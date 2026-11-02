# 搭话模式 next（定时器驱动的自主搭话）实现计划 v4

> **给执行 agent：** 必须逐任务执行本计划；步骤使用 `- [ ]` 复选框跟踪。只有整体交付终态全部验证通过，才算计划执行完成；未满足时持续修复与验证。执行方式由计划编写完成后的用户选择决定。

**目标：** `engagement: "next"` 模式下，群聊搭话改为周期开窗：每 10 分钟开 3 分钟「自由交流」窗口——开窗先把积压消息注入，窗内新消息实时进模型输入，模型自由决定是否发言；关窗后定时器重新计时。@ 仍即时必答（背景缩为 5 条）。奖惩 = 主人评价进长期记忆 + 渲染加权；群友画像、抽取评价机制与开关无关，上线即生效。

**架构：** engage-next 状态机（closed/open，按群）控制 gate：open 态非 @ 群消息以 `free_pass` 过闸走既有 10 秒合并管线（ambient 轮，mustAnswer=false）；closed 态 `skip:next_pending`。开窗瞬间注入积压（injection 轮，专用 entry kind）。轮类型（ambient/injection/answer）显式进入 trigger，@ 白名单与语音骰按轮类型判定。legacy（默认）零变化。

**技术栈：** TypeScript / pi-durable（submitRound / conversation）、debounce 合并管线、fish-config mtime 热加载、prompt/messages.md 模板体系、fish.memory 审批闸、memory-extract 抽取器。

## 前置条件（硬）

1. engagement 开关已实现并先落 commit（已满足：`c54df0b`）。
2. 新增测试授权（尾部清单，含 T9/T10/T11 的测试文件）；未授权不得开始执行。

## 全局约束

- 模型可见文字只来自 `prompt/` 与 `src/tools/<name>/TOOL.md`；`src/` 无大段 prompt 字面量（≥12 汉字扫描，`src/prompt-lint.ts`）；模板 `{{var}}` 严格替换；**新增 key 必须有 src 引用**（`test/prompts.test.ts` 的 dead-copy 断言）
- 出口只有 say_words / say_media / say_meme / say_voice（共享每轮 3 次额度）；校验失败以 tool 错误返回
- 主动 @ 机械边界：仅 ambient/injection 轮允许 @，目标 ∈ {主人} ∪ 本群 watched 且为真实成员；AGENTS.md 第 4 节同步修订并写明风险（open 窗内普通群友可诱导鱼 @ 主人/watched，属接受的放宽面）；answer 轮与 legacy 语义不变；say_voice 无 mentions、不支持 quoteMsgId（可 quote 正在回的那条）
- 语音台词 ≤200 字（say_voice 自身限制）；文字/图片出口无硬字数上限（勿误加机械限制）
- 配置走 `fish.config.json`；非法值告警保留缺省（不崩进程）；逐字段生效语义见 T9 附表
- 不开内置 compaction；摘要只收群友的话 + 鱼发出去的话（engage_tick / fish.eval 排除）
- next 不上线（生产 legacy）；本计划不 commit、不部署（各任务产出的 commit 由用户另行授权）
- 同一会话不许并发提交；互斥分级见决策 8（仅 next 的 ambient/injection 轮登记 in-flight；@ 轮排队等待而非 busy 丢弃）

## 整体交付终态

