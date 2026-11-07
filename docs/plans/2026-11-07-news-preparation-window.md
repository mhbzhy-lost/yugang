# 新闻准备窗口与人格备料改造计划（独立 review 后修订）

日期：2026-11-07
状态：已完成一轮独立 review；主人选择主会话串行执行，并已授权修复完成后自动部署及纳入 draw 既有改动。独立验收发现的在途标记泄漏、prepare 旧时间 CAS 与生产宿主覆盖不足已修复，新增真实 durable CAS 回归和独立进程 `scripts/news-runtime-smoke.ts`（真实 `submitRound` / `newsFreezeStage` / engage）。最终统一 AUTO 已通过：166 项测试、prompts、N1–N5、生产 runtime 竞态 smoke 与 `git diff --check`；证据为 `var/local-driver/news-smoke-mw67fvn7-3bfd85ca/evidence.jsonl` 和 `var/local-driver/news-runtime-smoke-mw67ke0b-3fbedc68/evidence.jsonl`。另将 Antigravity IDE User-Agent、ping 错误误判及主人私聊 `config models_probe` 并入本轮。F2/F3/F5 真机新闻窗口仍待自然时点验收。

## 1. 背景与目标

当前新闻管线是「会话外取料与归纳 → 目标群既有鱼会话的 scheduled answer 轮 → 模型调用
`say_words` → 出口闸重建 payload」。2026-11-07 的生产事故中，新闻于 10:30:09 已生成，
却因 `lastWasFish` / 会话忙连续推迟 30 分钟，最终以 `defer_giveup` 放弃。人格目前只负责
调用出口，并不真正选择新闻。

主人裁定的新行为：

- 仍使用**新闻时点目标群当前人格的既有鱼会话**，不另建独立会话；由该人格自主选材和组织语言。
- `news.at`（生产缺省 10:30）是**计划开始备料**时点，不再是立即播报时点。
- 10:30–10:40 是目标群的新闻准备窗口：暂停普通模型响应，专门备料；缺省准备时长 10 分钟。
- 窗口内有人 @ 鱼，机械回复「正在准备新闻哦，请稍后。」；这些 @ 不在窗口后补答。
- 非 @ 消息仍进原话簿、recent 与自由拍收集器，但窗口内不提交模型；其它群和主人私聊不受影响。
- 备料采用首次尝试 + 最多 3 次重试；所有尝试都不得越过新闻时点对应的 10:40。
- 人格通过专用结构化工具提交选材，不调用 `say_*`；宿主校验后保存成品。
- 10:40 由宿主将成品直接写入 outbox 并触发 drain，不再让鱼调用 `say_words`。
- 新闻原子入队后恢复普通响应；outbox FIFO 保证之后产生的普通回复不会抢到新闻前面。
- 提前耗尽重试则提前恢复并记失败；硬截止和故障路径都必须解除冻结。
- 保留外部文本清洗、sourceRef 索引、宿主 canonical 链接、500 字成品预算、单源降级、
  outbox 配速/两阶段发送/崩溃恢复、按日幂等语义。

## 2. 非目标与边界

- 不改新闻来源枚举、topic 默认表、目标群安全域（仍必须属于 `.env GROUPS`）。
- 不新建新闻专用 Conversation。run 开始时保存当前 `conversationId` / `effectivePersona` /
  `mappingKey`，所有重试、工具身份校验、恢复与发布都钉在这一会话上；冻结期切换人格不影响本次新闻，
  解冻后的普通消息按新人格路由。
- 不让 `news_prepare` 工具直接 `emit()`、写 outbox 或发 QQ；它只提交并持久化备料结果。
- 不把 URL 交给模型，不采信模型输出的 URL；链接仍由宿主按 sourceRef 渲染。
- 冻结期非 @ 消息继续受 `engage.freeBatchMax` 上限约束，超出时沿用现有丢最旧策略。
- 窗口开始前已经在执行的普通轮允许收束，但冻结后不得再起普通轮；新闻备料尝试可等其释放，
  不等 `lastWasFish`，不再使用旧 `awaitNewsSlot`。
