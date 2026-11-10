#!/usr/bin/env python3
"""hd / 管线阶段级 bisect 的 Windows 侧运行器。

只读诊断：不改鱼与 ComfyUI 的任何配置。图 JSON 由本地 scripts/experiments/hd-bisect.ts
从生产 makeGraph 导出（单人/双人直出同模板，模板带 SHA-256 校验），本脚本不手抄任何节点，
只按图里的 PreviewImage 抽头取图并测量。

阶段判定（按抽头读取的源节点归类，单人/双人通用）：
  43 / 5    initial    初采样原图
  92 / 62   upscaled   AnimeSharp 4x + ImageScaleBy 之后，未经二次采样
  8  / 65   resampled  二次采样 VAEDecode 之后，未经脸修
  其余       final      生产实际出图（hd 时脸修后还有纯放大尾部 95/96/97）

判定口径（同一次提交内、同分辨率可直接比较拉普拉斯方差）：
  resampled/upscaled ≈ 0.78  -> 二次采样在健康域（2x）
  resampled/upscaled ≈ 0.55  -> 二次采样超域（曾把 hd 推到 3x latent 时的实测值）
  final 缩回 upscaled 分辨率后的 lapVar 应不低于同 seed 2x 成品 -> 尾部纯放大真带细节

安全约定（与 impact-dual-candidate.py 一致）：
  - 提交前要求生产队列空闲，避免挤掉线上鱼的真实画图
  - 提交结果不明（prompt_id 不回显 / history 超时）一律中止且不重试
  - 断线可续接：state.json 记下 prompt_id 后，重跑只重新挂轮询，绝不重复提交

用法（Windows 内嵌 Python，自带 numpy/cv2/PIL）：
  python.exe hd-bisect-run.py OUTDIR GRAPH_JSON [TAG]
"""
import base64
import json
import sys
import time
import urllib.error
import urllib.parse
import urllib.request
import uuid
from pathlib import Path

import cv2
import numpy as np

BASE = "http://127.0.0.1:8188"
DEADLINE_S = 1800
STAGE_OF_SOURCE = {"43": "initial", "5": "initial", "92": "upscaled", "62": "upscaled", "8": "resampled", "65": "resampled"}


def req(path, data=None, headers=None, timeout=30):
    request = urllib.request.Request(BASE + path, data=data, headers=headers or {})
    with urllib.request.urlopen(request, timeout=timeout) as response:
        return response.read()


def get_json(path):
    return json.loads(req(path))


def fail(msg):
    print("ABORT", msg, flush=True)
    raise SystemExit(1)


def require_idle(tag):
    queue = get_json("/queue")
    if not isinstance(queue.get("queue_running"), list) or not isinstance(queue.get("queue_pending"), list):
        fail("queue status unavailable")
    if queue["queue_running"] or queue["queue_pending"]:
        fail("%s: 生产队列忙（running=%d pending=%d），未提交" % (tag, len(queue["queue_running"]), len(queue["queue_pending"])))


def submit_or_reattach(root, tag, graph):
    """返回 prompt_id。已有 accepted 状态则只续接，绝不重复提交。"""
    state_path = root / "state.json"
    if state_path.exists():
        state = json.loads(state_path.read_text(encoding="utf-8"))
        if state.get("state") in ("accepted", "submitting") and state.get("prompt_id"):
            print("REATTACH", tag, state["prompt_id"], "（不重复提交）", flush=True)
            return state["prompt_id"]
        if state.get("state") == "success":
            print("ALREADY_DONE", tag, flush=True)
            return state["prompt_id"]
    require_idle(tag)
    prompt_id = str(uuid.uuid4())
    state_path.write_text(json.dumps({"tag": tag, "prompt_id": prompt_id, "state": "submitting"}), encoding="utf-8")
    scale = graph.get("92", graph.get("62", {})).get("inputs", {}).get("scale_by")
    print("SUBMITTING", tag, prompt_id, "首级 scale_by=%s" % scale, flush=True)
    payload = json.dumps({"prompt": graph, "prompt_id": prompt_id, "client_id": str(uuid.uuid4())}).encode("utf-8")
    try:
        result = json.loads(req("/prompt", payload, {"Content-Type": "application/json"}, timeout=30))
    except urllib.error.HTTPError as e:
        print("REJECTED", e.code, e.read().decode("utf-8", errors="replace")[:500], flush=True)
        raise
    if result.get("prompt_id") != prompt_id:
        fail("提交结果不明（prompt_id 未回显）；不重试，需人工核对 ComfyUI 队列")
    state_path.write_text(json.dumps({"tag": tag, "prompt_id": prompt_id, "state": "accepted"}), encoding="utf-8")
    print("ACCEPTED", tag, flush=True)
    return prompt_id


def wait_history(root, tag, prompt_id):
    state_path = root / "state.json"
    deadline = time.monotonic() + DEADLINE_S
    while time.monotonic() < deadline:
        job = get_json("/history/" + prompt_id).get(prompt_id)
        if job:
            (root / (tag + "-history.json")).write_text(json.dumps(job, ensure_ascii=False, indent=2), encoding="utf-8")
            status = job.get("status", {})
            ok = status.get("status_str") == "success" and status.get("completed") is True
            state_path.write_text(json.dumps({"tag": tag, "prompt_id": prompt_id, "state": "success" if ok else "failed"}), encoding="utf-8")
            if not ok:
                fail("%s 执行失败，见 %s-history.json" % (tag, tag))
            print("COMPLETED", tag, flush=True)
            return job
        time.sleep(3)
    fail("%s history 超时（%ds）；提交结果不明，不重试（可用同一 OUTDIR 重跑以续接）" % (tag, DEADLINE_S))


