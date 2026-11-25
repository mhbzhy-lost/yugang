# SPDX-License-Identifier: GPL-3.0-only
"""T2b CPU render program for anima-interaction-v1 structure fixtures.

THIS IS RUN BY T2b, NOT BY T2a. T2a only wrote it and py_compile-checked it (no real CPU render
verification this round). It performs ZERO GPU work and ZERO diffusion sampling: it drives the FROZEN
RS pose3d rasterizer (pose3d._rasterize / render_pose_condition, numpy + Pillow only) on the frozen
geometry to produce the real condition assets and the formal structure index.

Run (CPU, after T0 preflight binds the real MHR asset; numpy + Pillow>=10):
  /usr/local/bin/python3 experiments/anima-interaction-v1/structure/render.py \
      --geometry experiments/anima-interaction-v1/structure/frozen/geometry.json \
      --out var/local-driver/anima-interaction-v1/inputs/structure
  # optional: --cases DC-HAND-W,DC-HUG-M   --dry-run (list planned work, render nothing)

Per case it writes (under --out/<case_id>/):
  scene.json        the frozen RS version-2 scene (camera + 2 MHR people) actually rendered
  pose_image.png    shaded 3D human body + outline RGB — the native LLLite condition AND the
                    auditable color reference (matches anima_3dpose_outline training distribution;
                    NO tail/appendage is ever drawn into it)
  owner_a.png       slot-A visible binary owner mask (1024x768, 0/255); DC: unioned with the deepseek
                    whale-tail occupancy (same owner, minus pixels occluded by B) — NOT a 3rd slot
  owner_b.png       slot-B visible binary owner mask (solo: omitted)
  owner_a_full.png  slot-A full (overlapping) silhouette — audit only
  owner_b_full.png  slot-B full silhouette — audit only (solo: omitted)
  repair_core.png   contact core (owner_a within core_radius_px of owner_b) — true contact line here
  support.png       binary editable domain (union dilated support_grow_px)
  context.png       independent context mask (support dilated context_grow_px) for Crop & Stitch
  gray.png          gray repaint-strength map (core=1 plateau, ~8%-of-crop-short-side falloff, 0 outside
                    support) — INDEPENDENT of the owner binary masks
  preview.png       owner-colored mask overlay (navigation only; the PNGs above are the real assets)
  structure_index.json  per-case real files + sha256 + authoritative boxes + repair params + visibility

And at --out root: structure_index.json (formal, rendered) replacing T2a's unrendered source index.

Authoritative box (spec.fixed_parameters.box_derivation): owner reference-projection VISIBLE envelope
-> bbox +8px each side -> clip to canvas -> normalized center x/y/width/height. This replaces T2a's
FK-proxy box. B0/B1 use this box; B2 uses the same-source non-rectangular owner outline union
(owner_a/owner_b PNGs), RSMultiCharacterMask margin=0/threshold=0.5.

The gray ring width is frozen at 8% of the 768 repair-crop short side (=61px), rasterized here at the
native 1024x768 canvas; T4's YugangMaskCropTransform resamples core/support/context/gray into the
768x768 crop with the SAME transform (gray continuous interp + support reclamp), realizing the
crop-space spec. The repair domains are produced only where a contact group exists; for framings whose
edit window falls outside the body (e.g. an XH head crop) support may be EMPTY — that is recorded as a
mechanical fact (support_empty=true), never silently faked, and never fixed by changing the framing.
"""
from __future__ import annotations

import argparse
import gzip
import hashlib
import json
import os
import sys
from pathlib import Path

import numpy as np

sys.path.insert(0, str(Path(__file__).resolve().parent))
import rs_bridge  # noqa: E402
import geometry_core as G  # noqa: E402
import frozen_poses as FP  # noqa: E402

