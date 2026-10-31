# 鱼的 @、连续消息延时与本地表情包导入实现计划

> **给执行 agent：** 必须逐任务执行本计划；步骤使用 `- [ ]` 复选框跟踪。只有整体交付终态全部验证通过，才算计划执行完成；未满足时持续修复与验证。执行方式由计划编写完成后的用户选择决定。

**目标：** 让鱼可靠区分“@鱼”和“@别人”，能够在受限身份范围内主动 @ 当前群成员；群消息在 5 秒静默窗口后再回复，并把同一发送者的连续发言合并理解；主人可以让鱼在当前群聊上下文中逐张查看并导入 `MEDIA_ROOT/meme-inbox/` 内的本地图片表情包。

**架构：** 入站消息继续由 OneBot 机械解析，但补齐结构化 @ 目标和到达序号；gate 放行后由宿主维护按“群 + 发送者”的 5 秒 debounce 状态，最后一条消息绑定为引用锚点，前 10 条群消息作为背景。主动 @ 作为 `say` 的结构化参数进入 outbox，由宿主做身份和群成员机械校验。表情导入在当前主人触发的会话里运行：专用导入清单登记本轮可看的图片，鱼逐张调用 `look`，再逐张调用 `meme_add`，标签仍由主模型结合群聊上下文决定。

**技术栈：** TypeScript（Node 22 直接运行 `.ts`）、OneBot v11、`@earendil-works/pi-durable` 1.4.0、`@earendil-works/pi-ai` 1.4.0、node:test。

## 全局约束

- 模型能看到的每一个字都必须来自 `prompt/`；新增行为说明放 `prompt/tools/*.md` 或 `prompt/messages.md`，`src/` 不写大段 prompt 文案。
- `prompt/tools/<name>.md` 必须与实际注册工具一一对应；新增工具必须同时修改 `src/tools/<name>.ts`、prompt 文件和 `src/tools/index.ts`。
- 出口只有 `say`；主动 @ 必须作为 `say` 的结构化参数，不能新增绕过 outbox 的发送路径，不能直接调用 `emit()`。
- 所有 tool 必须使用 `callers: ["model"]`；校验失败必须以 tool 错误返回模型，不能静默删掉主动 @ 或静默跳过导入。
- 群消息是不可信输入；@ 目标、主动 @ 权限、表情导入身份都必须由代码机械判定，不能只依赖 prompt。
- 主人身份使用本轮 `triggerOf` 的 `userId` 判定；特别关注名单使用当前群的 `watchedByChat`，不能从模型生成文本推断身份。
- 主动 @ 只允许当前群成员；禁止 @全体；私聊不得携带主动 @。
- 连续消息延时只作用于群消息；主人 `/` 指令仍走机械即时回复，私聊不进入 debounce。
- debounce 固定为 5 秒，本计划不新增环境变量或配置入口。
- 导入目录固定为 `MEDIA_ROOT/meme-inbox/`，不开放任意本机目录、不恢复通用文件读取、不使用 shell、MCP 或独立批量标注服务。
- 本地图片的语义标签由当前主模型决定；`look` 只提供逐张视觉描述，不能把独立视觉模型的结果直接当作最终 caption/tags。
- 表情包按 md5 去重，索引写入必须避免与现有 GIF 自动收图轮并发覆盖；导入失败必须返回可见错误或逐项结果。
- 上下文压缩继续使用仓库自己的 `src/compact.ts`；不打开 pi-durable 内置 compaction。
- 待发消息继续经过 `fish.outbox` 的 `queued → sending → 删除` 两阶段流程，主动 @ 信息必须随 outbox 一起持久化。
- 本次执行允许为新增 `meme_import` 工具同步修改既有 `test/tools.test.ts` 的工具清单断言，但不新增测试文件或提交图片 fixture；任何新增测试文件仍需另行授权。
- 未经用户明确授权不得 commit、push、部署或在本地启动生产鱼；生产验收只在 macmini 按 ops skill 执行。

## 首轮审阅后的确定性修订

- 主动 @的目标来源采用“上下文中的 `昵称(QQ号)`”方案：群背景行带发送者 QQ 号，模型不需要猜测或调用任意成员读取能力。
- `groupMembersOf` 统一作为宿主回调：`FishOptions`、`openFish`、`createTools`、`watch` 和 `say` 共用同一条成员查询链路；成员名单缺失时 fail closed。
- 主动 @权限使用判别值而不是 boolean，以便区分私聊、非主人/特别关注者和成员名单不可用三类错误；`voice: true` 与主动 @组合直接返回 tool 错误，禁止静默丢失 @。
- debounce 抽为 `src/qq/debounce.ts` 的可注入时钟状态机；不设置额外最长等待，发送者持续发言就按既定规则持续延长，静默 5 秒才 flush。
- debounce flush 前重新检查 `compacting`；`resetRun`、`resetLook`、引用/语音轮状态等轮级清账跟随 flush，不在 gate 放行时提前清空。
- `meme-store` 放在 `src/media/meme-store.ts`，工具目录继续只放模型可调用能力；本轮导入验证使用一次性 `/tmp` 脚本，不在仓库新增测试 fixture。
- 本计划先于并行的长期记忆计划落地；后者以后修改 `withContext` 时必须适配本计划的 anchor/burst 参数，不得按旧二参签名覆盖。

## 整体交付终态

鱼在群里收到消息时：能机械区分被 @、@其他成员、@全体和没有 @；同一发送者连续发言期间不会过早启动模型，静默 5 秒后以最后一条为引用锚点、以连续发言整体为目标、以其前 10 条为背景；主人或特别关注者要求鱼主动 @ 时，鱼只会 @当前群成员并将结构化 @ 随 outbox 发出；主人要求处理本地表情目录时，鱼能在当前群聊会话中逐张看图、结合上下文打标并去重落库。