- 「10:40 发布」的精确定义是：10:40 停止备料，若已 prepared 则原子写入 outbox 并触发 drain。
  outbox FIFO 保证新闻排在解冻后的普通回复之前；QQ 实际送达仍遵守既有 sending 不重试、
  队首阻塞不跳过规则，不能把「入队」伪装成「已送达」。
- 不默认 commit / push / deploy；部署和真机窗口验收需主人另行明确授权。
- 主人已明确授权新增本地测试，并要求「全管线走真实模型流量，把可能的竞态都模拟一遍」；
  Task 6 同时包含确定性状态机测试与真实模型全管线 smoke。真实 QQ/OneBot 发送仍以本地记录出口替代。

## 3. 总体设计

### 3.1 新闻备料接口

新增 deferred 工具 `news_prepare`，模型在新闻准备轮先通过 `tool_search` 加载，再调用。
参数为结构化 `NewsDigest`：

```ts
{
  sections: Array<{
    topic: string;
    items: Array<{ summary: string; sourceRef: string }>;
  }>;
  closing: string;
}
```

工具执行链：

1. 从本轮 submission 读取 `RoundTrigger`，只认 `kind: "news"` 且带有效 `newsRunId` 与
   `newsAttempt`；同时要求 `api.conversationId` 等于 run 绑定的 conversationId。
2. 经宿主窄接口取该 run/attempt 的候选索引、topic 顺序、每 topic 输出上限与硬截止；
   其它轮、其它会话、旧 attempt、超过截止均 fail closed。
3. 调用共享纯函数严格校验：topic 不增不减不重复、sourceRef 必须属于**该 topic**、全篇 sourceRef
   不重复、items 不超上限、summary ≤60 字、closing ≤30 字、文本先过 `sanitizeExternalText`、
   禁止 URL；空 topic 允许，全部空则拒绝。
4. 用既有 `renderNewsBroadcast` 生成 ≤500 字成品和 canonical links；除文本非空外，还要求
   `links.length > 0`，防止预算裁剪后只剩 header/closing 的假成品。
5. 在该工具自己的 `api.commit` 内重新读取当前 run，仅当同一 run 仍为 `preparing`、
   `attempts === newsAttempt` 且 `now < publishAt` 时，原子改为 `prepared` 并保存成品、链接、
   `preparedAt`；其它状态拒绝，禁止 stale attempt 覆盖新状态。工具不写 outbox、不调用发送函数。
6. 模型得到短回执；宿主在轮结束后读取 durable run 状态决定成功、继续重试或失败。

`RoundTrigger` 增加可选 `newsRunId` / `newsAttempt`，`RoundKind` 增加 `"news"`。
`submitRound` 增加可选 `modelAttempts`（缺省保持现有 3）与 `deadline`，新闻准备轮传 1 和 run
硬截止，确保「首次 + 3 次重试」由新闻调度器统一计数，不与通用模型错误自愈叠成最多 12 次。
新闻轮设置 `silentOf=true`，四个 `say_*` 机械拒绝；`kind:"news"` 不触发语音附加规则、
零出口日志、正文兜底或轮后自动 compact，entry 继续使用 `fish.engage_tick`，不写 `fish.inbound`，
不进入长期记忆抽取输入。

### 3.2 durable 状态、CAS 与 single-flight

将 `NewsRunsDoc` 及类型移到 `src/external/news-runs.ts`，doc kind 与 version 保持
`fish.news_runs` / 1，读侧兼容旧 `running` 记录。单条记录扩展为：

