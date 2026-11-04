# 模型输入模板与自主交流机制实现计划

> **给执行 agent：** 必须逐任务执行本计划；步骤使用 `- [ ]` 复选框跟踪。只有整体交付终态全部验证通过，才算计划执行完成；未满足时持续修复与验证。执行方式由计划编写完成后的用户选择决定。

**目标：** 将所有现行模型输入（含合并转发附件）统一到已裁定的消息模板，废除旧账、弹药库及后台逛轮，以零新增主动轮支持会话自主逛 B 站并分享，同时保持压缩调用不变、换页尾部消息格式一致。

**架构：** 以共享消息渲染器统一 `[m:id][标签] 昵称(QQ): 正文`、消息边界、引用原文和后置合集附件；answer/open/GIF/新闻只保留场景必需的模板差异。open 空窗按既有 `video.browseChance` 门生成主动交流机会，视频池按 conversationId 隔离，`say_words(videoBvid=...)` 在当前 browse 轮内原子保存并入队。压缩 prompt 与剖面卡片不动，仅重写换页尾部为真实顺序消息列表。

**技术栈：** TypeScript、pi-durable session doc / transaction、现有 `engage-next`、`bili-client`、工具包 manifest、OneBot、现有 outbox。

## 全局约束

- 需求权威为 `docs/decisions/2026-11-04-model-input-templates.md`；消息行固定为 `[m:id][可选标签] 昵称(QQ): 正文`，`: ` 后只放当前消息正文。
- 当前 decisions、主计划与报告尚未跟踪，managed worktree 中可能不存在；执行 child 必须只读主仓库绝对路径 `/Users/leshi.zhy/yugang/docs/decisions/2026-11-04-model-input-templates.md` 与 `/Users/leshi.zhy/yugang/docs/plans/2026-11-04-model-input-templates.md`，不得复制、提交或修改权威文档，不得因 worktree 缺文件推断合同缺失。T7 测试 helper 默认使用仓库相对路径，child 在 worktree 自验时可用 `YUGANG_DECISIONS_PATH` 指向上述绝对路径，禁止把本机路径写死为测试默认值。
- `docs/plans/2026-11-04-personal-video-browse.md` 的自主浏览与即时分享范围已并入本计划，不得作为另一份实施计划重复派发；如有冲突，以本计划和上述决策文档为准。
- 所有消息列表严格按真实接收顺序排列；不得为分组、强调当前消息或附加引用而重排。
- 模型可见共享文案只能来自 `prompt/`；工具说明、Schema 和工具专属文案只能来自对应 `src/tools/<name>/TOOL.md`、`schema.json`、`messages.json`。
- 不在 `src/` 内嵌大段模型文案；模板变量严格替换；新增能力按工具包契约注册。
- 所有外发继续只走 `say_*` 和 outbox，不得在视频浏览工具中直接调用 QQ emit。
- 主会话 inline 与 `look` fallback 都只能读取压缩图；不得把未压缩原图交给模型。
- 不把 image block 插入消息列表中间；使用 `[图片#N]` 与列表后的 `[图片#N 压缩图]` 关联。
- 每个群 × 当前人格会话独立拥有视频池；不同会话不得共享视频池或互相 claim。
- B 站外部文本继续按现有不可信边界清洗；模型不能提供 canonical URL，链接由宿主根据已核验 BV 拼接。
- 合并转发父消息保持真实顺序，展开内容只作消息列表后的附件；保留三条触发路径、背景短标记、前 10 条/2 张子图和嵌套不递归，缺少真实子消息 ID/QQ 时不得伪造。
- 旧弹药库、worker、claim/shared 和 `ammo_*` 源码保留作兼容代码，但不进入 active 工具面、调度、active messages 合并视图或模型文案。
- `prompt/handoff.md`、压缩输出 `threads / promises / mood`、剖面卡片和逐字校验保持不变；仅修改换页尾部。
- 既有测试只运行和修复与本次行为直接相关的回归。用户已明确授权独立 T7 新建 `test/model-input-templates.test.ts` 与 `test/support/authoritative-templates.ts`，并为这些测试使用固定内存 fixture；其它新增测试、fixture、提交和部署仍未授权。
- 实现后必须运行 `npm run prompts` 和 `npm test`；生产 Mac 的配置、数据库、进程和部署不在本计划内。

## 整体交付终态

| ID | 必须成立的条件 | 验证方法与环境 | 通过判据 | 证据位置 | 覆盖任务 |
| --- | --- | --- | --- | --- | --- |
| F1 | answer、私聊、open 与 GIF 的 user 输入使用统一消息行和边界；回复原文后置，合并组及背景保持真实顺序 | 本地源码核对、`npm run prompts`、相关既有测试 | 不再出现 `回复msg:`、`➤`、正文内嵌引用原文；标签在昵称前，引用含被引 ID/昵称/QQ | 命令输出与 diff | T1、T2、T5 |
| F2 | inline 图片以编号关联压缩图 block，fallback 保持路径并提示 `look`；两条路径均无原图 | 本地核对 `submitRound`、`shrinkForModel`、相关既有测试 | `[图片#N]` 与 `[图片#N 压缩图]` 一一对应，block 来自 `shrinkForModel`；无 `ctx_image_attached` 原图文案 | diff 与测试输出 | T2 |
| F3 | open 有消息时使用标准模板；空窗不再由沉默/旧账/弹药触发，只在每个 open 窗一次 0.3 门开时提交主动交流模板；ammo 工具与 worker 不再 active | `npm run prompts`、`npm test`、核对 `engage-next` / `index` / loader | 主动轮文案与裁定一致；gate/topic 同窗稳定；无 nudge/debt/worker/refill/ammo active 调用；旧源码仍在 | 命令输出与 diff | T3 |
| F4 | 当前 browse 轮可自主发现、实际观看并分享视频，私有池按 conversationId 去重，链接 canonical，写入与 outbox 同事务 | 本地事务/工具路径核对、`npm test`、T8 人工核对记录 | 非授权轮拒绝；未实际看过的 BV 拒绝；同 BV 跨会话不互斥；失败回滚；视频分享通过末条自言素材校验；普通用户视频查看不破坏 | diff、测试输出与计划执行记录 | T3、T4 |
| F5 | 新闻和 GIF 使用独立任务模板且新闻调度独立存活 | `npm run prompts`、`npm test`、源码核对 | 新闻为 `[新闻播报]`；GIF 为 `[GIF 收图任务]` 且只看压缩图；新闻 scheduler 不受 ammo 停用影响 | 命令输出与 diff | T5 |
| F6 | 换页前部剖面不变，尾部统一为真实顺序标准消息列表，无旧窗口说明/旧账/工具过程 | 本地核对 `compact.ts`、`prompt/handoff.md` diff、`npm test` | `handoff.md` 零改动；尾部为 `[历史消息]` + 边界 + 消息行；无 `鱼:` 专用行、open footer、thinking/toolResult | diff 与测试输出 | T6 |
| F7 | 当前交付通过仓库全量既有检查，模型可见文档无已停用机制引导 | 本地 `npm run prompts`、`npm test`、`git diff --check` | 三命令 exit 0；runtime/tool_catalog/active TOOL.md/active messages 无 ammo/worker/旧账主动提醒；报告与计划记录真实验证结果 | 命令输出、计划执行记录 | T7 |
| F8 | 合并转发保留三条触发路径与背景短标记；父消息使用标准行，展开附件后置且子消息有序，子图只走压缩链 | 本地源码核对、`npm test`、T8 人工核对记录 | 回复合集专用放行不恢复普通回复必答；无 @ 自带合集零成本丢弃；补展开附件不再前置；最多 10 条/2 图、嵌套不递归；不伪造子消息 ID/QQ；换页不补拉合集 | diff、测试输出与计划执行记录 | T1、T2、T6 |
| F9 | `prompt/handoff.md` 相对实施前基线零改动 | 本地 `git diff --exit-code -- prompt/handoff.md` | 命令 exit 0；压缩 prompt 未被任何任务修改 | 命令输出、计划执行记录 | T6 |
| F10 | decisions §10 矩阵中的每个 input 场景都由独立测试任务触发真实拼装，并与 decisions 权威模板精确比对 | 本地 `node --test test/model-input-templates.test.ts`，随后全量 `npm test` | 16 个 scene 均有真实入口触发器；文本、换行、附件顺序及图片 block 精确相等；open injection/shard 分别执行；缺场景、复制生产组装逻辑或修改 decisions 均不算通过 | 聚焦测试与全量测试输出、测试 diff | T7 |

