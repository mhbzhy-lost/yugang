# 全群 next 模式（下线 legacy 开关）+ 弹药库事件驱动补货 实现计划

> **给执行 agent：** 必须逐任务执行本计划；步骤使用 `- [ ]` 复选框跟踪。只有整体交付终态全部验证通过，才算计划执行完成；未满足时持续修复与验证。执行方式由计划编写完成后的用户选择决定。

**目标：** 下线 engagement 开关（next 成为唯一搭话行为，`.env GROUPS` 成为唯一群边界，崩坏狗窝 174408629 一并启用）；弹药库改为事件驱动补货（不再定时逛轮，库空自动补到 5）；新闻播报维持仅搬史群 659976571 不变。

**架构：** gate 删除 next 分支之后的整段 legacy 判定（回复合集必答/无 @ 合集丢弃/限流/特别关注随机门在 next 现状下本就不生效，属纯删除）；`fish-config` 删除 `engagement`/`engage.groups`/`ambientMinIntervalSeconds`/`watchAmbientChance` 四字段，engage-next 状态机的群表直取 `.env GROUPS`；弹药侧 `ammo.slots` 允许空数组（缺省空=无定时逛轮），新增 `ammo.refillTarget`（缺省 5，0=关闭），`src/index.ts` 新增空库触发器（分享消费后即时 + 每 5 分钟兜底扫描，30 分钟冷却），复用 `runBrowseJob` 逛轮管线并允许 maxPicks 覆盖。

**技术栈：** Node 26（直接跑 TS）、pi-durable、本仓 npm test（102 项）。

## 全局约束

- 模型能看到的文字只有 `prompt/` 与工具包四件套（TOOL.md/schema.json/messages.json/tool.ts）；`src/` 内不得出现 ≥12 汉字的 prompt 字面量（`npm test` 扫描兜底）。
- 模板 `{{var}}` 严格替换；新增文案 key 进 `prompt/messages.md`（宿主层）或工具 `messages.json`，key 撞车启动即失败。
- 工具包四件套格式：TOOL.md（frontmatter name/description + 非空指南）、schema.json（严格 JSON）、messages.json（可选）、tool.ts；`src/tools/loader.ts` FACTORIES 双向一一对应。
- 配置校验语义沿用「非法回默认并记 problems」；`ammo.refillTarget` 区间 0–20；`ammo.slots` 空数组合法（=无定时逛轮）。
- 不得改动新闻管线的任何行为与配置（`news.targetGroup` 保持 659976571）。
- 群准入硬边界仍是 `.env GROUPS`（安全域）；174408629 加入后，一切群内安全闸（@ 白名单、出口校验）对其照常生效。
- 未经用户明确授权不新增测试；既有测试可随生产改动同步调整。不默认 commit；提交仅在用户授权时按 `git-commit-convention` 执行。

## 整体交付终态

| ID | 必要成立的条件 | 验证方法与环境 | 通过判据 | 证据位置 | 覆盖任务 |
| --- | --- | --- | --- | --- | --- |
| F1 | 全仓测试通过：legacy 删除与补货制改造后 `npm test` 全绿 | 本地 `npm test`（repo 根） | exit 0、102 项（数量可因删 legacy 用例减少，但 fail 0） | 终端输出 | T1、T2 |
| F2 | 线上三群全部进入 next：部署后启动日志含 659976571、184875934、174408629 三群的 next 启动行 | mini 上 `grep "搭话开窗 next 启动" var/fish-console.log \| tail -5` | 三群各一行「搭话开窗 next 启动 qq:group:<gid>：closed 从零计时」 | mini 日志 | T3 |
| F3 | 补货制配置语义正确：`ammo.slots=[]` 解析为无定时；`refillTarget` 缺省 5；legacy 四字段从配置面消失（engage 块本身保留时序字段，只删 groups） | 本地 node 加载 `src/fish-config.ts`（空 tmp config + 隔离 env 注入），断言 `AMMO_DEFAULTS.slots` 长度 0、`refillTarget===5`、`engagement`/`engage.groups`/`ambientMinIntervalSeconds`/`watchAmbientChance` 均不往配置面出现；顺带源码断言 `runBrowseJob` 缺省路径 | 断言全部为真 | 终端输出 | T1、T2 |
| F4 | 新闻目标群未回归 | mini 上 `grep -A2 '"news"' fish.config.json`（或 python json 读 `news.targetGroup`） | `"659976571"` | mini 配置 | T3 |
| F5 | 空库触发补货链路在线上可用 | 代码路径存在（T1 实现 + F1 测试）+ 部署后日志无相关报错；线上自然触发后 `var/fish-console.log` 出现「补货逛轮」行 | 代码级验证即时通过；线上触发行为记录为观察项（不阻塞计划完成，弹药空时才发生） | mini 日志 | T1、T3 |

