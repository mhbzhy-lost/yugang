#!/usr/bin/env bash
# anima-wsl-setup2.sh —— 实验 ComfyUI 迁入 WSL（无 sudo；pip --target 隔离；权重实体入 ext4）
set -euo pipefail
export PIP_BREAK_SYSTEM_PACKAGES=1
export HTTPS_PROXY=http://127.0.0.1:7897 HTTP_PROXY=http://127.0.0.1:7897 NO_PROXY=127.0.0.1,localhost
LAB="$HOME/anima-lab"
mkdir -p "$LAB"
echo "[1/7] pip（get-pip 用户态）"
if ! python3 -m pip --version >/dev/null 2>&1; then
  curl -fsSL https://bootstrap.pypa.io/get-pip.py -o /tmp/get-pip.py
  python3 /tmp/get-pip.py --user
fi
echo "[2/7] ComfyUI 源码+节点（含全部补丁）"
[ -d "$LAB/ComfyUI" ] || cp -a /mnt/d/yugang-anima-interaction-lab/ComfyUI/. "$LAB/ComfyUI/"
echo "[3/7] torch cu128 → $LAB/pydeps"
python3 -m pip install --break-system-packages --target "$LAB/pydeps" torch torchvision torchaudio --index-url https://download.pytorch.org/whl/cu128
echo "[4/7] requirements"
python3 -m pip install --break-system-packages --target "$LAB/pydeps" -r "$LAB/ComfyUI/requirements.txt"
echo "[5/7] 权重实体复制"
SRC="${FORGE_MODELS_SRC:-/mnt/c/Users/<win-user>/sd-webui-forge-neo/models}"
mkdir -p "$LAB/models/Stable-diffusion" "$LAB/models/text_encoder" "$LAB/models/VAE" "$LAB/models/Lora" "$LAB/models/ESRGAN" "$LAB/models_patches/model_patches/rs_reference/anima_pose"
cp -n "$SRC/Stable-diffusion/oneObsessionAnima_v40.safetensors" "$LAB/models/Stable-diffusion/" || true
cp -n "$SRC/text_encoder/qwen_3_06b_base.safetensors" "$LAB/models/text_encoder/" || true
cp -n "$SRC/VAE/qwen_image_vae.safetensors" "$LAB/models/VAE/" || true
cp -n "$SRC/Lora/aigrilsV1.0.safetensors" "$LAB/models/Lora/" || true
cp -n "$SRC/Lora/claude_girl_anima_lora_clean.safetensors" "$LAB/models/Lora/" || true
cp -n "$SRC/ESRGAN/4x-AnimeSharp.safetensors" "$LAB/models/ESRGAN/" || true
cp -an /mnt/d/ComfyUI-Anima/ComfyUI_windows_portable/ComfyUI/models/model_patches/rs_reference/. "$LAB/models_patches/model_patches/rs_reference/" || true
echo "[6/7] extra_model_paths.yaml"
cat > "$LAB/ComfyUI/extra_model_paths.yaml" <<EOF
anima_shared:
  base_path: $LAB/models
  diffusion_models: Stable-diffusion
  checkpoints: Stable-diffusion
  text_encoders: text_encoder
  vae: VAE
  loras: Lora
  controlnet: ControlNet
  upscale_models: ESRGAN
anima_patches:
  base_path: $LAB/models_patches
  model_patches: model_patches
EOF
echo "[7/7] torch cuda 自检"
PYTHONPATH="$LAB/pydeps" python3 -c "import torch;print('torch',torch.__version__,'cuda',torch.cuda.is_available(),torch.cuda.device_count(),torch.cuda.get_device_name(0) if torch.cuda.is_available() else '')"
echo SETUP_DONE
