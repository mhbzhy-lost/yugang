# 搭话模式 next（定时器驱动的自主搭话）实现计划 v3

> **给执行 agent：** 必须逐任务执行本计划；步骤使用 `- [ ]` 复选框跟踪。只有整体交付终态全部验证通过，才算计划执行完成；未满足时持续修复与验证。执行方式由计划编写完成后的用户选择决定。

**目标：** `engagement: "next"` 模式下，群聊搭话改为周期开窗：每 10 分钟开一个 3 分钟「自由交流」窗口——开窗先把积压消息注入，窗内新消息实时进模型输入，模型自由决定是否发言；关窗后定时器重新计时。@ 仍即时必答（背景缩为 5 条）。奖惩 = 主人评价进长期记忆 + 渲染加权。

**架构：** engage-next 状态机（closed/open 两态，按群）控制 gate：open 态下非 @ 群消息以 `free_pass` 过闸、走既有 10 秒合并管线提交（mustAnswer=false）；closed 态照旧 `skip:next_pending`。开窗瞬间先把上次关窗以来的积压消息注入一轮。出口工具增加 `quoteMsgId`（引用本轮注入窗口内任意一条）。legacy（默认）零变化。

**技术栈：** TypeScript / pi-durable（submitRound / conversation）、现有 debounce 合并管线、fish-config mtime 热加载、prompt/messages.md 模板体系、fish.memory 审批闸。

## 前置条件（硬）

1. engagement 开关任务（gate next_pending / fish-config engagement 字段）已实现并**先于本计划落 commit**。
2. 本计划尾部新增测试清单已取得用户明确授权；未授权前不得开始执行。

## 全局约束

- 模型能看到的文字只来自 `prompt/` 与 `src/tools/<name>/TOOL.md`；`src/` 无大段 prompt 字面量（≥12 汉字阈值）；模板 `{{var}}` 严格替换
- 出口只有 say_words / say_media / say_meme / say_voice（共享每轮 3 次额度）；校验失败以 tool 错误返回，不静默丢弃
- 主动 @ 机械边界：open 态环境轮允许 @，目标仅限 {主人} ∪ 当前群特别关注名单且为真实成员（机械校验）——是对 AGENTS.md 第 4 节「被点名要求」语义的修订，须同步改 AGENTS.md；legacy 不变；say_voice 无 mentions 不变
- 一轮一条附件、台词 ≤200 字等既有出口限制不变
- 配置走 `fish.config.json`；新字段非法值告警保留缺省（不崩进程）
- 不开内置 compaction；摘要只收群友的话 + 鱼发出去的话（engage 轮专用 entry kind 排除）
- next 不上线（生产保持 legacy）；本计划不 commit、不部署
- 同一会话不许并发提交：engage 注入轮/环境轮与 @ 轮/换页/收图轮/在途轮互斥

## 整体交付终态