def fetch_image(descriptor):
    filename = descriptor.get("filename", "")
    if descriptor.get("type") != "temp" or descriptor.get("subfolder") or "/" in filename or "\\" in filename or not filename.endswith(".png"):
        fail("输出路径异常: %r" % (descriptor,))
    query = urllib.parse.urlencode({"filename": filename, "subfolder": "", "type": "temp"})
    return req("/view?" + query, timeout=120)


def metrics(img):
    """全图与脸部代理区域的高频能量。同一次运行内同分辨率的抽头可直接比较。"""
    gray = cv2.cvtColor(img, cv2.COLOR_BGR2GRAY).astype(np.float64)
    lap = cv2.Laplacian(gray, cv2.CV_64F)
    h, w = gray.shape
    size = min(int(w * 0.6), int(h * 0.3))
    x0 = (w - size) // 2
    y0 = int(h * 0.1)
    face = lap[y0:y0 + size, x0:x0 + size]
    return {
        "w": int(w), "h": int(h),
        "lapVar": float(lap.var()), "lapMeanAbs": float(np.abs(lap).mean()),
        "faceLapVar": float(face.var()), "faceLapMeanAbs": float(np.abs(face).mean()),
        "faceBox": [int(x0), int(y0), int(size)],
    }


def main():
    if len(sys.argv) not in (3, 4):
        raise SystemExit("usage: hd-bisect-run.py OUTDIR GRAPH_JSON [TAG]")
    root = Path(sys.argv[1])
    graph = json.loads(Path(sys.argv[2]).read_text(encoding="utf-8"))
    tag = sys.argv[3] if len(sys.argv) == 4 else Path(sys.argv[2]).stem
    root.mkdir(parents=True, exist_ok=True)

    previews = [nid for nid, node in graph.items() if node.get("class_type") == "PreviewImage"]
    if len(previews) < 3:
        fail("图里 PreviewImage 抽头少于 3 个：%r" % (previews,))

    prompt_id = submit_or_reattach(root, tag, graph)
    job = wait_history(root, tag, prompt_id)

    result = {"tag": tag, "prompt_id": prompt_id, "stages": {}}
    for node_id in previews:
        source = str(graph[node_id]["inputs"]["images"][0])
        stage = STAGE_OF_SOURCE.get(source, "final")
        images = job.get("outputs", {}).get(node_id, {}).get("images", [])
        if len(images) != 1:
            fail("抽头 %s（源 %s）输出缺失或不止一张" % (node_id, source))
        png = fetch_image(images[0])
        png_path = root / ("%s-%s.png" % (tag, stage))
        png_path.write_bytes(png)
        img = cv2.imdecode(np.frombuffer(png, np.uint8), cv2.IMREAD_COLOR)
        if img is None:
            fail("解码失败 %s" % png_path)
        m = metrics(img)
        m.update(previewNode=node_id, sourceNode=source, pngBytes=len(png))
        result["stages"][stage] = m
        x0, y0, size = m["faceBox"]
        cv2.imwrite(str(root / ("%s-%s-face.png" % (tag, stage))), img[y0:y0 + size, x0:x0 + size])
        print("  %-10s %5dx%-5d lapVar=%10.1f faceLapVar=%10.1f png=%.2fMB"
              % (stage, m["w"], m["h"], m["lapVar"], m["faceLapVar"], m["pngBytes"] / 1e6), flush=True)

    up = result["stages"].get("upscaled")
    re_ = result["stages"].get("resampled")
    fi = result["stages"].get("final")
    if up and re_:
        result["ratios"] = {
            "resampled_over_upscaled": re_["lapVar"] / up["lapVar"],
            "resampled_over_upscaled_face": re_["faceLapVar"] / up["faceLapVar"],
        }
    if up and fi and (fi["w"], fi["h"]) != (up["w"], up["h"]):
        # 成品比采样域更大（hd 尾部纯放大）：缩回采样域分辨率再量，跨倍率可比
        fin = cv2.imread(str(root / ("%s-final.png" % tag)))
        small = cv2.resize(fin, (up["w"], up["h"]), interpolation=cv2.INTER_AREA)
        lap = cv2.Laplacian(cv2.cvtColor(small, cv2.COLOR_BGR2GRAY).astype(np.float64), cv2.CV_64F)
        result["finalDownscaledToUpscaledRes"] = {"lapVar": float(lap.var())}
        print("final 缩回 %dx%d 的 lapVar = %.1f" % (up["w"], up["h"], lap.var()), flush=True)
        x0, y0, size = fi["faceBox"]
        crop = cv2.resize(fin[y0:y0 + size, x0:x0 + size], (640, 640), interpolation=cv2.INTER_AREA)
        ok, buf = cv2.imencode(".jpg", crop, [cv2.IMWRITE_JPEG_QUALITY, 88])
        print("B64START finalface")
        print(base64.b64encode(buf.tobytes()).decode())
        print("B64END finalface")

    (root / "metrics.json").write_text(json.dumps(result, ensure_ascii=False, indent=2), encoding="utf-8")
    print("", flush=True)
    print("=== 阶段间高频能量比值（同一次运行，同分辨率） ===", flush=True)
    for key, value in (result.get("ratios") or {}).items():
        print("%s = %.3f" % (key, value), flush=True)
    print("[done]", root, flush=True)


if __name__ == "__main__":
    main()
