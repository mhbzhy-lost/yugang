# 自由活动模式（free-mode engage）实现计划

日期：2026-11-05　状态：已按首轮评审与用户确认修订，待用户选择执行模式

## 1. 目标

给指定群（当前是搬史群）开一条与现有「开窗两态」并存的搭话轨道：

- **专用白名单**（`fish.config.json` 的 `engage.freeGroups`，热加载），独立于 `.env GROUPS` 但**必须与之取交集**；白名单群不走 10 分钟 closed / 3 分钟 open。
- 该群恒为「可搭话」，**非 @ 消息按 60 秒一拍合并**成一轮 ambient；一分钟内没有新消息就**不提交**（空拍跳过，拍子继续走）。
- **@ 通道完全不变**：仍按「群 + 发送者」10 秒静默合并 → answer 轮（整组必答）。
- **出站不变**：outbox 两阶段 + `sendPacingSeconds`，每轮 3 次开口额度，末条自言禁言。
- **宵禁保留**：本地 02:00–09:00 只关「自主起话题 / 逛 B 站 / 分享视频素材」，回复（answer 与 ambient）照常。
- **自主开口**：只在空拍时按低概率掷一次门（`engage.freeBrowseChance`，缺省 0.03 → 清醒时段日上限约 31 次，用户已确认这个量级），门开则提交 `[主动交流机会]`；宵禁内恒关；掷门与提交同拍原子完成。
- **批内回复关系可见**（2026-11-05 用户确认新增范围）：一拍里的每条消息带上 `replyIds` 与结构化 `quoted`，批内渲染 `[回复了m:id]` 并在列表后附 `[引用原文]`，与 @ 轮的口径一致。
- 非白名单群**零行为变化**（仍是 10 分钟 / 3 分钟 / 20 秒 shard / 开窗 injection）。

### 本轮采用的默认值（用户可在评审时否决）

用户已确认：空拍低概率掷门、空拍不提交、先写计划。其余取值由本计划决定：

| # | 决定 | 取值 |
|---|---|---|
| A1 | 「发送队列延时保留」= @ 轮 10 秒合并 + 出站 pacing | 两者都不动 |
| A2 | 60 秒窗口是**滚动**拍：由现有 1 秒 `tick()` 驱动（`at - lastBeatAt >= freeSeconds*1000`），每拍现读配置 | 不用自续 `setTimeout` |
| A3 | 单拍条数上限 | 新键 `engage.freeBatchMax`，缺省 50；**超出留最近 N 条、丢弃最旧并计数留日志**（本模式的唯一有损点，见 §7） |
| A4 | 白名单载体 | `fish.config.json` 的 `engage.freeGroups`（热加载） |
| A5 | 自由群与开窗节拍互斥 | 进了 `freeGroups` 就不再走窗口节拍，无需从 `GROUPS` 移除；移出后回窗口模式（首个 open 窗无积压，属预期） |
| A6 | @ 让行 | 拍子到期时若该群还有正在攒的 @ 组（`debouncer.pendingOf`），本拍不提交，顺延到下一拍（消息不丢） |
| A7 | prompt 文案不写死秒数 | 用「最近这一批」这类措辞，改 `freeSeconds` 不要求同步改 prompt |
| A8 | 批内回复关系（用户确认扩大范围） | `EngageShardItem` 增 `replyIds?` / `quoted?`；批内渲染 `[回复了m:id]` + 列表后 `[引用原文]`；批内图仍不做 inline 定级（沿用 `[图片 inbound/…]`） |

## 2. 终态（完成契约）

全部 `F` 项经验证满足才算完成；任务勾选或自报完成不构成完成。**停滞判据**：同一 `F` 项连续 2 轮验收输出无实质变化即判停滞，停下报告。

### 统一验收命令

```
node scripts/verify-free-mode.ts && npm test
```

`scripts/verify-free-mode.ts` 是本计划交付的自检脚本（不是 `test/*.test.ts`），按 `[F1] … [F10]` 逐项打印 `PASS/FAIL`，任一 FAIL 以非零码退出。脚本只 import 纯模块（`src/fish-config.ts`、`src/qq/engage-next.ts`、`src/qq/engage-mode.ts`、`src/qq/runtime-text.ts`、`src/qq/round-input.ts`、`src/qq/model-input.ts`）——**不得 import `src/app/runtime.ts`**（它在 import 期读 env 与模型配置）。`npm test` 是回归门。

