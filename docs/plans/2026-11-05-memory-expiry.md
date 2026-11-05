# 长期记忆的时效性核对与淘汰（EXPIRE）

- 日期：2026-11-05（v2，已按独立审阅意见修订）
- 状态：待用户选执行模式 + 待授权自检脚本
- 关联：`AGENTS.md` §16、`prompt/memory-extract.md`、`src/memory/*`、`src/fish/memory-admin.ts`

## 1. 目标

压缩抽取时不只「记新的」，还要**拿本页对话核对已有事实是否还成立**；确认失效且没有替代品的事实，
产出 `EXPIRE` 候选进入待审队列，由主人批准后置 `invalidAt`（不再注入、条目保留可追溯）。

用户口径：

> 在长期记忆提取时，可以加入对记忆时效性的检查，比如之前沉淀的记忆，此次压缩时是否还有效，
> 有没有效也好判断，当鱼说出失去时效性的话时，肯定会遭到反驳，这就可以用来进行记忆淘汰。

### 非目标

- 不做自动失效/自动删除：`EXPIRE` 一律进待审，主人批准才生效。
- 不做 TTL、时间衰减、按「事实太旧」自动淘汰。
- 不动 `lore` / `card` / `profile` 的淘汰；不改渲染与上限淘汰规则。
- 不改 supersede 的既有语义（有替代品时仍用 SUPERSEDE）。
- 不碰 `/评` 的 `feedback` 机械通道。

## 2. 现状（代码事实）

| 环节 | 现状 | 位置 |
|---|---|---|
| 抽取非空判定 | `extractMemories` 只看 `people/lore/cards`，**不看 supersede** | `src/memory/extract.ts:107-114` |
| 待审写入判定 | `savePendingMemories` 还要 `!isPatchEmpty(patch)` | `src/fish/compactor.ts:69-83` |
| 空 patch 判定 | `isPatchEmpty` 只查 people/lore/cards/supersede/feedback | `src/memory/pending.ts:120-128` |
| 主体白名单重建 | `restrictSubjects` 只回 `{people, lore, cards, supersede}`，**会丢新字段** | `src/memory/extract.ts:248`、`:395-405` |
| fact 解析入口 | 所有 `type=fact` 先过 `readFact`（强制 `text`+`source`） | `src/memory/extract.ts:201-214`、`:272-290` |
| 解析函数可见性 | `reconcileCandidates` 模块私有 | `src/memory/extract.ts:164-168` |
| 失效语义 | supersede → `invalidAt` + `supersededBy` | `src/memory/patch.ts:36-48` |
| 上限淘汰 | `evictFacts` 按 fact 数量/字数执行，失效条目仍计入、优先被淘汰 | `src/memory/patch.ts:233-248` |
| 批准 | 只对一个目标 doc 调 `applyPatch`；`applyPatch` 对未命中的 id **静默忽略** | `src/fish/memory-admin.ts:54-68`、`src/memory/pending.ts:175-194` |
| 待审展示 | 线上有 SUPERSEDE 的「将失效」原文查找；脚本 `--pending` 只有摘要 | `src/fish/memory-admin.ts:192-235`、`scripts/memory.ts:397-419` |
| 无替代失效 | **没有通道**：SUPERSEDE 必须给新事实文本 | — |

## 3. 设计决策

### D1 新增 `EXPIRE` 动作

用 SUPERSEDE 写「已不再玩 X」会占用 `factsPerPerson` 名额并产生否定句噪音。`EXPIRE` 只置失效，不新增事实。

### D2 证据闸：`quote` 必须是**入站原文**的逐字片段

模型每条 `EXPIRE` 必须带 `quote`（从本页**群友说的话**里逐字摘的更正原话，≤60 字）。机械校验：

1. `quote` 先过与 `safeShort` 同款的机械过滤（限长 60、去控制字符/隐私模式）；
2. 过滤后的 `quote` 必须是**本页入站原文集合**中某条的 substring。