**完成规则：** 所有必要条件同时满足，且验证证据对应当前交付版本，才能标记计划执行完成；仅完成任务步骤不能替代终态验证。机械命令 exit 0 只证明其实际覆盖范围；自主浏览、私有池事务等 F10 未覆盖的新行为，必须由 T8 回填对应当前 diff 的人工核对记录，不得把测试绿或命令成功夸大为新行为已自动验证。

**未满足时：** 在已授权范围内持续 `fix → test（验证）→ 对照终态`，修复后重验受影响条件；真实阻塞记录为未完成，并写明恢复下一步。

## 文件结构与职责

- `src/qq/model-input.ts`：唯一消息行、消息边界、引用原文、合集附件与附加段渲染器。
- `src/qq/onebot.ts`：把直接回复水合为结构化 `QuotedMessage`，把合集展开为结构化 `ForwardAttachment`，不再把引用或合集原文混入当前正文。
- `src/qq/debounce.ts`：answer 的真实顺序消息选择、合并组、后置附加段与图片编号。
- `src/qq/gate.ts`：结构化标签和昵称渲染，不再输出旧 `回复msg:` 头。
- `src/qq/round-images.ts`：一轮图片输入规划（编号、压缩 block、末尾标签、`look` fallback、合集子图换编）的唯一实现；宿主与 T7 测试共用同一入口。
- `src/qq/round-input.ts`：轮级输入装配（`backgroundTextOf` / `renderOpenMessageList` / `renderBrowseOpportunity` / `renderGifIngestInput` / `assembleRoundContent` / `submitContentOf` / `appendVoiceHint`）的唯一实现；宿主与 T7 测试共用同一入口。
- `src/external/news-broadcast.ts`：新闻成品与任务输入渲染（`renderNewsBroadcast` / `renderNewsTask` / 预算常量）的唯一实现；宿主与 T7 测试共用同一入口。
- `src/external/video-browse.ts`：open gate、当前轮 viewed BV 注册与清理。
- `src/external/video-pool.ts`：会话私有视频池、BV 去重与 canonical URL。
- `src/index.ts`：各场景接线、图片 block、主动轮与调度启停，不写模型文案。
- `src/compact.ts`：换页尾部投影及当页已见合集附件保留；压缩 prompt/剖面逻辑不改，不在换页时补拉合集。
- `test/support/authoritative-templates.ts`：独立测试专用，只读解析 decisions 的场景矩阵、模板围栏与图片 block。
- `test/model-input-templates.test.ts`：独立测试专用，以固定输入触发各真实场景拼装并精确比较完整 content。

## DAG

### T7 前置修复（主会话，2026-11-04，事后追认）

T7 首次启动即停在停点上报：decisions §10 的 16 个 scene 里有 10–11 个的真实拼装代码在零导出、
导入即启动宿主的 `src/index.ts` 内，测试无法安全触达；而合同禁止测试复制生产组装逻辑。裁定 A：
把这些拼装抽成可导入的生产模块，让 `src/index.ts` 调用同一实现（不开测试后门、不复制组装），T7 再从真实
模块入口取得 actual。由此新增的三个模块是**生产代码**（不是测试专用 shim），其写路径不在 T2/T3/T5
原始声明内，在此追认并补进「文件结构与职责」：

- `src/qq/round-images.ts`（原 `src/index.ts` 的 `planRoundImages` / 合集子图换编）
- `src/qq/round-input.ts`（原 `src/index.ts` 的 `backgroundTextOf` / `engageModelMessages` / 主动轮文案 / GIF 输入装配 / answer 附加段装配 / content block 组装 / 语音提示拼接）
- `src/external/news-broadcast.ts`（原 `src/index.ts` 的新闻渲染与任务输入）

核对口径：`src/index.ts` 对应调用点只做转发（`flushBurst`、`submitRound`、`maybeIngestGif`、`submitInjectionRound`、`submitShardRound`、`runNewsJob`），没有第二套渲染实现；三模块内无测试专用开关、无环境变量分支。

```text
T1（消息/回复/合集结构契约）──> T2（answer/私聊/图片）
T1、T2 ─────────────────────> T3（open/主动轮/停用 ammo）
T2、T3 ─────────────────────> T4（自主浏览与即时分享）
T3、T4 ─────────────────────> T5（GIF/新闻）
T1、T3、T4、T5 ─────────────> T6（换页尾部与 system 文案）
T6 ─────────────────────────> T7（独立权威模板机械测试）
T7 ─────────────────────────> T8（终验与记录）
```

## Waves

- Wave 1：T1（共享契约）
- Wave 2：T2（answer/私聊/图片）
- Wave 3：T3（在 T2 的 `src/index.ts` 当前版本上接入 open 与主动门）
- Wave 4：T4（依赖 T2 的图片输入与 T3 的 browse 授权）
- Wave 5：T5（在 T4 的 `src/index.ts` 当前版本上接入 GIF/新闻）
- Wave 6：T6（整合 system 文案和换页尾部）
- Wave 7：T7（独立 subagent 编写并运行权威模板机械测试）
- Wave 8：T8（最终验证与执行记录）

**关键路径：** T1 → T2 → T3 → T4 → T5 → T6 → T7 → T8。

---

### Task 1：共享消息模板、直接回复与合集结构契约

**Deps：** `none`

**WritePaths：**
- `src/qq/model-input.ts`
- `src/qq/onebot.ts`
- `src/qq/gate.ts`
- `src/qq/debounce.ts`（仅类型导入与接口声明，不改渲染行为）
- `prompt/messages.md`

**Resources：** `none`

**Files：**
- Create：`src/qq/model-input.ts`，定义 `ModelMessage`、`QuotedMessage`、`ForwardAttachment`、`ForwardChildMessage`、`MessageBlockParts` 与纯渲染函数。
- Modify：`src/qq/onebot.ts:205-309,497-563`，直接回复与合集水合输出结构化附件而非拼入 `parsed.text`；保留合集 id 缓存与真实子消息元数据。
- Modify：`src/qq/gate.ts`，标签渲染改为新标准；保留回复合集专用放行和无 @ 自带合集零成本丢弃，不恢复普通回复必答。
- Modify：`prompt/messages.md`，集中声明所有新模板 key（含合集父消息、附件、短标记），删除将被替代的旧 answer/open/GIF/news 文案；ammo 停用文案归 T3。

**接口契约：**
- Consumes：现有 `IncomingMessage`、OneBot `replyIds` / `forwardIds` / `repliedForward`、`get_msg` / `get_forward_msg` 返回、主人/特别关注身份。
- Produces：
  - `ForwardChildMessage={position:number; messageId?:number|string; userId?:string; nickname:string; text:string; images:readonly string[]}`；
  - `ForwardAttachment={id:string; sourceMessageId?:number|string; total:number; children:readonly ForwardChildMessage[]; truncated:boolean}`；
  - `QuotedMessage={id:string; nickname:string; userId:string; text:string; images:readonly string[]; forward?:ForwardAttachment}`；
  - `ModelMessage={messageId?:number|string; userId:string; nickname:string; text:string; mentionsBot:boolean; replyIds:readonly string[]; master:boolean; watched:boolean; quoted?:QuotedMessage; forward?:ForwardAttachment}`；
  - `renderMessageLine(message, messages): string`；
  - `renderMessageList(lines, messages, kind:"group"|"private"|"history"): string`；
  - `renderQuotedOriginal(quoted, messages): string`；
  - `renderForwardAttachment(forward, messages): string`，以 `[合集#N]` 保持子消息顺序，仅渲染真实存在的子消息 ID/QQ；
  - `MESSAGE_LIST_START="> 消息起始"`、`MESSAGE_LIST_END="> 消息结束"` 由模板 key 提供。

