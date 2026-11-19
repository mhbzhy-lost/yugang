#!/usr/bin/env python3
"""B 站视频轨与受控本地视频共用 PyAV 抽帧、缩图和去重；stdout 最后一行是 JSON。"""
import argparse
import shutil
import tempfile
import json
import os
import sys
import urllib.request

import av
from PIL import Image

HEADERS = {"user-agent": "Mozilla/5.0", "referer": "https://www.bilibili.com/"}


def pick_video_url(bvid: str, cid: str) -> str:
    req = urllib.request.Request(
        f"https://api.bilibili.com/x/player/playurl?bvid={bvid}&cid={cid}&fnval=16",
        headers=HEADERS,
    )
    with urllib.request.urlopen(req, timeout=20) as resp:
        play = json.load(resp)
    videos = sorted(((play.get("data") or {}).get("dash") or {}).get("video") or [],
                    key=lambda v: v.get("bandwidth") or 0)
    if not videos:
        raise RuntimeError("no video track")
    return videos[0]["baseUrl"]


def extract(source, args) -> dict:
    # 固定独立容器，禁止自动探测成 HLS/播放列表并读取附件以外的资源。
    prefix = source.read(16)
    source.seek(0)
    if prefix[4:8] in (b"ftyp", b"styp", b"moov", b"mdat", b"wide", b"free", b"skip"):
        container_format = "mov"
    elif prefix[:4] == b"\x1a\x45\xdf\xa3":
        container_format = "matroska"
    elif prefix[:4] == b"RIFF" and prefix[8:12] == b"AVI ":
        container_format = "avi"
    elif prefix[:4] in (b"\x00\x00\x01\xb0", b"\x00\x00\x01\xb5"):
        container_format = "m4v"
    else:
        raise RuntimeError("unsupported standalone container")
    # 主输入通过已打开的 Python 文件对象提供，不依赖 FFmpeg file 协议。
    # 除 pipe 外所有协议均关闭，MOV 外部数据引用也显式关闭。
    with av.open(source, format=container_format, options={
        "protocol_whitelist": "pipe", "enable_drefs": "0", "use_absolute_path": "0",
    }) as container:
        if not container.streams.video:
            raise RuntimeError("no video track")
        stream = container.streams.video[0]
        duration = float(stream.duration * stream.time_base) if stream.duration else float(container.duration or 0) / av.time_base
        if duration <= 0:
            raise RuntimeError("unknown duration")
        covered = min(duration, args.max_seconds)
        if args.timestamps:
            times = [float(x) for x in args.timestamps.split(",") if x.strip()]
        else:
            times = [covered * (i + 0.5) / args.count for i in range(args.count)]
        os.makedirs(args.out, exist_ok=True)
        results, signatures = [], []
        failed = 0
        for t in sorted(set(times))[:args.count]:
            if t < 0 or t >= covered:
                continue
            try:
                container.seek(int(t * av.time_base))
                frame = next(container.decode(video=0))
                img: Image.Image = frame.to_image()
                width = min(args.width, img.width)
                img = img.resize((width, max(1, int(img.height * width / img.width))))
                small = img.convert("L").resize((8, 8))
                sig = tuple(small.get_flattened_data()) if hasattr(small, "get_flattened_data") else tuple(small.getdata())
                if any(sum(abs(a - b) for a, b in zip(sig, prev)) < 40 for prev in signatures):
                    continue
                signatures.append(sig)
                path = os.path.join(args.out, f"{t:.3f}.jpg")
                img.convert("RGB").save(path, "JPEG", quality=args.quality)
                results.append({"time": t, "path": path, "width": width})
            except Exception:
                failed += 1
                print(f"skip frame at {t:.3f}", file=sys.stderr)
        return {"durationSeconds": duration, "coveredSeconds": covered, "frames": results, "failedFrames": failed}


def main() -> int:
    ap = argparse.ArgumentParser()
    source = ap.add_mutually_exclusive_group(required=True)
    source.add_argument("--input")
    source.add_argument("--bvid")
    ap.add_argument("--cid")
    ap.add_argument("--timestamps")
    ap.add_argument("--max-seconds", type=float, default=1800)
    ap.add_argument("--count", type=int, default=6)
    ap.add_argument("--out", required=True)
    ap.add_argument("--width", type=int, default=512)
    ap.add_argument("--quality", type=int, default=82)
    args = ap.parse_args()
    if not 1 <= args.count <= 6 or not 1 <= args.width <= 512 or not 0 < args.max_seconds <= 1800:
        ap.error("invalid frame limits")
    if args.bvid:
        if not args.cid:
            ap.error("--bvid requires --cid")
        req = urllib.request.Request(pick_video_url(args.bvid, args.cid), headers=HEADERS)
        # 保持 B 站最省轨来源，流式暂存避免整个视频驻留内存。
        with tempfile.TemporaryFile() as downloaded:
            with urllib.request.urlopen(req, timeout=60) as resp:
                shutil.copyfileobj(resp, downloaded, length=256 * 1024)
            downloaded.seek(0)
            result = extract(downloaded, args)
    else:
        with open(args.input, "rb") as local_file:
            result = extract(local_file, args)
    print(json.dumps(result, ensure_ascii=False))
    return 0


if __name__ == "__main__":
    try:
        sys.exit(main())
    except Exception:
        # 不把媒体 URL、宿主路径或异常响应原文写进日志。
        print("video decode failed", file=sys.stderr)
        sys.exit(1)