| ID | 必须成立的条件 | 验证方法与环境 | 通过判据 | 证据位置 | 覆盖任务 |
| --- | --- | --- | --- | --- | --- |
| F1 | legacy 模式行为零变化 | `npm test`（本地） | 全部既有测试通过 | 测试输出 | T1-T8 |
| F2 | 状态机按群运行：closed 10 分钟（可配）→ open 3 分钟（可配）→ 循环；closed 态非 @ 群消息 `skip:next_pending` 不进模型；open 态非 @ 群消息以 `free_pass` 过闸进既有 10 秒合并管线（mustAnswer=false，零出口合法无 salvage） | engage-next 单测 + gate 单测 + 日志 | 态迁移精确、closed 零提交、open 走管线 | 测试输出 | T2、T3 |
| F3 | 开窗注入：open 瞬间把「上次关窗以来」的积压消息注入一轮（每条带 `[m:<id>]` 标记，>windowSize 截最近 N，不足按实际）；之后窗内新消息走 burst 实时进；开窗时无积压则跳过注入轮（后续靠 burst） | 单测断言渲染与游标 | 积压一轮注入、窗内无重复注入 | 测试输出 | T3 |
| F4 | @ 必答轮在 next 下背景缩为最近 5 条（含整组），必答/salvage/引用语义不变；@ 在任意态（含 closed）都即时进 | 单测 + 既有必答回归 | 背景 ≤5；@ 仍必答 | 测试输出 | T5 |
| F5 | say_* 支持 `quoteMsgId`（接受 `[m:…]` 或裸数字）；属本轮注入窗口（开窗注入轮的积压集合，或环境轮/@ 轮的整组+背景）才有效；有效强制 quote 生效；无效 tool 错误不计数额度；缺省现行为不变 | 单测 + schema 校验 | 合法挂、非法拒、缺省零变化 | 测试输出 | T4 |
| F6 | open 态环境轮零出口合法；可 @ 目标 ∈ {主人} ∪ 本群 watched（成员校验照旧），越界拒绝 | 单测 + runtime.md 核对 | 零出口安静结束；@ 白名单生效 | 测试输出 | T3、T4、T1 |
| F7 | engage 配置（closedMinutes=10 / openMinutes=3 / windowSize=20 / mentionContextSize=5 / silenceThreshold=3 / windowRelaxCap=40）缺省合法、非法告警保留缺省、热加载生效 | 配置解析单测 | 判据如左 | 测试输出 | T2 |
| F8 | 特别关注无任何强制机制（不进 gate、不掷语音骰）；名单与备注照常记录；watched 消息行带「[特别关注]」标记；runtime 仅软引导 | 单测 + runtime.md 核对 | 标记存在、无 watched gate 分支 | 测试输出 | T1、T3、T5 |
| F9 | 主人不入特别关注列表，消息行带「[主人]」标记（互斥）；@ 轮锚点行「你主人」标注保留；runtime 软引导；无新增强制 | 单测 + runtime.md 核对 | 标记存在互斥 | 测试输出 | T1、T3、T5 |
| F10 | 主人 `/评 好|差`（引用鱼消息定位，群友拒绝）生成待审记忆 patch，经审批闸入人格 doc；评价类条目渲染加权置顶；未批准永不注入 | 记忆链路单测 | 待审/批准/拒绝/群友拒绝/加权全覆盖 | 测试输出 | T6、T7 |
| F11 | 连续 silenceThreshold 个 open 窗口全程零出口 → 下一窗注入尾部递进文案；超 2×阈值 → 下窗积压窗口放宽至 windowRelaxCap；模型任一轮开口清零；仅统计 open 窗口（@ 轮不计不清） | 单测 | 阈值触发文案与放宽 | 测试输出 | T8 |

**完成规则：** F1-F11 全部满足且证据对应当前版本才完成；步骤勾选不替代终态验证。

**未满足时：** 授权范围内 fix → test → 对照终态；阻塞记录未完成与恢复路径。

## 设计决策

