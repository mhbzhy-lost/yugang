# 计划 v2：只保留自由会话模式（开窗两态退役）+ @ 轮背景可控化

日期：2026-11-06 · 状态：执行中（T1 已完成）· 本版吸收独立 review 的全部「必须修正」
v2 → v2.1 关键裁定（主人 2026-11-06）：**flag（lastSeenByModel）无条件推满**——每次实际注入群消息的唤醒轮结束都推进到 recent 末条，不受 answerContextSize 影响；纯输出任务轮（browse/remind/news）不推。review 的时序问题随之消解为「设计内丢弃」；answer/ambient 背景装配期竞态窗口最坏一次重复注入，记录为已知限制。

## 一、整体交付终态

只有一个搭话机制：自由活动模式。所有 GROUPS 群恒自由拍（freeSeconds 一拍合并全部发送者非 @ 消息）；@ 恒走 10 秒必答；空拍掷 freeBrowseChance 起主动轮；夜里不起 ambient 轮。

### F1（AUTO）开窗两态代码全部移除
- 条件：以下符号在 src/ 与 scripts/ 中无生产消费（测试/verify 脚本自身除外）：closedMinutes、openMinutes、shardSeconds、windowSize、windowRelaxCap、silenceThreshold、mentionContextSize、engageBacklogOf、submitInjectionRound、enterClosed、enterOpen、scheduleShard、handOffToWindow、onPhase、backlogOf、freeGroups、freeGroupOf、freeGroupsSafe、freeGroupsOutsideEnv、freeModeOf、isOpen、freeCurfew、EngagePhase、EngageBacklogItem、lastCloseSeq、noteExit、silenceOf、shareGateOf、ammoShareChance、browseChance、shareChance、WINDOW_SECTION_PREFIX、`"win-"` 前缀（windowId 本身保留——自由拍 `free-` 前缀在用）。`next_pending` 保留（无 @ 合集仍用）。engage-mode 简化为 `free | legacy`。
- 验证：单条 grep 脚本（见 §五）逐符号断言无匹配；`npm test` 全绿 + `node scripts/verify-free-mode.ts` 通过。
- 覆盖：T1✓（已完成）、T2、T3、T5。

### F2（AUTO）@ 轮背景可控化（answerContextSize）+ flag 无条件推满
- **flag 推进规则（主人裁定，不受任何配置影响）**：每次唤醒轮（answer/ambient/自主轮，一切进模型输入的轮）结束，`lastSeenByModel` 无条件推进到 recent 末条（最新消息）——不管本轮背景实际注入了多少。被背景截断跳过的未读视为已读丢弃。
- **背景注入由 `engage.answerContextSize` 控制**：不设 = 补到 flag 之前的全部未读（`(seenSeq, anchorSeq)`）；设 N = 锚点前最近 N 条、再剔已读。
- 由此 review 的三个时序问题全部消解：① 推满是设计意图，锚点后消息不再有第二次注入机会；② 提交期竞态无害化（最坏单次重复注入，窗口极小）；③ 收集器/recent 溢出变为设计内丢弃，有损点两处（freeBatchMax 丢最旧 + answerContextSize 截断外的未读），都记入风险。
- free 拍（submitShardRound）的 fresh 过滤沿用 flag：flag 已推满，收集器中 ≤ flag 的全部剔掉（不重复注入）。
- 实现简化：answer 轮在 submitRound 收尾 `advanceSeenSeq(conv.id, recent 末条 seq)`；submitShardRound/自主轮同规则推满。不再需要临界区改造。
- 验证：新增时序测试（待授权）+ 既有测试同步；local-driver.ts 的 `backgroundLimit: 0` 语义同步。
- 覆盖：T4、T7。

