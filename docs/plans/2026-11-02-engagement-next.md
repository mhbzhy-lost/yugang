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
| F10 | 主人 `/评`（回复引用鱼消息=指向型；不引用=范围型，群友一律拒绝）机械装配评价包：方向、评价原文、结构化关联字段（见决策 11b）；待审→审批→入人格 doc；评价类条目渲染加权置顶；未批准永不注入；提取时关联字段不丢失 | 记忆链路单测 | 两类评价包的结构化字段完整入库、渲染可见关联、群友拒绝 | 测试输出 | T6、T7 |
| F11 | 连续 silenceThreshold 个 open 窗口全程零出口 → 下一窗注入尾部递进文案；超 2×阈值 → 下窗积压窗口放宽至 windowRelaxCap；模型任一轮开口清零；仅统计 open 窗口（@ 轮不计不清） | 单测 | 阈值触发文案与放宽 | 测试输出 | T8 |
| F12 | 新增主人专属统一配置工具，一切配置变更只走它（首批覆盖 fish.config.json 全部受控字段，含 engagement 开关与 engage 参数；写后热加载生效）；仅主人私聊轮生效（群内轮一律拒绝，execute 内核二次身份校验）；操作打审计日志；非法值拒绝 | 工具单测 + prompts 审查 | 仅主人私聊轮生效、群内拒绝、合法写入热加载生效、非法拒绝、越界字段拒绝、TOOL.md 唯一文档源 | 测试输出 | T9 |
| F13 | 每个群友的画像统一并入长期记忆：按人格隔离、以 QQ 为键的累积式印象条目（交流中不断叠加、带时间锚点，经审批闸入库）；无独立于 fish.memory 的第二套画像存储；渲染时在场群友的画像优先可见 | 记忆链路单测 + npm run memory 产物核对 | 画像条目累积叠加、跨会话同 QQ 合并、无重复存储、渲染按在场优先 | 测试输出 | T10 |
| F14 | 抽取评价机制落地：试金石提示词（few-shot 正反例 + 未来受益试金石 + confidence low 不报 + signal 标注）；对账三分类 ADD/SUPERSEDE/SKIP（无自动 DELETE）；零提取计数器与复查兜底（连续 N 页零提取提示 + 一次复查，不阻塞换页）；待审条目展示机械信号标签 | 抽取器单测 + npm run prompts | few-shot 在 prompt/ 唯一源、三分类结构输出被 sanitize 通过、零提取页计数与复查路径正确、待审列表含标签 | 测试输出 | T11 |

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
11. **奖惩 = 评价进长期记忆**：`/评 <文字>`（主人闸前指令，群友/陌生人拒绝）——不设 feedback section、不自动调参、不用模型评模型。
11b. **评价包机械装配（关联性不靠模型事后还原）**：
    - **指向型**（回复引用了鱼某条消息）：机械抓取 ①被评 outbound 条目 id + 其文本 ②该条若带 quoteId → 同包附带被引消息（鱼当时回的那条）③该条之前最近 20 条会话消息（inbound/outbound 按序，只存 id+摘要行）④chatKey、人格、日期。主人文字原文照存。例：「你这条回复不恰当」→ 包里天然带着「哪一条 + 它回的是谁 + 当时前后 20 条」。
    - **范围型**（不引用，直接 `/评 你今天聊太多了`）：机械抓取 ①当日该人格在当前群的发言条数统计 ②当日该群消息总条数（对照背景）③chatKey、人格、日期。评价语所指的「今天/本群/这个人格」由这些字段机械固定，不靠措辞解析。
    - patch 结构：结构化字段（target/stats/scope）+ 主人原文；**入待审时结构字段随 patch 持久化**，批准 apply 时结构字段进 fact 的机械元数据（不进自由文本），渲染时与 text 一同可见，抽取器消费的就是这些结构字段——保证「谁/何时/哪群/哪条/前后文」的关联在提取时不丢失。