**终态关联：** `F1`、`F8`。

**验收标准：**

- [x] **步骤 1：核对真实入口、身份和已有合同**

确认 `get_msg` 只展开直接一层，文本 200 字、图片 2 张的现有限额不变；确认回复段原文从 `parsed.text` 移除后仍保留 replyIds 供出口强制引用。核对合集三条触发路径、最近合集 10 分钟缓存、前 10 条/2 子图/嵌套不递归限制，以及当前 gate 与仓库已裁定合集专用例外的差异。

- [x] **步骤 2：完成最小实现**

实现标签顺序 `m → 回复 → 转发合集 → @ → 主人/特别关注`，昵称与 QQ 始终在 `: ` 前；实现群聊/私聊/历史三种边界模板、`[引用原文]` 与后置合集附件。`onebot` 水合填充 `quoted` / `forward`，失败保留显式读取失败附加信息，不把引用或合集文本混进当前正文；子消息只使用 API 真实返回的 ID/QQ。gate 对回复合集放行、对无 @ 自带合集零成本拒绝，普通回复仍按 @/open 判定。

- [x] **步骤 3：运行适用的既有检查并记录结果**

运行：`npm test`、`npm run prompts`。只记录当前契约改动造成的预期回归，不在后续任务未完成时误判终态。

- [ ] **建议（待用户授权）：新增测试或全新 fixture/压力场景**

为 `renderMessageLine`、标签顺序、多发送者真实顺序、直接回复结构、合集附件顺序与缺失子消息元数据增加纯函数测试。

### Task 2：answer、私聊与压缩图片输入

**Deps：** `T1`（理由：消费 `ModelMessage`、`QuotedMessage` 和共享渲染器）

**WritePaths：**
- `src/qq/debounce.ts`
- `src/index.ts`

**Resources：** `none`

**Files：**
- Modify：`src/qq/debounce.ts:321-414`，以真实顺序输出背景与 burst，不再输出 `➤`、目标说明和重复 seen/footer。
- Modify：`src/index.ts:926-961,1152-1212`，图片编号、文本引用、合集附件与压缩 image block 接线；私聊使用私聊边界，最近合集补展开移到消息列表后。
- Verify：`src/media/shrink-image.ts`，只核对压缩合同，不预期修改、不列入 WritePaths。

**接口契约：**
- Consumes：T1 消息/引用/合集渲染器、现有 `arrivalSeq`、`withContext` 背景去重、`inlinePick`、`shrinkForModel`。
- Produces：`withContext` 返回标准 user 文本及 `quoteIds`；普通引用、合集附件、最近合集补展开依次位于消息列表后；`submitRound` 的 content 为一个 text block 后随压缩 image blocks；每张直发图/合集子图编号与消息或附件内 `[图片#N]` 一致。

**终态关联：** `F1`、`F2`、`F8`。

**验收标准：**

- [x] **步骤 1：核对真实入口、身份和已有合同**

确认 answer 锚点、burst、背景与 quoteIds 仍来自同一组消息，禁止渲染重排后出口引用绑定到别的消息；GIF 不进入 inline，普通轮最多 2 张的限制不变；合集子图与直发图共享编号和压缩路径，背景合集仍只显示短标记。

- [x] **步骤 2：完成最小实现**

answer 与私聊接入共享模板；将 inline 选图结果映射为 `[图片#N]`，文本末尾附 `[图片#N 压缩图]`，每个标签后仅附对应 `shrinkForModel` block。非 inline 保留 `inbound/` 路径，并追加 `[本轮要求] 使用 look 工具读取消息中的图片。` 直接合集、回复合集与最近合集补展开都使用后置附件，不再把补展开内容前置到标准消息列表之前。

- [x] **步骤 3：运行适用的既有检查并记录结果**

运行：`npm test`、`npm run prompts`。记录引用白名单、inline/fallback、图片压缩及普通视频等回归结果。

- [ ] **建议（待用户授权）：新增测试或全新 fixture/压力场景**

为两图顺序、GIF 排除、图片编号与 block 对齐、fallback 提示、三类合集触发与后置附件增加入口测试。

### Task 3：open 标准输入、零新增主动门与 ammo 停用

**Deps：** `T1`（理由：复用标准消息列表和模板 key）；`T2`（理由：在 answer 已接入的 `submitRound` 当前合同上增加 open/主动轮，避免两套 content 形状并存）

**WritePaths：**
- `src/external/video-browse.ts`
- `src/engage-next.ts`
- `src/index.ts`
- `src/fish-config.ts`
- `src/tools/loader.ts`
- `src/tools/types.ts`
- `src/tools/config/TOOL.md`
- `prompt/messages.md`

**Resources：** `none`

**Files：**
- Create：`src/external/video-browse.ts`，定义 `VideoBrowseGate={windowId,topic,open}`、宿主 gate 存取、viewed BV 登记/查询/轮末清理。
- Modify：`src/engage-next.ts`，每个 open 窗一次 `video.browseChance` 门与四 topic 随机选择，关窗清空。
- Modify：`src/index.ts`，injection/shard 用标准列表；空窗只在 gate 开时提交主动模板；摘除 nudge/debt/ammo/worker/refill/manual ammo 接线；在保留的 active 配置/开窗接线中把 `video.dailyBudget` 接入 `syncBiliBudget`，不得依赖已停用 scheduler 的 tick。
- Modify：`src/fish-config.ts`，启用 `video.browseChance=0.3`、`browseMaxViewsPerRound=5`、`dailyBudget=60`，旧 `ammo.dailyBudget` 只作回退。
- Modify：`src/tools/loader.ts`，disabled package 仍做 manifest/factory/messages 完整性校验，但不进 active/deferred/catalog，disabled manifest 的 tool-messages 也不并入 active messages 合并视图。
- Modify：`src/tools/types.ts`，落地 `RoundTrigger.browseWindow/browseTopic` 与浏览工具窄依赖。
- Modify：`src/tools/config/TOOL.md`，active 字段表改为 `video.browseChance` / `video.browseMaxViewsPerRound` / `video.dailyBudget`，保留旧 ammo 配置兼容说明。
- Modify：`prompt/messages.md`，删除 `worker_browse_task`、`say_worker_round`、`ammo_*`、`ctx_engage_nudge_*`、`ctx_engage_ammo_*` 等停用 key；把 `say_self_mute` 改为认可 `videoBvid` 的合法素材分享且不再提 `ammoId`。

**接口契约：**
- Consumes：T1 列表渲染、既有 `random` 注入点、`submitInjectionRound`。
- Produces：`VIDEO_TOPICS=["二次元","游戏","军事","数码"]`；`RoundTrigger.browseWindow/browseTopic`；`wireVideoBrowseHost`、`videoBrowseGateOf`、`recordViewedVideo`、`viewedVideoOf`；零新增固定模板。

**终态关联：** `F3`。

**验收标准：**

- [x] **步骤 1：核对真实入口、身份和已有合同**

确认新闻 scheduler 与 external B 站 scheduler 独立；ambient shard 不获得 browse 授权；空窗债务和外部弹药不再成为起轮理由。

- [x] **步骤 2：完成最小实现**

open 进入时一次掷门并选 topic；仅 gate 开且无积压时提交 `[主动交流机会]` 模板；有消息 injection/shard 统一标准列表。停用 active ammo 工具、scheduler、refill、manual trigger、分享挂点及其中心/工具包文案但保留旧文件；同步新的每日预算热加载挂点。

- [x] **步骤 3：运行适用的既有检查并记录结果**