| # | 条件 | 类型 | 验证方法与环境 | 通过判据 | 证据位置 | 覆盖任务 |
|---|---|---|---|---|---|---|
| F1 | `engage` 块认 `freeGroups`（**只认字符串**群号数组）、`freeSeconds`（15–300）、`freeBrowseChance`（0–1）、`freeBatchMax`（1–200）；非法值逐条告警回默认；未知键告警；缺省 `freeGroups` 不跨 `loadFishConfig` 共享 | AUTO | `[F1]`：`mkdtemp` 写临时 `fish.config.json`，调 `loadFishConfig({ path })` 断言生效值与 `problems` | 四键合法值生效；`freeSeconds=5` / `freeBrowseChance=2` / `freeBatchMax=0` 各产生一条 `problems` 且回默认；`freeGroups=["42","abc","42"]` → `["42"]` 且 `problems` 里恰好一条；`[42,true,{},'42']` → `["42"]`；`freeGroups=[]` 合法；不写该键取 60/0.03/50/`[]`；**两份缺省配置之间改一份不能污染另一份**（默认常量不自污） | 脚本 `[F1]` 行 | T1 |
| F2 | 自由群恒为可搭话：无 closed/open 迁移、无开窗 injection 轮、`isOpen` 在 `start()` 之前即 true、未建相位时 `collectShard` 也收、T8 沉默簿记不被写脏 | AUTO | `[F2]`：假时钟推进 5 分钟，断言 `onPhase` 调用 0 次、`isOpen` 全程 true（含 `start()` 前）、`phaseOf` 恒 `open`、`silenceOf` 恒 0 | 四条全成立 | `[F2]` | T2、T3 |
| F3 | 60 秒一拍合并；跨拍不合并；`freeSeconds` 热改在**下一拍**生效；**热加入**白名单当天即接管（旧 20 秒 shard 定时器被摘掉） | AUTO | `[F3]`：一拍内 3 个发送者共 5 条 → `onShard` 恰好 1 次、条数 5、顺序=到达序；推进一拍后新消息 → 第 2 次只含新消息；运行中把 `freeSeconds` 60→15，推进 15s 即触发下一拍；`next(open)` 采集一条后把 `freeOf` 翻成 true → 20 秒时不得有提交、接管起满 60 秒才提交 | 次数/条数/顺序/间隔/接管全对 | `[F3]` | T2 |
| F4 | 自主门只在**空拍**掷、每拍最多一次、门从 `videoBrowseGateOf` 暴露、宵禁恒关、概率 0 恒关、有消息的拍不掷、忙时不掷不提交、宿主没传该键时状态机按 0.03 兜底 | AUTO | `[F4]`：`freeBrowseChance=1` + 本地 10:00 → 空拍后 `videoBrowseGateOf(chatKey)` 门开且 topic 非空、windowId 以 `free-` 开头；`=0` → 恒关；本地 03:00 → 即使 `=1` 也恒关且不消耗随机数；有消息的拍与 `busy=true` 的拍：门为 `undefined` 且未消耗随机数；`config()` 不提供该键 + RNG=0 → 门开（缺省 0.03） | 六种情形全对 | `[F4]` | T2、T3 |
| F5 | 非自由群零回归；旧调用形状（不传 `freeOf`、`config()` 不带新键）仍可运行；**热移出**白名单当拍交还 20 秒 shard | AUTO | `[F5]`：用现有测试同款最小 deps（无 `freeOf`、`config()` 只给三键）跑状态机 3 分钟，断言按 closed/open 迁移、`onShard` 节拍=20s；再跑一例把 `freeOf` 从 true 翻成 false → 20 秒内必须有提交（不是等 60 秒关窗收尾）；随后 `npm test` | 脚本 `[F5]` PASS 且 `npm test` 退出码 0、失败数 0 | `[F5]` + 终端 | T2 |
| F6 | 背压无损：会话忙时整拍并入下一拍；提交 reject 时整拍回收；有 pending @ 组时本拍让行 | AUTO | `[F6]`：`busy` 恒 true 连推两拍 → `onShard` 0 次，放开后一次 `onShard` 含两拍全部消息且顺序不变；`onShard` reject 一次 → 下次含被回收那批；`yield` 回调返回 true 的一拍 → 不提交、消息保留 | 三种情形全对 | `[F6]` | T2 |
| F7 | 单拍超限时有界丢弃：只提交最近 `freeBatchMax` 条，被丢条数进日志 | AUTO | `[F7]`：灌 200 条、`freeBatchMax=50` → 提交 50 条且是最新 50 条、顺序正确；注入的 `deps.log` 收到含丢弃条数的一行 | 条数/窗口/日志三者全对 | `[F7]` | T2 |
| F8 | 模型可见文案按模式分流：自由群看不到「自由交流窗口」段、看得到「自由活动群」段；开窗群反之；legacy 群两段都没有；`prompt/runtime.md` 里确实存在该段 | AUTO | `[F8]`：`runtimeTextOf(base, "next"/"free"/"legacy")` 三分支断言；再 `readFileSync("prompt/runtime.md")` 断言存在以 `自由活动群：` 开头的行 | 四者全对 | `[F8]` | T3、T6 |
| F9 | 白名单安全域 + 在途登记未被收窄：域外群号整次拒绝且**校验早于任何读写**；运行侧交集滤掉域外；自由群轮仍登记在途 | AUTO | `[F9]`：调 `freeGroupsOutsideEnv` 断言域外/混合入参返回域外清单、空入参返回空；调 `engageModeOf` 断言域外群不是 `free`、域内是；读 `src/app/runtime.ts` 源码断言 `trackInFlight` 仍由 `engageNextOf` 决定且 `engageNextOf` 只查 `config.groups`、状态机与 `engagementOf` 都接上了；读 `src/tools/config/tool.ts` 源码断言 `freeGroupsOutsideEnv` 调用点早于第一处 `readFileSync(fishConfigPath)`（抛错即整次拒绝，不会部分写入） | 四条全对 | `[F9]` | T1、T3、T5 |
| F10 | 批内回复关系可见：一拍里带 `replyIds` 的消息渲染 `[回复了m:id]`，带 `quoted` 的消息在列表后附 `[引用原文]`；无回复的消息行形状不变；批内图仍保持 `[图片 inbound/…]`（不做 inline 定级） | AUTO（渲染）+ 人工（接线） | `[F10]`：两条消息（一条回复另一条、一条普通），调 `renderOpenMessageList` 与新的引用附加段渲染函数，断言出现 `[回复了m:id]` 与 `[引用原文]`、普通行不带这两个标记、图仍是 inbound 路径；接线部分（`groupWindowStage` 把 `replyIds`/`quoted` 传进收集器）由人工 diff + `npm test` 覆盖 | 渲染三条全对；接线的两处 diff 与计划一致 | `[F10]` + diff | T2、T9 |
| F11 | 文档同步：`AGENTS.md`（架构图、第 7 节、开窗描述共四处）、`fish.config.example` 的 engage 注释、`.agents/skills/ops/SKILL.md`、`src/tools/config/TOOL.md` 字段表、`src/external/video-browse.ts` 与 `engage-next.ts` 的门语义注释 | MANUAL | 人工核对上述文件；`npm run prompts` 输出无意外新增/缺失条目（无退出码语义，由人判断） | 每一处都有对应描述，diff 可见 | 各文件 diff | T6、T7 |