> 关键：证据域不能是扁平 transcript——它同时包含鱼自己的 outbound 和主人评价，
> 拿它当证据域等于允许「鱼自己的推测」自证（与 D4 冲突）。抽取侧需由
> `renderMemoryTranscript` 额外产出结构化入站原文集合（`fish.inbound.data.text`），
> 只给这个集合做 substring 判定。substring 仍不能证明语义相关，靠提示词 + 待人审（D6）。

### D3 防误杀

- `confidence` 不是 `high` 的 `EXPIRE` 一律丢弃，**复查轮也一样**（复查轮放宽针对漏记，不针对误删）。
- 每页 `EXPIRE` 上限 5（常量单一定义，`reconcile` 与 `apply` 两层都机械截断）。
- 同一 `factId` 同页去重；**一条 `quote` 默认只支持一个 `factId`**（避免一句模糊反驳批量淘汰多条）。
- 不机械禁止「一次失效同一 subject 的全部 fact」（人可能同时结束多个项目），靠逐条 quote + 待人审。

### D4 证据来源只认三类

本人明说状态变了 / 群友明确更正反驳（含反驳鱼说过的过时话）/ 事件收尾。
不认：沉默、时间久、第三方猜测、鱼自己的推测。

### D5 subject 不采信模型

`factId → subject` 由 known 映射机械解析；模型写的 subject 忽略。**known id + 伪造 subject 要接受**（用真实 subject），
只有未知 `factId` 才整条丢弃。

### D6 有替代优先走 SUPERSEDE

**整批解析完成后再过滤**：以最终的 `supersededIds` 集合为准，命中的 `EXPIRE` 全部丢弃。
不依赖候选在 JSON 里的先后顺序。

### D7 审计字段

`MemoryFact` 新增可选 `expiredReason?: string`（存过滤后的 quote，≤60 字），与 `invalidAt` 一起写入；
不参与渲染。绝不写 `supersededBy`（那是「被谁取代」）。

### D8 patch 结构与常量

```ts
export interface MemoryPatch {
  // ...既有字段不动
  expire?: { subject: string; id: string; quote: string }[];
}
export const MEMORY_EXPIRE_PER_PAGE = 5;   // reconcile 与 apply 共用
export const MEMORY_EXPIRE_QUOTE_CHARS = 60;
```

### D9 批准双轨预检（新增，堵静默 no-op）

`known` 是「公共层 + 当前私有层」合并视图，但批准只写一个目标 doc。若待失效事实在另一层，
`applyPatch` 会静默不命中、待审却已被删除 —— 等于「报告成功但什么也没发生」。

因此：批准前先查目标 doc，**必须包含所有待 expire 的有效 fact 且 subject 相符**；不满足就返回明确错误、
**保留待审**，让主人改轨道。（既有 SUPERSEDE 的同类问题不在本次范围，只作为已知限制记录。）

### D10 术语统一为四动作

ADD / SUPERSEDE / EXPIRE / SKIP。抽取注释、两份 prompt、`AGENTS.md` §16、`MemoryFact.invalidAt` 注释
同步；`ExtractSignals.conflict` 明确**只统计 SUPERSEDE**（EXPIRE 单独计 `expired`）。

## 4. 抽取输出格式（模型侧）

```json
{
  "candidates": [
    { "action": "EXPIRE", "type": "fact", "factId": "f-3f2a91ab12cd", "quote": "早就不玩了", "confidence": "high" }
  ],
  "skipped": 1
}
```

提示词新增「时效性核对」段（放在三分类之前），写清：先核对旧账再挑新东西、四类证据、逐字引用要求、
时间久不是依据、high-only、每页 ≤5、正例 1 条（群友反驳鱼说过的过时话）/ 反例 1 条（仅因事实陈旧）。

## 5. 终态契约（完成判据）

统一验收命令（自检脚本需授权，见 §6 T5）：

```bash
node scripts/verify-memory-expire.ts && npm test && npm run prompts
```

