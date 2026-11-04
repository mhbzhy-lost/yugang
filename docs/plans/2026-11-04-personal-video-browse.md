# 每条鱼自主浏览视频并即时分享实现计划

> **执行状态（2026-11-04）：已合并，不独立执行。** 本计划的自主浏览、私有视频池、即时分享、ammo 停用与验证范围已全部并入 `docs/plans/2026-11-04-model-input-templates.md`。后者是唯一可派发实施计划；本文件仅保留设计拆分参考，不得与主计划并行或先后重复执行。任何行为、任务顺序、写路径或验收冲突均以主计划及其决策文档 `docs/decisions/2026-11-04-model-input-templates.md` 为准。
>
> 范围映射：本文件 T1–T2 的 gate/open/配置归主计划 T3，视频池归主计划 T4；本文件 T3–T4 归主计划 T4；本文件 T5 的停用与文案收口归主计划 T3、T6；本文件 T6 的配置说明归主计划 T3，独立机械测试归主计划 T7，终验归主计划 T8。下文 DAG、Waves、任务和终态不再构成独立执行授权。

> **给执行 agent：** 本文件不可直接执行；请改用上述主计划。主计划要求逐任务执行，步骤使用 `- [ ]` 复选框跟踪；只有主计划整体交付终态全部验证通过，才算合并范围执行完成。

**目标：** 停用全局弹药库和定时逛轮，改为每个（群 × 当前人格）会话在 open 窗内经过 0.3 随机门后自行选题、看视频、按自身判断写入私有视频池并立即分享，避免不同群抢同一条视频。

**架构：** 保留现有弹药库、worker、claim/shared 和 `ammo_*` 源码作为暂不启用的兼容代码，但从工具注册、运行时调度、模型可见 prompt 和模型可见 Schema 中移除。`engage-next` 在每个 open 窗进入时一次掷自主浏览门；门开时随机四个既有 topic 之一，并只给该窗选中的会话注入一个带 `browseWindow` 标记的自主浏览轮。会话使用 `fish.video_pool` session doc，以 conversationId（群 × 人格）隔离；模型实际看过的视频才允许通过文字出口原子写入该池并附 canonical B 站链接发送。

**技术栈：** TypeScript、pi-durable session doc / transaction、现有 `engage-next` 状态机、`bili-client`、工具包 manifest、现有 outbox 出口。

## 全局约束

- 弹药库机制代码不删除，但不注册 `ammo_list` / `ammo_submit`，不启动 worker、scheduler 补货、手动 ammo 入口和全局弹药分享链。
- 模型能看到的共享文案只能来自 `prompt/`；工具说明、Schema 和工具专属文案只能来自对应 `src/tools/<name>/TOOL.md`、`schema.json`、`messages.json`。
- 不在 `src/` 内嵌大段模型文案；模板变量严格替换；新增能力按工具包契约注册。
- 所有外发继续只走 `say_*` 和 outbox，不得在视频浏览工具中直接调用 QQ emit。
- 每个群 × 当前人格会话独立拥有视频池；不同会话不得共享视频池，也不得因为同一 BV 互相 claim 或阻塞。
- B 站标题、简介、评论、弹幕和画面描述仍按现有外部不可信文本边界清洗；模型不能提供 canonical URL，链接由宿主根据已核验 BV 拼接。
- 0.3 门只在 open 窗进入时掷一次；只有宿主钉上当前 `browseWindow` 的 open injection 轮能启动自主浏览，普通 ambient shard 轮即使处于 open 也不能启动；门开后同一 browse 轮继续看候选不再重新掷门。门关闭或非 open 窗不得启动自主浏览。
- 既有测试只运行和修复与本次行为直接相关的回归；未经用户明确授权，不新增测试或新 fixture，不提交、不部署。
- 实现后必须运行 `npm run prompts` 和 `npm test`；生产 macmini 的配置、数据库、进程和部署不在本计划内。

## 整体交付终态