```ts
{
  localDay: string;
  targetGroup: string;
  state: "preparing" | "prepared" | "done" | "failed";
  scheduledStartAt: number;
  startedAt: number;
  publishAt: number;
  attempts: number;
  conversationId: string;
  effectivePersona: string;
  mappingKey: string;
  preparedAt?: number;
  finishedAt?: number;
  broadcast?: { text: string; links: string[] };
  error?: string;
}
```

旧 `running` 按失败残账处理；缺少新时间/会话字段时不猜测、不恢复备料。

所有迁移都在各自的 `harness.commit` 内从 `tx.doc(NewsRunsDoc)` 读取当前值并比较，禁止快照整份覆盖：

- 创建/恢复执行权：run-key single-flight 防止正常调度与启动恢复并发执行同一 run。
- 领取尝试：仅 `preparing && attempts < 4 && now < publishAt`，原子递增 attempts。
- 备料成功：仅同一 run、同一 attempt 的 `preparing → prepared`。
- 失败：仅 `preparing → failed`；若已是 prepared，旧失败协程不得覆盖，应转发布流程。
- 发布：仅 `prepared → done`；同一事务检查稳定 outbox key 不存在后入队，若 key 已存在则只补 done。
- `done/failed` 是终态，任何旧协程不得覆盖。

稳定 outbox key 为 `news:<localDay>:<targetGroup>`。在同一个 harness commit 内完成
`OutboxDoc.queue.push` 与 run `done`；崩溃在 commit 前由 prepared 恢复重试入队，commit 后不重复入队。
payload 的 `at` 取实际入队时间，避免补跑时被 outbox 的 10 分钟过期规则误删。

### 3.3 时点、硬截止与解冻

`publishAt` **不得**按实际 job 启动时间计算：

```ts
scheduledStartAt = localTimestamp(date, news.at)
publishAt = scheduledStartAt + news.preparationMinutes
startedAt = 实际执行开始时间
```

- 正常触发晚几秒也仍使用新闻时点对应的 10:40。
- scheduler 补跑仍在窗口内时只使用剩余时间；已过 publishAt 的 preparing 直接失败，不建冻结、
  不取料、不起模型。
- prepared 的补发使用 durable run 原 publishAt；已过点但在既有 2 小时补跑窗内可立即入队，
  超过 2 小时记 `missed_window`，不发陈旧新闻。

每个 run 有独立 deadline 定时器，不等主流程 finally：

1. 到 publishAt 先在内存把 run 标为 expired，禁止任何新的取料后提交、模型请求与工具成功写入。
2. 若没有 prepared：同步解除本 run 冻结，再异步 CAS 记 `news_timeout`；若存在活跃新闻轮，
   用 `conv.abort()` 中止，不调用对已 placed 输入无效的 `Submission.abort()`。
3. 若已经 prepared：进入 publishing，仅执行「CAS prepared→done + outbox 入队」这一短事务，
   随后立即解冻并触发 drain；不等 abort、失败写库或 drain 才解冻。
4. 另设 publishAt+5 秒安全看门狗，即使存储事务异常悬挂也强制解除内存冻结；主流程 finally 只做
   幂等清理。看门狗只负责解冻，不重复发布、不把失败改成功。
5. 取料无法被外部信号取消时，deadline 定时器仍按时解冻；取料后续返回必须先检查 expired，
   不得再提交模型。`submitRound` 在入口、`absorbSecrets` 后及每次 `conv.submit` 前都检查 deadline；
   新闻轮跳过轮后 compact，避免额外资产生成越过截止。

### 3.4 目标群冻结与最终提交闸

新增 `newsFreezeStage`，消息链顺序调整为：

`normalizeInbound → commandsStage → gateStage → newsFreezeStage → groupWindowStage → privateChatStage`

- 放在 commands 后，主人 `/` 指令仍可用；放在 gate 后，合集忽略、群白名单等既有判决不变。
- 冻结仅作用于 `news.targetGroup` 对应 chatKey。
- @ 鱼：立即经 outbox 机械回复固定文案并引用该消息，稳定 key
  `news-preparing:<localDay>:<messageId>`；不进 debounce、不提交模型、不在恢复后补答。
