# RS 画质增强与防多人：统一实验设计（2026-11-10）

> 状态：**设计已完成，未执行**。主人裁定：单次批实验耗时长，先把所有可能的画质增强设计做齐，
> 攒成一次批实验再跑。本文是那次批实验的完整契约：配置、指标、判定规则、执行架构、下载清单。
> 事实来源：Windows 真机 `/object_info`、节点包 `engine.py` / `characters.py`、官方示例工作流、磁盘模型清单
> （见 `docs/plans/2026-11-10-anima-rs-capability-survey.md`）。

## 0. 目标与终态

一次 detached 批实验同时回答两组问题，产出可直接落进 `makeRsGraph` / `makeGraph` 的参数与节点组合：

- **P 组（防多人）**：两人请求画出 3–4 人、单侧区域出现第二个身体的发生率，哪组参数能压到可接受水平；
- **Q 组（画质增强）**：在 P 组最优配置上，角色细节修复 / 重叠控制 / 渐进采样器等增强各自的净收益。

终态判定：每个候选配置给出「人数错误率、高频保留、肉眼裁剪结论」三列数据；进生产的条件写在 §4。

## 1. 机制摘要（为什么是这些旋钮）

RS 区域隔离在 `engine.py` 里是一条**随步数衰减**的曲线：`initial_spatial_separation`（缺省 0.9）起步，
经 `boundary_hold_steps=3` / `boundary_decrement=0.2` 调度逐步放开；衰减后各区域提示互相可见，
人物先验强的一侧可在邻区或边界再激活一个身体。`region_feather=0.04` 软边与 point 几何放大泄漏面。
旧版 `RSMultiCharacterSampler` 的 optional 输入里这 8 个旋钮全部暴露且我们恒用缺省；
`characterN_uc`（每角色独立负提示，`characters.py:148/222`）我们恒传空串。
`RSMultiCharacterInteraction` 的 delay3/delay6 预设本质是同一条衰减曲线的另一种调法。

## 2. P 组配置矩阵（人数在初采样就决定 → 只跑 RS 采样器节点，不接超分/脸修，省一半 GPU）

公共部分：`width=1280 height=720 steps=30 cfg=4.5 dpmpp_2m/sgm_uniform`，公共提示恒以 `2girls, ` 开头，
左右点位 0.4/0.6（G4 改 box）。每配置 × 每提示 × 种子列表跑满。

| ID | 配置（相对基线的增量） | 精确参数 |
| --- | --- | --- |
| P0 | 基线（现生产） | 负提示 = 现质量表；`characterN_uc=""`；分离旋钮全缺省；point 几何 |
| P1 | +公共负提示人数词 | 负提示追加 `3girls, 4girls, 5girls, multiple girls, crowd, extra person, duplicated person` |
| P2 | +每角色 uc | `character1_uc=character2_uc=multiple girls, 2girls, extra person, crowd, duplicate` |
| P3 | +分离旋钮 | `boundary_hold_steps=8`、`boundary_decrement=0.1`、`initial_spatial_separation=1.0`、`region_feather=0.02` |
| P4 | +box 几何 | `characterN_geometry=box`、`width=0.42 height=0.86`（左右中心不变） |
| P5 | P2 + Interaction delay6（与 P3 二选一的隔离路线） | `RSMultiCharacterInteraction preset=delay6`（delay_steps=6, decrement=0.2） |
| P6 | +每区域 solo 与位置自然语言 | 各角色提示追加 `solo` 与 `on the left` / `on the right`（ DiT 对位置短语反应好，社区指南实测）；公共提示仍只以 `2girls, ` 开头 |
| P7 | +提示结构卫生 | 每角色提示 = 角色锚 tag 逐角色重复 + 主体优先场景最后 + 概念间句号硬停顿；公共提示场景描述放最后（社区 DiT 指南） |
| P8 | +base-only 类比调参 | `initial_common_prior` 0.05→0.15、`common_after_step3_boost` 0.1→0.0（社区 RegionalSampler `base_only_steps` 语义：背景先跑、区域后介入；RS 引擎的同义旋钮） |

