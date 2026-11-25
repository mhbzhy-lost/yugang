# Anima 2B 补充研究：联合接触与全场景镜头约束

日期：2026-11-12。状态：主人已授权离线实现、结构输入与实验夹具，总上限28次；首批4项回收后，主人明确要求继续剩余24项。执行模式为主会话串行。28项现已真实成功出图、逐张回收，无成功任务重投；这不是视觉验收通过，旧研究精简审阅与共享资源窗口收尾仍需分别处理。

## 1. 用户意图与本次纠偏

2026-11-12主人对已交付C组新增反馈：“局部修复基本可以认为没什么用，还大量丢失细节”。以`user-feedback.jsonl`绑定manifest `dd6849dc…`记录为C组负结果；没有逐图细分判断，不泛化为全部R方法失效或D组已验收。当前C修复路径不推荐为默认步骤，不自动以降denoise/补seed继续挽救；已授权18项LoRA诊断不含这条修复，继续独立执行。

用户要求将以下内容纳入实验：

1. 同一张图中同时出现拥抱、嘴唇接吻、十指相扣，而非三个单独 case。
2. 人物组可以偏在一侧或角落，不再只改变远近而基本居中。
3. 真实低机位、相机绕光轴旋转、倾斜地平线；代表场景为两人在夜空下的原野牵手奔跑，人物只占一侧。地面可以仍是水平世界平面，不能把相机 roll 偷换成山坡、身体歪斜或只给背景画一条斜线。
4. 用户已尝试过仅靠提示词无法实现这类要求，需要节点与结构条件。

用户随后质疑当前大量 B 组只是旧 RS 的简单应用、重复已知结论。此意见改变研究优先级：**停止用全排列数量代表技术进展，先以少量可解释对照验证能力增量。** 用户通过提问工具选择暂停后，又明确纠正：暂停的是重复旧基线的扩量，不是整个实验结束，也不是放弃已经开发的技术。旧批次已接受作业自然结束、不清队列；继续在既有授权与808总上限内优先运行 ready 父图的 R1/R2/R3、DD 与 Crop 技术对照。**G0继续保持，不能因基线暂停而执行G1。** 主会话误尝试的恢复命令没有成功，随后已停止恢复动作并重新实测 gateIntact=true。

本计划是后续三合一动作与镜头扩展的独立范围，不取代仍应继续的旧技术验证。不延续另一套808张矩阵，也不默认恢复重复B组扩量。提出最多 **28次实际扩散**，其中先做4项中途检查样例，给主人看过再决定是否继续剩余24项；禁止助手自己判好坏后放量、自动扩种或搜索权重。

### 1.1 授权与保护范围

- 当前已授权：本会话 inline 写计划与修订、只读源码核实、一次后台独立计划 review；暂停旧基线扩量，保持G0，继续既有授权下的R1/R2/R3等技术验证。不得把该纠偏理解成结束整个实验或恢复鱼权限。
- 已授权：本计划列出的离线代码、全新实验结构夹具、隔离新节点和最多28次扩散。首批4项后，主人明确说“剩下的24个先跑着”，因此已放行剩余24项；原4项按同一身份跳过。实验夹具不是新增软件测试；新增软件测试仍未授权。
- 建议（待用户授权）：新增软件单元测试与软件测试 fixture。当前不创建；既有 `npm test` 可用于回归。
- 不授权：commit/push、生产代码/模型/角色表/ComfyUI 模板改动、重启生产 ComfyUI、修改系统服务/SSH/防火墙/计划任务、训练新模型或自动下载新控制权重。
- 两组成年角色沿用 DC=DeepSeek+Claude、QG=Qwen+Grok。仍用标准 2B、1024×768；模型及角色唯一事实源不变。实验权重先固定 A/B=0.8，不把权重网格乘进本次研究。主人明确指定新权重时才另冻 revision，不由助手选优。
- 助手与审阅者不看生成图评分、不选图、不替主人判断身份、动作或镜头是否成立。用户先前的身份丢失反馈作为风险保留，不擅自归因或调权。

## 2. 先定义交付终态

交付物应使主人能针对两个技术假设，看清**同一输入的旧能力参照、新路径、真实图像及全部失败**，而不是只看到一个更复杂的 workflow。

- **H-contact**：在同一父图上，用嘴部、交握手、环抱接触带组成的多接触编辑域，配合双角色区域重绘与 Differential Diffusion，是否比单次 RS 初采样更能同时保持三个接触关系与角色身份。
- **H-camera**：人物、姿态、owner 区域、地面/天空布局来自同一物理相机与投影，且背景布局实际进入扩散初始化时，能否比“只约束人物、不约束地面/天空”的路径更稳定保留偏置、低机位和倾斜地平线。

旧矩阵正在优先验证的R1/R2/R3对照，是H-contact的上游机制证据，费用仍在原808内，不计入新28。若旧对照暴露R3/DD的接口或机制性失败，先修复、真实重验并向主人报告，不能绕过该证据直接消费新的C-repair预算；不因失败放弃旧技术或退回刷基线。

