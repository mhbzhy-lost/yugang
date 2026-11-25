# SPDX-License-Identifier: GPL-3.0-only
"""Numeric geometry core for anima-interaction-v1 structure (T2a authoring + T2b render support).

This module is the ONLY place that touches the frozen RS pose3d/mhr math. It splits cleanly:

  * NUMERIC (no raster) — FK control points, perspective projection, camera framing fit, box
    normalization, pattern-search IK. T2a uses these to author/freeze geometry and self-check; they
    are pure math (pose3d.project / mhr.global_matrices), explicitly allowed as 数值参数自查.
  * RASTER helpers — owner-mask box derivation, repair core/support/context/gray construction. These
    operate on numpy arrays the FROZEN RS rasterizer already produced; they never re-implement the
    renderer. Only render.py (T2b) feeds them real masks.

It NEVER calls pose3d._rasterize / render_pose_condition / render_scene itself — that is render.py's
job (T2b). build_geometry.py (T2a) imports only the NUMERIC half.

Coordinate frame: world Y up, +Z toward the reference camera, +X screen-right. Canvas 1024x768 (4:3),
all five framings share it (spec.canvas). Framing is expressed ONLY by reference camera distance /
framing window (spec: 不改画幅替代景别). RSCameraControl is NOT used (plan section 3.2).
"""
from __future__ import annotations

import math
from typing import Iterable, Sequence

import numpy as np

import rs_bridge

CANVAS_W, CANVAS_H = 1024, 768
FRAMINGS = ["W", "M", "C", "XU", "XH"]
FRAME_TOL = 0.02            # allowed |achieved - target| envelope-height fraction at authoring time
ENVELOPE_BODY_MARGIN = 0.11  # world-unit body-surface/hair inflation around FK control points (proxy)

# §3.2 envelope-height composition targets (midpoints of the frozen ranges). These are构图目标/辅助
# markers, NOT a guarantee: the authoritative subject_envelope is the rendered owner visible mask (T2b).
FRAMING_TARGET_HEIGHT = {"W": 0.45, "M": 0.90, "C": 0.90, "XU": 0.95, "XH": 0.95}
# §3.2 framing tags — appended ONCE to the public prompt (spec.fixed_parameters.prompt_form).
FRAMING_TAG = {
    "W": "wide shot, full body, scenery, small subjects",
    "M": "full body, centered composition",
    "C": "cowboy shot",
    "XU": "upper body, close-up",
    "XH": "extreme close-up, face focus",
}


def _rs():
    return rs_bridge.load()


def asset() -> dict:
    return _rs()["mhr"].asset()


# ---------------------------------------------------------------------------
# NUMERIC: forward kinematics (control-point world positions). Mirrors mhr.mannequin's points tail
# WITHOUT skinning/rasterization, so it is cheap and side-effect-free.
# ---------------------------------------------------------------------------
def control_points(person: dict) -> dict[str, np.ndarray]:
    """World-space positions of all 54 MHR controls for one person dict (FK only, no skin, no raster)."""
    mhr = _rs()["mhr"]
    pose3d = _rs()["pose3d"]
    a = asset()
    angles = {a["controls"][k]: list(v) for k, v in person["joints"].items() if k in a["controls"]}
    for rule in a["proceduralRotations"]:
        angles[a["names"][rule["bone"]]] = [
            sum(angles.get(a["names"][j], [0, 0, 0])[ax] * w for j, ax, w in terms) for terms in rule["axes"]
        ]
    posed = mhr.global_matrices(angles)
    size = person["scale"] * np.array([person["bulk"], 1.0, person["bulk"]])
    r = pose3d.rotation(person["rotation"])
    pos = np.array(person["position"], float)
    return {k: (posed[a["names"].index(b), :3, 3] * size) @ r.T + pos for k, b in a["controls"].items()}


def mkperson(pid: int, position, rotation, joints, scale: float = 1.0, bulk: float = 1.0) -> dict:
    """Build an RS scene 'person' dict. joints are merged over the MHR 'standing' preset (frozen base)."""
    base = {k: list(v) for k, v in asset()["presets"]["standing"].items()}
    for k, v in (joints or {}).items():
        base[k] = list(v)
    return {"id": int(pid), "position": [float(x) for x in position], "rotation": [float(x) for x in rotation],
            "scale": float(scale), "bulk": float(bulk), "joints": base}


