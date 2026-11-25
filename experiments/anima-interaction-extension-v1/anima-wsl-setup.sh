#!/usr/bin/env bash
# anima-wsl-setup.sh —— 实验 ComfyUI 迁入 WSL（生产 Windows 8188 不动）
set -euo pipefail
LAB="$HOME/anima-lab"
mkdir -p "$LAB"
echo "[1/6] venv"
python3 -m venv "$LAB/venv"
"$LAB/venv/bin/pip" install -q --upgrade pip
echo "[2/6] torch cu128"
"$LAB/venv/bin/pip" install torch torchvision torchaudio --index-url https://download.pytorch.org/whl/cu128
echo "[3/6] ComfyUI 源码与节点（从已验证 D 盘 lab 树复制，含全部补丁）"
cp -a /mnt/d/yugang-anima-interaction-lab/ComfyUI/. "$LAB/ComfyUI/"
echo "[4/6] requirements"
"$LAB/venv/bin/pip" install -r "$LAB/ComfyUI/requirements.txt"
echo "[5/6] 权重路径（只读引用，不复制）"
CKPT=$(find /mnt/d/ComfyUI-Anima -maxdepth 5 -name "oneObsessionAnima_v40.safetensors" 2>/dev/null | head -1)
echo "checkpoint: $CKPT"
MODELS_ROOT=$(dirname "$(dirname "$CKPT")")
echo "models root: $MODELS_ROOT"
cat > "$LAB/ComfyUI/extra_model_paths.yaml" <<EOF
anima:
  base_path: $MODELS_ROOT
EOF
echo "[6/6] torch cuda 自检"
"$LAB/venv/bin/python" -c "import torch;print('torch',torch.__version__,'cuda',torch.cuda.is_available(),torch.cuda.device_count(),torch.cuda.get_device_name(0) if torch.cuda.is_available() else '')"
echo SETUP_DONE