必要终态为 §9 的 F1–F10。全部 AUTO 通过只能声明「试验及证据已交付，等待主人视觉结论」；F8 未确认不得宣布整体完成。任何整条机制无法运行或没有可供判断的图，属于阻塞，不以错误清单冒充该机制已验证。

## 3. 已核实技术事实，不冒称现成能力

本节依据当前冻结 RS `721d57ab98e80dc6854d4f49758bc9c456bb925c` 源码及本地实验代码，非网上节点名称猜测：

| 已核实物料 | 可用能力 | 本次不能作的推断 |
| --- | --- | --- |
| `pose3d.py::read_scene/camera_coordinates/project` | camera 只清洗 position/target/fov；低机位可通过真实位置与朝向表达 | camera basis 固定 world-up，未读 roll/up/principal point；往 scene_json 加 roll 字段不会生效 |
| `RSCameraControl` / `camera_control.py` | 镜头 caption；可选 mask 的二维缩放/旋转/平面透视 | `elevation` 自述不是 3D 相机；roll 提示词不能保证方向；不能以该节点名字证明地平线被约束 |
| `RSMultiCharacterPose3D` | MHR 人体、full/visible owner、着色人体与轮廓、原生 2B 姿态计划 | 人体条件图不含真实地面/天空，不能把它当背景深度或地平线控制器；MHR 没有真实嘴唇控制点 |
| `ModelPatchLoader` + `AnimaLLLiteApply` | 当前已绑定的原生 2B 人体轮廓适配器 | 不证明兼容任意 Depth/Canny/OpenPose 模型；不能向人体条件图塞地平线冒充训练分布 |
| 既有隔离 `YugangRSMaskedImg2Img` + Crop/Stitch + mask 胶水 | 双身份局部 img2img、灰度编辑强度、贴回；正是尚需技术验证的 R3 路径 | 既有 repair 入口刻意禁止 pose/LLLite，不能直接拿来处理带姿态 patch 的整幅图，不能为了本研究解除旧保护 |
| `interaction-study-pull.py` | 已实现每 15 秒增量拉回、逐字节 hash、不覆盖原物料 | 当前远端根与 manifest SHA 写死；新研究接入需显式 profile，不能改常量破坏仍在服务的旧回收进程 |

源码证据位置：`experiments/anima-interaction-v1/structure/{geometry_core.py,rs_bridge.py,render.py}`、`experiments/anima-interaction-v1/patches/rs-img2img.patch`，以及只读冻结 RS 快照的 `pose3d.py/pose3d_node.py/camera_control.py/camera_layout.py`。执行准备时复制所消费源文件到新 run 的 `sources/` 并核 hash，不依赖临时目录永久存在。

**技术增量不是“装了一个新名字的节点”。** 联合接触组验证现有二开 R3 的新用途；镜头组需补齐当前确实缺失的共同相机几何与带姿态的整幅初始化入口。它们仍利用现成扩散模型，不声称提出新的学习算法。

## 4. 场景与空间契约

### 4.1 联合接触 C 组：三个明确的四臂分工

| ID | 冻结动作 | 必须能观察的关系 |
| --- | --- | --- |
| C1 正面相拥 | A 左臂绕 B 腰背，B 右臂绕 A 腰背；A 右手与 B 左手在胸下十指交扣；两人嘴唇接触 | 手不挡嘴；两条环抱臂与另一对交握手不混为额外手臂 |
| C2 斜侧相拥 | 两人躯干呈斜侧贴近；A 左臂、B 右臂分别环抱；A 右手与 B 左手在腰前交扣；侧脸接吻 | 环抱、腰前交握、唇部都在画内，不能用普通并排站立替代 |
| C3 背后环抱 | A 在 B 身后，A 左臂环 B 腰；A 右手与 B 左手在腹前交扣，B 右手扶环腰前臂；B 上身略转并回头与 A 接吻 | 不靠不合理拧颈实现接吻；腹前手、头颈、环腰臂的归属可判断 |

两对角色均做，初轮各一 seed `20261112`。统一以大腿以上/半身为目标，头完整、嘴部和交握手在画内；不做只剩头脸、因此无法判断三合一的景别。日光庭院环境仅作固定背景，不增加道具或角色。

### 4.2 镜头 D 组：夜空原野牵手奔跑

两人保持可读的奔跑步态与一对交握手，成年、原角色服装，夜空、原野、可辨天空/地面边界。**此组不是边奔跑边接吻的第四种联合动作**，避免把所有困难同时乘起来。

| ID | 人物组联合包络中心目标 `(x,y)` | 机位 | roll（图像坐标，右侧更低为正） |
| --- | --- | --- | --- |
| D0 中央参照 | (0.50, 0.55) | normal | 0° |
| D1 左侧留景 | (0.25, 0.55) | low | +15° |
| D2 右侧留景 | (0.75, 0.55) | low | −15° |
| D3 左下角留天空 | (0.25, 0.70) | low | +25° |

这四种是综合压力配置，不是位置/高度/roll 的全因子因果实验；只在每个 D case 内对比两条机制。不能据跨 case 差异宣称单个变量造成改善。

