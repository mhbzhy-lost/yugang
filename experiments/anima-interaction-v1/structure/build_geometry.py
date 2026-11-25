# SPDX-License-Identifier: GPL-3.0-only
"""T2a MAIN emitter: build the frozen structure geometry + unrendered source index.

Run:  /usr/local/bin/python3 experiments/anima-interaction-v1/structure/build_geometry.py

Produces (deterministic, FK + projection only — NEVER rasterizes; rasterization is T2b's render.py):
  experiments/anima-interaction-v1/structure/frozen/geometry.json       (8 worlds + 40 projections + 4 solo)
  experiments/anima-interaction-v1/structure/frozen/source_index.json   (44 cases, status=unrendered)
  var/local-driver/anima-interaction-v1/inputs/structure/source_index.json  (run-root copy for T2b/T3)
  var/local-driver/anima-interaction-v1/inputs/structure/README.md

geometry.json is the FROZEN GEOMETRY deliverable: world poses (MHR joints), per-framing cameras,
owner/contact/occlusion/visibility annotations, deepseek tail owner-union geometry, and an FK-proxy
box per case. The authoritative box / masks / pose_image / repair maps come from T2b's real render
(the RS rasterizer + real MHR asset); this file fills NO fake PNG/hash and marks everything unrendered.

Self-checks run inline (numeric, allowed): every scene passes the frozen RS read_scene validator;
contact residuals recomputed from the frozen angles match the recorded authoring_residuals; camera
framing fractions hit their targets; proxy boxes are in-canvas and normalized.
"""
from __future__ import annotations

import json
import os
import sys
from pathlib import Path

import numpy as np

sys.path.insert(0, str(Path(__file__).resolve().parent))
import rs_bridge  # noqa: E402
import geometry_core as G  # noqa: E402
import frozen_poses as FP  # noqa: E402

CANVAS_W, CANVAS_H = 1024, 768
FRAMINGS = ["W", "M", "C", "XU", "XH"]

_STRUCTURE_DIR = Path(__file__).resolve().parent
_FROZEN_DIR = _STRUCTURE_DIR / "frozen"
_REPO_ROOT = Path(os.environ.get("YUGANG_ROOT", _STRUCTURE_DIR.parent.parent.parent))
_RUN_ROOT = _REPO_ROOT / "var" / "local-driver" / "anima-interaction-v1"
_INPUTS_STRUCTURE = _RUN_ROOT / "inputs" / "structure"

# Per-framing planned file layout under run-root inputs/structure/<case_id>/ (T2b fills the PNGs).
PAIR_FILES = ["scene.json", "pose_image.png", "owner_a.png", "owner_b.png", "owner_a_full.png",
              "owner_b_full.png", "repair_core.png", "support.png", "context.png", "gray.png",
              "preview.png", "structure_index.json"]
SOLO_FILES = ["scene.json", "pose_image.png", "owner_a.png", "owner_a_full.png", "preview.png",
              "structure_index.json"]


# ---------------------------------------------------------------------------
# Region membership -> framed subsets per framing (mechanical expected-visibility source).
# ---------------------------------------------------------------------------
def _region_sets():
    head = {"head", "neck"}
    shoulder = {"left_clavicle", "right_clavicle", "left_shoulder", "right_shoulder"}
    arm = {"left_elbow", "right_elbow", "left_wrist", "right_wrist"}
    fingers = set(G.FINGER_CONTROLS)
    torso = {"chest", "pelvis"}
    hip = {"left_hip", "right_hip"}
    leg = {"left_knee", "right_knee", "left_ankle", "right_ankle", "left_toes", "right_toes"}
    return head, shoulder, arm, fingers, torso, hip, leg


def framed_subset(framing: str) -> set:
    head, shoulder, arm, fingers, torso, hip, leg = _region_sets()
    if framing in ("W", "M"):
        return set(G.ALL_CONTROLS)
    if framing == "C":
        return head | shoulder | arm | fingers | {"chest"} | hip
    if framing == "XU":
        return head | shoulder | arm | fingers | {"chest"}
    if framing == "XH":
        return head | shoulder
    raise ValueError(framing)


