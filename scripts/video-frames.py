#!/usr/bin/env python3
"""从 B 站视频里抽几帧，供 keyframes 方案使用。

用法：
    python video-frames.py --bvid BV1xx --cid 123 --duration 212 \
        --timestamps 12.5,45,90,140 --out /tmp/yg-frames --width 512

输出（stdout，最后一行）：JSON 数组 [{"time": 12.5, "path": "/tmp/yg-frames/12.5.jpg", "width": 512}]

为什么单独一个 python 脚本：解码要 PyAV（wheel 自带 ffmpeg 解码器），
mini 上没有系统 ffmpeg，用 node 直接解视频不现实。脚本保持无第三方魔改、可单独跑。
"""
import argparse
import io
import json
import sys
import urllib.request

import av
from PIL import Image

HEADERS = {
    "user-agent": "Mozilla/5.0",
    "referer": "https://www.bilibili.com/",
}


def api(url: str, timeout: int = 20) -> dict:
    req = urllib.request.Request(url, headers=HEADERS)
    with urllib.request.urlopen(req, timeout=timeout) as resp:
        return json.load(resp)


def pick_video_url(bvid: str, cid: str) -> str:
    play = api(f"https://api.bilibili.com/x/player/playurl?bvid={bvid}&cid={cid}&fnval=16")
    dash = (play.get("data") or {}).get("dash") or {}
    videos = sorted(dash.get("video") or [], key=lambda v: v.get("bandwidth") or 0)
    if not videos:
        raise RuntimeError("no video track")
    return videos[0]["baseUrl"]


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--bvid", required=True)
    ap.add_argument("--cid", required=True)
    ap.add_argument("--timestamps", required=True, help="逗号分隔的秒数")
    ap.add_argument("--out", required=True)
    ap.add_argument("--width", type=int, default=512)
    ap.add_argument("--quality", type=int, default=82)
    args = ap.parse_args()

    times = [float(x) for x in args.timestamps.split(",") if x.strip()]
    if not times:
        raise SystemExit("no timestamps")

    import os

    os.makedirs(args.out, exist_ok=True)
    url = pick_video_url(args.bvid, args.cid)
    req = urllib.request.Request(url, headers=HEADERS)
    with urllib.request.urlopen(req, timeout=120) as resp:
        raw = resp.read()

    container = av.open(io.BytesIO(raw))
    stream = container.streams.video[0]
    duration = float(stream.duration * stream.time_base) if stream.duration else max(times)

    results = []
    seen = set()
    for t in sorted(set(times)):
        if t < 0 or t > duration:
            continue
        try:
            container.seek(int(t * 1_000_000))
            frame = next(container.decode(video=0))
        except StopIteration:
            continue
        except Exception as exc:  # noqa: BLE001 - 单帧失败不影响其它帧
            print(f"skip {t}: {exc}", file=sys.stderr)
            continue

        img: Image.Image = frame.to_image()
        width = min(args.width, img.width)
        height = int(img.height * width / img.width)
        img = img.resize((width, height))

        # 粗糙去重：缩到 8x8 灰度，比较像素差（Pillow 12 起 getdata 已弃用）
        small = img.convert("L").resize((8, 8))
        sig = tuple(small.get_flattened_data()) if hasattr(small, "get_flattened_data") else tuple(small.getdata())
        if any(sum(abs(a - b) for a, b in zip(sig, prev)) < 40 for prev in seen):
            continue
        seen.add(sig)

        path = os.path.join(args.out, f"{t:.1f}.jpg")
        img.convert("RGB").save(path, "JPEG", quality=args.quality)
        results.append({"time": t, "path": path, "width": width})

    print(json.dumps(results, ensure_ascii=False))
    return 0


if __name__ == "__main__":
    sys.exit(main())