# Frozen repair-domain rasterization parameters (native 1024x768 canvas). plan section 5.2.
REPAIR_PARAMS = {
    "core_radius_px": 6,        # owner_a within 6px of owner_b = contact core (true contact line inside)
    "support_grow_px": 48,      # editable domain = binary union(owner_a,owner_b) dilated 48px
    "ring_px": 61,              # gray falloff ring = round(0.08 * 768 repair-crop short side)
    "context_grow_px": 96,      # independent context mask = support dilated 96px (Crop & Stitch context)
    "canvas": [1024, 768],
    "repair_crop_target": 768,
    "note": "native-canvas raster; T4 crop transform resamples into 768x768 with the same transform.",
}
BOX_EXPAND_PX = 8
PREVIEW_COLORS = [(255, 141, 145), (129, 188, 255), (148, 221, 157), (255, 210, 127), (195, 160, 255)]


def sha256_file(path: Path) -> str:
    h = hashlib.sha256()
    with open(path, "rb") as f:
        for chunk in iter(lambda: f.read(1 << 20), b""):
            h.update(chunk)
    return h.hexdigest()


def _save(arr: np.ndarray, path: Path, mode: str):
    from PIL import Image
    if mode == "L":
        img = Image.fromarray(np.asarray(arr, dtype=np.uint8), mode="L")
    else:
        img = Image.fromarray(np.asarray(arr, dtype=np.uint8), mode="RGB")
    path.parent.mkdir(parents=True, exist_ok=True)
    img.save(path)
    return sha256_file(path)


def save_mask(mask_bool: np.ndarray, path: Path) -> str:
    return _save((np.asarray(mask_bool, bool).astype(np.uint8) * 255), path, "L")


def save_gray(gray01: np.ndarray, path: Path) -> str:
    return _save(np.clip(np.asarray(gray01, float) * 255.0, 0, 255).astype(np.uint8), path, "L")


def save_rgb(rgb: np.ndarray, path: Path) -> str:
    return _save(np.asarray(rgb, np.uint8), path, "RGB")


def tail_pixels(cps_a, body_a, camera, tail_def, w, h):
    """Rasterize the deepseek whale-tail occupancy (perspective-scaled discs along the frozen polyline).
    Occupancy ONLY — never written into pose_image / the LLLite skeleton. Returns a bool mask (h,w)."""
    pose3d = rs_bridge.pose3d()
    from PIL import Image, ImageDraw
    pelvis = np.asarray(cps_a[tail_def["anchor_control"]], float)
    r = pose3d.rotation(body_a["rotation"])
    size = body_a["scale"] * np.array([body_a["bulk"], 1.0, body_a["bulk"]])
    f = h / (2.0 * np.tan(np.radians(camera["fov"]) / 2.0))
    img = Image.new("L", (w, h), 0)
    dr = ImageDraw.Draw(img)
    for seg in tail_def["segments"] + tail_def["fluke"]:
        wp = pelvis + (np.asarray(seg["off"], float) * size) @ r.T
        cam = pose3d.camera_coordinates(np.array([wp]), camera)[0]
        if cam[2] <= 0.05:
            continue
        sx = w / 2.0 + cam[0] * f / cam[2]
        sy = h / 2.0 - cam[1] * f / cam[2]
        rad = max(1.0, float(seg["r"]) * size[0] * f / cam[2])
        dr.ellipse((sx - rad, sy - rad, sx + rad, sy + rad), fill=255)
    return np.asarray(img, dtype=np.uint8) > 0


