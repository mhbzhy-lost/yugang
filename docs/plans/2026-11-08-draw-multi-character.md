# draw 多角色管线（inpaint 链）实现计划

> **给执行 agent：** 必须逐任务执行本计划；步骤使用 `- [ ]` 复选框跟踪。只有整体交付终态全部验证通过，才算计划执行完成；未满足时持续修复与验证。执行方式由计划编写完成后的用户选择决定。

**目标：** draw 支持双角色同框（通用双区生成，不跟 LoRA 绑定）——场景 → 左半 inpaint 角色 A → 右半 inpaint 角色 B；AI 娘时可选挂各自 LoRA（官方 tags 自动并入对应侧），任意双角色（如 JK+OL）不挂 LoRA 也能用；独立新管线，现有 V8 管线零改动。

**分层设计：管线通用、工具收窄**——workflow 层支持任意分区数（parts 数组 N 区，mask 布局按分区数机械生成：2=左右、3=左中右、4=四分）；draw 工具层初期只开放 2 人（schema maxItems），后续扩 3 人只改工具层参数上限，管线零改动。

**架构：** 新增 `workflow-multi.json`（独立 SHA-256 校验常量）+ `makeMultiGraph`（受控参数构造，模型只能传角色枚举数组与画面描述，mask 由代码按区域枚举机械生成）；区域 mask 走 ComfyUI `/upload/image` 上传（与 ref 同通道）经 `LoadImage` 的 MASK 输出接 `SetLatentNoiseMask`；阶段进度复用既有 `onDrawStage` 机制。

**技术栈：** TypeScript（comfy.ts/tool.ts）、ComfyUI API（`/prompt`、`/upload/image`、`/ws`）、`SetLatentNoiseMask`/`LoadImage`/`VAEEncode`/`KSampler`（已实测 HTTP 200 在场）。

## 全局约束

- **现有 V8 管线零改动**：`workflow.json`、`WORKFLOW_HASH`、`makeGraph` 及单角色路径的行为与 hash 全部保持原样；新管线独立文件、独立校验（`MULTI_WORKFLOW_HASH`）。
- **安全边界**：模型可见参数只有 `characters`（枚举数组，初期恰好 2 人，可选）、`left`/`right`（两侧自由文本描述）、既有 `prompt`/`ratio`；mask 不接受任何模型输入——由代码按区域枚举（初期仅「左右各半」）机械生成；LoRA 文件名/触发词仍全部来自 `CHARACTERS` 常量。
- **draw 工具超时放宽**：`src/app/runtime.ts` 的 `toolTimeoutOverrides.draw` 从 360 改 600（多角色四段采样预计 4–6 分钟，实测后若超 600 再议）；其余工具不动。
- **阶段进度扩展**：`DrawStage` 增加多角色阶段；新文案 key 进 `prompt/messages.md`，沿用 `onDrawStage` 的轮类型闸与幂等 key 语义（`stage:draw:<round>:<multi-scene|multi-first|multi-second>`）。
- **不 commit 不部署**（部署时机由主人另行决定）；新增测试仅「建议（待用户授权）」，既有断言可随变更最小同步并逐处说明。
- 注释与 TOOL.md 中文；`src/` 无 ≥12 汉字字面量（内嵌扫描）。
- Windows 侧零新增依赖（全部用已实测在场的内置节点）；操作只经 `connect.sh` 通道。

## 整体交付终态

群里对鱼说「画大肥鱼和克劳德的合影」时，draw 走多角色管线出双角色同框图：两角色特征各自正确（发色/瞳色/标志物互不污染）、带阶段进度机械提示、单请求内完成且不撞工具超时；单角色路径回归无任何变化。