12. **记忆提取/渲染考虑奖惩**：feedback 条目（`kind:"feedback"` 机械标记）渲染加权置顶（at+hits 机械规则保留）；抽取提示词（prompt/ 下对应文件）明确要求：评价类事实必须保留其结构化关联（对象消息、范围、群、人格、日期），不得降维成孤立的「主人说过 X」；抽取仍只进待审。
13. **沉默递进**：连续 N 个 open 窗零出口 → 下窗注入尾部 nudge 文案；2N → 积压窗口放宽 windowRelaxCap；开口清零；仅统计 open 窗。
14. **GIF 收图轮、`/` 指令、私聊、旁路记账** next 下不变（开关任务已保证）。
15. **鱼可自改配置，入口只有一个**：新增主人专属统一配置工具 `config`（范式同 `model` 工具），一切配置变更都走它，**不为 engage 单独建工具**。首批覆盖 fish.config.json 全部受控字段（engagement、engage 块、ambientMinIntervalSeconds、watchAmbientChance 等，具体字段清单在 TOOL.md schema 定义）；写后靠 mtime 热加载生效；**仅主人私聊轮可用**（群内轮一律拒绝；factory 无 MASTER_QQ 返回 undefined，execute 内核二次校验 chatKey 是否主人私聊）；审计日志；非法/越界值以 tool 错误拒绝且不落盘。既有 `model` 工具（改 config/models.json）是否并入由用户裁定，未裁定前不动。
16. **群友画像统一并入长期记忆**（用户已定）：以 fish.memory 的 people 结构为唯一画像载体（按人格隔离、QQ 为键、事实条目累积叠加、带 YYYY-MM 时间锚点，享既有 supersede/上限/淘汰规则），**不另建第二套画像存储**；若发现存在独立的画像/印象机制（如静态人物档），评估后合并入 people 并废弃旧入口；抽取提示词要求：在与某人的交流中持续提炼对其的新印象（只进待审）；渲染时在场群友（当前群/当前轮出现的人）画像优先可见（现有在场/关键词门槛的强化）。跨群同 QQ 在同一人格内自然合并（公共层语义）。
17. **抽取评价机制（基于 2026-11 社区调研，方案一+二，用户已确认纳入）**：
    - **试金石提示词（方案一）**：抽取提示词重写为三件套——①mem0 式 few-shot 正反例（正：新群友身份/梗的来历/主人的约定/对鱼的纠正/对某人的新印象；反：「在吗」「哈哈哈」、纯情绪宣泄、一次性闲聊）；②试金石「未来对话会受益吗？」（durable：偏好/带日期的决定/特质 ✅；ephemeral/不可证伪的模糊断言 ❌）+ confidence low 默认不报；③每条候选带 `signal` 标注（涉及人物 / 冲突旧记忆 / 情绪强度 / 承诺日期 / 模式重复），signal 只作待审列表展示标签辅助主人批，不参与硬判。
    - **对账三分类（方案二）**：抽取器输入 = 本页原话 + 当前人格公共+私有记忆渲染结果；每条候选三选一：`ADD`（新）/ `SUPERSEDE <fact-id>`（取代旧条，沿用 supersede 审计链）/ `SKIP`（附一句理由）。不做自动 DELETE——业界实测（Zep/Graphiti）自动失效 70% 错杀仍为真的事实，我们的待审闸把错杀风险转为误报待审。
    - **摆烂兜底（计数器，非强制配额）**：允许整页零提取；但连续 N 页（默认 5，可配）零提取时：①`/记忆` 待审汇总头部打「近 N 页零提取」提示；②自动追加一次「复查模式」抽取（更宽松提示词，只跑一次不循环，失败不清计数不阻塞换页）。强制最低量会制造噪音（mem0 实证），不采用。
    - 机械信号免费可用：候选命中既有 people 主体名、与现有 fact 文本冲突、主人参与轮、@鱼轮——作为待审条目的展示标签。
    - 方案三（显著度账本后验淘汰：注入/召回/拒绝历史计数与降权）**本期不做**，待审数据积累后再议。

## DAG

```text
T1 (prompt 文案) ──> T3 (开窗注入与环境轮) ──> T4 (quoteMsgId) ──> T8? 否，T8 依赖 T3
T2 (状态机+gate free_pass+配置) ──> T3
T3 ──> T5 (@背景5条，串行同文件)
T3 ──> T8 (沉默递进)
T2 ──> T6 (评价→记忆)
T6 ──> T7 (渲染/抽取奖惩)
T2 ──> T9 (统一配置工具)
T7 ──> T10 (群友画像并入记忆)
T7 ──> T11 (抽取评价机制)
全部 ──> 回归（并入 T5 收尾后统一核对，见 T5 步骤 3 与完成规则）
```

## Waves

