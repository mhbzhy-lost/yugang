# SPDX-License-Identifier: GPL-3.0-only
"""FROZEN authored structure data for anima-interaction-v1 (T2a).

This module is pure frozen data + light helpers. It holds NO rasterization and NO second
character/LoRA table. Character identity is referenced ONLY by key against the single source of
truth (src/tools/characters.ts + src/tools/tags/ai-girls.json, sha256 recorded below); the LoRA
file/weight facts live in spec.json + preflight.json and are NOT duplicated here.

The four action body poses were authored OFFLINE by numeric pattern-search IK (geometry_core.ik_solve)
against world-space contact targets, FK-only, with NO rasterization and NO look-at-output tuning.
The solved joint angles are hard-frozen below so geometry.json is deterministic and T2b only renders.
Measured residuals are frozen too and reported honestly: these are composition GUIDES
(pose_enforcement=false, no contact solver), NOT guaranteed contacts or precise interlock.

Coordinate frame: world Y up, +Z toward the reference camera, +X screen-right. MHR bind = A-pose,
~1.6 units tall at scale=1, faces +Z. rot.y>0 turns a person toward +X (screen-right).
All bodies use the canonical MHR adult preset proportions (scale=1.0, bulk=1.0): plan section 3.1
requires adult/normal-proportion/no-extra-body-change, and the MHR rig has no per-character morph,
so per-character scale/bulk would be unverified invention. Identity comes from LoRA/prompt, not geometry.
"""
from __future__ import annotations

# Single source of truth for characters (NOT re-tabulated here). Recorded for the
# "source table changed -> stop and start a new run" gate (spec.provenance).
CHARACTER_SOURCE_OF_TRUTH = {
    "path": "src/tools/characters.ts + src/tools/tags/ai-girls.json",
    "ai_girls_json_sha256": "50de0db51b2dca96e59ca7ac70b7e1556f067cc265c18ddd5fe9e166d3a36a93",
    "note": "本模块只按 key 引用角色; LoRA 文件/权重/inject 事实见 spec.json characters[] 与 preflight.json#/assets，不在此复制第二份表。",
}

# ---------------------------------------------------------------------------
# Finger interlock (HAND only). Authored at joint level on the two clasping hands.
# Flexion axis for the four fingers is +Y (probe: left_index1/2 +Y curls the tip up/forward
# toward the palm); thumb opposition uses +Y and +Z. The two hands are given the SAME curl table
# plus a small alternating lateral splay so the fingers are posed to interleave.
#
# HONEST LIMIT (preflight.rsMhr.fingerConditionLimits, plan section 4.2): finger CONTROL exists
# (34 per-finger joints), but there is NO interlock preset and NO contact/constraint solver. This
# table expresses authored wrist approach + hand orientation + per-finger angles. It is NOT precise
# inter-finger geometric control and does NOT guarantee the fingers actually interlock rather than
# interpenetrate. The master judges the real interlock visually.
# ---------------------------------------------------------------------------
FINGER_INTERLOCK = {
    # control suffix (applied per hand side): [x, y, z] degrees
    "thumb0": [0.0, 22.0, 14.0],
    "thumb1": [0.0, 18.0, 0.0],
    "thumb2": [0.0, 16.0, 0.0],
    "thumb3": [0.0, 12.0, 0.0],
    "index1": [0.0, 33.0, 4.0],
    "index2": [0.0, 43.0, 0.0],
    "index3": [0.0, 28.0, 0.0],
    "middle1": [0.0, 35.0, -3.0],
    "middle2": [0.0, 45.0, 0.0],
    "middle3": [0.0, 30.0, 0.0],
    "ring1": [0.0, 33.0, -4.0],
    "ring2": [0.0, 43.0, 0.0],
    "ring3": [0.0, 28.0, 0.0],
    "pinky0": [0.0, 16.0, -6.0],
    "pinky1": [0.0, 28.0, 0.0],
    "pinky2": [0.0, 36.0, 0.0],
    "pinky3": [0.0, 24.0, 0.0],
}
# The alternating splay sign per hand makes the two hands' fingers mesh rather than overlap exactly.
INTERLOCK_SPLAY_SIGN = {"A": 1.0, "B": -1.0}