运行：`npm test`、`npm run prompts`。记录工具 surface、active messages 合并视图、新闻接线、gate 与配置兼容结果。`test/tools.test.ts` 的 deferred 名单、`test/prompts.test.ts` 的“所有 manifest 都进入工具面”和“中心文案条数 + tool message 条数”断言属于本任务直接相关预期回归，可按全局约束随生产修复同步调整；不得新增测试文件。

补充（T8 终验发现 → 主会话修复 → 复验）：T8 初判 F3 未满足——`src/index.ts` settle 的 `finally` 仍调用 `engageNext.noteExit(chatKey)`，沉默计数仍由宿主上报。复核确认 `silenceOf` 在宿主与脚本侧零调用（该计数当时只写日志、不驱动任何模型面），但保留上报就是给 nudge 留了活接线。修复：删除该调用与 `exits` 读数，`src/index.ts` 与 `src/engage-next.ts` 的注释改为明确「noteExit / silenceOf 与 shareGateOf 同待遇：兼容源码、宿主无消费方、不得据此重新接线」。复验：`node --test test/model-input-templates.test.ts` 19/19、`npm test` 113/113、`node --test test/startup.test.ts` 通过、`npm run prompts` exit 0。

- [ ] **建议（待用户授权）：新增测试或全新 fixture/压力场景**

为 `random=0/0.3/大于0.3`、同窗稳定、ambient 无授权、空窗仅 gate 起轮增加状态机测试。

### Task 4：会话自主浏览、私有池与即时分享

**Deps：** `T2`（理由：保留普通图片/视频输入行为）；`T3`（理由：消费 browseWindow/topic 和 viewed registry）

**WritePaths：**
- `src/external/video-pool.ts`
- `src/index.ts`
- `src/tools/bili_hot/tool.ts`
- `src/tools/bili_hot/TOOL.md`
- `src/tools/bili_hot/schema.json`
- `src/tools/bili_video/TOOL.md`
- `src/tools/video/tool.ts`
- `src/tools/video/TOOL.md`
- `src/tools/say-shared.ts`
- `src/tools/say_words/tool.ts`
- `src/tools/say_words/TOOL.md`
- `src/tools/say_words/schema.json`

**Resources：** `none`（验证只用本地 faux/纯函数，不打线上客户端，因而不占用线上 B 站客户端资源）

**Files：**
- Create：`src/external/video-pool.ts`，`fish.video_pool` session doc、清洗、BV 去重和 `videoUrlOf(bvid)`。
- Modify：`bili_hot`，仅授权 browse 轮按宿主 topic 取候选并用当前会话 pool 过滤。
- Modify：`src/tools/bili_video/TOOL.md`，明确它只是普通元数据核实工具、不构成 browse 的“实际看过”证明；自主浏览最终必须调用 `video` 成功观看后才能分享，避免模型误走旧“核实后入库”流程。
- Modify：`video`，普通路径不变；browse 轮最多 5 次并登记实际成功查看的 BV。
- Modify：`say_words`，新增 `videoBvid`，同事务写 pool 和 outbox；旧 ammo 内核保留但模型 Schema 不再暴露 ammoId；末条自言校验把该字段视为合法素材分享。

**接口契约：**
- Consumes：T3 gate/viewed registry、conversationId、现有 `BiliVideoCard` 清洗与 `OutboxDoc`。
- Produces：`VideoPoolDoc`、`applyVideoPoolAdd`；`say_words(videoBvid)` 仅在当前会话当前 browse 轮已看过 BV 时生成 canonical 链接并入队；失败不消耗出口额度。

**终态关联：** `F4`。

**验收标准：**

- [x] **步骤 1：核对真实入口、身份和已有合同**

确认 `bili_hot` 不再读全局 ammo 过滤；普通 answer 的 video URL/opus 路径不登记 browse viewed；`bili_video` 元数据核实同样不登记 viewed；浏览授权不能只按群 open 推断。

- [x] **步骤 2：完成最小实现**

实现 topic 映射、pool 过滤、连续查看上限与 viewed 绑定；在 `say_words` 中核对 browseWindow 和 viewed BV，事务完成 pool 去重写入、canonical URL 和 outbox 入队，跨会话无 claim。

- [x] **步骤 3：运行适用的既有检查并记录结果**

运行：`npm test`、`npm run prompts`。记录普通 video、出口额度、self-mute、Schema 和事务失败路径。

- [ ] **建议（待用户授权）：新增测试或全新 fixture/压力场景**

为跨会话同 BV、未看拒绝、轮末清理、超限、事务 rollback 和双会话独立发送增加工具/事务测试。

### Task 5：GIF 与新闻任务模板

**Deps：** `T3`（理由：复用已清理的调度接线并保证新闻独立）；`T4`（理由：在自主浏览完成后的 `src/index.ts` 当前版本上合并 GIF/新闻接线）

**WritePaths：**
- `src/index.ts`
- `prompt/runtime.md`

**Resources：** `none`

**Files：**
- Modify：`src/index.ts` 的 GIF ingest 段（约 711–770 行）与新闻 scheduled answer 渲染段（约 2560–2640 行）：GIF 输入改为标准消息列表加 `[GIF 收图任务]`；新闻轮改为 `[新闻播报]` + 成品。
- Modify：`prompt/runtime.md`，写明 GIF 只能读取压缩图及新闻单条出口规则。

**接口契约：**
- Consumes：T1 模板 key（经 T3 当前版本）、现有 GIF prior、news digest、news scheduler。
- Produces：GIF 任务绑定具体 `[m:id]`；新闻任务不再含重复触发说明，新闻 job 独立注册。

**终态关联：** `F1`、`F5`。

**验收标准：**

- [x] **步骤 1：核对真实入口、身份和已有合同**

确认 GIF 任务不包含 say 出口、图片仍是压缩路径；新闻渲染的日期、topic、source、canonical URL 和幂等键不变。

- [x] **步骤 2：完成最小实现**

用标准列表渲染 GIF 环境与目标消息，追加任务段；新闻只保留 `[新闻播报]` 与成品正文，不改变调度及失败降级。

- [x] **步骤 3：运行适用的既有检查并记录结果**

运行：`npm test`、`npm run prompts`。记录 GIF 收图、meme_add、新闻 scheduler 与出口回归。

- [ ] **建议（待用户授权）：新增测试或全新 fixture/压力场景**

为 GIF 目标 ID 绑定、无出口和新闻模板正文保真增加入口测试。

### Task 6：换页尾部与 system 标签语义收口

**Deps：** `T1`（消息渲染器）；`T3`（停用机制清单）；`T4`、`T5`（active 工具和任务语义已稳定）

**WritePaths：**
- `src/compact.ts`
- `prompt/runtime.md`
- `AGENTS.md`
- `README.md`
- `fish.config.example`

**Resources：** `none`

**Files：**
- Modify：`src/compact.ts:400-467,668-730`，剖面卡片不变，机械尾部改为 `[历史消息]` 标准列表；只保留当页模型实际见过的合集附件，不补拉新内容。
- Modify：`prompt/runtime.md`，集中定义标签、open/零新增/自主浏览/实际看过后分享/图片关联/合集附件规则，删除 ammo/worker/旧账主动提醒。
- Modify：`AGENTS.md`、`README.md`，使运行行为与 active 机制一致。
- Modify：`fish.config.example`，把 active 示例与注释从 ammo 门/预算收口到 video 字段，旧字段只标明兼容回退。

**接口契约：**
- Consumes：T1 消息行模板、现有 counted entry 中实际模型见过的 inbound/outbound 文本。
- Produces：真实顺序的历史尾部及当页已见合集附件；`prompt/handoff.md` 与 `PageProfile` 完全不变；历史尾无 open footer、旧账、thinking/toolResult，未展开或仅在背景出现的合集不会在换页时补展开。

**终态关联：** `F3`、`F6`、`F8`、`F9`。

**验收标准：**

- [x] **步骤 1：核对真实入口、身份和已有合同**

确认尾部只来自被压缩页模型实际见过的消息，不读 recent/chatlog；群友与鱼的消息 ID 必须来自原 entry，不得编造。