OUT_OF_FRAME_GROUPS = {
    "W": [],
    "M": [],
    "C": ["legs(knee/ankle/toes)"],
    "XU": ["pelvis", "hips", "legs(knee/ankle/toes)"],
    "XH": ["arms(elbow/wrist)", "hands(fingers)", "torso_below_shoulder(chest/pelvis)", "hips", "legs", "feet"],
}

# §3.4 per-framing observability caveats (frozen text, mechanical — not an assistant verdict).
FRAMING_CAVEAT = {
    "W": "理论展示全局动作; 手指/嘴唇可能因 1024x768 原生像素不足而不可判; 看起来像牵手不等于证明十指相扣。",
    "M": "理论展示全局动作; 联合包络大不代表人物实际占比一定高。",
    "C": "从大腿/腰附近裁切, 头部完整; 看不到脚属正常裁切不判缺脚; 应在画内的接触若不符标 framing_mismatch/contact_not_observable, 不偷偷扩大取景。",
    "XU": "上半身构图; HAND 的低位双手可能在画外边缘; CARRY 常只展示上半身关系; 不移动牵手高度改变冻结姿态。",
    "XH": "仅头脸+少量肩颈; KISS 可检查接吻; 其他动作不能仅凭两张脸确认十指相扣/拥抱全部手臂/背负承重。",
}


def _tail_world_points(cps_a: dict, body_a: dict, tail_def: dict) -> list:
    """World points of the deepseek tail owner-union (occupancy only; never pose skeleton)."""
    pose3d = rs_bridge.pose3d()
    pelvis = np.asarray(cps_a[tail_def["anchor_control"]], float)
    r = pose3d.rotation(body_a["rotation"])
    size = body_a["scale"] * np.array([body_a["bulk"], 1.0, body_a["bulk"]])
    pts = []
    for seg in tail_def["segments"] + tail_def["fluke"]:
        off = np.asarray(seg["off"], float)
        pts.append((pelvis + (off * size) @ r.T).tolist())
    return pts


def _box_from_world_points(points_world, camera, tail_world=None):
    """FK-proxy box: project world points (+ optional tail), bbox +8px, clip, normalize center x/y/w/h.
    This is a PROXY (control points + body margin understate the true silhouette); the AUTHORITATIVE
    box comes from T2b's rendered owner mask. Returned in the frozen normalized-center contract."""
    pose3d = rs_bridge.pose3d()
    margin = G.ENVELOPE_BODY_MARGIN
    pts = []
    for p in points_world:
        for dx in (-margin, 0, margin):
            for dy in (-margin, 0, margin):
                pts.append([p[0] + dx, p[1] + dy, p[2]])
    if tail_world:
        pts.extend(tail_world)
    px = pose3d.project(np.asarray(pts, float), camera, CANVAS_W, CANVAS_H)
    xs, ys = px[:, 0], px[:, 1]
    # only points in front of the camera contribute a meaningful projection
    front = px[:, 2] > 0.05
    if front.any():
        xs, ys = xs[front], ys[front]
    x0 = max(0.0, float(np.floor(xs.min())) - 8.0)
    y0 = max(0.0, float(np.floor(ys.min())) - 8.0)
    x1 = min(float(CANVAS_W), float(np.ceil(xs.max())) + 8.0)
    y1 = min(float(CANVAS_H), float(np.ceil(ys.max())) + 8.0)
    return G.box_normalize(x0, y0, x1, y1, CANVAS_W, CANVAS_H), [round(x0, 2), round(y0, 2), round(x1, 2), round(y1, 2)]