**完成规则：** 所有必要条件同时满足，且验证证据对应当前交付版本，才能标记计划执行完成；仅完成任务步骤不能替代终态验证。F5 的线上自然触发是观察项：代码级与部署级验证通过即视为满足，自然触发证据后补。

**未满足时：** 在已授权范围内持续 `fix → test → 对照终态`；真实阻塞记录为未完成并写明恢复下一步。

## DAG

```text
T1 (弹药补货制：fish-config + index 触发器) ──> T2 (legacy 下线：gate/config/engage-next/文案/测试) ──> T3 (mini 配置 + 部署 + 线上验证)
```

依赖理由：T1 与 T2 都写 `src/fish-config.ts` 与 `src/index.ts`（同一文件不同区域），subagent worktree 隔离下文件级冲突不可并行，按「小先行、大在后」串行；T3 消费 T1+T2 的最终代码，且含部署动作（用户对计划的批准即部署授权）。

## Waves

- Wave 1：T1
- Wave 2：T2
- Wave 3：T3

**关键路径：** T1 → T2 → T3（全串行，无并行空间）。

---

### Task T1：弹药库事件驱动补货

**Deps：** `none`

**WritePaths：**
- `src/fish-config.ts`
- `src/index.ts`
- `src/external/ammo-store.ts`
- `prompt/messages.md`
- `prompt/runtime.md`
- `AGENTS.md`

**Resources：** `none`

**Files：**
- Modify：`src/fish-config.ts`（`AmmoConfig`/`AMMO_DEFAULTS`/`checkAmmoBlock`，约 60–115 行与 353–415 行）
- Modify：`src/index.ts`（`runBrowseJob` 约 2104–2190 行、emit 记账区约 620–640 行、worker 调度区约 2192–2205 行）
- Modify：`prompt/messages.md`（如「四时点」注释需同步；`watch_inline` 不在此文件，见 T2）
- Modify：`prompt/runtime.md`（第 19 行外部段「逛 B 站的工时轮」措辞：定时改为「定时（可空）或空库触发」）
- Modify：`AGENTS.md`（§17 弹药管线段：补货触发、冷却、扫描节奏，及「browse 失败（预算耗尽/当日熔断）时触发器每 30 分钟空转重试，每日预算兜底」的排查提示）

**接口契约：**
- Consumes：`runBrowseJob(slot: string, date: string): Promise<void>`（现签名，index.ts 2122 行）；`shareableAmmoOf(doc, nowMs)`（ammo-store.ts）；`jobKeyOf(date, slot)`；`localDay()`（既有工具，确认导入）。
- Produces：
  - `runBrowseJob(slot: string, date: string, opts?: { maxPicks?: number }): Promise<void>`——`opts.maxPicks` 覆盖 `ammo.maxPicksPerRun`（worker prompt 的 `{{max}}` 与 `triggerOf.workerRun.maxPicks` 同步取覆盖值；缺省行为零变化）。
  - `maybeRefillAmmo(reason: string): Promise<void>`（index.ts 内部函数）——条件全过才起补货逛轮；不抛错（内部 catch 打日志）。
  - `AmmoConfig` 新增 `refillTarget: number`；`AMMO_DEFAULTS.slots` 改为 `[]`；`checkAmmoBlock` 接受空 `slots` 数组并把 `refillTarget`（0–20）加入 ranges 校验与 known 集合。

**终态关联：** `F1`、`F3`、`F5`。

**验收标准：**

- [ ] **步骤 1：核对入口**
  - 读 `src/fish-config.ts` 的 `checkAmmoBlock`：现要求 `slots` 为「非空 HH:MM 数组」，空数组/非数组都回默认——本任务把「空数组」改为合法值（保留元素级时点校验），仅「非数组」回默认。
  - 读 `src/index.ts` 2104–2205 行：确认 `runBrowseJob` 的 `maxPicks` 来源是 `ammo.maxPicksPerRun`，`worker_browse_task` 模板变量 `{{max}}` 与 `triggerOf` 钉的 `workerRun.maxPicks` 是仅有的两个消费点。