1. **状态机按群、内存态**：`Map<chatKey, {phase: "closed"|"open", phaseSince: number, lastCloseSeq}>`。计时用可注入时钟（debounce 先例）。重启/热切换 legacy→next：进入 closed 态从零计时，`lastCloseSeq` 懒定基线（首个有消息时刻），宁少勿答。
2. **closed 态**：非 @ 消息照旧 `skip:next_pending`（旁路记账照常）；积压只靠 recent 流水承载，不单独存。
3. **open 态**：gate 的 next 早退分支改为放行 `free_pass`（非必答、不刷限流时钟——限流门在 next 下本就整体失效）；消息走既有 10 秒按发送者合并 → flushBurst 提交，trigger.mentionsBot=false。开窗瞬间：若 recent 存在 `> lastCloseSeq` 的积压，先提交一轮「开窗注入」（决策 4）；窗内后续新消息靠 burst 自然进（与注入轮的边界：注入轮覆盖到开窗瞬间，之后全归 burst，游标推进到开窗时刻 recent 末条，不重复注入）。
4. **开窗注入轮**：user message = `ctx_engage_header + ctx_engage_line×N + ctx_engage_footer`（积压消息，`[m:<messageId>]` 标记，watched/master 打标）；不传 mustAnswer；专用 entry kind `fish.engage_tick`（参照 MEMORY_GIF_KIND 先例，摘要/抽取白名单排除）；**仍处在 pending burst 里的消息不进积压**（会由 burst 进，不双份）。
5. **@ 轮**：任何 phase 都即时进（gate mentioned 分支最先），仅背景上限 10→mentionContextSize（默认 5）；@ 轮与 open 窗环境轮并存时靠互斥（决策 8）排队/丢弃语义。
6. **引用目标**：say_words/say_media/say_meme 新增可选 `quoteMsgId`（机械剥离 `[m:…]` 包装）；有效时强制 `payload.quote = true`（防 emit 静默丢弃）；窗口集合挂点扩展 `triggerOf` 值形状或照 `bypassOf` 先例新增回调，随轮清理（settle finally），不用会话级 Map。
7. **语音骰**：环境轮 trigger.userId undefined → 现状自洽不掷；不为 @ 能力伪造 trigger。
8. **互斥**：in-flight submitRound 登记进 conversationBusy（submit 前 set、settle finally 删）；开窗注入轮遇忙则本轮注入放弃（积压顺延到下窗？**否**——直接丢弃注入轮，窗内 burst 照常，宁少勿答）；burst flush 遇忙照旧（@ 轮回 busy_reply，环境轮静默丢组，沿用既有语义）。
9. **特别关注 = 纯设定集**（next）：记录机制照旧、无强制；`[特别关注]` 打标（注入行与 @ 锚点行）；runtime 软引导。
10. **主人打标**：`[主人]` 标记，同套机制互斥；runtime 软引导；既有主人待遇不变不增。
11. **奖惩 = 评价进长期记忆**：`/评 好|差`（主人闸前指令，回复引用鱼的消息定位）→ 待审 patch（方向、摘录 ≤40 字、originChatKey）→ 审批闸入人格 doc。不设 feedback section、不自动调参、不用模型评模型。
12. **记忆提取/渲染考虑奖惩**：feedback 条目（`kind:"feedback"` 机械标记）渲染加权置顶（at+hits 机械规则保留）；抽取器纳入主人评价事件（仍只进待审）。
13. **沉默递进**：连续 N 个 open 窗零出口 → 下窗注入尾部 nudge 文案；2N → 积压窗口放宽 windowRelaxCap；开口清零；仅统计 open 窗。
14. **GIF 收图轮、`/` 指令、私聊、旁路记账** next 下不变（开关任务已保证）。

## DAG

```text
T1 (prompt 文案) ──> T3 (开窗注入与环境轮) ──> T4 (quoteMsgId) ──> T8? 否，T8 依赖 T3
T2 (状态机+gate free_pass+配置) ──> T3
T3 ──> T5 (@背景5条，串行同文件)
T3 ──> T8 (沉默递进)
T2 ──> T6 (评价→记忆)
T6 ──> T7 (渲染/抽取奖惩)
全部 ──> 回归（并入 T5 收尾后统一核对，见 T5 步骤 3 与完成规则）
```

## Waves

- Wave 1：T1、T2（并行）
- Wave 2：T3（T1+T2 完成后）
- Wave 3：T4、T5（T4 并行 T5；T5 与 T3 串行已完成）、T6（可与 Wave 2 并行）
- Wave 4：T7、T8
- 收口：全任务完成后主会话对照 F1-F11 终态核对（不设独立 T 任务，由主会话执行）

**关键路径：** T1 → T3 → T4/T5 → 终态核对。

---

### Task 1：prompt 文案契约

**Deps：** `none`

**WritePaths：** `prompt/messages.md`、`prompt/runtime.md`

**Files：** Modify 两个文件

**接口契约：**
- Produces 新 key（不撞车）：
  - `ctx_engage_header`（`{{count}}`）——「你刚打开群，这是你不在时新冒出来的 {{count}} 条，都看一遍再决定要不要说话」
  - `ctx_engage_line`（`{{id}} {{name}} {{qq}} {{text}}`；主人 `[主人]`、特别关注 `[特别关注]`，互斥）
  - `ctx_engage_footer`——「说不说话你定：可以引用其中一条回（quoteMsgId 填那行 [m:…] 里的数字）、可以只吐槽、可以 @ 你感兴趣的人（只能 @ 主人和特别关注的人，语音带不了 @ 和引用）、也可以不出声。这个窗口里新进来的话你都会看到」
  - `ctx_engage_nudge_1` / `ctx_engage_nudge_2`：沉默递进两级（人格化措辞）
  - `quote_msg_invalid`：quoteMsgId 无效的 tool 错误文案
- Produces：runtime.md「自由交流窗口」小节（零出口合法、quoteMsgId 用法、@ 边界、语音限制、窗口内新消息会持续进来）+ 特别关注/主人软引导措辞；`<watched>` section 保留为查询设定集