| ID | 必须成立的条件 | 验证方法与环境 | 通过判据 | 证据位置 | 覆盖任务 |
| --- | --- | --- | --- | --- | --- |
| F1 | legacy 的**搭话行为**零变化（闸/合并/背景/出口/语音骰）；计划中与开关无关部分（评价→记忆、feedback 加权、画像、抽取机制、config 工具）在 legacy 同样生效，回退靠代码回滚 | `npm test` + 分项验收 | 搭话相关既有测试不变绿；记忆/工具测试不依赖开关 | 测试输出 | T1-T11 |
| F2 | 状态机按群：closed 10 分钟（可配）→ open 3 分钟 → 循环；closed 态非 @ 群消息 skip:next_pending 不进模型（**边界**：open 窗末尾已存在的 pending burst，closed 后同发送者续话并入该组照常 flush，属期望——同组不拆）；open 态非 @ 消息 free_pass 走既有合并管线（mustAnswer=false 零出口合法）；`isOpen` 缺省 = closed；热切换（含无消息期）由状态机每 tick 现读配置驱动 start/stop | engage-next 单测 + gate 单测 + 日志 | 态迁移精确、closed 零新提交、open 走管线、无消息热切换生效 | 测试输出 | T2、T3 |
| F3 | 开窗注入：open 瞬间把「上次关窗以来」积压（排除 pending burst 内消息、过滤 `/` 指令与纯 GIF 收图消息、>windowSize 截最近 N）注入 injection 轮（每条 `[m:<messageId>]`，watched/master 打标）；无积压不注入 | 单测 | 积压一轮注入、过滤与截断正确、无积压零提交 | 测试输出 | T3 |
| F4 | @ 必答轮在 next 任何 phase 即时进，背景缩为最近 5 条（含整组）；必答/salvage/引用语义不变；@ 轮遇在途 ambient/injection 轮**排队等待**（上限 60s，超时 busy_reply），不丢弃 | 单测 + 既有必答回归 | 背景 ≤5；@ 在环境轮进行中到达能进（等待或 busy，不静默丢） | 测试输出 | T5 |
| F5 | say_words/say_media/say_meme 新增 `quoteMsgId`（接受 `[m:…]` 或裸数字）；属本轮注入窗口才有效；有效时**同时**置 `payload.quote = true` 且 `payload.quoteId = 该消息 id`；无效 tool 错误不计数额度；缺省现行为不变（say_voice 不加此参数） | 单测 + schema 校验 | 合法挂 quote、非法拒、缺省零变化 | 测试输出 | T4 |
| F6 | ambient/injection 轮零出口合法（无 salvage、无强制引用）；可 @ 目标 ∈ {主人} ∪ 本群 watched（成员校验照旧），越界拒绝并记审计；answer 轮与 legacy 的 @ 语义不变 | 单测 + runtime 文案核对 | 轮类型判定正确、@ 白名单生效、审计有痕 | 测试输出 | T3、T4、T1 |
| F7 | engage 配置（closedMinutes=10 / openMinutes=3 / windowSize=20 / mentionContextSize=5 / silenceThreshold=3 / windowRelaxCap=30）缺省合法、非法告警保留缺省、热加载 | 配置解析单测 | 判据如左 | 测试输出 | T2 |
| F8 | next 态：特别关注无强制（不进 gate、语音骰对 ambient/injection 关闭）；名单与备注照常记录；watched 消息行带「[特别关注]」标记；runtime 软引导（全局可见，属措辞不属搭话机制） | 单测 + runtime 核对 | next 判据如左；legacy watched 行为（gate/语音骰）不变 | 测试输出 | T1、T3、T5 |
| F9 | 主人不入特别关注列表：watch add 拒绝 master、装载时过滤 master；主人消息行带「[主人]」标记（与 [特别关注] 互斥，master 优先）；@ 轮锚点行「你主人」标注保留；runtime 软引导；无新增强制 | 单测（含 watch 工具） | watch 无法添加 master、标记互斥 | 测试输出 | T1、T3、T5 |
| F10 | 主人 `/评 好|差 <文字>`（方向必填）：指向型（回复引用鱼消息）经 sentmap 定位被评 outbound 条目（查不到降级最近一条并在回执注明）；范围型（不引用）带当日统计；评价包结构化字段（对象/被引消息/前 20 条摘要或统计/群/人格/日期）随待审 patch 持久化，批准后进 fact 的 kind/meta；群内非主人 `/评` 闸前特判回拒绝，私聊非主人静默；meta 有独立上限，长期 doc 只存 target 短摘要+统计一行，20 条上下文只存 pending | 记忆链路单测 | 定位/降级/两型字段/互斥拒绝/上限全覆盖 | 测试输出 | T6、T7 |
| F11 | 连续 silenceThreshold 个 open 窗全程零出口 → 下窗注入尾部 nudge 文案；**backlog 为空时提交 nudge-only 轮**（header+footer+nudge，无行）；超 2×阈值 → 下窗 backlog 窗口放宽至 windowRelaxCap（受 recent 上限约束，上限已同步提升）；仅 ambient/injection 轮开口清零，@ 轮/私聊不计不清 | 单测 | 阈值触发文案、nudge-only 轮、放宽、清零口径 | 测试输出 | T8 |
| F12 | 统一配置工具 `config`（仅主人私聊轮，群内一律拒绝）：fish.config.json 受控字段（热加载类）+ config/models.json 角色表（restart 生效类，迁移自 model 工具）；旧 model 工具移除且全仓无残留引用（含 test/tools.test.ts、README、AGENTS 第 1/2/3 节、types/harness 注释）；审计日志；非法/越界拒绝 | 工具单测 + prompts 审查 | 仅主人私聊生效、两类配置生效语义正确、model 无残留、config 进 deferred 名单断言 | 测试输出 | T9 |
| F13 | 群友画像并入长期记忆（people 为唯一载体，**在场/活跃优先、受既有 MEMORY_CAPS 约束**——大群允许旧画像按既有淘汰规则让位）；people.md 的主人/关系**静态设定保留**（不属群友画像），仅「群里的人/梗」类动态画像并入；无第二套画像存储 | 记忆链路单测 + npm run memory | 画像累积叠加、同 QQ 合并、静态设定不受影响 | 测试输出 | T10 |
| F14 | 抽取评价机制：试金石提示词（few-shot+受益判准+confidence low 不报+signal 标注，signal 仅保留机械可得的「命中 people 名单/与现有 fact 冲突」两类）；对账三分类 ADD/SUPERSEDE（含 subject，factId→subject 由渲染 known 时附带 id→subject 映射机械解析）/SKIP（仅计数不产出）；空 patch 与解析失败可判别；零提取计数（阈值常量 5）+ 一次复查模式（不阻塞换页）；待审列表展示 signal 标签与零提取头部提示 | 抽取器单测 + npm run prompts | 三分类被 sanitize 通过、判别正确、计数与复查路径正确 | 测试输出 | T11 |

