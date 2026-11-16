#!/bin/bash
# Regional LLLite 3.8B 训练启动（草稿，待数据组装 + smoke 验证后正式跑）
#
# 环境复用 v8 当年训练现场（已勘察就绪）：
#   sd-scripts: /home/mhbzhy/anima-v8-train/sd-scripts  commit cb70b96858477e716a2096292ab8aab433277f38
#   venv:       /home/mhbzhy/anima-v8-train/venv        torch 2.11.0+cu128 CUDA
#   底模:       DeltaMix 3.8B V8.safetensors
#
# LLLite 参数从归档 v8 权重 metadata 精确反解（cond_emb_dim=64 / cond_dim=128 /
#   mlp_dim=64 / resblocks=4 / aspp / target=self_attn_qkv 覆盖全 52 层）。
# 标准参数（lr/optimizer/scheduler/steps）v8 未落日志，按 Sen-sou/计划选定，
#   不是 v8 恢复值——先 smoke 跑通看 loss 曲线再调。
#
# 起训前置：①生成图收齐（gen-runner 完成）②control 图传 WSL ③组装 target/condition/caption
#   ④smoke 验证（参考 v8 smoke.toml）⑤GPU 空闲（生成完成后，drawEnabled 恢复前）。
set -euo pipefail

TRAIN=/home/mhbzhy/anima-v8-train
WORK=/home/mhbzhy/anima-regional-train
BASE="/home/mhbzhy/anima-prod/models/checkpoints/DeltaMix 3.8B V8.safetensors"

mkdir -p "$WORK/out" "$WORK/logs"
cd "$TRAIN/sd-scripts"

"$TRAIN/venv/bin/accelerate" launch \
  --num_cpu_threads_per_process 4 --mixed_precision bf16 \
  anima_train_control_net_lllite.py \
  --pretrained_model_name_or_path "$BASE" \
  --qwen3 /home/mhbzhy/anima-prod/models/text_encoders/qwen_3_06b_base.safetensors \
  --t5_tokenizer_path /home/mhbzhy/anima-v8-train/sd-scripts/configs/t5_old \
  --vae /home/mhbzhy/anima-prod/models/vae/qwen_image_vae.safetensors \
  --attn_mode torch \
  --save_model_as safetensors \
  --dataset_config "$WORK/train.toml" \
  --output_dir "$WORK/out" \
  --output_name anima_regional_38b \
  --logging_dir "$WORK/logs" \
  --log_with tensorboard \
  --max_train_steps 8000 \
  --seed 42 \
  --train_batch_size 1 \
  --gradient_accumulation_steps 1 \
  --learning_rate 3e-4 \
  --optimizer_type AdamW8bit \
  --lr_scheduler cosine \
  --lr_warmup_steps 100 \
  --mixed_precision bf16 \
  --gradient_checkpointing \
  --cache_latents --cache_latents_to_disk \
  --persistent_data_loader_workers \
  --max_data_loader_n_workers 4 \
  --save_every_n_steps 1000 \
  --cond_emb_dim 64 \
  --lllite_mlp_dim 64 \
  --lllite_target_layers self_attn_qkv \
  --lllite_cond_dim 128 \
  --lllite_cond_resblocks 4 \
  --lllite_use_aspp \
  --lllite_cond_in_channels 3
