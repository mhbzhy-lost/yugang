# 3.8B Regional LLLite 自训方案（placement 硬条件）

日期：2026-11-15 立项，2026-11-16 数据就绪。前置结论：E5–E9 证死全部软引导（LLLite pose / 无消费平移 / Position box / 剪影+分域默认墙 / 拉满墙），placement 唯一路是模型级颜色区域条件。社区参照：Sen-sou/Anima-LLLite-Regional-Controlnet（580 图 4400 步起步，社区验证「adhere 惊人准确」）与 toyxyz anima_regional_4335（RGB 实例色图，黑底未分配）。

## 进度（2026-11-16）

- **打标完成**：1199 姿态，有效 1157（96.5%）。管线脚本与核心数据已收进仓库
  `scripts/regional-training/`（含 `data/pose-tags-raw.json`、`data/manifest.json`、README）。
- **训练对构造完成**：分层采样 412 姿态 × 4 变体 → 掩码校验滤除出界 → **1464 对**
  （`random.seed(20261115)` 确定性可复现）。体位分布：standing 140 / misc（动作态）140 /
  sitting 48 / lying 47 / kneeling 23 / crouching 13 / **squatting 1**。
  ⚠️ squatting 严重偏科（库裡仅 1 条），训练后蹲姿贴合度需重点验证，必要时补姿态。
- **control 区域图**：1464 张已渲染（17MB，可由 manifest 确定性重建，不入 git）。
- **下一步**：GPU 批量生成对照图（~1464 张 × ~15s ≈ 6h，等主人指定队列空闲窗口）→ 训练。

## 进度（2026-11-17）：v2 位置控制证伪，根因 = 训练数据位置多样性塌缩

> **2026-11-18 起本线收口至 `docs/plans/2026-11-18-regional-v4-staged-plan.md`**（S1/S2 能力实验、伪影教训与 v4 阶段计划 G1–G5 的唯一权威文档），本文以下内容为历史存档。

- **v1/v2 训练完成**：v1 8000 步 loss≈0.136（`out-v1/`，control↔target 错位作废归档）；
  v2 改用 rembg(isnet-anime) 从 target 分割 control（`segment-controls.py`，1464/1464），
  8000 步 loss≈0.134，产物 `anima_regional_38b_v2.safetensors`（174.66MB）已入 ComfyUI。
- **E21 生产形态四变体（center/left/right/up）目检无区别**；E22 消融排除 prompt 与 LoRA
  （生产词·无 LoRA IoU 0.914）；E23 发现 preset 木偶剪影面积仅 0.04（训练 p10=0.149）。
- **E24b 尺度修复实验**：preset 剪影实心放大 ×2.2（area 0.186 入训练分布）center 版
  IoU 0.663、dx +0.006；但 left 版（cx 0.307）gen cx 0.458、dx +0.151——向中心衰减。
  边界补测 cx 0.404→gen 0.530、cx 0.598→gen 0.508：**所有生成 cx 坍缩 0.50±0.03，
  与 mask 位置无关**。center「跟随」与 E22 高 IoU 均为中心先验巧合。
- **根因定罪**：condition-v2 剪影 cx 分布 mean 0.497 / **std 0.043** / range [0.316, 0.667]，
  位置在训练数据里近似常量 → 模型 shortcut learning 忽略剪影位置（loss 照降，
  形状/姿态信息有用、位置信息无用）。代码链无翻转（`AnimaLLLiteApply`→
  `comfy/ldm/anima/lllite.py` 仅 bicubic upscale+center crop），`flip_aug=false`，排除镜像。
  mask 实际控制的是姿态/外形（同 seed 换 mask 发型姿态全变），位置无效。
- **E25 全面筛查（跑着）**：14 变体一次性摸全失败面——位置 X 极端（0.25/0.75）、
  位置 Y（0.30/0.70）、**尺度（area 0.03/0.05 大背景小人物、0.45 大人物）**、
  组合 OOD（左上角、小人物偏左）、真实 rembg 剪影对照（中心/左移）、
  strength 1.0/end 1.0 欠驱动消融、prompt 位置词交互、strength 0 纯先验基线。
  产物 `output/interaction/e25/`，指标 + 14 宫格目检。主人裁定：先测全再重训，
  避免每次重训只解决一点问题；构图必须覆盖大背景小人物。