**完成规则：** F1-F14 全部满足且证据对应当前版本才完成；步骤勾选不替代终态验证。

**未满足时：** 授权范围内 fix → test → 对照终态；阻塞记录未完成与恢复路径。

## 设计决策

1. **状态机按群、内存态**：`Map<chatKey, {phase, phaseSince, lastCloseSeq}>`；可注入时钟（debounce 先例）；重启/热切换进入 closed 从零计时，`lastCloseSeq` 懒定基线（宁少勿答）。状态机**自带 tick 现读 fishConfig()**，不依赖消息驱动（无消息期也能热切换 start/stop）。
2. **closed 态**：非 @ 消息 skip:next_pending（旁路记账照常）；已存在的 pending burst 在关窗后收尾属期望（同组不拆）。
3. **open 态**：gate next 分支放行 `free_pass`（非必答）；消息走既有 10 秒合并管线；**环境轮背景上限沿用 10 不变**（mentionContextSize 仅 @ 轮）；开窗瞬间若有积压先提交 injection 轮（覆盖到开窗时刻，之后归 burst，游标推进到 recent 末条 arrivalSeq，不重复注入）。
4. **injection 轮**：`ctx_engage_header + ctx_engage_line×N + ctx_engage_footer`；**submitRound 增加 `entryKind` 参数**（现硬编码 MEMORY_INBOUND_KIND），injection 用 `fish.engage_tick`（摘要与抽取白名单排除）；**计入换页阈值**（renderTranscript 对 engage_tick 计 entries/chars，但不写 handoff 文本）；不附 inline image block。
5. **@ 轮**：任何 phase 即时进；next 下背景 = mentionContextSize（默认 5）；legacy 恒 10。
6. **引用目标**：三工具（say_voice 除外）`quoteMsgId`；窗口挂点扩展 `triggerOf` 值形状（`quoteIds?: Set<string>`）或照 `bypassOf` 新增 FishOptions 回调，**随轮清理**（settle finally），不用会话级 Map；有效时同时置 `payload.quote=true` 与 `payload.quoteId=<该 id>`（否则 emit 层静默丢弃）。
7. **轮类型显式化**：`triggerOf` 值增加 `kind: "ambient" | "injection" | "answer"`（legacy 轮全部 answer/既有语义）；`mentionPolicyOf` 按轮类型判定（ambient/injection → 白名单 {master}∪watched；answer/legacy → 既有「被点名」语义）；语音骰仅 answer 轮且 isVoiceVip（ambient/injection 一律不掷——修正「环境轮 userId undefined」的错误前提：flushBurst 实际传 anchor.userId）；injection 轮 trigger 无 messageId 时 `say_mention_no_trigger` 分支按轮类型放行 @ 白名单。@ 放宽记审计日志。
8. **互斥分级**：in-flight 登记仅针对 **next 的 ambient/injection 轮**（submit 前 set、settle finally 删，并入 conversationBusy）；**@ 轮遇 in-flight 排队等待**（重试等待上限 60s，超时 busy_reply），绝不因在途环境轮丢必答；ambient/injection 遇 in-flight/换页/收图轮：injection 放弃本轮注入（宁少勿答）、ambient 组静默丢弃（沿用既有语义）；legacy 不登记、行为零变化。
9. **特别关注 = 纯设定集（next）**：记录机制照旧；`[特别关注]` 打标（injection 行与 @ 锚点行；legacy watch_inline 行为零变化）；runtime 软引导全局可见（措辞不属搭话机制，F8 已按此口径）。
10. **主人打标**：`[主人]` 与 [特别关注] 同套机制、master 优先互斥；**watch add 拒绝 master、applyWatched 装载过滤 master**（归 T5）；「你主人」锚点标注保留。
11. **奖惩 = 评价进长期记忆**：`/评 好|差 <文字>`（方向必填，主人闸前指令）。
11b. **评价包机械装配**：指向型（回复引用鱼消息）——经 **sentmap**（B2 方案①：drain 成功发送后持久化 `sentMessageId → outbound entryId` 映射，新 doc `fish.sentmap`，保留 30 天滚动清理；`onebot.sendGroup` 需改为返回 message_id）定位被评条目；查不到降级「最近一条 fish.outbound」并在回执注明降级；附带被引消息（quoteId 解析，recent/chatlog 不可得时标注缺失）+ 前 20 条会话摘要（conv.viewState 取，只存 pending）+ chatKey/人格/日期。范围型（不引用）——当日统计：当前人格当前会话 entry 计数 + chatlog 当日该群总条数（口径写进回执）；主人原文存 patch 专用字段（≤200 字，不进 fact 40 字限制）。评价事件写专用 entry `fish.eval`（进抽取白名单、排除摘要）。
12. **feedback 数据模型与渲染**：`MemoryFact` 扩展可选 `kind?: "feedback"` 与 `meta?`（上限：target 短摘要 ≤20 字 + 统计数字一行；**20 条上下文只存 pending，不进长期 doc**）；MEMORY_CAPS 为 meta 补独立上限；渲染 feedback 条目加权置顶（at+hits 保留）；`/评` 回执走 `fish.enqueue`（不产生 outbound entry、不进 transcript）；公共化脱敏对 meta 结构同构保留（文本字段以原 patch 为准重建）。
13. **沉默递进**：连续 N 窗零出口 → 下窗注入尾部 nudge；**backlog 空时提交 nudge-only 轮**；2N → backlog 窗口放宽 windowRelaxCap=30（**recent 上限同步提升至 max(30, windowRelaxCap)**，legacy 背景截断不受影响）；仅 ambient/injection 开口清零。
14. **GIF 收图轮、`/` 指令、私聊、旁路记账** next 下不变；backlog 注入过滤 `/` 指令与纯 GIF 收图消息。
15. **统一配置工具**：`config`（仅主人私聊轮；`chatKeyOf` 依赖经 FishOptions/packageDeps 新增接线——types + harness + index）；fish.config.json 受控字段中**热加载类**（engagement、engage、ambientMinIntervalSeconds、watchAmbientChance、voices、salvage 等）与**启动/重启类**（thinkingLevel、toolTimeoutSeconds 等，回执注明需 restart）在 TOOL.md 逐字段标注生效语义；config/models.json 角色表能力自 model 工具迁移（restart 生效）；旧 model 工具移除、全仓残留清理。
16. **群友画像**：people 唯一载体、在场/活跃优先渲染（≤900 字预算内机械加权）、受 MEMORY_CAPS 约束（大群旧画像按既有淘汰让位）；**people.md 的主人/关系静态设定保留**，仅动态群友画像/梗并入；抽取提示词要求持续提炼对某人的新印象（只进待审）。
17. **抽取评价机制**（调研方案一+二）：试金石提示词（few-shot 正反例 + 未来受益判准 + confidence low 不报 + signal 标注，signal 仅「命中 people 名单 / 与现有 fact 冲突」两类机械可得项）；对账三分类：候选 `{action: ADD|SUPERSEDE, subject, factId?(SUPERSEDE 必填), text, signal[], confidence}`，known = 公共 doc + 当前会话私有 doc 渲染结果（附 factId→subject 映射）；SKIP 仅计数不产出；**空 patch 与解析失败可判别**（解析失败按现行降级、不计零提取）；零提取阈值**常量 5**（src/memory.ts 常量，暂不配置化）；复查模式一次、宽松提示词、失败不清计数不阻塞换页；不自动 DELETE。方案三账本期不做。
18. **开关覆盖边界**：T2/T3/T4/T5/T8 及 ctx_engage_*/nudge 文案仅 next 态生效（runtime.md 的「自由交流窗口」小节做成 engagement 条件注入——T3 补 harness 接线）；T6/T7/T9/T10/T11 与开关无关，上线即生效，回退靠代码回滚；runtime 软引导（特别关注/主人措辞）全局可见，属 F8/F9 口径内的措辞变化。
19. **key 引用时序**：`test/prompts.test.ts` 断言新增 key 必须有 src 引用；T1 落 key 后到 T8 完成前 `npm test` 会红——**各任务验收只跑 `npm run prompts`，`npm test` 在收口（全任务完成）统一跑**；T1/T6/T9/T11 新增 key 的消费引用由对应消费任务落地。