**终态关联：** F3、F5、F6、F8、F9。

**验收标准：**
- [ ] 核对现有 key（含 `watch_inline`）无撞车
- [ ] 新增 key 与 runtime 小节，全中文单一实现
- [ ] `npm run prompts` 干净；`npm test` 绿

---

### Task 2：状态机、gate free_pass 与配置

**Deps：** `none`

**WritePaths：** `src/engage-next.ts`（新）、`src/fish-config.ts`、`src/qq/gate.ts`、`src/index.ts`

**Files：** Create `src/engage-next.ts`；Modify 其余三个

**接口契约：**
- Consumes：index.ts 模块内 `recent` Map 与 `RecentChatMessage`（无独立模块，经参数传）；engagement 开关；groups 白名单；debounce pending 查询口（如需排除 pending，可由 T3 补）
- Produces：`createEngageNext(deps: { groups(): string[]; recentOf(chatKey): RecentChatMessage[]; onPhase(chatKey, phase, backlog: RecentChatMessage[]): void; now(): number; setTimer/clearTimer }): { start(); stop() }`——closed（closedMinutes）→ open（openMinutes）循环；open 进入时回调 backlog = `(lastCloseSeq, now]` 排除 pending（pending 查询若 T3 才有，本任务先留 deps 位并允许空实现）；closed 进入时 lastCloseSeq = 当前 recent 末条 arrivalSeq（无消息则懒定）
- Produces：gate 扩展：`GateOptions.isOpen(chatKey)`（或等价）；next 分支改判：open → enter `free_pass`（非必答、不 markHandled 限流时钟）；closed → `skip:next_pending`；`GateDecision` skip/enter 封闭集合加 `free_pass`
- Produces：配置 `engage: { closedMinutes: 10, openMinutes: 3, windowSize: 20, mentionContextSize: 5, silenceThreshold: 3, windowRelaxCap: 40 }`，非法告警保留缺省，热加载；fish.config.example 同步
- Produces：engagement==="next" start / 热切换 start-stop；legacy 不启动

**终态关联：** F2、F7。

**验收标准：**
- [ ] 核对 gate next 早退分支、chances() 热加载接线、debounce 时钟注入先例
- [ ] 实现状态机 + gate free_pass + 配置
- [ ] `npm test` 绿；日志 `engage:open` / `engage:close` / `skip:next_pending` 证据

---

### Task 3：开窗注入轮与环境轮管线

**Deps：** `T1`、`T2`

**WritePaths：** `src/index.ts`、`src/qq/debounce.ts`（pending 查询口，最小）

**Files：** Modify 两个文件

**接口契约：**
- Consumes：T1 文案；T2 onPhase(chatKey,"open",backlog)；submitRound 真实签名（**不传 mustAnswer**）；MEMORY_GIF_KIND 先例
- Produces：backlog 非空 → 提交开窗注入轮（决策 4 格式，entry kind `fish.engage_tick`，compact.ts 白名单确认排除）；遇忙放弃注入（窗内 burst 照常）；quoteIds 窗口登记（决策 6 挂点，随轮清理）
- Produces：环境轮（free_pass burst flush）自然走既有管线：整组语义/背景栏照旧（背景上限走 T5 的 mentionContextSize）、零出口无 salvage、`fish.inbound` entry 沿用环境轮现有 kind（它们是真实群消息，应进摘要/抽取——**区别于注入轮**：注入轮是宿主拼装的积压视图，用 engage_tick 排除）
- Produces：in-flight submitRound 登记（conversationBusy 扩展，决策 8）
- 注意：注入轮不附 inline image block（图片占位渲染）

**终态关联：** F2、F3、F6、F8、F9。

**验收标准：**
- [ ] 核对 submitRound/entry kind/compact 白名单/flushBurst busy
- [ ] 实现注入轮、互斥登记、quoteIds
- [ ] `npm test` 绿；`npm run prompts` 干净

---

### Task 4：出口工具 quoteMsgId 与环境轮 @ 白名单

**Deps：** `T3`（quoteIds 窗口）

**WritePaths：** 三个 say 工具的 `TOOL.md`/`tool.ts`、`src/tools/say-shared.ts`、`src/harness.ts`、`AGENTS.md`