- [ ] **步骤 2：实现**
  - `fish-config.ts`：`AmmoConfig` 加 `refillTarget: number`（注释：空库触发补货的目标条数，0=关闭）；`AMMO_DEFAULTS` 设 `slots: []`（注释：缺省不定时，补货制事件驱动）与 `refillTarget: 5`；`checkAmmoBlock` 中 `slots` 空数组合法（`parsed.slots = []`，`any = true`）；ranges 数组加 `["refillTarget", 0, 20]`。
  - `index.ts`：
    - `runBrowseJob` 加 `opts?: { maxPicks?: number }`，函数内 `const maxPicks = opts?.maxPicks ?? ammo.maxPicksPerRun;` 并替换两处消费点。
    - `src/external/ammo-store.ts` 的 `renderAmmoSectionOf` 改预算分家（2026-11-04 用户裁定：旧账是历史提醒，外部行是本轮可行动附件，两者不得共享预算）：`AmmoSectionBudget` 改为 `{ debtChars: number; debtCap: number }`（语义化改名，只管 debt）——debt 段按 debtChars/debtCap 机械裁决，超限丢条目不放宽（截断语义不变）；外部行独立渲染，在场且模板/ammoId 齐备即输出，不受 debt 预算与 cap 约束（自身长度由入库时标题截断与模板长度天然有界）；展示顺序不变（debt 在前、external 行最后）；同步改 `src/index.ts` 的 `renderAmmoSection` 调用点与新预算常量语义（AMMO_SECTION_CHARS/AMMO_ITEM_CAP 改为 debt 专用命名或注释说明）。
    - 新增模块级 `let lastRefillAttempt = 0;`（进程内存，重启即忘，可接受）与 `const REFILL_COOLDOWN_MS = 30 * 60_000;`、`const REFILL_SCAN_MS = 5 * 60_000;`。
    - 新增 `maybeRefillAmmo(reason)`：`refillTarget<=0` 或 `browseInFlight` 或 `Date.now()-lastRefillAttempt < REFILL_COOLDOWN_MS` 直接返回；`fish.harness.snapshot(ExternalAmmoDoc, ctx)` 读 available（`state==="available" && ttlAt > Date.now()`）计数，>0 返回；否则置 `lastRefillAttempt`、打日志 `[鱼缸] 弹药库空（${reason}），补货逛轮启动（目标 ${refillTarget} 条）`、`await runBrowseJob(\`refill-${HHmm}\`, localDay(), { maxPicks: refillTarget })`（HHmm 为当前本地时分，保证同日多次补货 runKey 不撞；runKey 仅用于 ammo_submit 单轮上限判重）。整体 try/catch，错误打 `[鱼缸] 补货逛轮失败 <message>`。
    - 挂点 a：emit 成功 markShared 处（index.ts 约 634 行 `applyAmmoShared` 成功分支后）`void maybeRefillAmmo("share").catch(() => {});`。
    - 挂点 b：worker 调度区 `externalScheduler.start()` 之后 `const refillTimer = setInterval(() => { void maybeRefillAmmo("tick").catch(() => {}); }, REFILL_SCAN_MS); refillTimer.unref?.();`
  - `prompt/runtime.md` 第 19 段：把「逛 B 站的工时轮」的触发描述改为「定时（配置了时点才跑）或弹药库空了自动触发，目标是把库存补足」一句话级措辞，其余不动。
  - `AGENTS.md` §17 B 站弹药管线段：开头「`ammo.slots`（缺省 09:00/12:00/18:00/24:00）起 worker 逛轮」改为「`ammo.slots` 定时逛轮（缺省空=不定时）+ 空库触发补货（`ammo.refillTarget` 缺省 5，0=关闭；30 分钟冷却，每 5 分钟扫描 + 分享消费后即时触发）」。
- [ ] **步骤 3：检查**
  - `npm test`：既有 ammo/config 相关测试若因缺省值变化失败，按新语义同步调整断言（属既有测试随生产改动调整）。
  - 手动验证 F3 的本地半场：`node --input-type=module -e` 断言 `AMMO_DEFAULTS.slots` 为 `[]`、`refillTarget===5`。
- [ ] **建议（待用户授权）：新增测试**
  - `maybeRefillAmmo` 的条件矩阵（空库/非空/冷却/在途/refillTarget=0）与 `runBrowseJob` maxPicks 覆盖——需把触发器抽成可注入纯函数，用户授权后再做。

---

### Task T2：下线 legacy，next 成为唯一搭话行为

**Deps：** `T1`（理由：同写 `src/fish-config.ts` 与 `src/index.ts`，串行避免 worktree 文件冲突；无接口依赖）

