#!/bin/bash
# ComfyUI A/B 实验脚手架：本地 → wsl-relay → Windows ComfyUI → 产物回收 ~/Downloads/yugang-ab/<分组>/
#
# 用法：
#   bash scripts/experiments/comfy-ab.sh <分组名> <变体JSON> [基底图json]
#   分组名会成为 Windows 侧 D:\hd-bisect\<分组>\ 与本地 ~/Downloads/yugang-ab/<分组名>/
#   基底图缺省用 D:\hd-bisect\graphs\new-2x.json（生产单人 2x 管线导出图，节点号与生产一致）
#
# 变体 JSON（数组，逐项一跑）：
#   [{ "tag": "S1-去painterly笔触",        // 必填，结果文件名（可用中文）
#      "prompt": "1girl, portrait, ...",   // 画面词，追加在正向文本之后
#      "pos":   "masterpiece, ...",        // 可选：整条正向文本（缺省用本脚本内的生产前缀常量）
#      "neg":   "low quality, ...",        // 可选：整条负向文本（缺省同上）
#      "seed":  11,                        // 缺省 11
#      "width": 912, "height": 1216 } ]    // 缺省 3:4
#
# 已踩过的坑（改脚本前先读）：
#   - Windows cv2.imread 读不了中文路径：一律 open().read() + np.frombuffer + cv2.imdecode
#   - ComfyUI API：POST /prompt 提交，GET /history/<pid> 轮询；POST history 会 405
#   - 400 的响应体里有具体校验错：捕获 e.read() 打出来，别瞎猜节点名
#   - 提交前必须查 /queue 空闲；结果不明的提交绝不重试（生产同机）
#   - Windows python 控制台是 GBK：sys.stdout.reconfigure(encoding='utf-8') 且少打印中文
#   - 长跑（>70s/跑）会被 relay 断流：改成 setsid 后台 + 轮询 run.log，参考 ugroup 的写法
set -euo pipefail
GROUP="${1:?用法：comfy-ab.sh <分组名> <变体JSON> [基底图]}"
VARIANTS="${2:?缺变体JSON路径}"
BASE_GRAPH="${3:-D:\\hd-bisect\\graphs\\new-2x.json}"
C="${HOME_CONNECT:-$HOME/.agents/skills/home-connect/scripts/connect.sh}"
[ -x "$C" ] || { echo "找不到 home-connect 的 connect.sh"; exit 1; }
FILT='post-quantum\|store now\|openssh.com\|may need to be upgraded'

VARIANTS_ABS=$(python3 -c "import os,sys; print(os.path.abspath(sys.argv[1]))" "$VARIANTS")

# 变体 JSON 转 base64 内嵌（避免 heredoc 转义）
VARIANTS_B64=$(base64 -i "$VARIANTS_ABS")

cat > /tmp/comfy-ab-driver.sh <<DRIVER
#!/bin/bash
set -uo pipefail
P=/mnt/d/ComfyUI-Anima/ComfyUI_windows_portable/python_embeded/python.exe
"\$P" - <<'PY'
import sys, os, json, time, copy, base64
sys.stdout.reconfigure(encoding='utf-8', errors='replace')
import urllib.request, urllib.error
import numpy as np, cv2
BASE="http://127.0.0.1:8188"
GROUP=r"__GROUP__"
OUT=r"D:\hd-bisect\%s"%GROUP
VARIANTS=json.loads(base64.b64decode("__VARIANTS_B64__"))
BASE_GRAPH=r"__BASE_GRAPH__"
LOG=os.path.join(OUT,"run.log")
os.makedirs(OUT, exist_ok=True)
open(LOG,"w",encoding="utf-8").write("")
def log(s):
    with open(LOG,"a",encoding="utf-8") as f: f.write(s+"\n")
def getp(p):
    with urllib.request.urlopen(BASE+p, timeout=60) as r: return json.load(r)
def postp(o):
    req=urllib.request.Request(BASE+"/prompt", data=json.dumps(o).encode(), headers={"Content-Type":"application/json"}, method="POST")
    try:
        with urllib.request.urlopen(req, timeout=60) as r: return json.load(r)
    except urllib.error.HTTPError as e:
        raise RuntimeError("HTTP %d: %s"%(e.code, e.read().decode()[:300]))