## 3. 任务与依赖

每个任务独占写路径，并行不冲突。

```
T1 配置层 ──┬──────────────────► T4 宿主接线 ──┬──► T8 自检脚本 ──► 验收
            │                                  │
T2 状态机 ──┴──► T3 纯模块抽取 ────────────────┴──► T9 批内回复关系（← T4）
T6 prompt（独立）
T5 config 工具（← T1）        T7 文档（← 全部）
```

| 任务 | 写路径 | 交付物 | 关键约束 | 验收 | 依赖 |
|---|---|---|---|---|---|
| T1 配置层 | `src/fish-config.ts` | `EngageConfig` 增 `freeGroups: string[]` / `freeSeconds` / `freeBrowseChance` / `freeBatchMax`；`ENGAGE_DEFAULTS` 补齐；`checkEngageBlock` 支持数组与概率分支；导出 `freeGroupsSafe(groups, free)`；`EngagementMode` 增 `free`（类型与注释） | 沿用「逐字段告警 + 回默认 + 全部非法才整块拒」；数组**剔除坏项**并留一条 problems、`[]` 合法；默认数组只读、不原地改；群号只认 `/^\d+$/` | F1、F9 | 无 |
| T2 状态机 | `src/qq/engage-next.ts` | `freeOf?` 可选依赖（缺省 false）、恒 open 懒建、`tick()` 驱动的自由拍与 `lastBeatAt`、`isOpen` 对自由群恒 true、`collectShard` 自由群总是收、热加入接管（摘旧 shard 定时器、重钉 `lastCloseSeq`）、热移出交还 20 秒 shard（`handOffToWindow`）、超限截断、`rollFreeBrowse()`（复用 `windowId`/`videoTopic`/`videoBrowseOpen` 字段，`free-` 前缀 id，宵禁 + 概率）、`onFreeIdle` 空拍回调、`yieldTo?` 让行依赖、`stop()` 清自由收集器并留日志、自由群跳过 T8 簿记、`EngageShardItem` 增可选 `replyIds` / `quoted`（承载批内回复关系） | 不调 `onPhase("open", backlog)`；新配置键在 `EngageTickConfig` 中标可选并 `??` 兜底（60/0.03/50）；随机数走注入 `random`、宵禁走 `isCurfewAt`；窗口模式分支除「模式交还」外一行不改 | F2、F3、F4、F5、F6、F7、F10 | T1（字段名与区间） |
| T3 纯模块抽取 | `src/qq/engage-mode.ts`、`src/qq/runtime-text.ts`、`src/fish/extension.ts` | `engageModeOf(chatKey, freeGroups, groups)` 与 `freeGroupsSafe` 复用口；`runtimeTextOf` 从 `extension.ts` 搬到 `runtime-text.ts`（可按模式裁两段：`自由交流窗口：` 仅 next 保留、`自由活动群：` 仅 free 保留） | 抽出的模块不 import pi-durable / memory / runtime；`extension.ts` 只改 import 与调用点 | F2、F4、F8、F9 | T1 |
| T4 宿主接线 | `src/app/runtime.ts` | deps 加 `freeOf` / `onFreeIdle` / `yieldTo`；`config()` 热读三键（`freeSeconds` / `freeBrowseChance` / `freeBatchMax`）；空拍机会轮复用 `submitInjectionRound` 的空窗分支（抽出 `submitBrowseOpportunity`）走 `videoBrowseGateOf`；`engagementOf` 按 `engageModeOf` 返回三分支；新增两行日志（自由拍提交条数 / 空拍） | 不改 `conversationBusy`、不改在途登记语义（`engageNextOf` 保持只查 `GROUPS`，自由群仍登记）；空拍判忙只看 `deps.busy(chatKey)` 与 pending burst，不为判忙调 `conversationFor`；`trigger.kind` 保持 `injection` | F2、F3、F4、F6、F9 | T1、T2、T3 |
| T5 config 工具 | `src/tools/config/tool.ts`、`src/tools/config/messages.json`、`src/tools/config/TOOL.md` | 删掉基于已下线 `engage.groups` 的死分支，改按 `freeGroups` 做安全域硬闸（域外整次拒绝、不部分写入）；新回执文案进 `messages.json`；字段表补四个键与区间 | 文案走 `messages.json`（不写 `src/` 字面量，注意 ≥12 汉字扫描阈值）；`config read` 能回显四个新键 | F9、F11 | T1 |
| T6 prompt | `prompt/runtime.md` | 新增一段（段首 `自由活动群：`）：这一批是最近这段时间群里的消息、不必逐条回应、可以整轮沉默、没人说话时偶尔出现 `[主动交流机会]`；不写死秒数 | 文案只在 `prompt/`；不改其它段落；`[回复了m:id]` 与 `[引用原文]` 的既有说明（第 13 行）已覆盖批内回复关系，不新增措辞 | F8、F11 | 无 |
| T7 文档 | `AGENTS.md`、`fish.config.example`、`.agents/skills/ops/SKILL.md` | 架构图与第 7 节写清两轨并存；`_engage` 注释补四个新键，并改掉已下线的 `_engagement` / `engage.groups` 描述（只改注释文本、不动键）；ops 补「怎么判断某群在自由模式 / 自由拍与截断日志长什么样」 | 只写可验证机制，不写死群号 | F11 | 全部 |
| T8 自检脚本 | `scripts/verify-free-mode.ts` | `[F1]…[F10]` 断言 + 退出码；假时钟放 `scripts/lib/fake-clock.ts`（`test/` 里已有两份，不再复制第三份到脚本内部） | 不 import `src/app/runtime.ts`；不碰 `var/` 与真实 `fish.config.json` | 统一验收命令 | T1、T2、T3 |
| T9 批内回复关系 | `src/qq/round-input.ts`、`src/app/runtime.ts` | 新增引用附加段渲染（把批里各条 `quoted` 渲染成 `[引用原文]` 段，附在消息列表之后）；`groupWindowStage` 收集时带 `replyIds` / `quoted`；`submitShardRound` 交给 `renderOpenMessageList` 时填 `replyIds` 并拼上附加段 | 复用 `renderQuotedOriginal`（不新写一种引用渲染）；批内**不做** inline 图定级、不加 look 提示；引用原文按 `lineText` 规范化，不额外截断（与 @ 轮一致）；合集引用仍走 `[转发合集]` 占位、不展开 | F10 | T2、T4 |