世界 Y 向上、地面 Y=0。以该场景人体参考高度 H 定尺度：normal 相机高 0.8H、朝向仰角 0°；low 高 0.2H、朝向仰角 +12°。距离按冻结数值解求出，fov=38°，取景平移用共同主点/窗口偏移，不重新瞄准人物来抵消低角度。人体联合包络目标高 0.40 画高、宽不超过 0.40 画宽，四边至少留 0.03；中心容差每轴 0.025。投影不可满足时在 CPU 阶段报具体冲突，不静默缩成居中、不剪掉头脚或尾巴补齐数字。

## 5. 实现路线：条件实际进入扩散，而非写提示词交差

### 5.1 接触图与联合编辑域

每个 C 世界夹具保存 `contacts.json`：边的类型、A/B owner、双方身体部位、三维目标/代理点、投影位置、预期可见性。至少有唇部、交握手、环抱接触带三类边。

- 通过既有 MHR 关节/FK authoring 准备姿态，不新建训练式接触求解器。记录头部前向与唇部代理的定义；代理接近不等于嘴唇真正接触。
- 手腕距离目标不大于 0.04H，唇部代理不大于 0.025H；环抱手/前臂到被抱躯干目标不大于 0.10H。每条边投影必须落在要求可见范围，并分别记录数值，不以数值自查宣布十指或受力正确。
- 为嘴、交握手、环抱接触带分别投影局部编辑核，再取并集；二值 support 与独立 context 只围绕这些接触域扩张，不再把两人全身 union 当“局部修复”。
- 按同一 Crop/Stitch 变换转换 A/B owner、三类编辑核及灰度 mask；owner 最近邻，灰度连续插值后夹限支持域。一次重绘可覆盖多个不连通编辑核，支持域以外噪声为零。
- 修复使用既有 R3 路径、固定 denoise=0.45、DD strength=1；未获视觉反馈前不搜索强度，不增加第二次修复。父图必须原样交付，修复无论好坏都保留。

### 5.2 一个相机，统一投影所有条件

拟新增纯 CPU 几何实现 `experiments/anima-interaction-extension-v1/geometry.py`；CLI 与拟新增节点 `YugangStudyCameraProject` 共用这一实现，不写两套投影算法。

1. 用冻结 RS 的真实低/正常相机渲染人体与 owner；相机 roll 不能交给会丢弃未知字段的 `read_scene`。
2. 在投影层对全部条件施加同一个光轴旋转与主点/窗口平移 H，保持宽高比，记录 3×3 矩阵、源相机 K/R/t、有效画布和裁切范围。光轴 roll 的共同二维投影变换在针孔模型下等价于相机旋转；这是**扩散前的条件变换**，不是旋转已经生成的照片。低机位来自三维相机，不以二维扭斜假冒。
3. 人体着色条件、A/B full/visible owner、鲸尾同 owner 附属轮廓、接触投影、天空/地面半平面、背景布局板全部消费同一个 H。binary mask 最近邻；人体 RGB 连续插值、背景维持黑色，不能把地面加进人体 LLLite 条件图。
4. 由水平世界地面法向经同一相机与 H 推导地平线，保存归一化直线系数与画内两端点；参考条件中的角度误差≤0.5°。共同点投影与 mask 边界抽样复核误差≤1.5px；owner 值域必须为 0/255。这里的角度/像素检查只针对自己生成的控制条件，不检查或评分生成图。
5. 低分辨率布局板以同一地平线分隔夜空与原野，给出连续色调/地面透视线索；不画文字/数字/标尺，不把身份参考或最终图冒充布局板。布局板只作为 img2img 初始化，不作为最终成品，也不是训练式背景 ControlNet。

滚转后的着色人体条件可能偏离现有LLLite的训练分布，D-human也用于检验这一风险；不能把模型不跟随条件直接解释成投影几何错误，反之也不能仅凭几何检查通过声称适配器一定支持roll。

新节点拟输出 `pose_image:IMAGE`、`owner_a/owner_b/sky/ground:MASK`、`layout_plate:IMAGE`、`projection_info:STRING`。输入为冻结 scene 与显式 camera-extension 参数、固定输出尺寸；拒绝任意文件路径/模型名/网络地址。名字和接口在此为**待实现合同**，没有宣称当前 object_info 已注册。

外部施加姿态的 graph 必须用 `ModelPatchLoader → AnimaLLLiteApply(pose_image)` 一次。角色 pipe 由 Prompt/LoRA/Position/Mask/Finalize 重建，不带会在采样内部重渲染的 pose3d_json；禁止再次调用 Pose3D auto 或 Camera layout_sync，避免旧坐标覆盖新条件或二次旋转。

### 5.3 背景初始化与带姿态的整幅 img2img

拟新增 `YugangRSSceneImg2Img`，独立于旧repair节点，继承**已经应用rs-img2img.patch、具备_initial_latent与_sample_latent钩子的**RS基础采样器，提供真实整幅image/latent初始化与denoise；未打补丁的原版基类不满足这个合同：