| ID | 必须成立的条件 | 验证方法与环境 | 通过判据 | 证据位置 | 覆盖任务 |
| --- | --- | --- | --- | --- | --- |
| F1 | 入站 @ 解析以当前消息的 self id 为准，支持 OneBot segment 和 CQ 字符串；@别人不会被标成 @鱼；同时 @鱼和别人时两类目标都保留 | 本地纯函数调用与 `npm test`；不连接 QQ | `mentionsBot`、其他目标和 @全体分类正确；`renderForModel` 明确列出全部目标；不满足机器规则的消息不会因普通 @别人直接走 mentioned gate | `test/onebot.test.ts`（建议，待授权）、`test/gate.test.ts`（建议，待授权）、`npm test` 输出 | T1、T6 |
| F2 | `say` 支持结构化主动 @，且只给主人或特别关注者开放 | 本地 faux harness；检查 `src/egress/say.ts`、`src/index.ts`、`src/harness.ts` | 普通群友触发主动 @ 得到 tool 错误；主人/特别关注者可 @当前群成员；未知成员、私聊、@all、voice+mentions 均得到 tool 错误；outbox payload 保留 mentions | `npm test`、代码审阅、outbox 快照 | T2、T3、T6 |
| F3 | 群消息 gate 放行后固定等待 5 秒；只重置同一发送者的待定窗口 | 本地注入时钟或人工审阅 debounce 状态机；不启动生产服务 | A 连续发言会重新计时，B 不会替换 A 的待回复锚点；5 秒后只提交一次 A 的合并消息；flush 前仍受 `compacting` 守卫保护；主人指令和私聊不延时 | `src/qq/debounce.ts`、`src/index.ts`、建议的 debounce 测试、`npm test` | T3、T6 |
| F4 | 连续消息的最后一条是 quote 锚点，前 10 条是背景，同一发送者的连续消息都有明确标记且按整体理解 | 本地构造 A-B-A / A-A-A 消息序列，审阅最终 user content 和 `triggerOf` | quoteId 等于 A 最后一条 messageId；背景恰为锚点前最多 10 条；模型提示明确不能只回应最后一句；任意一条 @鱼会保留整组必答和引用语义 | `src/index.ts`、建议的 context/debounce 测试 | T3、T6 |
| F5 | 主人可让鱼处理固定本地导入目录；鱼逐张 `look`，每张由主模型结合当前群聊调用 `meme_add` | 在不连接 QQ 的本地 faux harness 中放入 20 张合法图片；检查工具状态和索引 | `meme_import` 只枚举 `media/meme-inbox` 内图片；本轮可逐张 look 20 次；非主人无法启动；标签来自当前主模型参数，不由独立视觉流程直接写入 | 导入工具输出、`media/memes/index.json`、工具日志 | T4、T6 |
| F6 | 本地导入不越界、不重复、不破坏现有 GIF 自动收图 | 本地使用越界路径、符号链接、重复 md5 和并发 add 场景 | 越界或非图片逐项拒绝；重复只报告已有文件；索引不会丢已有条目；GIF 自动收图仍可运行 | `src/media/meme-store.ts`、索引快照、`npm test` | T4、T6 |
| F7 | prompt 与工具清单一致，所有新增模型可见文案在 prompt 下，既有检查全绿 | `npm run prompts`、`npm test` | 清单包含新增/修改的 prompt；无孤立工具文档；两条命令 exit 0 | 命令输出 | T1、T2、T3、T4、T5、T6 |
| F8 | 运维和项目说明同步记录 5 秒 debounce、主动 @权限和本地导入目录 | 阅读 `AGENTS.md`、`.agents/skills/ops/SKILL.md`、必要的 README 章节 | 文档说明与代码一致，特别是普通轮 look 2 张、导入轮受 manifest 限制放宽到 50 张、生产目录在 macmini、不能在本地开发机启动鱼 | 文件 diff | T5、T6 |

**完成规则：** 所有必要条件同时满足，且验证证据对应当前交付版本，才能标记计划执行完成；仅完成任务步骤不能替代终态验证。

**未满足时：** 在已授权范围内持续 `fix → test（验证）→ 对照终态`，修复后重验受影响条件；真实阻塞记录为未完成，并写明恢复下一步。

## DAG

```text
T1（入站 @ 结构化解析） ──> T2（say 主动 @ 与 outbox 契约） ──> T3（5 秒 debounce 与连续消息上下文）
T2 ───────────────────────────────────────────────────────────────────────> T4（本地表情导入模式）
T3、T4 ──> T5（prompt/项目/运维文档同步） ──> T6（全量验收）
```

依赖理由：T2 需要 T1 产出的可靠群成员目标表示；T3 要消费 T1 的到达序号并沿用 T2 的 quote/outbox 字段；T4 需要 T2 在 `harness` 中新增的工具依赖注入模式，并会共享 `meme_add`/`look` 的调用状态；T5 必须等行为和错误码稳定后再同步文案；T6 必须验证最终 prompt 清单、工具清单和集成行为。

## Waves

- Wave 1：T1
- Wave 2：T2
- Wave 3：T3
- Wave 4：T4
- Wave 5：T5
- Wave 6：T6

**关键路径：** T1 → T2 → T3 → T4 → T5 → T6。`src/index.ts`、`src/harness.ts`、`prompt/messages.md` 是共享热点，按上述顺序串行修改，不并行写入。

---

### Task 1：入站 @ 目标与消息元数据

**Deps：** `none`

**WritePaths：**
- `src/qq/onebot.ts`
- `src/qq/gate.ts`
- `src/index.ts`
- `prompt/messages.md`

**Resources：** `none`

**Files：**
- Modify：`src/qq/onebot.ts`
- Modify：`src/qq/gate.ts`
- Modify：`src/index.ts`（只负责把 `PromptSet.messages` 注入 `renderForModel`）
- Modify：`prompt/messages.md`
- Suggested Test（待用户授权）：`test/onebot.test.ts`、`test/gate.test.ts`

**接口契约：**
- Consumes：OneBot v11 `message` segment、`raw_message`、当前 frame 的 `self_id`、现有 `IncomingMessage`。
- Produces：
  ```ts
  export interface IncomingMention {
    qq: string;
    name: string;
    kind: "bot" | "other" | "all";
  }

  export type IncomingMessage = {
    // 保留现有 fields；旧 fixture 缺失时消费侧提供默认值
    mentions?: IncomingMention[];
    arrivalSeq?: number;
    // mentionsBot 继续作为 gate 的 O(1) 快速判定
  };
  ```

**终态关联：** `F1`、`F4`。

**验收标准：**

- [ ] **步骤 1：核对当前解析入口**
  阅读 `src/qq/onebot.ts` 的 `#onFrame`、`parseEvent`、`IncomingMessage` 和 `src/qq/gate.ts` 的 `renderForModel`；确认当前 `self_id` 只从 meta event 更新、字符串消息没有 CQ @解析、最近消息需要到达序号。

- [ ] **步骤 2：完成机械解析**
  `parseEvent` 使用 `frame.self_id ?? cachedSelfId` 判定鱼号；segment 消息和 CQ 字符串都解析 `at`；`qq === "all"` 固定归类为 `all`，不能归类为 bot；保留目标 QQ 号和显示名。

- [ ] **步骤 3：保留完整目标信息**
  `renderForModel` 接收由 `src/index.ts` 注入的 `PromptSet.messages`，无论是否同时 @鱼都列出所有 `IncomingMention`；只 @别人时明确标记“不是在叫你”，同时不改变 gate 的 `mentionsBot === false` 语义；不得依靠普通文本中的 `@昵称` 猜目标。

- [ ] **步骤 4：引入到达序号**
  在 OneBot 收到消息帧时分配单调递增的 `arrivalSeq`，使异步拉群成员、展开合集或下载图片后仍能按收到顺序做 debounce；旧 fixture 或外部构造缺失序号时由消费侧退回 bucket 顺序；序号不进入模型文本。