def build_scene(people: Sequence[dict], camera: dict, width: int = CANVAS_W, height: int = CANVAS_H,
                mask_mode: str = "visible", outline: bool = True, version: int = 2) -> dict:
    """A frozen RS version-2 (native MHR) scene_json dict. Validated by pose3d.read_scene in build/render."""
    return {"version": version, "width": int(width), "height": int(height), "mask_mode": mask_mode,
            "outline": bool(outline), "camera": dict(camera), "people": [dict(p) for p in people]}


def person_points(people: Sequence[dict]) -> list[dict[str, np.ndarray]]:
    return [control_points(p) for p in people]


def facing_dir(pts: dict[str, np.ndarray]) -> np.ndarray:
    """Unit forward (toes-ankle) direction; used for the KISS lip proxy. Not a guarantee of gaze."""
    v = pts["left_toes"] - pts["left_ankle"]
    n = np.linalg.norm(v)
    return v / n if n > 1e-9 else np.array([0.0, 0.0, 1.0])


def lip_proxy(pts: dict[str, np.ndarray]) -> np.ndarray:
    """Head control + 0.10*forward - 0.03*up. Lips are NOT an MHR control; documented proxy."""
    return pts["head"] + 0.10 * facing_dir(pts) - np.array([0.0, 0.03, 0.0])


def project_points(points: Iterable[Sequence[float]], camera: dict, w: int, h: int) -> np.ndarray:
    """Perspective-project world points via the FROZEN pose3d.project -> (N,3) [sx, sy, vz]."""
    pose3d = _rs()["pose3d"]
    arr = np.asarray(list(points), float)
    if arr.size == 0:
        return np.zeros((0, 3))
    return pose3d.project(arr, camera, w, h)


def inflate(pts: dict[str, np.ndarray], names: Sequence[str], margin: float = ENVELOPE_BODY_MARGIN) -> np.ndarray:
    """Control-point envelope proxy: each named point expanded by ±margin in world x/y (body surface)."""
    out = []
    for n in names:
        if n not in pts:
            continue
        p = pts[n]
        for dx in (-margin, 0.0, margin):
            for dy in (-margin, 0.0, margin):
                out.append([p[0] + dx, p[1] + dy, p[2]])
    return np.asarray(out, float) if out else np.zeros((0, 3))


def all_controls() -> list[str]:
    return sorted(asset()["controls"].keys())


def finger_controls() -> list[str]:
    return sorted(k for k in asset()["controls"] if any(f in k for f in ("thumb", "index", "middle", "ring", "pinky")))


ALL_CONTROLS = None  # filled lazily after asset load (see _ensure_vocab)
FINGER_CONTROLS = None
ALL_BODY_CONTROLS = None


def _ensure_vocab():
    global ALL_CONTROLS, FINGER_CONTROLS, ALL_BODY_CONTROLS
    if ALL_CONTROLS is None:
        ALL_CONTROLS = all_controls()
        FINGER_CONTROLS = finger_controls()
        ALL_BODY_CONTROLS = [c for c in ALL_CONTROLS if c not in set(FINGER_CONTROLS)]


# Framed control subset per framing (which controls SHOULD be in frame). Drives both the camera fit and
# the mechanical expected_visible_contacts / expected_out_of_frame_parts (plan section 3.4). Finger
# controls follow their hand (in frame whenever wrists are).
def _regions():
    head = {"head", "neck"}
    shoulder = {"left_clavicle", "right_clavicle", "left_shoulder", "right_shoulder"}
    arm = {"left_elbow", "right_elbow", "left_wrist", "right_wrist"}
    torso = {"chest", "pelvis"}
    hip = {"left_hip", "right_hip"}
    leg = {"left_knee", "right_knee", "left_ankle", "right_ankle", "left_toes", "right_toes"}
    return head, shoulder, arm, torso, hip, leg