- 接受一次已通过架构/条件检查的外部原生 2B LLLite MODEL；`ALLOW_PIPE_POSE=False`，pipe 的 pose3d_json 必须为空，避免内部再挂姿态。
- 从布局板经 VAEEncode 得到初始化 latent，固定 denoise=0.65、30 steps、cfg=4、euler_ancestral/sgm_uniform；A/B 路由与 LoRA 同参照路径一致。
- 复用基础采样器的路由/clone/采样实现，保持原有模型 hook；不解除 `YugangRSMaskedImg2Img` 的 crop/pose 安全校验，不给生产节点加参数。
- 正向真实传入变换后的 pose_image，保存 requested/effective 设置、patch 数、输入 image/latent 与 owner hash；不能有输入但内部仍从全零 latent 起步。

**这是软背景约束，不是精确地平线保证。** 姿态适配器不能约束地面，img2img 初始化也可能被模型洗回水平。这正是 D 组要证伪的部分。若两条路径的地平线都失败，报告机制不足，后续再单独研究已核实兼容 2B 的背景结构控制；不自动安装名字相似的 Depth/Canny 权重，也不旋转最终 PNG“修好”。

## 6. 最小技术矩阵与预算

| 组 | 构成 | 实际扩散上限 | 提供的决策证据 |
| --- | --- | --- | --- |
| C-parent | 3 联合场景 × 2 角色对 × 1 seed，单次 RS+原生姿态+owner 初采样 | 6 | 新联合场景的必要父图，不重复旧单动作基线 |
| C-repair | 上述 6 张各一次多接触 R3 修复 | 6 | 同父图 before/after；是否同时保住三种接触和身份 |
| D-human | 4 镜头配置 × 2 角色对 × 1 seed；统一投影的姿态+owner，零 latent txt2img，无背景初始化 | 8 | 人物节点能约束镜头到什么程度，背景会否自行拉平 |
| D-scene | 同 8 case；相同姿态/owner，加共同相机布局板与整幅 img2img | 8 | 背景布局进入扩散后的实际增量与身份/动作代价 |
| 合计 | 14 个不同条件 case、28 个结果，C 修复有 6 条真实父子关系 | **28** | 不自动扩矩阵 |

D-human 与 D-scene 的比较同时改变初始化方式和 denoise 路径，是机制家族对照，不宣称只改了某一个节点。C-parent 与 C-repair 是两阶段完整管线比较，不把额外一次采样的收益说成同计算量优势；分别报告时间与采样次数。

相同 pair/world/seed 的方法、镜头变体共用稳定初采样 seed：`uint32be(SHA256(UTF8(pair + '|' + world_id + '|20261112|initial'))[0:4])`；C-repair 的末字段为 repair。camera/layout/method 不参与 seed 派生。全量 job_id、条件 hash、有效参数、父子关系在启动前一次冻结。

### 6.1 计账与旧批次的关系

- 28是主人已授权的新范围上限，先放行4项；主人中途明确继续后再放行24项。不把旧808中未用的额度自动挪作新场景，不默认把旧矩阵补跑。
- 原批次已有一次成功 B0 smoke 未吸收而重复采样的历史错误，实际次数=不同成功任务数+该重复及其他已证明开始采样的失败次数；不能因 PNG 相同而不计。其欠一项覆盖的问题继续如实保留，不借新预算偷偷补。
- 冒烟直接选择本矩阵中的 C-parent、C-repair、D-scene 各一项；若成功，按原 job_id/graph/input hash 吸收，后续绝不再投。单一输出名差异不得掩盖等价执行；执行 fingerprint 排除 SaveImage 文件名前缀/metadata 标签，保留所有数值、seed、模型/条件/代码 hash。
- POST 尝试数先保守占额度；仅有明确“采样前失败”的证据才释放预留。开始采样后失败仍计一次；状态不明保持占用。技术失败按简单失败清单处理，修复后要另查剩余额度，不实现自动 retry/lineage 框架。
- 最多 28 次内若不能形成全组可评估物料，报告技术阻塞；不换 seed 凑好图，也不把 cap 自动涨到 29。
- 新28项先仅放行C1/DC的parent+repair与D1/DC的human+scene共4项；逐图回收后进入主人中途检查点。未得到继续意见不运行其余24项、不把沉默当继续授权。主人随后已明确继续，24项于12:25:41全部成功，新增POST恰好24次、无在途或重投；首批4项原prompt_id不变。此检查点只限制新扩展，不暂停旧授权内的R机制联调。D0保留为相同夜空奔跑条件下初始化机制的成对参照，不把旧庭院图伪装成同输入复用，也不据此扩成全景别基线。

## 7. 文件、隔离与逐图交付

以下是执行获授权后才创建的精确落点，不是假装已经存在的实现：

```text
experiments/anima-interaction-extension-v1/
  spec.json                          # 14 条件 / 28 job 契约
  geometry.py                        # 唯一共同相机/接触投影实现
  contacts.py                        # 3 联合姿态与奔跑世界夹具作者接口
  custom_nodes/yugang_composition/
    __init__.py                      # 仅注册以下两个新节点
    scene_project.py                 # YugangStudyCameraProject
    scene_img2img.py                  # YugangRSSceneImg2Img
scripts/experiments/interaction-extension.ts
                                      # describe/build/verify，复用旧窄构图函数
var/local-driver/anima-interaction-extension-v1/
  sources/ preflight.json spec.json manifest.json graphs/
  inputs/ state.json results.jsonl generation-info/ images/
  checks/ reviews/ delivery.json user-feedback.jsonl
```

