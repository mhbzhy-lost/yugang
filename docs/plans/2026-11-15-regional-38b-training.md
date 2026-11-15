# 3.8B Regional LLLite 自训方案（placement 硬条件）

日期：2026-11-15 立项。前置结论：E5–E9 证死全部软引导（LLLite pose / 无消费平移 / Position box / 剪影+分域默认墙 / 拉满墙），placement 唯一路是模型级颜色区域条件。社区参照：Sen-sou/Anima-LLLite-Regional-Controlnet（580 图 4400 步起步，社区验证「adhere 惊人准确」）与 toyxyz anima_regional_4335（RGB 实例色图，黑底未分配）。

## 目标

训练 3.8B（DeltaMix V8，52 层）的 Regional LLLite adapter：输入「纯色人形区域图」，硬约束人物（含多区域时的区域归属）画在指定位置。训练完成后接入单人姿态线（placement 参数面上线），并为将来多区域控制留路。

## 数据构造管线（打标完成后立即启动）

### 1. 姿态采样（依赖打标产物 pose-tags-raw.json）
- 按 tag 分层采样：每基础体位（standing/sitting/lying/kneeling/crouching...）配额均衡，避免 Sen-sou「近景偏科→远景不贴」同款教训
- confident=false 与 failed 条目剔除
- 计划规模：~800 姿态 × 4 随机变体 ≈ 3200 训练对（Sen-sou 580→4400 步起步，我们 3200 起步余量充足）

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
- ~3200 张 × ~15s ≈ 13 小时 GPU；分批提交生产 ComfyUI（队列空闲窗口）
- **caption 一致性**：caption 直接复用生成时的正向词（image/caption 自洽，无打标偏差）

### 5. 训练对组装
```
train-regional/
  image/    <id>.png     ← GPU 生成对照图
  control/  <id>.png     ← Pose3D 颜色区域图（同尺寸）
  caption/  <id>.txt     ← 生成正向词
```

## 训练配置（Sen-sou 实测起点 + 52 层对齐）

- cond_emb_dim 32 / lllite_cond_dim 64 / lllite_mlp_dim 64 / target self_attn_qkv / resblocks 4 / ASPP enabled
- lr 3e-4 / AdamW8bit / bf16 / epoch 8 起（对照 Sen-sou 4400–9280 步）
- **层结构对齐 v8 pose adapter 的 52 层配置（待主人提供当时训练参数）**

## 信息缺口（待主人补充）

1. v8 pose adapter 训练用的 sd-scripts fork / 命令行 / 层配置（52 层怎么进 LLLite target）
2. 训练机（WSL 5090D 32GB？）与训练窗口（生产 ComfyUI 能否同期服务）
3. GPU 生成对照图的算力窗口（夜间队列空闲？）

## 验证方案（训练完成判定）

- 固定测试集：E7 left/center 同场景 + 10 个随机位置姿态组合
- 判定：vision 判读成图人物质心 vs control 图质心偏差 ≤8 个点（当前分域基线是 10-15 点）
- 对照：同 seed 无 control 生成（确认 control 真的在起作用，不是文字巧合）

## 接线（验证通过后）

- ComfyUI：原生 LoadModelPatch + Apply Anima LLLite（0.44 已有）
- 单人线 node 5 的 control 图：scene_json → `_rasterize(control_maps=True)` 路径（或 RS 采样器 pose_control 换 auto + 自训权重进 anima_pose 校验链——看哪条接线更顺）
- placement 参数面（工作区就绪）：draw schema 暴露 + TOOL.md + messages 文案，同批上线
