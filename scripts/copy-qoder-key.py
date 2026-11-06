#!/usr/bin/env python3
"""把 ~/pi-config/pi/auth.json 里的 qoder-pool 凭据并入本仓库 config/auth.json。

用法（在仓库根执行）：
    python3 scripts/copy-qoder-key.py

- 源文件与本仓库 auth.json 都不打印内容，只报告条目名与结果
- 只并 qoder-pool 一个条目；目标文件保持 0600
"""
import json
import os
import sys

SRC = os.path.expanduser("~/pi-config/pi/auth.json")
DST = os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))), "config", "auth.json")

def main() -> int:
    if not os.path.exists(SRC):
        print(f"源不存在：{SRC}")
        return 1
    with open(SRC) as f:
        src = json.load(f)
    if "qoder-pool" not in src:
        print("源里没有 qoder-pool 条目，可用条目：", ", ".join(src.keys()))
        return 1
    entry = src["qoder-pool"]
    # 归一成 fish 缸认的 api_key 形状（pi 的形状可能缺 type）
    if "type" not in entry:
        entry = dict(entry, type="api_key")
    dst = {}
    if os.path.exists(DST):
        with open(DST) as f:
            try:
                dst = json.load(f)
            except json.JSONDecodeError:
                dst = {}
    dst["qoder-pool"] = entry
    with open(DST, "w") as f:
        json.dump(dst, f, indent=2, ensure_ascii=False)
        f.write("\n")
    os.chmod(DST, 0o600)
    print(f"已把 qoder-pool 凭据并入 {DST}（type={entry.get('type')}，key 长度 {len(str(entry.get('key', '')))}）")
    return 0

if __name__ == "__main__":
    sys.exit(main())
