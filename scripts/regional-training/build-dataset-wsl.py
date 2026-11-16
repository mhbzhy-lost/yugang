#!/usr/bin/env python3
"""Regional 训练数据构造：打标结果 → 变体计划 + control 图 + caption + manifest。

用法：render-poses 同款 venv。产物 /tmp/yugang-study/train-regional/
  control/<id>.png  颜色区域图（黑底人物纯色）
  manifest.json     变体清单（pose_idx/scene/caption/状态）
生成对照图（GPU 段）由 WSL 侧 gen-runner 消费 manifest 后回填 image/。
"""
import json
import random
import sys
import time
from pathlib import Path

sys.path.insert(0, "/home/mhbzhy/anima-prod/ComfyUI/custom_nodes/comfyui-rs-multicharacter-sampler")
from PIL import Image
import pose3d

random.seed(20261115)

TAGS = json.load(open("/tmp/pose-tags-raw.json"))
LIB = json.load(open("/tmp/ope-library.json"))["poses"]
OUT = Path("/tmp/train-regional")
(OUT / "control").mkdir(parents=True, exist_ok=True)

# ── 1. 过滤 + 分层采样 ──────────────────────────────────────────
BASE_POSTURES = ("standing", "sitting", "lying", "kneeling", "squatting", "crouching")
def base_of(tags):
    for b in BASE_POSTURES:
        if b in tags: return b
    return None

pools = {}
for idx, info in TAGS.items():
    if not info.get("confident") or not info.get("tags"): continue
    b = base_of(info["tags"])
    if b: pools.setdefault(b, []).append(int(idx))

POSES_PER_POSTURE = 140  # ~800 姿态（六体位 × 140，不足的体位全收）
VARIANTS = 4
picked = []
for b, ids in sorted(pools.items()):
    random.shuffle(ids)
    sel = ids[:POSES_PER_POSTURE]
    picked += [(i, b) for i in sel]
    print(f"{b}: {len(sel)}/{len(ids)}")
print(f"采样姿态合计 {len(picked)}，目标训练对 {len(picked) * VARIANTS}")

# ── 2. 场景词池（对照图生成用；caption 与生成正向词自洽） ────────
QUALITY = "masterpiece, best quality, absurdres, score_7, score_8, score_9, anime"
SCENES = ["flower field", "city street", "classroom", "sunset beach", "forest path", "rooftop at dusk",
          "cafe interior", "snowy park", "summer festival", "library", "rainy street", "mountain trail",
          "train station platform", "garden", "bedroom", "gymnasium", "shrine grounds", "harbor"]

# ── 3. 变体随机化 + control 渲染 ────────────────────────────────
def make_scene(pose, target_cx, cam_dist_jitter, cam_height_jitter):
    """构造单变体 scene：目标画面质心 → 世界坐标（E2 公式逆运算，粗略）。"""
    scene = json.loads(json.dumps(pose3d.default_scene()))
    aspect = scene["width"] / scene["height"]
    # fov 垂直视野高 3.6m：dx = (target_cx - 0.5) * 3.6 * aspect（x<0 = 画面左）
    dx = (target_cx - 0.5) * 3.6 * aspect
    person = scene["people"][0]
    person["joints"] = pose["joints"]
    person["position"] = [dx, pose.get("floor_y", 0.0), 0.0]
    scene["people"] = [person]
    # 相机随机：绕 target 的距离/高度（保持全身入画由掩码校验兜底）
    cam = scene["camera"]
    cam["position"][1] += cam_height_jitter
    cam["target"][1] += cam_height_jitter
    dist = ((cam["position"][0] - cam["target"][0]) ** 2 + (cam["position"][2] - cam["target"][2]) ** 2) ** .5
    k = dist_jit = cam_dist_jitter
    cam["position"][2] = cam["target"][2] + (cam["position"][2] - cam["target"][2]) * k
    return scene

manifest = []
t0 = time.time()
for pose_idx, posture in picked:
    pose = LIB[pose_idx]
    for v in range(VARIANTS):
        cx = random.uniform(0.12, 0.88)
        hjit = random.uniform(-0.25, 0.25)
        djit = random.uniform(0.75, 1.35)
        scene = make_scene(pose, cx, djit, hjit)
        try:
            full, visible, shaded, control = pose3d._rasterize(scene, max_side=512, control_maps=True)
        except Exception as e:  # noqa: BLE001
            continue
        cov = (control.sum(2) > 0).mean()
        # 掩码校验：覆盖 5%–70% 才收（太小=出画/太远，太大=特写怼脸）
        if not (0.05 <= cov <= 0.70): continue
        ys, xs = (control.sum(2) > 0).nonzero()
        real_cx = (xs.max() + xs.min()) / 2 / control.shape[1]
        real_cy = (ys.max() + ys.min()) / 2 / control.shape[0]
        cap = f"{QUALITY}, 1girl, solo, {', '.join(TAGS[str(pose_idx)]['tags'][:6])}, {random.choice(SCENES)}"
        rid = f"{pose_idx:04d}-{v}"
        Image.fromarray(control.astype("uint8")).save(OUT / "control" / f"{rid}.png")
        manifest.append({
            "id": rid, "pose_idx": pose_idx, "posture": posture,
            "target_cx": round(real_cx, 3), "target_cy": round(real_cy, 3), "coverage": round(float(cov), 3),
            "scene_json": json.dumps(scene), "caption": cap, "image": None,
        })
    if len(manifest) % 200 < VARIANTS:
        print(f"{len(manifest)} 对（{time.time() - t0:.0f}s）", flush=True)

json.dump(manifest, open(OUT / "manifest.json", "w"))
print(f"完成：{len(manifest)} 训练对（control 图 + manifest 就绪，待 GPU 段）")