- [x] **步骤 2：完成最小实现**

保留 `buildProfileHandoff` 的剖面前部，替换 `mechanicalTail` 投影为标准列表；没有真实 ID 的历史兼容项按既有锚点规则保留可读文本但不伪造 `[m:id]`。合集父消息与当页已见附件按同一渲染合同保留，缺子消息 ID/QQ 时不伪造。更新 system、配置示例与运维文档。

- [x] **步骤 3：运行适用的既有检查并记录结果**

运行：`npm test`、`npm run prompts`、`git diff --exit-code -- prompt/handoff.md`，记录三者 exit；最后一条为 F9 的机械终检。

- [ ] **建议（待用户授权）：新增测试或全新 fixture/压力场景**

为尾部顺序、鱼/群友统一行、open footer 排除、当页已见合集附件保留和旧数据缺 ID 兼容增加 compact 测试。

### Task 7：独立权威模板机械测试

**Deps：** `T6`（理由：T1–T6 的真实场景拼装入口均已交付；测试只消费这些入口，不参与其实现）

**WritePaths：**
- `test/model-input-templates.test.ts`
- `test/support/authoritative-templates.ts`

**Resources：** `none`

**Files：**
- Create：`test/support/authoritative-templates.ts`，只读解析 `docs/decisions/2026-11-04-model-input-templates.md` 的 `input-scene-matrix`、`input-template:*` fenced blocks 与图片 JSON。
- Create：`test/model-input-templates.test.ts`，为矩阵 16 个 scene 提供真实入口触发器、固定内存输入和精确比较。

**接口契约：**
- Consumes：decisions §10 的 scene/template 矩阵；T1–T6 已声明的真实渲染与场景入口。测试必须由未参与 T1–T6 的独立 subagent 新开 run 执行。
- Produces：`loadAuthoritativeScenes()` / `loadAuthoritativeTemplate(id)` 测试 helper；每个 scene 的实际 content 获取与 `assert.equal` / `assert.deepEqual` 精确断言。不得产出或修改任何生产接口。

**终态关联：** `F10`。

**验收标准：**

- [x] **步骤 1：只读核对权威矩阵和真实入口**

完整读取 decisions，建立 scene → 模板/图片 block → 真实拼装入口映射。确认 answer、私聊、inline/fallback、open injection、open shard、零新增、新闻、GIF、三类合集展开、背景合集、普通/合集换页均有可触达入口。不得复制生产组装函数生成 actual；入口无法触达时列出事实并停止上报。

- [x] **步骤 2：实现独立测试 helper 与全场景机械测试**

helper 直接读取 decisions，严格校验标记唯一性、JSON、场景覆盖和占位符残留；只移除围栏，不 trim 或归一化正文。测试以固定内存消息/卡片/entry 触发真实入口，精确比较多段模板拼接后的完整文本；图片额外断言 text block 在前、压缩 image blocks 顺序、base64 和 MIME。open injection 与 shard 分别执行。不得修改 decisions、生产代码、既有测试或新增二进制 fixture。

- [x] **步骤 3：运行聚焦与全量检查并记录结果**

运行：`node --test test/model-input-templates.test.ts`、`npm test`、`npm run prompts`。记录 exit、16 个 scene 的实际覆盖及失败差异。actual 与 decisions 不一致时保持测试失败并交回对应生产 repair task，不得改权威模板或放宽断言。

- [x] **步骤 4：核对独立性与授权边界**

确认 diff 只含本任务两个测试文件；本任务新增测试已获用户明确授权。确认没有写入 decisions、生产文件，没有为了通过测试而调整模板、增加生产测试后门或把第三方组装副本当作真实输入。

### Task 8：全局终验与执行记录

**Deps：** `T7`（理由：所有生产行为与独立权威模板机械测试均已交付）

**WritePaths：**
- `docs/plans/2026-11-04-model-input-templates.md`
- `docs/reports/2026-11-04-turn-input-shapes.md`

**Resources：** `none`

**Files：**
- Modify：计划文件回填命令 exit、验证范围与阻塞。
- Modify：报告只保留现行输入及新实现证据，旧 `pi.user` 仅作历史不参与结论。

**接口契约：**
- Consumes：T1–T6 当前交付版本及 T7 的独立机械测试证据。
- Produces：F1–F10 的可核对证据；任何未通过项保持未完成，不标记整体完成。

**终态关联：** `F1`–`F10`。

**验收标准：**

- [x] **步骤 1：核对真实入口、身份和已有合同**

扫描 active prompt、active messages、工具 catalog、scheduler、出口、合集附件和换页尾部，区分保留兼容源码与 active 引用。

- [x] **步骤 2：完成最小实现**

更新报告与计划执行记录；逐项回填自主浏览、私有池事务等 F10 未覆盖行为的人工核对证据，记录仅 T7 两个测试文件获新增授权、未部署生产、执行环境需已安装依赖等验证边界。不得仅引用 `npm test` 成功就宣称机械测试未覆盖的新行为成立。

- [x] **步骤 3：运行适用的既有检查并记录结果**

依次运行：`node --test test/model-input-templates.test.ts`、`npm run prompts`、`npm test`、`git diff --check`、`git diff --exit-code -- prompt/handoff.md`。命令均 exit 0 且 F1–F10 的证据成立才通过终验；失败则回到对应 repair task。

- [ ] **建议（待用户授权）：新增测试或全新 fixture/压力场景**

增加两会话在同一 open 门看同一 BV 并独立分享、以及 answer/open/GIF/新闻/合集/换页输入快照验收。

## 成果独立验收（用户已授权）

- T8 完成后，由未参与 T1–T8 的独立 `reviewer` 新开 run，只读审查当前交付 diff、decisions、16 个场景的机械测试证据及 F1–F10 终态，不修改文件、不派发其他代理。
- 主会话核对 review 发现；需要修复时在已授权范围内修复并重跑受影响检查。该轮之后的额外成果 review 仍需用户明确授权。
- 成果 review 是交付后的独立验收，不替代 T7 的独立机械测试，也不把 reviewer 自报意见当作测试证据。

## T8 执行记录（2026-11-04）

本记录对应当前工作区候选；五条命令均在 `/Users/leshi.zhy/yugang` 依次实跑，未使用线上进程、生产 Mac 或数据库写入。

### 命令证据

| 命令 | exit | 关键输出 |
| --- | ---: | --- |
| `node --test test/model-input-templates.test.ts` | 0 | `tests 19`、`pass 19`、`fail 0`；16 个 scene、矩阵/helper 严格性、open injection/shard 均通过。 |
| `npm run prompts` | 0 | 输出 `工具包 24 个`、`源码内嵌扫描：干净`；active catalog 不含 `ammo_list` / `ammo_submit`。 |
| `npm test` | 0 | `tests 113`、`pass 113`、`fail 0`。运行中仅有本地缺失 `var/bili-filters.json` 的回缺省日志。 |
| `git diff --check` | 0 | 无输出。 |
| `git diff --exit-code -- prompt/handoff.md` | 0 | 无输出，`prompt/handoff.md` 无改动。 |

**F3 修复后复验**（上表为 T8 首次实跑；F3 未满足项修复后，受影响命令重跑同结果）：`node --test test/model-input-templates.test.ts` 19/19；`npm test` 113/113；`node --test test/startup.test.ts` 通过；`npm run prompts` exit 0；`git diff --check` 与 `git diff --exit-code -- prompt/handoff.md` 仍 exit 0。

### F1–F10 逐项核对