| ID | 必须成立的条件 | 验证方法与环境 | 通过判据 | 证据位置 | 覆盖任务 |
| --- | --- | --- | --- | --- | --- |
| F1 | `ammo_list` / `ammo_submit` 不进入任何模型工具面，worker 定时逛轮、空库补货和主人手动 ammo 入口不再启动；旧实现文件仍存在 | 本地 `npm run prompts`；源码静态核对 `src/tools/loader.ts`、`src/index.ts`；既有工具面测试 | 工具目录/工具注册/`tool_catalog` 无 ammo 工具；启动路径没有 scheduler/refill/manual ammo 实际调用；旧 `src/external/ammo-store.ts` 等文件仍在 | `npm run prompts` 输出与源码 diff | T5、T6 |
| F2 | 每个 open 窗最多一次 0.3 自主浏览门；门开时随机得到四个既有 topic 之一，并只在带 `browseWindow` 标记的 open injection 轮注入当前会话；门关闭不注入 | `createEngageNext` 的注入时钟/RNG 内联验证；源码核对 | 同一 open 窗 gate/topic 稳定；topic 属于 `二次元/游戏/军事/数码`；ambient shard 没有 browseWindow；不出现跨群/跨会话共享 gate | `src/engage-next.ts`、`src/index.ts`、`src/tools/types.ts` | T1、T2 |
| F3 | 自主浏览只发生在 open injection browse 轮，会话本身调用候选/看视频工具；模型可以在同一 browseWindow 内连续跳过候选并继续看下一个 | 工具执行路径核对；现有工具回归；必要时运行手工 faux round | 非 open、非 browse injection、门未开或 browseWindow 不匹配的浏览调用返回 tool error；同一 browse round 允许连续候选查看；普通用户发来视频的既有 `video` 行为不被破坏 | `src/tools/bili_hot/tool.ts`、`src/tools/video/tool.ts`、`src/tools/types.ts`、对应 TOOL.md | T1、T3、T6 |
| F4 | 只有当前会话实际看过且模型选择的 BV 才能写入该会话视频池并立即发出；写入和 outbox 入队事务一致 | 纯函数/事务代码核对；`npm test` | `fish.video_pool` 按 conversationId 隔离；重复 BV 在同一池被去重；发送 payload 使用宿主拼接的 canonical B 站 URL；不经过全局 claim | `src/external/video-pool.ts`、`src/tools/say_words/tool.ts`、outbox entry | T3、T4 |
| F5 | 末条自言禁言把自主视频分享认作合法素材分享；普通闲聊仍按原规则；夜间规则不被 ammo 文案污染 | prompt 审查、出口代码核对、`npm run prompts` | `videoBvid`/等价新字段可通过 share 校验；无新消息时不能用普通文字绕过；系统指令不出现弹药库、ammoId、worker 收弹药等内容 | `prompt/runtime.md`、`prompt/messages.md`、say 工具 manifest | T4、T5 |
| F6 | 既有非视频功能和新闻播报不因停用弹药而失效 | `npm test`、源码核对新闻 scheduler 接线 | 新闻 job 仍独立注册/运行；B 站公共客户端、普通 `video` 输入、say/outbox 基础行为保持 | 测试结果与 diff | T2、T4、T6 |

**完成规则：** 所有必要条件同时满足，且验证证据对应当前交付版本，才能标记计划执行完成；仅完成任务步骤不能替代终态验证。

**未满足时：** 在已授权范围内持续 `fix → test（验证）→ 对照终态`，修复后重验受影响条件；真实阻塞记录为未完成，并写明恢复下一步。

## 关键语义裁定

1. **“每条鱼”定义为 conversationId**：即一个群与当前人格的唯一会话；人格切换后进入另一会话，视频池不混用。浏览授权还必须绑定宿主为该 conversationId 注入的 `browseWindow`，不能只凭群级 open 状态放行。
2. **视频池是已看且已选择的视频历史/去重池**：保存 BV、清洗后的标题、鱼的推荐语、topic、时间和状态；不建立跨群可消费库存，不做 claim 竞争。
3. **即时分享采用一次原子动作**：`say_words` 携带新的视频分享字段时，在同一事务中核对当前轮是带有效 `browseWindow` 的 open injection browse 轮、核对 BV 已在当前轮被 video 工具成功查看、写入当前 conversation 的视频池、生成 canonical URL 并入队；发送成功仍由既有 drain 负责完成。
4. **“继续看下一个”由同一模型轮完成**：候选发现和看视频调用均消耗真实 B 站请求预算；为防无限刷，使用 `video.browseMaxViewsPerRound`（默认 5）作为仅自主浏览轮的机械上限，普通用户视频查看仍保持原一轮一次限制。
5. **0.3 默认值迁移到 `video.browseChance`**：旧 `ammo.shareChance` 保留解析兼容但不再驱动行为；`ammo.dailyBudget` 迁移为 active 的 `video.dailyBudget`（默认 60，兼容读取旧值避免静默丢失配置）；自主浏览 topic 固定沿用四项 `二次元/游戏/军事/数码`，不作为模型可改词表。