- [ ] **步骤 5：更新模型可见文案**
  将目标标记和“不是在叫你”等文案放入 `prompt/messages.md`，代码只引用 message key；运行 `npm run prompts`，记录清单和内嵌 prompt 扫描结果。

- [ ] **步骤 6：运行既有检查**
  运行 `npm test`；记录 exit、已验证范围和任何因尚未完成下游字段而产生的失败，不把暂时失败标成终态通过。

- [ ] **建议（待用户授权）：新增解析断言**
  覆盖：frame self id 优先、CQ 字符串 @别人、@鱼+@别人、@全体、乱序异步处理仍按 arrivalSeq 排序。

---

### Task 2：say 主动 @、身份闸与 outbox 持久化

**Deps：** `T1`（理由：消费 T1 的 `IncomingMention`/群目标表示，并避免在主动 @层重新猜昵称）

**WritePaths：**
- `src/egress/say.ts`
- `src/qq/onebot.ts`
- `src/harness.ts`
- `src/tools/index.ts`
- `src/index.ts`
- `prompt/tools/say.md`
- `prompt/messages.md`

**Resources：** `none`

**Files：**
- Modify：`src/egress/say.ts`
- Modify：`src/qq/onebot.ts`
- Modify：`src/harness.ts`
- Modify：`src/tools/index.ts`（把同一 `groupMembersOf` 显式传给 watch）
- Modify：`src/index.ts`（emit 透传 mentions，并提供统一成员回调）
- Modify：`prompt/tools/say.md`
- Modify：`prompt/messages.md`
- Suggested Test（待用户授权）：`test/tools.test.ts`、`test/qq.test.ts`

**接口契约：**
- Consumes：`triggerOf`（含 `userId`）、宿主提供的 `mentionPolicyOf`、宿主提供的 `groupMembersOf`。
- Produces：
  ```ts
  export interface OutboundPayload {
    // 保留现有 fields
    mentions?: string[];
  }

  export interface SendOptions {
    quote?: number | string;
    mentions?: readonly string[];
    delayMs?: () => number;
  }

  export interface SayDeps {
    // 保留现有 deps
    mentionPolicyOf?: (conversationId: string, triggerUserId: number | undefined) => "allow" | "not_group" | "not_privileged";
    membersOf?: (conversationId: string) => Promise<{ nickname: string; userId: string }[]>;
  }

  // src/harness.ts 的 FishOptions 也提供同名宿主回调，openFish 将其传给 createSayTool 和 createTools。
  export interface FishOptions {
    // 保留现有 fields
    mentionPolicyOf?: (conversationId: string, triggerUserId: number | undefined) => "allow" | "not_group" | "not_privileged";
    groupMembersOf?: (conversationId: string) => Promise<{ nickname: string; userId: string }[]>;
  }
  ```

**终态关联：** `F2`、`F7`。

**验收标准：**

- [ ] **步骤 1：核对唯一出口和 outbox 字段传递**
  阅读 `src/egress/say.ts` 的 `OutboundPayload`、参数 schema、outbox commit，阅读 `src/harness.ts` 的 `drainConversation` 和 `src/index.ts` 的 `emit`；确认 mentions 必须经过 payload、outbox、drain、emit 四层，不得另开发送路径。

- [ ] **步骤 2：增加结构化参数**
  在 `say` 增加可选 `mentions: string[]`；限制为去重后的纯数字 QQ 号，禁止 `all`，最多 3 个；只在首条 outgoing text 上生成 OneBot `at` segments，多个 `messages` 不重复插入。

- [ ] **步骤 3：完成身份和群成员机械校验**
  有 mentions 时必须存在本轮 trigger；`mentionPolicyOf` 返回 `allow` 才继续，`not_group`、`not_privileged` 分别映射到私聊和身份锁文案；调用 `groupMembersOf` 验证所有目标仍是当前群成员，回调缺失或返回空名单时以“成员名单不可用”错误 fail closed；目标不在群内、@all、普通群友触发均以 tool 错误返回。

- [ ] **步骤 4：接通 outbox 和 OneBot**
  `OutboundPayload`、`OutboxRecord`、`drainConversation` 和 `emit` 全链路保留 mentions；`OneBot.sendGroup` 按 quote → at → text 的顺序构造 segment；`sendPrivate` 不接受 mentions。`openFish` 增加 `mentionPolicyOf` 与 `groupMembersOf` 两个 FishOptions 回调，并把同一 `groupMembersOf` 显式传给 `createTools`，修复 watch 现有的成员查询断链。

- [ ] **步骤 5：处理语音交互**
  `voice: true` 与 `mentions` 同时出现时必须以 tool 错误返回新增 message key；不允许因为语音 payload 没有 text item 而静默丢失主动 @。

- [ ] **步骤 6：补齐 prompt 文案**
  `prompt/tools/say.md` 说明主动 @只能填写当前上下文中确认过的 QQ 号；`prompt/messages.md` 增加身份锁、非成员、私聊和成员名单不可用等错误文案，代码只引用 key。

- [ ] **步骤 7：运行既有检查**
  运行 `npm run prompts` 和 `npm test`；记录工具说明、消息 key 和 outbox 字段审查结果。

- [ ] **建议（待用户授权）：新增主动 @断言**
  覆盖普通群友拒绝、主人允许、特别关注者允许、非成员拒绝、@all 拒绝、outbox 重启后仍保留 mentions、segment 顺序正确。

---

### Task 3：5 秒 debounce 与连续消息整体上下文

**Deps：** `T2`（理由：最终提交必须消费 T2 的结构化主动 @/quote outbox 契约）；`T1`（理由：消费 arrivalSeq 和完整 @目标信息）

**WritePaths：**
- `src/qq/debounce.ts`
- `src/index.ts`
- `prompt/messages.md`

**Resources：** `none`

**Files：**
- Create：`src/qq/debounce.ts`
- Modify：`src/index.ts`
- Modify：`prompt/messages.md`
- Suggested Test（待用户授权）：`test/index-debounce.test.ts`

**接口契约：**
- Consumes：`IncomingMessage.arrivalSeq`、`messageId`、`userId`、`mentionsBot`、`replyIds`、现有 gate decision、T2 的 `triggerOf`/outbox 契约。
- Produces：
  ```ts
  interface RecentChatMessage {
    arrivalSeq?: number;
    messageId?: number | string;
    userId: number;
    nickname: string;
    text: string;
    at: number;
  }

  interface PendingBurst {
    chatKey: string;
    userId: number;
    messages: RecentChatMessage[];
    lastReceivedAt: number;
    mustAnswer: boolean;
    quoteFromReply: boolean;
    timer: ReturnType<typeof setTimeout>;
  }

  function withContext(
    anchor: IncomingMessage,
    bucket: readonly RecentChatMessage[],
    burst: readonly RecentChatMessage[],
  ): string;
  ```