提示集（2 条，一条易发多条常规）：
- `T-hard`：`2girls, standing close together, holding hands, looking at each other, smiling, garden, sunlight, full body`（现生产同款，贴身互动最易多人）
- `T-easy`：`2girls, seated opposite each other at a cafe table, talking, indoor, warm light, upper body`

种子：6 个固定值（`20261110, 11, 22, 33, 44, 55`）。P 组规模 = 6 配置 × 2 提示 × 6 种子 = 72 次初采样
（≈20–25s/次 → GPU 25–30 分钟）。

## 3. 画质增强设计：损失预算 + 三轴单变量筛 + 组合复验

设计原则：不堆增强节点一起跑（交互效应会让结论不可归因）。先把画质拆成三个**独立可测**的轴，
用同 seed 实测给现有链记一本损失账，每轴内单变量筛出 Top-1，最后组合复验确认无交互效应才进生产。

### 3.1 三个可测轴

- **轴 A 细节保留**：阶段 lapVar 链（initial→upscaled→final）与脸区 lapVar；每阶段保留率 = 后/前。
- **轴 B 正确性**：人数/半区人数（§2 口径）、串色与属性错位（左右裁剪肉眼表 + detailer 角色分配报告）。
- **轴 C 伪影**：ESRGAN 光晕/塑料感、局部重绘接缝、块状斑点。接缝有机械口径：遮罩边界内外 8px 环带
  lapVar 比 >1.25 记 `seam`；其余肉眼表逐配置归档，新伪影类型一票否决。

### 3.2 现有链的损失预算（2026-11-10 同 seed 实测，基线账本）

| 阶段 | 单人 2x 保留率 | 双人 2x 保留率 | 备注 |
| --- | --- | --- | --- |
| 初采样→超分后 | ×0.888 | ×0.965 | AnimeSharp 4x + lanczos 0.5；下采样丢掉一半 ESRGAN 细节，**核从未对照过** |
| 超分后→脸修后 | ×0.907 | ×0.955（脸区 ×1.000） | 单人花 9% 全图 HF 换脸；**双人脸修对脸区零变化** |
| （已删除）二次采样 | ×0.78 | ×0.69 | commit `0697aba` |

账本结论：剩余最大的单阶段细节损失在「超分下采样核」与「单人脸修强度」；正确性损失在区域隔离（P 组）；
双人脸修目前是零收益 pass，是明确的砍/换候选。

### 3.3 轴 A 候选（单变量、同 seed 对照）

零扩散成本层（纯图像操作，不占采样预算，可随时先跑满）：
- **A1 超分下采样核**：lanczos（现）/ area / bicubic，同时作用于节点 92 与 hd 尾 97。
- **A2 hd 尾路径**：4x→0.375 一级（现）vs 4x→0.5 再 4x→0.75 两级 ESRGAN（更慢、可能更锐），仅 hd 档。

扩散成本层（进批实验）：
- **A3 脸修强度**：denoise 0.25（现）/0.20/0.15；guide_size 512（现）/640/768；steps 20（现）/12。
  单人双人分开判——双人脸修现为零收益，候选结论之一是「双人直接关脸修」或「换成 RS 角色细节修复」。
- **A4 初采样预算**：steps 30（现）/40；cfg 4.5（现）/5.0；scheduler sgm_uniform（现）/karras；
  分辨率 912×1216（现）/1024×1360（DiT token +26%，耗时同幅）。
- **A5 锚定 tiled 超分**：`UltimateSDUpscale(FLS)` + Anima tile ControlNet-LLLite
  （`anima_tiled_lllite_v1.safetensors`，strength 0.9、活跃 0–90%、tile 512、padding 32、seam fix、
  denoise 0.20、steps 20、cfg 8）替换或并列现有 ESRGAN 链——社区称这是 Anima 上唯一真正有效的 ControlNet，
  让超分 pass 不发明与源矛盾的细节（需装节点包 + 下权重，见 §6）。