**WritePaths：**
- `src/qq/gate.ts`
- `src/qq/debounce.ts`（如引用 legacy 文案/注释则同步，预计零改动，仅核对）
- `src/engage-next.ts`
- `src/fish-config.ts`
- `src/index.ts`
- `prompt/messages.md`
- `prompt/runtime.md`
- `AGENTS.md`
- `test/`（gate/config/engage 相关既有测试文件）

**Resources：** `none`

**Files：**
- Modify：`src/qq/gate.ts`（100–175 行判定区、`GateOptions`/`GateDecision` 类型、文件头注释）
- Modify：`src/tools/watch/messages.json`（删 `watch_inline` key：定义在这里而非中心 messages.md；其唯一消费方 `src/index.ts:1165` 仅 legacy 分支，删引用后成孤儿，`test/prompts.test.ts:172` 会硬失败）
- Modify：`src/tools/config/TOOL.md`（22–27 行字段表删 engagement/engage(含 groups)/ambientMinIntervalSeconds/watchAmbientChance——`src/fish-config.ts:321` 注释要求两边同步）
- Modify：`.env.example`（删 30–31 行 `AMBIENT_MIN_INTERVAL_SECONDS`/`WATCH_AMBIENT_CHANCE` 模板行）
- Modify：`src/engage-next.ts`（`EngageDeps.config` 的 `engagement` 字段、tick 热切换分支约 305–325 行、文件头注释）
- Modify：`src/fish-config.ts`（`Config` 删 4 字段；`checkEngageBlock` 删或瘦身为仅 shard/closed/open 等时序字段；`CONFIG_FIELDS` 删 3 行；env/文件合并逻辑相应删）
- Modify：`src/index.ts`（`engageNextOf`/`engageGroupsSafe` 改直取 `config.groups`；`createGate` 接线删 `chances`/`ambientMinIntervalMs`/`watchedChance`；~2612–2622 行；§7 相关注释）
- Modify：`prompt/messages.md`（仅核对：`watch_inline` 不在此文件；`ctx_*` engage 文案全保留）
- Modify：`prompt/runtime.md`（自由交流窗口段删 legacy 对照措辞，若存在）
- Modify：`AGENTS.md`（§7 重写为 next-only 语义；顶部架构图「@ 必答 / 回复合集 / 特别关注 / 限流」与 §4 的 legacy/next 对照、legacy 语义零变化措辞同步清理）
- Modify：`test/gate.test.ts`（legacy 判定套件：rate_pass/rate_limited/replied_forward/forward_ignored/watched*/watched_sampled_out 用例，36–134 行）
- Modify：`test/gate-next.test.ts`（47 行起 legacy 用例、77–83「缺省=legacy」、159–180 chances 热切换用例）
- Modify：`test/prompts.test.ts`（watch_inline 孤儿兜底，随 messages.json 删除自然通过）

**接口契约：**
- Consumes：T1 后的 `fish-config` 形态（`ammo.refillTarget` 等）；`createEngageNext` 的 `groups()` 回调签名不变。
- Produces：`createGate(options: { master: string; groups: string[]; isOpen?: (chatKey: string) => boolean })`——`GateDecision` 精简为 `{ enter: true; reason: "private" | "mentioned" | "free_pass" } | { enter: false; reason: "stranger_private" | "group_not_allowed" | "next_pending" }`；`engageNext` 状态机群表 = `.env GROUPS` 全量。

**终态关联：** `F1`、`F2`、`F3`。

**验收标准：**

- [ ] **步骤 1：核对现状语义（防误删）**
  - 确认 gate 判定顺序：私聊 → 群白名单 → @ 必答 → next 分支（open=free_pass / closed=next_pending）→ 【以下全部是 legacy-only，next 下不可达】回复合集必答 → 无 @ 合集丢弃 → 限流 → 特别关注随机门 → rate_pass。删除范围 = next 分支之后全部 + `lastHandled`/`markHandled`（next 无冷却消费方）+ `chances` 回调 + `GateOptions.ambientMinIntervalMs/watchedChance/engagement`。
  - 确认合集展开逻辑在 host 消息层（不在 gate）：删 gate 的 repliedForward 判定不影响 open 窗内回复合集的展开行为（free_pass 进入后照旧走 §13 展开链）。
  - 确认 `watch_inline` 文案 key 的定义与消费：定义在 `src/tools/watch/messages.json`（不在中心 messages.md），唯一消费方 `src/index.ts` ~1160 行 legacy 分支——删引用后同步删该 key（`test/prompts.test.ts` 的「没人用的文案」检查会兜底）。
  - 确认 `src/tools/config/TOOL.md` 的字段表与 `src/fish-config.ts` 的 `CONFIG_FIELDS` 双向同步义务（321 行注释）。