- 非 @：继续进入自由拍收集器；`engageNext.busy` 在冻结时返回 true，因此拍子保留消息且不掷自主门。
- 冻结前已进入 debounce 的组，在 `flushBurst` 首段及等待 ambient 清零后都复查。整组被拦时，
  @ 条目走固定机械回复；其中非 @ 条目转换为同一 shard item 形状放回收集器，不能随组丢弃。
- 解冻后不清空收集器，下一拍按真实到达序处理仍保留的消息；不补处理冻结期 @。

仅靠消息链和 engage busy 不足以挡住已通过前置检查的异步回调，因此在 `submitRound` 增加统一最终准入：

- 入口检查一次，`absorbSecrets` 后及**每一次 `conv.submit` 前**再检查。
- 冻结时只有 `kind:"news"` 且 `newsRunId` 等于当前冻结 run、会话与 attempt 也相符才放行。
- ambient 被最终闸拦截时抛出专用 `NewsFrozenError`，由 `engage-next.ts` 既有 recycle 把整拍放回
  收集器；不得返回成功导致丢消息。
- answer 被最终闸拦截时按上一条拆分为 @ 机械回复 + 非 @ 回收；browse/injection 直接放弃并留日志。
- 新闻准备轮自身不受普通 busy 冻结误挡，但仍受同会话互斥、run identity 和 deadline 约束。
- 其它群、私聊完全走旧路径。

### 3.5 可测试的新闻编排与恢复

将新闻编排从 `runtime.ts` 提取为 `src/external/news-job.ts` 的窄状态机工厂，注入：

- 时钟、deadline 定时器与安全看门狗；
- news client、候选缓存与 run store；
- conversation/submit/abort；
- freeze/unfreeze；
- 原子 publish、drain 与日志。

`runtime.ts` 只保留生产适配，避免 F4 只能驱动带大量顶层副作用的入口。

启动增加独立 `recoverNewsRuns()`，直接扫描非终态 run，不依赖每日 slot 补跑：

- `done/failed`：不执行。
- `prepared` 未到 publishAt：重建冻结并只恢复到点发布，不重新备料。
- `prepared` 已过 publishAt 但在 2 小时内：立即原子入队一次；超过 2 小时记 missed_window。
- `preparing` 仍在窗口：重建冻结、重新取候选并接续剩余 attempts；未 prepared 不会重复发。
- `preparing` 已过 publishAt：记 news_timeout，不补备料、不发布、不保留冻结。

`startNews` 改为 async：先 await 恢复和冻结重建，再启动 scheduler；`src/index.ts` 的启动顺序保证
它在 `listenMessages` / `connectOnebot` 之前完成，杜绝恢复前普通响应抢跑。恢复与正常调度共用
run-key single-flight。恢复时 publish 只负责入队，实际 drain 等 OneBot 连接后的既有 restore/drain
阶段执行。

### 3.6 正常调度流程

1. 校验目标群安全域，按 date+slot 计算 scheduledStartAt/publishAt，绑定当前人格既有 Conversation，
   创建 durable run 并建立冻结。
2. 首次成功取料后，同一 run 的各次人格备料尝试复用同一批候选和 sourceRef；取料失败时下一次可重新取。
   单源失败只降级，空候选才算该次失败。
3. CAS 领取每次尝试，上限 4。等待已在途普通轮释放后，用绑定的 Conversation 提交新闻准备轮；
   不检查 lastWasFish。
4. 某轮 prepared 即停止重试，保留冻结至 publishAt；失败且 attempts<4、未到截止则立即下一次。
5. 提前耗尽 4 次：CAS 记失败并立即解冻。到点仍未 prepared：按 3.3 的独立 deadline 路径处理。
6. prepared 到点：原子 outbox+done，解冻并触发 drain。日志区分「备料完成」「已入队」
   「drain 实际发出/失败/队首阻塞」，不把返回 0 一律当成功或失败。
