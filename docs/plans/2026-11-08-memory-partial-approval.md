# 长期记忆待审子项的部分采纳

- 日期：2026-11-08（v2，已按独立 Kimi-K3.1-Pro review 修订）
- 状态：独立验收意见已修复，F1–F8 自动终态通过；F9 待生产人工验收；未 commit / push / deploy
- 用户需求：
  > 我看为什么刚才审记忆的时候，很多条记忆共享一个id，我想采纳其中一部分做不到吗
  >
  > 嗯，把功能补上吧

## 1. 目标与边界

把一个压缩页产生的待审 `MemoryPatch` 拆成**可稳定寻址、可单独批准**的候选子项：

```text
p-9a4c04ce774b13c74d       父条目：批准 = 采纳全部剩余项；拒绝 = 清除全部剩余项
p-9a4c04ce774b13c74d#01    子项：只采纳这一项，其余项仍以原编号留在待审队列
```

两条既有写通道都支持子项：

```text
/记忆 查看 <父id>
/记忆 同意 <子项id> [公共|私有]

npm run memory -- --pending
npm run memory -- --approve <子项id> [公共|私有]
```

### 非目标

- 不开放模型直接批准；写通道仍只有主人私聊 `/记忆` 与 `scripts/memory.ts`。
- 不改变默认私有、公共批准先调用既有 `publicizePatch`、群内 `/记忆` 无副作用、外部写库活鱼护栏。
- 不改变长期记忆的公共/私有隔离、渲染、上限淘汰与 `applyPatch` 的核心语义。
- 不扩大公共化字段范围：facts/lore/cards 的 text 仍按现状处理；纯资料、feedback、纯 supersede/expire 不额外送模型。
- 本次不做一次命令多选，也不加子项拒绝；子项批准后可对父 id 执行「拒绝」清除全部剩余项。
- 不恢复本次已经清空的旧待审；旧格式若以后仍存在则必须兼容。

## 2. 独立 review 与修订结论

独立审阅指出两个阻断问题，本版均改变设计而非仅补测试：

1. **旧公共化快照可能复活已批准子项并串轨**：原方案在等待模型后把公共化 patch 写回待审，再另起事务批准。若等待期间某子项已私有批准，父条目仍存在，旧快照会把该子项复活并随后公共批准。
   - 修订：**取消公共化写回待审的中间事务**。公共化只在内存生成候选结果；最终事务重新解析 selector、校验原始 patch fingerprint，并直接应用脱敏 patch、删除所选 item。fingerprint 变化则 conflict，零写入。
2. **EXPIRE 预检与最终批准分离会静默 no-op**：预检后目标 fact 可能已失效或被删，`applyPatch` 会跳过但待审被移除。
   - 修订：两条入口都必须在**最终批准事务内**对实际选择的 patch 重做失效目标预检；失败则目标和待审均不变。

同时吸收以下审阅意见：明确 items ↔ patch 聚合规则；子项详情必须展示绑定 supersede 的旧事实影响；事务回执只带纯值；补父公共化/子项私有交错、事务内失效变化、SQLite 重开、残留人格和旧 feedback 子项测试；修正测试任务依赖图。

## 3. 现状与根因

- `src/fish/compactor.ts` 每次非空抽取只生成一个 `PendingMemoryEntry`，其 `patch` 内含多个候选数组。
- `src/memory/pending.ts::approvePending()` 按父 id 找到 entry 后，对完整 `entry.patch` 调 `applyPatch()`，随后 splice 整个 entry。
- `src/memory/query.ts`、线上 `memory-admin.ts` 与 `scripts/memory.ts --approve` 均只识别父 id。
- `src/app/runtime.ts::publicizePendingForApproval()` 目前会先把公共化结果写回 pending，再正式批准；部分批准后父 entry 持续存在，使旧快照覆盖成为新风险。
- 线上 EXPIRE 预检目前在 commit 外；CLI 缺少同等的最终事务预检。

因此需要统一**待审子项模型、selector、fingerprint、最终事务批准、公共化编排和展示**，不能只在表格或 CLI 上加编号。