**终态关联：** `F3`、`F4`、`F7`。

**验收标准：**

- [ ] **步骤 1：核对现有消息入口和副作用顺序**
  阅读 `src/index.ts` 的 `onebot.onMessage`、`recent`、`withContext`、gate、`conv.submit`、`triggerOf`、`submission.wait`、`compacting` 和 `maybeIngestGif`；确保 chatlog、GIF 自动收图和 `/` 指令的既有语义不被 debounce 误吞。把 timer/flush 状态机放进 `src/qq/debounce.ts`，注入 `now` 和 timer 操作，`index.ts` 只负责接线。

- [ ] **步骤 2：替换最近消息记录**
  最近流水保存 `userId`、`messageId`、`arrivalSeq` 和文本，仍保留每群最多 30 条；所有 background 计算按 arrivalSeq，而不是异步 handler 完成时间。群背景行显示为 `昵称(QQ号): 文本`，让模型能从可信上下文选择主动 @目标；缺 arrivalSeq 时退回 bucket 顺序。

- [ ] **步骤 3：实现按发送者的待定窗口**
  gate 放行后创建 `chatKey + userId` 的 `PendingBurst`，固定等待 5000ms；同一发送者的新消息在 gate 前先并入该 burst、取消旧 timer、重新等待；被 gate 拦截的同发送者 follow-up 也必须并入已有 burst；不同发送者不重置该 burst。连续发言没有额外最长等待，最后一条静默 5 秒才 flush。

- [ ] **步骤 4：定义最终锚点和背景**
  timer 到期时取该 burst 最后一条为 anchor，向上取 anchor 之前最多 10 条群消息；A-B-A 中 B只能作为背景，不能替换 A；burst 中每条 A 消息都加 prompt 中的连续发言标记，额外说明最后一条只是 quote 锚点，回复目标是整组含义。背景渲染时剔除 burst 自身消息，burst 只渲染一次，避免同一句同时出现在普通背景和连续发言区。

- [ ] **步骤 5：flush 前复检压缩守卫并迁移轮级清账**
  timer 到期准备 `submit` 前重新检查 `compacting`；命中时按现有 busy 语义处理 @鱼消息并丢弃待定 burst，不提交旧上下文。`resetRun`、`resetLook`、`lastMessageId`、`lastMention`、`lastReply` 和语音计数等当前在 gate 后立即清空的轮级状态，统一移动到 flush/submit 前，并保证同一 burst 内 follow-up 不互相清账。

- [ ] **步骤 6：绑定 quote 和 mention 语义**
  burst 中任意消息 `mentionsBot` 为真时，整组 `mustAnswer` 为真；`triggerOf` 绑定最终 anchor 的 messageId、整组 mentionsBot 和最终触发 userId；回复引用和主动 @使用当前轮绑定信息，不能回退到后来消息的会话级 lastMessageId。

- [ ] **步骤 7：接通主动 @权限回调并处理异常**
  在 `openFish` 调用处提供机械的 `mentionPolicyOf`：私聊返回 `not_group`，群内触发 userId 等于主人或存在于当前原始 chatKey 的 `watchedByChat` 才返回 `allow`，其余返回 `not_privileged`；同时提供统一的 `groupMembersOf`，从当前群拉成员名单。timer、submit、wait 成功或抛错都清理 pending；不新增持久化 pending 文档；重启时未提交的 5 秒窗口按丢弃处理，不产生陈年回复；`maybeIngestGif` 继续独立运行，不把内部任务文本写入普通 burst。

- [ ] **步骤 8：更新模型可见文案并跑检查**
  在 `prompt/messages.md` 增加背景、连续发言、最终锚点文案；运行 `npm run prompts` 与 `npm test`，记录没有把宿主状态字符串硬编码进 `src/` 的结果。

- [ ] **建议（待用户授权）：新增 debounce/context 断言**
  覆盖 A-A-A、A-B-A、A@鱼后继续发言、B@鱼独立 pending、5 秒边界、submit 失败清理、最终 quoteId 和 background 数量。

---

### Task 4：固定 inbox 的本地表情导入模式

**Deps：** `T3`（理由：需要现有 `ToolDeps` 的主人 trigger/master、统一 `groupMembersOf` 和轮结束清理 manifest）

**WritePaths：**
- `src/media/meme-store.ts`
- `src/tools/meme-import.ts`
- `src/tools/meme-add.ts`
- `src/tools/meme.ts`
- `src/tools/look.ts`
- `src/tools/index.ts`
- `src/harness.ts`
- `src/index.ts`
- `test/tools.test.ts`
- `prompt/tools/meme_import.md`
- `prompt/tools/meme_add.md`
- `prompt/tools/look.md`
- `prompt/messages.md`

**Resources：** `none`

**Files：**
- Create：`src/media/meme-store.ts`
- Create：`src/tools/meme-import.ts`
- Create：`prompt/tools/meme_import.md`
- Modify：`src/tools/meme-add.ts`
- Modify：`src/tools/meme.ts`
- Modify：`src/tools/look.ts`
- Modify：`src/tools/index.ts`
- Modify：`src/harness.ts`
- Modify：`src/index.ts`
- Modify：`test/tools.test.ts`（仅把既有工具清单加入 `meme_import`，不新增测试）
- Modify：`prompt/tools/meme_add.md`
- Modify：`prompt/tools/look.md`
- Modify：`prompt/messages.md`
- Suggested Test（待用户授权）：`test/meme-import.test.ts`、`test/tools.test.ts`

**接口契约：**
- Consumes：`MEDIA_ROOT/meme-inbox/`、现有 `ToolDeps` 的主人 trigger/master/groupMembersOf、现有 `meme_add` index 格式、现有 `look` 视觉描述接口。
- Produces：
  ```ts
  // src/tools/meme-import.ts
  export interface MemeImportManifest {
    roundId: string;
    refs: string[];
    createdAt: number;
  }
  export function registerMemeImportRound(roundId: string, refs: readonly string[]): void;
  export function memeImportRefs(roundId: string): readonly string[];
  export function clearMemeImportRound(roundId: string): void;
  export function memeImportLookLimit(roundId: string): number | undefined;
  ```
  `meme_import` 工具只扫描并登记 manifest；`meme_add` 继续负责一张图的 caption/tags 校验和落库；`look` 在当前 manifest 存在时放宽本轮 2 张限制到 manifest 中待处理图片数量，上限 50。

**验收标准：**

- [ ] **步骤 1：核对现有表情包写入和识图路径**
  阅读 `src/tools/meme-add.ts`、`src/tools/meme.ts`、`src/tools/look.ts`、`src/tools/index.ts`、`src/harness.ts` 的 `ToolDeps`；确认现有 GIF 自动收图会与普通 `meme_add` 并发写同一个 `index.json`，确认 look 的本轮计数入口。