def framed_subset(framing: str) -> set:
    _ensure_vocab()
    head, shoulder, arm, torso, hip, leg = _regions()
    fingers = set(FINGER_CONTROLS)
    if framing in ("W", "M"):
        return set(ALL_CONTROLS)
    if framing == "C":       # 大腿/腰裁切, 头部完整 -> head..hip, hands in, legs out
        return head | shoulder | arm | fingers | {"chest"} | hip
    if framing == "XU":      # 胸/腰上 -> head..chest, arms/hands in, pelvis/hip/leg out
        return head | shoulder | arm | fingers | {"chest"}
    if framing == "XH":      # 头+少量肩颈 -> head/neck/shoulder only
        return head | shoulder
    raise ValueError(f"unknown framing {framing}")


FRAMED_SUBSET = {f: framed_subset(f) for f in FRAMINGS}


def framing_tag(framing: str) -> str:
    return FRAMING_TAG[framing]


# ---------------------------------------------------------------------------
# NUMERIC: camera framing fit. Fixed frontal azimuth (+Z), fixed fov; per framing solve the camera
# DISTANCE so the framed-subset projected envelope height hits the target fraction, aiming at the
# subset centroid (realizes 取景窗口: lower body falls out of frame for C/XU/XH). Bisection on the
# FROZEN pose3d.project — exact perspective, no small-angle assumption, no rasterization.
# ---------------------------------------------------------------------------
def fit_camera(points_world, framing: str, w: int = CANVAS_W, h: int = CANVAS_H,
               fov: float = 38.0, dist_range=(0.6, 15.0), width_cap: float = 0.92) -> dict:
    """Solve the camera-to-target distance d for one framing.

    Camera sits at target + [0,0,d] (level frontal view, fixed azimuth +Z, fixed fov). d is floored at
    dist_range[0]=0.6 so position-target norm and cross([0,0,d],[0,1,0]) norm both stay safely above
    pose3d.read_scene's 0.5 / 1e-4 gates (no float-cancellation at the boundary).

    The envelope is the framed-subset control points inflated by ENVELOPE_BODY_MARGIN (body-surface
    proxy). Two fits are computed and the FARTHER distance taken so the framing is realized on the
    binding axis: height -> §3.2 envelope-height target; width -> width_cap (keeps a side-by-side head
    pair / wide subject inside the canvas). For W/M/C height binds; for XH width usually binds. Targets
    are composition markers, NOT a guarantee; the authoritative envelope is T2b's rendered owner mask.
    """
    raw = np.asarray(list(points_world), float)
    if raw.shape[0] == 0:
        raise ValueError("fit_camera: empty envelope subset")
    cx, cy, cz = (float(np.mean(raw[:, 0])), float(np.mean(raw[:, 1])), float(np.mean(raw[:, 2])))
    target = [cx, cy, cz]
    m = ENVELOPE_BODY_MARGIN
    pts = []
    for p in raw:
        for dx in (-m, 0.0, m):
            for dy in (-m, 0.0, m):
                pts.append([p[0] + dx, p[1] + dy, p[2]])
    pts = np.asarray(pts, float)
    target_h = FRAMING_TARGET_HEIGHT[framing]

    def extents(d):
        cam = {"position": [cx, cy, cz + d], "target": target, "fov": fov}
        px = project_points(pts, cam, w, h)
        front = px[:, 2] > 0.05
        if not front.any():
            return 0.0, 0.0, cam
        ys, xs = px[front, 1], px[front, 0]
        return (float(ys.max() - ys.min()) / h), (float(xs.max() - xs.min()) / w), cam

    lo, hi = dist_range

    def bisect(axis_target, idx):
        def f(d):
            return extents(d)[idx]
        if f(lo) < axis_target:
            return lo
        if f(hi) > axis_target:
            return hi
        a, b = lo, hi
        for _ in range(60):
            mid = 0.5 * (a + b)
            if f(mid) > axis_target:
                a = mid
            else:
                b = mid
        return 0.5 * (a + b)

    d_height = bisect(target_h, 0)
    d_width = bisect(width_cap, 1)
    d = max(d_height, d_width, lo)
    hf, wf, cam = extents(d)
    return {"camera": cam, "distance": round(float(d), 4), "aim": [round(cx, 4), round(cy, 4), round(cz, 4)],
            "fov": fov, "target_height_frac": target_h, "achieved_height_frac": round(float(hf), 4),
            "width_cap": width_cap, "achieved_width_frac": round(float(wf), 4),
            "binding_axis": "width" if d_width > d_height else "height",
            "framing": framing, "azimuth": "frontal(+Z)", "envelope_proxy": "fk_control_points(+body_margin)"}