def _interlock_joints(hand: str, splay_sign: float) -> dict:
    out: dict[str, list[float]] = {}
    for suffix, ang in FINGER_INTERLOCK.items():
        name = f"{hand}_{suffix}"
        out[name] = [ang[0], ang[1], ang[2] * splay_sign]
    return out


def hand_interlock_joints(slot: str, hand: str) -> dict:
    """slot in {'A','B'} -> splay sign; hand in {'left','right'}."""
    return _interlock_joints(hand, INTERLOCK_SPLAY_SIGN[slot])


# ---------------------------------------------------------------------------
# DeepSeek whale tail: SAME-OWNER occupancy union (owner=deepseek), NOT a third character slot and
# NOT a body joint. The MHR rig has NO tail bones (preflight: verified across all 127 names), and
# plan section 4.2 forbids adding a whale-tail skeleton tag to the human body / disguising a
# non-human appendage as LLLite skeleton. So the tail is frozen world geometry that T2b projects and
# unions into owner_a's region mask (B2 non-rectangular union) and into the box envelope. It is NEVER
# written into pose_image (the LLLite shaded-body condition stays a pure human body).
#
# Offsets are in the deepseek person's BODY-LOCAL frame relative to the pelvis control point
# (+x = person's left, +z = forward). The tail trails backward (-z) and down (-y), tapering to a
# horizontal fluke. T2b transforms each offset exactly like a control point:
#   world = pelvis_world + (off * scale*[bulk,1,bulk]) @ body_rotation.T
# and rasterizes a perspective-scaled filled disc of radius r*scale per segment, unioned into owner_a.
# ---------------------------------------------------------------------------
TAIL_DEEPSEEK = {
    "owner": "deepseek",
    "kind": "same_owner_occupancy_union",
    "anchor_control": "pelvis",
    "never_in": ["pose_image", "lllite_skeleton", "openpose", "body_joints"],
    "union_into": ["owner_a_region_mask_B2", "box_envelope_W_M"],
    "note": "鲸尾属 deepseek 同一角色 (DC 的 slot A); B2 与身体做同 owner union, 不加第三角色槽; 人体姿态条件不加鲸尾骨架标签。QG 无尾。",
    "segments": [
        {"off": [0.0, -0.02, -0.06], "r": 0.135},
        {"off": [0.0, -0.08, -0.24], "r": 0.120},
        {"off": [0.0, -0.18, -0.44], "r": 0.095},
        {"off": [0.0, -0.30, -0.64], "r": 0.070},
        {"off": [0.0, -0.44, -0.82], "r": 0.050},
        {"off": [0.0, -0.58, -0.95], "r": 0.038},
    ],
    "fluke": [
        {"off": [0.0, -0.60, -1.00], "r": 0.050},
        {"off": [0.17, -0.62, -1.07], "r": 0.085},
        {"off": [-0.17, -0.62, -1.07], "r": 0.085},
    ],
}

