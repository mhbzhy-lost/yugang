# SPDX-License-Identifier: GPL-3.0-only
"""T2a numeric/JSON/AST self-check for the structure source. NO rasterization, NO GPU, NO image decode.

Run:  /usr/local/bin/python3 experiments/anima-interaction-v1/structure/selfcheck.py
Exit 0 = all mechanical checks pass. This does NOT judge images, actions, identity or framing quality
(those are the master's eyes only); it only proves the frozen geometry is internally consistent, schema
valid against the frozen RS read_scene, and that T2a never crossed into the rasterizer.
"""
from __future__ import annotations

import ast
import hashlib
import json
import sys
from pathlib import Path

import numpy as np

HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(HERE))
import rs_bridge  # noqa: E402
import geometry_core as G  # noqa: E402
import frozen_poses as FP  # noqa: E402

REPO = Path(__file__).resolve().parent.parent.parent.parent
GEOM = HERE / "frozen" / "geometry.json"
SIDX = HERE / "frozen" / "source_index.json"
AI_GIRLS = REPO / "src" / "tools" / "tags" / "ai-girls.json"

# Modules that must NEVER call the rasterizer (only render.py may).
NO_RASTER_MODULES = ["build_geometry.py", "geometry_core.py", "frozen_poses.py", "selfcheck.py"]
FORBIDDEN_CALLS = {"_rasterize", "render_pose_condition", "render_scene"}

results: list[tuple[str, bool, str]] = []


def check(name, ok, detail=""):
    results.append((name, bool(ok), detail))


def _sha256(p: Path) -> str:
    h = hashlib.sha256()
    with open(p, "rb") as f:
        for chunk in iter(lambda: f.read(1 << 20), b""):
            h.update(chunk)
    return h.hexdigest()


def _calls_in(path: Path) -> set:
    tree = ast.parse(path.read_text(encoding="utf-8"))
    names = set()
    for node in ast.walk(tree):
        if isinstance(node, ast.Call):
            f = node.func
            if isinstance(f, ast.Attribute):
                names.add(f.attr)
            elif isinstance(f, ast.Name):
                names.add(f.id)
    return names