7. 对目标 conversation 执行 drain 后，结合稳定 key 的 outbox 状态和发送记录判断结果；
   `fish.drain()` 返回 0 只作为线索，不能单独判定。所有路径最终解冻。
8. scheduler watchdog 改为「准备分钟数 + 2 分钟」余量，业务 deadline 仍精确落在 publishAt；
   删除旧 30 分钟 `awaitNewsSlot`、`defer_giveup`、会话外 `completeNewsDigest` 和 scheduled answer
   `say_words` 播报路径。

### 3.7 确定性竞态矩阵与真实模型全管线 smoke

两层验证不可互相替代：假时钟负责把每个竞态确定地摆出来，真实模型负责证明人格在完整协议里
确实能发现工具、提交合法物料，并在竞态发生后不泄漏普通出口。

**确定性状态机测试（获授权新增 `test/news-preparation.test.ts`）：**

- R1 冻结建立与 ambient 已通过 busy 检查交错，最终提交闸拒绝并由 engage recycle。
- R2 冻结前 pending burst 含 @ + 非 @，@ 只机械回复，非 @ 回收集器。
- R3 取料在 deadline 后返回，不能再起模型；preparing 过期记 news_timeout 并解冻。
- R4 第 4 次失败与工具成功并发，CAS 只允许一个终局；stale attempt 成功不得覆盖新 attempt。
- R5 prepared 与 timeout failed 并发，prepared 必须转发布，不能被旧失败覆盖。
- R6 publish 与 recover 并发，single-flight 和 outbox key 检查保证只入队一次。
- R7 outbox+done commit 前抛错可由 prepared 重试；commit 后抛错/重放不得重复入队。
- R8 prepared 后重启只恢复发布；preparing 窗口内重启只续剩余 attempts；超过 2 小时不补发。
- R9 drain 返回 0 且队首 sending 时记阻塞、不跳过、不重复，冻结仍解除。
- R10 冻结期切换人格，所有 attempts/tool/publish 仍绑定原 conversation，解冻后新消息走新人格。
- R11 新闻轮结尾不得触发自动 compact；非目标群与私聊提交始终不受冻结影响。
- R12 安全看门狗在存储悬挂时仍于 publishAt+5 秒强制解冻，且不改变 durable 终态。

**真实模型全管线 smoke（获授权新增 `scripts/news-real-model-smoke.ts`，npm 入口
`npm run smoke:news`）：**

- 复用 `real-model-smoke.ts` 的隔离原则与 `local-driver.ts` 的记录出口：临时 ROOT、临时 SQLite、
  真实 `config/models.json` / 凭据副本、真实 provider 流量、真实 `openFish` agent loop；
  不连接 OneBot、不改仓库配置、不部署、不向 QQ 发消息，restart 成功路径机械阻断。
- 新闻源边界使用 `createNewsClient({ fetchImpl })` 注入本地确定性 HTTP 响应，仍走真实解析、
  清洗、topic 映射和 sourceRef；只有模型请求走真实 provider，新闻外网与 QQ 不依赖。
- 从生产 scheduler/news job 入口启动，不只调用工具本身；实际经过 freeze stage、debounce/engage、
  当前人格 Conversation、`tool_search` 渐进加载、`news_prepare`、durable run、outbox 与 drain。
- 场景 N1 正常全链：真实人格选材成功，无 say_*，成品与 canonical links 唯一入队，run prepared→done。
- 场景 N2 备料中 @ / 非 @ / 其它群消息交错：@ 立即机械回执，非 @ 保留，其它群可响应；
  恢复后目标群普通自由拍才继续。
- 场景 N3 真实模型请求在途时触发 deadline：用 provider fetch 包装层在真实响应返回后短暂拦住
  completion 交付，先推进 deadline，验证 abort/解冻/无 prepared；随后释放响应，stale 后续不得发布。