## DAG

```text
T1 (文案契约) ──> T3 ──> T4 ──> T8
T2 (状态机+gate+配置) ──> T3
T3 ──> T5（串行：同写 index.ts/debounce.ts）
T5 ──> T6（串行：同写 index.ts）
T3 ──> T7（feedback 渲染消费轮类型/quoteIds 不冲突，仅排程稳妥）
T7 ──> T10、T7 ──> T11（同写 memory.ts，串行排程）
T2 ──> T9（无代码依赖，仅排程；T9 独立文件为主）
```

## Waves（串行为主，避免同文件并发）

- Wave 1：T1、T2（并行，文件不重叠）
- Wave 2：T3
- Wave 3：T4 → T5 → T6（串行链，均涉 index.ts）
- Wave 4：T7、T9（并行，文件不重叠）
- Wave 5：T8、T10、T11（T10/T11 串行：T10 → T11；T8 与其并行）
- 收口：主会话对照 F1-F14 终态核对（统一 `npm test` + `npm run prompts`）

**关键路径：** T1/T2 → T3 → T5 → T6 → 收口。

---

### Task 1：prompt 文案契约

**Deps：** `none`

**WritePaths：** `prompt/messages.md`、`prompt/runtime.md`

**接口契约：**
- Produces 新 key（不撞车；消费引用由 T3/T4/T8 落地，见决策 19）：
  - `ctx_engage_header`（`{{count}}`）——「你刚打开群，这是你不在时新冒出来的 {{count}} 条，都看一遍再决定要不要说话」
  - `ctx_engage_line`（`{{id}} {{name}} {{qq}} {{text}}`；主人 `[主人]`、特别关注 `[特别关注]`，master 优先互斥）
  - `ctx_engage_footer`——「说不说话你定：可以引用其中一条回（quoteMsgId 填那行 [m:…] 里的数字）、可以只吐槽、可以 @ 你感兴趣的人（只能 @ 主人和特别关注的人；语音不能 @ 也不能用 quoteMsgId，但可以照常引用正在回的那条）、也可以不出声。这个窗口里新进来的话你都会看到」
  - `ctx_engage_nudge_1` / `ctx_engage_nudge_2`
  - `quote_msg_invalid`
  - `eval_rejected`（群内非主人 /评 拒绝）、`eval_unknown_target`（定位降级注明）、`eval_receipt`（/评 回执，含方向/类型/定位结果摘要）