| 条件 | 判定 | 当前证据 |
| --- | --- | --- |
| F1 | 满足 | `src/qq/model-input.ts` 的 `renderMessageLine` 固定生成 `[m:id][标签] 昵称(QQ): 正文`，`src/qq/debounce.ts` 以 arrival 顺序组装列表并将引用/合集放在列表后；源码生成路径未再输出 `回复msg:` 或 `➤`，`src/compact.ts` 的 `historyInputProjection` 仅对旧存量尾行兼容剥离 `➤`。聚焦测试覆盖 `answer_reply`、`answer_burst_voice`、`private_master`、`open_injection`、`open_shard`、`gif_ingest`。 |
| F2 | 满足 | `src/qq/round-images.ts` 的 `planRoundImages` 统一分配图片编号、标签和压缩 blocks；`src/qq/round-input.ts` 的 `submitContentOf` 将唯一 text block 放在 image blocks 前；`npm test` 通过 inline/fallback 回归，源码无 `ctx_image_attached`。 |
| F3 | 满足（T8 初判未满足 → 主会话修复 → 复验） | 已核对 `src/tools/loader.ts`：`DISABLED_TOOL_PACKAGES` 含 `ammo_list` / `ammo_submit`，disabled 包不调 factory、不进 active/deferred/catalog，文案不并入 active 合并视图；`src/index.ts` 的 worker/refill/manual ammo/全局分享接线已摘除，新闻仍由独立 `newsScheduler` 接线。open injection/shard 与空窗门均由测试和 `src/qq/round-input.ts` 入口覆盖。**T8 初判未满足的原因已修复**：原 `src/index.ts` settle 的 `finally` 仍调 `engageNext.noteExit(chatKey)`，沉默计数仍有宿主上报；复核确认 `silenceOf` 在宿主/脚本侧零调用（当时只写日志、不驱动任何模型面），已删除该调用与 `exits` 读数，并把 `src/index.ts` / `src/engage-next.ts` 注释改成「noteExit / silenceOf 与 shareGateOf 同待遇：兼容源码、宿主无消费方、不得据此重新接线」。复验：`grep -rn noteExit src/` 仅剩 engage-next 自身声明/实现与两处停用注释；聚焦 19/19、全量 113/113、startup 检查通过。 |
| F4 | 满足（人工核对） | F10/`npm test` 未覆盖完整自主浏览事务，以下为源码人工证据：`src/external/video-pool.ts` 的 `VideoPoolDoc` 使用 `scope: "conversation"`，`videoUrlOf` 生成 canonical URL，`applyVideoPoolAdd` 按 BV 去重；`src/tools/say_words/tool.ts` 约 L117–L132 要求 injection 的 `browseWindow`/`browseTopic`、现窗 `videoBrowseGateOf` 的 window/topic/open 三项匹配并命中 `viewedVideoOf(round)`；约 L138–L155 在同一 `api.commit` 写池、`OutboundEntry` 与 `OutboxDoc` queued 项，约 L157 才 `chargeSayRound`，失败路径不占额度；`src/tools/say-shared.ts` 的 `assertShareAllowed` 约 L158–L163 将 `videoBvid` 作为 self-mute 素材分享豁免；`src/external/video-browse.ts` 的 `recordViewedVideo`/`viewedVideoOf`/`clearViewedVideos` 与 `src/index.ts` settle finally 约 L1029 清理轮内 viewed。 |
| F5 | 满足 | `prompt/messages.md` 的 `news_broadcast_task` 为 `[新闻播报]`；`src/external/news-broadcast.ts` 的 `renderNewsTask` 与 `src/index.ts` 的 `newsScheduler`（约 L2140–L2148）独立；GIF 由 `renderGifIngestInput` 绑定真实消息 ID 并追加 `[GIF 收图任务]`，prompt 明确只 look 压缩图且不使用 `say_*`。 |
| F6 | 满足（首轮为「部分满足」，已在 review 后修复并复验） | `src/compact.ts` 的 `historyInputProjection`、`mechanicalTail`、`buildProfileHandoff` 只从被压缩页尾部投影消息和已见附件，输出 history 标准列表；工具过程、thinking、旧 open footer 不进入尾巴，不补拉合集。**首轮问题**：鱼自己的行在生产里永远拿不到 `[m:id]`（`OutboundPayload` 无 `messageId`，drain 只写 `fish.sentmap`），而权威 `history-tail` 要求有；`history_*` 场景当时手造 `CountedEntry.tailMessages`，绕过了唯一生产者 `renderCountedEntries`，属假绿。**修复**：裁定「不伪造」——鱼的行省略 `[m:id]`，decisions §7.2 同步加规则；两个 scene 改为真 harness（`openFish` + 接 `selfOf` → `Elysia(3768557204)` + 真 `submit` 产出 `fish.inbound`/`fish.outbound` + 真 `fish.compact` → 从 `pi.reset` 读 handoff）。复验：聚焦 19/19（`history_reset` 23ms、`history_forward` 7ms，走真链路），全量 113/113。 |
| F7 | 满足（按 active 面判定） | `prompt/runtime.md`、`prompt/messages.md` 和 `npm run prompts` 的 runtime/tool_catalog 输出没有停用机制的主动提醒，prompts 报告“源码内嵌扫描：干净”；旧 ammo/worker 文件及 config 的兼容说明仍保留，但不属于 active 工具面或主动引导。 |
| F8 | 满足 | `src/qq/gate.ts` 约 L58–L63 保留回复合集专用放行、无 @ 自带合集零成本拒绝；`src/index.ts` 约 L1172–L1176 将最近合集作为列表后附件；`src/qq/onebot.ts` 约 L564–L592 限前 10 条、子图最多 2 张、嵌套不递归且只带真实 ID/QQ。聚焦测试覆盖 `forward_direct`、`forward_reply`、`forward_recent`、`forward_background`、`history_forward`。 |
| F9 | 满足 | `git diff --exit-code -- prompt/handoff.md` exit 0、无输出。 |
| F10 | 满足（首轮在 `history_*` 上不成立，已修复） | 聚焦命令真实结果为 19/19；矩阵严格覆盖 16 个 scene，测试分别触发 open injection 与 open shard，图片 block 做类型/顺序/base64/MIME deepEqual，且生产入口链路来自 `planRoundImages`、`withContext`、`submitContentOf`、`createEngageNext`、`renderNewsTask`、`renderGifIngestInput`、`buildProfileHandoff`。**首轮缺陷**：`history_reset`/`history_forward` 的 `CountedEntry`（含 `tailMessages`/`tailAttachments`）由测试手造，生产造不出来 → 「真实入口」在这两个 scene 上名不副实。**修复**后这两个 scene 走真 harness，手造 fixture 已删除；断言仍为整串 `assert.equal`，未放宽。 |

### 三个已裁定差异的复核

1. `answer_burst_voice`：当前 `prompt/messages.md` 的 `voice_hint`、`prompt/runtime.md`、`src/tools/say_voice/TOOL.md` 与 decisions §5.2 均使用 `[本轮要求] 必须使用 say_voice 回复，不要使用文字。`；聚焦 `answer_burst_voice` 通过。
2. `news` 来源署名：当前 `src/external/news-client.ts` 的 `NEWS_SOURCE_LABELS` / `newsSourceLabelOf` 覆盖 60秒、界面、虎嗅、IT之家、人民网、知乎日报、微博热搜、百度热搜，`src/external/news-broadcast.ts` 在宿主渲染时调用；聚焦新闻场景输出 `（人民网）` / `（IT之家）`，旧报告中的 `（ithome）` 仅属改造前基线。
3. `history_forward`：当前 decisions §7.2 已将尾巴父消息修正为同时带 `[转发合集]` 与 `[这条消息@了你]`；这是与 `renderMessageLine` 逐字投影一致的唯一决策文档修正，聚焦 `history_forward` 通过。

### 成果独立 reviewer 后的修复（2026-11-04）

独立 `reviewer`（未参与 T1–T8，`qoder-pool/Qwen3.8-Max`）结论为「有条件通过」，抓出两处真实缺陷与三项合规问题。处理如下：