## 4. 执行模式（启动前由用户二选一）

- **A. subagent 并发驱动**：T1 / T2 / T6 同时起步；T3 等 T1，T4 等 T1+T2+T3，T5 等 T1，T9 等 T4，T7 收尾，T8 在 T3 完成后即可写（其 F10 段需等 T9）。除 T4/T9 同写 `src/app/runtime.ts`（有依赖边、串行）外，写路径互不重叠。
- **B. 主会话串行执行**：本会话按 T1 → T2 → T6 → T3 → T4 → T9 → T5 → T7 → T8 顺序做。上下文连续、无合并成本，但受会话轮次预算限制。

## 5. 非目标（本轮不做）

- 不改换页阈值与 `fish.engage_tick` 的计数口径（自由群会让换页更频繁，这是已知代价，观测后再单独决策）。
- 不改记忆抽取范围（`engage_tick` 仍不进摘要与抽取，自由群长期记忆产出仍然很低）。
- 不引入新出口工具、不改 @ 身份闸、不改链接白名单、不改 outbox 与 pacing。
- 不改 @ 轮的 inline 图定级与 look 提示策略（批内仍是 `[图片 inbound/…]`，不新增提示语）。
- 不做群级「自由模式开关」的 `/` 指令（配置工具已够）。
- 不做 itbed 宿主级场景（若要验「每分钟真提交一次」的端到端行为，另立计划）。