# ---------------------------------------------------------------------------
# The four FROZEN action body poses (IK-solved offline, FK-only, no raster, no output tuning).
# joints are per-slot dicts of control->[x,y,z] degrees, MERGED over the MHR 'standing' preset.
# authoring_residuals are the frozen measured endpoint errors (world units) from the IK solve;
# they are reported as honest evidence, NOT as pass/fail.
# ---------------------------------------------------------------------------
ACTION_TEMPLATES = {
    "HAND": {
        "action_id": "HAND",
        "world": "A 左 B 右, A 右手与 B 左手十指相扣, 其余手自然放置",
        "body": {
            "A": {"position": [-0.19, 0.0, 0.0], "rotation": [0.0, 88.0, 0.0], "scale": 1.0, "bulk": 1.0},
            "B": {"position": [0.19, 0.0, 0.0], "rotation": [0.0, -88.0, 0.0], "scale": 1.0, "bulk": 1.0},
        },
        "joints": {
            "A": {"right_shoulder": [10.35, -25.2, 5.8], "right_elbow": [0.0, -11.3, 5.0], "right_wrist": [0.0, 0.0, 0.0]},
            "B": {"left_shoulder": [10.35, -25.2, 5.8], "left_elbow": [0.0, -11.3, 5.0], "left_wrist": [0.0, 0.0, 0.0]},
        },
        # Clasping hands get the authored interlock finger curl on top of the arm pose.
        "interlock_hands": {"A": "right", "B": "left"},
        "authoring_targets": {"A.right_wrist": [0.0, 0.97, 0.24], "B.left_wrist": [0.0, 0.97, 0.24]},
        "authoring_residuals": {"wrist_to_wrist": 0.1623},
        "contact_group": {
            "kind": "wrist_approach_plus_authored_finger_interlock",
            "controls": ["A.right_wrist", "B.left_wrist"],
            "finger_controls": "A.right_* and B.left_* finger joints (authored interlock table)",
            "honest_limit": "wrists approach to 0.162 world units; fingers authored to interleave but interlock NOT guaranteed (no contact solver). 普通 OpenPose 不能表达十指交错; 这不是精确指间几何控制。",
        },
        "occlusion": "两人身侧相对(profile), 相握的手在两人之间偏相机侧; A 右臂与 B 左臂在胸前交叠, 手腕相邻。",
        "other_hands": "A.left / B.right 自然下垂 (bind standing)。",
    },
    "HUG": {
        "action_id": "HUG",
        "world": "正面相拥, 双臂分别绕向对方躯干, 保持可辨前后交叠",
        "body": {
            "A": {"position": [-0.17, 0.0, 0.0], "rotation": [0.0, 18.0, 0.0], "scale": 1.0, "bulk": 1.0},
            "B": {"position": [0.17, 0.0, 0.0], "rotation": [0.0, -18.0, 0.0], "scale": 1.0, "bulk": 1.0},
        },
        "joints": {
            "A": {"left_shoulder": [29.8, 9.15, 13.6], "left_elbow": [0.0, -42.2, 65.45],
                  "right_shoulder": [40.1, -57.95, 47.85], "right_elbow": [0.0, -55.55, 35.55],
                  "chest": [10.0, 0.0, 0.0]},
            "B": {"right_shoulder": [39.25, 14.05, 9.0], "right_elbow": [0.0, -50.55, 65.65],
                  "left_shoulder": [41.0, -64.0, 54.4], "left_elbow": [0.0, -57.45, 38.4],
                  "chest": [10.0, 0.0, 0.0]},
        },
        "authoring_targets": {
            "A.left_wrist": [0.05, 1.22, -0.12], "A.right_wrist": [0.01, 1.03, -0.14],
            "B.right_wrist": [-0.05, 1.22, -0.12], "B.left_wrist": [-0.01, 1.03, -0.14],
        },
        "authoring_residuals": {
            "A.left_wrist": 0.2111, "A.right_wrist": 0.2097,
            "B.right_wrist": 0.2291, "B.left_wrist": 0.2221, "chest_gap": 0.369,
        },
        "contact_group": {
            "kind": "mutual_torso_wrap",
            "controls": ["A.left_wrist", "A.right_wrist", "B.left_wrist", "B.right_wrist", "A.chest", "B.chest"],
            "honest_limit": "双手落在对方背部目标约 0.21 世界单位内, 胸腔间距 0.369; 手臂环绕与前后交叠为构图引导, 接触/遮挡非求解器保证。",
        },
        "occlusion": "A 双臂绕 B 躯干(一臂过肩一臂绕腰, 形成可辨前后交叠); B 双臂绕 A 躯干; 两人胸腹相接, 互相遮挡内侧手臂。",
        "other_hands": "无 (双臂均参与拥抱)。",
    },
    "KISS": {
        "action_id": "KISS",
        "world": "面对面嘴唇接触, 双头保持可读侧面或三分之四角度",
        "body": {
            "A": {"position": [-0.13, 0.0, 0.0], "rotation": [0.0, 82.0, 0.0], "scale": 1.0, "bulk": 1.0},
            "B": {"position": [0.13, 0.0, 0.0], "rotation": [0.0, -82.0, 0.0], "scale": 1.0, "bulk": 1.0},
        },
        "joints": {
            "A": {"chest": [-3.9, 4.3, 3.2], "neck": [0.0, 0.0, 3.5], "head": [0.0, 0.0, 0.0],
                  "left_shoulder": [5.2, -39.1, -12.3], "left_elbow": [0.9, -7.13, -26.64]},
            "B": {"chest": [3.9, -4.3, 3.2], "neck": [0.0, 0.0, 3.5], "head": [0.0, 0.0, 0.0],
                  "right_shoulder": [5.2, -39.1, -12.3], "right_elbow": [0.9, -7.13, -26.64]},
        },
        "authoring_targets": {
            "A.head": [-0.015, 1.50, 0.05], "B.head": [0.015, 1.50, 0.05],
            "A.left_wrist": [0.10, 1.10, -0.10], "B.right_wrist": [-0.10, 1.10, -0.10],
        },
        "authoring_residuals": {"head_to_head": 0.1478, "lip_proxy_to_lip_proxy": 0.041},
        "contact_group": {
            "kind": "lip_contact",
            "controls": ["A.head", "B.head"],
            "lip_proxy": "head control point + 0.10*forward - 0.03*up (lips are not an MHR control; proxy documented)",
            "honest_limit": "双头朝向相对(facing +x/-x), 唇代理点相距 0.041 世界单位(接近接触); 嘴唇非 MHR 控制点, 实际唇接触/鼻下巴不穿插由主人看图判定。",
        },
        "occlusion": "两人侧面相对(profile to camera), 头颈前倾相触; A 左手/B 右手轻搭对方腰背。",
        "other_hands": "A.right / B.left 自然下垂。",
    },
    "CARRY": {
        "action_id": "CARRY",
        "world": "A 背 B; B 在 A 身后双脚离地, A 双手承托 B 大腿, B 手臂自然搭 A 肩前",
        "body": {
            "A": {"position": [0.0, 0.0, 0.0], "rotation": [0.0, 0.0, 0.0], "scale": 1.0, "bulk": 1.0},
            # B sits HIGH on A's back: B pelvis ~1.224 (A pelvis 0.924), behind A (z=-0.30), raised (y=+0.30)
            # so B's feet clear the ground. A's arms (reach < ~0.55 from shoulder y1.42) cannot go below
            # y~0.87, so B must be high for A's hands to support B's thighs — a hard rig constraint found by FK.
            "B": {"position": [0.0, 0.30, -0.30], "rotation": [0.0, 0.0, 0.0], "scale": 1.0, "bulk": 1.0},
        },
        "joints": {
            "A": {"chest": [8.0, 1.0, -6.75],
                  "left_shoulder": [2.3, -0.3, -34.75], "left_elbow": [0.0, -33.25, -14.0],
                  "right_shoulder": [3.15, 1.45, -39.45], "right_elbow": [0.0, -32.45, -16.3]},
            "B": {"chest": [-2.7, -0.15, 10.25],
                  "left_hip": [1.75, -11.45, 12.15], "left_knee": [0.0, 2.05, -73.75], "left_ankle": [0.0, 0.0, 0.0],
                  "right_hip": [1.75, -11.45, 12.15], "right_knee": [0.0, 2.05, -73.75], "right_ankle": [0.0, 0.0, 0.0],
                  "left_shoulder": [2.3, -28.05, 33.1], "left_elbow": [0.0, -26.55, 27.0],
                  "right_shoulder": [2.85, -29.7, 34.6], "right_elbow": [0.0, -27.7, 27.0]},
        },
        "authoring_targets": {
            "A.left_wrist": [0.24, 0.93, -0.10], "A.right_wrist": [-0.24, 0.93, -0.10],
            "B.left_ankle": [0.24, 0.56, -0.04], "B.right_ankle": [-0.24, 0.56, -0.04],
            "B.left_knee": [0.27, 0.92, -0.10], "B.right_knee": [-0.27, 0.92, -0.10],
            "B.left_wrist": [0.15, 1.46, 0.05], "B.right_wrist": [-0.15, 1.46, 0.05],
        },
        "authoring_residuals": {
            "A.left_wrist": 0.0552, "A.right_wrist": 0.0509,
            "B.left_ankle": 0.032, "B.right_ankle": 0.032,
            "B.left_knee": 0.3267, "B.right_knee": 0.3267,
            "B.left_wrist": 0.0703, "B.right_wrist": 0.0584,
            "B_ankle_y": [0.585, 0.585], "B_pelvis_y": 1.224,
        },
        "contact_group": {
            "kind": "piggyback_load_bearing",
            "controls": ["A.left_wrist", "A.right_wrist", "B.left_hip", "B.right_hip", "B.left_knee", "B.right_knee",
                         "B.left_wrist", "B.right_wrist", "B.left_ankle", "B.right_ankle"],
            "honest_limit": "A 双手落在 B 大腿/膝目标 0.05 内(承托); B 双脚离地(ankle y=0.585>0); B 双手落 A 肩 0.06-0.07; B 膝绕 A 两侧(x=±)但 z 偏后(膝目标残差 0.33, 腿wrap前绕程度为构图近似)。背部承重为构图引导, 非受力求解。",
        },
        "occlusion": "B 在 A 身后(z=-0.30)偏高(pelvis y1.224), A 躯干遮挡 B 下半身前侧; A 双臂向后下承托 B 大腿; B 双臂过 A 肩垂于胸前; B 小腿在 A 体侧后方, 双脚离地。",
        "other_hands": "无 (A 双手承托, B 双手搭肩)。",
        "owner_note": "A=承托者(deepseek/qwen), B=被背者(claude/grok); 反向背负与左右互换是后续扩展, 不混入首轮。",
    },
}