def _contact_visible(action_tpl, framing):
    """expected_visible_contacts: contact controls whose region is inside this framing's subset."""
    cg = action_tpl.get("contact_group")
    if not cg:
        return [], "no_contact_solo"
    sub = framed_subset(framing)
    vis = []
    for c in cg["controls"]:
        ctrl = c.split(".", 1)[1]
        if ctrl in sub:
            vis.append(c)
    # fingers of clasping hands count with the hand region
    if framing in ("W", "M", "C", "XU") and "finger_controls" in cg:
        vis.append("clasping_hand_fingers(authored interlock)")
    return vis, ("visible_in_frame" if vis else "contact_out_of_frame")


def build_world(pair_id, action_id):
    pair = FP.PAIRS[pair_id]
    tpl = FP.action_template(action_id)
    bodyA, bodyB = FP.person_body(action_id, "A"), FP.person_body(action_id, "B")
    jointsA, jointsB = FP.person_joints(action_id, "A"), FP.person_joints(action_id, "B")
    personA = G.mkperson(1, bodyA["position"], bodyA["rotation"], jointsA, bodyA["scale"], bodyA["bulk"])
    personB = G.mkperson(2, bodyB["position"], bodyB["rotation"], jointsB, bodyB["scale"], bodyB["bulk"])
    return {
        "world_id": f"{pair_id}-{action_id}",
        "pair": pair_id,
        "action": action_id,
        "A_character": pair["A"],
        "B_character": pair["B"],
        "lora_relationship": pair["lora_relationship"],
        "owner_annotations": pair["owner_annotations"],
        "tail_owner_slot": pair["tail_owner_slot"],
        "body": {"A": bodyA, "B": bodyB},
        "joints": {"A": jointsA, "B": jointsB},
        "people": [personA, personB],
        "contact_group": tpl.get("contact_group"),
        "occlusion": tpl.get("occlusion"),
        "other_hands": tpl.get("other_hands"),
        "authoring_targets": tpl.get("authoring_targets"),
        "authoring_residuals": tpl.get("authoring_residuals"),
        "action_world_def": tpl.get("world"),
        "shared_across_framings": True,
    }


def build_solo(char_key):
    body = FP.SOLO_TEMPLATE["body"]["A"]
    joints = FP.SOLO_TEMPLATE["joints"]["A"]
    person = G.mkperson(1, body["position"], body["rotation"], joints, body["scale"], body["bulk"])
    return {
        "world_id": f"SOLO-{char_key}",
        "case_id": f"SOLO-{char_key}",
        "character": char_key,
        "action": "STAND",
        "framing": "M",
        "body": {"A": body},
        "joints": {"A": joints},
        "people": [person],
        "contact_group": None,
        "occlusion": FP.SOLO_TEMPLATE["occlusion"],
        "owner_annotations": {"A": f"{char_key}: 单人中景站姿(1girl/solo), 身份来自 LoRA/prompt; 无 pair 无交互。"},
    }


def scene_for(world, framing, camera):
    """Full frozen RS scene_json dict (version 2 MHR, outline on, mask_mode visible) for one case."""
    return {
        "version": 2,
        "width": CANVAS_W,
        "height": CANVAS_H,
        "mask_mode": "visible",
        "outline": True,
        "camera": camera,
        "people": world["people"],
    }