## 6. 建议（待用户授权后才做）

1. 扩展既有 `test/model-input-templates.test.ts` 与 `test/gate-next.test.ts`，把 F2/F3/F4/F5/F6/F7/F10 固化成常驻用例（脚本可作人工自检，`npm test` 才是护栏）。
2. 新增 `test/engage-free.test.ts` 承载自由模式独占断言（状态机 + 配置校验 + prompt 裁剪 + 批内引用渲染）。

## 7. 已知风险与恢复

| 风险 | 影响 | 处置 |
|---|---|---|
| **超限截断是有损的**（A3）：一拍超过 `freeBatchMax` 时丢最旧 | 搬史群刷屏高峰会周期性少一批消息 | 本模式唯一有损点，必须在 `AGENTS.md` 第 7 节明写；日志报丢弃条数；`freeBatchMax` 可热调大 |
| 自由群每分钟一轮，长期活跃群贴着 60 轮/小时跑 | 模型成本、换页频率上升 | 单拍截断 + `freeSeconds` 可调；观测一两天后再定是否降频 |
| ambient 更密，@ 轮可能撞上在途环境轮 | 必答被降级为忙碌语 | A6 让行规则（有 pending @ 组时本拍顺延），把窗口压到一拍 |
| 重启丢掉收集器里 ≤60 秒的非 @ 消息 | 少答一句 | 沿用「宁少勿答」，`stop()` 日志报丢弃条数 |
| `freeGroups` 热增删 | 移出后首个 open 窗无积压（`lastCloseSeq` 为空） | **已修**：接管与交还两个方向都会重钉 `lastCloseSeq`、摘/挂 shard 定时器（见 §8 R1） |
| 在途登记被误收窄（把自由群排除出 `engageNextOf`） | busy 恒 false → 并发提交、背压与 F6 全线失效 | F9 源码断言兜底；T4 明确不改该函数 |
| 自主门与在途机会轮冲突 | 机会轮授权抖动被误拒 | 只在空拍且会话不忙时掷门；掷门与提交同拍；有消息的拍不掷不覆盖 |
| 批内引用原文让单拍输入变长（一条被引长文会整段进上下文） | 活跃群里每拍多出若干段引用 | 与 @ 轮同一口径（`lineText` 规范化、合集不展开）；若观测到超限，再决定是否给引用段加长度上限 |

