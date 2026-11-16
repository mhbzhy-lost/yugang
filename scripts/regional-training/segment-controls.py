# 从 target 实际人物分割导出对齐 control（白剪影/黑底），替代「意图位置」渲染。
#
# 背景（v1 事故）：v1 的 control 从 scene 参数渲染「意图位置」剪影，target 却是纯文本
# 生成（人物落点由文本/随机决定），两者位置/尺度不对齐 → LLLite 学不到位置控制，
# loss 平台在 unconditional 地板 ~0.136（v8 对齐数据可降到 0.0895）。
# 修正：control 从 target 图里实际人物分割导出（剪影↔成图天然对齐），这才是
# ControlNet/Regional 的正确训练信号。target 与 caption 复用，不重跑生成。
#
# 依赖：rembg + onnxruntime + scipy（装进训练 venv）；动漫分割模型 isnet-anime.onnx
# （skytnt/anime-seg ISNet，hf-mirror 可下）放 ~/.u2net/isnet-anime.onnx。
# 用法：python segment-controls.py [--test]   # --test 只处理前 3 张验证掩码
import os, sys, glob
import numpy as np
from PIL import Image
from rembg import remove, new_session

BASE = "/home/mhbzhy/anima-regional-train/dataset/768x1024"
SRC = os.path.join(BASE, "target")
DST = os.path.join(BASE, "condition-v2")
os.makedirs(DST, exist_ok=True)
session = new_session("isnet-anime")
files = sorted(glob.glob(os.path.join(SRC, "*.png")))
if "--test" in sys.argv:
    files = files[:3]
done = 0
for i, f in enumerate(files):
    img = Image.open(f).convert("RGB")
    out = remove(img, session=session)            # RGBA，alpha=人物掩码
    alpha = np.array(out)[:, :, 3]
    mask = (alpha > 128).astype(np.uint8) * 255
    ctrl = np.stack([mask, mask, mask], axis=-1)  # 白剪影黑底 RGB，与 target 同尺寸
    Image.fromarray(ctrl).save(os.path.join(DST, os.path.basename(f)))
    done += 1
    if (i + 1) % 100 == 0:
        print(f"{i+1}/{len(files)}", flush=True)
print(f"DONE {done} -> {DST}", flush=True)