**接口契约：**
- Produces：`quoteMsgId`（schema：接受 `[m:123]` 或裸数字）→ 属窗口有效 → 强制 `payload.quote = true` → 无效 tool 错误不计数额度 → 缺省不变
- Produces：mention 策略：free_pass/engage 轮（trigger.userId undefined 且轮为环境轮）允许 @ ∈ {master} ∪ 本群 watched，成员校验照旧；legacy 与必答轮语义不变；AGENTS.md 第 4 节措辞修订
- 不伪造 trigger.userId（语音骰维持不掷）

**终态关联：** F5、F6。

**验收标准：**
- [ ] 核对 say-shared 校验链、emit 四条件、mentionPolicyOf
- [ ] 三工具实现 + AGENTS.md 修订
- [ ] `npm test` 绿；`npm run prompts` Schema 正确

---

### Task 5：@ 轮背景缩为 5 条（next 模式）

**Deps：** `T2`、`T1`；与 T3 串行（同文件）

**WritePaths：** `src/qq/debounce.ts`、`src/index.ts`

**接口契约：**
- Produces：next 下 @ 轮背景 = mentionContextSize（默认 5）；legacy 恒 10；`backgroundFor` 的 limit 默认参数改 ContextOptions 透传；锚点行 watched/master 标记（T1 文案，「你主人」保留）；GIF 轮 `slice(-10)` 不动

**终态关联：** F4、F8、F9。

**验收标准：**
- [ ] 核对 backgroundFor/withContext 签名与既有测试
- [ ] 实现条件上限
- [ ] `npm test` 绿

---

### Task 6：评价指令与待审记忆管道

**Deps：** `T2`（串行稳妥；无代码依赖）

**WritePaths：** `src/index.ts`（handleCommand）、`src/memory.ts`（最小）

**接口契约：**
- Produces：`/评 好|差`（主人闸前指令，回复引用鱼消息定位；群友/陌生人拒绝回执）：待审 patch `{方向, 摘录≤40字, originChatKey}`，跨人格唯一 id，不直接落库；回执不进 transcript/摘要
- Produces：`/记忆` 待审列表兼容展示评价条目

**终态关联：** F10。

**验收标准：**
- [ ] 核对 handleCommand、pending patch 结构与 id 生成
- [ ] 实现指令与写入
- [ ] `npm test` 绿

---

### Task 7：记忆渲染与抽取的奖惩逻辑

**Deps：** `T6`

**WritePaths：** `src/memory.ts`、`src/compact.ts`

**接口契约：**
- Produces：feedback 条目（`kind:"feedback"`）渲染加权置顶（at+hits 保留、加权为额外机械规则）；抽取器纳入主人评价事件（仍只进待审）；sanitize/结构过滤照旧；MEMORY_CAPS 不豁免、渲染期零写入

**终态关联：** F10。

**验收标准：**
- [ ] 核对 MEMORY_CAPS/排序/抽取白名单
- [ ] 实现加权与抽取
- [ ] `npm test` 绿

---

### Task 8：沉默递进与窗口放宽

**Deps：** `T3`

**WritePaths：** `src/engage-next.ts`、`src/index.ts`

**接口契约：**
- Consumes：T1 nudge 文案；T2 silenceThreshold/windowRelaxCap；open 窗出口观测（窗内任一轮调过 say_*）
- Produces：连续零出口窗计数——达阈值 → 下窗注入尾部 `ctx_engage_nudge_1`；2×阈值 → `ctx_engage_nudge_2` + 下窗 backlog 窗口 = windowRelaxCap；开口清零；仅统计 open 窗（@ 轮/私聊不计不清）

**终态关联：** F11。

**验收标准：**
- [ ] 核对出口观测点（sayCalled per-round 同侧）
- [ ] 实现计数/文案/放宽
- [ ] `npm test` 绿

---

**新增测试清单（前置条件 2，须用户明确授权后创建）：**
- `test/engage-next.test.ts`：状态机迁移、closed skip/open free_pass、backlog 计算（pending 排除、截断）、懒基线、热切换、注入时钟
- 开窗注入渲染（打标/[m:id]）、entry kind 排除、互斥三向（在途轮/注入/burst）
- 环境轮零出口无 salvage；quoteMsgId 三态 + quote 强制；环境轮 @ 白名单
- @ 轮背景 5 条；`/评` 全链路；feedback 加权；nudge 与放宽