- [ ] **步骤 2：实现**
  - `gate.ts`：按步骤 1 范围删除；next 分支改为唯一路径（`isOpen?.(chatKey) === true → free_pass`，否则 `next_pending`），保留私聊/白名单/@ 必答原样；文件头注释重写为 next-only 判定说明。
  - `engage-next.ts`：`config()` 返回类型删 `engagement`；tick 删 `engagement !== "next"` 的热切换停机分支；头注释更新。
  - `fish-config.ts`：`Config` 与 `CONFIG_FIELDS` 删 `engagement`、`ambientMinIntervalSeconds`、`watchAmbientChance`；`engage` 块删 `groups` 字段校验（保留 `closedMinutes`/`openMinutes`/`shardSeconds`/`windowRelaxCap`/`mentionContextSize` 等时序字段，逐一核对现字段清单后保留）；合并逻辑（`{...DEFAULTS.engagement...}` 等）同步删除；默认值表同步。
  - `index.ts`：`engageGroupsSafe()` 删除，`groups: () => config.groups.map((g) => "qq:group:" + g)`（`.env GROUPS` 直取，注意现有 `config.groups` 的类型与来源）；`engageNextOf` 恒真化或删陚全部四个调用点（gate 接线 + `src/index.ts:474` runtime 裁剪 + `:944` trackInFlight + `:1162` nextMode）；`MUST_ANSWER_REASONS` 删 `"replied_forward"`（`src/index.ts:420`）；`createEngageNext` 的 `config()` 回调删 `engagement: c.engagement`（2055 行）；`createGate` 接线删 `chances/ambientMinIntervalMs/watchedChance` 与 `dailyQuota/cooldownMs`（2609–2611 行，新签名不再需要）；相关注释（§7 描述）更新。
  - `.env.example` 删两行模板（30–31 行），与 `parseEnv` 删除保持同步（§9 精神）。
  - 文案：`prompt/runtime.md`/`messages.md` 删 legacy-only 措辞；`AGENTS.md` §7 重写：判定 = 私聊只认主人；群白名单（GROUPS）；@ 必答；非 @ 按窗（closed=next_pending，open=free_pass 非必答）；@ 轮背景 5 条去重、整组合并、宵禁二态、弹药三件套、watch 在 next 下的作用（@ 白名单/标记）全部保留——以现有 §7 的 next 段落为底稿改写，删 legacy 对照。
  - 测试：gate 测试改为 next-only 断言（私聊/白名单/@/两态各保留；rate_limited/watched*/replied_forward/forward_ignored/rate_pass 用例删除）；config 测试删三字段用例；engage-next 测试删热切换用例；`npm test` 迭代到全绿。
- [ ] **步骤 3：检查**
  - `npm test` 全绿；`npm run prompts` 无意外条目（watch_inline 删除后清单一致）。测试影响面（真实文件）：`test/gate.test.ts`、`test/gate-next.test.ts`、`test/prompts.test.ts`——`test/` 下无 config/engage 命名的测试文件，勿按图索骥。
- [ ] **建议（待用户授权）：新增测试**
  - gate 的 next-only 判定矩阵快照（三群 × 两态 × @/非 @）。

---

### Task T3：mini 配置迁移 + 部署 + 线上验证

**Deps：** `T2`（理由：消费 T1+T2 最终代码；部署内容含两者）

**WritePaths：**
- `docs/plans/2026-11-04-engage-next-only-ammo-refill.run.md`（运行记录：部署横幅、三群启动行、news 验证原文与时间戳——F2/F4 的证据位置）
- （远程）mini `~/yugang/.env`、`~/yugang/fish.config.json`

**Resources：** mini SSH 连接（`/Users/mhbzhy/.agents/skills/home-connect/SKILL.md`，执行前必须先 read 该 skill 并用 `scripts/connect.sh --` 执行远程命令；禁止自拼 ssh）；部署窗口避开整点新闻播报（10:30 触发前后 10 分钟不部署）。

**接口契约：**
- Consumes：T1+T2 代码（已 push 到 main）。
- Produces：线上三群 next 运行、补货制生效、F2/F4 验证证据。

**终态关联：** `F2`、`F4`、`F5`。

**验收标准：**

