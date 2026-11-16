#!/usr/bin/env python3
"""姿态库批量渲染 shaded 姿态图（打标原料）。

1199 姿态 → default 相机全身构图 → render_pose_condition → PNG。
输出 /tmp/yugang-study/pose-renders/<idx>.png + index.json。
"""
import json
import sys
import time
from pathlib import Path

sys.path.insert(0, "/tmp/yugang-study/rsconv/pkg/comfyui-rs-multicharacter-sampler")

from PIL import Image

import pose3d

LIB = json.load(open("/tmp/yugang-study/rsconv/out-lib/library.json"))
OUT = Path("/tmp/yugang-study/pose-renders")
OUT.mkdir(parents=True, exist_ok=True)

base = pose3d.default_scene()

start = int(sys.argv[1]) if len(sys.argv) > 1 else 0
end = int(sys.argv[2]) if len(sys.argv) > 2 else len(LIB["poses"])

t0 = time.time()
skipped = []
for i in range(start, min(end, len(LIB["poses"]))):
    p = LIB["poses"][i]
    scene = json.loads(json.dumps(base))
    person = scene["people"][0]
    person["joints"] = p["joints"]
    person["position"] = [0.0, p.get("floor_y", 0.0), 0.0]
    scene["people"] = [person]
    try:
        rgb = pose3d.render_pose_condition(scene, max_side=448)
        img = Image.fromarray(rgb.astype("uint8"))
        img.save(OUT / f"{i:04d}.png")
    except Exception as e:  # noqa: BLE001
        skipped.append({"idx": i, "reason": str(e)[:120]})
    if (i - start + 1) % 100 == 0:
        rate = (i - start + 1) / (time.time() - t0)
        print(f"{i+1}/{end}: {rate:.1f} 张/秒, 跳过 {len(skipped)}", flush=True)

if start == 0:
    json.dump({"total": len(LIB["poses"]), "rendered": end - start - len(skipped), "skipped": skipped},
              open(OUT / "render-index.json", "w"))
print(f"完成 [{start},{end}): 跳过 {len(skipped)}")