新 CLI 与验证器严格区分计划缺件、未执行、执行错误、机械通过、等待主人；不存在返回总是通过的 stub。`describe` 不需要 GPU；`build` 缺真实结构/资产/Schema 就拒绝。跨机器 source path 使用 revision 内相对路径，禁止再次依赖 Mac 绝对路径在 Windows 的意外映射。

现有 runner 只以新增 manifest/profile 驱动，沿用单 GPU 单 job、未知提交回查、HTTP4xx/执行错误停止新提交。当前回收器新增显式 `--profile` 读取远端 owned root/manifestSHA/destination，保留旧默认行为；不能为新研究改掉旧默认常量。新 profile 的路径仍限定在 owned 实验根，经 home-connect 唯一入口传输；新旧账本不混。

交付目标根预定为：

`~/Downloads/yugang-ab/61-Anima2B-联合接触与镜头约束-20261112/`

创建前核对不存在；若已存在且没有匹配本研究 marker，则停止并报告，不覆盖或另取随机目录规避冲突。每 15 秒增量回收，成功一张即回收一张；PNG、graph、有效参数、generation-info、原始 history、接触与投影条件、布局板都可追溯。回收与人工 review 并行，不等全组结束。既有 01–60 以及实时回收目录原样保留。

目录内按 `C-联合接触/`、`D-人物与背景镜头/` 组织导航，并保留统一 images/parameters/graphs/conditions；每个对照给父子或配对原图、控制条件、不同变量、实际成本与局限。README 不含“最佳”“身份通过”等助手视觉结论。

## 8. 任务、验收与真实依赖 DAG

整体终态先于此任务表；任务完成不代替 F 条件。实现与真实 GPU 验证分开，不把 blocker 与修复捆成一个无界任务。

| 任务 | 最小可审交付与独立通过判据 | 依赖的具体产物及原因 |
| --- | --- | --- |
| E0 契约与账本冻结 | spec/节点接口/14 条件28 job/预算、旧暂停事实与所有保护文件基线，输出 checks/contract.json；describe 精确报 6+6+8+8 | 本计划、旧 state/manifest/resource-lease，只读消费，不以旧全部执行完成为前提 |
| E1 共同相机几何 | geometry.py 与 checks/projection.json；同一 H 下角度/中心/边界/对应点达到 §4/§5 数值判据，旧 read_scene 不冒读 roll | E0 的参数和节点接口；不依赖 GPU、节点安装或 E2 |
| E2a 投影节点 | scene_project.py/注册项，接口与 E0 一致、CPU 输入拒绝规则明确；同一输入与 E1 CLI 的数组/hash 一致 | E0 接口 + E1 唯一几何实现，避免算法重复 |
| E2b 整幅初始化节点 | scene_img2img.py/注册项，完整输入→VAE latent→base sampler 路径、外部 pose 一次与旧 repair 隔离有静态证据 | E0接口和已冻结的含rs-img2img.patch基类源码；可与E1/E3独立实现，不等新GPU环境 |
| E3 世界姿态与条件夹具 | 8 套世界姿态（3 联合动作×2对+奔跑×2对）、14 组真实投影条件/contacts，hash齐全、无空 owner、三类预定接触在画内 | E0 场景语义 + E1 投影实现；不依赖 E2b 或服务器启动 |
| E4 构图/验证/回收 profile | CLI 产28真实 graph；每输入相对路径、parent、sampler、预算与输出合同完整，验证逐F真实读证据；新 profile 不破坏旧回收 | E0、E2a/E2b 接口源码、E3实际条件与已有runner/pull；不把“接口文档就绪”当节点运行通过 |
| E5 隔离注册与 CPU 合同核验 | 保持G0，确认旧技术验证暂时无在途/不明提交、单GPU互斥后才加载新实验节点；真实object_info/版本/hash及CPU节点输出核验 | E2a/E2b实际包、E4 graph；与旧R技术验证共享串行调度但账本分立，不以旧G1为前提，不重启有在途任务的lab |
| E6 四项技术样例与中途检查 | C1/DC parent+repair、D1/DC human+scene；history真实成功、PNG可解码、R3 mask/初始化/LLLite接入有证据、预算累计≤4，不评价画面；回收给主人决定是否继续 | E3/E4/E5及旧R3/DD机械联调通过；repair精确依赖本次parent原图，不伪造先前父图 |
| E7 剩余真实运行 | 吸收E6成功项，得到主人明确继续意见后，仅运行其余尚未完成且依赖ready的job；简单失败清单；每图增量回收 | E6机械通过+主人中途继续意见；各C-repair只依对应C-parent；新旧实验共用单GPU串行队列，不能同时各起一个worker |
| E8 收尾与完整交付 | 完成所有图/技术失败/条件/README/hash索引；新旧共享GPU窗口的全部已授权作业都已结束且无在途/不明提交、队列空时才G1；已有物料不变 | E7终态或真实阻塞退出；本支路暂停不结束其它已授权技术验证，最终G1不等待视觉验收 |
| E9 独立机械验收 | 一次独立审计原始文件与F1–F7/F9；F8保持pending-user；缺件在授权内修复 | E8当前版本，不能只读验证器自己的acceptance来自证 |