### F3（AUTO）宵禁语义 = 夜间不主动起 ambient 轮
- **语义修正**（review #4）：宵禁（00:00–08:00）拦截的是「free 拍提交」与「自主门」两处（freeBeat 层面），不是 gate 层——夜间 @ 必答照常、被并入 @ 组的 follow-up 照常、无 @ 合集仍 `next_pending`（不误标 curfew）、@ 轮全量背景**包含**夜间 recent 流水（夜里群里说的话，白天 @ 时作为背景可见——它们本来就没进过模型）。理由：@ 必答与背景补充是「应答」，不是「主动搭话」。
- 实现：freeBeat 开头判 isCurfewAt → 有消息也不提交（消息留收集器顺延到早上 8 点后第一拍；注意收集器在拍间可能超 freeBatchMax 丢最旧——夜间高流量群的可接受损耗，记入风险）；掷门处恒关（现状）。gate 层删除 freeCurfew 依赖。
- 验证：gate 断言更新（夜间 @ → mentioned 放行；夜间非 @ 消息不再有 curfew 原因——它们照常进收集器，只是不提交）。
- 覆盖：T3、T7。

### F4（AUTO）配置面收敛
- engage 只剩：freeSeconds（15–300，缺省 60）/ freeBrowseChance（0–1，缺省 0.03）/ freeBatchMax（1–200，缺省 50）/ answerContextSize（1–100，可选；不设=全量到 flag）。
- `video` 块的 browseChance 废弃：VideoConfig 删字段、checkVideoBlock 同步、fish.config.example、config TOOL.md、mini 配置迁移（T8）。video 块剩余字段（dailyBudget 等）不动。
- ammo.shareChance 兼容字段一并删（宿主已不消费）。
- prompt/runtime.md：删「自由交流窗口」段，**末条自言规则内联进「自由活动群」段**（review #5：原 free 段写「规则同上」，删窗口段后悬空），段名与「全部白名单群」表述适配。
- 覆盖：T5、T6。

### F5（AUTO）测试与权威矩阵同步
- 删除/改写清单：gate.test.ts 开窗两态用例 → 自由拍语义；gate-next.test.ts closed 断言；model-input-templates.test.ts 的 `triggerOpenInjection`/`open_injection` scene（真实入口已消失，删除该 scene）、`triggerOpenShard` → freeOf 驱动、`triggerBrowseEmpty` → 空拍驱动；权威矩阵 15→14（AUTHORITATIVE_SCENE_COUNT 校正，decisions 文档同步）；debounce.test.ts:130-144 上限断言适配新语义；verify-free-mode.ts 按 review 建议重写（F1 域校验改为「所有 GROUPS 群都是 free」、F2 相位断言删除、F3 保留、F5 开窗兼容删、F8 next 分支删、F9 改写）。
- **新增测试（待主人授权）**：① @ 轮 answerContextSize 两态（全量到 flag / 固定 N 剔已读）+ flag 只推到注入集；② 收集器被 @ 轮消费后不重复注入；③ 宵禁拍不提交但消息保留。落点：新建 test/engage-free.test.ts 或并入既有文件。
- 覆盖：T7。

### F6（MANUAL）文档审阅 —— 主人过目
- 范围（review #10 全清单）：AGENTS.md 顶部消息链 L10、第 7 节全部开窗表述、出口 @ 规则 L143-145、外部信息源 L472-473（video.browseChance）；ops SKILL.md L144（@ 背景最多 10 条 → 新语义）、L148-163 自由模式段；prompt/messages.md L134-139（open 空窗与 video.browseChance 表述）；docs/decisions/2026-11-04 矩阵注记。
- 覆盖：T6。

### F7（MANUAL）部署与群收缩
- mini `.env` GROUPS → 只剩 659976571；mini fish.config.json engage 块改新字段集 + video.browseChance 删除 + ammo.shareChance 删除（避免启动告警）；`fish.sh deploy` + 横幅确认。
- **T8 前核对**（review 建议 #6）：news 目标群若被移出 GROUPS 会跳过（确认 news.targetGroup 是否=搬史群或接受停播）；其他群的旧 remind 到期仍可能发（不重过群闸）——收缩前用 `npm run memory` 侧工具或 SQL 核对 fish.reminders 清单，主人确认后清掉非搬史群的存量提醒。
- 覆盖：T8。

### 停滞判据
同一 F 项连续 2 轮验证输出无实质变化即判停滞，停下报告。

## 二、任务拆分（v2 调整）

