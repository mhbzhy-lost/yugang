# Anima 双人交互能力探索：测试方案 v1

日期：2026-11-11。

状态：2026-11-11 主人已通过提问工具选择「并发驱动，授权启动」。执行模式为 subagent 并发驱动；首先准备并落实 G0 资源闸，G0 未确认前不启动后继实验。授权时尚未安装资产、关闭鱼权限、重启鱼或提交 GPU 作业。本文不是已经跑通的能力声明。

## 1. 授权、目标与范围

主人明确要求设计完整测试方案，并指定：

- 标准 2B 的 oneobsession anima v40 为首轮底模；通过后再探索 DeltaMix 3.8B V8。
- 双人组合为 DeepSeek + Claude，以及 Qwen + Grok。
- 动作为牵手（十指相扣）、拥抱、接吻、背负。
- 四档景别：远景人物较小、环境突出且人物完整；中景人物完整并占据主体；近景人物不完整且以人物为主；超近景为 upper body 或只剩头，背景可忽略。
- 研发阶段可以人工准备结构条件、自由调参；不能为了未来 agent 接口简单而提前砍掉研究变量。
- 最终产品面向 agent，应在能力验证后以 preset 与内部策略收敛操作面，不依赖运行中人工救图。

本轮助手交付目标是生成并完整归档可复现的对照样例、参数、执行记录和决策说明，全部拉回 `~/Downloads/yugang-ab`。所有视觉验收、角色是否成立、动作是否正确、哪个配置更好均由主人亲眼决定，助手和 subagent 不评分、不筛图、不选优、不代为验收。未跑、缺文件或只挑成功图不构成交付完成。

### 本次授权边界

- 已授权：编写并按主人意见修订本方案、只读核实源码与资产声明、一次独立方案 review；交付位置与主人独占人眼验收权已明确。
- 主人新增硬前置：「在正式执行计划之前，记得先关闭鱼的管线使用权，否则会和你争夺计算资源。」因此执行启动第一步必须机械禁用鱼的 ComfyUI 提交入口，结束后恢复原状态；不能只观察队列空闲。当前仍未操作线上。
- 已授权（2026-11-11 提问工具选择「并发驱动，授权启动」）：新增本文实验脚本与夹具、结构参考、隔离节点二开及依赖准备，最多 808 次采样。这里的实验不是新增软件单元测试。
- 主人随后明确要求「改成热生效」，并通过提问工具选择「恢复、实现并上线」：授权本次 `drawEnabled` 热开关的生产代码修改、对应 commit/push 和一次生产部署；此后 G0/G1 热切换、不再各重启一次。仅这一生产改动获提交/上线授权，实验脚本/夹具/本计划不夹带提交。执行模式仍是原后台 subagent 并发驱动；不新增软件单元测试。
- 建议（待用户另行授权）：新增软件单元测试；本方案不以创建新单元测试为前提。既有 `npm test` 可用于改动后的回归。
- 未授权：除上述热开关外的 commit/push 或代码部署，改变 draw 的模型参数接口、改线上 LoRA 表/模型/ComfyUI 模板、重启生产 ComfyUI或修改系统服务。不扩大为长期停鱼；首次上线热开关的一次正常部署重启不等于以后切换权限仍需重启。
- 3.8B 迁移、训练新适配器与自动构图规划器不计入本轮执行授权。

## 2. 事实基线与实验隔离

唯一角色事实源：`src/tools/characters.ts` 及其加载的 `src/tools/tags/ai-girls.json`。实验 manifest 记录解析后的快照及源文件 SHA-256，不在脚本里再维护一份角色/LoRA 表。

| pair_id | A | B | 文件关系 |
| --- | --- | --- | --- |
| DC | deepseek | claude | A=`aigrilsV1.0.safetensors`，B=`claude_girl_anima_lora_clean.safetensors`，不同文件 |
| QG | qwen | grok | 两者均为 `aigrilsV1.0.safetensors`，相同文件、不同触发词 |

当前四者表内权重均为 0.8；它只是基线，不代表视觉强度相等。B/H/R/P 的机制对照先固定表内值；§5.5 另做单角色强度梯度、双角色不对称权重及全局/区域施加对照。实验权重覆盖只进离线 manifest，不改生产角色表。manifest 冻结角色解析结果与每项实际权重，开始后源表改变即停止续跑并建立新 run。

注意：两组同时还改变了角色形态、颜色、服装及训练概念，不是「只改变是否同一 LoRA 文件」的严格因果实验。只能分别报告两组表现，不能直接把组间差异归因于文件是否相同。

已核实的代码边界：

- `src/tools/draw/comfy.ts::makeRsGraph` 目前是固定双人矩形布局，只公开 normal/wide；本方案四档景别是离线实验契约，不假装现有工具已经支持四档。
- 现生产模板默认 DeltaMix 3.8B V8，不能未经检查直接拿来作 2B 对照；MODEL/CLIP/VAE、LoRA 块映射和提示地板必须为 2B 独立核实。
- `makeRsGraph` 的初采样 seed 可指定，但质感 pass seed 仍随机。离线图须逐阶段显式指定 seed，不能只固定第一段。
- 现生产质感 pass 按角色串接 93→94；QG 会引用同一文件两次。不能假定节点内部一定去重，也不能未经实测断言等效权重翻倍。
- RS 初采样与上述全局 pass 不是同一机制：冻结源码 `RegionalLoras` 以 `(file,strength)` 缓存 hook/clip，同文件同强度共享 hook，其角色区域按 grouped_masks 合并；不同强度生成不同 hook。相同 LoRA 参数更新被共享，不等于各角色提示词隔离自动消失。`shared_lora.py` 还有 `hook not in entry[3]` 去重保护，不能未经核实声称 normal 模式必然把 0.8+0.8 加倍。记录 requested/effective mode 与 audit，不用 P 组替初采样作结论。
- RS 角色 mask 是二值身份区域，不是灰度重绘强度图。两者必须分开保存、投影及传入。
- RS 原生 2B LLLite 姿态路径有架构检查；不能把骨架、深度图、二值遮罩当作训练所需的着色 3D 人体轮廓图。
- RS 主采样器尚无 image/latent、denoise、noise_mask 入口；局部多身份 img2img 需要二开。RS Interaction 调节分离时序，不解算接触关系。
- 旧 `docs/plans/2026-11-10-rs-quality-experiment-design.md` 和旧 bisect 脚本包含过时管线/指标；只借鉴记录与安全机制，不直接继承脸修、左右各一人、旧模型或旧时长结论。

固定外部研究基线：RS `721d57ab98e80dc6854d4f49758bc9c456bb925c`，ComfyUI `4d64a8bc072b81c9b47321789b4d83fb7348ae2a`；若实际安装版本不同，先记录 diff 和支持面，再冻结实验版本，不静默混用。

实验优先在隔离 ComfyUI 实例进行，权重目录可只读共享，custom_nodes 与补丁独立。Windows loopback `8189` 仅为拟用实验端口，必须验证空闲；被占用时停止，不夺端口。不得改生产 `8188` 或鱼使用的 `18190` 隧道。

同一张 GPU 即使不同进程仍会争抢。一次查询生产空队列不等于独占许可。真实采样前必须由主人确认可独占的实验窗口或独立 GPU；若不能保证，不自行停鱼来获得窗口，记录阻塞。

**G0/G1 资源使用权闸，覆盖整个执行期**：

1. 启动第一步记录鱼原有画图权限状态、`drawEnabled` 原键是否存在及布尔值、进程与启动方式。原源码从启动环境读取 COMFYUI_URL，空值已能拒绝提交；主人现要求新增真正热开关，不能在代码上线前仅写 `drawEnabled=false` 就声称已禁用。
2. 热开关契约：`fish.config.json` 的 `drawEnabled` 为受控布尔字段、缺省 true、effect=hot；`COMFYUI_URL` 仍只作启动连接地址。沿用现有配置热加载 getter，draw 每次执行现读，实际提交回调在标记 submitted 之前再次检查，堵住排队查询/ref 准备期间关闭开关的窗口；已经 accepted 的任务不取消、不重投。不为本需求重写 ComfyUI 请求器、修改工作流或增加模型参数。
3. 本次先实现并回归验证热开关，再只提交/推送这一改动，经 ops/home-connect 正常部署一次。部署前核对生产干净状态、提交祖先关系、依赖与既有 ref-cleanup；不夹带实验文件或未知本地提交。新逻辑上线后，G0 自身的小型 `interaction-resource.ts` 只原子修改 `drawEnabled=false` 并保存原键状态，保留配置其余字段，不改 `.env`、不发进程信号、不触碰生产 ComfyUI/QQ 协议端/隧道/服务。用部署版本、运行 PID、字段规格及实际配置读值证明入口确实消费热值；禁止在开发机起鱼。
4. 禁用生效后等待之前已 accepted 的生产作业自然结束，核查 running/pending 都为空，再取得实验互斥闸；不清空他人队列、不强杀任务、不因网络超时重发。任一提交状态不明则先回查，不能开始实验。
5. 实验调度期间持续核对鱼仍是禁用时的 PID/启动状态；被外部重启或发现其他 GPU 使用者就停止新提交并报告，不与之抢资源。
6. 最后一项 GPU 作业已闭合且队列空闲后立即执行 G1，仅恢复保存的 `drawEnabled` 原键状态（原本缺省则删除本次新增键，原本 false 则保持 false），不重启、不等待主人看图。不能扩大权限；其他配置变化保留，不覆盖整份旧文件。失败退出同样执行资源收尾；尚有未知/在途任务时不贸然恢复造成争抢，明确报告鱼仍禁用、未闭合任务和恢复下一步。

证据统一写 `resource-lease.json`：原状态、禁用/恢复时间与 PID、队列核对、实验 job 范围、退出处置。当前只是设计；没有关闭鱼权限、重启鱼或启动实验。

### 2.1 代码物料总表：现成 / 二开 / 自研

下表的节点名为 API `class_type`，不是 UI 昵称。**静态源码已核实不等于实验实例已安装或组合已跑通**；启动前以隔离实例 `/object_info`、包 commit、实际依赖及机械冒烟核实。现在没有把任何新包装进生产。

| 物料 | 分类与是否必需 | 准确节点/源码 | 本轮用途与边界 |
| --- | --- | --- | --- |
| ComfyUI core 基础节点 | 现成，必需，不二开 | `UNETLoader`、`CLIPLoader`、`VAELoader`、`CLIPTextEncode`、`LoadImage`、`ImageToMask`、`VAEEncode`、`VAEDecode`、`KSampler`、`SetLatentNoiseMask`、`LoraLoader`、`SaveImage`；core `nodes.py` 及内置扩展 | 模型装载、普通 img2img、全局 LoRA 对照与原生图落盘；LoadImage 的 mask 通常来自 alpha，独立灰度图须从 IMAGE 经 ImageToMask 指定通道转换，不能误读成空 alpha mask |
| core Differential Diffusion | 现成，R2/R3 必需，不二开 | `DifferentialDiffusion`；`comfy_extras/nodes_differential_diffusion.py` | MODEL denoise-mask hook；strength=1，真正灰度变化由 latent noise_mask 提供；不是最后贴回羽化 |
| core Anima 学习式姿态 | 现成，B1/B2/W-G 等必需，不二开 | `ModelPatchLoader` + `AnimaLLLiteApply`；`comfy_extras/nodes_model_patch.py` | 2B 原生 LLLite；RS 路径由 pose_pipe 内部调用，W-G 路径显式接这两个节点；同一 MODEL 不能两路重复挂 |
| RS 区域角色装配 | 现成，必需，不二开 | `RSMultiCharacterPrompt`、`RSMultiCharacterLoRA`、`RSMultiCharacterPosition`、`RSMultiCharacterMask`、`RSMultiCharacterFinalize`；`character_builder.py` | 构建两个独立角色槽，使用 box/非矩形 mask、每角色 model/clip 权重；同文件仍保留两个角色槽。也可消费现成 `RSMultiCharacterPrompts`，但离线图统一 builder 接口以避免混用类型 |
| RS 联合初采样 | 现成，B/W-RS/H 必需，不二开初采样分支 | `RSMultiCharacterSampler`；`nodes.py`、`engine.py`、`regional_lora.py` | 联合生成，区域提示与 LoRA 路由；不是接触拓扑求解器；regional_lora 源码以文件缓存原权重、以 `(name,strength)` 缓存各槽 hook，支持同文件不同槽权重 |
| RS 3D 场景与姿态图 | 现成，结构参考及 B1/B2 必需 | `RSMultiCharacterPose3D`；`pose3d_node.py`、`pose3d.py`、`mhr.py`、`pose_pipe.py`、`anima_pose_control.py` | scene_json→人体渲染、full/visible masks、pose plan。会同时写人物轮廓 mask；B1 必须在其后对两个角色显式 `RSMultiCharacterMask(enabled=false)` 清除轮廓并使用同一 box，B2 才覆盖为非矩形 mask，避免姿态与区域两个变量混在一起 |
| RS 自带 MHR 网格资产 | 现成资产，随节点版本核实，非训练任务 | `web/pose3d/mhr-body.json.gz`、`web/pose3d/MHR-LICENSE.txt`；`mhr.py::asset()` | T0 已核实真实资产与固定 RS 逐字节一致：54 controls 中 34 个逐指关节；存在可控手指不等于已经得到正确十指交错，接触精度仍由实际结构与主人看图判定 |
| Crop & Stitch | 现成，R 组必需，不重写裁切/贴回算法 | `InpaintCropImproved`、`InpaintStitchImproved`；`inpaint_cropandstitch.py` | 输入 IMAGE + 二值支持域 + 独立 context mask，输出 `STITCHER/IMAGE/MASK`，最后贴回。原生 mask 预处理可能改变灰度，所以灰度图另走坐标转换，不直接借 cropped_mask 当差分图 |
| KJNodes 遮罩形态学 | 现成可选辅助，无新权重 | `GrowMaskWithBlur`；`nodes/mask_nodes.py` | 可扩张/模糊支持域后保留白色核心平台；不是任意轮廓的严格 SDF。T2 也可前置 CPU 生成冻结的灰度输入，明确记录真实算法/参数/hash，不声称与 KJ 数值等价；实际图未调用 KJ 时不为无关可选导入阻塞执行，不造新扩散节点 |
| RS 局部多身份 img2img | **二开静态原型已交付，R3 的关键工程** | 隔离 RS `nodes.py`、`__init__.py` 与新 `yugang_rs_img2img.py`；节点 `YugangRSMaskedImg2Img` | T4 patch 已落盘并静态检查，未真实采样。输入 MODEL/CLIP/VAE、crop character_pipe、image/latent 二选一、denoise、独立 noise_mask；保留路由和原零 latent 分支，clone 保留 DD hook；尚需隔离注册与真实组合验证 |
| 同坐标遮罩转换 | **自研胶水静态原型已交付，R2/R3 必需** | `experiments/anima-interaction-v1/custom_nodes/yugang_interaction/` 的 `YugangMaskCropTransform` | T4 已实现。消费真实 STITCHER、原画布 A/B MASK、灰度 MASK，crop 尺寸从 STITCHER 读取；按 pad→crop→resize 同一变换输出区域、灰度图和 transform JSON。owner 最近邻、gray 连续插值并重夹限支持域；尚未用真实采样验证 |
| 结构/清单/执行/归档程序 | **需要自研的离线脚本，不是 ComfyUI 生图节点** | `interaction-study.ts`、`interaction-study-run.py`，以及结构资产生成模块 | 从唯一角色表生成 case、相机投影、权重矩阵、稳定 stage seed、图/输入 hash、断线状态；完整回收 PNG、按决策组织 Downloads 子文件夹和 README。不得实现视觉评分器、自动挑图器或自动验收器 |
| 鱼的 GPU 使用权租约 | **生产热开关小改动 + 小型运维辅助，G0 自己实现，不等待后继T3** | 现有 fish-config/getter/draw 链新增 `drawEnabled`；`scripts/experiments/interaction-resource.ts` 接口 preflight/off/status/restore | 新逻辑仅首次部署一次；辅助脚本此后只原子热切换配置、保存原键/PID/队列时间线，不发进程信号、不改 .env/模型/模板，不用旧空 URL 重启实现 |

