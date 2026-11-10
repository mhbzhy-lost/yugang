# Anima RS 能力调研报告（2026-11-10）

> 目的：回答「迁移到 ComfyUI 之后，Anima 还有哪些手段能做出更复杂的构图与人物关系」。
> 全部结论来自 Windows 真机（`D:\ComfyUI-Anima`）运行中服务的 `/object_info`、节点包源码/README/docs/examples
> 与磁盘模型清单，不凭印象。本报告只调研不实现；每条能力线给出接入成本与验证方法，供决策。

## 0. 先回答「和 forge 没差异、迁移意义在哪」

当前生产链刻意最简：初采样 →（可选手修）→ AnimeSharp 超分净 2 倍 → 脸修 →（hd 纯放大）。
这是因为 2026-11-10 的同 seed 对照证明**全局扩散 pass 只帮倒忙**（二次采样保留率单人 ×0.78、双人 ×0.69，
已删除，见 commit `0697aba`）。所以「看起来和 forge 一样」是剪枝的结果，不是 ComfyUI 的上限。

ComfyUI 迁移的真实价值在节点包 `comfyui-rs-multicharacter-sampler` 的**区域性/条件性**能力：
按角色遮罩的局部重绘、矩形/遮罩级布局、姿势遮罩、相机与重叠控制、渐进采样。这些是 forge 的
「提示词 + 全局 pass」表达不出来的。我们目前只用了它 15 个节点里的 2 个（旧版 `RSMultiCharacterPrompts`
+ `RSMultiCharacterSampler`），脸修还是借 Impact 的通用 FaceDetailer（只认脸、不认身份）。

## 1. 能力线清单

### 线 1：RS 多角色细节修复（身份级局部重绘）——建议第一条

- 节点：`RSMultiCharacterDetailer` + `RSMultiCharacterDetectionLoader` + `RSMultiCharacterTaggerLoader`
- 接线（官方示例 `examples/two-characters-detailer-anima.json` 实测）：
  采样器成品 → detailer 的 `image`；同一路 MODEL/CLIP/VAE；`character_pipe` 接角色管线；
  `detectors` 接检测组合；`tagger` 接标签模型。示例参数：`denoise=0.25`、`steps=20`、`cfg=4.0`、
  `euler_ancestral`/`sgm_uniform`、`guide_size=768`、`max_size=1024`、`max_regions=10`、
  `bbox_threshold=0.3`、`crop_factor=3.0`、`dilation=8`、`match_min_score=0.25`、`match_min_margin=0.08`。
- 检测组合输入：`face_segm_model` ∈ {OFF, `segm/Anzhc Face seg 640 v2 y8n.pt`, `segm/Anzhc Eyes -seg-hd.pt`,
  `segm/Anzhc Face seg 640 v4 y11n.pt`, `segm/Anzhc HeadHair seg y8n.pt`, `segm/deepfashion2_yolov8s-seg.pt`,
  `segm/person_yolov8m-seg.pt`, `segm/person_yolov8n-seg.pt`}；可选 `sam_model`（`sam_vit_b_01ec64.pth`）、
  `face_bbox_model` / `eye_bbox_model`。官方建议起点：**face SEGM + WD ViT v3 + denoise 0.25**。
- 标签模型：`WD ViT v3` / `WD EVA02 Large v3` / `PixAI Tagger v1.0`；**只用于选择该角色原有提示词，不追加推断标签**。
- 机制与收益：检测出每个角色后，用**该角色自己的原始提示与 LoRA** 做 masked img2img。这是区域性的——
  不像全局二次采样那样抹平 RS 隔离；直接对治串色、身份漂移、配饰错位。输出带「角色分配报告」可核对。
- 模型落盘情况：`sam_vit_b_01ec64.pth` ✅；`bbox/face_yolov8n.pt`、`bbox/hand_yolov8n.pt` ✅；
  **Anzhc 系列 segm ❌、WD ViT v3 ❌**（首次使用需下载，见 `requirements-detailer.txt` / `requirements-tagger.txt`）。