- **v3 增广方向（待 E25 定标）**：target+control 同步随机平移（位置变有信息量）
  + 同步缩放（面积覆盖 0.03–0.5，含大背景小人物）+ 边缘复制填充，caption 不动；
  增广范围以 E25 失败面为准，一次训全。
- **独立发现：质感 pass 裸地板词吃虚化**（E24b A/B 同 seed 对照）：裸词 pass 背景
  虚化被刷锐、瞳色粉→蓝漂移；带风格/DoF 词 pass 保留虚化与瞳色。生产 pass 现用
  裸词（M/L/P 三夜实验定版），是否修订待主人裁定，与 regional 问题解耦。
- **运维事故（同日）**：macmini 内存耗尽致 QQ 冻死掉线。根因航拍视频壁纸喂大
  VTDecoderXPCService 泄漏（11-16 jetsam 案底 91.88GB 页计数）+ OrbStack VM 8GB 气球。
  已修：纯黑静态壁纸、OrbStack 3GB、telegraf 改 ps 直读 + 看门狗 v4
  （压缩器>4GB/swap>80%/可用<10% 拍快照，VTDecoder>2GB 自动杀）。监控在 macmini
  `~/memwatch/`（metrics.jsonl + snapshots.log），jetsam 案底在
  `/Library/Logs/DiagnosticReports/Retired/`。

## 目标

训练 3.8B（DeltaMix V8，52 层）的 Regional LLLite adapter：输入「纯色人形区域图」，硬约束人物（含多区域时的区域归属）画在指定位置。训练完成后接入单人姿态线（placement 参数面上线），并为将来多区域控制留路。

## 数据构造管线（打标完成后立即启动）

### 1. 姿态采样（依赖打标产物 pose-tags-raw.json）
- 按 tag 分层采样：每基础体位（standing/sitting/lying/kneeling/crouching...）配额均衡，避免 Sen-sou「近景偏科→远景不贴」同款教训
- confident=false 与 failed 条目剔除
- 实际规模：412 姿态 × 4 随机变体 → 1464 训练对（原计划 ~800×4≈3200，受体位库分布限制
  实采 412；Sen-sou 580→4400 步起步，1464 对余量仍充足）。采样确定性 seed 20261115。

### 2. 场景随机化（每姿态变体）
- 人物位置：画面水平 0.1–0.9 / 垂直重心 0.3–0.8 均匀随机（E2 公式反解世界坐标）
- 相机：距离 ±30%、高度 ±0.3m、朝向（正面/侧面/背面）
- 画幅 bucket：912×1216 / 1216×912 / 1024×1024（对齐 sd-scripts bucket）

### 3. control 图渲染（接口已确认，零依赖）
- `pose3d._rasterize(scene, control_maps=True)` —— RS 包现成的颜色区域渲染（RS 采样器内建 adapter 同款路径）
- 格式：黑底 + 人物固定纯色（跟随 toyxyz 语义：颜色区分实例、黑=未分配）

### 4. 对照图生成（GPU 批量，唯一重活）
- 纯文本生成（无任何区域条件）：生产正向词骨架 + 姿态 tag 化 caption + 场景词池
- graph：单人直出形态（fast 规格 28 步即可——训练数据不需要 pass 质感）
- ~1464 张 × ~15s ≈ 6 小时 GPU；分批提交生产 ComfyUI（队列空闲窗口）
- **caption 一致性**：caption 直接复用生成时的正向词（image/caption 自洽，无打标偏差）

### 5. 训练对组装
```
train-regional/
  image/    <id>.png     ← GPU 生成对照图
  control/  <id>.png     ← Pose3D 颜色区域图（同尺寸）
  caption/  <id>.txt     ← 生成正向词
```

## 训练环境（2026-11-16 勘察就绪，全部复用 v8 当年环境）

- **sd-scripts fork**：`/home/mhbzhy/anima-v8-train/sd-scripts`，commit `cb70b96858477e716a2096292ab8aab433277f38`
  （与归档权重 metadata 的 `modelspec.implementation_version` 精确一致，kohya-ss/sd-scripts）
- **训练脚本**：`anima_train_control_net_lllite.py`（Anima LLLite 专用）
- **venv**：`/home/mhbzhy/anima-v8-train/venv`，torch 2.11.0+cu128，CUDA 可用
- **底模**：`/home/mhbzhy/anima-prod/models/checkpoints/DeltaMix 3.8B V8.safetensors`
- **v8 参考指标**：8000 步 / 2h24m / 1.08s/it 稳态 / avr_loss 0.159→0.0895 / 无 NaN/OOM / seed 42 / batch 1