## 4. 设计

### D1 稳定子项与唯一聚合规则

`PendingMemoryEntry` 增加可选字段：

```ts
interface PendingMemoryItem {
  id: string;             // 完整选择器：`${entry.id}#${两位序号}`
  order: number;          // 首次拆分的全局顺序；聚合只按它排序，不按 subject 猜测
  patch: MemoryPatch;     // 独立 apply 所需的最小 patch
}

interface PendingMemoryEntry {
  // 既有字段保留
  items?: PendingMemoryItem[]; // 缺省 = 旧格式，读取时从 effective patch 确定性拆分
}
```

共享纯函数只有一套：

```ts
effectivePendingPatch(entry): MemoryPatch
splitPendingPatch(entryId, patch): PendingMemoryItem[]
aggregatePendingItems(items): MemoryPatch
pendingItems(entry): PendingMemoryItem[]
```

规则：

- 新待审先拆分，再令 `entry.patch = aggregatePendingItems(items)` 后一次写入；序号只分配一次、永不复用。
- `aggregatePendingItems` 按 `order` 排序并直接拼接同类数组；**允许同 subject 的多个 people 元素**，不按 subject 合并，以兼容旧数据和保持逐位置语义。
- 对含 items 的 entry，items 是选择的事实源；所有写路径维持不变量：`effectivePendingPatch(entry)` 与 `aggregatePendingItems(entry.items)` 深度相等。每次部分批准只删选中 item，再重建父 patch；其余 id/order/patch 不变。
- 旧 entry 无 items 时以 `effectivePendingPatch` 确定性派生；父批可直接应用原 effective patch。首次子项批准后，将剩余 items 物化并重建父 patch，之后编号稳定。
- T6 旧 `entry.feedback` 先由 `effectivePendingPatch` 一次性映射进 feedback 通道，再参与拆分、公共化和批准，避免重复映射或丢失。

### D2 子项粒度与拆解规则

按固定顺序生成子项，order 只用于聚合和首次编号：

1. **人物资料**：每个原 people 元素的非空 `names/style/catchphrases` 合成一个资料项；无资料不产生空项。
2. **人物事实**：每个 fact 一个子项，只含该 subject 和这一条 fact。
3. **说法**：每个 lore 一个子项。
4. **卡片**：每个 card 一个子项。
5. **取代**：按 D3 绑定或独立列出。
6. **淘汰**：每个 expire 一个子项，保留 subject、fact id 与 quote。
7. **评价**：每个 feedback 一个子项。

这样选择某个人物的一条事实，不会被迫采纳该人物其它事实；资料项与事实项也可独立决定。拆分/聚合不得按 subject 重新分配公共化文本。

### D3 SUPERSEDE 与替代事实绑定，EXPIRE 独立审批

- 对每个 supersede note，若同一 patch 里存在同 subject 的新 fact 子项，则把 note 并入**该 subject 的第一个新 fact 子项**，不另生成可独立选择的 supersede 项。
- 选择该事实时，新增与旧事实失效在同一次 `applyPatch` 内完成，`supersededBy` 仍指向新 fact；同 subject 其它新事实不会重复执行该 note。
- 若 supersede 没有同 subject 新 fact，保留为明确标注「仅失效、无替代」的独立子项，不静默丢弃、不绑定其它 subject。
- expire 是有独立 quote 证据的无替代失效，逐项展示、逐项预检、逐项批准。
- 父 id 整批批准应用全部剩余 patch；既有 `applyPatch` 无需理解 selector。

### D4 selector、fingerprint 与事务结果

在 `src/memory/pending.ts` 提供共享能力，线上与脚本不得各写一套：

```ts
findPendingSelection(entries, selector): { entry, item?, patch } | undefined
fingerprintPatch(patch): string // 对象 key 递归排序的 canonical JSON + SHA-256
approvePending(pending, selector, target, at, options?: {
  expectedFingerprint?: string;
  approvedPatch?: MemoryPatch; // 公共化后的同构 patch；缺省用当前原始选择
}): {
  status: "ok";
  digest: string;       // 事务内用实际应用 patch 算出的纯字符串
  remaining: number;
  originChatKey: string;
} | { status: "missing" | "changed" | "expire_mismatch" | "supersede_mismatch" }
```

- 父 id 选择全部剩余项；完整子项 id 只选择对应 item。malformed、跨父拼接、不存在或已批准的 selector 返回 missing。
- 公共批准在最终事务重新解析 selector，并要求当前原始选择 patch 的 fingerprint 等于公共化前的 expectedFingerprint；不一致返回 changed，禁止把旧脱敏结果应用到已变化的选择集合。
- 最终事务内重读目标 draft，对本次实际选择的 patch 执行 expire 和 supersede 目标预检：目标 fact 必须存在、subject 相符且仍有效。失败返回对应 mismatch，目标与 pending 均不变。
- 预检与 `approvePending` 必须在同一 commit；公共化前的早期预检只能用于节省模型调用，不能替代事务内预检。
- 通过后直接应用 `approvedPatch ?? 当前选择 patch`，删除所选 item/entry并重建剩余父 patch。
- digest、remaining、originChatKey 都在事务内提取为纯值；事务外不得读取 draft 或引用 draft 的 appliedPatch。

### D5 公共化不写回待审，最终事务直接应用

公共批准统一采用 prepare → commit：

1. 只读解析 selector，取得原始选择 patch 和 fingerprint。
2. 在事务外仅对这个 patch 调既有 `publicizePatch()`，**不写 pending**。字段覆盖范围、机械过滤、结构同构和 fail closed 完全沿用现状。
3. 最终 commit 重新解析 selector、核对 fingerprint、做失效目标预检，然后直接应用内存中的公共化 patch并删除所选原始 item。
4. 模型或输出失败、selector 消失、fingerprint 改变、失效目标不符，全部零写入；changed 提示主人重试，不能退化成父批或私有批准。

效果：父公共化等待期间，即使某子项被另一请求私有批准，父选择的剩余 patch fingerprint 也会变化，最终公共批准 conflict；旧快照不会复活子项，更不会把同一项写入两个轨道。

实现上可将准备结果作为独立 `MemoryApprovalPreparation` 纯值从 `publicizePendingForApproval` 传给 `memoryCommandReply/approveMemory`；不要把内部 patch 塞进用户命令字符串或 `MemoryCommand` 解析结果。CLI 复用同一 selector/fingerprint 语义。

### D6 主人私聊展示与命令

`src/memory/query.ts` 新增：

```text
/记忆 查看 <父id>
/记忆 同意 <父id|子项id> [公共|私有]
```

- `/记忆` 总览继续按父条目列出，digest 增加剩余子项数，避免一次撑爆 QQ。
- `/记忆 查看 <父id>` 展开全部剩余子项：完整子项 id、类型、原文；资料项列 names/style/catchphrases，事实项列 subject 与原文，lore 带 keys，card 带正文，expire 带目标 fact 与 quote，独立 supersede 明示「仅失效、无替代」。
- **凡子项 patch 绑定 supersede，详情必须附 `将失效 <fact-id> <旧原文>`，说明它与新事实原子批准**；旧原文查询覆盖该人格公共层与全部私有层。CLI 同语义。
- 子项批准回执包含选中 id、本次实际 digest 和剩余数；剩余为 0 时明确父条目已审完。changed/mismatch 都有独立错误回执且零写入。
- 新增机械文案只放 `prompt/messages.md`；群内仍只回 `cmd_memory_group`，即使带子项也无副作用。

### D7 CLI 展示与批准

- `scripts/memory.ts --pending` 在父条目摘要下逐项打印稳定子项 id、原文和失效影响，便于直接复制。
- `--approve <子项id> [公共|私有]` 复用共享选择器、fingerprint、公共化、最终事务预检与 `approvePending()`。
- 只读定位同时支持父/子 id，继续覆盖人格书已删除后的残留 pending doc；该场景必须有子项批准测试。
- 活鱼检测、`--force`、写完必须重启的约束不变；CLI 不新增绕过线上进程的写通道。

### D8 文档同步

更新 `AGENTS.md` §16 与 `.agents/skills/ops/SKILL.md`：父/子 id、`/记忆 查看`、子项批准、剩余项保留、公共化不写回与 fingerprint conflict、supersede 展示和事务内失效预检。命令示例以最终实现为准。

## 5. 整体交付终态（goal 可消费清单）

统一 AUTO 验收命令（新增测试获授权并落地后）：

```bash
npm test && npm run prompts && git diff --check
```

| ID | 类型 | 必要条件 | 验证方法与环境 | 通过判据 | 证据位置 | 覆盖任务 |
|---|---|---|---|---|---|---|
| F1 | AUTO | 多资料、多事实、同 subject 重复 people、lore、card、feedback 可拆分/聚合；旧无 items 条目兼容 | Node 纯函数 fixture | 候选无遗漏/重复/空项；order 与 id 固定；含 items 时 effective patch === aggregate items | `test/memory-partial.test.ts` 拆分聚合用例 | T1 |
| F2 | AUTO | 私有子项批准只落地选中项，未选内容不进长期 doc，fromChat 正确 | 隔离 MemoryState + PendingMemoryState | 目标只有选中内容；pending 保留其余项；错误 selector 零写入 | 部分批准用例 | T1 |
| F3 | AUTO | 连续部分批准、父批剩余和 SQLite 重开后编号稳定；最后一项后父 entry 删除 | 非首项→首项→父批 + 隔离 SQLite 重开 | 每次 digest 命中实际选择；剩余 id/order 不变；items↔patch 不变量逐步成立；最终 entries 为空 | 连续审批与持久化用例 | T1 |
| F4 | AUTO | 旧整批与旧 `/评` feedback 兼容，旧 feedback 也可用子项选择器批准；回执不读取失效 draft | 旧格式 fixture + 真实 harness/SQLite 回执 | 父批语义不回归；旧 feedback 子项只落地一次；事务外回执为纯字符串 | 旧格式与回执用例 | T1+T2 |
| F5 | AUTO | supersede 与首个替代事实原子应用并展示旧事实影响；独立 supersede/expire 在最终事务预检；预检后目标变化会失败且保留待审 | 多同 subject fact + supersede/expire fixture；事务内改变目标事实的交错用例 | `invalidAt/supersededBy` 正确；详情有旧原文；目标缺失/已失效返回对应 mismatch，双 doc 不变 | 关联失效与事务交错用例 | T1+T2 |
| F6 | AUTO | 公共化不写 pending；父公共化等待期间子项被私有批准会 conflict，不复活、不串轨；子公共化不影响未选文本；无可改写文本不调模型 | 可注入 stub `complete()` 的公共化编排 + 两请求交错 | fingerprint 变化时目标与 pending 保持交错后的真实状态；A 只私有、B 未公共；模型输入不含未选文本；失败零写入 | 公共化并发与字段范围用例 | T1+T2+T3 |
| F7 | AUTO | `/记忆 查看`、`--pending` 展示子项 id/原文/失效影响；私聊与 CLI 子项批准同语义；残留人格 doc 可定位；群内无副作用 | parser 测试 + YUGANG_HOME 临时 SQLite 的 CLI 集成测试，无活鱼 | 两入口只批准选中项并给正确剩余数；残留人格子项成功；群内只回引导且 DB 不变 | 命令与 CLI 用例 | T2+T3 |
| F8 | AUTO | prompt 注册无冲突、无新增大段源码模型文案、全量回归通过 | 统一 AUTO 命令 | `npm test` fail 0；`npm run prompts` 退出 0 且无意外归属；diff 无空白错误 | 命令输出 | T1–T5 |
| F9 | MANUAL | macmini 真实 pending 完成「查看 → 私有批准一个子项 → 再查看 → 拒绝父条目剩余项」 | 操作者：主人；等自然压缩产生至少两个子项后在主人私聊操作 | 只有选中项进来源会话私有层；其余保持原 id 并可父拒绝；公共 doc 不变；鱼持续正常响应 | 生产 `/记忆` 回执与只读 `npm run memory -- --persona <名>` | 部署后人工验收 |

### 停滞判据

同一 F 项连续 **3 轮**验证输出无实质变化即判停滞：停止重复重试，记录未满足条件、最近证据、根因假设与恢复下一步；不得把任务自报完成当终态完成。

## 6. 任务拆分与 DAG

```text
T1 选择器、fingerprint、拆分聚合与事务批准纯函数
 ├──→ T2 私聊命令、展示与线上公共化编排
 ├──→ T3 CLI 展示、批准与脚本公共化编排
 └──→ T4 文档（等 T2/T3 命令落地后收口）