# Single-actor SOLO template (W-S): canonical standing pose, facing camera, centered.
SOLO_TEMPLATE = {
    "action_id": "STAND",
    "framing": "M",
    "body": {"A": {"position": [0.0, 0.0, 0.0], "rotation": [0.0, 0.0, 0.0], "scale": 1.0, "bulk": 1.0}},
    "joints": {"A": {}},  # empty -> pure MHR 'standing' preset
    "contact_group": None,
    "occlusion": "单人站姿, 无交互无遮挡。",
}

# ---------------------------------------------------------------------------
# Pair owner bindings: 8 worlds = 4 action templates x 2 pairs. Body geometry is shared per action
# (same MHR adult rig); the world instance differs by which character_key occupies slot A/B and by
# per-world owner annotations (deepseek tail union for DC; grok bat-wings = headwear note for QG).
# ---------------------------------------------------------------------------
PAIRS = {
    "DC": {
        "pair_id": "DC",
        "A": "deepseek",
        "B": "claude",
        "lora_relationship": "different_files",
        "owner_annotations": {
            "A": "deepseek: 鲸尾(cetacean tail)为同 owner occupancy union (TAIL_DEEPSEEK), 不加第三角色槽, 不进 pose_image 骨架; 保留发色/发饰/服装(LoRA 身份)。",
            "B": "claude: 保留发色/发饰与服装(LoRA 身份); 无几何附属物 union。",
        },
        "tail_owner_slot": "A",  # deepseek carries the tail union
    },
    "QG": {
        "pair_id": "QG",
        "A": "qwen",
        "B": "grok",
        "lora_relationship": "same_file_different_trigger",
        "owner_annotations": {
            "A": "qwen: 保留渐变发/辫子/小帽(LoRA 身份); 小帽为头饰, 不单独 union 几何(尺寸小, 由 LoRA 表达)。",
            "B": "grok: 保留双马尾/尖耳/冠饰(LoRA 身份); 头饰段 bat wings 是 HEADWEAR, 不擅自解释为必须长出一对巨大背翼, 故不加背翼几何 union。",
        },
        "tail_owner_slot": None,  # no whale tail in QG
    },
}

# Character keys referenced (identity facts live in spec.json/preflight, NOT here).
CHARACTER_KEYS = ["deepseek", "claude", "qwen", "grok"]

# Action -> ordered slot assignment mnemonic (A=left/主, B=right/次; CARRY: A 背 B).
ACTIONS = ["HAND", "HUG", "KISS", "CARRY"]


def action_template(action_id: str) -> dict:
    return ACTION_TEMPLATES[action_id]


def person_joints(action_id: str, slot: str) -> dict:
    """Frozen joints for one slot, merged over the standing preset, incl. HAND interlock fingers."""
    tpl = ACTION_TEMPLATES[action_id] if action_id in ACTION_TEMPLATES else SOLO_TEMPLATE
    joints = dict(tpl["joints"].get(slot, {}))
    interlock = tpl.get("interlock_hands")
    if interlock and slot in interlock:
        joints.update(hand_interlock_joints(slot, interlock[slot]))
    return joints


def person_body(action_id: str, slot: str) -> dict:
    tpl = ACTION_TEMPLATES[action_id] if action_id in ACTION_TEMPLATES else SOLO_TEMPLATE
    return dict(tpl["body"][slot])