| ID | 必要条件 | 验证方法与环境 | 通过判据 | 证据位置 | 覆盖任务 |
| --- | --- | --- | --- | --- | --- |
| F1 | 真机探索报告：mask 上传/加载、inpaint denoise 调优、双角色链拓扑与分步耗时实测 | 本地起 SSH 隧道连 Windows ComfyUI 跑临时脚本 | 左半 inpaint 只改左半、denoise 参数定稿、双角色链全通且总耗时 < 560s | `/tmp/draw-multi-survey.md` + 脚本日志 | T1 |
| F2 | `workflow-multi.json` 落库且 `MULTI_WORKFLOW_HASH` 启动校验通过；`makeMultiGraph` 只消费结构化受控参数 | 代码审阅 + `npm test`（启动即校验） | 模板节点拓扑与 T1 定稿一致；构造 graph 不含任何模型传入的文件名/mask 数据 | diff + 测试输出 | T2 |
| F3 | `characters` 参数（枚举数组）路由到新管线；与 `character` 互斥校验；非法值以 tool 错误返回（文案含 next 指引）；draw 超时 600s | `npm run prompts` + 代码审阅 | schema/tools 校验闭合；单角色路径（character 单值）行为与 hash 无变化 | diff + prompts 输出 | T3 |
| F4 | 多角色阶段进度机械提示（scene/first/second 三条文案，复用轮类型闸与幂等 key） | 代码审阅 + 真机日志 | 每阶段一条、同轮不重复、自由交流轮不发 | `/tmp/draw-multi-e2e.log` + T2/T3 报告 | T2、T3 |
| F5 | `npm test` 全绿、`npm run prompts` 干净 | 仓库根目录两条命令 | fail 0；无意外条目 | 命令输出 | T2、T3、T4 |
| F6 | 真机验收：两个用例——①AI 娘双 LoRA（deepseek 左 + claude 右）②无 LoRA 双区（JK 左 + office lady 右）；各自出图、特征成立、阶段消息按时序触发、总耗时 < 600s | SSH 隧道跑验收脚本 | 两张 PNG 合法：①左蓝发鲸尾右侧橙发花饰 ②左 JK 制服右侧 OL 套装；三阶段日志时序正确 | `/tmp/draw-multi-e2e.png` + `/tmp/draw-multi-e2e-jkol.png` + 日志 | T4 |

**完成规则：** 所有必要条件同时满足，且验证证据对应当前交付版本，才能标记计划执行完成；仅完成任务步骤不能替代终态验证。

**未满足时：** 在已授权范围内持续 `fix → test（验证）→ 对照终态`；真实阻塞记录为未完成并写明恢复下一步。

## DAG

```text
T1 (真机探索: mask 通道 + inpaint 调优 + 链式拓扑实测)
 └──> T2 (workflow-multi.json + comfy.ts: makeMultiGraph + MULTI_WORKFLOW_HASH + 多阶段进度)
        └──> T3 (tool.ts + schema + TOOL.md + messages + 超时 600s)
               └──> T4 (真机验收: 双角色出图 + 阶段时序 + 耗时)
```

- T2 依赖 T1 的拓扑定稿与参数（denoise/步数/耗时预算）；T3 依赖 T2 的接口；T4 依赖全部。

## Waves

- Wave 1：T1
- Wave 2：T2（等 T1 定稿）
- Wave 3：T3
- Wave 4：T4

**关键路径：** T1 → T2 → T3 → T4（全串行；每步的产物是下一步的输入，无并行空间）。

---

### Task 1：真机探索——mask 通道与 inpaint 链实测

**Deps：** `none`

**WritePaths：** 无仓库写入。产出在 `/tmp/draw-multi-survey.md` 与临时脚本 `/tmp/draw-multi-*.ts`。

**Resources：** Windows ComfyUI 在线（SSH 隧道，1 个并发）；通道：先 read `/Users/mhbzhy/.agents/skills/home-windows-connect/SKILL.md` 再按其 `scripts/connect.sh` 用（禁止自动杭州中继）。

**Files：**
- Create：`/tmp/draw-multi-survey.md`、`/tmp/draw-multi-probe.ts`（探索脚本，不进仓库）
- Modify：无
- Suggested Test（待用户授权）：无