# ---------------------------------------------------------------------------
# RASTER helpers (operate on numpy masks from the frozen RS rasterizer; only render.py feeds them).
# ---------------------------------------------------------------------------
def box_from_mask(mask: np.ndarray, w: int, h: int, expand_px: int = 8) -> dict:
    """Owner reference projection visible envelope -> bbox +expand_px each side -> clip canvas ->
    normalized CENTER x/y/width/height (spec.fixed_parameters.box_derivation). mask is bool/uint8 (H,W)."""
    m = np.asarray(mask)
    ys, xs = np.nonzero(m)
    if xs.size == 0:
        return {"x": None, "y": None, "width": None, "height": None, "pixel_bbox": None, "empty": True}
    x0 = max(0.0, float(xs.min()) - expand_px)
    y0 = max(0.0, float(ys.min()) - expand_px)
    x1 = min(float(w), float(xs.max()) + 1 + expand_px)
    y1 = min(float(h), float(ys.max()) + 1 + expand_px)
    return box_normalize(x0, y0, x1, y1, w, h)


def box_normalize(x0: float, y0: float, x1: float, y1: float, w: int, h: int) -> dict:
    x0 = max(0.0, min(float(x0), float(w)))
    y0 = max(0.0, min(float(y0), float(h)))
    x1 = max(0.0, min(float(x1), float(w)))
    y1 = max(0.0, min(float(y1), float(h)))
    bw, bh = x1 - x0, y1 - y0
    return {"x": round((x0 + x1) / 2.0 / w, 6), "y": round((y0 + y1) / 2.0 / h, 6),
            "width": round(bw / w, 6), "height": round(bh / h, 6),
            "pixel_bbox": [round(x0, 2), round(y0, 2), round(x1, 2), round(y1, 2)], "empty": bw <= 0 or bh <= 0}


def contact_adjacency_mask(owner_a: np.ndarray, owner_b: np.ndarray, radius_px: int) -> np.ndarray:
    """Pixels of owner_a within radius_px of owner_b (true contact line lives here). Binary.
    Uses a separable box dilation (no scipy dependency). radius_px<=0 -> empty."""
    a = np.asarray(owner_a).astype(bool)
    b = np.asarray(owner_b).astype(bool)
    if radius_px <= 0 or not a.any() or not b.any():
        return np.zeros_like(a)
    grown = _box_dilate(b, radius_px)
    return a & grown


def _box_dilate(mask: np.ndarray, r: int) -> np.ndarray:
    """Binary dilation by an (2r+1) square, separable cumulative-sum, O(N) per axis."""
    m = np.asarray(mask).astype(np.uint8)
    h, w = m.shape
    out = m
    for axis, n in ((0, h), (1, w)):
        c = np.cumsum(out, axis=axis)
        c = np.pad(c, [(1, 0), (1, 0)] if axis == 0 else [(0, 0), (1, 0)], mode="constant")
        # after pad, c has shape (h+1,w) or (w+1,...) transposed; compute windowed sums
        if axis == 0:
            lo = np.clip(np.arange(n) - r, 0, n)
            hi = np.clip(np.arange(n) + r + 1, 0, n)
            win = c[hi, :] - c[lo, :]
            out = (win > 0).astype(np.uint8)
        else:
            lo = np.clip(np.arange(n) - r, 0, n)
            hi = np.clip(np.arange(n) + r + 1, 0, n)
            win = c[:, hi] - c[:, lo]
            out = (win > 0).astype(np.uint8)
    return out.astype(bool)


def falloff_from_core(core: np.ndarray, ring_px: int, support: np.ndarray) -> np.ndarray:
    """Gray strength map: core=1.0 plateau, linear falloff to 0 across ring_px outside the core,
    0 outside support (spec.fixed_parameters.gray_map: 核心1/外环约crop短边8%衰减/域外0). The true
    contact line stays inside the core (not locked to a low-strength edge). Independent of owner mask."""
    core = np.asarray(core).astype(bool)
    supp = np.asarray(support).astype(bool)
    if ring_px <= 0:
        return (core & supp).astype(np.float32)
    gray = np.zeros(core.shape, dtype=np.float32)
    prev = core.copy()
    steps = max(1, int(ring_px))
    for i in range(1, steps + 1):
        ring = _box_dilate(prev, 1) & (~prev)
        val = 1.0 - (i / steps)
        gray[ring & supp] = np.maximum(gray[ring & supp], np.float32(val))
        prev = prev | ring
    gray[core & supp] = 1.0
    gray[~supp] = 0.0
    return gray