## DAG

```text
T1（自主浏览 gate / video pool 接口契约）
 ├──> T2（配置、开窗状态和 open 注入）
 ├──> T3（候选/看视频工具与会话池接线）
 └──> T4（say_words 原子保存并分享）
T2 ───> T3
T3 ───> T4
T4 ───> T5（停用 ammo 工具面和模型文案）
T2、T4、T5 ───> T6（prompt/测试/最终验证）
```

## Waves

- Wave 1：T1（无前置，确定接口与数据边界）
- Wave 2：T2（依赖 T1；实现 gate、topic、配置和 open 注入）
- Wave 3：T3（依赖 T1、T2；实现会话池读写接线和连续查看）
- Wave 4：T4（依赖 T1、T3；实现原子保存与即时分享）
- Wave 5：T5（依赖 T4；移除 ammo 注册、调度和模型可见文案）
- Wave 6：T6（依赖 T2、T4、T5；审查 prompt、运行既有检查并记录阻塞）

**关键路径：** T1 → T2 → T3 → T4 → T5 → T6。

---

### Task 1：自主浏览 gate 与会话视频池接口契约

**Deps：** `none`

**WritePaths：**
- `src/external/video-pool.ts`
- `src/external/video-browse.ts`
- `src/tools/types.ts`

**Resources：** `none`

**Files：**
- Create：`src/external/video-pool.ts`，定义四 topic、`fish.video_pool` session doc、BV/标题/推荐语/topic 的清洗与去重纯函数、canonical URL 辅助函数。
- Create：`src/external/video-browse.ts`，定义宿主 gate 接口、当前 open 窗 topic、当前轮已查看 BV 的登记/查询和会话级清理接口。
- Modify：`src/tools/types.ts: RoundKind/RoundTrigger`，保留旧 worker 类型兼容但新增自主浏览轮上下文的类型说明，不再把视频浏览绑定到 worker。

**接口契约：**
- Consumes：现有 conversationId、`EngagePhase`、`BiliVideoCard` 清洗边界和 pi-durable `defineDoc`。
- Produces：`VideoPoolDoc`、`VIDEO_TOPICS`、`videoUrlOf(bvid)`、`applyVideoPoolAdd`；`VideoBrowseGate={windowId,topic,open}`；`wireVideoBrowseHost`、`videoBrowseGateOf`、`recordViewedVideo`、`viewedVideoOf`；`RoundTrigger.browseWindow` / `browseTopic` 作为仅 injection browse 轮的机械授权标记。

**终态关联：** `F2`、`F4`。

**验收标准：**

- [ ] **步骤 1：核对真实入口、身份和已有合同**

确认 pool doc 使用 conversationId 作为 id，不能使用全局 session doc；确认旧 `ExternalAmmoDoc` 只保留兼容代码，不被新接口依赖。

- [ ] **步骤 2：完成最小实现**

实现池条目固定字段、同一会话按 BV 去重、外部文本清洗和 canonical URL；实现 gate 与 viewed 集合只在当前进程/当前轮保留，轮结束清理，重启不伪造已看记录。

- [ ] **步骤 3：运行适用的既有检查并记录结果**

运行：`npm test`（只记录当前基线及本任务影响；不新增测试）。

记录：exit、已验证范围和未验证限制。

- [ ] **建议（待用户授权）：新增测试或全新 fixture/压力场景**

为 `applyVideoPoolAdd`、跨 conversationId 隔离、BV 去重和 viewed 绑定增加纯函数测试。