- 限制（README/docs）：要检查角色分配报告；匹配分数低于阈值区域不修；检测漏人则漏修。
- 接入成本：中。`makeRsGraph` 尾部把通用 FaceDetailer 换成三节点链；Schema 不扩（参数固定起步值）。
- 验证：现有 hd-bisect harness 同 seed A/B（加抽头看 detailer 前后）+ 角色分配报告 + 左右裁剪肉眼。

### 线 2：模块化角色链 + 矩形/遮罩布局 + 物体与文字槽位

- 节点：`RSMultiCharacterPrompt`（每槽 `kind ∈ {character, text}`，最多 10 槽）→ `RSMultiCharacterLoRA`
  （`lora_application_mode ∈ {normal, precision}`，precision 为默认）→ `RSMultiCharacterPosition`
  （每槽 `geometry ∈ {point, box}` + x/y/width/height）→（可选 `RSMultiCharacterMask` 外部遮罩，
  `margin/threshold/offset/scale`）→ `RSMultiCharacterFinalize` 汇总 → 采样器。
- 布局方法：采样器/渐进采样器的 `layout_method ∈ {regional, moss_native, auto}`；
  **`moss_native` 会把遮罩转外接矩形、丢轮廓细节**（README 明示）；混合布局见 `examples/epsilon/`。
- 物体与文字：物体用 `character` 矩形槽填物体描述（`examples/epsilon/objects/` 有苹果/茶壶/花/泰迪/书/相机/灯笼示例）；
  文字用 `kind=text` 槽 + 实际 STRING（「两个人一个词」三槽用法）。
- 收益：构图宽度——三人以上、人物+道具、画面内文字；box 级区域控制比点更稳。
- 成本：低-中。纯参数面改造；我们现在的 legacy `RSMultiCharacterPrompts` 仍受支持但 README 建议新工作流用模块化链。
- 风险：区域只是**引导**提示影响范围，不保证人数/身份/姿势/拼写（README 明示）。
- 产品面影响：若要开放物体/文字/box 给模型，draw 的 Schema 要扩字段（需主人决策）。

### 线 3：姿势遮罩与 3D 姿势 / 相机控制

- 节点：`RSMultiCharacterPoseMasks`（`pose_json` 或 `POSE_KEYPOINT` 或 `pose_image`（OpenPose 彩色 PNG）→
  人物遮罩；`thickness`、`body_part_strength`、`confidence`、canvas 尺寸）；
  `RSImageToPose3D`（照片/成品图 → 3D 场景 JSON，`character_number`）；
  `RSMultiCharacterPose3D`（场景 JSON：相机 position/target/fov + 每人 position/rotation/scale/bulk + 关节角；
  `pose_control ∈ {auto, masks_only}`、`pose_strength`、`pose_start/end`）；
  `RSCameraControl`（azimuth/elevation/distance/roll/strength、`scope ∈ {scene_and_characters, scene_only}`、
  `layout_sync ∈ {fixed, distance_and_roll, perspective}`——**提示词级**相机语义注入，不是几何条件）。
- 关键语义：OpenPose/3D 骨架**只转遮罩引导区域，不把骨架喂给模型**（README 明示），风险低于 ControlNet 式硬条件。
- 示例：`examples/openpose/anima-hug.json`（拥抱！）、`front-hug-frame.json`、`two-people-pose.png`；
  `examples/pose3d/`（genshin 多姿势、moss-native 审计图）。
- 收益：复杂人物关系的构图控制（拥抱、背靠背、互动举手），以及接触区以外的分离保持。
- 成本：中。姿势来源要定：手摆 OpenPose PNG / 从参考图 `RSImageToPose3D` / 直接写场景 JSON。
- 限制：不保证准确关节与接触（README 明示）。

### 线 4：角色重叠控制（互动区分离衰减）