- 场景 N4 prepared 后在同一临时 SQLite 上关闭并重开 fish，recover 不再次调用模型、不重复入队；
  正常 scheduler 与 recover 同时触发也只有一次发布。
- 场景 N5 预置 outbox 队首 sending，新闻仍只入队一次并记 drain 阻塞，后续消息不得跳过它。
- 每个场景输出 `status: pass|fail`、expected/observed、模型调用次数、tool 调用序列、run/outbox 状态、
  freeze 状态和 token usage；任一 fail 退出码 1，不允许 blocked/not-run 冒充通过。
- 证据写入 `var/local-driver/news-smoke-<runId>/evidence.jsonl`，只含虚构新闻与机械指标，
  不打印 key、完整凭据、真实群消息或模型隐藏 prompt。

## 4. 整体交付终态（完成契约）

以下 F 项是完成声明的唯一来源。任务勾选或 subagent 自报完成均不算完成。

- **F1（AUTO）— 装配与静态契约完整**
  - 条件：`news_prepare` 四件套与 loader 双向注册；新闻冻结中间件顺序正确；`news.at` 缺省 10:30、
    `news.preparationMinutes` 缺省 10；旧 `say_words` 新闻闸、会话外归纳和 `awaitNewsSlot` 全移除；
    既有机械测试覆盖 prompt、工具目录、权威模板和入口顺序。
  - 验证：统一 AUTO 验收命令；通过判据为命令退出 0、全部既有测试绿、prompts 检查无错误。
  - 证据：命令输出、对应 diff。覆盖 Task 1–5。

- **F2（MANUAL）— 冻结期只机械接待**
  - 操作者与步骤：主人在 macmini 真机验收窗口，于目标群新闻准备期分别发一条 @ 和一条非 @，
    同时在另一白名单群 @ 鱼。
  - 通过判据：目标群 @ 只收到「正在准备新闻哦，请稍后。」，无模型提交且事后不补答；非 @ 进收集器、
    窗口内不提交；另一群正常响应；目标群恢复后保留的非 @ 才进入自由拍。
  - 证据：生产日志中 freeze/gate/shard 时间线、QQ 消息记录。覆盖 Task 3、4。

- **F3（MANUAL）— 人格备料、10:40 原子入队且仅一次**
  - 操作者与步骤：同一真机窗口观察绑定人格的新闻准备轮和 10:40 发布；核对 transcript、
    `fish.news_runs`、outbox 与 drain 日志，再在当日重复触发调度判定。
  - 通过判据：准备轮属于 run 绑定人格的既有 Conversation；人格通过 `news_prepare` 选材；全程无
    `say_*`；10:40 宿主机械入队并触发 drain，成品 ≤500 字、links 来自 canonical index；
    outbox FIFO 中新闻早于解冻后的普通回复；run done 当日不重复入队。QQ 实发以 drain/发送记录单独判定，
    不用入队冒充送达。
  - 证据：transcript 中 news + tool call、run 状态 prepared→done、稳定 outbox key、QQ/ drain 日志。
  - 覆盖 Task 1、2、4。

- **F4（AUTO）— 确定性竞态与真实模型全管线均通过**
  - 条件：R1–R12 全部有独立通过证据；真实模型 N1–N5 全部 pass，模型确实经 tool_search 调用
    news_prepare，deadline/restart/单飞/outbox 阻塞下无重复发布、无 say_*、无永久冻结。
  - 验证：统一 AUTO 验收命令依次运行 `test/news-preparation.test.ts` 与
    `scripts/news-real-model-smoke.ts`；任何场景 fail、blocked 或缺少证据都判未通过。
  - 证据：npm test 输出、`var/local-driver/news-smoke-<runId>/evidence.jsonl` 与汇总退出码。
  - 覆盖 Task 4、6。