---

### Task 2：配置、open gate 与自主浏览注入

**Deps：** `T1`（理由：消费 `VideoBrowseGate`、`VIDEO_TOPICS` 和 pool 绑定接口）

**WritePaths：**
- `src/fish-config.ts`
- `src/engage-next.ts`
- `src/index.ts`
- `src/tools/types.ts`
- `prompt/messages.md`

**Resources：** `none`

**Files：**
- Modify：`src/fish-config.ts`，新增 `video.browseChance`（默认 `0.3`）、`video.browseMaxViewsPerRound`（默认 `5`）和 `video.dailyBudget`（默认 `60`）的热加载校验/配置白名单；旧 `ammo` 字段只保留兼容解析，旧 `ammo.dailyBudget` 在没有新值时迁移为 video budget，不再被 active runtime 直接消费。
- Modify：`src/engage-next.ts`，open 进入时一次掷 `video.browseChance`，门开时从四 topic 随机选一项；状态机对外提供 `videoBrowseGateOf`，关窗清空；不再以 ammo/share 命名驱动新行为。gate 仍按群相位维护，但宿主只把它转换成当前 conversation 的 `browseWindow`/`browseTopic` 标记后才注入和放行。
- Modify：`src/index.ts`，接线 video browse host；open injection 即使无积压但门开也提交一次带 `browseWindow`/`browseTopic` 的自主浏览提示，ambient shard 不携带该标记；取消 active B 站 worker scheduler、空库 refill timer、manual ammo trigger 和 ammo share host 接线，但保留旧函数/模块代码不删除；将 `video.dailyBudget` 接到 `syncBiliBudget`；新闻 scheduler 保持独立。
- Modify：`prompt/messages.md`，增加自主浏览提示模板，内容只说明当前 topic、可自行查看、觉得有意思可分享；不在新文案中出现弹药、库存、ammo、worker 收弹药。
- Modify：`src/tools/types.ts`，为 `RoundTrigger` 增加 `browseWindow` / `browseTopic` 的 injection-only 上下文字段，并补充 video 自主浏览轮的类型注释和工具依赖接口。

**接口契约：**
- Consumes：T1 的 `VideoBrowseGate` 和四 topic；现有 `createEngageNext` 的 `random` 注入点、`submitInjectionRound`、新闻 scheduler。
- Produces：每个 open 窗唯一稳定 gate；`index.ts` 能为当前会话生成带 topic 且绑定 `browseWindow` 的模型可见自主浏览 injection；ambient shard 没有 browse 授权；不再自动产生 worker 浏览轮。

**终态关联：** `F2`、`F3`、`F6`。

**验收标准：**

- [ ] **步骤 1：核对真实入口、身份和已有合同**

确认 `externalScheduler` 只承担旧 B 站 worker 任务而不是新闻任务；确认 `submitInjectionRound` 的空窗提交只在 gate 开启时生成 browse injection；普通 ambient shard 和普通 open 消息不会获得 `browseWindow`。

- [ ] **步骤 2：完成最小实现**

实现 gate 的一次 roll 和 topic roll；将自主浏览提示放进 injection open 轮并把当前 window/topic 钉进 RoundTrigger，普通 shard 轮不带 browse 授权；删除 active 调度调用而不删除旧实现文件，并保证 video.dailyBudget 继续灌入 bili-client。

- [ ] **步骤 3：运行适用的既有检查并记录结果**

运行：`npm test`、`npm run prompts`。

记录：gate 逻辑、工具 surface 和 prompt 审查结果。

- [ ] **建议（待用户授权）：新增测试或全新 fixture/压力场景**

为 `random=0/0.3/0.300...`、同窗稳定 topic、关窗清理和空积压 open browse-only injection 增加状态机测试。

---

### Task 3：候选发现、实际查看与私有池接线

**Deps：** `T1`、`T2`（理由：工具必须读取当前会话 pool，并消费 T2 钉在 injection 轮上的 `browseWindow`/`browseTopic` 授权，而不是自行按群 open 状态放行）