- 节点：`RSMultiCharacterInteraction`：`preset ∈ {baseline, delay3, delay6, custom}`、`delay_steps`、`decrement`。
- 语义：延后**非重叠区域**的分离衰减——即互动区（牵手/搭肩）允许更晚分离、其余区域更早隔离。
- 收益：对治「接触点糊成一体 / 手长在一起」，与线 3 组合使用。
- 成本：低（一个节点三个参数）。验证简单：同 seed 开/关对照接触区裁剪。

### 线 5：渐进采样器（备选主采样器）

- 节点：`RSMultiCharacterProgressiveSampler`：`start_scale=0.67` 起、`region_feather`、`initial_common_prior`、
  `common_after_step3_boost`、`initial_character_gain=1.7`、`initial_spatial_separation=0.9`、
  `boundary_hold_steps`、`boundary_decrement`、`layout_method`。
- 语义：低分辨率起步 + 区域分离强度随步数调度，面向难构图（多人/拥挤布局）。
- 成本：中-高（替换主采样器，全管线重验）。建议放在线 1–4 之后评估。

### 线 6：参考图 / Role K/V（实验，暂不接）

- 节点：`RSAnimaCharacterReference` / `RSAnimaReferenceAdapter` / 参考帧适配器。
- README 明示：**实验性、不推荐；有角色 LoRA 时优先 LoRA**。Role K/V 首次自动下载约 504MiB 适配器、仅 2B 支持。
- 结论：记录在案，等官方转正或我们出现「无 LoRA 的常驻原创角色」需求再评估。

### 线 7：生成设置往返（迭代改图）

- 节点：`RSMultiCharacterLoadImage`：打开自家 PNG/WebP 恢复角色管线与提示；`use_image_settings` 可连种子/尺寸/区域参数一起恢复。
- 收益：同布局同种子迭代改图（改一个角色提示重出），配合 `ref` 改图面是更强的「改而不崩」。
- 成本：低；但要先决定产品语义（谁触发、改什么）。

## 2. 模型/下载清单

| 资产 | 用途 | 磁盘现状 |
| --- | --- | --- |
| `sam_vit_b_01ec64.pth` | 细节修复可选 SAM | ✅ |
| `bbox/face_yolov8n.pt`、`bbox/hand_yolov8n.pt` | 现脸修/手修 | ✅ |
| `segm/Anzhc Face seg 640 v2 y8n.pt` 等 | 细节修复 face SEGM（官方建议） | ❌ 需下载 |
| `WD ViT v3` | 细节修复标签匹配 | ❌ 需下载 |
| Role K/V 适配器（~504MiB） | 线 6 | ❌（暂不接） |

## 3. 建议验证顺序与统一方法

1. **线 1**（细节修复）：纯质量收益、区域性、官方有示例与验证文档。
2. **线 4**（重叠控制）：一个节点，和线 1 正交，可同批验。
3. **线 2**（模块化布局/物体/文字）：构图宽度；涉及产品 Schema 决策。
4. **线 3**（姿势/相机）：先做「拥抱」示例复现，再定姿势来源策略。
5. **线 5** 评估；**线 6** 挂起。

统一验证法（复用现有 harness）：`scripts/experiments/hd-bisect.ts` 从生产代码导出带抽头的图 →
Windows 内嵌 python 提交（`hd-bisect-run.py`）→ 同 seed 对照 lapVar/faceLapVar + 阶段裁剪肉眼 +
（线 1）角色分配报告。中继约 71s 断流，长任务拆多次 exec；生产队列空闲才提交。

## 4. 需要主人决策的点

1. 线 1 是**替换**通用 FaceDetailer 还是**叠加**（脸修后再角色修）？替换省时间，叠加多一道 pass。
2. 线 2/3 是否进产品面（模型可传 box/物体/文字/姿势）？进则 draw Schema 扩字段 + TOOL.md 文案；
   不进则只做主人私聊/运维侧能力。
3. 姿势来源策略：手摆 OpenPose PNG 入库 / 从参考图提取 / 场景 JSON 模板库。
4. 细节修复的额外耗时（每角色一次 masked img2img）是否接受进默认管线，还是只做 hd 档。