- **F5（MANUAL）— prepared 后重启能接上，故障不会永久封群**
  - 操作者与步骤：真机窗口中先等 run 明确进入 `prepared`，再在 publishAt 前执行一次平滑 restart；
    观察恢复与发布。另在 F4 已验证的 preparing 过期逻辑基础上，确认真机 finally/看门狗解冻。
  - 通过判据：prepared 重启后只入队/发布一次；未 prepared 且窗口已过不补备料；所有路径都解除冻结，
    目标群恢复正常响应。
  - 证据：重启前后日志、run/outbox 状态与 QQ 恢复消息。覆盖 Task 4。

**统一 AUTO 验收命令：**

```bash
npm test && npm run prompts && npm run smoke:news && git diff --check
```

该命令覆盖 F1 与 F4。`smoke:news` 使用真实模型流量，执行前必须确认本机 models/auth 可用；
任何真实模型场景失败都使命令非零退出，不得跳过后宣称完成。

**停滞判据：** 同一 F 项连续 2 轮验证输出没有实质变化（相同失败点、无新增证据）即判停滞；
停止重复尝试，报告未满足条件、证据、根因与下一步，不把停滞当完成。

## 5. 任务拆分与 DAG

### Task 1 — 新闻合同、durable run 与配置前置

- 交付：新增 `src/external/news-runs.ts`；共享候选/校验/成品类型与纯函数；`src/fish-config.ts`
  增加 `news.preparationMinutes`（数值 1–30，缺省 10，热加载），`news.at` 语义改为计划备料开始。
- 同步 `fish.config.example` 与 `src/tools/config/TOOL.md` 的 news 字段表。
- 验收：旧 running 只按失败残账处理；新 run 可序列化；非法 preparationMinutes 被拒绝/回默认并告警；
  sourceRef 校验 topic 归属且全篇不重复；成品 ≤500 字且 links>0。
- 依赖：无。

### Task 2 — `news_prepare` 工具与轮内窄接口

- 交付：`src/tools/news_prepare/{TOOL.md,schema.json,messages.json,tool.ts}`；loader factory；
  `RoundKind` / `RoundTrigger` / `ToolPackageDeps` 扩展；工具内 run、attempt、conversation、候选和
  截止校验，prepared CAS。
- 验收：普通轮、错会话、旧 attempt、过期调用均被拒；合法新闻轮可 prepared；工具无 emit/outbox；
  `npm run prompts` 能看到该 deferred 工具且无文案冲突。
- 依赖：Task 1。

### Task 3 — 目标群冻结与统一最终提交闸

- 交付：冻结状态、`newsFreezeStage`、入口注册、flushBurst 两次复查、混合组拆分回收、engage busy、
  `submitRound` 入口/absorbSecrets 后/每次 conv.submit 前的最终准入、ambient recycle 专用错误、
  固定机械回复及稳定幂等 key。
- 验收：@ 即时机械回复且不进模型；非 @ 保留不提交；异步已越过前置检查的提交仍被最终闸拦住；
  其它群/私聊不变；解冻后收集器继续；所有路径可解冻。
- 依赖：Task 1。

### Task 4 — 可注入新闻状态机、独立恢复与原子机械发布

- 交付：`src/external/news-job.ts` 窄状态机与 runtime 适配；新闻准备轮；4 次尝试、按 slot 计算的
  publishAt、独立 deadline/安全看门狗、conv.abort、启动 recover、single-flight、outbox+done CAS 事务、
  FIFO 后解冻、drain 结果核对；`submitRound` 的 modelAttempts/deadline/news/silent/跳过 compact 支持。
- 删除旧会话外归纳、awaitNewsSlot、say 新闻注册/重建代码。
- 验收：Task 1–3 接口真实连通；模型只备料不 say；过期后续不能重新提交；恢复不依赖 2 小时 scheduler
  入口；done 与 outbox 原子；不再出现 defer_giveup 或新闻 say_words 路径。