- [ ] **步骤 1：改 mini 配置**
  - `.env`：`GROUPS=659976571,184875934,174408629`（只改这一行）。
  - `fish.config.json`：删除 `engagement`、`engage`（整块——groups 已下线，若块内无其它字段；若保留时序字段则只删 `groups` 数组，以 T2 实际保留的字段为准）、`ambientMinIntervalSeconds`、`watchAmbientChance`；`ammo` 块设 `"slots": []`（`refillTarget` 缺省 5 不必显式写）。改前备份两文件（`*.bak-20261104-*`）。
- [ ] **步骤 2：部署**
  - `cd ~/yugang && export PATH=/opt/homebrew/bin:$PATH && npm run deploy`（经 connect.sh），确认横幅「已连接」+ 工具清单正常。
- [ ] **步骤 3：验证 F2/F4**
  - `grep "搭话开窗 next 启动" var/fish-console.log | tail -5` → 三群各一行（部署一次启动即连续打三行，tail -5 内三群齐备即为本次部署产物；旧 boot 只含两群，174408629 的出现必然来自新 boot）。
  - `python3 -c "import json;print(json.load(open('fish.config.json'))['news'])"` → `{'targetGroup': '659976571'}`。
  - 观察项 F5（不阻塞终态）：之后任意时点 `grep 补货逛轮 var/fish-console.log`，弹药空时自动出现。
- [ ] **停止条件**：部署后横幅 8 秒未出、或三群启动行缺一、或 config loader 告警异常 → **停止并上报**，恢复 `*.bak-20261104-*` 配置备份即止；**不动 main 分支，不自行 git revert/push**，回滚等用户决策。

