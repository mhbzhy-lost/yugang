# PIPELINE-V1（直出管线·规格冻结，2026-11-12）

本文件冻结当日全部主人判定，作为管线实现的唯一依据。改动需重新过主人判定。

## 管线形态（2 次扩散 + 0 GPU 收尾）

```
① 语义输入：characters ×2 + 互动类型 + 场景意图 + 取景预设（agent 不碰技术参数）
② CPU 构图编排（0 GPU）：接触世界 authoring → 相机投影 → pose_image/人物区域
③ 联合初采样（1 扩散）：RS 区域装配（Prompt→LoRA(1.0)→Position→Finalize）
   + RS Sampler + 外部 LLLite 姿态（0.8 / 0–0.7）；矩形框（不用非矩形 owner）
④ 质感收尾（1 扩散）：基础分辨率 scene img2img denoise 0.25 + 外部 pose patch
⑤ 离线超分（0 扩散）：4x-AnimeSharp + lanczos 0.5 = 净 2x 展示副本
```

## 冻结参数（全部有当日判定支撑）

| 参数 | 值 | 依据 |
|---|---|---|
| 初采样方法 | B1 配方（RS 装配+外部 LLLite+矩形框） | B 组终判：B1 综合最好 |
| LoRA 权重 | 1.0（model/clip 联动） | 强度收尾裁定；低档丢细节 |
| 提示词地板（2026-11-12 主人裁定，原文写入） | POS 头：`masterpiece, best quality, absurdres, score_7, score_8, score_9, ` + 场景/景别/2girls 段；NEG 整串：`low quality, worst quality, score_1, score_2, score_3, early, old, monochrome, lips, shiny skin`（替换研究负向；abs/oily/airbrushed/sketch 系与 anatomy 系均未纳入） | 生产地板主人圈定 |
| 姿态 | LLLite strength 0.8，作用 0–0.7 | B1 冻结值 |
| 采样器 | euler_ancestral / sgm_uniform，30 步，cfg 4 | 全程冻结 |
| 收尾 | denoise 0.25 @1024×768，提示词=初始原文，挂 pose patch | finish-human 验证 |
| 超分 | 4x-AnimeSharp + lanczos 0.5，纯像素离线派生 | 8 张派生验证 |
| 画布 | 1024×768 | 全程冻结 |

## 明确不进管线的（负结果）

- 局部修复链（repair/Crop&Stitch/灰度遮罩/DD/Falloff）：无收益、丢细节
- 非矩形 owner 区域：重叠场景三人/双尾事故源
- 背景先行分层（布局板/背景渲染/latent 或像素回贴）：两变体证伪
- 全局 LoRA 共同加载：跨体污染

## 待研究（下一步，不阻塞管线交付）

- `RSMultiCharacterInteraction`（采样时间分层）：已安装未测；对"隔离不足"对症；1–2 次扩散可定去留
- 朝向信号：CARRY 型朝向不可控，结构性缺口
- QG 同文件隔离、3.8B 迁移：另立

## 实现说明

- 驱动：`pipeline-v1.py`（Windows 嵌入式 Python，stdlib）。
- 初采样图直接克隆旧 v4 manifest 的 B1 graph（提示词/框/链零重写），仅改 seed、LoRA 强度→1.0、输出名；finish 图由初始图派生（Pose3D 节点替换为 Project 节点、Sampler 替换为 scene img2img）。
- 条件来自冻结库（668 文件镜像）；parent_job 链接 finish→initial（runner 已验证路径）。
- 预算：验证运行 2 次扩散（DC-HUG-M × 新 seed 20261113）。