T1+T2+T3 ─→ T5 新增回归测试（需授权）
T2+T3+T4+T5 ─→ T6 统一验证与独立验收
```

| 任务 | 交付物 | 独立可观察验收 | 依赖与理由 |
|---|---|---|---|
| T1 | `src/memory/pending.ts` 的 items、effective/split/aggregate、selector、fingerprint、最终批准；`src/fish/compactor.ts` 写 items；必要类型导出 | D1–D4 纯函数可运行，公共化准备结果可在最终事务校验并直接应用 | 无；先冻结两入口共用契约 |
| T2 | `query.ts`、`fish/types.ts`、`fish/memory-admin.ts`、`app/runtime.ts`、`prompt/messages.md` | 私聊可查看/批准子项；公共化不写回且交错 conflict；事务内失效预检；群内无副作用 | T1：依赖共享 selector/fingerprint/批准结果 |
| T3 | `scripts/memory.ts` 的逐项 pending、子项定位、公共化 prepare 与最终 commit | 隔离库上 CLI 与线上语义一致，残留人格可批准，活鱼护栏不变 | T1：禁止复制另一套拆分/指纹逻辑 |
| T4 | `AGENTS.md`、`.agents/skills/ops/SKILL.md`、本计划状态回填 | 文档与真实 parser/CLI 一致，无旧「只能整批」或公共化写回描述 | T2+T3：以最终命令为事实源 |
| T5 | **建议（待用户授权）**：新增 `test/memory-partial.test.ts` 与隔离 SQLite fixture，覆盖 F1–F7 | 新测试被 `npm test` 自动发现，逐项通过 | T1+T2+T3：接口和两入口都确定后编写；未授权不得创建 |
| T6 | 统一 AUTO 验证、独立验收 subagent、差距修复 | F1–F8 有当前版本证据；F9 如实待人工，不伪造完成 | 全部实现与已授权测试完成 |

事件驱动调度：启动时只有 T1 无依赖；T1 完成后立即并行启动 T2、T3，二者都 ready 后启动 T4 与已授权的 T5，不等待无关批次。若用户选择主会话串行，则按 T1 → T2 → T3 → T5 → T4 → T6 执行，不派发实现 subagent。

## 7. 授权与交付边界

- 计划编写与本轮独立 review 已完成；尚未开始实现。
- **新增测试与隔离 fixture：已获用户明确授权（2026-11-08）**，执行模式为主会话串行；已创建 `test/memory-partial.test.ts`，使用临时目录 SQLite，不接触生产库。
- 不默认 commit、push 或 deploy；每项都需用户另行明确授权。
- 生产人工验收必须使用线上 `/记忆` 写路径；外部 CLI 写库仍遵守停鱼/重启护栏。

## 9. 验收记录（2026-11-08）

- 独立 Kimi-K3.1-Pro 验收：F1–F6、F8 通过；F7 因独立 supersede 未区分「仅失效、无替代」暂不通过，另指出该场景缺少永久回归。
- 主会话已修复：私聊与 CLI 按 `pendingItemHasReplacement` 区分原子取代与纯失效；新增独立 supersede 成功、目标交错失效、完整回滚和双入口展示测试。
- CLI 公共子项补充纯资料真实测试；模型配置与模型实例均延迟到确有文本需要脱敏时加载。
- 当前统一 AUTO 结果：`npm test` **174/174 通过**（其中本功能 8 组），`npm run prompts` 通过，`git diff --check` 通过。
- F9 未执行；生产未部署，不能把本地完成等同于线上生效。