## LLLite 配置（从归档权重 metadata 精确反解，非猜测）

归档 `~/anima-prod/archive/anima_v8_3dpose.safetensors`（183MB / 1476 张量）的 metadata 完整记录了训练配置：

```
cond_emb_dim=64  lllite_cond_dim=128  lllite_mlp_dim=64  cond_resblocks=4
use_aspp=true  aspp_dilations=1,2,4,8（network 模块内定）
target_layers=self_attn_qkv（preset 展开为 atomic self_attn_q_pre,self_attn_kv_pre）
cond_in_channels=3  version=2  inpaint_masked_input=false
```

**52 层结构**：52 个 DiT block（0–51）× self_attn q/k/v 各注入 LLLite（每 proj 9 张量）
+ 共享 conditioning1（72 张量：conv1[64,3,4,4]→conv2[64,64,3,3]→conv3[128,64,4,4]
+ ASPP(128) → proj[64,128,1,1] → out_norm[64]）。1476 = 52×3×9 + 72 ✓。
target_layers=self_attn_qkv 即覆盖全部 52 层，无需额外层范围参数。

**训练脚本 LLLite 参数名**（`add_anima_lllite_arguments`，括号内为脚本默认值，v8 实际值见上）：
`--cond_emb_dim`(32) `--lllite_mlp_dim`(64) `--lllite_target_layers`(self_attn_q)
`--lllite_cond_dim`(64) `--lllite_cond_resblocks`(1) `--lllite_use_aspp`(flag)
`--lllite_cond_in_channels`(3) `--lllite_multiplier`(1.0) `--lllite_dropout`(None)
`--network_weights`(resume 用)

## 标准训练参数（v8 日志未存 CLI，按 Sen-sou/计划选定，待 smoke 验证）

lr 3e-4 / AdamW8bit / cosine / warmup 100 / bf16 / gradient_checkpointing / cache_latents /
8000 步（v8 参考）/ seed 42 / batch 1 / save+sample every 1000。
**这些是选定值不是 v8 恢复值**——v8 的 lr/optimizer/scheduler 未落日志，smoke 跑通后按 loss 曲线调。
草稿见 `scripts/regional-training/train.toml` + `train.sh`。

## 数据布局（v8 dataset.toml 同款）

每个分辨率 bucket 一个 `[[datasets]]`（enable_bucket=false / batch 1 / num_repeats 1 / 无增强）：
`image_dir=<bucket>/target`（生成图）+ `conditioning_data_dir=<bucket>/condition`（control 图）
+ `.txt` caption（caption_extension=".txt" / shuffle_caption=false）。
本批数据统一 3:4 竖构图（scene 768×1024 → 生成图 1088×1456），单 bucket [768,1024] 即可
（control 原生分辨率，LLLite loader 自动 resize condition 到 target）。

## 信息缺口（状态更新）

1. ~~v8 sd-scripts fork / 层配置~~ **已解决**：环境/commit/LLLite 参数全部反解就绪（见上）。
   仅剩 lr/optimizer 等标准参数未落日志，按 Sen-sou 选定 + smoke 验证。
2. ~~训练机~~ 已确认 WSL 5090D 32GB；训练在生成完成后起（避免与生成争 GPU）。
3. ~~GPU 生成窗口~~ **已启动**（2026-11-16 11:08，1462 张 detached 运行，~8h）。
   鱼的 drawEnabled 已热关让出 GPU。

## 验证方案（训练完成判定）

- 固定测试集：E7 left/center 同场景 + 10 个随机位置姿态组合
- 判定：vision 判读成图人物质心 vs control 图质心偏差 ≤8 个点（当前分域基线是 10-15 点）
- 对照：同 seed 无 control 生成（确认 control 真的在起作用，不是文字巧合）

## 接线（验证通过后）

- ComfyUI：原生 LoadModelPatch + Apply Anima LLLite（0.44 已有）
- 单人线 node 5 的 control 图：scene_json → `_rasterize(control_maps=True)` 路径（或 RS 采样器 pose_control 换 auto + 自训权重进 anima_pose 校验链——看哪条接线更顺）
- placement 参数面（工作区就绪）：draw schema 暴露 + TOOL.md + messages 文案，同批上线