def build_projection(world, framing, action_tpl):
    people = world["people"]
    pts_per_person = [G.control_points(p) for p in people]
    sub = framed_subset(framing)
    # envelope subset points (world) for camera fit
    env_pts = []
    for cps in pts_per_person:
        env_pts.extend([cps[c] for c in sub if c in cps])
    # deepseek tail extends the owner_a envelope; include it for full-body framings (W/M) so the
    # frozen camera frames the complete tail (plan section 3.2 W: 尾巴不出画).
    tail_world = None
    if world.get("tail_owner_slot") and framing in ("W", "M"):
        slot = world["tail_owner_slot"]
        idx = 0 if slot == "A" else 1
        tail_world = _tail_world_points(pts_per_person[idx], world["body"][slot], FP.TAIL_DEEPSEEK)
        env_pts.extend(tail_world)
    fit = G.fit_camera(env_pts, framing, CANVAS_W, CANVAS_H)
    camera = fit["camera"]
    scene = scene_for(world, framing, camera)
    # validate through the FROZEN RS read_scene (authoritative schema gate)
    rs_read_scene = rs_bridge.pose3d().read_scene
    rs_read_scene(json.dumps(scene))  # raises on any schema violation
    # FK-proxy boxes per owner
    boxes = {}
    for slot, cps, person in zip(("A", "B"), pts_per_person, people):
        tw = None
        if world.get("tail_owner_slot") == slot and framing in ("W", "M"):
            tw = _tail_world_points(cps, world["body"][slot], FP.TAIL_DEEPSEEK)
        owner_pts = [cps[c] for c in sub if c in cps]
        box, pixel_bbox = _box_from_world_points(owner_pts, camera, tail_world=tw)
        boxes[f"owner_{slot.lower()}"] = {
            "normalized_center": box,
            "pixel_bbox_plus8_clipped": pixel_bbox,
            "source": "fk_control_point_proxy(+tail for DC W/M owner_a)",
            "authoritative": "pending_T2b_rendered_owner_visible_mask",
        }
    vis_contacts, vis_state = _contact_visible(action_tpl, framing)
    case_id = f"{world['world_id']}-{framing}"
    return {
        "case_id": case_id,
        "world_id": world["world_id"],
        "pair": world["pair"],
        "action": world["action"],
        "framing": framing,
        "framing_tag": G.framing_tag(framing),
        "camera": camera,
        "camera_fit": fit,
        "scene_json": scene,
        "framed_subset_size": len(sub),
        "expected_visible_contacts": vis_contacts,
        "expected_visibility_state": vis_state,
        "expected_out_of_frame_parts": OUT_OF_FRAME_GROUPS[framing],
        "framing_caveat": FRAMING_CAVEAT[framing],
        "box_proxy": boxes,
        "box_derivation_contract": "owner 参考投影可见包络 -> bbox 四边各扩 8px -> 夹画布 -> 归一化中心 x/y/width/height; B0/B1 同 box, B2 同来源轮廓 union; RSMultiCharacterMask margin=0/threshold=0.5。proxy 来自 FK 控制点(+DC W/M 尾), 权威 box 由 T2b 渲染 owner visible mask 计算。",
        "status": "unrendered",
    }


def build_solo_projection(solo):
    cps = G.control_points(solo["people"][0])
    sub = framed_subset("M")
    env_pts = [cps[c] for c in sub if c in cps]
    tw = None
    if solo["character"] == "deepseek":
        tw = _tail_world_points(cps, solo["body"]["A"], FP.TAIL_DEEPSEEK)
        env_pts.extend(tw)
    fit = G.fit_camera(env_pts, "M", CANVAS_W, CANVAS_H)
    camera = fit["camera"]
    scene = {"version": 2, "width": CANVAS_W, "height": CANVAS_H, "mask_mode": "visible",
             "outline": True, "camera": camera, "people": solo["people"]}
    rs_bridge.pose3d().read_scene(json.dumps(scene))
    owner_pts = [cps[c] for c in sub if c in cps]
    box, pixel_bbox = _box_from_world_points(owner_pts, camera, tail_world=tw)
    return {
        "case_id": solo["case_id"],
        "world_id": solo["world_id"],
        "character": solo["character"],
        "action": "STAND",
        "framing": "M",
        "framing_tag": "full body, centered composition",
        "camera": camera,
        "camera_fit": fit,
        "scene_json": scene,
        "expected_visible_contacts": [],
        "expected_visibility_state": "no_contact_solo",
        "expected_out_of_frame_parts": [],
        "box_proxy": {"owner_a": {"normalized_center": box, "pixel_bbox_plus8_clipped": pixel_bbox,
                                  "source": "fk_control_point_proxy(+tail for deepseek)",
                                  "authoritative": "pending_T2b_rendered_owner_visible_mask"}},
        "status": "unrendered",
    }