- [ ] **步骤 2：建立固定目录和导入 manifest**
  `meme_import` 只允许主人触发，只读取 `resolve(mediaRoot, "meme-inbox")` 的直接子文件；只接受现有图片格式 `.jpg/.jpeg/.png/.gif/.webp`，拒绝目录、符号链接越界、非图片和超过现有媒体上限的文件；按文件名稳定排序，单次最多登记 50 张并返回继续游标。

- [ ] **步骤 3：让 look 支持导入专用额度**
  manifest 只绑定当前 `LiveDoc` round id；普通轮仍最多看 2 张；当前轮先成功调用 `meme_import` 后，`look` 可以逐张查看 manifest 内图片，最多 50 张；round 结束由 `index.ts` 的 finally 调 `clearMemeImportRound`，异常和超时也必须清理。

- [ ] **步骤 4：扩展 meme_add 的本地导入授权**
  先判断 ref 是否位于 `meme-inbox/`：命中时先做主人身份和当前 manifest 校验，再进入后续复制逻辑；`.gif` 的既有豁免只适用于 `inbound/` 自动收图，不能绕过本地 manifest。每张图仍要求 caption、至少一个一级情绪词和最多 8 个 tags。

- [ ] **步骤 5：抽出串行、原子、去重的 meme store**
  新增 `src/media/meme-store.ts` 统一加载索引、按 md5 去重、复制到 `memes/`、原子替换 `index.json` 和模块级写入串行化；`meme-add` 与现有 GIF 自动收图共用该入口；不能用一次完整旧索引覆盖另一个并发写入已经新增的条目。

- [ ] **步骤 6：保持“鱼打标、视觉模型只看图”**
  `meme_import` 的 prompt 明确流程：先登记目录，再对每个 ref 调 `look`，再用当前群聊上下文决定 caption/tags，最后调用 `meme_add`；不得增加独立自动 caption 服务，也不得让导入工具直接生成标签。

- [ ] **步骤 7：注册工具并同步 prompt**
  添加 `src/tools/meme-import.ts`、`prompt/tools/meme_import.md` 和 `createTools()` 注册行；更新 `meme_add`、`look`说明及所有错误/结果 message key；运行 `npm run prompts`，确认没有孤立或缺失工具文档。

- [ ] **步骤 8：本地验证 20 张导入路径**
  用一次性脚本写入 `/tmp` 临时 `MEDIA_ROOT` 和 20 张合法图片（脚本及产物不进入仓库），使用 faux round 验证 manifest、逐张 look 配额、meme_add 去重和索引写入；不新建测试文件，不启动 OneBot，不使用生产 `var/`。

- [ ] **建议（待用户授权）：新增导入断言**
  覆盖固定目录越界、符号链接、普通群友拒绝、20 张 look、51 张游标、重复 md5、GIF 自动收图与本地导入并发写入。

---

### Task 5：项目说明与运维说明同步

**Deps：** `T3`、`T4`（理由：行为、工具名、目录和错误文案已经稳定）

**WritePaths：**
- `AGENTS.md`
- `.agents/skills/ops/SKILL.md`
- `README.md`
- `scripts/memes.ts`

**Resources：** `none`

**Files：**
- Modify：`AGENTS.md`：补充入站 @结构化识别、5 秒连续消息合并、主动 @权限和 `MEDIA_ROOT/meme-inbox/` 约束；把“look 一轮最多两次”改为普通轮 2 张、导入轮受 manifest 控制最多 50 张。
- Modify：`.agents/skills/ops/SKILL.md`：补充“不说话/答非所问”排查中的 debounce、@目标和本地表情导入检查；保留已有 macmini 生产说明，不重复制造冲突入口。
- Modify：`README.md`：同步工具面、@出口、5 秒等待和本地导入模式，删除与当前限流策略冲突的旧描述；明确普通轮 look 两张、导入轮 manifest 内最多 50 张。
- Modify：`scripts/memes.ts`：同步“无批处理导入”的过时注释，说明当前由模型逐张 look + meme_add 完成。

**接口契约：**
- Consumes：T3/T4 的最终行为、工具名和日志前缀。
- Produces：与代码一致的维护文档，不新增模型能力、不改变运行时行为。

**终态关联：** `F8`。

**验收标准：**

- [ ] **步骤 1：逐段对照现有硬约束**
  只修改与本功能直接相关的章节，不改写凭据、部署、出口和隔离原则；所有新增说明使用中文。

- [ ] **步骤 2：同步可观测信息**
  文档说明待定消息不会落 outbox、最终 quote 使用最后一条、普通群友主动 @会收到 tool 错误、本地目录是 macmini 上的 `MEDIA_ROOT/meme-inbox/`；同步 AGENTS/README 中“look 一轮最多两次”为普通轮规则，导入轮只能由 manifest 受控放宽到 50 张。

- [ ] **步骤 3：静态审阅**
  用 `grep` 检查旧的“立即提交/只能收 QQ 图片/主动 @不支持/一轮只能 look 两次/没有批量导入/旧环境变量”等冲突描述，逐项改为当前语义；不启动生产鱼。

---

### Task 6：最终检查与验收记录

**Deps：** `T5`（理由：最终检查必须针对代码和文档全部落地的版本）

**WritePaths：**
- `docs/plans/2026-10-31-fish-mentions-debounce-meme-import.md`（只追加验证记录，不修改终态或任务范围）

**Resources：** `none`

**Files：**
- Read：所有任务涉及的源码、prompt、文档和测试
- Modify：计划文档末尾追加实际验证记录

**接口契约：**
- Consumes：F1–F8 的验证命令、代码审阅结果和用户授权范围。
- Produces：对应当前交付版本的验证记录；失败项必须保留为未完成并写明恢复步骤。

**终态关联：** `F1`–`F8`。

**验收标准：**

- [ ] **步骤 1：运行 prompt 审查**
  运行 `npm run prompts`；确认所有 `prompt/tools/*.md` 都有真实工具，新增 message key 都被代码引用，内嵌 prompt 扫描无意外。

- [ ] **步骤 2：运行既有测试**
  运行 `npm test`；记录 exit code、测试范围和失败原因。`test/tools.test.ts` 的既有工具清单已在 T4 同步 `meme_import`，不得以跳过该断言代替通过。

- [ ] **步骤 3：执行静态安全审阅**
  检查：主动 @只在 `say`；mentions 随 outbox；无 `@all`；普通群友不能主动 @；本地导入只能固定 inbox；没有任意路径、shell、MCP 或独立打标旁路；5 秒 timer 的所有异常路径都清理。

- [ ] **步骤 4：对照 F1–F8**
  每项写入实际命令、exit、关键输出或文件位置；未运行、证据过期、待用户授权或环境不可用的条件标为“未完成/阻塞”，不能用任务勾选代替。