- Produces：runtime.md 两处——①「自由交流窗口」小节（**engagement 条件注入，T3 接线**；零出口合法、quoteMsgId 用法、@ 边界、语音限制）②特别关注/主人软引导（全局措辞）；`<watched>` section 保留
- 注意：`/评` 相关回执文案全部在此任务落 messages.md（禁止 src/ 字面量）

**终态关联：** F3、F5、F6、F8、F9、F10。

**验收标准：**
- [ ] 核对现有 key 无撞车、模板变量完整
- [ ] 新增 key 与 runtime 小节
- [ ] **只跑 `npm run prompts`**（npm test 留收口，决策 19）

---

### Task 2：状态机、gate free_pass、配置

**Deps：** `none`

**WritePaths：** `src/engage-next.ts`（新）、`src/fish-config.ts`、`src/qq/gate.ts`、`src/index.ts`、`fish.config.example`、`AGENTS.md`、`src/qq/gate.ts` 头注释

**接口契约：**
- Produces：`createEngageNext(deps: { groups(); recentOf(); busy(); onPhase(chatKey, phase, backlog); now(); setTimer/clearTimer })`——closed/openMinutes 循环；**每 tick 现读 fishConfig() 的 engagement**（无消息热切换）；open 进入回调 backlog = `(lastCloseSeq, now]` 排除 pending（T3 补查询口，本任务留 deps 位允许空实现）；closed 进入 lastCloseSeq = recent 末条 arrivalSeq（懒定）
- Produces：gate：`GateOptions.isOpen(chatKey)`（**缺省 = closed**）；next 分支 open → enter `free_pass`、closed → `skip:next_pending`；GateDecision 封闭集合加 `free_pass`
- Produces：配置 `engage: { closedMinutes: 10, openMinutes: 3, windowSize: 20, mentionContextSize: 5, silenceThreshold: 3, windowRelaxCap: 30 }`；**recent 上限提升为 max(30, windowRelaxCap)**（index.ts recent 截断处；legacy 背景截断不受影响）；非法告警保留缺省；热加载
- Produces：文档同步：AGENTS.md 第 7 节、fish.config.example、gate 头注释——next 语义改为「closed skip / open free_pass 两态」
- Produces：`src/index.ts` 接线（start/stop/热切换）

**终态关联：** F2、F7。

**验收标准：**
- [ ] 核对 gate next 早退、chances() 热加载、debounce 时钟先例、recent 截断点
- [ ] 实现状态机 + free_pass + 配置 + recent 上限 + 文档
- [ ] `npm run prompts` 干净；gate 相关既有测试不受影响（新增 engage 测试在授权下补）