<!-- goal-runtime-contract:start -->
```json
{
  "schema": "goal-runtime.plan.v1",
  "objective": "下线 engagement 开关使 next 成为唯一搭话行为（GROUPS 即边界、崩坏狗窝一并启用），弹药库改为空库自动补货到 5 的事件驱动模式，新闻播报维持仅 659976571",
  "constraints": [
    "不改动新闻管线行为与配置（news.targetGroup 保持 659976571）",
    "模型可见文字只来自 prompt/ 与工具包四件套；src/ 内不得出现 ≥12 汉字 prompt 字面量",
    "未经用户明确授权不新增测试文件；既有测试可随生产改动同步调整",
    "不默认 git commit；提交仅在用户授权时按 git-commit-convention 执行",
    "mini 操作必须经 home-connect skill 的 scripts/connect.sh，禁止自拼 ssh",
    "engage 配置块保留时序字段（closedMinutes/openMinutes/shardSeconds 等），只删 groups"
  ],
  "resources": [],
  "checks": [
    {
      "id": "F1",
      "statement": "全仓测试通过（legacy 删除与补货制改造后 npm test 全绿）",
      "command": {
        "executable": "npm",
        "args": [
          "test"
        ],
        "timeoutSeconds": 300
      },
      "repairTaskIds": [
        "T1",
        "T2"
      ]
    },
    {
      "id": "F3",
      "statement": "配置语义正确：AMMO_DEFAULTS.slots 为空、refillTarget 缺省 5、legacy 四字段不往配置面出现（engage 块保留时序字段只删 groups），且 runBrowseJob 缺省路径取 ammo.maxPicksPerRun",
      "command": {
        "executable": "bash",
        "args": [
          "-lc",
          "cd /Users/mhbzhy/yugang && node --input-type=module -e 'import { writeFileSync, mkdtempSync } from \"node:fs\"; import { AMMO_DEFAULTS, createConfigLoader } from \"./src/fish-config.ts\"; const d = mkdtempSync(\"/tmp/yg-cfg-\"); writeFileSync(d + \"/fish.config.json\", \"{}\"); const c = createConfigLoader({ path: d + \"/fish.config.json\", env: {} }).config; console.log(JSON.stringify({ slots: AMMO_DEFAULTS.slots.length, refill: AMMO_DEFAULTS.refillTarget, hasEngagement: \"engagement\" in c, hasEngageGroups: (\"engage\" in c) && (\"groups\" in c.engage), hasAmbient: \"ambientMinIntervalSeconds\" in c, hasWatch: \"watchAmbientChance\" in c }));' | tail -1 | grep -q '{\"slots\":0,\"refill\":5,\"hasEngagement\":false,\"hasEngageGroups\":false,\"hasAmbient\":false,\"hasWatch\":false}' && grep -q 'opts?.maxPicks ?? ammo.maxPicksPerRun' src/index.ts"
        ],
        "timeoutSeconds": 60
      },
      "repairTaskIds": [
        "T1",
        "T2"
      ]
    },
    {
      "id": "F2",
      "statement": "部署后三群（659976571/184875934/174408629）next 启动行齐备（单次启动连续三行为准，旧 boot 只有双群）",
      "command": {
        "executable": "bash",
        "args": [
          "-lc",
          "S=/Users/mhbzhy/.agents/skills/home-connect; $S/scripts/connect.sh mac -- 'cd ~/yugang && grep \"搭话开窗 next 启动\" var/fish-console.log | tail -5' | grep -v -E 'WARNING|post-quantum|decrypt|upgraded' | { ok=1; for g in 659976571 184875934 174408629; do grep -q \"$g\" || ok=0; done; [ \"$ok\" = 1 ]; }"
        ],
        "timeoutSeconds": 120
      },
      "repairTaskIds": [
        "T3"
      ]
    },
    {
      "id": "F4",
      "statement": "新闻目标群仍为 659976571",
      "command": {
        "executable": "bash",
        "args": [
          "-lc",
          "S=/Users/mhbzhy/.agents/skills/home-connect; $S/scripts/connect.sh mac -- 'cd ~/yugang && python3 -c \"import json;print(json.load(open(\\\"fish.config.json\\\"))[\\\"news\\\"][\\\"targetGroup\\\"] )\"' | grep -v -E 'WARNING|post-quantum|decrypt|upgraded' | grep -q 659976571"
        ],
        "timeoutSeconds": 120
      },
      "repairTaskIds": [
        "T3"
      ]
    }
  ],
  "tasks": [
    {
      "id": "T1",
      "agent": "executor",
      "task": "依据 docs/plans/2026-11-04-engage-next-only-ammo-refill.md 的 Task T1 实现弹药库事件驱动补货：修改 src/fish-config.ts（AmmoConfig 加 refillTarget 0–20 缺省 5、AMMO_DEFAULTS.slots 改 []、checkAmmoBlock 空数组合法并把 refillTarget 纳入 ranges 与 known）、src/index.ts（runBrowseJob 加 opts?.maxPicks 覆盖 prompt {{max}} 与 triggerOf.workerRun.maxPicks 两处消费点，缺省路径保持 opts?.maxPicks ?? ammo.maxPicksPerRun；新增 maybeRefillAmmo(reason) 触发器：refillTarget<=0/browseInFlight/30 分钟冷却任一命中即返回，snapshot ExternalAmmoDoc 数 available（state==available 且 ttlAt>now），>0 返回，=0 则置 lastRefillAttempt 并以 runKey refill-<HHmm> 与 localDay 起 runBrowseJob(maxPicks=refillTarget)，整体不抛错；挂点 a=emit 成功 markShared 后 fire-and-forget，挂点 b=externalScheduler.start() 后 setInterval 5 分钟 unref）、src/external/ammo-store.ts 的 renderAmmoSectionOf 改预算分家（AmmoSectionBudget 改 { debtChars, debtCap } 只管 debt：超限丢条目截断语义不变；外部行独立渲染不受 debt 预算与 cap 约束；同步改 index.ts 调用点与预算常量语义；展示顺序不变）；prompt/runtime.md 外部段触发措辞、AGENTS.md §17 补货描述（含失败空转重试节奏提示）。输入为本计划 T1 全文；发现与计划冲突的既有行为时停止并上报，不越界写入。",
      "deps": [],
      "writePaths": [
        "src/fish-config.ts",
        "src/index.ts",
        "src/external/ammo-store.ts",
        "prompt/messages.md",
        "prompt/runtime.md",
        "AGENTS.md"
      ],
      "resources": [],
      "acceptance": {
        "criteria": [
          "npm test 全绿",
          "AMMO_DEFAULTS.slots 为 [] 且 refillTarget 为 5",
          "runBrowseJob 缺省路径取 ammo.maxPicksPerRun（F3 内源码断言覆盖）",
          "renderAmmoSectionOf 预算分家：外部行在场必渲染且不受 debt 预算/cap 影响；debt 超限截断语义不变"
        ]
      },
      "checkIds": [
        "F1",
        "F3"
      ]
    },
    {
      "id": "T2",
      "agent": "delegate",
      "task": "依据 docs/plans/2026-11-04-engage-next-only-ammo-refill.md 的 Task T2 下线 legacy：src/qq/gate.ts 删 next 分支之后的全部 legacy 判定（replied_forward/forward_ignored/限流/特别关注随机门/rate_pass）与 lastHandled/markHandled/chances/ambientMinIntervalMs/watchedChance/engagement/dailyQuota/cooldownMs 选项，GateDecision 精简为 private|mentioned|free_pass / stranger_private|group_not_allowed|next_pending；src/engage-next.ts 删 config().engagement 与热切换分支；src/fish-config.ts 删 engagement/engage.groups/ambientMinIntervalSeconds/watchAmbientChance 四字段与 env 模板解析（engage 块保留时序字段，先核对现字段清单）；src/index.ts 删 engageGroupsSafe、engageNextOf 四个调用点（gate 接线/474/944/1162）、MUST_ANSWER_REASONS 的 replied_forward（约 420 行）、config() 回调 engagement 字段（约 2055 行）、createGate 接线三参与 dailyQuota/cooldownMs（约 2609–2611）、groups() 直取 config.groups、watch_inline 引用（约 1165 行）；src/tools/watch/messages.json 删 watch_inline key（定义在此文件而非中心 messages.md）；src/tools/config/TOOL.md 字段表同步删四字段；.env.example 删两行模板；prompt/runtime.md 与 AGENTS.md（§7 重写为 next-only + 顶部架构图与 §4 legacy 对照措辞清理）；既有测试仅涉及 test/gate.test.ts、test/gate-next.test.ts、test/prompts.test.ts，按 next-only 语义调整删除 legacy 用例（test/ 下无 config/engage 命名的测试文件）。语义红线：@ 必答、私聊只认主人、GROUPS 白名单、open/closed 两态行为零变化；合集展开在 onebot 解析层不受影响。npm test 与 npm run prompts 全绿。发现行为歧义或需越界写入时停止并上报。",
      "deps": [
        "T1"
      ],
      "writePaths": [
        "src/qq/gate.ts",
        "src/qq/debounce.ts",
        "src/engage-next.ts",
        "src/fish-config.ts",
        "src/index.ts",
        "src/tools/watch/messages.json",
        "src/tools/config/TOOL.md",
        ".env.example",
        "prompt/messages.md",
        "prompt/runtime.md",
        "AGENTS.md",
        "test/gate.test.ts",
        "test/gate-next.test.ts",
        "test/prompts.test.ts"
      ],
      "resources": [],
      "acceptance": {
        "criteria": [
          "npm test 全绿且无 legacy 用例残留",
          "npm run prompts 清单无 watch_inline 等孤儿 key",
          "gate 判定矩阵：私聊/白名单/@ 必答/open free_pass/closed next_pending 与改前 next 行为一致"
        ]
      },
      "checkIds": [
        "F1",
        "F3"
      ]
    },
    {
      "id": "T3",
      "agent": "delegate",
      "task": "依据 docs/plans/2026-11-04-engage-next-only-ammo-refill.md 的 Task T3 完成 mini 配置迁移与部署验证。必须先 read /Users/mhbzhy/.agents/skills/home-connect/SKILL.md 并只用其 scripts/connect.sh -- 执行远程命令：备份后改 ~/yugang/.env 的 GROUPS=659976571,184875934,174408629 与 fish.config.json（删 engagement/engage.groups/ambientMinIntervalSeconds/watchAmbientChance、ammo.slots=[]，engage 块以 T2 实际保留的时序字段为准），然后 npm run deploy（PATH 加 /opt/homebrew/bin），验证部署横幅、三群「搭话开窗 next 启动」行、news.targetGroup=659976571。部署窗口避开 10:30 前后 10 分钟。横幅 8 秒未出或三群缺一或 loader 告警异常即停止上报，恢复 *.bak 配置备份即止，不动 main 分支不自行 revert/push，回滚等用户决策。F5（空库补货触发）为部署后观察项：弹药空时日志出现「补货逛轮」行，不阻塞终态。T1/T2 的 commit 需用户授权后按 git-commit-convention 提交并 push，再部署。 产物：把部署横幅、三群启动行、news 验证原文与时间戳写入 docs/plans/2026-11-04-engage-next-only-ammo-refill.run.md（运行记录，F2/F4 的证据位置）。",
      "deps": [
        "T1",
        "T2"
      ],
      "writePaths": [
        "docs/plans/2026-11-04-engage-next-only-ammo-refill.run.md"
      ],
      "resources": [],
      "acceptance": {
        "criteria": [
          "部署横幅正常且工具清单完整",
          "三群 next 启动行齐备",
          "news.targetGroup 仍为 659976571"
        ]
      },
      "checkIds": [
        "F2",
        "F4"
      ]
    }
  ],
  "terminalCheckIds": [
    "F1",
    "F2",
    "F3",
    "F4"
  ]
}
```
<!-- goal-runtime-contract:end -->