| ID | 类型 | 条件 | 验证方法 | 通过判据 | 证据位置 | 任务 |
|---|---|---|---|---|---|---|
| F1 | AUTO | `EXPIRE` 落库：命中 fact 置 `invalidAt` + `expiredReason`，**不写** `supersededBy`；该事实从 `renderMemorySection` 输出消失 | 纯函数：`applyPatch` + `renderMemorySection(state, {speakers:[],text:""}, {})` | 断言 invalidAt 有、supersededBy 无、渲染文本不含该 fact | verify 脚本 E1 | T1 |
| F2 | AUTO | **EXPIRE-only 不被静默丢**：`reconcile` 返回 `status:"ok"`、`isPatchEmpty(patch)===false`、`restrictSubjects` 后 `expire` 仍在 | 三段串联断言（不依赖真实模型） | 三处都为真；任一为假即 FAIL | verify 脚本 E2 | T1+T2 |
| F3 | AUTO | factId 机械解析：known id + 伪造 subject → 接受且 subject 取 known 的真实值；未知 factId → 丢弃且不产生任何 fact | 两条用例 | 与 D5 一致 | E3a/E3b | T2 |
| F4 | AUTO | quote 闸：空 / 不在**入站原文集合** / 超过 60 字 / 命中隐私模式 → 丢弃；合法 quote 通过 | 四态用例；证据域用注入的入站文本集合 | 前四态丢弃、合法通过 | E4 | T2 |
| F5 | AUTO | 防误杀与限额：confidence≠high 丢弃（含 review 模式）；同页 >5 截断到 5；同 factId 去重；一句 quote 只支持一个 factId | 四类用例 | 全部符合 | E5 | T2 |
| F6 | AUTO | supersede 优先：`EXPIRE` 在前 / 在后两种顺序，最终都只按 supersede 生效（`supersededBy` 指向新 fact），expire 条目不生效 | 两种顺序都跑 | 两种顺序结果一致 | E6 | T1+T2 |
| F7 | AUTO | 批准双轨预检：目标 doc 缺该有效 fact（或 subject 不符）→ 批准失败、**待审仍在**；正确轨道才置 `invalidAt` | 纯函数构造两个 doc + 批准 | 错误轨道失败且 pending 未删；正确轨道成功 | E7 | T1+T4 |
| F8 | AUTO | 不回归：EXPIRE 不新增 fact（apply 前后 fact 总数不变）；失效条目仍计上限并优先被淘汰；不含 expire 的 patch（含 `feedback`）行为不变 | 三条断言 | 全部符合；`feedback` 通道显式断言 | E8 | T1 |
| F9 | AUTO | 提示词与术语：两份 prompt 均含四动作口径与 EXPIRE 关键规则片段（逐字断言：`EXPIRE`、`quote`、`逐字`、`high`）；`npm run prompts` 无报错、无死文案 | 文件断言 + `npm run prompts` + `npm test` 的死文案检查 | 关键片段都在；`npm run prompts` 退出 0 | 脚本输出 | T3 |
| F10 | AUTO | 全量回归：`npm test` `fail 0`（数量以实际输出为准，不把 145 当判据） | `npm test` | fail 0 | 测试输出 | T1–T5 |
| F11 | MANUAL | 待审展示链（线上 `/记忆` 与脚本 `--pending`）都显示：`淘汰 N 条` + 每条 `factId + 原事实 + quote`；正确轨道批准后 `--persona` 显示 `失效@时间` 与 `expiredReason` | 主人在私聊对鱼发 `/记忆`，配合 `npm run memory -- --persona <名> [--json]` | 三样都能看到 | 操作者：主人（macmini） | T4 |
| F12 | MANUAL·非阻塞 | 线上首周观察：记录出现几条 EXPIRE（**含 0 条**），日志 `记忆抽取 … 淘汰N` 可对账 | 观察日志与 `/记忆` | 形成一条观察记录即可，不要求必须出现 EXPIRE | 操作者：维护者 | T7 |

### 停滞判据

同一 `F` 项连续 **3 轮**验证输出无实质变化 → 判停滞，停止重试，报告：未满足条件、证据、原因、恢复下一步。

### 授权前提

- **T5 自检脚本已获用户授权（2026-11-05）**：`scripts/verify-memory-expire.ts` 落文件、不接入 `npm test`。
- commit / push / deploy 各自需要用户明确授权（部署另走 `fish.sh deploy` 既定流程）。