---

### Task 3：injection 轮、轮类型与互斥

**Deps：** `T1`、`T2`

**WritePaths：** `src/index.ts`、`src/qq/debounce.ts`、`src/harness.ts`、`src/tools/types.ts`、`src/compact.ts`、`prompt/runtime.md`（条件 section 接线如需）

**接口契约：**
- Produces：**submitRound 增加 `entryKind` 参数**（默认现值，injection 用 `fish.engage_tick`）；compact renderTranscript 对 engage_tick **计入 entries/chars 阈值但不写 handoff 文本**
- Produces：**轮类型**：triggerOf 值加 `kind: "ambient" | "injection" | "answer"`（legacy 全 answer）；ambient 轮 = free_pass burst flush（trigger.userId=anchor.userId，kind=ambient）；injection 轮 trigger 无 messageId、kind=injection；packageDeps/harness 透传
- Produces：injection 注入轮（决策 4 格式 + backlog 过滤 `/` 指令与纯 GIF 消息）；遇忙放弃（宁少勿答）；quoteIds 窗口登记（决策 6 挂点，settle finally 清）
- Produces：**互斥分级**（决策 8）：ambient/injection in-flight 登记（并入 conversationBusy）；@ 轮 flushBurst 遇 in-flight **排队等待**（上限 60s 超时 busy_reply）；legacy 不登记零变化
- Produces：runtime.md「自由交流窗口」小节的 engagement 条件注入接线（harness）
- 注意：injection 不附 inline image block；@ 锚点行 watched/master 打标（T1 文案）

**终态关联：** F2、F3、F6、F8、F9。

**验收标准：**
- [ ] 核对 submitRound 签名/entry kind/compact 计数/flushBurst/triggers 装配
- [ ] 实现上述全部
- [ ] `npm run prompts` 干净

---

### Task 4：quoteMsgId 与 @ 白名单（按轮类型）

**Deps：** `T3`（轮类型与 quoteIds 窗口）

**WritePaths：** `src/tools/say_words|say_media|say_meme/TOOL.md + tool.ts`、`src/tools/say-shared.ts`、`src/tools/types.ts`、`src/index.ts`、`src/harness.ts`、`AGENTS.md`

**接口契约：**
- Produces：`quoteMsgId`（三工具；`[m:123]` 或裸数字）→ 属窗口有效 → **同时置 `payload.quote=true` 与 `payload.quoteId=<该 id>`** → 无效 tool 错误不计数额度 → 缺省不变
- Produces：`mentionPolicyOf` 按轮类型：ambient/injection → 白名单 {master} ∪ 本群 watched（成员校验照旧，拿不到名单拒）；answer/legacy → 既有语义；@ 放宽**记审计日志**；AGENTS.md 第 4 节修订含风险说明
- 语音骰仅 answer 轮（T3 的 kind 判定在此消费）

**终态关联：** F5、F6。

**验收标准：**
- [ ] 核对 say-shared 校验链、emit 四条件、mentionPolicyOf、triggerOf 消费
- [ ] 三工具实现 + 策略 + 审计 + AGENTS 修订
- [ ] `npm run prompts` Schema 正确

---

### Task 5：@ 轮背景 5 条与 watch 拒 master

**Deps：** `T2`、`T1`；与 T3/T4 串行（同文件）

**WritePaths：** `src/qq/debounce.ts`、`src/index.ts`、`src/tools/watch/tool.ts`、`test/watch*.test.ts`（随授权）、`AGENTS.md`

**接口契约：**
- Produces：next 下 **@ 轮（answer）背景** = mentionContextSize（默认 5）；ambient 轮背景沿用 10；legacy 恒 10；`backgroundFor` limit 改 ContextOptions 透传；GIF 轮 slice(-10) 不动
- Produces：**watch add 拒绝 master**（tool error）+ applyWatched 装载过滤 master；锚点行打标沿用 T1 文案（「你主人」保留）

**终态关联：** F4、F8、F9。

**验收标准：**
- [ ] 核对 backgroundFor/withContext/applyWatched/watch add
- [ ] 实现条件上限 + watch 拒 master
- [ ] `npm run prompts` 干净；watch 既有测试回归

---

### Task 6：/评 指令、sentmap 与待审管道

**Deps：** `T5`（串行同 index.ts）

**WritePaths：** `src/index.ts`（handleCommand、sentmap 写入）、`src/harness.ts`（drain 后 sentmap 记录，如发送链在此）、`src/qq/onebot.ts`（sendGroup 返回 message_id）、`src/memory.ts`（patch 构造 helper）、`prompt/messages.md`（key 已在 T1 落）