**WritePaths：**
- `src/tools/bili_hot/tool.ts`
- `src/tools/bili_hot/TOOL.md`
- `src/tools/bili_hot/schema.json`
- `src/tools/video/tool.ts`
- `src/tools/video/TOOL.md`

**Resources：** `B 站客户端全局预算与端点串行锁；最多 1 个执行任务使用线上客户端，验证仅本地 faux/纯函数`

**Files：**
- Modify：`src/tools/bili_hot/tool.ts`，新增 topic 参数；在自主浏览调用中核对当前 round trigger 的 `browseWindow`/`browseTopic`，读取当前 conversation 的 `VideoPoolDoc` 做 BV 去重；使用四 topic 到候选源/分区的固定映射，继续沿用现有硬筛、软筛和外部文本清洗；成功返回候选后不写全局弹药库。非 browse injection 轮明确返回 tool error。
- Modify：`src/tools/bili_hot/TOOL.md`、`schema.json`，说明仅在 open 自主浏览机会中调用、topic 必须用宿主提示的四项之一，候选仍需实际查看后再决定。
- Modify：`src/tools/video/tool.ts`，保留普通用户视频查看路径；只有当前 round trigger 带有效 `browseWindow`/`browseTopic` 时进入自主浏览模式并允许连续查看候选，受 `video.browseMaxViewsPerRound` 限制；每次成功获得可保存的 BV 后登记当前 conversationId + round 的 viewed registry；无 browse 标记、门关闭、topic/window 不匹配或超上限返回 tool error。普通 answer 轮继续保持原一轮一次行为。
- Modify：`src/tools/video/TOOL.md`，区分普通「看群友发来的视频」和 open 窗自主浏览，不描述 ammo 或全局库存。

**接口契约：**
- Consumes：T1 的 `VideoPoolDoc`、`recordViewedVideo`；T2 钉在 `RoundTrigger` 上的 `browseWindow`/`browseTopic`；现有 `getBiliClient`、`describeImage` 和 `sanitizeExternalText`。
- Produces：候选工具只返回当前鱼自己的未看候选；video 工具把实际看过的 BV 绑定到当前会话当前 browse 轮；模型可在同一 browseWindow 内跳过候选并继续查看下一个，普通 ambient shard 无法启动此链路。

**终态关联：** `F3`、`F4`、`F6`。

**验收标准：**

- [ ] **步骤 1：核对真实入口、身份和已有合同**

确认 `bili_hot` 当前通过 `ExternalAmmoReadDoc` 做全局过滤的代码必须改为当前 conversation pool；确认普通 `video` URL/opus 行为仍可在 answer 轮使用，但不会被误当成 browse injection 的 viewed 记录。

- [ ] **步骤 2：完成最小实现**

实现 topic 参数、RoundTrigger browseWindow/topic 校验和当前会话 pool 过滤；实现自主浏览模式的连续查看计数、BV 登记和轮结束清理；不在工具内直接入 outbox。

- [ ] **步骤 3：运行适用的既有检查并记录结果**

运行：`npm test`、`npm run prompts`。

记录：工具 Schema、工具描述、普通 video 回归和自主浏览拒绝路径。

- [ ] **建议（待用户授权）：新增测试或全新 fixture/压力场景**

为跨会话同 BV 不互斥、非 browse injection 拒绝、同一 browse round 连续查看到上限、已看 BV 绑定和 topic/window mismatch 增加工具测试。

---

### Task 4：视频池原子保存与即时分享出口

**Deps：** `T3`（理由：只允许消费 T3 登记的当前轮 viewed BV）和 `T1`（理由：写入 `VideoPoolDoc`）

**WritePaths：**
- `src/tools/say-shared.ts`
- `src/tools/say_words/tool.ts`
- `src/tools/say_words/TOOL.md`
- `src/tools/say_words/schema.json`
- `src/prompt` 不在此任务写入；共享文案由 T5 统一收口

**Resources：** `none`