def render_case(case, geom, out_root: Path, dry_run=False):
    pose3d = rs_bridge.pose3d()
    case_id = case["case_id"]
    is_solo = case.get("is_solo", False) or "character" in case
    cdir = out_root / case_id
    scene = case["scene_json"]
    entry = {"case_id": case_id, "is_solo": bool(is_solo), "framing": case["framing"],
             "world_id": case["world_id"], "status": "rendered", "files": {}, "boxes": {},
             "repair_params": None if is_solo else dict(REPAIR_PARAMS),
             "expected_visible_contacts": case.get("expected_visible_contacts", []),
             "expected_out_of_frame_parts": case.get("expected_out_of_frame_parts", [])}
    planned = [cdir / "scene.json", cdir / "pose_image.png", cdir / "owner_a.png",
               cdir / "owner_a_full.png", cdir / "preview.png", cdir / "structure_index.json"]
    if not is_solo:
        planned += [cdir / "owner_b.png", cdir / "owner_b_full.png", cdir / "repair_core.png",
                    cdir / "support.png", cdir / "context.png", cdir / "gray.png"]
    if dry_run:
        entry["status"] = "dry_run_planned"
        entry["planned_files"] = [str(p) for p in planned]
        return entry

    cdir.mkdir(parents=True, exist_ok=True)
    (cdir / "scene.json").write_text(json.dumps(scene, ensure_ascii=False, indent=1), encoding="utf-8")
    entry["files"]["scene.json"] = {"path": str(cdir / "scene.json"), "sha256": sha256_file(cdir / "scene.json")}

    clean = pose3d.read_scene(json.dumps(scene))
    full, visible, rgb = pose3d._rasterize(clean, shaded=True)  # FROZEN RS rasterizer (numpy, CPU)
    w, h = scene["width"], scene["height"]

    # pose_image: the shaded body+outline RGB is BOTH the LLLite condition and the color reference.
    entry["files"]["pose_image.png"] = {"path": str(cdir / "pose_image.png"), "sha256": save_rgb(rgb, cdir / "pose_image.png")}

    owner_a = visible[0].copy()
    owner_a_full = full[0].copy()
    # deepseek whale-tail same-owner occupancy union (DC worlds / deepseek solo), minus B-occluded px.
    tail_slot = None
    world = next((wd for wd in geom["worlds"] if wd["world_id"] == case["world_id"]), None)
    if world and world.get("tail_owner_slot"):
        tail_slot = world["tail_owner_slot"]
    if (is_solo and case.get("character") == "deepseek") or (tail_slot == "A" and not is_solo):
        cps_a = G.control_points(scene["people"][0])
        body_a = scene["people"][0]
        tailmask = tail_pixels(cps_a, body_a, scene["camera"], FP.TAIL_DEEPSEEK, w, h)
        if not is_solo:
            tailmask = tailmask & (~visible[1])  # single-owner: B's visible region wins where it occludes
        owner_a = owner_a | tailmask
        owner_a_full = owner_a_full | tailmask
        entry["tail_union"] = {"owner": "deepseek", "slot": "A" if not is_solo else "solo",
                               "occluded_by_b_removed": not is_solo,
                               "note": "occupancy union into owner_a only; never in pose_image/skeleton"}

    entry["files"]["owner_a.png"] = {"path": str(cdir / "owner_a.png"), "sha256": save_mask(owner_a, cdir / "owner_a.png")}
    entry["files"]["owner_a_full.png"] = {"path": str(cdir / "owner_a_full.png"), "sha256": save_mask(owner_a_full, cdir / "owner_a_full.png")}
    entry["boxes"]["owner_a"] = G.box_from_mask(owner_a, w, h, BOX_EXPAND_PX)

    owner_b = None
    if not is_solo:
        owner_b = visible[1].copy()
        entry["files"]["owner_b.png"] = {"path": str(cdir / "owner_b.png"), "sha256": save_mask(owner_b, cdir / "owner_b.png")}
        entry["files"]["owner_b_full.png"] = {"path": str(cdir / "owner_b_full.png"), "sha256": save_mask(full[1], cdir / "owner_b_full.png")}
        entry["boxes"]["owner_b"] = G.box_from_mask(owner_b, w, h, BOX_EXPAND_PX)
        # repair domains from the two owner binary masks (gray independent of owner masks)
        stack = G.build_repair_stack(owner_a, owner_b, REPAIR_PARAMS["core_radius_px"],
                                     REPAIR_PARAMS["support_grow_px"], REPAIR_PARAMS["ring_px"],
                                     REPAIR_PARAMS["context_grow_px"])
        entry["files"]["repair_core.png"] = {"path": str(cdir / "repair_core.png"), "sha256": save_mask(stack["core"], cdir / "repair_core.png")}
        entry["files"]["support.png"] = {"path": str(cdir / "support.png"), "sha256": save_mask(stack["support"], cdir / "support.png")}
        entry["files"]["context.png"] = {"path": str(cdir / "context.png"), "sha256": save_mask(stack["context"], cdir / "context.png")}
        entry["files"]["gray.png"] = {"path": str(cdir / "gray.png"), "sha256": save_gray(stack["gray"], cdir / "gray.png")}
        entry["repair_flags"] = {"core_empty": bool(stack["core_empty"]), "support_empty": bool(stack["support_empty"]),
                                 "note": "empty edit domain is a mechanical fact (framing window), never faked or fixed by reframing"}

    # preview: owner-colored overlay (navigation only)
    prev = np.full((h, w, 3), 12, dtype=np.uint8)
    prev[owner_a] = PREVIEW_COLORS[0]
    if owner_b is not None:
        prev[owner_b] = PREVIEW_COLORS[1]
    entry["files"]["preview.png"] = {"path": str(cdir / "preview.png"), "sha256": save_rgb(prev, cdir / "preview.png")}
    entry["canvas"] = [w, h]
    (cdir / "structure_index.json").write_text(json.dumps(entry, ensure_ascii=False, indent=1), encoding="utf-8")
    entry["files"]["structure_index.json"] = {"path": str(cdir / "structure_index.json"), "sha256": sha256_file(cdir / "structure_index.json")}
    return entry