- **A6 hd 3x 改走 tiled 超分**：2x 成品 `upscale_by=1.5` 的 A5 链，对照现 hd 尾（4x→0.375 纯 ESRGAN）。
- **A7 修复 pass 的位置**：手修现单人跑在超分**前**（912×1216 上修完再 4x 放大，修复细节被 ESRGAN 抹淡）；
  社区 detailer 阵列实践是 detailer 放超分**后**（2x 分辨率上 crop 更大、可动像素更多）。对照 pre vs post。

### 3.4 轴 B 候选

B1–B6 = §2 的 P0–P5（防多人参数）；B7 = RS 角色细节修复**叠加**通用脸修；B8 = **替换**通用脸修；
B9 = 重叠控制 delay6；B10 = 拥抱姿势遮罩（只验构图正确性，不进画质对照）。
B11 = 逐人轮廓分割（CoiiChan Every-Person-Seg）精化人数指标 + 多余人遮罩补绘安全网 + 逐人 refine；
B12 = detailer 阵列顺序脸→手：双人补一道手修 pass（hand_yolov8n + 手部正提示 + 独立阈值，社区 ADetailer 顺序实践）；
B13 = **交界区修复 pass**：两人 person 遮罩交集 + dilate → masked img2img（denoise 0.35/0.5 对照）+
联合提示（`holding hands, interlocked fingers, detailed hands`）；只修接触带，不动其余区域；
B14 = 脚部启发式 pass（仅 full body 请求）：person 遮罩 bbox 下 25% 区域 → detailer，正提示 `detailed feet, shoes`；可选档。

### 3.5 筛选与组合规则

1. 轴内单变量筛：每候选 vs 基线同 seed ×4；轴 A 看保留率与 seam，轴 B 看错误率，轴 C 一票否决。
2. 各轴 Top-1 进组合复验（同 seed ×6）：组合保留率 ≥ 单变量预期乘积的 97% 才算无交互效应。
3. 组合胜出者才改 `makeRsGraph` / `makeGraph`，一次只落一个 commit；AGENTS.md 同步管线描述。

### 3.6 成本分层与批排程

- 层 0（零扩散）：A1/A2，ESRGAN-only ≈ 2–4 分钟，不占批实验窗口。
- 层 1（P 组初采样）：72 次 ≈ GPU 25–30 分钟。
- 层 2（轴 A 扩散项 + 轴 B 全链项）：A3/A4 ≈ 32 次、B7–B9 ≈ 12 次、B10/Q4 渐进采样 ≈ 6 次，
  合计 ≈ 50 次全链 ≈ GPU 60–75 分钟。
- 层 3 组合复验：6 次 × 胜出组合数。
层 1+2 一次 detached 会话跑完 ≈ GPU 90–105 分钟；层 0 与层 3 独立窗口。

## 4. 指标与判定规则

- **人数（主指标，P 组）**：Windows 内嵌 python 跑 `models/ultralytics/segm/person_yolov8m-seg.pt`（已落盘）
  得 person 数；同时用 `bbox/face_yolov8n.pt`（已落盘）得人脸数作第二口径；再按 x<0.5 / x≥0.5 分半区计数。
  错误 = 总数≠2 或任一半区≠1。输出每图 `persons/faces/left/right` 进 `results.jsonl`。
- **高频保留（Q 组）**：沿用 hd-bisect 的 lapVar / faceLapVar 与阶段抽头（initial/upscaled/final）。
- **接缝（轴 C 机械口径）**：局部重绘遮罩边界内外 8px 环带 lapVar 比，>1.25 记 `seam:<config>` 进 jsonl。
- **身份/串色（Q 组）**：detailer 的角色分配报告原文存档 + 左右脸/边界 512px 裁剪肉眼表。
- **进生产判定**：P 配置人数错误率 ≤ 基线的 1/3 且 ≥12 次样本无「单侧双人」；Q 增强 final lapVar 不低于 Q0 的 95%
  且肉眼表无新增伪影（塑料感/光晕/块状）；Q1 vs Q2 取耗时与质量折中者（替换省一道 pass）。