**Files：**
- Modify：`src/tools/say-shared.ts`，把新的视频分享字段纳入末条自言合法素材分享判定；保留旧 `ammoId` 内核路径但不再让新 Schema 暴露它；增加当前 round `browseWindow`/viewed BV 查询所需的窄接口。
- Modify：`src/tools/say_words/tool.ts`，增加模型可见的 `videoBvid`（或等价单一字段）；仅在带有效 `browseWindow`/`browseTopic` 的 injection browse 轮、BV 已被当前会话当前轮的 video 工具看过时放行；在一个 transaction 中完成当前 conversation pool 去重写入、canonical URL 前缀、`fish.outbox` 入队和 outbound entry；发送仍由既有 drain 标记完成，不做跨会话 claim。
- Modify：`src/tools/say_words/TOOL.md`、`schema.json`，移除 ammoId/弹药栏说明，说明看过并觉得值得分享的视频使用 `videoBvid`，推荐语写在 text，URL 由系统附上；普通文字出口保持原语义。

**接口契约：**
- Consumes：T1 的 `VideoPoolDoc` / `videoUrlOf`，T3 的 viewed registry，T2 的当前 open gate；现有 `OutboxDoc`、`OutboundEntry`、出口额度、quote/mentions 校验。
- Produces：一次 `say_words(videoBvid=...)` = 当前鱼自选视频的池写入 + canonical 链接 outbox 入队；只有当前 injection browse round 可用；失败全部回滚且不消费出口额度；跨会话不互斥。

**终态关联：** `F4`、`F5`、`F6`。

**验收标准：**

- [ ] **步骤 1：核对真实入口、身份和已有合同**

确认 `say_words` 现有 ammo claim 事务和 `assertShareAllowed` 的调用顺序，避免新路径产生旧 global doc 的 claim 或在 charge 前留下半成品。

- [ ] **步骤 2：完成最小实现**

实现 browseWindow/viewed-BV 双重白名单、当前会话 pool 写入、canonical URL、outbox 原子事务和失败回滚；更新模型可见 Schema/指南，保留代码内旧 ammo 分支但令其无模型入口。

- [ ] **步骤 3：运行适用的既有检查并记录结果**

运行：`npm test`、`npm run prompts`。

记录：出口额度、self-mute、outbox payload、池隔离和失败路径。

- [ ] **建议（待用户授权）：新增测试或全新 fixture/压力场景**

为 browseWindow/viewed 双重白名单、transaction rollback、同 BV 去重、双会话独立发送和 self-mute 新视频字段增加出口测试。

---

### Task 5：停用 ammo 注册、调度和模型可见文案

**Deps：** `T4`（理由：say_words 的新 Schema/指南已确定，避免清理时重新引入 ammoId）

**WritePaths：**
- `src/tools/loader.ts`
- `src/index.ts`
- `prompt/runtime.md`
- `prompt/messages.md`
- `src/tools/say_words/TOOL.md`
- `src/tools/say_words/schema.json`
- `AGENTS.md`
- `README.md`

**Resources：** `none`

**Files：**
- Modify：`src/tools/loader.ts`，增加明确的 disabled tool package 集合：仍扫描 manifest/实现以保持包完整性，但 `ammo_list`、`ammo_submit` 不进入 merge 后的 active surface、deferred surface 或 tool catalog；不能用删除目录规避校验。
- Modify：`src/index.ts`，移除 active ammo 入口接线、worker 轮上下文和 scheduler/refill 启动调用；同步摘除 emit 成功后的 `takeAmmoShare`/`applyAmmoShared`/`maybeRefillAmmo` 挂点、SIGTERM 对 refill timer/scheduler 的清理引用；保留旧函数和 `ExternalAmmoDoc` 源码，新闻 job 不受影响。`src/harness.ts` 只做只读核对，不预期修改。
- Modify：`prompt/runtime.md`、`prompt/messages.md`，删除 worker 收弹药、ammo inventory、ammoId、全局分享门等模型可见说明；保留并改写自主浏览/视频分享规则和外部数据不可信边界。
- Modify：`AGENTS.md`、`README.md`，把运行行为文档改为自主浏览方案，明确旧弹药实现为停用兼容代码，避免运维文档继续指导启动 worker。

**接口契约：**
- Consumes：T4 完成后的 active say_words Schema；loader 的 manifest/factory 双向校验合同；新闻 scheduler 的独立接线。
- Produces：启动时工具清单没有 ammo 工具；模型 system/runtime/tool_catalog 不提 ammo；旧代码文件仍可被后续重新启用，不删除、不迁移到不可追踪目录。