**接口契约：**
- Produces：`onebot.sendGroup` 返回 message_id；drain 成功后写 `fish.sentmap`（sentMessageId→entryId，30 天滚动清理）
- Produces：`/评 好|差 <文字>`（方向必填）：闸前特判（在 master 判断前识别 `/评`：群内非主人回 `eval_rejected`；私聊非主人静默——不违反私聊硬约束）；指向型经 sentmap 定位（降级最近一条 outbound 并回执注明 `eval_unknown_target`）；范围型带当日统计（口径见决策 11b）；评价包（结构化字段+原文 ≤200 字）写入待审；评价事件写 `fish.eval` entry（进抽取白名单、排除摘要）；回执走 `fish.enqueue`（不产生 outbound entry、不进 transcript）
- Produces：`/记忆` 待审列表兼容展示评价条目（含关联摘要）

**终态关联：** F10。

**验收标准：**
- [ ] 核对 handleCommand 顺序（/评 特判位置）、drain/发送链路、patch 结构与 id 生成
- [ ] 实现 sentmap + 指令 + 评价包 + fish.eval
- [ ] `npm run prompts` 干净

---

### Task 7：feedback 数据模型、渲染加权与抽取纳入

**Deps：** `T3`（排程稳妥）；`T6` 的 patch 结构（数据依赖）

**WritePaths：** `src/memory.ts`、`src/compact.ts`、`src/memory-extract.ts`、`prompt/`（抽取提示词对应文件）

**接口契约：**
- Produces：`MemoryFact` 扩展 `kind?: "feedback"`、`meta?`（上限：target 短摘要 ≤20 字 + 统计一行；20 条上下文只存 pending）；MEMORY_CAPS 补 meta 上限；批准 apply 时评价包结构字段进 meta（公共化脱敏对 meta 结构同构保留）
- Produces：渲染 feedback 加权置顶（at+hits 保留）；待审列表展示 meta 摘要
- Produces：抽取器纳入 `fish.eval` 事件（renderMemoryTranscript 白名单加 fish.eval、摘要排除）；抽取仍只进待审

**终态关联：** F10。

**验收标准：**
- [ ] 核对 MemoryFact/MEMORY_CAPS/渲染排序/publicizePatch/compact 白名单
- [ ] 实现扩展 + 加权 + 抽取纳入
- [ ] `npm run prompts` 干净

---

### Task 8：沉默递进与窗口放宽

**Deps：** `T3`

**WritePaths：** `src/engage-next.ts`、`src/index.ts`

**接口契约：**
- Produces：open 窗零出口计数（窗内任一 ambient/injection 轮调过 say_* 即算开口）；达阈值 → 下窗注入尾部 nudge；**backlog 空时提交 nudge-only 轮**（header+footer+nudge）；2×阈值 → backlog 窗口 = windowRelaxCap；开口清零（仅 ambient/injection）；@ 轮/私聊不计不清

**终态关联：** F11。

**验收标准：**
- [ ] 核对出口观测点（sayCalled per-round 同侧）
- [ ] 实现计数/nudge-only/放宽
- [ ] `npm run prompts` 干净

---

### Task 9：统一配置工具（并入 model）

**Deps：** `T2`（排程；独立文件为主）

**WritePaths：** `src/tools/config/TOOL.md + tool.ts`（新）、`src/tools/loader.ts`、`src/tools/types.ts`（chatKeyOf 依赖）、`src/harness.ts`（chatKeyOf 接线）、`src/index.ts`（装配）、`src/fish-config.ts`（导出校验函数供复用）、`prompt/ops.md`、`AGENTS.md`（第 1/2/3 节）、`README.md`、`test/tools.test.ts`（deferred 名单）、`test/config-tool.test.ts`（随授权）、`src/tools/model/`（删除）

**接口契约：**
- Produces：工具包 `config`（三处改动规范）：①fish.config.json 受控字段（字段白名单制；TOOL.md 逐字段标注**热加载生效 / 需 restart**——thinkingLevel、toolTimeoutSeconds 等属后者，回执注明）②config/models.json 角色表（复用 model 工具校验与写回，restart 生效）③读现状；非法/越界 tool 错误拒绝不落盘
- Produces：**仅主人私聊轮**：`chatKeyOf` 依赖（FishOptions → packageDeps 新增，types/harness/index 接线）；execute 二次校验触发者=master 且 chatKey=主人私聊；审计日志；回执文案在 TOOL.md tool-messages
- Produces：**移除 model 工具**：删 `src/tools/model/`、FACTORIES 条目、ops.md/AGENTS（第 1/2/3 节）/README（三处）/types 与 harness 的 modelsPath 注释引用；test/tools.test.ts deferred 名单改 `config`