def planned_files(case_id, is_solo):
    names = SOLO_FILES if is_solo else PAIR_FILES
    base = f"var/local-driver/anima-interaction-v1/inputs/structure/{case_id}"
    out = {}
    for n in names:
        status = "unrendered"
        if n.endswith(".png"):
            status = "unrendered_T2b"
        if n in ("repair_core.png", "support.png", "context.png", "gray.png") and is_solo:
            status = "not_applicable_no_contact"
        out[n] = {"path": f"{base}/{n}", "status": status, "sha256": None}
    return out


def main():
    rs_bridge.load()
    meta = rs_bridge.asset_meta()
    worlds, projections = [], []
    for pair_id in ("DC", "QG"):
        for action_id in FP.ACTIONS:
            w = build_world(pair_id, action_id)
            worlds.append(w)
            tpl = FP.action_template(action_id)
            for framing in FRAMINGS:
                projections.append(build_projection(w, framing, tpl))
    solos = [build_solo(k) for k in FP.CHARACTER_KEYS]
    solo_projections = [build_solo_projection(s) for s in solos]

    # ---- numeric self-checks (no raster) ----
    checks = {"scenes_validated_via_read_scene": len(projections) + len(solo_projections),
              "framing_fraction_within_tol": 0, "residual_recheck": {}, "box_in_canvas": 0}
    for pr in projections + solo_projections:
        fit = pr["camera_fit"]
        if fit.get("binding_axis") == "width":
            ok = abs(fit["achieved_width_frac"] - fit["width_cap"]) <= G.FRAME_TOL + 0.01
        else:
            ok = abs(fit["achieved_height_frac"] - fit["target_height_frac"]) <= G.FRAME_TOL + 0.01
        if ok:
            checks["framing_fraction_within_tol"] += 1
        for slot, b in pr["box_proxy"].items():
            nc = b["normalized_center"]
            if 0 <= nc["x"] <= 1 and 0 <= nc["y"] <= 1 and 0 < nc["width"] <= 1 and 0 < nc["height"] <= 1:
                checks["box_in_canvas"] += 1
    # recompute contact residuals from frozen angles, compare to recorded authoring_residuals
    for pair_id in ("DC", "QG"):
        for action_id in FP.ACTIONS:
            tpl = FP.action_template(action_id)
            w = build_world(pair_id, action_id)
            ca, cb = G.control_points(w["people"][0]), G.control_points(w["people"][1])
            rec = {}
            if action_id == "HAND":
                rec["wrist_to_wrist"] = round(float(np.linalg.norm(ca["right_wrist"] - cb["left_wrist"])), 4)
            elif action_id == "HUG":
                rec["chest_gap"] = round(float(np.linalg.norm(ca["chest"] - cb["chest"])), 4)
                for nm, p, t in (("A.left_wrist", ca["left_wrist"], tpl["authoring_targets"]["A.left_wrist"]),
                                 ("A.right_wrist", ca["right_wrist"], tpl["authoring_targets"]["A.right_wrist"]),
                                 ("B.right_wrist", cb["right_wrist"], tpl["authoring_targets"]["B.right_wrist"]),
                                 ("B.left_wrist", cb["left_wrist"], tpl["authoring_targets"]["B.left_wrist"])):
                    rec[nm] = round(float(np.linalg.norm(p - np.array(t, float))), 4)
            elif action_id == "KISS":
                rec["head_to_head"] = round(float(np.linalg.norm(ca["head"] - cb["head"])), 4)
            elif action_id == "CARRY":
                rec["B_ankle_y"] = [round(float(cb["left_ankle"][1]), 3), round(float(cb["right_ankle"][1]), 3)]
                rec["B_pelvis_y"] = round(float(cb["pelvis"][1]), 3)
            checks["residual_recheck"][action_id] = {
                "recorded": tpl.get("authoring_residuals"), "recomputed": rec,
            }

    geometry = {
        "schema": "yugang.anima-interaction-v1.structure.geometry",
        "version": 1,
        "generated_by": "T2a build_geometry.py (FK + projection numeric only; NO rasterization, NO GPU, NO output tuning)",
        "execution_state": "structure_source_frozen_unrendered",
        "visual_acceptance": "user_only; geometry is a composition guide (pose_enforcement=false), not a guaranteed pose/contact",
        "rs_commit": meta["rs_commit"],
        "rs_geometry_sha256": {"pose3d.py": meta["pose3d_sha256"], "mhr.py": meta["mhr_sha256"],
                               "mhr-body.json.gz": meta["mhr_body_gz_sha256"]},
        "mhr_asset": {"bones": meta["bones"], "controls": meta["controls"],
                      "finger_controls": len(meta["finger_controls"]), "presets": meta["presets"],
                      "source": meta["source"], "asset_ref": "preflight.json#/assets/mhr_mesh"},
        "canvas": {"width": CANVAS_W, "height": CANVAS_H, "aspect": "4:3", "all_framings": FRAMINGS},
        "scene_contract": {"version": 2, "mask_mode": "visible", "outline": True,
                           "validator": "frozen RS pose3d.read_scene (every scene passed)",
                           "size_cap_chars": 100000},
        "character_source_of_truth": FP.CHARACTER_SOURCE_OF_TRUTH,
        "pose_distribution_match": {
            "condition": "shaded 3D human body + outline (RS render_pose_condition, version 2 outline=True)",
            "matches_adapter": "anima_3dpose_outline_7000.safetensors (preflight.json#/assets/pose_lllite)",
            "tail_rule": "deepseek 鲸尾为同 owner occupancy union, 永不进 pose_image/LLLite 骨架; grok bat wings 是头饰, 不加背翼几何。",
        },
        "finger_limitation": (
            "MHR 暴露 54 controls, 其中 34 为逐指关节(存在性已闭合为肯定); 但无十指相扣预设、无接触/约束求解器。"
            "HAND 的腕接近+相对姿态+逐指角度为人工 authoring(FINGER_INTERLOCK), 非精确指间几何控制, 不保证真正交错而非穿插。"
            "实际十指表现交主人看图; 额外可控手指网格须单列探索, 不静默混入原生 LLLite 消融。"
        ),
        "envelope_proxy_note": (
            "相机拟合与 box proxy 基于 FK 控制点(+ ENVELOPE_BODY_MARGIN=0.11 体表白边, DC W/M 另含鲸尾), 是构图目标/辅助标记; "
            "权威 subject_envelope 与 box 由 T2b 渲染 owner visible mask 计算。不看出图调几何。"
        ),
        "worlds": worlds,
        "solo": solos,
        "projections": projections,
        "solo_projections": solo_projections,
        "counts": {"worlds": len(worlds), "projections": len(projections),
                   "solo": len(solos), "solo_projections": len(solo_projections),
                   "main_cases": len(projections), "assert_main_40": len(projections) == 40,
                   "assert_worlds_8": len(worlds) == 8, "assert_solo_4": len(solos) == 4},
        "self_checks": checks,
    }

    # ---- unrendered source index (44 cases) ----
    index_cases = {}
    for pr in projections:
        index_cases[pr["case_id"]] = {
            "world_id": pr["world_id"], "pair": pr["pair"], "action": pr["action"], "framing": pr["framing"],
            "is_solo": False, "status": "unrendered",
            "scene_ref": f"structure/frozen/geometry.json#/projections[case_id={pr['case_id']}]/scene_json",
            "camera": pr["camera"],
            "box_proxy": pr["box_proxy"],
            "box_authoritative": "pending_T2b_rendered_owner_visible_mask",
            "expected_visible_contacts": pr["expected_visible_contacts"],
            "expected_out_of_frame_parts": pr["expected_out_of_frame_parts"],
            "files": planned_files(pr["case_id"], False),
        }
    for pr in solo_projections:
        index_cases[pr["case_id"]] = {
            "world_id": pr["world_id"], "character": pr["character"], "action": "STAND", "framing": "M",
            "is_solo": True, "status": "unrendered",
            "scene_ref": f"structure/frozen/geometry.json#/solo_projections[case_id={pr['case_id']}]/scene_json",
            "camera": pr["camera"], "box_proxy": pr["box_proxy"],
            "box_authoritative": "pending_T2b_rendered_owner_visible_mask",
            "expected_visible_contacts": [], "expected_out_of_frame_parts": [],
            "files": planned_files(pr["case_id"], True),
        }
    source_index = {
        "schema": "yugang.anima-interaction-v1.structure.source_index",
        "version": 1,
        "execution_state": "unrendered_T2a_source_only",
        "generated_by": "T2a build_geometry.py",
        "render_program": "experiments/anima-interaction-v1/structure/render.py (T2b runs it; produces real PNG + sha256 + per-case structure_index.json)",
        "geometry_source": "experiments/anima-interaction-v1/structure/frozen/geometry.json",
        "asset_pointers": {"mhr_mesh": "preflight.json#/assets/mhr_mesh", "mhr_license": "preflight.json#/assets/mhr_license",
                           "pose_lllite": "preflight.json#/assets/pose_lllite"},
        "note": "T2a 未实际渲染: 不填不存在的 PNG/hash。每 case 给 scene 指针 + 相机 + FK-proxy box + planned files(status=unrendered)。T2b 成功渲染后产正式 structure_index.json(真实文件+sha256+权威 box), 覆盖本 unrendered 状态。",
        "case_count": len(index_cases),
        "assert_44": len(index_cases) == 44,
        "cases": index_cases,
    }

    _FROZEN_DIR.mkdir(parents=True, exist_ok=True)
    _INPUTS_STRUCTURE.mkdir(parents=True, exist_ok=True)
    (_FROZEN_DIR / "geometry.json").write_text(json.dumps(geometry, ensure_ascii=False, indent=1), encoding="utf-8")
    (_FROZEN_DIR / "source_index.json").write_text(json.dumps(source_index, ensure_ascii=False, indent=1), encoding="utf-8")
    (_INPUTS_STRUCTURE / "source_index.json").write_text(json.dumps(source_index, ensure_ascii=False, indent=1), encoding="utf-8")
    (_INPUTS_STRUCTURE / "README.md").write_text(
        "# inputs/structure — T2b 渲染落点\n\n"
        "本目录由 T2a 写入 unrendered `source_index.json`（44 case：40 主 + 4 单人）。\n"
        "T2b 运行 `experiments/anima-interaction-v1/structure/render.py` 后，在此按 `<case_id>/` 落\n"
        "真实 PNG（pose_image / owner_a / owner_b / repair_core / support / context / gray / preview）\n"
        "与每 case `structure_index.json`（真实文件 + sha256 + 权威 box），覆盖 unrendered 状态。\n"
        "几何唯一源：`experiments/anima-interaction-v1/structure/frozen/geometry.json`。\n"
        "T2a 未渲染、未填假 hash；GPU/真实采样不在本目录范围。\n", encoding="utf-8")

    print(json.dumps({
        "worlds": geometry["counts"]["worlds"], "projections": geometry["counts"]["projections"],
        "solo": geometry["counts"]["solo"], "assert_main_40": geometry["counts"]["assert_main_40"],
        "scenes_validated": checks["scenes_validated_via_read_scene"],
        "framing_within_tol": checks["framing_fraction_within_tol"],
        "box_in_canvas": checks["box_in_canvas"],
        "source_index_cases": source_index["case_count"], "assert_44": source_index["assert_44"],
        "wrote": ["structure/frozen/geometry.json", "structure/frozen/source_index.json",
                  "inputs/structure/source_index.json", "inputs/structure/README.md"],
    }, ensure_ascii=False, indent=2))
    print("residual_recheck:", json.dumps(checks["residual_recheck"], ensure_ascii=False))
    return geometry, source_index


if __name__ == "__main__":
    main()