**接口契约：**
- Consumes：`src/tools/draw/comfy.ts` 现有 `makeGraph`/`runComfy`（复用场景生成与取图）；ComfyUI `/upload/image`（mask PNG 上传，与 ref 同通道）、`LoadImage`（IMAGE+MASK 双输出，已实测）、`SetLatentNoiseMask(LATENT,MASK)→LATENT`（已实测）
- Produces：`/tmp/draw-multi-survey.md`——①mask 通道实测结论（代码生成左/右半 mask PNG → 上传 → LoadImage MASK → SetLatentNoiseMask 是否按预期只重绘掩区）；②inpaint 参数定稿（KSampler denoise 初值 0.7、步数建议、feather 处理——掩区边界是否需要羽化及实现方式）；③完整双角色链拓扑（场景→A→B→收尾）分步耗时与总耗时；④是否需要最终低 denoise 全图统一段（对比有/无的融合质量）

**终态关联：** `F1`（拓扑与参数是 T2 的全部输入）。

**验收标准：**

- [ ] **步骤 1：mask 通道最小验证**

代码生成 912×1216 左半白右半黑 PNG（Node Buffer 构造最小 PNG 或 sips），`/upload/image` 上传，构造最小 graph（LoadImage→VAEEncode 场景→SetLatentNoiseMask→KSampler denoise 0.7 少步数→decode→Preview），提交并确认：只有左半被重绘。

- [ ] **步骤 2：双角色链全跑（两个用例）**

用例①（AI 娘双 LoRA）：场景图（无 LoRA、30 步）→ 左半 inpaint 挂 `aigrilsV1.0` deepseek tags → 右半 inpaint 挂 `claude_girl_anima_lora_clean` claude tags → 成图核对两角色特征。用例②（无 LoRA 双区）：同拓扑不挂 LoRA，左半「school uniform, pleated skirt, school bag」右半「office lady, suit, pencil skirt」→ 成图核对两侧服装成立（验证通用性，不跟 LoRA 绑定）。记录每段耗时。

- [ ] **步骤 3：融合质量对比**

同一 seed 分别跑「有/无最终全图统一段（denoise ≤0.3）」两版，对比角色边界融合度；结论写报告（有收益才进 T2 拓扑，没有就不加，避免白耗时间）。

- [ ] **步骤 4：写报告并给出拓扑定稿建议**

含：节点清单与连线（供 T2 逐节点翻译成 workflow-multi.json）、参数表、耗时预算、风险点。

**建议（待用户授权）：** 无新增测试。

---

### Task 2：多角色管线实现（workflow-multi.json + comfy.ts）

**Deps：** `T1`（理由：消费拓扑定稿、inpaint 参数、耗时预算与融合段决策）

**WritePaths：**
- `src/tools/draw/workflow-multi.json`
- `src/tools/draw/comfy.ts`
- `src/tools/types.ts`（DrawStage 联合类型扩展）
- `src/fish/types.ts`（同上）
- `src/app/runtime.ts`（onDrawStage 实现三元 + `drawStageSent` Map 类型两处触点）
- `prompt/messages.md`（三个新文案 key）

**Resources：** 无（本任务不跑真机；真机在 T4）。

**Files：**
- Create：`src/tools/draw/workflow-multi.json`（按 T1 定稿拓扑；静态部分：加载器/编码/解码/输出；动态部分留给 makeMultiGraph）
- Modify：`src/tools/draw/comfy.ts`（`MULTI_WORKFLOW_HASH` 常量 + 启动校验 + `MultiDraw` 接口 + `makeMultiGraph` + `runMulti`）
- Suggested Test（待用户授权）：`test/tools.test.ts` 新增 makeMultiGraph 结构断言（mask 节点连线、LoRA 注入、两角色 tags 互不混入）