def build_repair_stack(owner_a: np.ndarray, owner_b: np.ndarray, core_radius_px: int,
                       support_grow_px: int, ring_px: int, context_grow_px: int) -> dict:
    """All four repair domains from the two owner binary masks. Gray map is INDEPENDENT of owner masks.
    core = owner_a within core_radius_px of owner_b (true contact line inside core).
    support = binary union(owner_a,owner_b) dilated support_grow_px (editable domain; may be empty if
              the contact group falls out of the framing edit window — that is a mechanical fact).
    gray = falloff_from_core(core, ring_px, support).
    context = support dilated context_grow_px (independent context mask for Crop & Stitch)."""
    a = np.asarray(owner_a).astype(bool)
    b = np.asarray(owner_b).astype(bool)
    core = contact_adjacency_mask(a, b, core_radius_px)
    union = a | b
    support = _box_dilate(union, support_grow_px) if support_grow_px > 0 else union
    gray = falloff_from_core(core, ring_px, support)
    context = _box_dilate(support, context_grow_px) if context_grow_px > 0 else support
    return {"core": core, "support": support, "context": context, "gray": gray,
            "core_empty": bool(not core.any()), "support_empty": bool(not support.any())}


# ---------------------------------------------------------------------------
# NUMERIC authoring tool: bounded pattern-search IK (FK only, no raster). Used OFFLINE to freeze the
# action poses; build_geometry.py consumes the FROZEN angles, not this solver. Kept for audit/repro.
# ---------------------------------------------------------------------------
def pattern_search_ik(dofs, targets, seedA, seedB, pA, rA, pB, rB, lo=-150.0, hi=150.0,
                      comfort=0.0003, steps=None):
    """dofs: [(who,control,axis)]; targets: [(who,control,weight,xyz)]. Returns (x, cpsA, cpsB, jointsA, jointsB)."""
    if steps is None:
        steps = [45, 32, 23, 16, 11, 8, 5.5, 4, 2.8, 2, 1.4, 1.0, 0.7, 0.45, 0.3, 0.2]
    x0 = np.array([(seedA if w == "A" else seedB).get(c, [0, 0, 0])[ax] for (w, c, ax) in dofs], float)

    def build(xv):
        ja, jb = dict(seedA), dict(seedB)
        for (w, c, ax), val in zip(dofs, xv):
            d = ja if w == "A" else jb
            d[c] = list(d.get(c, [0, 0, 0]))
            d[c][ax] = val
        return control_points(mkperson(1, pA, rA, ja)), control_points(mkperson(2, pB, rB, jb)), ja, jb

    def cost(xv):
        xv = np.clip(xv, lo, hi)
        ca, cb, _, _ = build(xv)
        s = 0.0
        for (w, c, wt, t) in targets:
            p = (ca if w == "A" else cb)[c]
            s += wt * float(np.sum((p - np.array(t, float)) ** 2))
        return s + comfort * float(np.sum((xv - x0) ** 2))

    x, best = x0.copy(), cost(x0)
    for st in steps:
        improved, guard = True, 0
        while improved and guard < 90:
            improved, guard = False, guard + 1
            for i in range(len(x)):
                for sg in (1, -1):
                    xt = x.copy()
                    xt[i] = float(np.clip(xt[i] + sg * st, lo, hi))
                    ct = cost(xt)
                    if ct < best - 1e-11:
                        best, x, improved = ct, xt, True
    x = np.clip(x, lo, hi)
    ca, cb, ja, jb = build(x)
    return x, ca, cb, ja, jb


ik_solve = pattern_search_ik  # alias


def collect_joints(dofs, x, who) -> dict:
    out: dict[str, list] = {}
    for (w, c, ax), val in zip(dofs, x):
        if w == who:
            out.setdefault(c, [0.0, 0.0, 0.0])
            out[c][ax] = round(float(val), 2)
    return out


_ensure_vocab()