- Wave 1：T1、T2（并行）
- Wave 2：T3（T1+T2 完成后）
- Wave 3：T4、T5（T4 并行 T5；T5 与 T3 串行已完成）、T6（可与 Wave 2 并行）
- Wave 4：T7、T8、T9、T10、T11
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
- Produces：`/评 <文字>`（主人闸前指令）：指向型（回复引用鱼消息）与范围型（不引用）两类评价包，按决策 11b 机械装配结构化字段（被评条目/被引消息/前 20 条上下文或当日统计/群/人格/日期）；生成待审 patch（结构字段 + 主人原文，跨人格唯一 id，不直接落库）；回执不进 transcript/摘要；群友/陌生人拒绝回执
- Produces：`/记忆` 待审列表兼容展示评价类条目（含关联摘要：哪条/哪群/哪天）

**终态关联：** F10。

**验收标准：**
- [ ] 核对 handleCommand、fish.outbound/recent/chatlog 的可抓取字段（quoteId、发送序）、pending patch 结构与 id 生成
- [ ] 实现指令与写入
- [ ] `npm test` 绿

---

### Task 7：记忆渲染与抽取的奖惩逻辑

**Deps：** `T6`

**WritePaths：** `src/memory.ts`、`src/compact.ts`

**接口契约：**
- Produces：feedback 条目（`kind:"feedback"`）渲染加权置顶（at+hits 保留、加权为额外机械规则）；批准 apply 时评价包的结构化字段进 fact 机械元数据，渲染时随 text 可见；抽取提示词（prompt/ 对应文件）要求评价类事实保留结构化关联不降维；抽取器纳入评价事件（仍只进待审）；sanitize/结构过滤照旧；MEMORY_CAPS 不豁免、渲染期零写入

**终态关联：** F10。

**验收标准：**
- [ ] 核对 MEMORY_CAPS/排序/抽取白名单/抽取提示词文件位置
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

### Task 9：统一配置自改工具（主人专属）

**Deps：** `T2`（engage 配置块结构与合法性规则）

**WritePaths：**
- `src/tools/config/TOOL.md`（新）
- `src/tools/config/tool.ts`（新）
- `src/tools/loader.ts`
- `prompt/ops.md`
- `AGENTS.md`
- `test/config-tool.test.ts`（随前置条件 2 授权）

**接口契约：**
- Consumes：T2 的 engage 配置块；fish-config 全部字段的既有校验规则（同源复用，不另写一份合法性规则）
- Produces：工具包 `config`——**唯一配置变更入口**，严格遵循三处改动规范（TOOL.md 三元数据块 + tool.ts defineTool + loader FACTORIES 注册）：支持读现状与改 fish.config.json 受控字段（首批：engagement、engage 块、ambientMinIntervalSeconds、watchAmbientChance 及其它已有运行时参数；入参在 TOOL.md schema 定义，字段白名单制，拒绝越界字段与非法值）；写回仅限白名单字段；热加载生效；**仅主人私聊轮可用**（factory 无 MASTER_QQ 返回 undefined，execute 内核二次校验：触发者=主人且会话为主人私聊，群内轮拒绝）；审计日志；回执文案放 TOOL.md tool-messages 块；prompt/ops.md 同步（把「改配置」的引导指向本工具）；AGENTS.md 第 3 节能力面清单更新；**不动 `model` 工具**（是否并入 config/models.json 管理由用户另行裁定）

**终态关联：** F12。

**验收标准：**
- [ ] 步骤 1：核对 model 工具范式（factory/身份校验/审计/写回）与 loader 注册规范、fish-config 全部字段校验入口
- [ ] 步骤 2：实现工具包三处改动 + ops.md + AGENTS.md
- [ ] 步骤 3：`npm test` 绿；`npm run prompts` 新工具正确列出（deferred）且文案 key 无撞车

---

### Task 10：群友画像并入长期记忆

**Deps：** `T7`（记忆渲染/抽取的奖惩逻辑先行，people 结构改造在其上）

**WritePaths：**
- `src/memory.ts`
- `src/compact.ts`（抽取提示词接入，如抽取提示词在 prompt/ 下则改对应文件）
- `prompt/memory-*.md`（如抽取/渲染提示词在此）
- `AGENTS.md`（第 16 节补充画像语义）
- `test/memory-people.test.ts`（随前置条件 2 授权）