def main(argv=None):
    ap = argparse.ArgumentParser(description="T2b CPU render of anima-interaction-v1 structure fixtures (no GPU, no sampling).")
    here = Path(__file__).resolve().parent
    repo = Path(os.environ.get("YUGANG_ROOT", here.parent.parent.parent))
    ap.add_argument("--geometry", default=str(here / "frozen" / "geometry.json"))
    ap.add_argument("--out", default=str(repo / "var" / "local-driver" / "anima-interaction-v1" / "inputs" / "structure"))
    ap.add_argument("--cases", default="", help="comma-separated case_id filter (default: all 44)")
    ap.add_argument("--dry-run", action="store_true", help="list planned files, render nothing")
    args = ap.parse_args(argv)

    rs_bridge.load()  # verifies frozen RS geometry + real MHR asset before any render
    geom = json.loads(Path(args.geometry).read_text(encoding="utf-8"))
    out_root = Path(args.out)
    out_root.mkdir(parents=True, exist_ok=True)
    want = set(c.strip() for c in args.cases.split(",") if c.strip())

    cases = list(geom["projections"]) + list(geom["solo_projections"])
    if want:
        cases = [c for c in cases if c["case_id"] in want]
        missing = want - {c["case_id"] for c in cases}
        if missing:
            raise SystemExit(f"render.py: unknown case_id(s): {sorted(missing)}")

    index = {"schema": "yugang.anima-interaction-v1.structure.structure_index", "version": 1,
             "execution_state": "dry_run_planned" if args.dry_run else "rendered_cpu_no_gpu",
             "rs_commit": geom["rs_commit"], "rs_geometry_sha256": geom["rs_geometry_sha256"],
             "mhr_asset": geom["mhr_asset"], "canvas": geom["canvas"],
             "repair_params": REPAIR_PARAMS, "box_expand_px": BOX_EXPAND_PX,
             "finger_limitation": geom["finger_limitation"],
             "tail_rule": geom["pose_distribution_match"]["tail_rule"],
             "case_count": len(cases), "cases": {}}
    for case in cases:
        entry = render_case(case, geom, out_root, dry_run=args.dry_run)
        index["cases"][entry["case_id"]] = entry
    (out_root / "structure_index.json").write_text(json.dumps(index, ensure_ascii=False, indent=1), encoding="utf-8")
    print(json.dumps({"out_root": str(out_root), "case_count": len(cases),
                      "dry_run": args.dry_run, "structure_index": str(out_root / "structure_index.json")},
                     ensure_ascii=False, indent=2))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
