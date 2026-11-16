#!/usr/bin/env python3
"""WSL 侧 GPU 生成 runner：manifest → 逐条组 graph（fast 直出模板）→ 提交 → 收图。

用法（WSL）：nohup python3 /tmp/gen-runner.py > /tmp/gen-runner.log 2>&1 &
断点：manifest 里 image 非空的条目跳过；每 20 张回写 manifest。
"""
import json
import time
import urllib.request
import urllib.error
from pathlib import Path

BASE = "http://127.0.0.1:8188"
MANIFEST = Path("/tmp/yugang-study-sync/manifest.json")  # 与本地同步目录（scp/base64 回传）
OUTDIR = Path("/tmp/yugang-study-sync/image")
TEMPLATE = json.load(open("/tmp/gen-template.json"))

def submit(graph):
    body = json.dumps({"prompt": graph, "client_id": "regional-data"}).encode()
    r = urllib.request.urlopen(urllib.request.Request(f"{BASE}/prompt", body, {"Content-Type": "application/json"}), timeout=30)
    return json.load(r)["prompt_id"]

def wait(pid, timeout=600):
    t0 = time.time()
    while time.time() - t0 < timeout:
        try:
            h = json.load(urllib.request.urlopen(f"{BASE}/history/{pid}", timeout=15))
        except Exception:  # noqa: BLE001
            time.sleep(5); continue
        if not h: time.sleep(5); continue
        e = list(h.values())[0]
        st = e.get("status", {})
        if st.get("completed") or st.get("status_str") in ("error",):
            imgs = []
            for out in e.get("outputs", {}).values():
                imgs += out.get("images", [])
            if st.get("status_str") == "error":
                return None
            return imgs  # SaveImage 输出
        time.sleep(5)
    return None

manifest = json.load(open(MANIFEST))
todo = [m for m in manifest if m.get("image") is None]
print(f"待生成 {len(todo)}/{len(manifest)}", flush=True)
OUTDIR.mkdir(parents=True, exist_ok=True)
done = fail = 0
for i, m in enumerate(todo):
    g = json.loads(json.dumps(TEMPLATE))
    # 找正向词节点（CLIPTextEncode，正向 = 带 masterpiece 的那个）
    for nid, n in g.items():
        if n["class_type"] == "CLIPTextEncode" and "masterpiece" in str(n["inputs"].get("text", "")):
            n["inputs"]["text"] = m["caption"]
    for nid, n in g.items():  # seed（KSampler）
        if n["class_type"] == "KSampler":
            n["inputs"]["seed"] = 100000 + m["pose_idx"] * 10 + int(m["id"][-1])
    for nid, n in g.items():  # 输出前缀
        if n["class_type"] == "SaveImage":
            n["inputs"]["filename_prefix"] = f"regional-data/{m['id']}"
    try:
        pid = submit(g)
        imgs = wait(pid)
        if imgs:
            # 图在 ComfyUI output 目录，复制到同步目录
            import shutil
            src = Path.home() / "anima-prod/ComfyUI/output" / imgs[0]["subfolder"] / imgs[0]["filename"]
            dst = OUTDIR / f"{m['id']}.png"
            shutil.copy(src, dst)
            m["image"] = str(dst)
            done += 1
        else:
            fail += 1
    except Exception as e:  # noqa: BLE001
        print("FAIL", m["id"], str(e)[:120], flush=True)
        fail += 1
    if (i + 1) % 20 == 0:
        json.dump(manifest, open(MANIFEST, "w"))
        print(f"{i+1}/{len(todo)} done={done} fail={fail}", flush=True)

json.dump(manifest, open(MANIFEST, "w"))
print(f"生成完成：done={done} fail={fail}", flush=True)