**接口契约：**
- Consumes：T1 报告的节点清单/参数/拓扑；comfy.ts 现有 `comfyUrl`/`request`/`imageBytes`/`openStageSocket`（多阶段复用，阶段映射按新节点序列）；tool.ts 现有 `CHARACTERS`（经参数传入，comfy.ts 不感知角色概念，同单角色先例）
- Produces：
  - `MultiDraw = { prompt: string; left: string; right: string; width: number; height: number; seed?: number; roles?: [{ file: string; weight: number; tags: string }, { file: string; weight: number; tags: string }] }`（roles 可选：AI 娘才传，无 roles 时纯分区生成；两侧 inpaint 的正段 = 内置前缀 + （roles 有则官方 tags）+ left/right 描述；roles 恰好 2 项，机械校验）
  - **内部分区通用化**：`makeMultiGraph` 以 `parts: Array<{ text: string; role?: { file: string; weight: number; tags: string } }>` 为核心实现（N 区，2≤N≤4，机械校验），mask 布局按 N 机械生成（2=左右半、3=左中右竖条、4=四分）；`MultiDraw` 的 left/right 双区形态是 parts 在 N=2 的投影（工具层适配层），后续扩 3 人只改工具层
  - `makeMultiGraph(args, maskNames)`：左/右 mask 用上传后的 `yugang-mask-<uuid>.png`（LoadImage 输入名与 ref 同款强校验）；两段 inpaint 各挂一个 `AnimaLoRARemapTagLoader`（节点 id 避开现役与动态占用：静态 1-11/13/14/41-44 + 动态 19/20/88/90-93）；mask 尺寸与 latent 对齐（912×1216 / 8 = 114×152 latent，区域由代码生成 mask 决定，模型零输入）
  - `runMulti(url, args, onSubmitted, onStage)`：上传两张 mask → 提交 → 轮询取图；**history 轮询 deadline 参数化且 ≥560s**（与 F1 耗时预算对齐，不得照抄 runComfyJob 的 240s）；**与 runComfy 共用模块级 busy 单飞与 `/queue` 空校验**（单/多管线不得并发提交同一台 ComfyUI）；`DrawStage` 扩展 `"multi-scene" | "multi-first" | "multi-second"`（ws 阶段映射按新管线节点序列，T1 实测序列翻译）
  - `MULTI_WORKFLOW_HASH` 校验失败即启动抛错（与单管线同哲学）
- 阶段进度：`onDrawStage` 的 stage 联合类型在 `src/tools/types.ts`/`src/fish/types.ts`/`src/app/runtime.ts` 同步扩展，新文案 key `draw_stage_multi_scene/first/second` 进 `prompt/messages.md`（runtime 侧同款三元选择或映射，保持 `messages["key"]` 字面量形态供死文案检测）；**文案与单管线互不复用**（多人流程步骤更多，拟人措辞体现「逐位作画」节奏，建议内容：scene=背景铺好了开始画第一位、first=第一位好了换第二位、second=人都画齐了最后润色，具体措辞实现时定稿）

**终态关联：** `F2`、`F4`、`F5`。

**验收标准：**

- [ ] **步骤 1：核对 T1 拓扑并落 workflow-multi.json**（严格 JSON 无注释——动态段以键名约定或空输入节点表达，拓扑说明写进 commit message；禁止任何注释形式）

- [ ] **步骤 2：实现 makeMultiGraph / runMulti / hash 校验**（与 T1 报告逐节点对照；roles 数量、mask 文件名格式、LoRA 文件名正则全部机械校验）

- [ ] **步骤 3：跑 `npm test`**（新 hash 校验进启动链；单管线 hash 不变）；记录结果

**建议（待用户授权）：** makeMultiGraph 结构断言（mask 连线/LoRA 双注入/tags 隔离）。

---

### Task 3：工具面接入（tool.ts + schema + TOOL.md + messages + 超时）

**Deps：** `T2`（理由：消费 `runMulti`/`MultiDraw` 接口与扩展后的 DrawStage）

**WritePaths：**
- `src/tools/draw/tool.ts`
- `src/tools/draw/schema.json`
- `src/tools/draw/TOOL.md`
- `src/tools/draw/messages.json`
- `src/app/runtime.ts`（仅 `toolTimeoutOverrides.draw: 360 → 600` 一处，与 T2 的阶段扩展触点互不重叠）
- `AGENTS.md`（§15 超时行 360→600 同步 + draw 工具描述行补双管线一句）
- `test/**`（仅既有断言最小同步）

**Resources：** 无。