**本轮不需要自研**：扩散模型、LLLite 训练、Differential Diffusion 算法、人物检测/语义分割模型、自动手指/受力求解器、自动验收模型。复杂尾巴/服装先作为人工/程序绘制的同 owner 形状输入，不宣称一个 mask 即可约束其三维拓扑。

### 2.2 节点仓库、版本与运行依赖

| 包 | 固定源码与静态核实状态 | 依赖/安装边界 |
| --- | --- | --- |
| [ComfyUI](https://github.com/Comfy-Org/ComfyUI/tree/2c75dc1b379a59e0880619d029607af5169a62ef) | 调研源码 `4d64a8bc072b81c9b47321789b4d83fb7348ae2a`；T0 量化差异后，实际实验明确冻结已复制的 v0.44.0 / `2c75dc1b379a59e0880619d029607af5169a62ef`，不静默混用 | ModelPatch/DD/mask/LLLite 四关键文件 LF 规范化相同，nodes.py 与 lora.py 两差异仅无关注册/Flux/Mochi；详见 preflight.coreVersionDrift。记录真实 Python/CUDA/torch/驱动，不升级生产 Python 或 core |
| [RS MultiCharacter](https://github.com/raspie10032/ComfyUI_RS_MultiCharacter_Sampler/tree/721d57ab98e80dc6854d4f49758bc9c456bb925c) | `721d57ab98e80dc6854d4f49758bc9c456bb925c`；pyproject 与注册器版本 1.1.3 | Python >=3.11，numpy、Pillow>=10、torch；基础+3D路径不默认安装 detailer/tagger/reference 可选推理依赖。复制/派生代码保留 GPL-3.0-only 和资产单独许可 |
| [Inpaint CropAndStitch](https://github.com/lquesada/ComfyUI-Inpaint-CropAndStitch/tree/6005efc02f7745649118edd89cdd084c2b9bd3ae) | `6005efc02f7745649118edd89cdd084c2b9bd3ae`，3.0.20；注册名/接口/源码 import 已核实 | 源码使用 numpy、torch、torchvision、Pillow、scipy；pyproject 没有完整列依赖，须在隔离 venv 核对，不能以「pip 无报错」视为节点可导入；GPL-3.0 |
| [KJNodes](https://github.com/kijai/ComfyUI-KJNodes/tree/ab72eda7ffad6280422d71ab7d54d3fb87c0ba18) | `ab72eda7ffad6280422d71ab7d54d3fb87c0ba18`；GrowMaskWithBlur 已核实 | 遮罩分支需要 kornia、torch、numpy、Pillow；包其他可选导入较多，在隔离实例安装并记录依赖，不为无关节点下载模型 |

上述依赖在执行前导出精确 lock/`pip freeze`；源码未提供的版本不在此编造。开发机 TypeScript CLI 用仓库 Node>=22；Windows runner 使用隔离实例 Python。模型目录可以只读共享，但新 custom_nodes、依赖与 patch 不污染生产实例。

### 2.3 模型与非代码物料

| 物料 | 数量与路径契约 | 现状/核实方式 |
| --- | --- | --- |
| oneobsession anima v40 | 实体 `oneObsessionAnima_v40.safetensors`，UNETLoader 使用 preflight 的真实相对名 | T0 流式核 hash、28 连续 DiT blocks、width 2048、F16、4182229969 字节；完整实体记录在 preflight.assets.unet，不把 header 核实当推理已跑通 |
| 文本编码器 + VAE | `qwen_3_06b_base.safetensors`、`qwen_image_vae.safetensors`；CLIPLoader/VAELoader | T0 核实 CLIP hidden 1024 与 UNET cross-attn 输入匹配、VAE latent 16 与 UNET 输入机械匹配；完整 hash/键形在 preflight，实际编码/采样另证 |
| 角色 LoRA | 两份唯一文件：`aigrilsV1.0.safetensors` 和 `claude_girl_anima_lora_clean.safetensors`，四个角色概念 | T0 实体 hash/28块覆盖及通用映射已核实；两份 TE keys 都为 0，因此 clip 强度是空操作，不能声称 clip 权重生效；rank/目标模块不同，不因同系数或文件共享假定相同强度 |
| 原生 2B 姿态适配器 | 真实路径 `models/model_patches/rs_reference/anima_pose/anima_3dpose_outline_7000.safetensors`，固定来源/hash 见 §5.1 | T0 确认已存在，28块/2048宽/3通道匹配；磁盘/固定revision LFS/方案/RS pin 四方 hash 已一致，非商业许可 README 及上游 CircleStone v1.2 文本已取证于 checks/weight-license-evidence.json。Comfy 相对名含 `rs_reference`；source-data 条款与其余权重许可仍未全部核实，不将文本取证说成法律清除 |
| MHR 渲染资产与 8 套世界结构 | 节点包资产 + 8 套 scene_json/手部与 owner 说明 + 40 投影条件 | 需要准备输入数据，不是下载一个节点就自动得到正确拥抱/十指/尾巴；全部随图交给主人，不由助手验收 |
| 裁切/区域/灰度图 | 每个 case 保存 A/B 区域、core/support/context/gray、投影与变换 JSON | 接触域从冻结结构投影得到，不由助手看生成图挑选；超近景空投影有机械说明 |

首轮明确不加入：FaceDetailer/Impact、WD Tagger、SAM、人体检测权重、Anima image-reference/KV adapter、Claquasse 另一套姿态 patch、UltimateSDUpscale/FLS、自训练 3.8B 姿态权重。这些不是主线先决条件，也不为了「装齐所有包」扩大依赖。

### 2.4 各实验的接线与开发落点

```text
B0 / W-RS基础装配：core模型 → RS Prompt/LoRA/Position → Finalize → RS Sampler → SaveImage
B1：上述builder + Pose3D(auto) → 两槽Mask(enabled=false)保留矩形 → Finalize → RS Sampler
B2 / W-RS：Pose3D(auto) → 两槽Mask(非矩形owner) → Finalize → RS Sampler
W-G：core模型 → 全局LoraLoader → 原生ModelPatchLoader/AnimaLLLiteApply → 普通KSampler
R1：父图 → Crop → VAEEncode + binary noise mask → 普通KSampler → Decode → Stitch
R2：R1同裁剪 + MaskCropTransform灰度图 + DifferentialDiffusion → 普通KSampler → Stitch
R3：R2同裁剪/灰度图 + crop后A/B区域 → YugangRSMaskedImg2Img → Stitch
P：原生父图 → VAEEncode → 一次/逐角色全局LoRA链 → KSampler(0.25) → Decode
```

Crop 先用二值支持域确定窗口，`mask_fill_holes=false`、`mask_expand_pixels=0`、`mask_invert=false`、`mask_hipass_filter=0`、`preresize=false`、`extend_for_outpainting=false`；初始 context factor=1.2、target=768×768、padding=32，最终 STITCHER 参数在同组全部一致。此局部修复画布随主人低分可用性要求下调，不做全量高分修复。R1/R2/R3 使用相同的贴回 alpha，避免把贴回羽化误当差分扩散收益。

开发量估算（1 熟悉项目工程师，含实现不含等待主人看图；不是已完成承诺）：现成节点装配/隔离与条件格式核实约 1–3 人日；结构夹具与镜头投影约 2–4 人日，精确十指资料不足另报阻塞；RS 局部 img2img 二开约 3–7 人日；坐标胶水节点约 1–2 人日；离线清单/运行/完整回收与 README 约 2–4 人日。共享工作不直接相加；无需从零开发扩散推理引擎。工程完成与真实运行分开验证，视觉成败只由主人判断。

## 3. 场景契约：32 个核心 + 8 个头部边界场景

### 3.1 动作的精确定义

两人为成年、正常比例、穿原设服装；不使用 Q 版、不额外改变体型、不加入第三人、家具支撑或手持道具。固定柔和日光、庭院地面、背景墙和远处树木；这些环境线索允许远景展示，并随镜头自然退出近景。

| action_id | 世界空间中固定的动作 | 必须检查的关系 | 不算完成的替代动作 |
| --- | --- | --- | --- |
| HAND | A 在左、B 在右，A 右手与 B 左手十指相扣；其余手自然放置 | 一对手的手指交错、手掌/手腕连接及左右角色归属 | 普通握手、掌心贴合、挽手、只碰指尖、多生一只手遮掩错误 |
| HUG | 正面相拥，双臂分别绕向对方躯干，保持可辨的前后交叠 | 双方手臂与肩/躯干连通，存在合理互相遮挡 | 并排贴肩、单向搭肩、两人融合成一具身体 |
| KISS | 面对面嘴唇接触，双头保持可读侧面或三分之四角度 | 唇部接触、鼻/下巴不穿插、头颈各自连接 | 亲额头/脸颊、嘴唇明显分开、用头发完全遮住接触 |
| CARRY | A 背 B；B 在 A 身后且双脚离地，A 双手承托 B 大腿，B 手臂自然搭在 A 肩前 | 背部承重、承托手与大腿、B 的腿绕在 A 两侧、双人身体归属 | 公主抱、并排站立、B 自己站地、额外腿或共用躯干 |

角色顺序不随镜头变化：DC 为 DeepSeek 背 Claude，QG 为 Qwen 背 Grok。反向背负和左右互换是后续扩展，不混入首轮。拥抱/接吻中 A/B 初始左右锚点明确，但不使用「每个半幅只能有一个人」作为通过条件。

DeepSeek 保留鲸尾与尾根连接，Claude 保留发色/发饰与服装，Qwen 保留渐变发/辫子/小帽，Grok 保留双马尾/尖耳/冠饰。Grok 资料中头饰段的 bat wings 不擅自解释为必须长出一对巨大背翼。可见范围以冻结的角色参考图确认，不靠工具结果臆测。

### 3.2 四档景别及头部边界

`subject_envelope` 指两名角色可见主体与所要求附属部件的联合外包络，不能仅用两张脸的 bbox 代替。数值是输入构图目标和辅助标记，最终景别还需视觉复核；检测器低置信时不伪造精确占比。

| framing_id | 主体与环境要求 | 冻结时的构图目标 | 关键裁切规则 |
| --- | --- | --- | --- |
| W 远景 | 人物小、环境明确突出，完整展示两人 | 主体包络高度约画高 35–55%；包络面积一般不超过画面约 30% | 两人头脚和要求完整的尾巴/帽子不出画；背负者的脚也完整 |
| M 中景 | 两人完整，人物占据主要位置，边缘环境很少 | 主体包络高度约画高 85–95%；横向贴合人物组，避免左右大片空景 | 不以切脚或切帽制造「占比高」；联合包络大不代表人物实际占比一定高 |
| C 近景 | 人物不再完整，画面以人物为主 | 从大腿或腰附近裁切，头部完整；保留躯干和当前动作主要接触带 | 看不到脚属于正常裁切，不能判缺脚；至少一名角色下身出画 |
| XU 超近景·上半身 | 两人以上半身为主，背景可忽略 | 胸/腰上构图，头肩/胸占满画面 | 不为了让动作可见偷偷改成中景，也不移动牵手高度改变冻结姿态 |
| XH 超近景·头部边界 | 头脸为主，背景可忽略 | 双人头部与少量肩颈占据画面 | 只作为超近景子档，不宣称还能证明画外承重/手指动作 |

四个主档是 W/M/C/XU，形成 `2 × 4 × 4 = 32` 核心 case。XH 再增加 `2 × 4 = 8` 个边界 case，共 40 个不同构图；不能把 40 写成 32。

同一 pair/action 的参考世界姿态、手部接触、服装、角色相对位置与镜头朝向固定，仅改变参考相机距离和取景窗口。不能直接裁放一张中景成图冒充独立近景生成；每档在原生画布上独立采样。B0 只有文本/框，不能强制生成世界姿态不变；B1 增加人体投影条件，B2 再增加轮廓区域，它们也不是像素级姿态保证。

主人在执行前明确本轮只验证可用性、降低物料与回传成本：五种取景统一采用基础 `1024×768`、4:3 原生画布，不做全量 2×/3× 放大；两角色组合、各方法和权重对照之间保持同画幅。通过参考相机距离/取景窗口表达 W/M/C/XU/XH，不用改变画幅替代景别定义。新规格在正式 manifest 前冻结，旧 1152×864/864×1152/1024×1024 配置不执行；当前尚无已生成样例需要覆盖。基础像素不足可能限制远景手指/嘴唇判断，作为证据边界交给主人，不自行加高分补跑。

如上述画幅无法满足完整人物与尾巴的中景目标，先在无扩散的参考构图阶段调整并由主人确认，不在看过正式出图后逐图改画幅。目标调整必须写入新 spec 版本。

实验不接 `RSCameraControl`，避免它再缩放/旋转区域导致二次变换；它不是三维相机。每档参考 camera 写入 scene_json，角色 box 由对应 owner 参考投影的可见包络计算：像素 bbox 四边各扩 8px、夹到画布，再归一化为中心 x/y 与 w/h；重叠按参考真实存在，不套生产相接矩形。B0/B1 使用同一 box；B2 使用同一投影来源的轮廓 union，`RSMultiCharacterMask margin=0/threshold=0.5`。框尺寸不是出图后主体包络，不能机械推断景别已经正确。

各档 framing tags 仅在公共 prompt 追加一次：W=`wide shot, full body, scenery, small subjects`，M=`full body, centered composition`，C=`cowboy shot`，XU=`upper body, close-up`，XH=`extreme close-up, face focus`；角色描述只写各自姿态/朝向/身份。离线研究允许这个提示词对照，不改生产 wide 的 Camera 规则。精确 prompt、scene 与投影 hash 在 spec 冻结。

### 3.3 核心 case 清单

| 动作 | DC 核心 case | QG 核心 case |
| --- | --- | --- |
| 十指相扣 | DC-HAND-W / M / C / XU | QG-HAND-W / M / C / XU |
| 拥抱 | DC-HUG-W / M / C / XU | QG-HUG-W / M / C / XU |
| 接吻 | DC-KISS-W / M / C / XU | QG-KISS-W / M / C / XU |
| 背负 | DC-CARRY-W / M / C / XU | QG-CARRY-W / M / C / XU |

边界 case 为上述 8 个 pair/action 分别加 `-XH`。只有 HAND 的一对手十指相扣，不额外要求两对手同时交握。

### 3.4 动作可观测性，不用裁切作弊

每个 case 在出图前声明 `expected_visible_contacts` 与 `expected_out_of_frame_parts`；出图后再标实际可见性，二者都保留。

- W/M 理论上能展示全局动作，但 W 的手指/嘴唇可能因原生像素不足而不可判；画面看起来像牵手不等于证明十指相扣。
- C 按冻结构图保留应在画内的接触；若不符合，分别标 `framing_mismatch` 或 `contact_not_observable`，不偷偷扩大取景。
- XU 的 HAND 可能看不到低位双手；CARRY 常只能展示上半身关系；说明文件明确这种证据边界，由主人判断，助手不填写动作通过分。
- XH 的 KISS 可检查接吻；其他动作不能仅凭两张脸确认十指相扣、拥抱全部手臂或背负承重。
- 正常裁掉的尾巴/脚不算缺失；在声明应可见的区域缺失才计错误。可见的尾根、手腕和肩颈仍要检查连接。
- 放大裁剪只能帮助阅读原生已有证据；ESRGAN 或扩散新造的指头不能反向证明初稿正确。

## 4. 固定输入、结构参考与变量控制

### 4.1 随机性与模型

- 种子固定为 `20261111 / 20261112 / 20261113`。第一枚用于校准，后两枚用于修复策略留出验证。
- 阶段 seed 固定算法：`uint32be(SHA256(UTF8(case_id + "|" + decimal(seed) + "|" + stage))[0:4])`，无换行。stage 词表为 single/pose_grid/initial/repair_grid/repair_repeat/pass；W-RS/W-G 都使用 initial，保证权重/路由对照同 seed，且可复用 B2。例 `DC-HAND-W|20261111|initial` 的 digest 为 `23b8437e0cc1a70c5c55dda57c5e17a87e2ce49994db1af7b63fcb8afa401114`，stage seed=599278462。相同阶段各方法/权重用同 seed；方法名不进派生。同一噪声种子不意味着不同裁剪/架构内部随机过程完全相同。
- 冻结 checkpoint、CLIP、VAE、LoRA、姿态权重、节点源码、patch 的实际文件名与 SHA-256。oneobsession 文件位置和架构须现场确认，不能只凭文件名当作 2B。
- 初采样起点使用冻结 RS 的 Anima 默认组合：30 steps、CFG 4.0、euler_ancestral / sgm_uniform；所有 B/H/W 初采样一致，不混用生产 V8 的 dpmpp_2m/4.5 起点，也不同时扫 CFG/步数/采样器。R/P 步数/CFG/采样器同此固定组合，R 只扫声明的 denoise。
- RS 路由全部显式冻结：`layout_method=regional`、`lora_application_mode=precision`、`region_feather=0.04`、`initial_common_prior=0.05`、`common_after_step3_boost=0.1`、`initial_character_gain=1.7`、`initial_spatial_separation=0.9`、`boundary_hold_steps=3`、`boundary_decrement=0.2`；Interaction 不接（baseline）。这些只是固定研究条件，不代表最适合交互；若后续调整分离时序须独立对照。保存 mode 的 requested/effective，不能悄悄 fallback。
- run 内不加 RS image reference/Role K-V，不引入 progressive 或其他 attention patch；姿态 `AnimaLLLiteApply.mask=None`，从 MODEL 只挂一次。姿态 auto 未 applied 时机械报错，不让 masks_only 冒充 B1/B2。
- 不使用额外画风 LoRA；不照搬 V8 专用四轴扁平前缀。正负提示地板在正式采样前冻结，角色身份与原设服装来自角色资料。
- 所有送入 draw/条件文本采用英文逗号分隔 tag 形态，触发词走现有 normalize/escape；公共提示为 2girls，区域角色注入剔除全局人数冲突用的 1girl/solo，双人描述不能完全相同。

### 4.2 理想结构输入

先制作 8 套 pair/action 的共享世界结构，再分别输出五个景别的条件资产，共 40 组：

1. 可审核的彩色参考渲染及相机参数；8 套姿态中的身体、手指、接触与遮挡关系一并交给主人看，不由助手声称已视觉验收。
2. 与原生 LLLite 权重分布一致的着色 3D 人体及轮廓控制图；人体不擅自添加鲸尾骨架标签。
3. A/B 的矩形区域；A/B 的非矩形可见部件区域。鲸尾属于 DeepSeek 同一角色，不增加第三角色槽。
4. 接触组 core、可编辑域、灰度强度图与独立上下文域；灰度图核心有平台，外环渐变，实际错误接触线不被锁在低强度边缘。
5. 每个部件的 owner、连通关系、前后遮挡说明、应可见/应出画字段及区域坐标变换。

普通 OpenPose 不能表达十指交错；T0 已核实原生 MHR 54 controls 中有 34 个逐指关节，因此 T2 可使用真实 scene 手指控制，不再把 controls 存在性当未知。可控关节不等于已解算接触：确切指间几何、网格碰撞和成图表现仍须记录边界并交主人看图，不因有 controls 就声称十指相扣成功。若实际制作只用腕/整手控制，须明确该条件限制；额外网格/渲染分布变化不静默混入原生 LLLite 消融。

人体姿态条件、角色归属 mask、参考图、重绘灰度图是不同资产。外部 `RSMultiCharacterMask` 确定性清空 body_parts；本轮 B2 就是「角色级非矩形轮廓」，鲸尾与身体做同 owner 的 union，明确 `body_parts=()/body_part_strength=0`，不是另加一个尾巴语义槽。头/手等独立部位注意力不是本轮机制，不同时改变两件事。

首轮不要求自动生成这些结构输入；每组记录人工准备分钟数。未来自动化成本与当前扩散能力结论分开。

## 5. 方法矩阵与消融

### 5.1 联合构图 B 组：每方法 32 × 3 = 96 次初采样

| method_id | 输入与唯一增量 | 目的 |
| --- | --- | --- |
| B0 | 2B RS + 两角色 LoRA + 按景别投影的矩形区域与提示；无学习式姿态、无部件区域 | 当前能力类别的可复现离线基线，不冒称生产 V8 基线 |
| B1 | B0 + RS 原生 2B LLLite 3D 姿态条件 | 测姿态条件对交互关系的收益 |
| B2 | B1 + 同结构来源的非矩形角色轮廓 union，含同 owner 尾巴；body_parts 关闭 | 测角色轮廓区域对尾巴、衣服、交叠的影响，不冒称语义部件槽 |

B1/B2 的姿态权重来源：toyxyz/Anima_ControlNet-LLLite，revision `37f3a4b6574f1dce3dfe3b5440285a39b11b3d8d`，`anima_3dpose_outline_7000.safetensors`，预期 SHA-256 `8e2c90505c4363f74ea2deef427dd3b3f8e91ec41c40ab1955f18040fc15b708`。

上行 hash 已与固定 RS 快照的 `reference_assets.json` 核对；下载时还必须以固定 revision 的 LFS 元数据和实文件核对，不因不匹配而绕过检查。真实 manifest 只能记核对后的完整 64 位 SHA-256。权重许可与节点 GPL 使用范围一并记录。

姿态强度与作用区间另做 8 张决策对照：2 个 M 构图（DC-HUG、QG-CARRY）的第一种子 × strength=0.5/0.8 × 作用区间=前 70%/全程。主 B1/B2 预先固定 strength=0.8、start=0、end=0.7，不由助手看这 8 张图选优。仅当架构/权重/patch 日志等机械证据显示未实际接入时停止后继；视觉效果是否生效由主人判断。

B0/B1/B2 只比较原生分辨率初稿，不默认叠加脸修、手修或质感 pass。每次只添加一个机制；不把多个调参同时改掉后称单因素结论。

角色轮廓重叠区可能共享 caption；同文件相同权重会共享 LoRA hook。框/轮廓与分离时序也会影响交互，不得根据某组效果直接宣布「2B不会拥抱」「同文件一定串色」或「RS是唯一原因」。这里只冻结条件和交付对应图，结论由主人看图决定。

### 5.2 接触组修复 R 组

基础父图统一选 B2 对应 case/seed；若 B2 有真实阻塞，不自动改用另一个方法并宣称原方案完成，须记录阻塞或经主人批准修订。父图不能按最好看程度挑选。

| method_id | 修复机制 | 对照关系 |
| --- | --- | --- |
| R0 | 父图原样保留，不采样 | 修复净收益基线 |
| R1 | 联合接触裁剪 + 均一可编辑域 + 普通 masked img2img，角色 LoRA 全局加载 | 廉价接触修复对照 |
| R2 | R1 + 灰度外环 Differential Diffusion | 隔离渐变重绘机制收益 |
| R3 | R2 + RS 多角色区域身份路由的局部 img2img | 检查保留身份隔离的额外收益 |

R1/R2 本轮两角色权重均固定为 0.8，同文件全局只加载一次，角色提示仍为两份；R3 两个角色槽不因文件相同而合并。不同文件各加载一次。若未来同文件两个槽权重不同，不能按两个 `(file, weight)` 各全局加载一次冒充角色独立加权，必须明确改为统一文件强度或保持区域槽位；生产逐角色重复加载方式另放 P 组。

二开内容仅在隔离 RS 源码：新增 latent/image、denoise、noise_mask 输入，保留区域 LoRA 路由、正确采样区间与模型 hook；crop/resize/pad 对图像、角色 mask 和灰度图使用同一变换。R1/R2/R3 都使用未挂初采样姿态 patch 的全新 MODEL，保持修复阶段姿态条件关闭；不让 RS 按旧全景 scene 在裁剪画布重渲染而造成坐标错位。保留姿态的局部修复作为后续独立变量，不暗加到 R3。保留来源许可与 patch，不修改生产 custom_nodes。

重绘从 `VAEEncode + SetLatentNoiseMask` 起步，不用会 round 遮罩并抹灰原图的 VAEEncodeForInpaint 保留渐变。Crop & Stitch 保护外部像素。均一与渐变方案使用相同核心、外部支持域、上下文、裁剪分辨率及 seed，只改变域内强度分布。

首次校准取 8 个 M case 的第一种子，固定接触组，不选图；R1/R2/R3 各试 denoise=0.30/0.45/0.60，共最多 `8 × 3 × 3 = 72` 次。灰度外环宽度固定为裁剪短边约 8%，核心内值为 1；支持域外为 0。确切栅格化、blur/距离算法和灰度图 hash 冻结记录，不能每图手改。

修复裁剪保留原像素坐标与实际 resize 倍率，统一局部 target 为 768×768；不把整个 1024×768 父图做 2×/3× 放大后扩散。初稿像素不足时修复可能新造细节，原稿与修后图并排交付，不由助手宣布任何一方动作成功。

后两种子作预先固定策略复验：每个核心 case 比较 R1(denoise=0.45) 与 R3(denoise=0.45)，各最多 `32 × 2 = 64` 次，共最多 128 次；R0 父图同时交付。它们不是助手从校准图中选出的胜者。主人看过全部图后再决定是否换权重、强度或增加 R2 复验，新增运行另列预算。

修复域按冻结的结构投影生成，不能由助手看生成结果挑「值得修」的父图。只允许因投影编辑域为空/出画、缺父文件或执行故障等机械原因跳过，写清具体原因并保留父图；不根据「人数错」「姿势差」「身份弱」等视觉判断删图或重抽。遮罩与模型实际生成位置不一致也原样交付，附控制图供主人判断。

### 5.3 头部边界 H 组

8 个 XH case × 3 seeds，对 B0 和 B2 各生成一遍，最多 48 次。只检查实际可见关系与身份，完整动作证据单独记不可观测。B2 不可用时保留阻塞，不偷偷换为 B1。

### 5.4 收尾与同文件叠加诊断 P 组

8 个 M case 第一种子 B2 父图，在原生分辨率追加 denoise=0.25 的外观 pass：

- P1：按唯一文件/权重全局加载；
- P2：按现生产逐角色链式加载习惯，即 QG 同文件出现两次。

最多 16 次；不同文件的两图若图结构与所有输入完全相同，可复用并记录 hash，不重复算样本。此组隔离「全局收尾/同文件叠加」影响，不冒称等价于生产 2x 域质感 pass。

2B 的 P1/P2 统一使用 core `LoraLoader`，不依赖未冻结的 `AnimaLoRARemapTagLoader`，不进行 28→52 remap；P2 只模仿逐角色链式加载的顺序，不冒称与生产 remap loader 实现完全相同。先机械核对匹配 key，禁止在同一 run 临时换 loader。

收尾不承担结构修复，生产质感 pass 仍固定 0.25。本轮默认交付基础原图；如需展示放大，最多约 1.2× 的本地像素域纯缩放，单列为可追溯派生产物，不额外扩散、不替代原生结构证据，不默认给全部图生成额外展示副本。高分效果验证仅在主人亲眼看过基础样例并明确指定后另行安排，助手不挑图；3 倍 latent 扩散禁止。

### 5.5 LoRA 强度与相互压制 W 组

目的：区分「单角色本来就需要更高系数」「共同使用后概念竞争」「区域路由额外影响」。数值系数相同不代表不同文件或不同角色概念的视觉强度相同；B 特征变弱不能直接判 RS 有问题。所有效果判断归主人。

**W-S 单角色梯度**：4 个角色各自中景站姿，权重 0.6/0.8/1.0，两个种子 20261111/20261112，共 24 张，替代原来的 4 张单角色冒烟，第一枚种子的 0.8 项兼作机械冒烟。提示、服装、镜头、采样设置固定，默认 model/clip 强度联动；实际匹配到的 model/clip key 数分别记录，clip 没有匹配 key 时不能声称它有作用。

**W-RS 双角色九宫格**：两组角色 × 四动作 × M 景 × 两种子 × A/B 各取 0.6/0.8/1.0 的 3×3 网格，共 144 个结果引用。使用 B2 的相同结构/区域/姿态设置，只变 A/B 槽位强度；其中 16 个 (0.8,0.8) 项复用 B2 已有同输入图，实际最多新增 128 次。明确展示 (0.8,1.0)、(1.0,0.8) 等不对称配置，不只一起升高。

**W-G 全局共同加载对照**：不使用 RS 身份区域路由，保留相同底模、结构姿态条件、提示与采样设置，走普通 KSampler。DC 可将两个不同文件分别按 3×3 权重加载，4 动作 × 2 seeds × 9=72 张。QG 同文件不具有两个可独立全局加权的角色参数，只比较该文件整体 0.6/0.8/1.0，4 动作 × 2 seeds × 3=24 张；与 W-RS 的等权对角线配对，不伪造异权全局等价组。W-G 的条件由 core 原生 LLLite 施加一次，不同时从 RS pipe 再挂一次。

W-S 24 + W-RS 新增 128 + W-G 96 合计 248 次，其中 24 已替代单人冒烟；相对旧预算净增 244 次。权重首轮不超过现有受控范围 0.4–1.1；1.1 或更细 0.1 步进留给主人看后决定，不默认追加。

B 组在 0.8 基线下的结果不代表已穷尽各角色合适权重。W 组不能由助手自动计算「最佳权重」或据此筛掉 B/R 结果；主人决定新的组合后，才另开对应权重复验，不把不同权重改善误写为 RS 机制改善。

## 6. 规模、成本与停止规则

| 阶段 | 最大新增采样次数 |
| --- | ---: |
| W-S 单角色权重梯度，含身份/架构冒烟 | 24 |
| 姿态条件小校准 | 8 |
| B0/B1/B2：32 核心 × 3 seeds × 3 方法 | 288 |
| H：8 头部边界 × 3 seeds × 2 方法 | 48 |
| R 校准 | 72 |
| R 留出验证 | 128 |
| P 收尾诊断 | 16 |
| W-RS 双角色异权对照新增，16 个 0.8/0.8 项复用 B2 | 128 |
| W-G 全局共同加载对照 | 96 |
| 合计上限 | **808** |

R0 和 W-RS 重复的 0.8/0.8 项复用父图、不另采样；裁剪/条件渲染/约 1.2× 像素域纯缩放不算扩散采样，但耗时另记，不加入 ESRGAN 等学习式超分。跳过项保留清单；失败不靠自动补 seed 扩大预算。正式任务不得越过 808 次或主人批准的更小上限。数量上限本身不构成授权；当前执行授权及仍未放行的 G0 前置见 §1/§13。

不承诺沿用 3.8B 历史秒数。用冒烟及姿态校准记录模型加载、首图、warm p50/p90、显存峰值（若可读）；预估为各阶段任务数乘该阶段实测时长，裁剪/收尾不同分辨率单独估算。R1/R2/R3 首个已预算任务串行计时后再放行余量，不额外加未计数 benchmark。

以下属于真实阻塞，应停止相关后继并保存已完成证据：

- 2B 架构、CLIP/VAE、LoRA 映射或姿态权重校验不成立；
- 独占窗口未确认、生产工作到来或 GPU 资源不可安全隔离；
- 参考姿态本身无法验证，或用户认为景别/动作定义偏离要求；
- 灰度图被二值化、RS 局部采样丢失身份路由、坐标变换不能对齐；
- 提交状态不明、丢失 prompt_id、runner 状态与服务队列矛盾；
- 相同环境错误连续 2 次、同一修复条件连续 3 轮验证输出无实质变化；
- 达到数量、磁盘或时间窗口限制。

OOM 先记录失败；不得静默降分辨率、改模型、改 seed 或换采样器。需要降档时形成新配置版本并征得范围调整授权。

## 7. 主人人眼验收与 Downloads 样例交付

### 7.1 职责边界

**主人是唯一图像验收者。** 助手及任何 subagent 不代看图打分、不判身份/动作/景别是否成功、不决定哪个权重或方法更好、不删掉「坏图」，也不以检测器、相似度、LLM 评语或高频分数替主人验收。

助手只记录机械事实：case/seed/method/父图、实际权重和参数、版本与 graph/资产 hash、prompt_id、generation_info 原文、实际尺寸、文件大小/SHA-256、执行状态/错误与耗时、回收位置。RS generation_info 中保留 pose_adapter/anima_lllite、region_geometry、mask_slots/box_slots、RegionalLoras.audit 与 execution.effective；它们证明接线和执行，不证明图像效果。

不预填 0/1/2、confirmed_action_success、in_frame_success、可观测性或建议采用配置。可在说明里列「你可以重点看什么」和哪些关系按取景定义可能出画，但不得写成图像已经通过/失败的结论。用户反馈可由助手逐字登记，未反馈的内容保持未验收；不要求主人使用评分表或填写 JSON。

### 7.2 指定交付根与已有内容保护

唯一用户交付根：`~/Downloads/yugang-ab`。2026-11-11 已只读确认其中有历史实验 01–46 等目录及散图；这些全部是既有用户物料，不移动、不覆盖、不删除。

**2026-11-12 主人新增执行要求：边生成边回收，不等完整实验。** 实时副本独立放在 `47-Anima2B-双人交互-实时回收-20261112/`，不与下表最终决策目录混用。`scripts/experiments/interaction-study-pull.py` 经 home-connect 的 LAN 优先 WSL 通道每约 15 秒检查成功任务，只复制新增原始 PNG、参数、graph 与 generation-info，逐文件和传输包核 SHA-256；`INDEX.md` 只导航、不打分。增量回收不构成最终交付或视觉验收，最后仍须按下表完整归档与机械审计。主人可在执行期间自行 review，助手不查看图像评分或选优。

本轮使用下列独立决策目录。编号 47–60 是拟用命名；真正创建前原子检查每个目录是否存在，任何冲突都停止创建该交付 revision，统一加新的 run 后缀，不把新旧图混在一起。下载根的空间需求在 preflight 按原图及必要重复副本估算。

| 拟交付子目录 | 样例集合（全部保留） | README 要解释的决策 |
| --- | --- | --- |
| 47-2B-角色身份与结构参考 | W-S 的 0.8 单人图、全部结构渲染/owner/control/gray 参考 | 模型、角色、世界姿态和条件图分别是什么，参考输入有哪些限制；不宣称已确认正确 |
| 48-2B-姿态条件开关 | B0 与 B1，同 case/seed 成对 | 是否需要增加学习式姿态条件，而不是只靠提示和区域 |
| 49-2B-非矩形身份区域 | B1 与 B2，同 case/seed 成对 | 矩形区域与同 owner 非矩形轮廓是否值得替换 |
| 50-2B-均匀与渐变重绘 | R0/R1/R2 校准全部强度与控制图 | 渐变重绘是否比均匀重绘值得采用；二者支持域和贴回方式相同 |
| 51-2B-接触组区域身份 | R0/R2/R3 校准全部强度 | 局部重绘时保留两角色区域路由是否值得二开 |
| 52-2B-重绘强度梯度 | R1/R2/R3 的 0.30/0.45/0.60，按方法分组 | 结构改动力度与身份/外围稳定性的取舍，不预选最优 |
| 53-2B-固定策略复验 | 后两种子 R0/R1(0.45)/R3(0.45) | 预先固定策略在各动作和景别下的表现，是否需要用户指定下一轮 |
| 54-2B-超近景头部边界 | H 的 B0/B2 和同源 XU 对照 | 仅头部与 upper body 的身份/接触可见性边界；不能凭画外部分证明全动作 |
| 55-2B-收尾与同文件叠加 | P 父图、P1、P2 | 全局外观 pass 是否改变角色；同一文件全局链加载一次与两次的区别；不是 RS 初采样 hook 去重对照 |
| 56-2B-四景别覆盖 | B2 的 W/M/C/XU 全部图及 XH | 同动作与角色的五种取景配置如何呈现，完整展示与局部细节如何取舍 |
| 57-2B-姿态强度与区间 | 全部 8 张姿态强度/区间对照 | pose strength 与生效区间是否值得调整，主线固定值没有经过助手选优 |
| 58-2B-单角色LoRA权重 | W-S 的四角色 × 三权重 × 两种子 | 各角色在独立使用时需要什么加载系数，不以同数值视作同视觉强度 |
| 59-2B-双角色不对称权重 | W-RS 的完整 3×3 九宫格 | A/B 权重不等时能否改善一方特征变弱；保持同场景/姿态/seed |
| 60-2B-全局与区域LoRA | W-G 与可对应的 W-RS；QG 仅等权对角线有全局对应 | 区分共同加载、区域路由与权重不足；QG 不存在「同文件两概念独立全局加权」的等价组 |

同一张原图可能用于多个决策，允许复制到多个目录并在清单注明复用；不因复用再次采样，也不以软链接代替下载到本机的真实文件。全体 job_id 的并集必须与计划清单一致；技术失败没有图也必须有记录，不能静默缺项。

每个决策目录至少有：

```text
README.md
manifest.csv
运行记录.jsonl
DC_HAND_M_seed20261111_B0.png
DC_HAND_M_seed20261111_B1.png
参数与接线/
控制图/
原生裁剪/
```

命名是格式例子，不是已经生成的文件。每张图包含 pair/action/framing/seed/method/权重或denoise；参数单独明细避免超长文件名。原生裁剪按冻结结构坐标机械输出，不根据图像好坏挑裁剪、不做增强。拼贴若提供只为导航，原始 PNG 仍全部交付。

### 7.3 每份 README 的固定内容

1. **这组要决定什么**：采用哪条机制、是否值得二开或下一轮应调哪个旋钮。
2. **各侧是什么**：节点路径、输入/权重/denoise/作用区间，哪些变量不同、哪些固定；不是单因素的全局/区域家族对照明说其编码和路由结构同时不同。
3. **如何看图**：按同 case+seed 横向对照，文件命名、角色 A/B、动作与景别定义；附匹配文件表，不隐藏方法名、不打乱用户看图顺序。
4. **重点可看什么**：身份、鲸尾/帽饰归属、手/肩/头连接、接触带、接缝；只列观察问题，不填写答案。
5. **证据边界**：哪些部位按结构取景在画外、远景像素可能不足；局部修复可能补造新细节，父图与修后图不可混为证据。
6. **这组有多少项**：计划数、采样返回数、实际图数、复用项、技术失败/跳过项及原因；不提供助手判定的成功率。
7. **执行与追溯**：版本/实际参数、源 job_id/hash、耗时、对应节点/patch；结论写「待主人看图」，不预填最佳方案。

顶层新增本轮索引 Markdown 和 delivery.json，列决策目录、样本集合、路径/hash/尺寸与错误项。可读文件只含样例和必要技术说明，不夹入凭据或大段模型内部过程。

### 7.4 交付与视觉验收是两个状态

原图和说明全部回收、机械完整性检查通过后，助手状态为 `delivered_awaiting_user_review`，只报告「样例已全部交付，等待你看图」。主人之后指出选用、淘汰、调整权重或重跑的结论，助手才如实记录；没有反馈不宣告管线视觉验收通过。

不以等待主人看图触发停滞、自动补图或重复催促；未授权的新参数/新样本不自动开跑。原证据留在 run-root，Downloads 是用户可自由查看/删除的副本；若在已交付后删除，不偷偷重建或改写其反馈。

## 8. 产物、执行器与恢复

以下为已经授权、待实现的产物；实际完成情况以执行证据为准：

- `experiments/anima-interaction-v1/spec.json`：冻结角色键、动作、景别、种子、参数、字段契约。
- `experiments/anima-interaction-v1/structure/`：40 组可审核结构夹具及生成源、相机参数、标注；角色事实只引用源表。
- `experiments/anima-interaction-v1/patches/rs-img2img.patch` 及 `custom_nodes/yugang_interaction/`：隔离节点包二开与遮罩坐标胶水节点，保留来源许可。
- `scripts/experiments/interaction-study.ts`：本地 build/preflight/collect/deliver/report/verify 统一入口，根路径从 `src/paths.ts::REPO_ROOT` 取得；Downloads 目标为主人指定的绝对路径，不从 repo root 派生。
- `scripts/experiments/interaction-study-run.py`：远端只消费绝对 manifest/run-root 的离线 runner，不自行推导本地仓库根、不接 QQ。
- `scripts/experiments/interaction-resource.ts`：G0/G1 的生产 Mac 资源租约辅助，单独记录原状态与恢复证据，不混入实验采样 runner。
- `var/local-driver/anima-interaction-v1/`：运行证据，不进 git；至少含 preflight.json、manifest.json、inputs/、graphs/、images/、crops/、results.jsonl、generation-info/、reviews/、state.json、delivery.json、acceptance.json、report.md。user-feedback.jsonl 仅在主人反馈后逐字登记，不生成助手 annotations。
- `~/Downloads/yugang-ab/`：§7 定义的每决策目录、全部样例和 README、本轮索引与 delivery.json；目录编号冲突不得覆盖。

实际模型路径、实验实例路径、Windows run-root 和端口在 preflight 记录真实值后冻结，缺失就拒绝 build，不填假路径或假 hash。模型/条件/graph hash 改变不得覆盖旧 run，需新建 revision 子目录并只验当前 revision。

runner 要求：

1. 仅通过 home-connect：LAN 被证明时可用 `~/.agents/skills/home-connect/scripts/connect.sh` 的 `windows windows-check`、`windows win-exec` / `windows win-run`；主人已明确允许中继，非 LAN 时可核实既有 `wsl-relay` 入口，并在既有 WSL/Windows 文件与互操作通道可用的前提下执行等价控制。不能仅因 LAN 未证明就判研究阻塞，也不能把 WSL 中继称为 Windows 原生 SSH。不得自行拼 SSH、创建新隧道、绕过认证或修改系统服务；指纹/认证/反向端口异常按技能停止条件处理。中继大文件传输仍须遵守费用确认与显式放行规则。
2. Windows 独立后台进程持久化 manifest/job/prompt_id；客户端断线不取消已提交作业。一次仅一个采样任务。
3. 提交前持久化 submitting 与预分配 ID。仅在服务支持并验证客户端指定 ID 时使用该协议；否则实现并验证可唯一回查的关联机制，不能假设远端回显就足够。
4. 明确 accepted 才等待 history；断线只回查原 ID，不重新 POST。状态不明即停止调度，留恢复说明。
5. 在实验互斥窗口内调度；检测到生产需求时停止新增提交，已接受任务不擅自中断，释放窗口后等待重新授权。
6. 采样成功以 history completed/success、输出存在并可解码、hash/尺寸符合为准；日志出现「提交」不等于完成。
7. 收集原始 PNG、控制图和完整参数；凭据不进 manifest、图元数据或日志。不得触碰 fish.db、表情库或 QQ 出口。
8. 每任务等待上限初定 1800s；超时记 observation_timeout 并停止新提交，回查原 ID，不认定服务端已取消。未核清的任务保持 unresolved，不能用 timeout 行把它伪装成已闭合。
9. 隔离实例的 output/temp/user 目录均独立，不只改端口；启动与结束保存生产 custom_nodes/配置/模型目录的只读清单与相关文件 hash，证明未修改生产和既有 18190 隧道目标。
10. 回收后逐文件比对远端/run-root/Downloads 的 hash、尺寸与 case 映射；机械报告只列数量/参数/耗时/错误，不输出图像质量结论。

### 8.1 实现期接口与后置绑定

T1 已冻结声明式 `spec.json`，T4 已冻结节点接口。本地结构生成源与构图/runner 代码不依赖权重文件存在，可以立即并行实现；T0 仍是实体绑定、条件实际渲染、节点安装和任何 GPU 运行的真实前置。不得因实现先行填假路径/hash、用代理模型或把缺输入的 build 记为通过。`build` 必须在真实 preflight 与结构资产齐全时才产出可执行 manifest/graphs。

- **T2a 结构源**：唯一写 `experiments/anima-interaction-v1/structure/` 与 run-root 的 `inputs/structure/`。按固定 RS scene schema 产世界/相机/owner/接触定义及 CPU 渲染程序；真实 MHR 资产不可用时只交已完成源和缺项，不画火柴人冒充匹配的 LLLite 条件。T2b 另行实际 CPU 渲染与机械核验，不混入 GPU 或人眼评分。
- **T3a manifest/构图实现**：写 `scripts/experiments/interaction-study.ts` 与 `interaction-study-lib/` 内构图模块。入口 build/preflight 调用这些模块，后续 collect/deliver/report/verify 通过独立模块整合，禁止以永远通过的空实现占位。基于真实 spec/preflight/结构文件绑定全部矩阵和 T4 接口，缺一即报具体缺项、不生成假可运行图。
- **首批 W-S 不设双人结构屏障**：既定单人普通文本管线的首 seed `20261111`、权重 `0.8` 四项可先通过 `build --group W-S --seed 20261111 --weight 0.8` 编译到 `stages/w-s-smoke/`，不额外添加姿态 patch 或等待 40 份双人几何。子集 manifest 仍绑定真实模型/图/元数据节点，只声明所选 4 项，不能当完整 F1；完整交付必须吸收这 4 项原图/原 prompt_id/真实 graph hash 为同一 job 的已执行证据，不再次采样、不增加 808 上限。跨子集/完整清单的闭合状态迁移另行整合，不覆盖旧状态或将未知任务当新任务。
- **T3b runner 实现**：唯一写 `scripts/experiments/interaction-study-run.py` 及 `contracts/runner.md`；只消费绝对 manifest/run-root 和显式连接配置。Windows 独立后台进程与本地资源守护通过 home-connect 配合，每次提交前核对真实 Mac 热闸与隔离队列；本地守护失联/许可过期时停止新增提交，已 accepted 的任务继续回查，不能靠 Windows 复制的旧 lease 自证互斥。不得新建 SSH 隧道或把进程绑在中继前台。
- **manifest 基本格式**：顶层 `schema_version="anima-interaction-manifest.v1"`、`spec_sha256`、`preflight_sha256`、`jobs`；每行除 §10/spec.output_contract 字段外，固定 `sample_kind=new|reuse`、`depends_on`、`reuse_of`、`graph_path`、`graph_hash`、`expected_width/expected_height`、`input_files`、`output_contract.image_node_ids/metadata_node_ids`。新增采样行与复用/父图引用行分别计数，808 是新增采样上限，不是假定总引用行数。复用不 POST；`input_files` 每项为 `target`（安全扁平 PNG 名，与 LoadImage 相同）和 `source`：文件输入 `kind=structure|run_root_file,path,sha256`，父图 `kind=parent_job,job_id,output_node_id`，实际产生后核 hash 并上传到隔离 input，不能预填不存在图的 hash。
- **图/结构对应**：每 case 结构索引记录 scene、pose_image、owner_a/owner_b、repair_core/support/context/gray 的真实文件与 hash，box 为归一化中心坐标 `x/y/width/height`；图构建在真实渲染后消费，不各自重造几何。case 内相机/动作/owner 定义共享，景别仅改规定相机参数。
- **运行元数据**：输出节点 ID 在 manifest 明确列出，runner 从 history 保存其原文，不从进度日志猜 generation_info。若 core 缺字符串落盘节点，可在独立实验包 `custom_nodes/yugang_study_support/` 增加非采样 OUTPUT 节点，将接入的 generation_info/transform_json 以 `ui.study_metadata` 字符串列表交给 history；不修改 T4 已交付包或生产节点。
- **状态协议**：runner 持久化 `state.json`、追加 `results.jsonl`、保存 `generation-info/` 与原始 images；`submitting/accepted/unresolved` 不当终态。新建任务协议验证/真实冒烟另派，不将语法通过当成已验证服务支持客户端 prompt_id。按批限时停止新增提交，保留精确续接点，不能用重新 POST 恢复未知任务。
- **R 接口修正（真实机械证据触发，不改方法/预算）**：T2b 证明旧 support 是全身 union 膨胀、非局部接触组，native gray 经 crop 后的 8% 也未证实。因此 R 不放行旧域：另产 `inputs/repair-v2/repair_index.json`，从冻结动作的相关部件/接触锚点投影定义局部 core/support/context，保留旧 416 PNG/原索引审计，不改世界姿态/pose/owner/box。HAND 用双手腕及必要前臂，HUG 用相关肩臂/躯干，KISS 用双方头颈，CARRY 用承托/搭靠相关部件；core 必须涵盖两侧之间待补的空隙，不能仅取 owner 相交或盲用两人全身。部件/锚点与出画判据全部可追溯，不看生成图选域。
- **裁剪空间噪声图**：保留 T4 坐标胶水不变，新增隔离小节点 `YugangRepairMaskFalloff(core, support, ring_fraction=0.08)`，输入为同 STITCHER 变换后的 crop mask；阈值 0.5 转二值，core 必须包含于 support。在真实 crop 尺寸上计算 `round(min(H,W)*0.08)` 的 Chebyshev 外环（768 时 61px），core=1、环内连续递减、域外=0，边界/支持域截断如实记参数。输出 `uniform_mask/gray_mask/falloff_info`（MASK/MASK/STRING）；uniform 定义为最终 gray>0，以保证 R1/R2/R3 的可编辑支撑一致，R1 不接 DD、R2/R3 接 DD。原生 gray 仍保留作结构来源，不冒充 crop 的实际 noise_mask；元数据保存真实 falloff 参数/尺寸与截断事实，不新增扩散阶段。
- **R 输出类型/尺寸与输入寻址**：`YugangRSMaskedImg2Img` output0 已是 IMAGE，直接 Stitch，不能再接 VAEDecode；R1/R2 的 LATENT 才 Decode。Stitch 后主 PNG 与父图同为 1024×768，768² 只是修复内部画布，manifest 的 expected_width/height 必须对应实际主输出。文件型 input_files.source.path 使用相对 run-root 的真实可解路径（或显式绝对路径），不得把 repo-root 相对名冒充 run-root 相对名。修正仅改实验实现，旧 draft 图/manifest 不覆盖，真实运行前在最终绑定版本重建。
- **首批运行的保守资源许可**：每次 fresh Mac helper 状态及生产旧队列空闲取证之后，签发新许可并仅启动 `max-new-jobs=1`；不让首次运行拿磁盘旧许可自证新鲜，也不以仅检查隔离队列代替全 GPU 互斥。接收后按原 ID 回查直到闭合，不因许可到期取消或重新 POST。扩大批运行前仍须满足每次提交的真实互斥证据，不因 runner 的一般默认参数放宽本约束。
- **当前 revision 的统一消费**：旧根目录 draft 的 manifest/808图不覆盖；新的绑定版位于 canonical run-root 的独占 `revisions/` 子目录。发布时新增 `current-revision.json`，字段为 `schema_version="anima-interaction-current-revision.v1"`、`run_root`（其下真实 revisions 子目录的相对路径）、`manifest_sha256`（当前实文件 SHA）。只有 collect/deliver/report/verify 跟随该指针，build/preflight/describe 仍使用显式 --run；无指针沿原根，有指针但路径越界/不存在/hash不符必须拒绝，不能回退旧 draft 冒通过。因此主人固定的 `verify --auto --run var/local-driver/anima-interaction-v1` 仍只核当前交付版。指针发布前须让当前版带齐实际 spec/preflight/输入及原始资源/checks 上下文，不伪造 G1 或审计；首4W-S 仅吸收已闭合的原 job/graph/prompt_id/图像证据，未知状态不迁为新任务、不重新采样。本地审计上下文可明确复用实际原文件，Downloads 图像仍必须真复制。
- **跨机器输入与账本位置**：编译版若引用开发 Mac 的绝对 `input_files.source.path`，不得直接交 Windows 读取。派生独占 executable revision，把真输入按 SHA 复制到本 revision 的相对 `inputs/by-hash/`，仅改传输定位并保留来源映射；job/graph/种子/模型/条件图字节与 hash 不变，不重造几何或补采样。Windows 原样镜像该目录即可，实际 worker run-root 用独立 execution profile 记载，不把库存 preflight 的计划路径伪改为历史实测。D 卷 fsync 已失败的关键账本迁到验证可持久化的新 owned C 卷目录；Comfy/core/共享模型可仍在 D，禁止通过系统防护排除、改服务或静默取消 fsync 来绕过故障。旧 D 失败物料完整保留；若 C 也失败则停并判断 G1 安全收尾，不无界尝试系统修复。

## 9. 整体交付终态：goal 可消费清单

本清单是执行完成声明唯一来源。执行前先取得脚本/夹具/GPU 授权与模式选择；下列命令是待实现的机械交付检查入口，不是当前已经存在或已经通过的检查。AUTO 不判图，唯一视觉验收项 F8 只接受主人结论。

统一机械交付检查命令（从仓库根执行，覆盖全部 AUTO）：

```sh
node scripts/experiments/interaction-study.ts verify --auto --run var/local-driver/anima-interaction-v1
```

命令逐项输出 F1–F10 的 passed/failed/pending-user、判据与证据路径，写 acceptance.json；全部 AUTO 通过则 exit=0，即使 F8 尚待主人。`verify --all` 仅在主人已经反馈后检查整体终态；F8 未确认时非零是预期等待，不是故障，不重试催促。每个 AUTO 项可用同一入口 `--criterion F数字` 单独执行。

| 编号 | 类型 | 必要条件、环境与通过判据 | 验证命令或人工步骤 | 证据位置；覆盖任务 |
| --- | --- | --- | --- | --- |
| F1 | AUTO | 本地构建后存在 32 核心+8 XH 唯一 case，角色源表/模型/节点/输入 hash 完整；所有方法任务数与 §6 上限一致 | `node scripts/experiments/interaction-study.ts verify --criterion F1 --run var/local-driver/anima-interaction-v1` | manifest.json、preflight.json；T0/T1/T3 |
| F2 | AUTO | 8 套世界结构、40 组投影/owner/control/core/support/context/gray 文件与源参数齐全，尺寸/hash/坐标和值域一致；不机械声称动作或身份正确 | `node scripts/experiments/interaction-study.ts verify --criterion F2 --run var/local-driver/anima-interaction-v1` | structure/、inputs/、manifest.json；T2 |
| F3 | AUTO | Windows 冒烟与 B0/B1/B2 的全部预定任务有真实结果；正常出图可解码、尺寸/hash/seed/条件可追溯；execution_error 明确记录，不以阻塞替代尚未执行的整组 | `node scripts/experiments/interaction-study.ts verify --criterion F3 --run var/local-driver/anima-interaction-v1` | preflight.json、graphs/、results.jsonl、images/；T0/T3/T5 |
| F4 | AUTO | R 参数对照与预定策略复验按冻结清单完成；父图无挑选；仅机械跳过且有原因，所有父图仍交付；crop/mask 变换及灰度值域可核验 | `node scripts/experiments/interaction-study.ts verify --criterion F4 --run var/local-driver/anima-interaction-v1` | inputs/、graphs/、results.jsonl、patch；T4/T6 |
| F5 | AUTO | H/P/W 全部对照有终态；两角色实际 model/clip 权重、作用方式、generation_info、stage seed 明确；16 个 W-RS 复用项与 B2 原图完全绑定；QG 无虚构异权全局对照 | `node scripts/experiments/interaction-study.ts verify --criterion F5 --run var/local-driver/anima-interaction-v1` | graphs/、generation-info/、results.jsonl、images/；T3/T5/T6 |
| F6 | AUTO | Downloads 每种决策独立目录并含全部计划图/技术错误记录、README、参数及清单；delivery 的 job 并集==预定集合，原图 hash 与 run-root 相同，已有 01–46 等物料无改动；不含助手评分或选优结论 | `node scripts/experiments/interaction-study.ts verify --criterion F6 --run var/local-driver/anima-interaction-v1` | Downloads 指定根、delivery.json、report.md；T7 |
| F7 | AUTO | 当前交付版本通过既有 npm test；生产变更只限主人授权的 drawEnabled 热开关已审核清单/提交与本轮配置键切换，其他受保护源码/配置/模型/模板和已有物料无改动；运行证据不含凭据，报告 hash 对应实文件 | `node scripts/experiments/interaction-study.ts verify --criterion F7 --run var/local-driver/anima-interaction-v1` | checks/npm-test.log、checks/change-scope.json、checks/draw-hot-switch/、preflight.json；T3/T4/T7 |
| F8 | MANUAL | **全部图像验收只由主人亲眼判定**；助手/subagent 不可代判、代选或用自动评分替代 | 操作者主人：自行查看 `~/Downloads/yugang-ab` 中各决策目录的全部图和 README，用自然语言给出结论/取舍/需要重跑项即可，不必填表。助手仅逐字记录并绑定交付 revision；未反馈为 pending-user | 主人原始反馈、delivery.json、user-feedback.jsonl；交付后主人执行 |
| F9 | AUTO | 作业状态闭合、无不明提交；独立审计核对 F1–F7/F10 的原始文件与当前 hash，明确 F8 仍归主人；不得用审计结果输出视觉通过。审计不读取自己生成的 acceptance 来自证 | `node scripts/experiments/interaction-study.ts verify --criterion F9 --run var/local-driver/anima-interaction-v1` | state.json、reviews/delivery-audit.json、原始证据；T8 |
| F10 | AUTO | 第一项实验提交前已禁用鱼的 ComfyUI 权限并等旧队列结束；整个采样期保持资源闸；最后作业闭合后恢复原权限，不能只证明开始时队列为空 | `node scripts/experiments/interaction-study.ts verify --criterion F10 --run var/local-driver/anima-interaction-v1` | resource-lease.json、PID/启动与队列时间线；G0/G1 |

F3 的「全部结果」允许已真实执行的单任务 execution_error，但如果某主线机制根本不能运行、某整组被阻塞或未产出可评估图，必须报告研究阻塞，不自动视作整组已测完。调整必测组需主人批准修改 spec 与本清单。

停滞判据：同一 AUTO 项连续 3 轮验证没有实质变化，或同环境错误连续 2 次，即停下记录该 F、证据、原因与恢复下一步；不以 blocked 代替 complete。`delivered_awaiting_user_review` 的等待轮次不计停滞。AUTO 全绿可报告样例交付完成，F8 未确认前不可宣告图像或整体视觉验收完成。

## 10. 任务与依赖图

接口先行：manifest 行至少包含 `job_id/case_id/pair/action/framing/seed/stage/method/weights/parent/asset_hashes/graph_hash/expected_visibility/output_contract/comparison_folders`；结果行包含原 job_id、prompt_id、终态/时间/输出 hash/错误分类、generation_info 路径；delivery 行包含目标目录、原图/参数/README hash 与 job/复用映射。主人反馈绑定交付 revision，未反馈不填视觉字段。

| 任务 | 独立交付物与验收 | 上游具体产物及理由 |
| --- | --- | --- |
| G0a 生产热开关实现 | `drawEnabled` 布尔/hot/缺省 true，getter 沿 runtime→FishOptions→ToolPackageDeps→draw 传递，执行入口与 onSubmitted 回调都校验；配置模板、受控字段工具说明和拒绝文案同步。只改热开关必要文件，不改 ComfyUI 请求器/图模板，不新增测试 | 当前新增专项授权与 §2 热开关接口契约；与 G0r/G0p 并行，无远端操作 |
| G0r 热租约辅助改写 | `interaction-resource.ts` 的 preflight/off/status/restore 仅读写受控热键、记录原键/部署版本/PID、验证闭合作业证明；不 spawn/kill 鱼进程、不 deploy、不写 .env。只读 ps/lsof/pgrep/git 探针不属于启停鱼。旧重启版不进入实际执行 | §2 热开关契约；实现可与 G0a 并行，生产操作必须等 G0c |
| G0p 上线前只读取证 | 生产 HEAD/干净状态、当前PID/启动方式、配置原键状态、依赖及ref-cleanup就绪事实、远端main/祖先关系风险；输出 `checks/draw-hot-switch/production-preflight.json`，不改远端 | 现有 home-connect/ops 入口与基线；不进入 T0 模型/节点环境准备 |
| G0b 本地独立验证 | 审查 G0a 实文件、既有 npm test 与 prompts 通过、精确允许变更/hash及默认/热值/提交前复核接线记录；不新增测试或测试夹具，不接QQ/真实GPU | G0a 文件ready 即派，不等待 G0r；与真实生产部署分开 |
| G0i 纯热开关候选构建 | 基于生产 9c55e8d 的独立 detached worktree，仅应用 HEAD→工作树的 10 文件热补丁；AGENTS.md 不整文件复制，draw/TOOL.md 保持生产基线；主工作树/历史/暂存区保留，证据为 candidate-preparation.json | G0b 通过 + git-scope-analysis.json 证明与 14d29a1 可分；只准备候选，不提交或运行验证 |
| G0ib 实际候选独立回归 | 在 G0i 的实际候选树运行既有 npm test/prompts，核对 10 文件 hash/补丁、未含 14d29a1、实验及计划文件；验证对应将提交的同一内容 | G0i 候选 ready；不新增测试/fixture，不修改失败项，修复另派 |
| G0r-v 热租约合同核验 | 只读核对原键/事务状态/热值与唯一PID及版本闸/新鲜闭合证明/恢复键级保真；发现缺陷不自行修复，证据为 resource-contract-validation.json | G0r 脚本 ready，与 G0i/G0ib 并行；不真实 off/restore |
| G0c 专项提交并上线一次 | 只提交 G0ib 已验证的候选，普通快进 push；不夹带 14d29a1/实验文件，推送前远端仍须为基线；一次正常 deploy，真实新PID/新增日志横幅与部署版本一致；失败不重复部署掩盖 | G0ib 当前候选通过 + G0p 证据/即时生产健康与唯一进程核实；不自动重写或清理本地主 main |
| G0 关闭鱼的管线使用权 | 热开关实现/既有回归/专项提交及一次部署证据；resource-lease.json：原键状态、drawEnabled=false 的实际热值与接线、运行PID、旧作业结束与互斥闸；未确认不放行 | G0c 部署证据 + G0r-v 合同通过；真实 G0 单独派发，不和试验抢跑 |
| T0 环境与资产核实 | T0a 已交 preflight 的真实 8 实体、MHR/键形/core 差异、lab 准备；T0b 激活纯净 RS+T4/Crop、独立实例、真实 object_info，缺项不冒称 ready | G0 已关闭提交入口；T0a 与 T1 并行；T0b 消费库存及 T4，不能复用生产 52 层 remap RS |
| T1 冻结实验契约 | spec.json：40 主case、单人case、W权重矩阵、stage/method/任务生成与复用规则；预算≤808。采用紧凑声明式契约，808 个实际 job 的完整枚举/parent 解析由 T3 确定性展开到 manifest.json，不在契约阶段手写长任务表 | G0 资源闸；消费本方案和现有角色事实源，不依赖 GPU；F1 最终完整清单/实体 hash 要求不变 |
| T2 理想结构夹具 | T2a 冻结结构生成源/几何，T2b 实际 CPU 渲染 8 世界/40 投影/4单人、机械核文件与坐标，不判图；输出对接 §8.1 | T2a 依 T1+固定 RS schema；T2b 依 T2a 与 T0a 的真实 MHR/渲染依赖，不把服务器启动设为本地 CPU 渲染假屏障 |
| T3 图构建与执行器 | T3a manifest/图构建与 T3b 持久化 runner 并行实现；真实绑定、协议核验与冒烟另派，不增加热开关清单外生产改动 | 代码依 T1/T4 冻结接口；实际 build/运行依 T0 实体/隔离节点、T2渲染输入与持续资源闸，未 ready 不生成假图 |
| T4 RS 局部采样扩展 | 先静态核对 detailer/wrapper 复用边界，记录选型，再产出隔离 patch、坐标胶水节点和 R1/R2/R3 图；不捆绑真实GPU运行 | G0 已关闭；实现消费 §2 已冻结的 mask/阶段接口及已核实 RS/core/Crop 快照，可与 T0/T1 并行，不必等待实体权重；与 T3 对接和实际运行仍须 T0/T1 的真实环境/实例与任务契约 |
| T5 初稿/边界/权重真实运行 | W-S机械冒烟、姿态参数对照、B/H/W 的全部图与generation_info；未挑seed/权重 | T2 结构资产；T3 runner/graphs；T0 机械兼容与主人资源许可 |
| T6 修复与收尾真实运行 | R/P 全部图、父子关系、机械跳过记录与时长；预定策略不由助手校准选优 | T4 patch/图；T5 B2 父图和原始证据；资源窗口持续有效 |
| G1 恢复鱼的原使用权 | 队列/作业已闭合，原子恢复 drawEnabled 原键状态、PID不变与恢复时间入 resource-lease；原本关闭则不擅自开启 | T5/T6 全部 GPU 作业已闭合，或失败退出时确认无在途/未知任务；不依赖主人人眼验收 |
| T7 全量拉回与决策说明 | §7 指定 Downloads 子文件夹、全部 PNG/控制图/参数、每组 README、delivery.json及机械统计；不含助手评分 | T5/T6 原图与参数；决策说明消费 T1 契约，不替主人输出结论 |
| T8 独立交付完整性审计 | 一次只核文件/清单/hash/README 的审计；F1–F7/F10与当前版本对应，F8保持用户专属 | T7 当前交付版、G1 恢复证据；缺件在授权范围内补回，不对图像作结论 |

依赖简图：`G0a/G0r/G0p 并行`，`G0a → G0b → G0i → G0ib`，`G0r → G0r-v`，`G0ib+G0p → G0c`，`G0c+G0r-v → G0`；随后 `G0 → T0a,T1,T4实现`，`T1 → T2a/T3a/T3b`，`T0a+T4 → T0b`，`T2a+T0a → T2b`，`T0b+T2b+T3a/T3b → 真实绑定/协议与冒烟`；`T2+T3+资源闸持续有效 → T5`；`T4对接+T5 → T6`；`T5+T6 → G1/T7`；`G1+T7 → T8 → delivered_awaiting_user_review`。代码与实际运行分开，ready 产物即放行后继，不把权重/服务器或其他并行任务当纯实现屏障；F8 不阻塞回收，只有主人解除视觉验收等待。任何提前退出都进入 G1 的安全收尾判断。

所有子任务派发必须后台，完整提供任务/路径/验收/停止条件；单次按 30 分钟组织，二开与真实验证分别派发。并发模式下每次产物 ready 立即释放满足依赖的任务，不做批次屏障；GPU runner 始终只有一个。超过单次预算先交中间产物并拆小，不放任无限调参。

## 11. 执行模式、审阅与后续

主人最初选择 subagent 并发驱动；在发现剩余主线已收敛为强依赖串行后，主人改为主会话串行执行，后续不再派发新的实现/验证 subagent。已在途的 graph 修复任务仅安全收口并交回，不得与主会话并行写同一路径：

- subagent 并发驱动：主会话调度、整合与汇报，T0/T1 及 ready 的独立产物并行；更快但有接口整合/冲突成本。优先不重叠写路径；未经 commit 授权不使用要求自动提交的 worktree 流程。
- 主会话串行执行：本会话逐任务 inline，不派发执行 subagent；上下文连续，但受会话上下文和轮次预算限制。方案 review 与最终文件完整性审计是明确要求的例外，它们不承担任何人眼验收。

写完本方案立即后台派发一次只读独立 review；本会话根据意见修订，不自动重复 review。方案执行结束按全局要求派发一次独立交付审计，严格限定为机械完整性：不看图选优、不评分、不替主人签收；缺文件/hash不符等在授权范围修复，视觉验收永久保留给主人。

主人看完并反馈后再决定：每个角色合适权重、保留哪些 preset、结构输入自动化是否值得、是否扩种/反向背负/左右互换、是否尝试人物组后背景分支。3.8B 另立兼容研究，先通用 masked img2img/区域模块，再 2B 定结构→V8 转画风，最后评估学习式控制适配器；不将 28→52 层 LoRA remap 当作姿态适配器已兼容。

## 12. 首轮独立方案 review 处理记录

2026-11-11 已完成一次后台只读独立 review；本会话 inline 修订，未再次自动 review。该 review 是方案审查，不是图像验收，也不是执行授权。

- 采纳：删除助手视觉评分/首评/自动选优，增加主人专属 F8、Downloads 全量样例/README、delivery.json 与正常等待状态；机械 `verify --auto` 和最终 `--all` 分离。
- 采纳：B2 明确为角色轮廓 union 而非新尾巴部件槽；外部 MASK 清空 body_parts；十指控制存在输入表达限制，不能虚构节点能力。
- 采纳：准确冻结 Crop 外部包/节点、core/RS 接线、generation_info、全部路由参数、stage seed、独立 output/temp/user 目录、超时与不明提交处理；2B 使用 core 全局 LoRA loader 而非未冻结的 remap 包。
- 调整采纳：保留姿态与 denoise 参数对照作为交给主人看的物料，主线参数预先固定，不让助手看校准图挑选；因此不新增中途视觉门，也不删除用户希望探索的参数空间。
- 未采纳「normal 模式同文件必然系数翻倍」：再次核对 `shared_lora.py:78–80` 有共享 hook 去重；QG 同文件相同权重共享参数更新，与全局串接两次不同，按 audit 记录实际路径，不作不成立的源码结论。
- T4 先记录现成复用边界：现有 detailer 的单裁剪单角色修复不等于双方接触组联合路由；若要改成联合也需显式保留双方区域。OUTER_SAMPLE 已接收 latent/denoise_mask 可复用，但上游公开节点仍缺显式局部输入。静态选型后采取最小 patch，不从头重写推理器。
- 主人新增权重要求后补 W-S/W-RS/W-G，完整物料和图像集合按新预算≤808冻结；这是后续授权时要明确的数量上限，不宣称已执行或已验证。

方案授权时只有本 Markdown 文档被新增。既有 `npm test` 在方案编写轮运行结果为 174/174 通过；不把既有软件测试通过当成实验图像验收。该时点没有安装节点、创建实验夹具、修改生产配置、启动 GPU 作业或把任何生成图写入 Downloads；后续实际状态见 §13。

## 13. 执行检查点

- 本轮预算收尾仅保存检查点，不主动暂停 goal、不新增派发、不声称完成。C卷 stage 持久化与8源文件 hash 已验证；实际首4执行由 `ses_e3526d71fffeJgMI5bnO5d4Vni` 在后台，完整 v3 的 C镜像由 `ses_e35095ce9ffewH4cNqrdrjqtXB` 在后台，尚未收到这两项本轮收口证据，不能把旧 D卷的0 POST或已派发任务当成当前采样计数。下一步先消费 `checks/w-s-smoke-c-volume-execution.json` 与 `checks/full-executable-c-staging.json` 实文件：前者确认所有 accepted/open 的原ID、worker退出、原图/hash和新鲜队列；无未知且首4闭合后才另派完整节点实例切换、同job/graph原结果吸收及后续运行。任何 unknown 只回查原ID，不重POST、不重启其在途实例。G0仍关闭，G1未执行；尚无实际 Downloads交付或F8验收，不以预算边界提前恢复鱼的权限造成争抢。
- 首4 C卷运行收口已实际核对：`checks/w-s-smoke-c-volume-execution.json` 记录 4 次真实 POST、4 次 accepted/采样、4/4 success、unknown/open/unresolved/timeout 均为 0，4 个 PNG 均三方 hash 一致且 1024×768；lab queue 0/0、worker 全退出、生产鱼/Comfy/PID全程仅读。job1 日志命名覆盖与 PIL bytes 探针异常均原样记录，不影响数据面 hash/state/history；首4结果后续吸收，不重POST、不扩808。
- 首4已闭合后，完整节点激活任务已派 `ses_e34db7425ffeE7BD6thAUbtOBz`：只切换独立 lab 8189 到完整节点包并核 object_info/queue，不创建 permit/state、不POST、不采样；生产 gate/队列前后必须保持不变。激活通过后再派全量运行，失败则保留精确错误并停在安全状态。
- 全量首批实际执行已收口到 `checks/full-execution-batch-1.json`：首4吸收有效；新增 345 次 POST 尝试中 344 次因 `RSMultiCharacterPrompt` 缺 `webp_quality/character3_kind/character6_enable` 等必填字段而 HTTP 400，1 次虽 accepted 但实际图片在 node 6、合同写 node 14，故新增可用图为 0；其余 288 级联机械跳过、259 pending。生产 gate/队列无漂移，未继续旧 run。该证据同时暴露 runner 的 `max-new-jobs` 只约束 accepted、不约束 4xx POST 尝试的安全缺陷。
- 用户恢复后并行派出两个精确修复：`ses_e347c178dffe03cWYPysLwZ5PB` 只读取真实 8189 `/object_info` 并生成新 executable revision，修正 RS 各节点必填 schema 和实际输出合同，不改旧 v3/旧运行；`ses_e347c1780ffeB2flnMvKnWctHd` 只修 runner 的 POST attempt 预算闸，保证4xx后fail-closed且unknown不重POST，不运行 GPU。修复完成前不再提交全量任务；修复后必须先单 RS smoke 证明 accepted 且回收到正确 PNG，再批跑。
- 已通过既有 home-connect `wsl-relay` 对当前完整 lab PID32176/8189 做只读 GET，实证 `object_info` HTTP200、原始 UTF-8 2,306,502 bytes、SHA-256 `5c0b85188165992371ba542832ab9ae96e5838cd3d2c5caa7292f647a5f5e932`，queue running/pending 均空；完整选定 Schema 已落 `checks/object-info-schema-20261112.json`。真实 Prompt 节点要求 character1–10 的 enable/kind，Sampler 必填 `webp_quality`（default90），R3 节点实际 required/outputs 和 SaveImage/StudyMetadata 的 output_node 定义均已取得；不再依据旧摘要或错误文本猜字段。

- 当前续跑：C 盘准备已 READY，主会话已读 `checks/w-s-smoke-c-volume-staging.json`：新 owned `C:/Users/<win-user>/yugang-anima-interaction-run-20261111-e970eb55/anima-interaction-v1/stages/w-s-smoke` 的 write/flush/fsync/replace/回读通过，8 文件原字节 hash 全一致，worker-plan 4 项。沿 `ses_e3526d71fffeJgMI5bnO5d4Vni` 已另派真实首4项，每项 fresh 热闸/生产空队列/新 nonce/max-new-jobs=1，结果回收 `run-c/`；不复用旧许可、不取消 fsync。此运行任务已放行，当前实际 POST/采样计数须读其新 state/history/收口记录，不能沿用此前 D 失败的 0 当作永久状态；G1 未执行。
- 此前 D 卷真实结果：首轮 worker 初始化 state 时 `os.fsync` 报 EBADF，发生在读取许可/队列/生成client_id/POST之前。主会话已读 `checks/w-s-smoke-execution.json`：该轮 0 POST、0 GPU、无 prompt_id；旧worker32860已退出、lab8440队列0/0，后3项未启动，无不明或accepted作业。D卷 FlushFileBuffers=433/C卷成功是真实环境事实，过滤驱动/EDR或损坏原因均未确证。D关键账本分支停重试、旧现场保留；当前主动走已验证 C 替代，若替代也不可用则无在途前提下安全G1收尾，不把未执行整组称完成。
- 跨机器 v3 已交并经真实数据核验：`revisions/interaction-executable-v3/manifest.json` SHA `09c4e7e9c0f6cf9da0e445a24077239932c4a681c5663323c80dcf7a193f98b1`，896=808new+88reuse；1712处文件型输入定位改为相对 by-hash，162个真文件复用，job/graph/seed/模型/条件字节不变。PG8实际参数及首4 graph 与原stage逐一一致，旧v2/输入不变。沿 `ses_e35095ce9ffewH4cNqrdrjqtXB` 另派只文件镜像到同C基础根下新 `revisions/interaction-executable-v3`，不碰运行中的stage、不POST/签许可/复制未闭合状态，不发布 current-revision。
- 完整节点包已就绪未激活：主会话已读 `checks/full-node-package-preparation.json`，新 `D:/yugang-anima-interaction-lab/packages/study-custom-nodes-v2` 共493文件/38642955字节，纯净RS721d+T4、Crop6005efc、双glue/Falloff、metadata当前版，关键hash一致，无生产52层remap，所需依赖现成、无pip/新权重。首4任务闭合之前不切换或重启lab8440；完成后另派只激活此实验包根并核实际注册。
- 权重许可窄取证已消费：固定 pose README 引上游非商业许可及 LFS oid 四方一致，clip/VAE随选定checkpoint的字节溯源已核；其他许可仍 not_asserted，不作用户法律承诺。原 `weight-license-evidence.json#/nothingInFlight` 的 `isolatedLabInstancePid=null/stillNotStarted=true/port8189 free` 没有实时探针支撑，且与已读 D3 和 C staging 的真实lab8440/API证据冲突，这几项不采信为运行状态或启停依据；原文保留，许可文本证据与错误的全局状态声明分开使用。
- T3d 已交 `revisions/interaction-bound-v2`，主会话已读bound-revision-build.json：896行/808图、R200均有真图、真实输入hash/target匹配、4WS图hash与原stage一致，manifest SHA `a92fe6b930e8000de3f643d4f8a00f9926c1c6138590d3dccbaece5fa5692b9a`。该派发越过发现缺陷应停的边界，自修一处pose_grid权重键后重构；保留在授权实验脚本范围内的修复并如实记录，不将其自报当独立验证。`ses_e35095ce9ffewH4cNqrdrjqtXB` 已派只做跨机器物料绑定/核真实8PG参数，产新executable revision，不改实现、不GPU、不发布指针、不吸收未闭合WS。
- 统一入口接线已交：243行、SHA `a3c958afb2b0034ee82a2275c4a719960dfc41897aedb43257ca1edfe01f9e9b`，verify真实导出可由--help走通；consumer current-revision真实目录/manifestSHA检查已实现但尚无真实指针，未跑AUTO/未写acceptance。权重许可缺口由原T0资产会话另作8分钟窄取证，保持未知为未知，不修改已冻结preflight或阻已授权私人研究。
- 此前首样例放行：D3 已实证闭合，新的自有 lab PID8440/8189、folder_paths 来自lab、custom roots仅lab、生产 `python313._pth` 未改，首批禁用全部custom nodes；9core/5模型别名命中。首4物料已在Windows独占stage暂存且8文件双端SHA相同，真实worker-plan通过。已沿 `ses_e3526d71fffeJgMI5bnO5d4Vni` 放行原计划4项真实GPU运行，每项fresh Mac gate/生产空队列→新permit→max-new-jobs1；该轮尚未收到实际prompt_id/history，不把派发算成已出图，后续D卷失败结果见上方。G1未执行，不为安装后续节点重启在途core。
- 证据勘误：`environment-isolation-fix.json` 第58行 seedCorrection 的 `w-s-...600008`/0.6–0.9说法错误。主会话直接读取实际stage manifest并算SHA `e2a52de46fbf7fadeecb5eff24dfb1a7f4851fd40bcc1362d98eec90a202d74c`：四角色各一项，全部20261111/0.8，job_id为 `WS__SOLO-{角色}__20261111__w0.8`，stage_seed依次396859045/2391010264/2389655430/2241271482；Windows暂存也独立核实相同。该错误段不作为提交依据，旧证据保留，D3模块/API隔离证明与此错误任务描述分开处理。
- T2d 已真实生成32case/128PNG的repair-v2，32秒exit0、真实像素/来源/hash核验无失败，索引 SHA `6ef479fd4a209a76207032c209b84e3cc35cc4c7d1b246a343ee2f0eb6766f63`；旧416PNG/结构索引未变，native gray不冒充运行噪声mask。已立即沿T3c会话派新独占绑定revision构建/核验（不改源码、不GPU、不覆盖旧draft/首WS），另由 `ses_e351bce54ffeMiZLXd0G8W3swf` 仅准备完整实验节点包文件、不动当前server。
- T7a归档模块与T3v验收模块均已交代码/合同，未实际全量交付或AUTO验收；真实统一入口已接archive，verify及current-revision消费接线由 `ses_e35121c24ffela4Um6sPso96GV` 单独窄实现，不改构图库/运行物料。完整节点的实际注册、修复crop真实验证、全量采样/归档/G1/T8/F8都尚未完成。
- 此前入口取证（D3 后续已按上方当前记录闭合）：窄 core 取证确认 T0b 残留的 lab PID41856 在8189真实提供 API，9 core类/5模型枚举可用、隔离队列0/0，未重复启动。但新增日志出现生产 custom_nodes 路径（D3），不能用「W-S预计无影响」跳过隔离合同；已沿 `ses_e365fe3edffdOglvJJCLqNatMx` 另派3–5分钟窄修正，仅可停止/重启自有lab、明确lab模块路径与自定义根、禁写bytecode，可首批禁用全部custom nodes。生产8188/PID36932与鱼27230不动；D3闭合后直接首4WS，不增无关审查或等待R。
- T3c 已交代码修正，主会话已 grep 实文件确认 R3 IMAGE直接Stitch、R内部768与主输出1024×768分离、输入路径转run-root相对及新Falloff接线。producer dry-run可构608非R图、R200行在repair-v2缺失时明确blocked；旧896行/808图draft和首4WS bytes未变，仍不能称完整F1或F4通过。T2c 局部域生成源已交、32case dry-run无失败，已立即另派 T2d `ses_e352b5859ffeQduOwNRkNSFXE0` 真正CPU生成/机械核验，旧416PNG不改。新repair索引 ready 后再构建实际运行revision，不重写旧draft。
- T4c 已交 `YugangRepairMaskFalloff` 三文件，主会话已读真实接口说明并立即通知 T3c 接线：crop 768 对应61px非零环、uniform=gray>0、core⊆support，否则明确拒绝；节点源码 SHA `0ee5924c36bdb5ec802d20165a390bdab0c8f4e7be145830b3e47ff4f91cbb54`。仅静态/py_compile 通过，本机无 torch，尚未用真实crop输入运行；不能据此认定 F4 通过。原坐标胶水/RS patch/生产文件未改，不把此 R 路实现当作首4个W-S的前置。
- 此前构建整合：T3a 已实际构建 896 行 draft manifest（808 new+88 reuse）/808 图及首4个 W-S 子清单，主会话已读 README/子清单；该取证时仍未 POST，不把编译通过当运行通过。T2b 已真实 CPU 渲染44case/416PNG、164秒、文件/解码/hash/owner/权威box机械核验0失败；原索引/416PNG全部保留，B/H/W条件可消费，R局部域问题单列。
- 主会话亲读 R 构图源码发现真实接口缺陷：R3 IMAGE 被重复 VAEDecode、Stitch 主输出1024×768却期望768²、结构 input path 错用repo-root相对名。另 T2b 证明旧R support为全身union而非局部、native环并不能证明crop8%。已分别派 T2c `ses_e3542938dfferJNamm9d76TazN` 只实现局部域源，T4c `ses_e35429371ffelBwB5yN5PgPcDW` 只实现crop Falloff节点，T3c沿 `ses_e35a215adffeaoy68Y0vHL1ikS` 修接口与接线；真实生成/组合验证另派，旧draft图不覆盖，不阻首4WS。
- T0b 到收口时限仍无 activation-status 文件。一次只读运行元数据诊断确认21:04仍有真实工具活动，因此未称挂死；但任务范围未按时收口，主会话已明确 interrupt（返回true并收到cancelled），未暂停goal。改由已熟悉生产资源闸的 `ses_e365fe3edffdOglvJJCLqNatMx` 在5分钟窄任务中仅盘点并启动lab core8189：可用 `--disable-all-custom-nodes`、只读现有embedded依赖、不装RS/Crop/KJ，独立进程/目录并交真实PID/API/命令。原任务可能残留进程必须先辨别，不盲杀/重复启动，生产8188与鱼均不动。
- T7a/T3v 已通知当前draft与新R接口边界，不把CPU控制图当采样图、不用旧全身域/Falloff缺项输出F4通过。当前扩散采样仍0；G0保持disabled，首批每次真实fresh Mac gate/生产空队列→新permit→max-new-jobs=1，未闭合任务不重复POST，G1尚未执行。

- 2026-11-11：收到并发驱动执行授权，范围如 §1。G0 尚未完成；先分别准备资源闸辅助与只读生产连接/生命周期核实，二者 ready 后单独执行资源禁用与真实核验。T0–T8 尚未开始，GPU 提交数 0。
- G0 前置已后台并发派发：资源租约辅助实现由 `ses_e365fe3edffebPiSs5M4fmVdqU` 承担，仅写 `scripts/experiments/interaction-resource.ts`，不操作远端；生产连接/生命周期只读核实由 `ses_e365fe3edffdOglvJJCLqNatMx` 承担，不改文件、不重启。实现与真实运行核验分离；等待这两项结果期间不放行 T0–T8。
- 生产只读核实已返回：Mac 可经既有中继到达，根 `~/yugang`，Node v26.0.0，核实时鱼 PID 8066、`var/up.pid` 一致，日志 `var/fish-console.log`；无鱼本体 launchd/cron 自动拉起。`COMFYUI_URL` 非空，鱼仍有提交权；核实时队列 0/0 不能替代实际 G0 时重查。未停止或启动鱼。
- 本轮曾因预算暂停，主人现已恢复目标，并明确「可以走中继」。连接判断修正：Windows 原生 SSH 的 LAN 要求不等于 WSL 中继不可用；另由 `ses_e3654cfe3ffe4OGCEvdSfvo1zd` 只读核实既有 WSL 中继及其 Windows 访问通道，不提前进入 T0、不查 GPU/模型、不改服务。资源辅助实现继续原派发，G0 尚未完成，GPU 提交仍为 0。
- WSL 中继核实已完成：`wsl-relay --check` 可达，`/mnt/d/ComfyUI-Anima` 存在，Windows PowerShell 绝对路径互操作实跑成功；无需新隧道或系统配置变更。Windows 目录不在 WSL PATH，须使用绝对路径。只读核实不等于 G0 已关闭，也未进入环境安装。
- 主人在中继传输确认中要求「基础用个1024*768，放大走个1.2倍」「最后几次验收效果的时候再跑高分图」；已按 §3.2/§5 下调本轮画布与局部修复规格。不做全量 2×/3× 放大，≤808 次采样上限不变，同一原图远程只回收一次，Downloads 多决策目录在本地复制；约 1MB/图是用户经验估计，实际逐文件统计字节数，不能写成实测或大小保证。高分验证不在本轮自动启动。
- 为后续 F6/F7 补齐操作前保护基线，后台 `ses_e364ba728ffe1JWuY3sfC5XFw7` 仅机械记录既有 Downloads 文件与受保护生产源码的路径/字节/hash，写 `checks/pre-existing-downloads.json` 和 `checks/pre-existing-source.json`；不改既有物料、不看图判定、不接远端、不开始后继实验。资源闸仍等待原辅助实现，未以基线记录冒充 G0 完成。
- 资源辅助首版已返回，静态检查发现旧日志横幅可能误认新启动、生命周期过程中未先持久化状态等问题；已向原实现会话派发一次仅修该文件的有界安全修正，真实生产执行仍分开。主人随后认可「用COMFYUI_URL控制也很合理」：继续复用现成启动入口，不新增热配置、不改生产 draw 代码，不把 G0 扩为通用资源管理系统。当前尚未执行关闭重启，GPU 提交 0。
- 后续指令覆盖上述旧选择：主人明确要求热生效，并在提问工具选择「恢复、实现并上线」，goal 已显式恢复。按 §1/§2 的新契约实现 drawEnabled、单独验证后专项提交/部署一次，再热关闭执行 G0；停止继续完善旧空 URL 重启租约。已有物料保护基线已返回：Downloads 298 文件、273500179 字节，零错误/变化；源码基线 290 个受保护跟踪文件，旧基线保留，不因新授权覆写。为热开关另存精确允许变更/提交/hash 证据。此时生产权限尚未关闭，实验提交仍 0。
- 热开关授权后的无前置任务已并发派发：G0a 生产最小实现 `ses_e363c53dcffe3tYlzVrX17utmv`；G0r 沿用资源辅助会话 `ses_e365fe3edffebPiSs5M4fmVdqU` 改写为无重启热租约，停止旧方式修补；G0p 沿用生产只读会话 `ses_e365fe3edffdOglvJJCLqNatMx` 刷新上线前安全事实。G0a ready 后立即派 G0b，不等待辅助实现；上线与真实关权限仍分开，不提前进入 T0/T1。
- 本轮预算收尾检查点：上述三个后台派发尚未收到本轮完成回执，不能认定实现/安全核实通过；本会话只修订计划和授权记录，未 commit/push/deploy，未关闭鱼权限，实验提交仍 0。后续先接收并核对 G0a/G0r/G0p 原始交付，G0a ready 即独立执行 G0b；不得跳过当前版本回归和待部署提交范围审查直接上线。这是预算暂停，不是外部阻塞或实验完成。
- 暂停期间 G0a/G0r/G0p 回执均已到达：G0a 报告 10 个文件的本地热开关实现（未独立回归），G0r 报告 665 行无重启热租约脚本（未真实 off/restore），G0p 证据已落 `checks/draw-hot-switch/production-preflight.json`。G0r 回执中的「已上线」只指本地依赖源码已具备，不能作为生产已加载的证据。生产仍是 9c55e8d、鱼 PID 8066，原 drawEnabled 键缺省、URL 非空，G0 仍未执行。
- 上线范围事实：本地 main 的既有 14d29a1 只改 AGENTS.md 与 draw/TOOL.md，远端 main/生产尚不含它；不能把本次专项授权解释为允许一同推送或部署。保留既有历史和工作树，不擅自 reset/rebase/丢弃；上线前须有基于生产原版本的纯热开关候选及对应验证，不能整文件复制 AGENTS.md 时混入旧文案。正常部署前还要即时核实 60s/TTS 健康与唯一鱼进程，避免其自愈分支引入未授权操作。
- 主人再次显式恢复后，已立即派发 G0b 独立源码/既有回归核验 `ses_e3624c5aaffefSzWzuD6OY4TYm`；另由只读 `ses_e3624c59fffeIYv7WgoHQ4sG45` 分析纯专项提交隔离路径（不写 git、不上线）。资源闸尚未通过，不释放 T0/T1。goal 约束已同步新专项授权，不再保留旧的完全禁止提交/部署及双重启条款。
- G0b 与隔离分析已完成，主会话已读原始 JSON：本地既有测试 174/174、prompts 通过，10 文件热改动及辅助脚本的运行前后 hash 稳定；9 文件在生产基线与 14d29a1 相同，AGENTS.md 两类 hunk 不相交，纯热候选可构建。相关原证据为 local-validation.json、npm-test.log、prompts.log、git-scope-analysis.json；未将这些本地证据冒称生产已上线。
- 主人指出普通预算提示不应导致反复人工恢复。执行策略纠正：普通轮次/上下文收尾仅存检查点、压缩并结束本轮，保持 goal active；等待后台任务不设 paused。只在主人明确叫停、真实阻塞或 AUTO 交付后等待 F8 时停下，不把内部调度边界升级为新授权门。
- 最新显式恢复后，G0i `ses_e36097c1fffeqk6GV3VZaEINCJ` 已后台构建隔离候选，G0r-v `ses_e36097c1fffd7mijkHEOJcoRFF` 已后台核验热租约安全合同。G0i ready 即派实际候选独立回归，不等待无依赖的其他任务；G0 尚未关闭，GPU 提交仍为 0。
- G0p-h `ses_e365fe3edffdOglvJJCLqNatMx` 另行补齐部署依赖的实际只读健康证据：4399/health 与当前 voices 的部署等价端口探测，明确正常 deploy 是否会触发未授权服务自愈；不调用 deps/tts up/doctor 或任何修复。产物 deploy-dependencies-preflight.json 仅作近期预检，部署前仍须即时复核；不与 G0i/G0r-v 写路径重叠。
- G0p-h 原证据已返回并由主会话读取：17:42 的生产仍为 9c55e8d/干净主树/唯一鱼 8066，lock marker 相符；4399/health 实测 200，当前 9884/9887/9888 全部监听，按现有部署分支无需 npm install、docker 或 TTS 拉起。只读预检无停止项，不代替部署前即时复核。回执沿用的「14d29a1 裁定归用户」只是旧风险措辞；当前授权已明确排除它，按 G0i 纯候选路径处理，不增加一轮用户确认门。
- G0i 已完成并由主会话读取 candidate-preparation.json：候选为批准 TEMP 下 `yugang-hot-candidate-g0i-20261111-174055`，detached 于 9c55e8d；热补丁 SHA256 为 `90823bcc47d229e0812a613f271eb3030b7c8f70661707b7bc056d454d2a359c`，10 文件、48+/3-，AGENTS.md 只含热 hunk，draw/TOOL.md 保持生产 blob。主树 HEAD/暂存区/10 文件 hash 不变；没有 commit/push/部署。ready 后已立即派 G0ib `ses_e35fcd6d3ffe3ZriGxiVhe0pYO`，在该实际候选运行既有测试/prompts，不等租约审查。
- G0i 校准：生产基线本来就跟踪 scripts/experiments 中 4 个历史脚本，旧只读分析称目录不存在有误；正确约束为该树与基线一致、无本轮新增实验文件。候选的 `?? node_modules` 是已授权依赖 symlink，不应误删/暂存，专项提交必须显式只 add 10 文件。首次空补丁已被机械校验拦在建 worktree 前，遗留 TEMP 空文件保留；最终补丁/候选以以上稳定 hash 和独立回归为准，不取空补丁。
- 主人指出热开关不应因过度流程化耗费一下午，主会话已要求现有候选/租约核验立即收口，不新增审查轮次。G0ib 已 PASS，原证据 candidate-validation.json 已读取：实际候选 npm test 174/174（3480ms）、prompts 干净，候选和主树保护 hash 稳定。ready 后立即派 G0c `ses_e365fe3edffdOglvJJCLqNatMx` 专项提交、普通快进 push 与一次正常部署；不等待无依赖的租约审查，不提前执行 G0 off。此时尚未收到上线证据，不能声称已上线。
- 主人另行明确要求 AGENTS.md 增加 Git 命令规则：原主树已新增“Git 操作优先使用 git1；仅在 git1 不可用时回退使用 git”，由 `ses_e36097c1fffeqk6GV3VZaEINCJ` 只改该文档。已通知 G0c：此为独立授权的主树精确 delta，不修改已验证候选、不混入热开关专项提交；其余主树保护不变。后续手动 Git 操作遵守新规则，不为此改写现有部署脚本。
- G0r-v 已 PASS，resource-contract-validation.json 原证据已读取，未发现阻塞性安全缺陷，不再加审查或重构。真实 G0/G1 必须每次传完整 40-hex expectedCommit、消费 status JSON 的 gate.gateIntact（不能只看 exit 0）；off 文案不代替部署/PID/共享 loader 与 raw 键值证据。无关配置变动会使现辅助的整文件 hash 闸安全拒绝恢复，属于已记录的操作约束，不会覆盖其他配置；若真实出现再按保留现值的资源收尾处理，不预先扩成新功能。
- G0c 已回报专项 commit/push 完成：`5b1f4486bb09819e9641bcdce75cdad4c2b9dca9`，审计 branch `audit/draw-hot-switch-g0c-20261111`，唯一父 9c55e8d，不含 14d29a1/新 git1 文档 hunk。git 直推传输失败后用 git1 完成普通快进 push；18:05:14 远端 main 指向新提交。同一次标准部署已后台发起，部署前日志 offset 为 5060964；尚待完成通知后的唯一新PID/新增连接横幅与版本取证，不能先称已上线。已派原 G0c 会话继续收口该次部署，不重跑 deploy；真实 G0 off 与 GPU 仍未发生。
- 同次 G0c 已 RELEASED，主会话读取 hot-switch-release.json：生产干净 HEAD=5b1f448，唯一新 PID=27230，18:06:14 启动、18:06:15 在 offset 5060964 后新增日志中连接；10 文件与候选一致，配置原键仍 absent、.env hash 不变，一次部署无额外服务操作。已立即派原生产会话执行独立 G0 实际热关闭和旧队列排空，使用固定 SHA 的暂存 helper、完整 expectedCommit 与真实 gateIntact；该操作尚待回执，T0/T1 不抢跑、GPU 提交仍 0，不新增回归或审查轮次。
- G0 已通过，主会话读取实际 lease/raw-status/resource-gate-g0.json：18:14:11 原键 absent→false，PID27230不变；raw/shared loader均false、gateIntact九项全真，18:14:39旧队列0/0，双端租约SHA为5a35047441bfb69226130ce2f5dce074b8b1397bce22ef3c975bc2a175b69c52。热关闭保持到全部实验作业闭合后G1，不因交付前置准备提前恢复。已立即并行派T0 `ses_e35e10772ffeZixLe40oyEUSPh` 准备隔离2B环境、T1 `ses_e35e10763ffepeHDBExOacANgI` 冻结spec；GPU采样仍0。
- T0/T1 的实体绑定接口已统一：`preflight.json#/assets/` 下固定 `unet/clip/vae/lora_shared/lora_claude/pose_lllite/mhr_mesh/mhr_license` 逻辑键，T1 引用指针、T0 填真实路径/hash，T3 最终绑定；不以尚未核实的实体字段伪造 F1 通过。T4 本地隔离实现 `ses_e35dd8f86ffejIWwSTifvm8aI9` 已按冻结源码与 §2 并行启动，仅写实验 patch/胶水节点/接口说明，不接远端或执行 GPU；去掉实体权重准备对纯代码实现的假依赖，实际对接/采样依旧受 T0/T1 与资源闸约束。
- 主人指出 T1 长期 thinking，按其请求一次性核对运行元数据与产物：19:00 API 仍 running，无权限/表单等待，已有 assistant finish=error 后重试，spec/contracts 未产出且超过原30分钟预算。19:02:12 仅 interrupt 该 T1（返回 interrupted=true、随后不在 active map，收到 cancelled 回执），未暂停 goal 或其他两路。改由 `ses_e35b96a85ffeSi1MI8l3q1BIHP` 在10分钟内落精简声明式 spec，808任务展开交T3；矩阵/交付/用户视觉门不变，不重复全套方案设计。
- T1 接替已交 spec.json/contract，主会话已读实文件：40 主case+4单人、9组新增上限808、真实角色源 hash、8逻辑资产指针、阶段 seed 与复用规则完整；T4 已交 patch/胶水5文件，静态检查通过不冒称真实运行。立即派 T2a `ses_e35a215ceffedThbc0Aog9pgzA`、T3a `ses_e35a215adffeaoy68Y0vHL1ikS`、T3b `ses_e35a215adffdruLxIiI3AYYVTi` 并行落实现，不再等待实体准备作为代码屏障。
- T0a 已收口真实 preflight，8资产hash/2B与LoRA键形/MHR及lab事实齐全，在途0、采样0；主会话亲读 coreVersionDrift 后明确冻结实际core v0.44.0/2c75dc1b，RS仍纯净721d57ab+T4。T0b `ses_e359e7e7cffeSHDgZIgDb1UjbI` 已派激活隔离节点/实例，仅Windows直取公开代码，不经中继搬大源码/权重、不改生产；MHR真实本地blob与pose的rs_reference路径/TE keys=0已通知T2/T3。尚无GPU采样，不把实体库存核实当作服务器或图像已跑通。
- 最新主人显式恢复后，goal_status 确为 active、新窗口 0/180000；其17:42旧 Recent checkpoint 已过时，不得据此否认实际5b1f448上线和G0热关闭。当前以本计划/原始release与lease实证为准，不重做热开关回归或部署。主会话已指出T3a入口的根来源/ESM与成功build路径问题，要求原生产者修正，尚未核实修复落盘；真实runner输入接口已统一，优先编译原清单4个W-S首样例，不另造测试样本。
- T3b 已交双模式真实runner，但混入新增固定预期值 selftest/内存软件测试，已另派精准移除；现两文件hash分别为脚本 `0190d442204a415d6803e910c181906ac10a3e166a68a11e4cac3a693f5c9ce4`、合同 `4eb289a6af5803b68877243c648d2dd899c3ed12656ebb1d6b1678fa2ee61dd1`，真实解析/许可/提交/恢复逻辑未改。仅 py_compile/已有 CLI help 通过，不冒称真实网络或采样已验证。
- T2a 已交可执行冻结几何（8世界/40投影/4单人）及 unrendered 索引，主会话已读README；T2b `ses_e355a2d6bffetEc5hMFbG7jgZm` 已立即派真实 CPU 渲染/文件与数值核验，不改源、不评分。R域 support 是否真局部、native61px环经resize不能自称crop8%等数值风险单列核查，不以core空伪称接触在画外，不阻初采样pose/owner落盘。
- 无依赖的交付代码已并行：T7a `ses_e355dbfcbffeViEDqzeTAbzRwr` 仅实现 `interaction-study-archive.ts`，T3v `ses_e3557f677ffeVvq54xrC2B6uq6` 仅实现 `interaction-study-verify.ts`；不实际交付、验收、改Downloads或生成假审计。独立T8仍只在真实全量交付与G1后执行一次。首图仍0，鱼仍禁用，后续实例/首图ready即放行真实验证。

## 15. 2026-11-12 精简审阅：从铺满矩阵改为回答剩余问题

**本节核心18项已经主人通过提问工具明确采纳“继续18项核心诊断”；14个条件项仍未放行，其余旧任务延期。** 原冻结manifest继续保留，执行使用独占精简profile，不重开原全量worker。新场景28项已执行并回收，与本节分账；不把“剩余24次采样”误写为24个不同世界场景。

### 15.1 结论和当前账目

808可以由各维度组合算出，但不是证明这些技术可用所必需的最小数量，也不是通过统计功效分析得到的样本量。它更接近广覆盖benchmark；在机制收益未确认前同时展开动作、景别、权重和多种子，投入顺序不合理。不能为对齐旧矩阵而继续消耗GPU。

现场复核：旧研究已完成198个不同任务（179 B、4 W-S、15 R），另有已如实计账的1次成功B0重复，实际已花199次。原896行含88个零采样复用引用；因此698个pending行不等于698次未跑采样，真正未跑new项是610。既有198项及全部失败证据保留，不删除，也不重复采样。

建议旧研究下一阶段仅追加**18次核心诊断**；另有**至多14次条件项，默认0，必须由主人看图后的明确问题触发并单独放行**。其余578个未跑new项不作为本轮必要完成条件的建议范围。采纳前仍不将这些历史项标成已完成或偷偷删除。

### 15.2 核心18项及数量推导

只回答主人已反馈、而目前还没有实验证据区分的“角色特征为何丢失”问题。固定旧场景、同seed、同控制图，不把新28场景再乘进权重维度。场景选用旧方案已预先指定的两个机制代表：DC-HUG-M（两份不同LoRA文件）与QG-CARRY-M（同一文件中的两个角色概念）；不是助手看图选的好例子。

| 问题 | 保留的最小对照 | 新采样 |
|---|---|---:|
| 单角色自身对强度的响应 | 4角色各补0.6与1.0，复用同seed已完成0.8；不先跑第二seed | 4×2=8 |
| 双人是否相互压制 | 每对只取一个M场景；以已有(0.8,0.8)为中心，一次只改一方为0.6或1.0，形成十字而非3×3九宫格 | 2对×4=8 |
| 区域/全局加载家族有何差别 | 每对仅补默认0.8的全局版本，与已有区域0.8基线配对；QG只加载共享文件一次，不伪造两个独立全局系数 | 2对×1=2 |
| 合计 | 复用4张单人基线和2张B2双人基线；不为本阶段再造父图 | **18** |

这是诊断而非完整响应面：十字设计不能估计所有A×B交互，单seed不能给出跨seed稳定性结论；全局/区域家族还改变提示编码与路由，不伪称严格单因素。若需要这些结论，应在收益成立后再针对问题扩展，而不是预先把所有组合跑满。

机器核对已完成：16个权重对照与既有基线具有相同stage_seed、条件图hash及其余推理图；只允许强度字段、输出标签和按相同hash证明等价的上传文件名不同。已有6张基线均为success，18个候选均未执行，父依赖已ready。

### 15.3 条件项：不自动把14次全部跑完

| 主人明确指出的问题 | 定向对照 | 最多新增 |
|---|---|---:|
| 固定0.45修复过弱/改坏，需要确认强度 | 两个既有代表场景的R3，各补0.30/0.60；只用原父图、原0.8权重 | 4 |
| 已看到R机制收益，需确认不是单seed偶然 | 两代表场景在第二seed比较R1/R3；第二seed的B2父图也已存在 | 4 |
| 输入姿态已核对正确，生成仍不随姿态 | 两代表场景仅比较0.5/0.8姿态强度，时段固定前70%；不扩完整时段网格 | 4 |
| 准备回生产质感pass，需排查共享文件重复串接 | 仅QG-CARRY-M做P1单文件一次/P2重复串接两项 | 2 |

其他低权重组合、更多动作/景别、第三seed、姿态全时段、完整P/W网格均不自动启动。若问题超出这14项的定义，先给出精确新增对照与成本，不将“有剩余额度”当作授权。

### 15.4 对各旧组的处置建议

- B剩余109项、H48项：不再默认补满；179张既有B图保留用于背景参照。
- R原200项：已有5场景×R1/R2/R3=15项，已证明真实接线；是否有画面收益仍由主人判断。停止剩余185项的无条件扩展，仅保留上表按问题触发的最多8项R。
- W原248项：已完成4张单人基线，建议追加18项定向诊断；双人默认基线直接复用B2，不把动作/景别/seed乘进去。
- pose_grid与P：只保留上表各4/2项条件入口；其余暂不跑。
- 新联合接触/镜头28项：独立预算、当前已跑完，不被本节折算或取消。

若核心18项获采纳，旧研究实际成本上界先收敛为199+18=217；若14项之后全部逐项放行，则是231，不是继续追808。历史重复仍占1次，不被精简抹掉。新28另账；对应两项研究合计分别为245或259次实际采样，并非这些数字已经全部发生。

### 15.5 可核查产物与执行前门禁

审阅清单：`var/local-driver/anima-interaction-v1/checks/pruning-review-selection.json`，包含18个准确source job、14个条件source job、6个可复用基线、源manifest/state SHA和逐项图差异核对；状态为`proposal_only_no_old_job_released`。机械复核命令：

```bash
python3 var/local-driver/anima-interaction-v1/checks/review-pruning.py
```

该命令只验证选择依据，不提交、不看图、不代表18项已执行或原F终态通过。原始manifest继续保持SHA `a07406fe9afe5c050bbe85742742b010bc317e1c9915840df0d8da61fda32e10`。

若主人采纳，先在独占执行profile中封存选择/复用/排除清单，再跑这18项；不能直接续跑旧全量worker。静态审阅还发现两个W-G源图的ModelPatchLoader名称使用斜杠，而当前Windows真实enum使用反斜杠：必须按同一个已核hash的资产做受控绑定并记录新graph SHA；不得绕过Schema，也不得覆盖旧图。其余未包含在新28局部Schema记录中的旧core节点也须在第一次POST前读取真实Schema。无成功任务重投、未知提交不重POST、单GPU串行、逐图回收、用户独占视觉验收、G0/G1共享窗口语义全部保持。

主人已经采纳核心18项，当前执行profile为`stages/pruned-core18-20261112`，manifest SHA `d2570db0f9c91b6ba5e061b171e215d0eb6f516940a47e2ea05f83d8fceba955`。24行包含6个已经成功的基线、18个新增任务；新进程提交上限18。24张交付物不等于24次新采样。两处W-G名称绑定已按真实Schema受控完成，旧图不变、新图另存并记录source_graph_hash。所有24张图已在POST前核对真实21类节点Schema；未新增软件测试、未提交或推送。

本轮不再追原808全矩阵：592个其余未跑new项（含14个未放行条件项）延期，不伪装成已执行。198个已完成旧任务与1次历史重复的记录原样保留；精简profile中的新增18项单独作为真实执行依据，不将W-G新graph SHA谎写为原图SHA。主人对新C组修复的负反馈不自动触发旧R的条件项，当前18项不含局部修复。

### 15.6 采纳后的阶段终态与验收

本轮交付目标是“旧18项身份诊断+6份原字节基线、新28项全部可回溯；随后共享GPU窗口正确收尾，等待主人视觉结论”，不是完成历史808覆盖。

| 条件 | 类型 | 可观察状态与通过判据 |
|---|---|---|
| S1 | AUTO | 精简manifest只有预定18个新增与6个已完成基线；基线prompt_id/PNG SHA不变；source_graph_hash可追溯，两处名称绑定以外没有未声明变更 |
| S2 | AUTO | 18新增任务全部真实success；PNG均1024×768且SHA匹配，提交图/原始history齐全；Sampler没有被缓存而冒充新增执行 |
| S3 | AUTO | 本进程实际新增≤18、未知=0、成功重投=0；6基线不计新成本；旧成本=199+本批新增，新28独立计28 |
| S4 | AUTO | 24项图片、参数、图、原始history与基线/权重/全局对照索引齐全且hash正确；新28的F1–F7仍可复核；不自动补回主人主动删除的已交付文件 |
| S5 | AUTO | 生产/角色表/共享模板及先前用户改动的保护hash不变；沿用当前已通过的174项回归证据，任何测试过源码漂移均拒绝接受旧测试结论 |
| S6 | MANUAL | 主人按同角色同seed配对判断身份、相互压制与路由差异；只有主人提供结论才记录，助手不选优；新C组仅有已记录负反馈，D组与LoRA尚待判断 |
| S7 | AUTO | 新28与旧18全部已授权提交闭合、无其他在途/未知、队列空时才结束共享窗口并G1；原drawEnabled键状态恢复、鱼PID及其它配置不变；不能提前因分支结束恢复 |
| S8 | AUTO | 当前交付版本经过一次独立机械审计，直接核原图hash、原始history、预算与资源证据；不以自报完成代替证据，不代替S6 |

统一机械验收命令为`python3 var/local-driver/anima-interaction-v1/stages/pruned-core18-20261112/verify-execution.py`，逐项输出S1–S5/S7/S8及证据，S6固定为pending-user直至主人确认；脚本只读取真实当前物料与保护基线，不发采样请求、不做视觉检测。S8还未产生时不能宣告整体机械通过。连续3轮同一条件无实质变化或同一技术错误重复2次则记录阻塞，不换seed、不放开条件项；无在途时也只按整个共享窗口的状态决定G1。