依赖图：`E0 → E1,E2b`；`E1 → E2a,E3`；`E0+E2a+E2b+E3 → E4`；`旧技术验证无在途/未知+G0互斥+E4 → E5`；`E5+旧R3/DD机械通过 → E6 → 主人中途继续意见 → E7 → E8 → E9`。E7内repair只等本父图。并发模式每有产物ready就立即释放依赖，不设批次屏障；GPU调度仍只有一个。每个实现任务按30分钟切片，超预算先交精确阻塞与产物，不在同一任务无限摸索。

## 9. goal 可消费的完成契约

以下清单可以独立落盘。`interaction-extension.ts` 是待实现的验证入口，当前不运行、不声称已经通过；E4必须交出真实实现后才能执行。统一命令只覆盖AUTO；MANUAL的签收仍独立保存。

```json
{
  "contract": "anima-contact-camera-extension.v1",
  "run_root": "var/local-driver/anima-interaction-extension-v1",
  "auto_command": "node scripts/experiments/interaction-extension.ts verify --auto --run var/local-driver/anima-interaction-extension-v1",
  "criteria": [
    {"id":"F1","type":"AUTO","condition":"14条件和28job、6+6+8+8计数、唯一seed/输入/模型/源码hash与授权范围匹配","command":"node scripts/experiments/interaction-extension.ts verify --criterion F1 --run var/local-driver/anima-interaction-extension-v1","pass":"无缺件、重复job或未授权组，冻结后无静默变化","evidence":"manifest.json, spec.json, sources/, checks/contract.json","tasks":["E0","E4"]},
    {"id":"F2","type":"AUTO","condition":"8世界与14投影的相机/接触/owner/地平线/布局板同源，目标中心与画内边界满足§4，角度误差≤0.5度、投影误差≤1.5px，接触代理值明确","command":"node scripts/experiments/interaction-extension.ts verify --criterion F2 --run var/local-driver/anima-interaction-extension-v1","pass":"所有条件机械合格且hash相符；不输出图像效果判断","evidence":"inputs/, checks/projection.json, checks/contacts.json","tasks":["E1","E2a","E3"]},
    {"id":"F3","type":"AUTO","condition":"真实节点Schema/注册、输入初始化、LLLite一次、旧repair保护与输出合同成立","command":"node scripts/experiments/interaction-extension.ts verify --criterion F3 --run var/local-driver/anima-interaction-extension-v1","pass":"机械冒烟闭合、有效图与history存在；D-scene非零latent来源可追溯且未重复挂pose","evidence":"preflight.json, graphs/, generation-info/, checks/smoke.json","tasks":["E2b","E4","E5","E6"]},
    {"id":"F4","type":"AUTO","condition":"全部授权job有真实终态、C父子和D配对成立、每种主线机制有可评估图","command":"node scripts/experiments/interaction-extension.ts verify --criterion F4 --run var/local-driver/anima-interaction-extension-v1","pass":"无pending/unknown/遗漏或被错误清单掩盖的整组阻塞；失败如实记录","evidence":"state.json, results.jsonl, images/, generation-info/","tasks":["E6","E7"]},
    {"id":"F5","type":"AUTO","condition":"全部实际扩散包括冒烟与采样后失败≤28，无成功重投，旧预算独立","command":"node scripts/experiments/interaction-extension.ts verify --criterion F5 --run var/local-driver/anima-interaction-extension-v1","pass":"尝试/采样/缓存/复用可对账、无不明额度；旧重复不能冲销","evidence":"checks/budget.json, state.json, histories, smoke-absorption.json","tasks":["E0","E4","E6","E7"]},
    {"id":"F6","type":"AUTO","condition":"每张原图/参数/graph/条件/history/失败/README增量交付，图与原始hash一致，既有Downloads物料不变","command":"node scripts/experiments/interaction-extension.ts verify --criterion F6 --run var/local-driver/anima-interaction-extension-v1","pass":"交付job并集等于授权job集合；无不同字节覆盖或助手评分字段","evidence":"delivery.json, receipts/, Downloads/61-Anima2B-联合接触与镜头约束-20261112/","tasks":["E4","E7","E8"]},
    {"id":"F7","type":"AUTO","condition":"只改获授权实验范围，既有npm test对应当前源码全绿，生产及旧运行物料未被改写","command":"node scripts/experiments/interaction-extension.ts verify --criterion F7 --run var/local-driver/anima-interaction-extension-v1","pass":"保护hash与启动前基线一致，测试证据对应当前代码，无凭据泄漏、无未授权提交部署","evidence":"checks/change-scope.json, checks/npm-test.log, sources/","tasks":["E0","E2a","E2b","E4","E8"]},
    {"id":"F8","type":"MANUAL","condition":"主人判断三合一、身份、空间构图、真实低机位和倾斜地平线是否成立及技术增量是否值得","operator":"主人","steps":["查看C父图与修复图以及三类接触条件","查看D两路径、正负roll与中央/偏侧/角落的原图和条件","用自然语言给出取舍、失效点或下一步；不必填表"],"pass":"明确反馈绑定本revision；没有反馈为pending-user，不由助手代判","evidence":"user-feedback.jsonl, delivery.json","tasks":["E8","E9"]},
    {"id":"F9","type":"AUTO","condition":"旧基线暂停不触发G1；实验窗口内保持G0、新旧作业串行无冲突，无生产重启；整个授权GPU窗口真正结束后才G1","command":"node scripts/experiments/interaction-extension.ts verify --criterion F9 --run var/local-driver/anima-interaction-extension-v1","pass":"窗口内资源闸完整；最终无在途/不明提交且队列空，最终键级恢复记录与真实读值一致；不得把中途暂停当最终恢复","evidence":"resource-lease.json, jobs-closed.json, checks/resource-timeline.json","tasks":["E0","E5","E8"]},
    {"id":"F10","type":"AUTO","condition":"独立机械审计核对当前原始证据，不采信任务自报或以自动结果代替视觉","command":"node scripts/experiments/interaction-extension.ts verify --criterion F10 --run var/local-driver/anima-interaction-extension-v1","pass":"F1–F7/F9证据独立对上，审计不含图像评分，F8未反馈时仍pending-user","evidence":"reviews/delivery-audit.json, 原始文件","tasks":["E9"]}
  ],
  "stagnation": {"same_auto_criterion_unchanged_rounds":3,"same_environment_error_rounds":2,"action":"停止本支路新增提交，保存未满足F项/原始证据/原因/恢复下一步；已接受任务只回查不重投；仅当整个新旧共享授权GPU窗口结束后G1，其它支路仍继续时保持G0；阻塞不等于完成"},
  "completion": {"auto_all_pass":"delivered_awaiting_user_review","all_including_F8_pass":"complete","blocked":"blocked_not_complete"}
}
```