**终态关联：** F12。

**验收标准：**
- [ ] 核对 model 工具全部能力与被引用处（grep 全仓）；FishOptions/packageDeps 装配链
- [ ] 实现 config 工具 + chatKeyOf + model 移除与全仓清理
- [ ] `npm run prompts`：config 正确列出、model 消失、无残留引用

---

### Task 10：群友画像并入长期记忆

**Deps：** `T7`

**WritePaths：** `src/memory.ts`、`src/compact.ts`、`src/memory-extract.ts`、`prompt/`（抽取/渲染提示词）、`prompt/README.md`、`AGENTS.md`（第 16 节）、`test/memory-people.test.ts`（随授权）

**接口契约：**
- Produces：画像 = people 结构强化（QQ 键累积叠加、YYYY-MM 锚点、supersede/淘汰照旧、**受 MEMORY_CAPS 约束——在场/活跃优先，大群允许旧画像让位**）；抽取提示词要求持续提炼对某人的新印象（只进待审）；渲染在场优先（当前轮/群出现的 QQ 机械加权，≤900 字预算内）
- Produces：**people.md 保留**：主人/关系静态设定不属群友画像、不迁移；仅「群里的人/梗」类动态内容并入（若 people.md 含此类内容，迁移后在文件中删除对应段落，prompt/README.md 同步）；不删 people section
- 探索性前置：先只读盘点画像类机制，列合并清单；冲突停下报告

**终态关联：** F13。

**验收标准：**
- [ ] 盘点 + 合并清单
- [ ] 实现叠加、在场优先、提示词、静态设定保留
- [ ] `npm run prompts` 干净；`npm run memory` 核对

---

### Task 11：抽取评价机制

**Deps：** `T7`（并建议在 T10 后串行，同写 memory 系文件）

**WritePaths：** `prompt/`（抽取提示词，执行时定位；新文件接 src/prompts.ts）、`src/memory-extract.ts`（三分类解析、判别、signal）、`src/memory.ts`（零提取计数、signal 存取）、`src/compact.ts`（复查模式挂点）、`src/harness.ts`（/记忆 头部提示）、`scripts/memory.ts`（待审列表 signal 标签）、`AGENTS.md`（第 16 节）、`test/compact-extract.test.ts`（随授权）

**接口契约：**
- Produces（决策 17 全量）：试金石提示词（唯一源 prompt/）；候选 `{action: ADD|SUPERSEDE, subject, factId?, text, signal[], confidence}`；known = 公共+当前私有渲染结果（附 factId→subject 映射）；SUPERSEDE 复用 readSupersede 的 subject+ids 结构；**空 patch vs 解析失败可判别**（解析失败降级不计零提取——修正 sanitizePatch 对未知形状返回空数组造成的误判）；signal 仅「命中 people 名单/与现有 fact 冲突」；零提取阈值常量 5；复查一次不循环；待审列表 signal 标签 + `/记忆` 头部「近 N 页零提取」提示（harness 的 memoryCommandReply 组装处）；不自动 DELETE
- 硬边界：抽取失败不阻塞换页；复查失败不清计数；提示词全在 prompt/

**终态关联：** F14。

**验收标准：**
- [ ] 核对 memory-extract 解析/sanitize/readSupersede、compact 抽取链、/记忆 组装
- [ ] 实现全部产出
- [ ] `npm run prompts` 干净；`npm run memory -- --pending` 展示核对

---

**新增测试清单（前置条件 2，须用户明确授权后创建）：**
- `test/engage-next.test.ts`：状态机迁移（含无消息热切换）、closed skip/open free_pass、backlog（pending 排除、过滤、截断）、懒基线、isOpen 缺省 closed、注入时钟
- injection 渲染（打标/[m:id]）、entry kind 排除但计入换页阈值、互斥分级（@ 排队 60s/ambient 丢弃/injection 放弃）
- 轮类型：mentionPolicyOf 三态、语音骰仅 answer、say_mention_no_trigger 分支
- quoteMsgId 三态 + quote/quoteId 双置；@ 白名单 + 审计
- @ 轮背景 5 条（ambient 10/legacy 10 对照）；watch 拒 master
- `/评` 全链路（sentmap 定位/降级、两型评价包、群内拒绝/私聊静默、meta 上限）；feedback 渲染加权与 meta 约束
- nudge/nudge-only 轮/放宽/清零口径
- `test/config-tool.test.ts`：仅主人私聊、两类配置生效语义、model 无残留
- `test/memory-people.test.ts`：画像叠加/在场优先/静态设定保留
- `test/compact-extract.test.ts`：三分类、空 patch vs 解析失败判别、零提取计数与复查
- 配置解析测试（engage 块缺省/非法/热加载，F7）