- [ ] **建议（待用户授权）：真实 QQ 侧验收**
  仅在用户另行授权并连接 macmini 后，使用 ops skill 的 `scripts/fish.sh probe` 和受控测试群验证：@别人、A 连发、主人主动 @、特别关注者主动 @、本地 20 张导入。不得在本地开发机启动生产鱼。

---

### Task 7：仅提交，不部署

**Deps：** `T6`（理由：必须先完成 `npm test`、`npm run prompts` 和 F1–F8 证据记录）

**WritePaths：** `none`（只操作 Git 索引和提交，不改工作树内容）

**Resources：** `git index`、当前仓库分支

**Files：**
- Read：`git status --short --branch`、当前 diff、T6 验证记录
- Commit：本次功能源码、prompt、文档、测试清单和本计划文件
- Exclude：`docs/plans/2026-10-30-long-term-memory.md` 及任何无关未跟踪文件

**接口契约：**
- Consumes：T6 的全绿验证结果和用户“仅提交但不部署”授权。
- Produces：一个本地 Git commit；不 push、不启动、不部署、不调用 `npm run deploy` 或 `fish.sh deploy`。

**验收标准：**

- [ ] **步骤 1：提交前确认范围**
  用 `git status --short` 和 `git diff --stat` 检查只包含本功能；使用显式 `git add` 路径，不使用 `git add -A`；确认长期记忆计划和其他未跟踪文件未被加入。

- [ ] **步骤 2：按约定提交**
  读取并遵循 `git-commit-convention` skill；使用不超过 50 字、含中文祈使句且无 AI 署名的提交标题，例如 `feat(fish): 增加主动@、消息合并与表情导入`；body 说明把这些行为落地到受控入口的原因。

- [ ] **步骤 3：提交后验证不部署**
  运行 `git status --short --branch` 确认提交成功和剩余文件仅为明确排除项；不要运行 `npm start`、`npm run deploy`、`fish.sh deploy`、`git push` 或任何生产连接命令。

## 执行交接

已选择 **Subagent-Driven**，执行模型固定为 `deepseek/deepseek-flash`。计划执行完成后仅创建本地 commit，不 push、不部署；本次不进行真实 QQ 侧验收。

---

## 执行验证记录（T6）

**执行时间：** 2026-10-31 13:50 CST（本地开发机，`main` 分支，工作树含 T1–T5 全部改动）
**执行范围：** 只读命令 + 一次性 `/tmp/yg-verify/verify.mjs` 脚本（跑完已删除）。**未 commit、未 push、未 deploy、未启动生产鱼、未连接 QQ**（全程没有 `npm start` / `probe` / `deploy` / `fish.sh`，脚本不加载 `.env`）。

### 一、命令与退出码

| 命令 | exit | 关键结果 |
| --- | --- | --- |
| `npm run prompts` | 0 | 27 个 prompt 文件（18 份 `tools/*.md`、3 本人格书）；工具说明 18 条与注册工具**一一对应**（含 `meme_import: [params: cursor]`，`say: [params: messages, media, meme, voice, quote, mentions]`）；文案表 144 条（含 `mention_*`、`say_mention_*`、`ctx_bg_line`/`ctx_burst_*`/`ctx_anchor_note`、`meme_import_*`、`look_import_used`）；pi-durable 内置 compaction 仍为「已禁用」；**源码内嵌扫描：干净** |
| `npm test` | 0 | `tests 62 / pass 62 / fail 0 / cancelled 0 / skipped 0 / todo 0`，`duration_ms 1926.449292`；`test/tools.test.ts` 的工具清单断言实际执行并通过（清单含 `meme_import`，无 `bash`/`shell`）；「messages.md 里没有死文案，tools/ 里没有死文件」「src/ 里没有内嵌 prompt」均绿 |
| `git diff --check` | 0 | 无输出（无空白错误/冲突标记） |
| `git status --short --branch` | 0 | `## main`；18 个 ` M` + 7 个 `??`；`git diff --cached --stat` 为空（**无暂存内容**） |

范围核对：`git status --porcelain` 共 25 条，逐条比对计划全部 WritePaths（T1–T6）后**范围外条目为 0**，WritePaths 也全部有对应变更。7 个未跟踪项中 3 个是计划文档（`2026-10-30-long-term-memory.md`、`2026-10-31-runtime-prompt-tool-packages.md` 与本计划，均属预先存在/并行计划，非本功能修改），其余 4 个是本功能新增文件（`src/qq/debounce.ts`、`src/media/meme-store.ts`、`src/tools/meme-import.ts`、`prompt/tools/meme_import.md`）。**除本计划末尾这段记录外，T6 未改动任何文件。**

### 二、F1–F8 逐项证据（当前版本）

