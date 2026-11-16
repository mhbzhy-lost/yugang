#!/usr/bin/env python3
"""WSL 侧：manifest → control 图渲染（与本地校验渲染同源同果，确定性）。
用法：PYTHONPATH=/home/mhbzhy/anima-lab/pydeps anima-lab venv python render-controls.py
"""
import json
import sys
from pathlib import Path

sys.path.insert(0, "/home/mhbzhy/anima-prod/ComfyUI/custom_nodes/comfyui-rs-multicharacter-sampler")
from PIL import Image
import pose3d

MANIFEST = Path("/tmp/train-regional/manifest.json")
OUT = Path("/tmp/train-regional/control")
OUT.mkdir(parents=True, exist_ok=True)

manifest = json.load(open(MANIFEST))
done = 0
for m in manifest:
    scene = json.loads(m["scene_json"])
    full, visible, shaded, control = pose3d._rasterize(scene, max_side=512, control_maps=True)
    Image.fromarray(control.astype("uint8")).save(OUT / f"{m['id']}.png")
    done += 1
    if done % 400 == 0:
        print(f"{done}/{len(manifest)}", flush=True)
print(f"control 渲染完成：{done}")