| 发现 | 处理 | 复验 |
| --- | --- | --- |
| **B1（阻塞 F6/F10）** 换页尾里鱼的行永远没有 `[m:id]`，测试手造 `tailMessages` 掩盖 | 裁定不伪造 id：decisions §7.2 鱼行去锚点并加规则；两个 `history_*` scene 改走真 harness（真 `openFish`/`submit`/`compact`，接 `selfOf`） | 聚焦 19/19、全量 113/113；`history_reset` 23ms / `history_forward` 7ms 为真链路耗时 |
| **B2（合规）** decisions 第三处修改（`前情 2→3`）未披露，且记录里写「未修改 decisions」自相矛盾 | 在「边界与未满足项」补齐 3 处 hunk 的完整披露与理由；保留该修改（3 个 entry 对应 3 行，`count` 取 `counted.length` 是改造前语义） | 文档层面核对 |
| **B3（合规）** `round-images.ts` / `round-input.ts` / `news-broadcast.ts` 不在计划 WritePaths | 补「T7 前置修复（主会话，事后追认）」小节与「文件结构与职责」三行，并记录 `src/index.ts` 只转发、无第二套渲染 | `grep` 复核一处实现 |
| **S1** 停用弹药后宵禁硬闸消失，AGENTS.md 仍称「宵禁硬边界生效」 | 改 AGENTS.md：明确宵禁只剩 prompt 软约束、browse 门与 `videoBvid` 无时段闸，标注待定产品项与补闸位置（`videoBrowseGateOf` 开窗计算加 `!ammoCurfewAt(now)`） | 文档层面核对 |
| **S2** `_salvagePlainReply` 配置注释仍称「回复合集」必答 | 改 `fish.config.example`：仅私聊/被@是必答轮；回复合集只是闸放行 | `node -e` 解析 example JSON 通过 |
| **S3** `scripts/real-model-smoke.ts` 仍手拼 `回复msg:` | 改为直接调用生产 `renderMessageList`；`claimMaster` 语义改成「正文自称主人」（真实身份标签仍由宿主机械判定） | `grep -rn "回复msg:" src/ scripts/` 只剩一条描述性注释 |
| **S4** 死函数 `gate.ts:renderForModel`、`onebot.ts:expandForwardById`（后者以空文案表触发 `model-input.ts` 中文字面兜底） | 两处均删除；`gate.ts` 的 `MessageTable` 保留（闸与渲染共用） | `npm test` + startup 检查通过 |
| **S5** `bili_hot_bad_rid` 死 key + 过期注释 | 删 key 与回退，注释改为「宿主与工具字表脱节属配置事故」 | `npm run prompts` 显示 bili_hot 文案 6 key、无死文案告警 |

未处理的 reviewer 建议（明确保留为已知限制，不擅自改产品语义）：**S6** 删除 `@全体成员`/`@别人` 的机械澄清标注（decisions §3 标签合同本就没有，属行为面削弱，需上线观察）；**S7** 换页尾跨轮重复消息行（改造前后一致，去重口径未裁定）；**S8** 升级后首个换页周期内旧 `回复msg:` 行会按逐字投影进尾部（存量页兼容，F1 判据在该窗口为假）。

### 边界与未满足项

§1–§5 的线上 DB 记录仅是改造前基线；本记录的改造后结论来自当前源码与 T7 机械测试，不是线上 DB 新取证。F4 的自主浏览、私有池事务、出口额度和 self-mute 只完成人工源码核对，不能用 `npm test` 或 F10 夸大为自动验证。F3 的初判未满足项（宿主仍上报沉默计数）已按上文修复并复验通过，不再是未满足项；T3 步骤 1、2 随修复完成补勾。

**decisions 的修改清单（完整披露，共 3 处 hunk；T7 自身未改文档，均为主会话裁定后修改）**：

1. §7.2 `history-profile` 卡片头 `（前情 2 条 …）` → `（前情 3 条 …）`：原文与同节 `history-tail` 的 3 行消息自相矛盾；`count` 来自 `counted.length`（改造前既有语义，未动），3 个 entry 对应 3 行，故改文档而非改生产计数。
2. §7.2 `history-forward-tail` 父消息补齐 `[转发合集]` 与 `[这条消息@了你]`：尾巴是被压缩页输入的逐字投影，自带合集靠 @ 才展开，该行必然带这两个标签（与 §5.9 `forward-direct` 同一套标签）。
3. §7.2 `history-tail` 鱼自己的行去掉 `[m:2123920690]`，并新增「鱼的行没有真实 id 时省略 `[m:id]`」规则：`fish.outbound` entry 不携带 messageId（实际 id 发送成功后才落 `fish.sentmap`），历史尾是 entry 的逐字投影，不得编造 ID（与合集子消息同一规则）。

这三处均是「文档与机械事实不一致」的修正，方向上没有一处是「改文档让实现变绿」：对应生产侧一律未动（count 语义、逐字投影、不伪造 ID 都是改造前就有的约束）。

T7 只新增了获授权的两个测试文件；本次未新增其它测试、未 commit、未 push、未部署。