所有AUTO由统一命令逐项输出 `passed/failed`、判据与证据路径，写当前manifest/source指纹对应的 `acceptance-auto.json`。不能仅检查文件存在或读取自己上次的acceptance就通过。

## 10. 停止条件与执行模式

### 10.1 立即停新提交的条件

- 用户认为方向仍在重复已知结论或要求暂停；保留已接受任务，不清队列。
- 共同相机变换与pose/owner/背景不一致、接触条件无法准备、源头手部/嘴部代理不成立；不靠软提示词掩盖。
- 2B架构/模型hash/新节点注册不符，Schema缺件，外部pose重复施加，旧repair保护被绕过。
- accepted状态不明、HTTP4xx、执行错误、预算不明/到顶、资源闸失效、生产PID漂移或其他GPU使用者。
- 任一主线完全无法出图或同环境错误两次：先记录未满足F项，修复在授权范围内单独进行，再真实验证；不扩大到系统维修或新权重训练。
- 主人没有确认F8时，停止于等待反馈；不自动挑“最好”的方法继续扩样。

### 10.2 已选择主会话串行执行

- **主会话串行执行**：本会话 inline 逐任务推进，不派发实现/运行 subagent。上下文连续、符合用户此前的偏好；代价是受本会话上下文和轮次预算限制。独立计划review与终态机械审计按既定规则各一次，均不看图评分。
- **subagent 并发驱动**：无依赖的CPU/代码任务事件驱动派发，主会话调度整合；更快但有交接、合并与冲突成本，所有派发后台，GPU仍串行。不因选择并发推定commit/worktree提交授权。

计划已经完成一次独立只读review并由本会话修订。主人通过提问工具选择“授权实现，先跑4项”和“主会话串行（推荐）”，本会话据此开始执行，不派实现/运行子代理。旧基线扩量暂停，G0保持；只有整个授权GPU实验窗口真正结束，才按原契约执行G1，不能再次把暂停某组误解成结束实验。

## 11. 首轮独立审阅处理

2026-11-12已完成一次只读review，未看图、未运行命令、未改文件。主会话inline修正：区分旧基线暂停与整个研究结束，移除旧G1作为新E5前提；接入旧R1/R2/R3真实联调作为H-contact上游；明确新scene节点消费打过patch的基类；补充roll条件可能超LLLite训练分布的风险；采用先4项给主人中途决策、再决定剩余24项的早停结构。修订后不再次自动派审。

## 12. 首批执行记录（不是视觉结论）

- 主人已选择“授权实现，先跑4项”与“主会话串行”。新增实验夹具已授权，新增软件测试、生产改动和commit/push未授权。
- E0–E4已形成8世界、14组真实CPU条件和28张graph。共同相机点复核最大误差约2.55e-13px，owner边界抽样最大误差0.814px，地平线参考角误差约2.85e-14度；仅说明参考条件一致，不说明生成图成立。
- C3在CPU authoring中发现MHR局部Y轴并非头部yaw轴，已依据真实FK修正为分配到躯干/颈/头的局部X轴；通过signed body-forward检查，A位于B身后（约-0.0664世界单位），三类接触代理满足预设距离。旧失败与初版参考保持归档，不混为正式图。
- E5仅重启隔离lab 26740→14408，生产Comfy PID36932不变；新增两个节点真实注册，总类数1065。CPU-only prompt `f5766ee3-6877-40e9-b381-9b011da683a6`成功，投影输出数组hash与冻结参考逐项相等；该prompt没有任何采样节点，扩散计数0。旧repair源码hash保持不变。
- 实际ModelPatchLoader枚举使用Windows反斜杠，已按同一个已核实体名做唯一Schema绑定；修改前的graph/manifest/source快照保留在`revisions/schema-before-windows-binding`，不是更换权重或跳过校验。
- 当前完整manifest SHA为`dd6849dc233381cacb3c84659a1888c2f0e76cd2e2a55647da7644f26d8af630`；首批4项manifest SHA为`a643a613865b78b82128d860650d486bf8814c4d7c9c6b91aa3d13765dd972dd`。仅这4项收到maxNewJobs=4许可，其余24项无许可、不自动续跑。
- 当前源码既有回归174/174通过。首批worker与15秒增量回收已启动；真实终态只读state/history和逐图回执，不由启动成功推断出图成功。共享实验窗口未结束，G0继续保持。