**Files：**
- Modify：见 WritePaths
- Suggested Test（待用户授权）：characters 互斥/长度校验断言

**接口契约：**
- Consumes：T2 的 `runMulti`；现有 `CHARACTERS`/`RATIO_SIZES`/`deps.onDrawStage`
- Produces：
  - schema：`left`/`right`（必填 string，两侧角色描述）；`characters` 可选数组（`items.enum` = 单角色同枚举，`minItems: 2, maxItems: 2`，描述写明「AI 娘双人时传，官方外观自动并入对应侧，不传则两侧纯 prompt 描述」）；与 `character` 的互斥在 tool.ts 机械校验（同时传 → tool 错误 `draw_characters_conflict`，文案含 next：二选一）
  - tool.ts：`characters` 命中 → 查 `CHARACTERS`×2 → `runMulti(...)`；出图落 `gen/` 与出口回执同单角色；一轮一次额度/inflight/uncertain 语义复用（多角色也算一次画图）；**multi 路径参数矩阵（初期）**：`preset` 与 `ref` 同时传入 → tool 错误 `draw_multi_unsupported`（文案写明 multi 不支持这两项，next: 去掉后重试）；`hand_repair` 语义按 T1 拓扑定稿写明（如最终段是否含修复段）
  - TOOL.md：多角色段落（何时用 left/right+characters、左右由谁先谁后决定、AI 娘与任意双角色两种用法、服装 tag 查询引导同单角色、耗时提示）
  - messages.json：`draw_characters_conflict` + `draw_characters_count`（长度≠2，文案含 next）+ `draw_multi_unsupported`（preset/ref 与 multi 互斥，文案含 next）；死文案检测可引用的字面量形态
- 启动一致性校验扩展：schema `characters.items.enum` 与 `CHARACTERS` 键集一致（与单角色 enum 同款断言，同一处抛错）

**终态关联：** `F3`、`F5`。

**验收标准：**

- [ ] **步骤 1：核对 T2 接口与现有 execute 流程**（额度/inflight/uncertain 状态机在 multi 路径同样生效）

- [ ] **步骤 2：实现参数/校验/文案/超时**（互斥、长度、枚举、启动一致性、600s、AGENTS.md 两处文档同步）

- [ ] **步骤 3：`npm test` + `npm run prompts`**（含漂移自证：schema enum 改错 → 启动抛错 → 还原，try/finally 包裹，前后 git status 对拍）

**建议（待用户授权）：** 互斥与长度校验断言。

---

### Task 4：真机验收

**Deps：** `T3`（理由：需要完整工具路径的 `makeMultiGraph` 真实产物与阶段文案）

**WritePaths：** `/tmp/draw-multi-e2e.ts`（验收脚本，仓库外）、`/tmp/draw-multi-e2e.png`。

**Resources：** Windows ComfyUI 在线（SSH 隧道，1 个并发）；通道同 T1（先 read `/Users/mhbzhy/.agents/skills/home-windows-connect/SKILL.md`）。

**Files：**
- Create：`/tmp/draw-multi-e2e.ts`（验收脚本，仓库外）、`/tmp/draw-multi-e2e.png`、`/tmp/draw-multi-e2e.log`（阶段时序与耗时日志）
- Modify：无

**接口契约：**
- Consumes：`runMulti`；`CHARACTERS` 的 deepseek/claude 四元组（用例①）；无 LoRA 用例的两侧服装 tags（用例②）
- Produces：`/tmp/draw-multi-e2e.png`（双角色成图）+ 阶段触发时序日志

**终态关联：** `F6`。

**验收标准：**

- [ ] **步骤 1：跑通验收脚本**（deepseek 左 + claude 右，flower field 场景，912×1216；记录三阶段 onStage 时序与总耗时）

- [ ] **步骤 2：人工看图**（主人确认：左侧蓝发渐变鲸尾女仆特征、右侧橙发花饰特征，边界融合自然；不像则回 T2 调 denoise/步数重验）

- [ ] **步骤 3：回归记录**（`npm test` + `npm run prompts` 终态复跑，输出存证）

**建议（待用户授权）：** 无新增测试。