# 生产词表常量（与 src/tools/draw/workflow.json 前缀同步维护；改模板后记得同步这里）
POS_DEFAULT="masterpiece, best quality, absurdres, score_7, score_8, score_9, \nnewest, year 2025, detailed, novel illustration, game cg, anime, clean lineart, thin lines, cel shading, hard-edged shadows, painterly shading, visible brushstrokes, multi-tone shading, cinematic lighting, directional light, strong rim light, dramatic shadows, dappled sunlight, "
NEG_DEFAULT="low quality, worst quality, score_1, score_2, score_3, early, old, \nlips, shiny skin, abs, monochrome, photorealistic, 3d, render, realistic face, oily skin, airbrushed, subsurface scattering, flat lighting"
g0=json.load(open(BASE_GRAPH, encoding="utf-8"))
POS_ID, NEG_ID, KS = "4", "5", "7"
log("AB START group=%s base=%s runs=%d"%(GROUP, BASE_GRAPH, len(VARIANTS)))
for v in VARIANTS:
    tag=v["tag"]
    try:
        q=getp("/queue")
        while q.get("queue_running") or q.get("queue_pending"):
            time.sleep(8); q=getp("/queue")
        g=copy.deepcopy(g0)
        w,h=v.get("width",912), v.get("height",1216)
        for nid,node in g.items():
            if "width" in node.get("inputs",{}): node["inputs"]["width"]=w; node["inputs"]["height"]=h
        g[KS]["inputs"]["seed"]=v.get("seed",11)
        g[POS_ID]["inputs"]["text"]=v.get("pos",POS_DEFAULT)+v.get("prompt","")
        g[NEG_ID]["inputs"]["text"]=v.get("neg",NEG_DEFAULT)
        pid=postp({"prompt":g,"client_id":"ab-%s-%s"%(GROUP,tag)})["prompt_id"]
        log("SUBMIT %s %s"%(tag,pid))
        while True:
            hist=getp("/history/"+pid)
            if pid in hist: break
            time.sleep(2)
        st=hist[pid].get("status",{}).get("status_str")
        if st!="success":
            log("FAIL %s %s"%(tag,st)); continue
        node=None
        for oid,o in hist[pid]["outputs"].items():
            if "images" in o: node=o["images"][0]
        if node is None:
            log("FAIL %s no-output"%(tag)); continue
        raw=urllib.request.urlopen(BASE+"/view?filename=%s&subfolder=%s&type=%s"%(node["filename"],node["subfolder"],node["type"]), timeout=60).read()
        open(os.path.join(OUT,"%s.png"%tag),"wb").write(raw)
        log("DONE %s %d"%(tag,len(raw)))
    except Exception as e:
        log("ERR %s %s"%(tag,str(e)[:300]))
log("AB END")
# 收集：读回 PNG 转 jpg base64（中文路径用 frombuffer 绕 cv2.imread 的 GBK 坑）
for v in VARIANTS:
    tag=v["tag"]
    p=os.path.join(OUT,"%s.png"%tag)
    if not os.path.exists(p): print("MISSING %s"%tag); continue
    img=cv2.imdecode(np.frombuffer(open(p,"rb").read(), np.uint8), cv2.IMREAD_COLOR)
    ok,buf=cv2.imencode('.jpg',img,[cv2.IMWRITE_JPEG_QUALITY,88])
    print("B64START %s"%tag)
    print(base64.b64encode(buf.tobytes()).decode())
    print("B64END %s"%tag)
PY
DRIVER

# 注入参数
python3 - "$GROUP" "$VARIANTS_B64" "$BASE_GRAPH" <<'PY'
import sys, pathlib
group, vb64, base_graph = sys.argv[1:4]
t = pathlib.Path("/tmp/comfy-ab-driver.sh").read_text()
t = t.replace("__GROUP__", group).replace("__VARIANTS_B64__", vb64).replace("__BASE_GRAPH__", base_graph)
pathlib.Path("/tmp/comfy-ab-driver.sh").write_text(t)
PY

timeout 900 "$C" wsl-relay exec /tmp/comfy-ab-driver.sh 2>/dev/null | grep -v "$FILT" > /tmp/comfy-ab-out.txt

# 本地解码
python3 - "$GROUP" <<'PY'
import base64, pathlib, sys
group = sys.argv[1]
out = pathlib.Path.home()/f"Downloads/yugang-ab/{group}"
out.mkdir(parents=True, exist_ok=True)
raw = pathlib.Path("/tmp/comfy-ab-out.txt").read_bytes().decode("utf-8", errors="replace")
label, buf = None, []
saved, missing = [], []
for ln in raw.splitlines():
    if ln.startswith("B64START "): label = ln.split()[1]; buf = []
    elif ln.startswith("B64END "):
        try:
            (out/f"{label}.jpg").write_bytes(base64.b64decode("".join(buf))); saved.append(label)
        except Exception as e: print("DECODE FAIL", label, e)
        label = None
    elif ln.startswith("MISSING "): missing.append(ln.split()[1])
    elif label is not None: buf.append(ln.strip())
print("saved:", sorted(saved))
if missing: print("missing:", missing)
PY