- 任何配置出现新伪影类型即记 `artifact:<类型>` 进 jsonl，肉眼表复核。

## 5. 执行架构（绕开 71s 中继断流）

1. 本地（开发机）新增 `scripts/experiments/rs-ab-batch.ts`：从生产 `makeRsGraph` 导出基线图，按 §2/§3 表
   机械patch 出全部配置图（JSON），一并生成 `batch-manifest.json`（config×prompt×seed → 图文件与期望指标口径）。
2. 传输：图与 manifest 经 base64 分批落 `D:\rs-ab\graphs\`（每 exec ≤ 18KB，纯写盘秒级）。
3. 新增 `scripts/experiments/rs-ab-run.py`（Windows 内嵌 python）：读 manifest 顺序提交；**状态文件防重提**
   （沿用 hd-bisect-run.py 的 accepted/reattach 语义）；每完成一项追加 `D:\rs-ab\results.jsonl` 并写
   `D:\rs-ab\state.json`（当前 index / prompt_id / 状态）。
4. 启动：`wsl-relay exec` 里用 `powershell.exe -Command "Start-Process -WindowStyle Hidden python.exe rs-ab-run.py ..."`
   脱离中继会话；exec 立即返回。轮询 = 短 exec 读 `state.json` / `results.jsonl` 尾部（只读，秒级）。
5. 闸：提交前查 `/queue` 空闲；生产鱼在跑图时整批暂停（manifest 支持断点续跑：state.index 续）。
6. 回收：jsonl + 裁剪图 base64 分批回传；本地汇总成 markdown 对照表存档 `docs/plans/` 下。

## 6. 前置下载清单（实验开始前一次性完成，避开实验中断）

| 资产 | 用途 | 现状 |
| --- | --- | --- |
| `segm/Anzhc Face seg 640 v2 y8n.pt` | Q1/Q2 detailer face SEGM | ❌ |
| `WD ViT v3` | Q1/Q2 标签匹配 | ❌ |
| `segm/person_yolov8m-seg.pt` | P 组人数指标 | ❌（磁盘只有 yolov8m-seg.pt 通用名，需核对是否 person 权重；不是则下载） |
| `sam_vit_b_01ec64.pth` | detailer 可选 | ✅（本设计 sam=OFF，不用） |
| `anima_tiled_lllite_v1.safetensors` | A5/A6 锚定 tiled 超分（ComfyUI controlnet 目录） | ❌ |
| 节点包 `ComfyUI UltimateSDUpscale FLS + LLLite`（Lebensignal） | A5/A6 | ❌ 需安装（实验机装，生产暂不装） |
| 节点包 `comfyui-every-person-seg-coii`（CoiiChan） | B11 逐人分割 | ❌ 需安装（同上） |

下载方式：节点包首次使用自动拉取或按其 docs 手动放置；实验前用一次 dry 提交触发并确认落盘。

## 7. 实验后才决策的产品面问题（不在本设计内实现）

1. P/Q 胜出参数是否对**单人管线**同效（单人没有区域隔离问题，预计只需负提示人数词一项）。
2. box/物体/文字/姿势是否进模型可见 Schema（draw 的 `schema.json` + TOOL.md 文案）。
3. 细节修复额外耗时进默认管线还是只进 hd 档。
4. 人数安全网（生成后机械数人 ≠2 → 自动换种子重抽）是否作为最后防线常驻——若 P 组错误率仍 >5% 则上。

## 8. 与既有资产的关系

- 抽头/指标/裁剪代码复用 `scripts/experiments/hd-bisect.ts` 与 `hd-bisect-run.py`（含 `images[0]` 索引教训）。
- 生产管线现状（无二次采样）见 commit `0697aba` 与 AGENTS.md；本设计不改生产代码，只产出参数结论。
- 能力全景见 `docs/plans/2026-11-10-anima-rs-capability-survey.md`；本文是其 P/Q 两组的执行契约。

## 9. 社区借鉴候选与来源（2026-11-10 扫描）

扫描结论：社区在 Anima/DiT 上攒的经验集中在四类——区域提示卫生、锚定超分、逐人遮罩、detailer 阵列。
下列每条都已映射到 §2/§3 的配置 ID；来源 URL 存档备查。

1. **Tile ControlNet-LLLite 是 Anima 上唯一被社区证实有效的 ControlNet**（kohya LLLite 移植；姿态类权重实测无效，
   tile/repair 类有效）。`UltimateSDUpscale(FLS + LLLite Tile Repair)` 节点默认参数即社区甜点：
   upscale_by 2 / steps 20 / cfg 8 / denoise 0.20 / tile 512×512 / padding 32 / seam fix / lllite 0.9 @0–90%。
   → A5/A6。来源：https://comfy.icu/node/UltimateSDUpscaleFLSLLlite 、
   https://civitai.com/models/2383336/anima-usducntile-upscale-workflow-anima?modelVersionId=3064453
2. **DiT 提示卫生**：booru tag 开头 → 自然语言（人物关系与细节）居中 → 背景环境最后；角色锚 tag **逐角色重复**
   （分组写会串特征）；位置自然语言短语（on the left/right、in front of/behind）对 DiT 特别有效；句号是注意力硬停顿。
   → P6/P7。来源：https://civitai.red/articles/32568/anima-crossover-couple-generation-using-regional-sampler 、
   https://huggingface.co/datasets/rouge-kasshoku/anima-crossover-couples-regional-sampler-guide
3. **base_only_steps 语义**：区域采样器先跑纯背景若干步再介入区域，是「区域像贴上去还是长出来」的关键旋钮；
   降低它或放大遮罩 = 更强的区域覆写（Proxy Method：让底图先带上目标特征，区域 pass 少干活）。
   RS 引擎的同义旋钮是 `initial_common_prior` / `common_after_step3_boost` / 分离调度。→ P8。
   来源：https://www.runflow.io/blog/comfyui-regional-prompting 、
   https://huggingface.co/circlestone-labs/Anima/discussions/218
4. **逐人轮廓分割**：CoiiChan Every-Person-Seg 为多人场景逐人拆精细轮廓 → 人数指标精化、多余人遮罩补绘、逐人 refine。
   → B11。来源：https://github.com/CoiiChan/ComfyUI-Every-Person-Seg-CoiiNode
5. **detailer 阵列顺序**：detailer 放在超分之后、脸→手→眼多 pass、每 pass 独立正提示与检测阈值；
   手修 pass 阈值不当会「满屏头」（社区事故帖）。→ B12 与 A3。
   来源：https://sweettea.co/resources/text2img-workflow-with-detailer-arrays-v2-1-civitai-workflow-2412680-release-2764054 、
   https://github.com/Bing-su/adetailer/discussions/238
6. **区域遮罩设计**：LoRA delta 遮罩出框留 35% 软裙、裙边 Voronoi 限到邻区半程——「遮罩要宽容但绝不串」。
   若启用 `RSMultiCharacterMask` 外部遮罩，margin 设计参考此法。来源：
   https://github.com/CliffNodes/Krea2-Multi-Character-Lora-Node-with-bounding-box-Scene-and-Outfit-Edit
7. **备选区域节点生态**（不装，仅记录）：Comfyui-Anima-Regional-Conditioning、Moon Anima Regional Patcher
   （「知道何时停止遮罩」的遮罩调度）、Radiance Regional Prompt、Regional Mask Prompt Encode。
   RS 包已覆盖其能力面，暂不引入第二套区域实现。

## 10. 问题导向重排（2026-11-10 主人澄清后）

主人裁定：不追求精确姿势控制，Anima 直出动作已足够自然；要修的是两类异常——
**多人交界处**（牵手/搭肩/身体重叠处的融合与串色）与**手指脚趾**。据此重排优先级：

- **降级归档（不主动做）**：B10 姿势遮罩、相机控制、Q4 渐进采样器——构图自然度不是当前痛点；
  若将来出现「指定动作」需求再启用。
- **R1 交界区（预防 + 修复双轨）**：预防 = P3 分离旋钮 / P4 box / P8 base-only 类比 / B9 重叠控制 delay6；
  修复 = B13 交界 masked inpaint、B7/B8 角色细节修复（逐人重绘天然重画各自轮廓线）。
- **R2 手/脚**：B12 双人补手修 + A7 手修移到超分后 + 手修参数化（denoise 0.25→0.35 对照、独立正提示、
  阈值防「满屏头」）+ B14 脚部启发式（可选档）。
- **批实验顺序相应调整**：层 1（P 组预防）不变；层 2 先跑 R1/R2 候选（B13/B12/A7/B7/B8），
  A5/A6 锚定超分与 A3/A4 预算项排其后；层 3 组合复验只组合 R1/R2 胜出者。
- **新增指标**：交界环带 = 两人 person 遮罩交集 dilate 8px 环带，报环带内 lapVar 与两侧人物区 lapVar 比
  （融合区通常高频塌陷）+ 交界/手/脚三张 512px 裁剪进肉眼表；手修 pass 报手区 lapVar 与检测置信度分布。

## 11. S 组：风格轴分解与精细风格控制（2026-11-10 主人追问后新增）

痛点：想让光影更真实、人物保持二次元扁平；但扁平常伴随粗边线与简单上色，皮肤缺层次；
用 `realistic` 一词全盘推动效果很差。设计原则：**风格拆四轴独立控制，绝不用全局 realism 词**。

四轴：
- 线稿轴：正 `clean lineart, thin lines`；负 `bold lines, sketchy, painterly`。
- 上色/阴影轴：扁平基 `flat color, cel shading` 与层次基 `multi-tone shading, soft gradient,
  detailed skin shading, blush, subtle shadow` 互斥可选；目标组合 = 线稿扁平 + 阴影多阶。
- 光影轴：只描述光的摄影词表 `natural light, rim light, backlighting, dappled sunlight,
  volumetric lighting, light particles, light rays`，放公共提示**尾部独立段**（角色段不混入）。
- 负向封锁轴：`photorealistic, 3d, render, realistic face` 进负提示，堵全盘真实化。

机制级候选：
- **S1 提示轴分解**：上表四轴落进 `makeGraph`/`makeRsGraph` 的提示拼装（角色段 = 线稿轴+外观+阴影轴层次基；
  公共段尾 = 光影轴；负 = 质量表+封锁轴）。零成本，先跑。
- **S2 timestep 分段条件**（仅单人，核心 KSampler）：`ConditioningSetTimestepRange` 把光影条件挂后 30–40% 步，
  风格/线稿条件挂全步，`ConditioningCombine` 合并；RS 节点吃字符串不吃 conditioning，双人暂不适用。
- **S3 皮肤遮罩精修 pass**：HSV 皮肤色域 ∩ person 遮罩 → denoise 0.15/0.25 对照，正提示只写皮肤层次词；
  遮罩外零改动。精版替代 = SAM3 文本引导分割（SAX_Bridge），零依赖版 = HSV 色域。
- **S4 锚定重打光 pass**：全图 denoise 0.2/0.3 + tile LLLite 锚（A5 同款）+ 纯光影词提示；改光不改线。
- **S5 风格 LoRA 档**：`styles.json` 增补「cinematic light anime」类条目走节点 88（有现成权重才加）。

机械指标：
- 线稿粗细 = Canny/形态学骨架化后线宽均值；S 候选相对基线漂移 >±15% 即否决（线稿被改写）。
- 皮肤层次 = 皮肤遮罩内色调直方图熵（有效色阶数）；要求上升 ≥20%。
- 光影真实度 = 三列肉眼表（flat 基线 / realistic 全盘反例 / 候选）+ 明暗对比度（全图 luminance p5–p95 跨度）。
- 复用轴 C 伪影一票否决。

排程：S1 零扩散成本随层 0 跑；S2 单人扩散项进层 2；S3/S4 依赖遮罩与 LLLite，排层 2 后段；S5 待权重调研。

## 12. 层 0 与 S1 首轮实测结论（2026-11-10）

### 12.1 层 0：下采样核（零扩散，仅超分子图）
同一 initial 图过 AnimeSharp 4x 后三种核下采到 2x：

| 核 | single lapVar | multi lapVar | 近 Nyquist 混叠比（越低越干净） |
|---|---|---|---|
| lanczos（现用） | 482.3 | 826.4 | **0.267** |
| area | 424.5 | 720.7 | 0.308 |
| bicubic | 639.4 | 1150.9 | 0.377 |

结论：**维持 lanczos**。bicubic 的高 lapVar 是振铃伪影能量（混叠比高 41%），area 丢细节且箱式混叠更差。
教训：lapVar 单独不能判下采样质量，必须配混叠比或肉眼。

### 12.2 S1 提示轴分解：v1 否、v2 中
- v1（含 `soft gradient, soft volumetric lighting, light rays, light particles`）：皮肤层次出来了但全局被压成
  pastel 洗白，单人 lum_span 212→157，基线的 rim light 与暗部对比消失。**否决 soft 系词**。
- v2 组合（胜出，单人/双人各一跑肉眼确认）：
  - 线稿轴：`clean lineart, thin lines`
  - 皮肤/阴影轴：`multi-tone shading, detailed skin shading, blush, subtle shadow`
  - 光影轴：`cinematic lighting, directional light, strong rim light, dramatic shadows, dappled sunlight`
  - 封锁轴（负）：`photorealistic, 3d, render, realistic face, bold lines, sketchy, painterly, flat lighting`
  效果：叶隙光斑/方向光投影形状 + 多层皮肤渐变，线稿仍为细 anime 线；双人 lum_span 201 ≈ 基线 207。
- 对照图在 `~/Downloads/yugang-ab/04-S1-风格轴/`（基线/v1/v2 脸裁剪 + 双人左/交界裁剪）。

### 12.3 指标口径修正
- 线宽指标（Canny+distanceTransform 均值）**量化失效**（四种图全报 1.91），弃用；线稿是否被改写暂靠肉眼。
- lum_span 受内容影响（基线黑礼服贡献大暗部），只作同内容对照的辅助量。
- skin_entropy 受人脸框检测抖动影响（两次框差一倍），不作判定依据；皮肤层次靠肉眼裁剪。

## 13. 多人异常复现与载体化（2026-11-10）

### 13.1 首批 P 扫跑（测试 prompt）无信息量
P0/P2/P8 × 2 seed（bisect 测试 prompt：女仆+橙发牵手）全部干净 2 脸；P3 因 knob 名与安装版本
不匹配被 /prompt 拒（HTTP 400），未跑成。**基线不炸的载体上测不出抑制效果**——防多人是
概率性失败，载体必须选自历史失败请求。

### 13.2 真实载体：私聊 elysia+eden 拥抱构图（E77417）
参数：ratio 16:9；character1=elysia（LoRA Elysia_Hi3_Part01_Anima-01 w1.0）desc
`nightwear, lying on side on bed, snuggling against companion, gentle smile, head on pillow`；
character2=eden（LoRA Eden_Hi3_Anima-01 w1.0）desc `…cuddling together, calm expression, closed eyes…`；
common `bed, pillows, soft blanket, warm dim bedroom lighting, cozy and intimate indoor atmosphere`。

复现（挂 LoRA = 生产配置 / 不挂对照，各 2 seed）：
- 挂：s11 三头（中间多一个 eden 系复制头）、s22 三头（闭眼侧脸漏检、计数报 2）；
- 不挂：s11 **整对拥抱组合复制**（左右两对）、s22 三人（对+单）。
结论：**LoRA 不是触发器**（不挂更炸）；触发器 = 拥抱重叠构图 × RS 区域分离——分离机制撬开的
重叠区被同角色复制头或整对复制填充。两份 desc 各写 companion/cuddling + common 写 intimate，
等于两个区域各自要求拥抱，与 separation 正面对撞。

### 13.3 度量修正
人脸计数（face_yolov8n conf 0.3）对闭眼/侧脸漏检，**只是下界**；多人判定以接触表肉眼为准。
后续 B11 的每人分割才是可靠机械计数。

### 13.4 载体化 P 扫跑二批（psweep2，挂 LoRA）
C0=已复现两跑（3 头/3 头）；P2 每角色 uc；P3 分离旋钮（sep 1.0/hold 6/dec 0.1）；
P8 公共先验压制（prior 0/boost 0.05）；**P7c 提示卫生**：desc 去掉 companion/cuddling、
互动只写 common 一次（`the two cuddling together, snuggling against each other`）。
P7c 若胜出 → 进 TOOL.md 双人互动写法守则（互动词只写 common，desc 只写各自姿态）。

## 14. 构图自由原则与 D 组（2026-11-10 主人裁定）

**原则：工具不接受任何控制构图分布的参数；构图由模型天然输出决定；管线只承担身份
（点名角色时特征不串）。** 位置枚举（pos）、点位透传等方案全部废弃——左右/上下/前后
都该是模型自己的决定，接管线反而限制人物分布是不合理的。

路由推论：
- 双人无角色键（普通人）：没有身份要保护 → 走单人管线单 prompt 直出，构图自由；
  现生产把 characters[] 一律送 RS，普通人被白盒无谓约束，属路由错误。
- 双人含命名角色（LoRA）：身份锚必需，实现方式由 D 组实验决定：
  - D1 直出、不挂 LoRA、两角色特征全走 tag inject（床载体同 prompt 同 seed）；
  - D2 直出、双 LoRA 链（93→94 串联，各 0.8）——测量 blend 串色代价；
  - D3 直出 + 事后按人身份修复（FaceDetailer 逐脸挂各自 LoRA 链）——构图最自由，
    难点是脸→角色分配（检测序无语义；候选：发色直方图匹配 inject 描述，待验证）；
  - 对照：RS 现跑（复制头/整对复制 artifacts 已知）。
  判读三轴：身份串色 / 复制 artifacts / 构图自然度（拥抱该真拥抱，不该被撬成并排）。
- D 组胜出者决定 characters[] 的默认路由；RS 退居显式需要严格分区_identity_ 的场景，
  或整体退役。TOOL.md「顺序左、右」措辞随路由变更一并重写。

### 13.5 psweep2 判读（接触表为 ground truth，计数漏闭眼侧脸）
- P2（每角色 uc）：2/2 仍复制头 → uc 无效。
- P3（sep 1.0 / hold 6 / dec 0.1）：2/2 干净，**但拥抱消失**——两人平行分开各抱各手。
  机制坐实：重叠区 = 复制头Spawn点；P3 靠撬开全部重叠赢，拥抱与不复制在 RS 内互斥。
- P8（prior 0 / boost 0.05）：1/2 干净，不稳定。
- P7c（互动只写 common 一次）：2/2 仍复制 → common 驱动整场含重叠区，写法搬家无效。
结论：RS 白盒下「真拥抱 + 不复制」不可兼得；要兼得只能走无盒管线 → D 组。