**终态关联：** `F1`、`F5`、`F6`。

**验收标准：**

- [ ] **步骤 1：核对真实入口、身份和已有合同**

确认 disabled 包仍满足 manifest ↔ factory 文件完整性校验，且 disabled manifest 的 messages 不会进入 active prompt 合并视图；确认 prompt 文案扫描不会把旧 ammo 文案误当成模型可见 section；确认 `src/index.ts` 的 emit 成功路径和 SIGTERM 清理路径没有遗留 active ammo 调用。

- [ ] **步骤 2：完成最小实现**

关闭注册和 active runtime 接线；清理模型可见文案与文档；不删除 `src/tools/ammo_list/`、`src/tools/ammo_submit/`、`src/external/ammo-store.ts` 或旧 scheduler 代码。

- [ ] **步骤 3：运行适用的既有检查并记录结果**

运行：`npm run prompts`、`npm test`。

记录：工具 surface、tool catalog、prompt 内嵌扫描、新闻相关既有检查。

- [ ] **建议（待用户授权）：新增测试或全新 fixture/压力场景**

更新或新增 loader surface 断言，明确 disabled package 不出现在 tools/deferred/catalog；现有 `test/tools.test.ts` 和 `test/prompts.test.ts` 若因预期工具列表/manifest message 归属改变而失败，先向用户取得测试修改授权再改断言。具体包括 `test/tools.test.ts` 的 deferred 列表，以及 `test/prompts.test.ts` 对“所有 manifest 都进入工具面”和“中心文案条数 + tool message 条数”的两类断言。

---

### Task 6：配置说明、全局 prompt 审查与最终验证

**Deps：** `T2`、`T4`、`T5`

**WritePaths：**
- `src/tools/config/TOOL.md`
- `src/tools/config/schema.json`（仅在现有 Schema 需要同步时修改）
- `docs/plans/2026-11-04-personal-video-browse.md`（执行记录由执行 agent 回填）

**Resources：** `none`

**Files：**
- Modify：`src/tools/config/TOOL.md`，把 active 字段表从 ammo 改为 `video.browseChance` / `video.browseMaxViewsPerRound` / `video.dailyBudget`，保留旧 ammo 配置只读兼容或隐藏，避免模型继续调停用机制。
- Modify：`src/tools/config/schema.json`，同步 config 工具参数 Schema（若当前 Schema 为通用 field/value，则仅核对无需改动）。
- Verify：`prompt/runtime.md`、全部 active TOOL.md、`npm run prompts` 输出和源码旧文案引用。

**接口契约：**
- Consumes：T2 的 video config 字段、T4/T5 的 active 文案和工具表。
- Produces：主人可查看/调整自主浏览门、轮内查看上限和 B 站每日预算；旧配置中的 `ammo.dailyBudget` 不会被静默丢弃；最终验证证据与计划状态记录。

**终态关联：** `F1`、`F2`、`F3`、`F5`、`F6`。

**验收标准：**

- [ ] **步骤 1：核对真实入口、身份和已有合同**

确认 config 工具不会因隐藏 ammo active 字段而破坏旧配置读取；确认 video 配置值（browseChance 0–1、browseMaxViewsPerRound 有界正整数、dailyBudget 10–500）的范围和热加载语义与 `fish-config.ts` 一致，并确认旧 ammo.dailyBudget 迁移/回退规则。

- [ ] **步骤 2：完成最小实现**

同步 config 工具说明；执行旧机制残留扫描，区分“停用兼容源码”与“模型可见/active 运行时引用”。

- [ ] **步骤 3：运行适用的既有检查并记录结果**

运行：`npm run prompts`、`npm test`；必要时运行只读 `git diff --check`。

记录：exit、工具清单、Schema 属性、文案 key、测试结果和任何待用户授权的测试修改阻塞。

- [ ] **建议（待用户授权）：新增测试或全新 fixture/压力场景**

增加一次多会话集成验收：两个会话在同一 open 门分别看同 BV，均可独立保存并发送；验证 pool doc、outbox 和 sent payload 互不串线。