## 8. 修订记录（独立验收轮发现的缺陷 → 修复 → 重验）

首轮验收在统一命令全绿的情况下仍找出三项真缺陷，均已修复并补进自检脚本（脚本新用例在修复前均会失败）：

| # | 缺陷 | 证据 | 修复 | 重验 |
|---|---|---|---|---|
| R1 | `freeGroups` 热增删没有完成模式接管/交还：`next(open)→free` 时旧的 20 秒 shard 定时器仍在跑（20 秒就提交，不是 60 秒）；`free→next(open)` 时没有重建 shard（要等关窗收尾才提交） | `src/qq/engage-next.ts` 的 `ensureFreeState` 只改相位、不摘 timer；tick 的窗口分支看到 `phase === "open"` 就不再 `enterOpen` | `GroupPhase` 增 `free` 标记；`ensureFreeState` 摘 timer、重钉 `lastCloseSeq`；新增 `handOffToWindow`（`free→window` 当拍转 open、挂 20 秒 shard、不补注入轮）；tick 在窗口分支前做交还 | `[F3]` 新用例（接管后 20 秒必须无提交、满 60 秒才提交）、`[F5]` 新用例（移出后 20 秒内必须提交） |
| R2 | 缺省 `freeGroups` 跨 `loadFishConfig` 共享同一个数组：一次调用改动会污染下一份配置 | `loadFishConfig` 的 `engage: { ...DEFAULTS.engage, ... }` 浅展开，数组仍是同一个引用 | 合并后克隆一份 `freeGroups: [...merged.freeGroups]` | `[F1]` 新用例（两份缺省配置互不影响，且默认常量不自污） |
| R3 | 状态机缺省自主门概率写成 `?? 0`（注释与计划都是 0.03）：宿主没传该键时自主轮恒不触发 | `src/qq/engage-next.ts` 的 `rollFreeBrowse` | 改为 `?? 0.03` | `[F4]` 新用例（不传该键 + RNG=0 → 门开） |

顺带修的三个小问题：`freeGroups` 只认字符串（数字/布尔/对象一律剔除，不再 `String()` 静默接受）；
`src/fish/extension.ts` 文件末尾多余空行（`git diff --check` 通过）；ops 文档里「没有提交日志＝空拍」的说法
改成「也可能是忙/让行顺延」，并把 `video-browse.ts` 里「下一拍作废」的门注释改成实际语义（在途/让行那拍保留，但没有提交路径消费它）。

F9 的验证方式也做了更正：原计划写「断言临时文件字节未变」，但 config 的写路径没有可注入的入口，
脚本无法端到端复现；改成**机械校验抛错点早于第一处文件读**（`freeGroupsOutsideEnv` 的调用位置 <
第一处 `readFileSync(fishConfigPath)`），文件不被部分写入由该顺序保证。部署后用手测 `/config` 做补充确认（F11）。