| ID | 结论 | 证据（命令/脚本输出/文件位置） |
| --- | --- | --- |
| F1 | 通过 | 一次性脚本：segment `at` 别人 → `mentionsBot=false`、`kind=other`；CQ 字符串 `[CQ:at,qq=3000]` → 同上；`[CQ:at,qq=999]`（self=999）→ `kind=bot`；`[CQ:at,qq=all]` → `kind=all` 且 `mentionsBot=false`；同时 @鱼+@别人 → 两条 `mentions` 都在；`frame.self_id=999` 覆盖入参 `selfId=123` 仍判 `bot`。`renderForModel` 输出 `[群42 \| 张三(2000) 回复msg:11 @了李四(3000)（这些都不是在叫你，别把别人的 @ 当成点名）]`；同时 @ 时输出 `@了你 @了李四(3000)` 且**不含**「不是在叫你」。只 @别人进闸结果为 `enter=true reason=rate_pass`（不是 mentioned 路径）。代码：`src/qq/onebot.ts` `applyMention`/`parseCqMessage`/`parseEvent`，`src/qq/gate.ts` `renderMentions`/`renderForModel` |
| F2 | 通过 | 直调 `createSayTool`：主人 + 在群成员 → 放行且 `outbox.queue[0].mentions = ["3000"]`；`not_privileged` → 「主动@只在主人或你特别关注的人叫你点名时才行」；`not_group` → 「私聊里没有@这回事」；非成员 → 「7777 不在这个群里」；`all` → 「不能@全体成员」；非数字 → 「只能填纯数字 QQ 号」；4 个不同号 → 「一次最多@3个人」；`voice:true`+`mentions` → 「语音里带不了@」；成员回调缺失/空名单 → 「拿不到这个群的成员名单」，两者均 fail closed 且 outbox 无记录；重复号去重后只 @ 一次。链路审阅：`OutboundPayload.mentions`（`src/egress/say.ts`）→ `harness.enqueue` 落 `OutboxDoc` → `drainConversation` 透传 `next.mentions`（`src/harness.ts`）→ `index.emit` 仅群分支传给 `onebot.sendGroup`，私聊分支不传 |
| F3 | 通过 | `DEBOUNCE_WINDOW_MS === 5000`（`src/qq/debounce.ts`），`index.ts` 用该常量建 debouncer，无环境变量/配置入口（`fish.config.example` 无 debounce 键）。注入时钟脚本：首条排队 5000ms；同发送者第二条 `clearTimer=1` 并重排 5000ms、组内 2 条；不同发送者 B 插话后 `clearTimer` 仍为 1、A 组仍 2 条、B 独立 1 条；timer 到期先摘表再 flush（`pending=undefined`）；`onFlush` 抛错被 `onError` 兜住；`drop` 可清异常窗口。`flushBurst` 开头复检 `compacting`（命中则丢弃并只对被 @ 的走 busy 回执）。`/` 指令仍走闸前 `handleCommand`，私聊分支不进 debounce，`maybeIngestGif` 仍在闸前独立运行 |
| F4 | 通过 | 脚本构造 A-B-A 流水：`burst.anchor.messageId` = A 最后一条（4），组内消息 `A1,A2,A3` 顺序正确，任意一条 `mentionsBot` → `mustAnswer=true`；`backgroundFor` 返回恰 10 条（`[7..15,17]`，剔除了组内的 16/18）；`withContext` 背景行为 `U9(109): m9` 形式（带 QQ 号）；整组有 `➤` 标记 + 「连着发了 N 条」头 + 锚点说明，锚点行在最后；同一句正文只出现 1 次（不重复出现在背景与整组区）。代码：`src/qq/debounce.ts` `createDebouncer`/`backgroundFor`/`withContext`，`src/index.ts` `flushBurst`/`submitRound` |
| F5 | 通过 | 临时 `MEDIA_ROOT/meme-inbox/` 放 20 张合法 PNG + `note.txt`/`subdir`/符号链接 `link.png`/超限 `huge.png`：`meme_import` 登记 20 张（`meme-inbox/pic-00..19`），跳过 4 项并逐项回报（`太大`/`符号链接`/`不是图片`/`不是文件`）；`memeImportLookLimit(本轮)=20`，换 round 为 `undefined`；非主人触发被拒且不产生清单；普通轮 `look` 前 2 张成功、第 3 张报「本轮已经看过 2 张图」；导入轮 `look` 连续 20 张成功、第 21 次报「这一轮导入的 20 张已经看完了」；清单内 `meme_add` 成功写入 `memes/index.json`（caption 由主模型参数给出、tags 含一级情绪词，无独立打标服务） |
| F6 | 通过 | 重复 md5 → 「库里已经有这张了（…），不用重复收」且索引不增；登记后新放进目录的图与 `meme-inbox/anim.gif` → 均报「这张不在本轮导入清单里」（动图豁免绕不过清单）；`inbound/auto.gif` 由非主人触发的收图轮仍可入库（「收好了：memes/…」）；`../../etc/passwd` → 「找不到这张图」；两次并发 `addMeme` 后索引条数 4（串行 + 原子替换不丢条目）；`hasMemeMd5` 命中当条 md5；51 张场景首批 50 + `cursor=p-049.png`，续批后同轮清单合并为 51、look 额度仍夹在 50 |
| F7 | 通过 | 见上表：`npm run prompts` exit 0 且「源码内嵌扫描：干净」，18 份 `tools/*.md` 与 18 个注册工具一一对应，无孤立/缺失工具文档；新文案 key 全部落在 `prompt/messages.md` 并被代码引用（`npm test` 的「没有死文案」断言绿）；`npm test` exit 0 |
| F8 | 通过 | `AGENTS.md`：入站 @ 三类标注、5 秒合并/锚点/背景 10 条/三条延时例外、主动 @ 的机械边界与身份闸、`meme-inbox` 固定目录与每批 50、look「普通轮 2 张 / 导入轮按 manifest 上限 50」；`.agents/skills/ops/SKILL.md`：新增「答非所问怎么排查（5 秒合并相关）」与「表情包导入排查」两节，保留 macmini 生产说明；`README.md`：流程图更新为「闸 → 5 秒合并 → submit」，工具面、@ 结构化、`meme-store`/`debounce` 目录说明、普通轮 2 张/导入轮 50 张、`.env` 只留 `MASTER_QQ`/`GROUPS` 等；`scripts/memes.ts` 注释改为「本脚本只读索引，不做入库」。四处描述与代码一致 |

### 三、静态安全审阅（逐条结论，全部命中预期）

1. **主动 @ 只有一个入口**：`type: "at"` 段只在 `OneBot.sendGroup`（`src/qq/onebot.ts:353`）生成，调用方只有 `index.emit` 的群分支；无第二个发送函数。
2. **mentions 全程走 outbox**：`say` → `OutboundPayload.mentions` → `OutboxDoc.queue`（两阶段 `queued→sending→删除`）→ `drainConversation` 透传 → `emit` → `sendGroup`；重启补发仍是同一条 @。
3. **无 @all 旁路**：`say` 对 `mentions.includes("all")` 直接报错；入站 `all` 只作 `kind:"all"` 标注，`mentionsBot=false`。
4. **普通群友不能主动 @**：`mentionPolicyOf` 机械判定（`src/index.ts`），只认 `MASTER_QQ` 或当前原始 chatKey 的 `watchedByChat` 成员；未配置回调时 `say` 按 `not_privileged` fail closed。
5. **群成员从当前 chatKey 现拉**：`groupMembersOf` → `chatKeyFor(conversationId)`（兼容数字/字符串两种键）→ `qq:group:<id>` → `onebot.groupMembers`；非群/空名单/异常 → `say` 报「拿不到这个群的成员名单」。
6. **本地导入只能固定目录**：`meme_import` 只有一个 `cursor` 参数，无路径参数；目录写死 `resolve(mediaRoot,"meme-inbox")`，目录本身是符号链接直接拒，条目级拒绝符号链接/非文件/非图片/超限/越界。
7. **manifest 绑定 round**：`registerMemeImportRound(String(round))`，round 来自 `LiveDoc.run.inputs[0]`；`submitRound` 的 `finally` 与 GIF 收图轮 `finally` 都调 `clearMemeImportRound`，换轮/失败/抛错/中断即清。
8. **inbound GIF 豁免不绕过清单**：`meme-add` 先判 `fromInbox`（`meme-inbox/` 前缀）→ 主人 + 本轮清单双校验；只有非 inbox 分支才保留 `.gif` 豁免。
9. **配额**：`look` 默认 `maxPerRun=2`；导入轮仅当该 ref 在本轮清单里才放宽到 `min(manifest 数量, MEME_IMPORT_MAX=50)`；清单外 ref 仍按 2 张。
10. **debounce 语义**：窗口固定 5000ms 常量、无环境变量、无最长等待；A-B-A 锚点恒为组内最后一条；背景 `limit=10`；flush 前复检 `compacting`；timer 回调先 `bursts.delete` 再提交，异常经 `onError` 记日志，pending 不残留。
11. **不回归的路径**：`/` 指令在桶记录后、闸前机械拦截；私聊走 `submitRound` 即时语义；GIF 静默轮 `silentRounds` + `say_silent` 仍独立。
12. **无新增旁路**：`src/` 内 `child_process` 仅出现在既有 `draw.ts`/`video.ts`/`restart.ts`/`look.ts`(sips 压缩)/`onebot.ts`(sips)，本次 diff 未新增；无 MCP；无独立批量打标/自动 caption 服务；`meme_import` 只登记清单，标签仍由主模型经 `meme_add` 写入。