<!-- goal-runtime-contract:start -->
```json
{
  "schema": "goal-runtime.plan.v1",
  "objective": "统一鱼缸模型输入模板与合集附件，停用旧账/弹药库/后台逛轮，交付主动自主浏览、压缩图关联及标准化换页尾",
  "constraints": ["遵循 docs/decisions/2026-11-04-model-input-templates.md", "不修改 prompt/handoff.md", "仅 T7 可新增声明的两个权威模板测试文件及固定内存 fixture，其它测试/fixture 不新增", "T7 不得修改 decisions 或生产代码", "不部署生产", "不 commit/push"],
  "resources": [],
  "checks": [
    {"id":"F1","statement":"统一消息模板与真实顺序通过 prompts 静态审查；完整 input 由 T7 机械比对","command":{"executable":"npm","args":["run","prompts"],"timeoutSeconds":120},"repairTaskIds":["T1","T2","T5"]},
    {"id":"F2","statement":"压缩图编号关联与 fallback 的既有回归通过；完整 content 由 T7 机械比对","command":{"executable":"npm","args":["test"],"timeoutSeconds":180},"repairTaskIds":["T1","T2"]},
    {"id":"F3","statement":"主动轮 gate、ammo 停用和 system 文案通过 prompts 审查","command":{"executable":"npm","args":["run","prompts"],"timeoutSeconds":120},"repairTaskIds":["T3","T6"]},
    {"id":"F4","statement":"自主浏览相关既有回归通过；私有池、出口事务和 self-mute 新行为由 T8 人工核对","command":{"executable":"npm","args":["test"],"timeoutSeconds":180},"repairTaskIds":["T3","T4"]},
    {"id":"F5","statement":"GIF 与新闻任务模板及独立调度通过 prompts 审查","command":{"executable":"npm","args":["run","prompts"],"timeoutSeconds":120},"repairTaskIds":["T1","T5"]},
    {"id":"F6","statement":"换页尾部相关既有回归通过；完整 reset input 由 T7 机械比对","command":{"executable":"npm","args":["test"],"timeoutSeconds":180},"repairTaskIds":["T1","T6"]},
    {"id":"F7","statement":"最终候选无 whitespace 错误；全量检查与证据由 T8 终验记录核对","command":{"executable":"git","args":["diff","--check"],"timeoutSeconds":30},"repairTaskIds":["T8"]},
    {"id":"F8","statement":"合集相关既有回归通过；完整合集 input 由 T7 机械比对，触发授权由 T8 人工核对","command":{"executable":"npm","args":["test"],"timeoutSeconds":180},"repairTaskIds":["T1","T2","T6"]},
    {"id":"F9","statement":"prompt/handoff.md 相对基线零改动","command":{"executable":"git","args":["diff","--exit-code","--","prompt/handoff.md"],"timeoutSeconds":30},"repairTaskIds":["T6"]},
    {"id":"F10","statement":"decisions 矩阵全部 input 场景经真实入口拼装并与权威模板精确比较","command":{"executable":"node","args":["--test","test/model-input-templates.test.ts"],"timeoutSeconds":180},"repairTaskIds":["T1","T2","T3","T4","T5","T6","T7"]}
  ],
  "tasks": [
    {"id":"T1","agent":"delegate","task":"先只读主仓库绝对路径 `/Users/leshi.zhy/yugang/docs/decisions/2026-11-04-model-input-templates.md` 与 `/Users/leshi.zhy/yugang/docs/plans/2026-11-04-model-input-templates.md` Task 1，worktree 缺文件不构成合同缺失，不得复制或修改文档。依据计划 Task 1 和决策文档实现 src/qq/model-input.ts、结构化直接回复、结构化合集附件及共享模板，修改声明文件。产出 ModelMessage、QuotedMessage、ForwardAttachment、ForwardChildMessage、renderMessageLine/renderMessageList/renderQuotedOriginal/renderForwardAttachment；保留回复合集专用放行和无 @ 自带合集零成本丢弃，普通回复不必答。仅写声明路径，不新增测试；接口冲突即停止上报。","deps":[],"writePaths":["src/qq/model-input.ts","src/qq/onebot.ts","src/qq/gate.ts","src/qq/debounce.ts","prompt/messages.md"],"resources":[],"acceptance":{"criteria":["消息行与边界符合决策","直接回复和合集展开不再混入当前正文","合集附件不伪造子消息 ID/QQ"]},"checkIds":["F1","F8"]},
    {"id":"T2","agent":"delegate","task":"先只读主仓库绝对路径 decisions 与主计划 Task 2（完整路径同 T1 合同），不得复制或修改文档。依据计划 Task 2 消费 T1 契约，实现 answer/私聊标准输入、真实顺序、后置引用/合集附件与压缩图片编号关联，仅修改 src/qq/debounce.ts 和 src/index.ts。保留 quoteIds、inline 上限及 GIF 排除；最近合集补展开不得再前置；不新增测试。","deps":["T1"],"writePaths":["src/qq/debounce.ts","src/index.ts"],"resources":[],"acceptance":{"criteria":["answer/私聊模板统一","图片与合集子图编号同压缩 block 对齐","fallback 提示 look","合集附件后置且有序"]},"checkIds":["F1","F2","F8"]},
    {"id":"T3","agent":"delegate","task":"先只读主仓库绝对路径 decisions 与主计划 Task 3（完整路径同 T1 合同），不得复制或修改文档。依据计划 Task 3 实现 open 标准输入、每窗一次 0.3 主动门、video browse 契约并停用 active ammo/worker/nudge/debt。disabled 包仍校验完整性但不进 active/deferred/catalog/messages 合并视图；清理中心停用文案并更新 say_self_mute 为 videoBvid；在 active 接线保留 video.dailyBudget 到 syncBiliBudget 的热加载。仅修改声明文件，新闻 scheduler 不动，旧源码不删。","deps":["T1","T2"],"writePaths":["src/external/video-browse.ts","src/engage-next.ts","src/index.ts","src/fish-config.ts","src/tools/loader.ts","src/tools/types.ts","src/tools/config/TOOL.md","prompt/messages.md"],"resources":[],"acceptance":{"criteria":["空窗仅 gate 起主动轮","ammo 与 worker 无 active 面及 active 文案","disabled messages 不并入合并视图","配置兼容且预算热加载挂点保留"]},"checkIds":["F3"]},
    {"id":"T4","agent":"delegate","task":"先只读主仓库绝对路径 decisions 与主计划 Task 4（完整路径同 T1 合同），不得复制或修改文档。依据计划 Task 4 实现 conversation 私有视频池、授权候选与实际查看登记、say_words(videoBvid) 原子分享及 self-mute 合法素材判定。更新 bili_video/TOOL.md，明确元数据核实不等于实际看过，browse 最终必须成功调用 video。仅修改声明文件，使用本地 faux/既有测试，禁止线上 B 站请求和新增测试。","deps":["T2","T3"],"writePaths":["src/external/video-pool.ts","src/index.ts","src/tools/bili_hot/tool.ts","src/tools/bili_hot/TOOL.md","src/tools/bili_hot/schema.json","src/tools/bili_video/TOOL.md","src/tools/video/tool.ts","src/tools/video/TOOL.md","src/tools/say-shared.ts","src/tools/say_words/tool.ts","src/tools/say_words/TOOL.md","src/tools/say_words/schema.json"],"resources":[],"acceptance":{"criteria":["未授权或未看 BV 拒绝","pool 按会话去重","canonical 链接与 outbox 同事务","videoBvid 通过 self-mute 素材校验","bili_video 不冒充实际观看"]},"checkIds":["F4"]},
    {"id":"T5","agent":"delegate","task":"先只读主仓库绝对路径 decisions 与主计划 Task 5（完整路径同 T1 合同），不得复制或修改文档。依据计划 Task 5 修改 src/index.ts 和 prompt/runtime.md，实现 GIF 与新闻独立任务模板，保持新闻调度、GIF 压缩图和出口规则，不改其他文件。","deps":["T3","T4"],"writePaths":["src/index.ts","prompt/runtime.md"],"resources":[],"acceptance":{"criteria":["GIF 任务绑定消息 ID 且无 say","新闻模板和独立调度保留"]},"checkIds":["F1","F5"]},
    {"id":"T6","agent":"delegate","task":"先只读主仓库绝对路径 decisions 与主计划 Task 6（完整路径同 T1 合同），不得复制或修改文档。依据计划 Task 6 修改 src/compact.ts、prompt/runtime.md、AGENTS.md、README.md、fish.config.example，保持 prompt/handoff.md 和剖面不变，把换页尾改为真实顺序标准历史消息列表，只保留当页模型实际见过的合集附件且不补拉；收口 system 标签、自主浏览实际看过后分享与合集附件语义。","deps":["T1","T3","T4","T5"],"writePaths":["src/compact.ts","prompt/runtime.md","AGENTS.md","README.md","fish.config.example"],"resources":[],"acceptance":{"criteria":["handoff 不变","尾部无旧窗口/旧账/工具过程","合集附件只保留当页已见内容","system 无停用机制引导"]},"checkIds":["F3","F6","F8","F9"]},
    {"id":"T7","agent":"delegate","task":"先只读主仓库绝对路径 decisions 与主计划 Task 7（完整路径同 T1 合同），不得复制或修改文档。测试 helper 默认仓库相对路径，worktree 自验可用 YUGANG_DECISIONS_PATH 指向主仓库 decisions，禁止写死本机默认路径。作为未参与 T1-T6 的独立测试 subagent，依据计划 Task 7 与 decisions §10 编写权威模板机械测试。只创建 test/model-input-templates.test.ts 和 test/support/authoritative-templates.ts；直接只读解析 decisions 矩阵和模板，从真实场景入口取得 content，精确比较 16 个 scene 的完整文本、附件与图片 block。不得修改 decisions、生产代码或既有测试，不得复制生产组装逻辑充当 actual，不得为通过测试放宽断言；入口不可触达或实现不符时停止上报。","deps":["T6"],"writePaths":["test/model-input-templates.test.ts","test/support/authoritative-templates.ts"],"resources":[],"acceptance":{"criteria":["16 个 scene 均由真实入口触发并精确比对","open injection/shard 分别执行","diff 仅含两个获授权测试文件","未修改 decisions 或生产代码"]},"checkIds":["F10"]},
    {"id":"T8","agent":"delegate","task":"先只读主仓库绝对路径 decisions 与主计划 Task 8（完整路径同 T1 合同），不得复制或修改 decisions。依据计划 Task 8 只修改计划和现行输入报告，回填真实检查证据与阻塞，不伪造通过，不修改生产代码，不部署。","deps":["T7"],"writePaths":["docs/plans/2026-11-04-model-input-templates.md","docs/reports/2026-11-04-turn-input-shapes.md"],"resources":[],"acceptance":{"criteria":["F1-F10 证据对应当前候选","未满足项明确保留"]},"checkIds":["F7"]}
  ],
  "terminalCheckIds": ["F1","F2","F3","F4","F5","F6","F7","F8","F9","F10"]
}
```
<!-- goal-runtime-contract:end -->