def main():
    rs_bridge.load()
    pose3d = rs_bridge.pose3d()
    meta = rs_bridge.asset_meta()
    geom = json.loads(GEOM.read_text(encoding="utf-8"))
    sidx = json.loads(SIDX.read_text(encoding="utf-8"))

    # 1. JSON validity + counts
    check("geometry.json parses", isinstance(geom, dict))
    check("source_index.json parses", isinstance(sidx, dict))
    c = geom["counts"]
    check("8 worlds", c["worlds"] == 8 and c["assert_worlds_8"], str(c["worlds"]))
    check("40 projections", c["projections"] == 40 and c["assert_main_40"], str(c["projections"]))
    check("4 solo", c["solo"] == 4 and c["assert_solo_4"], str(c["solo"]))
    check("44 source-index cases", sidx["case_count"] == 44 and sidx["assert_44"], str(sidx["case_count"]))
    case_ids = [p["case_id"] for p in geom["projections"]]
    check("40 unique case_ids", len(set(case_ids)) == 40, f"{len(set(case_ids))}")

    # 2. every scene passes the FROZEN RS read_scene + camera validity + scene contract
    all_scenes = [p["scene_json"] for p in geom["projections"]] + [p["scene_json"] for p in geom["solo_projections"]]
    n_valid = n_cam = n_contract = 0
    for sc in all_scenes:
        try:
            pose3d.read_scene(json.dumps(sc))
            n_valid += 1
        except Exception as e:  # noqa: BLE001
            check("read_scene failure", False, str(e)[:120])
            break
        d = np.array(sc["camera"]["position"]) - np.array(sc["camera"]["target"])
        if np.linalg.norm(d) >= 0.5 and np.linalg.norm(np.cross(d, [0, 1, 0])) >= 1e-4:
            n_cam += 1
        if sc["version"] == 2 and sc["mask_mode"] == "visible" and sc["outline"] is True \
                and sc["width"] == 1024 and sc["height"] == 768:
            n_contract += 1
    check("all 44 scenes pass frozen read_scene", n_valid == len(all_scenes), f"{n_valid}/{len(all_scenes)}")
    check("all cameras satisfy distinct-target/nonvertical gate", n_cam == len(all_scenes), f"{n_cam}/{len(all_scenes)}")
    check("all scenes version2/visible/outline/1024x768", n_contract == len(all_scenes), f"{n_contract}/{len(all_scenes)}")

    # 3. boxes normalized in [0,1], non-empty
    n_box = n_box_ok = 0
    for p in geom["projections"] + geom["solo_projections"]:
        for slot, b in p["box_proxy"].items():
            n_box += 1
            nc = b["normalized_center"]
            if 0 <= nc["x"] <= 1 and 0 <= nc["y"] <= 1 and 0 < nc["width"] <= 1 and 0 < nc["height"] <= 1 and not nc["empty"]:
                n_box_ok += 1
    check("all proxy boxes normalized in-canvas", n_box_ok == n_box, f"{n_box_ok}/{n_box}")

    # 4. framing fractions hit target on the binding axis
    n_fit = 0
    for p in geom["projections"] + geom["solo_projections"]:
        f = p["camera_fit"]
        if f.get("binding_axis") == "width":
            ok = abs(f["achieved_width_frac"] - f["width_cap"]) <= G.FRAME_TOL + 0.01
        else:
            ok = abs(f["achieved_height_frac"] - f["target_height_frac"]) <= G.FRAME_TOL + 0.01
        n_fit += int(ok)
    check("all framing fits within tol on binding axis", n_fit == len(all_scenes), f"{n_fit}/{len(all_scenes)}")

    # 5. residual recheck reproduces the frozen authoring_residuals from the frozen angles
    rr = geom["self_checks"]["residual_recheck"]
    hand_ok = abs(rr["HAND"]["recomputed"]["wrist_to_wrist"] - rr["HAND"]["recorded"]["wrist_to_wrist"]) < 1e-3
    kiss_ok = abs(rr["KISS"]["recomputed"]["head_to_head"] - rr["KISS"]["recorded"]["head_to_head"]) < 1e-3
    carry_ok = (rr["CARRY"]["recomputed"]["B_pelvis_y"] == rr["CARRY"]["recorded"]["B_pelvis_y"]
                and rr["CARRY"]["recomputed"]["B_ankle_y"] == rr["CARRY"]["recorded"]["B_ankle_y"])
    hug_ok = abs(rr["HUG"]["recomputed"]["chest_gap"] - rr["HUG"]["recorded"]["chest_gap"]) < 1e-3
    check("HAND residual reproduces", hand_ok, json.dumps(rr["HAND"]["recomputed"]))
    check("HUG residual reproduces", hug_ok, json.dumps(rr["HUG"]["recomputed"].get("chest_gap")))
    check("KISS residual reproduces", kiss_ok, json.dumps(rr["KISS"]["recomputed"]))
    check("CARRY residual reproduces (B off-ground, pelvis high)", carry_ok, json.dumps(rr["CARRY"]["recomputed"]))
    check("CARRY B feet off ground (ankle y>0.1)", min(rr["CARRY"]["recomputed"]["B_ankle_y"]) > 0.1,
          json.dumps(rr["CARRY"]["recomputed"]["B_ankle_y"]))

    # 6. MHR finger controls present + honest limitation text
    check("MHR exposes 34 finger controls", len(meta["finger_controls"]) == 34, str(len(meta["finger_controls"])))
    check("MHR controls == 54", meta["controls"] == 54, str(meta["controls"]))
    fl = geom["finger_limitation"]
    check("finger limitation states 'not guaranteed / 不保证'", ("不保证" in fl or "NOT guarantee" in fl.lower()
          or "非精确" in fl), fl[:60])
    check("finger limitation forbids 'precise inter-finger' claim", "精确指间" in fl or "precise inter-finger" in fl.lower())

    # 7. character source-of-truth sha256 matches the real ai-girls.json (no second LoRA table here)
    if AI_GIRLS.is_file():
        real = _sha256(AI_GIRLS)
        check("ai-girls.json sha256 matches recorded source-of-truth",
              real == FP.CHARACTER_SOURCE_OF_TRUTH["ai_girls_json_sha256"], real[:16])
    else:
        check("ai-girls.json present", False, str(AI_GIRLS))
    # geometry must NOT carry lora file/weight facts (those live in spec/preflight only)
    blob = json.dumps(geom, ensure_ascii=False)
    check("geometry carries no LoRA filename", "safetensors" not in blob.replace("anima_3dpose_outline_7000.safetensors", ""),
          "only the pose adapter name (asset pointer) may appear")

    # 8. tail rule: deepseek tail is owner-union occupancy, never skeleton/pose_image
    tail = FP.TAIL_DEEPSEEK
    check("tail owner == deepseek", tail["owner"] == "deepseek")
    check("tail never_in pose_image/skeleton", all(k in tail["never_in"] for k in ("pose_image", "lllite_skeleton", "body_joints")))
    check("tail kind = same_owner_occupancy_union", tail["kind"] == "same_owner_occupancy_union")
    check("QG has no tail slot", FP.PAIRS["QG"]["tail_owner_slot"] is None)
    check("DC tail slot = A (deepseek)", FP.PAIRS["DC"]["tail_owner_slot"] == "A")
    # grok bat wings recorded as headwear, no back-wing geometry
    check("grok bat-wings annotated as headwear (no back-wing geometry)", "头饰" in FP.PAIRS["QG"]["owner_annotations"]["B"]
          and "背翼" in FP.PAIRS["QG"]["owner_annotations"]["B"])

    # 9. AST: no T2a module calls the rasterizer (only render.py may)
    for mod in NO_RASTER_MODULES:
        calls = _calls_in(HERE / mod)
        bad = calls & FORBIDDEN_CALLS
        check(f"{mod} never rasterizes", not bad, f"forbidden calls: {sorted(bad)}" if bad else "clean")
    render_calls = _calls_in(HERE / "render.py")
    check("render.py DOES drive the frozen rasterizer", bool(render_calls & {"_rasterize"}),
          f"render.py calls: {sorted(render_calls & FORBIDDEN_CALLS)}")

    # 10. owner/contact/visibility annotations present per case
    n_vis = sum(1 for p in geom["projections"] if "expected_visible_contacts" in p and "expected_out_of_frame_parts" in p)
    check("all 40 projections declare expected visibility", n_vis == 40, f"{n_vis}/40")
    n_contact = sum(1 for w in geom["worlds"] if w.get("contact_group"))
    check("all 8 worlds carry a contact_group", n_contact == 8, f"{n_contact}/8")

    # 11. source index is explicitly unrendered, no fake hash/png
    check("source_index execution_state = unrendered", sidx["execution_state"] == "unrendered_T2a_source_only", sidx["execution_state"])
    fake = 0
    for cid, ce in sidx["cases"].items():
        if ce["status"] != "unrendered":
            fake += 1
        for fn, fe in ce["files"].items():
            if fn.endswith(".png") and fe["sha256"] is not None:
                fake += 1
    check("no fake png sha256 / all cases unrendered in source index", fake == 0, f"violations={fake}")

    # ---- report ----
    npass = sum(1 for _, ok, _ in results if ok)
    nfail = len(results) - npass
    for name, ok, detail in results:
        print(f"[{'PASS' if ok else 'FAIL'}] {name}" + (f"  :: {detail}" if detail and not ok else ""))
    print(f"\nselfcheck: {npass}/{len(results)} passed, {nfail} failed")
    return 0 if nfail == 0 else 1


if __name__ == "__main__":
    raise SystemExit(main())