### 四、一次性脚本

`/tmp/yg-verify/verify.mjs`（已删除，未进仓库、未新增测试文件/fixture，仅在 `/tmp` 下建临时 `MEDIA_ROOT`）：42 项断言全部 PASS（`总计 42 项，通过 42，失败 0`，exit 0）。覆盖 F1（9）、F3/F4（8）、F2（10）、F5/F6（15）。

### 五、遗留与注意（不阻塞本次验收，均未修改）

- `README.md`「已验证」第 4 条仍写「模型调 `look` 拿到 image block」，与当前「look 返回文字描述、图片不进主会话」的实现不一致——属本次未涉及的旧描述，未擅自修改，建议后续单独订正。
- `src/index.ts` 第 11 行两个 `import` 被并到同一行（`...from "node:fs";import { homedir } from "node:os";`），功能与测试无影响（`npm test`/`npm run prompts` 均绿），只是格式瑕疵；按 T6 范围未改源码，建议随下一步格式化修正。
- 真实 QQ 侧验收（`probe` + 受控测试群）按计划「建议（待用户授权）」项**未执行**，本次未连接 QQ。

### 六、收尾修正（非阻塞项处理）

日期：2026-10-31。针对上节列出的两条遗留做最小修正，**不改变任何运行时行为**：

1. `README.md`「已验证」第 4 条改为与当前实现一致的描述：`look` 返回逐张文字视觉描述、图片不进入主会话；普通轮最多 2 张，导入轮仅对本轮 manifest 里的图片受控放宽到最多 50 张；越界路径与非媒体路径被拦。README 其余内容未改。
2. `src/index.ts` 文件头部被合并到同一行的两个 import（`node:fs` / `node:os`）拆成两行；仅格式调整，导入内容、顺序与运行时逻辑均不变。

验证：`git diff --check`、`npm run prompts`、`npm test` 均通过（结果见下）。本次收尾**未 commit、未 push、未 deploy、未启动生产鱼、未连接 QQ**，也未新增或修改测试。

| 命令 | exit | 结果 |
| --- | --- | --- |
| `git diff --check` | 0 | 无输出（无空白错误/冲突标记） |
| `npm run prompts` | 0 | prompt 校验通过，源码内嵌扫描干净 |
| `npm test` | 0 | 全部用例通过 |

## 后置修复记录（2026-10-31）

主计划 commit（`a99a628`）之后，对本功能做了一轮边界加固修复（未 amend 历史，叠加为后续 commit）。逐项验证结果：

| 修复项 | 行为与验证证据 |
| --- | --- |
| watch 撤销 | `watch remove` 先于成员校验执行（退群的人照样能撤销）；`onChanged` 改传整份名单，宿主侧 `replaceWatched` 整份替换内存镜像，删掉的人立即失去随机门加权与主动 @ 权限。`test/watch-state.test.ts` 覆盖：整体替换、去重、add→remove 撤权、remove 不依赖成员名单 |
| arrivalSeq | 整组消息与锚点按收到序号排序（`orderByArrival` / `isLaterArrival` / `anchorIndex`），异步补名片/合集/头像导致乱序完成时不再顶掉锚点；背景栏按「序号小于锚点」取，锚点被 30 条流水裁掉时不再把后续对话当背景。`test/debounce.test.ts` 覆盖 |
| persona/bypass/react/compacting/outbox | burst 首次 push 绑定会话/人格，5 秒窗口内 `/切换人格` 不改组；bypass payload 取整组最近一条非空；`react` 只贴本轮触发那条消息（轮级绑定）；换页统一守卫 `compactWithGuard`，收图轮/换页互相让路（`conversationBusy`）；`emit` 记账移到真的发完之后（发送抛错可重试，不提前吃掉幂等键）。`test/qq.test.ts` 覆盖 |
| meme-inbox 读取 | `look` 只认「本轮主人触发 + 这张在本轮 manifest 里」，其余 inbox 引用一律拒（`look_inbox_master` / `look_inbox_outside`）；inbox 读取不占用普通轮 2 张额度 |
| 逐张 look | 清单内每张只看一次，成功描述后才 `memeImportMarkLooked`（失败不占额度也不算看过）；额度 = min(manifest 张数, 50)；`meme_add` 机械核对「本轮 manifest + 已成功 look」，没看成收不了 |
| GIF inbound 围栏 | 动图豁免只适用于 `inbound/` 自动收图；`meme-inbox/` 一律走主人 + manifest + look 三条校验，其他目录 gif 也收不了 |
| 来源校验 | `checkMemeSource`：媒体目录围栏 → 扩展名 → lstat 拒符号链接 → realpath 再围（防目录链接逃逸）→ 大小 → 图片文件头；校验在串行队列里做、写库内容以同一次读取的 bytes 为准（TOCTOU 无效） |
| 主动 @ 来源 | 机械校验：去重 ≤3、禁 `all`、纯数字、`mentionPolicyOf`（主人或当前群特别关注者）、`groupMembersOf` 现拉成员核对、缺名单 fail closed；号码来源靠 prompt 引导从可信上下文抄写，代码不校验号码抄自哪句话 |
| 测试 | 新增 `test/debounce.test.ts` / `test/meme-import.test.ts` / `test/watch-state.test.ts`，增补 `test/onebot.test.ts` / `test/qq.test.ts`；`npm test` 实测 **86 项全部通过** |

同步修正的文档语义：`README.md`（主动 @ 主体改为「主人或当前群特别关注者」）、`AGENTS.md`（meme_add 流程明确 manifest + 已成功 look；主动 @ 号码改为「优先可信上下文 + 机械校验纯数字/成员」，不声称代码验证来源）、`prompt/tools/say.md`（纯文字一轮最多 3 条，与代码一致；mentions 说明对齐成员/权限校验）、`prompt/tools/meme_add.md`（tags 至少含一个一级情绪词；本地 inbox 必须 manifest + 成功 look）、`prompt/tools/meme_import.md`（同上 tags 口径）。

本次后置修复**未 push、未部署**（也未启动生产鱼、未连接 QQ）。