## 6. 任务拆分与依赖

```
T1 ──→ T2 ──→ T5*
 │      │
 ├──→ T3 ┴──→ T5*
 ├──→ T4
 └──────────→ T6
                 T7（全部完成后，需授权）
```

\* T5 需授权；T3 与 T1 字段契约对齐后可并行起草，最终以 T2 的字段名收口。

| 任务 | 交付物 | 独立验收标准 | 依赖 |
|---|---|---|---|
| **T1** 数据结构与落库 | `src/memory/model.ts`：`MemoryPatch.expire`、`MemoryFact.expiredReason`、`MEMORY_EXPIRE_PER_PAGE/QUOTE_CHARS`；`src/memory/patch.ts`：expire 阶段（含 ≤5 截断、幂等、不写 supersededBy）；`src/memory/pending.ts`：`isPatchEmpty` 纳入 expire、`summarizePatch` 增「淘汰 N 条」 | 纯函数：apply 后 invalidAt/expiredReason 正确、总数不变、二次 apply 幂等 | 无 |
| **T2** 抽取解析 | `src/memory/extract.ts`：新 `readExpire()`（只认 factId+quote+confidence，不造 fact）、`EXPIRE` 仅允许 `type=fact`、quote 机械过滤 + **入站原文集合** substring、high-only、≤5、factId 去重、一句 quote 一事实、supersede 后置过滤、`restrictSubjects` 保留 expire、`extractMemories` 非空判定纳入 expire/supersede、**导出纯解析入口** `export function reconcileCandidates(...)`（或 `parseExtraction`） | 用构造 raw 跑导出的纯入口，覆盖 F2–F6 全部用例 | T1 |
| **T3** 提示词与术语 | `prompt/memory-extract.md`、`prompt/memory-extract-review.md`（四动作 + 时效性核对段 + 正反例）；`AGENTS.md` §16；`extract.ts` 头注释与 `reconcileCandidates` 注释；`MemoryFact.invalidAt/supersededBy` 注释；`ExtractSignals` 增 `expired` | 两份 prompt 关键片段逐字断言；`npm test` 死文案检查通过 | T1（字段名） |
| **T4** 审批与展示 | `src/fish/memory-admin.ts`：批准前 expire 预检（D9）、待审行展示 `factId + 原事实 + quote`；`scripts/memory.ts`：`--pending` 同款展示、`--persona` 文本详情附 `expiredReason`；`prompt/messages.md`：新 key 用字面量 `messages["…"]` 引用；`src/compact.ts` 抽取日志加 `淘汰N` | 隔离 fixture（临时 `YUGANG_HOME`）下 `--pending` 输出含三要素；预检失败保留待审 | T1 |
| **T5*** 自检脚本（**待授权**） | `scripts/verify-memory-expire.ts`：F1–F10 逐项 PASS/FAIL + 退出码，只 import 纯模块，禁止 import `src/app/runtime.ts`；不接入 `npm test` | 脚本内含负例（误输入必须被拒），不以「基线必然 FAIL」作为终态判据 | T2 + T3 |
| **T6** 文档 | `AGENTS.md` §16 增「时效性核对」条目（证据闸/high-only/≤5/审批预检）；`.agents/skills/ops/SKILL.md` 增排查口径（怎么看待审里的「淘汰」与 `expiredReason`） | grep 到段落；`npm test` 文档一致性通过 | T1–T4 |
| **T7** 部署与观察 | 提交 → 推送 → `fish.sh deploy`（三步分别授权） | 线上日志出现 `记忆抽取 … 淘汰N` 字段可用；F11 人工走一遍 | 全部 + 授权 |

### 调度

无真实依赖即并行：T1 与 T3 可同时起步；T1 完成即启动 T2、T4；T2/T3 完成后启动 T5；
T6 在 T1–T4 完成后与 T5 并行；T7 最后。

## 7. 风险与对策