| 任务 | 状态 | 依赖 | 预算 |
|------|------|------|------|
| T1 状态机瘦身 | **✅ 完成**（engage-next.ts 已重写 free-only 290 行） | — | — |
| T2 runtime 接线收敛：删 engageBacklogOf/submitInjectionRound/freeModeOf/engage-mode 简化/recentCap 回 30/createEngageNext deps 缩减；删 videoBrowseGateOf 死接线 | ✅ 完成 | T1✓ | — |
| T3 gate 简化（删 isOpen/freeCurfew）+ 宵禁改 freeBeat 层拦截（拍内不提交不掷门） | ✅ 完成 | T2✓ | — |
| T4 @ 轮可控化：debounce backgroundLimit（undefined=全量）+ answerContextSize 接线 + flag 无条件推满（flushBurst/submitShardRound 推到 recent 末条）+ local-driver 清理 | ✅ 完成 | T2✓ | — |
| T5 配置面：fish-config 字段集（含 answerContextSize）/config 工具/example/TOOL.md/video.browseChance+ammo.shareChance 退役 | ✅ 完成 | T2✓ | — |
| T6 prompt + 文档全清单（runtime.md 段内联、messages.md、AGENTS、ops、README、decisions） | ✅ 完成 | T1-T5✓ | — |
| T7a 既有测试与矩阵（gate/gate-next/debounce/templates/权威矩阵 15→14） | ✅ 完成 | T6✓ | — |
| T7b verify-free-mode.ts 重写（F1-F10 全部新语义） | ✅ 完成 | T7a✓ | — |
| T7c 新增时序测试 test/engage-free.test.ts（主人已授权） | ✅ 完成 | T7a✓ | — |
| T8 部署 + 群收缩 + remind 存量核对 | 待做 | T7 全绿 + 主人确认 | 20min |

## 三、调度
串行 T2 → T3 → T4 → T5 → T6 → T7 →（主人确认）→ T8。

## 四、执行模式
主会话串行（主人已选定）。

## 五、验证命令（v2：失败即非零）

```bash
npm test && node scripts/verify-free-mode.ts && bash -c '
bad=0
for sym in closedMinutes openMinutes shardSeconds windowSize windowRelaxCap silenceThreshold mentionContextSize engageBacklogOf submitInjectionRound enterClosed enterOpen scheduleShard handOffToWindow onPhase backlogOf freeGroups freeGroupOf freeGroupsSafe freeGroupsOutsideEnv freeModeOf freeCurfew EngagePhase EngageBacklogItem lastCloseSeq noteExit silenceOf shareGateOf ammoShareChance browseChance shareChance WINDOW_SECTION_PREFIX "win-"; do
  grep -rn "$sym" src/ scripts/ --include="*.ts" | grep -v "test/" | grep -v "scripts/verify-free-mode" >/dev/null && { echo "残留: $sym"; bad=1; }
done
exit $bad'
```

## 六、风险与决策记录（v2 增补）
- **@ 轮成本上升**：背景从默认 5 条到最多 30 条（recent 容量），输入 token 与换页频率上升；answerContextSize 设 N 可压回。记为预期行为变化。
- **flag 无条件推满的设计内丢弃**（主人裁定）：① answerContextSize 截断外的未读；② answer 锚点之后、提交期间新到的消息；③ ambient 提交期间新到的消息；④ 被 freeBatchMax 挤出收集器或挤出 recent 的消息——全部视为已读，不再有第二次注入机会。
- **已知限制**：answer 轮背景装配期（数秒）free 拍可能插队提交，最坏造成一次重复注入（无丢失，pi 层串行排队兜底）；不做深改。
- **夜间收集器积压**：宵禁不提交但照收，早上 8 点第一拍可能很大（超 freeBatchMax 丢最旧）；可接受。
- **remind 跨群存量**：T8 前核对清理。
- freeBatchMax 丢最旧是收集器防爆闸；answerContextSize 设 N 时截断外的未读按主人裁定视为已读丢弃——两处有损点，均为设计内。
- 重启丢弃在途拍（宁少勿答旧话）——不变。