- 依赖：Task 1、Task 2、Task 3。

### Task 5 — prompt、权威模板、既有测试与文档同步

- 交付：
  - `prompt/news-digest.md` 改为人格选材 + `tool_search`/`news_prepare` 指南；
  - `prompt/runtime.md` 删除旧「新闻用 say_words」协议；`prompt/messages.md` 增机械忙碌文案并移除旧
    `news_broadcast_task`；
  - `docs/decisions/2026-11-04-model-input-templates.md` §5.7 与 scene 改为新闻准备输入；
  - 既有 `test/model-input-templates.test.ts`、`test/tools.test.ts`、`test/index-registration.test.ts`
    随生产接口同步调整，不新增测试文件；
  - `README.md`、`AGENTS.md`、`.agents/skills/ops/SKILL.md` 改为新时序、故障码与排查口径。
- 验收：既有权威模板测试按新生产入口精确通过；工具面与消息链断言更新；无旧新闻 say 文案残留；
  `npm run prompts` 无错误。
- 依赖：Task 4。

### Task 6 — 已授权：确定性竞态测试 + 真实模型全管线 smoke

- 主人已明确要求「本地应该有全管线的走真实模型流量的模拟测试，把可能的竞态都模拟一遍」，
  本任务的新测试文件、脚本与必要本地 fixture 均已获授权。
- 新增 `test/news-preparation.test.ts`，直接驱动 `createNewsJob` 与真实 durable store，逐项覆盖 3.7 的
  R1–R12；每个竞态有独立名称与证据，不用一个笼统 smoke 代替矩阵。
- 新增 `scripts/news-real-model-smoke.ts` 与 package.json 的 `smoke:news` 入口，逐项覆盖 3.7 的
  N1–N5；真实 provider、真实 openFish/agent loop、真实新闻工具与 durable/outbox 链路，新闻 HTTP
  和 QQ 出口用确定性本地边界，不接生产。独立验收后新增 `scripts/news-runtime-smoke.ts`，在独立
  进程直接驱动生产 `submitRound` / `newsFreezeStage` / engage，覆盖 absorbSecrets 交错与真实机械接待/回收。
- 验收：确定性测试全绿；真实模型场景 N1–N5 全部 pass 且 evidence.jsonl 完整；重复执行不会污染
  仓库配置、生产 var 或 QQ。
- 依赖：Task 5（真实模型必须使用最终 prompt、工具说明与生产适配）。

### 依赖图

```text
T1 ──┬── T2 ──┐
     │        ├── T4 ── T5 ── T6（确定性测试 + 真实模型全管线 smoke）
     └── T3 ──┘                    │
                                   └──（主人另行授权部署后）F2/F3/F5 真机验收
```

- T1 启动后，T2 与 T3 可并行。
- 任一前置完成即重新检查后继；T4 必须等 T2、T3 都 ready，T5 等 T4。
- 无批次屏障；T6 已获授权，T5 ready 后立即启动。

## 6. 验证与交付顺序

1. 按任务实现并运行 `npm test` / `npm run prompts`，修复至 F1 满足。
2. 执行 F4 的确定性竞态矩阵与真实模型全管线 smoke，确认重试、竞态、超时、恢复与幂等；
   保存 N1–N5 的真实流量证据。
3. 自动派发一轮独立验收 subagent，按 F 项核对实际证据，不采信任务自报。
4. 向主人报告本地交付状态；未经明确「部署」授权，不 commit、不 push、不部署。
5. 主人授权部署后按仓库标准流程提交、push、`fish.sh deploy`，再完成 F2/F3/F5 真机窗口验收。

## 7. 执行模式

**主人已选择：主会话串行执行。** 本会话 inline 逐任务执行，不派发实现 subagent；
完成后按规范自动派发一次独立验收。未经主人另行明确授权，不 commit、不 push、不部署。