| 风险 | 影响 | 对策 |
|---|---|---|
| R1 模型凭「旧」判失效 | 记忆变差 | quote 逐字闸（入站证据域）+ high-only + 待人审；失效条目保留可追溯（**不承诺一键恢复**，现有只有同意/拒绝/删除，必要时人工修复） |
| R2 quote 合法但语义无关 | 闸挡不住 | 待审必须展示 quote + 原事实；提示词要求 quote 是反驳原句 |
| R3 待审堆积 | 审批疲劳 | 每页 ≤5；逐条 quote；只在明确证据时产出 |
| R4 与 supersede 冲突 | 双重失效 | D6 整批后置过滤 |
| R5 双轨批准静默 no-op | 「批准成功但没生效」 | D9 预检 + F7 |
| R6 改动波及 `/评` 通道 | 评价包异常 | 不碰 `feedback`；F8 显式断言 |
| R7 外部写库撞 id（今日已发生） | 会话损坏、整群静默 | 写操作走活鱼护栏（`--force` + 写完重启）；首选线上 `/记忆` |
| R8 提示词膨胀 | 抽取成本上升 | 新段 ≤15 行，正反例各 1 条 |

## 8. 执行模式

二选一，由用户在启动执行前决定：

- **subagent 并发驱动**：按 §6 调度派发（T1/T3 并行起步），主会话只做调度、整合与汇报；
- **主会话串行执行**：本会话 inline 逐任务执行，不派发 subagent。

## 9. 审阅意见处理（v1 → v2）

| 审阅项 | 处置 | 落点 |
|---|---|---|
| A1 EXPIRE-only 三处被丢 | 已写入 T1/T2 交付物 + F2 | §5 F2、§6 T1/T2 |
| A2 `readFact` 误伤 EXPIRE、顺序陷阱 | 新增 `readExpire()`；supersede 后置过滤；F6 双顺序 | §3 D6、§5 F6、§6 T2 |
| A3 双轨批准静默 no-op | 新增 D9 预检 + F7 | §3 D9、§5 F7 |
| A4 待审缺 quote 展示 | F11 + T4 三要素展示；脚本与线上同款格式 | §5 F11、§6 T4 |
| B1 纯入口不可达、F2 判据矛盾 | T2 导出纯入口；F3 按 D5 改正 | §6 T2、§5 F3 |
| B2 F6 与上限实现冲突 | 改写为「不新增 fact、仍计上限并优先淘汰」 | §5 F8 |
| B3 F7 验收不闭合 | 统一命令加 `npm run prompts`；删 sha 判据；改逐字断言 | §5 F9、§5 命令 |
| B4 F9/F10 不可结束 | F11 给出具体操作步骤；F12 改为非阻塞观察并允许 0 条 | §5 F11/F12 |
| C1 quote 证据域与过滤 | quote 先过滤再在**入站原文集合**内做 substring | §3 D2、§6 T2 |
| C2 去重与限额 | factId 去重、一句 quote 一事实、常量单一定义 | §3 D3/D8 |
| D1 自检脚本未授权 | T5 标「待授权」，未授权降级为 inline 验证 | §5 授权前提、§6 T5 |
| E1 DAG 矛盾 / 基线 FAIL 判据 | 重画 DAG、加 T3→T5、删基线判据 | §6 |
| E2 T4 缺隔离环境 | 明确用临时 `YUGANG_HOME` fixture | §6 T4 |
| F1 术语与注释未同步 | T3 扩为四动作口径 + 注释 + `ExtractSignals` | §3 D10、§6 T3 |
| F2 部署与恢复口径 | commit/push/deploy 分别授权；R1 不承诺一键恢复 | §5 授权前提、§7 R1 |

## 10. 修订记录

| 版本 | 日期 | 变更 |
|---|---|---|
| v1 | 2026-11-05 | 初稿 |
| v2.1 | 2026-11-05 | 用户选定「主会话串行执行」并授权 T5 自检脚本；按 v2 执行 |
| v2 | 2026-11-05 | 按独立审阅修订：补 EXPIRE-only 三处丢失、`readExpire` 与后置 supersede 过滤、双轨批准预检、quote 证据域改入站原文、F 项重编为 F1–F12、T5 标待授权、DAG 与验收命令修正、术语统一四动作 |