## 13. D-scene v2（2026-11-12 主人授权，执行中）

主人终判后追加授权：“先把d-scene v2搞定，朝向问题确实需要新立项”“现在就跑12次，但是把鱼的画图关了之后就别再恢复了，我说恢复再恢复”。

- **假设**：v1 D-scene 失败原因是低细节色块布局板初始化；把布局板先经模型完整渲染成真背景图，再作 scene 初始化，模板路线才有可判性。
- **管线**：①背景渲染段 4 次扩散（D0–D3 各一张，布局板 LoadImage→VAEEncode→KSampler denoise=0.8→VAEDecode→SaveImage；夜空的野场景提示词、无角色 tag、无 LLLite/RS；plate 角色无关、DC/QG 共用）；②scene-v2 段 8 次扩散（DC/QG×D0–D3，图与 v1 D-scene 完全一致，唯一改动是 YugangRSSceneImg2Img 的 image 输入从 project 布局板输出换成①的渲染背景（parent_job 上传），denoise 保持 0.65）。
- **单变量对照**：v2 vs v1 只差初始化质量（同 stage seed、同人物条件）；v2 vs D-human 回答背景初始化路线有无增强。背景段 seed 派生 `SHA256("SCENE-BG|D<i>|20261112|background")` 前4字节。
- **预算**：12 次新扩散，独立于 245 旧账（合计上限 257）。复用既有节点/runner/parent-job 机制，不写新节点、不加新测试。
- **资源闸变更（主人指令）**：本轮 G0 关闭后**不自动 G1**；`drawEnabled` 保持 false 直到主人明确说恢复。旧计划 §9 F9/§6 的“窗口结束即恢复”对本轮失效，验收记 G1 悬置为遵指令状态而非缺陷。
- **朝向问题**：确认为新立项（需显式朝向信号），本轮不实施、不占预算。
- **交付**：61 号目录新子文件夹 `D-scene-v2/`（含背景渲染 4 张 + scene-v2 8 张 + 参数/graph/history/条件），不覆盖既有物料；逐图回收。

### 13.1 finish-v3：收尾链公平重跑（2026-11-12 主人裁决，执行中）

- 数据库取证（`ses_e36c96d4…` 2026-11-11 14:41:51）确认原始畅想管线含收尾链：联合生成 → 结构检查 → 可选精化 → 接触组联合重绘 → **超分与外观收尾** → 评估；“超分与质感最后进行、不改拓扑”“质感 pass 0.25 只负责质感”。扩展计划 §5.3 与旧计划 §5.4 两处丢弃了该链，导致 v1/v2 以裸单 pass 充当路线代表，对比不成立；D-scene 路线状态改为“从未被公平测试”。
- 主人裁决：只跑 DC（QG 同场景无增量）；两臂对称补收尾链；选项=“超分+质感 pass 两臂对称”。
- 链：复用初始 pass（v2 scene 8 张中 DC 4 张 / v1 human 8 张中 DC 4 张，0 新扩散）→ `4x-AnimeSharp` + `ImageScaleBy lanczos 0.5`（净 2x，0 扩散）→ `YugangRSMaskedImg2Img(image=2x, denoise=0.25, 无 noise_mask, 不挂 LLLite/pose, 区域 pipe 与提示词同初始原文)`，每图 1 次扩散。
- 规模：4 case × 2 臂 = **8 次新扩散**；总账 257+8=265。成品 2048×1536；hd 不进实验。
- stage seed = `uint32be(SHA256(UTF8(pair|world_id|20261112|pass))[0:4])`，world_id=`DC-RUN`（与 v1 初始 seed 公式同构，已用 v1 initial seed 反推自证）；两臂同 case 同 seed。
- manifest SHA `1c81c71a8ae6428046a4f80dde3fd52e731ec6c70903328a9ba65689c48e5b67`；构建器 `scripts/experiments/interaction-finish-v3.py`；Schema 静态校验 0 错误（真实 object_info：UpscaleModelLoader enum 含 4x-AnimeSharp.safetensors、ImageScaleBy 含 lanczos）。
- 交付目录 `Downloads/yugang-ab/61-…/D-finish-v3/`（新 marker，独立 ledger）。
- 读图对比在收尾后成品上进行；助手不做正式验收（F8/S6 仍归主人）。