**接口契约：**
- Consumes：T7 的 feedback 结构与渲染加权实现；现有 fish.memory people 结构（人 ≤12、每人事实 ≤8、names ≤5）
- Produces：画像 = people 结构的强化语义（不建新存储）：以 QQ 为键累积叠加印象条目（带 YYYY-MM 锚点，supersede/淘汰规则照旧）；抽取提示词要求在与某人交流中持续提炼新印象（只进待审）；渲染在场优先：当前轮/当前群出现的 QQ 其画像条目优先可见（在现有 ≤900 字预算与排序规则内加权，机械规则）；排查并合并任何独立的画像/印象机制（如静态人物档、watched 备注——watched 备注是运维设定不属画像，保留），合并后废弃旧入口；`npm run memory` 可按人查看画像
- 探索性前置：执行时先只读盘点现有画像类机制（people.md / memory people / 其它），产出合并清单后再动手；发现语义冲突停下报告

**终态关联：** F13。

**验收标准：**
- [ ] 步骤 1：只读盘点现有画像/印象类机制，列出合并清单（含证据）
- [ ] 步骤 2：实现累积叠加、在场优先渲染、抽取提示词更新、旧入口合并
- [ ] 步骤 3：`npm test` 绿；`npm run prompts` 干净；`npm run memory` 产物核对

---

### Task 11：抽取评价机制（试金石 + 对账三分类 + 零提取兜底）

**Deps：** `T7`（抽取链路改造先行）

**WritePaths：**
- `prompt/`（抽取提示词文件，执行时定位现有抽取提示词位置；如需新文件则接入 src/prompts.ts）
- `src/compact.ts`（对账三分类结构化输出解析、零提取计数、复查模式）
- `src/memory.ts`（待审条目 signal 标签的存取）
- `scripts/memory.ts`（待审列表展示：signal 标签 + 近 N 页零提取提示）
- `AGENTS.md`（第 16 节补充抽取评价机制语义）
- `test/compact-extract.test.ts`（随前置条件 2 授权）

**接口契约：**
- Consumes：T7 的抽取链路；现有 savePendingMemories / sanitizePatch / supersede 审计链；待审列表机制
- Produces（按设计决策 17 全量）：
  1. 抽取提示词重写（唯一源在 prompt/）：few-shot 正反例 + 试金石 + confidence low 不报 + signal 标注要求；群聊场景正反例按决策 17 措辞
  2. 抽取器结构化输出：候选数组，每条 `{action: ADD|SUPERSEDE, factId?, text, signal[], confidence}`；SKIP 不产出（或产出仅计数）；解析失败 fail-safe：按现行行为降级（不阻塞换页，见下）
  3. 零提取计数器：按人格连续零提取页数（内存态即可，重启清零可接受）；达 N（默认 5，engage 配置外独立可配，放 fish.config.json 记忆块或常量，执行时按 fish-config 既有风格定）→ `/记忆` 汇总头部提示 + 触发一次复查模式（宽松提示词重跑本页，只一次不循环；失败/无效不清计数、不阻塞换页）
  4. 待审条目机械信号标签：命中 people 主体名 / 与现有 fact 文本冲突 / 主人参与轮 / @鱼轮——待审列表与 `/记忆` 展示
- 硬边界：不自动 DELETE；三分类的 SUPERSEDE 仍走待审批准；抽取失败不阻塞换页；提示词为模型侧文字唯一在 prompt/，src/ 无大段字面量

**终态关联：** F14。

**验收标准：**
- [ ] 步骤 1：核对现行抽取提示词位置与结构、savePendingMemories 输入、待审列表渲染、fish-config 风格
- [ ] 步骤 2：实现四件产出
- [ ] 步骤 3：`npm test` 绿；`npm run prompts` 干净；`npm run memory -- --pending` 展示核对

---

**新增测试清单（前置条件 2，须用户明确授权后创建）：**
- `test/engage-next.test.ts`：状态机迁移、closed skip/open free_pass、backlog 计算（pending 排除、截断）、懒基线、热切换、注入时钟
- 开窗注入渲染（打标/[m:id]）、entry kind 排除、互斥三向（在途轮/注入/burst）
- 环境轮零出口无 salvage；quoteMsgId 三态 + quote 强制；环境轮 @ 白名单
- @ 轮背景 5 条；`/评` 全链路；feedback 加权；nudge 与放宽
