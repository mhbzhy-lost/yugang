# 合并转发接收 + 人格切换 实现计划

> **给执行 agent：** 必须逐任务执行本计划；步骤使用 `- [ ]` 复选框跟踪。只有整体交付终态全部验证通过，才算计划执行完成；未满足时持续修复与验证。执行方式由计划编写完成后的用户选择决定。

**目标：** ① 鱼能接收合并转发合集（文本进上下文、图片可看）；② 主人用 `/查询可用人格`、`/切换人格 <名>` 指令在多个人格间切换，人格各自独立会话且切回时接续原会话；③ 每个人格有一张人设图，切换回复携带、模型可发。

**架构：** ① forward 段在 `parseEvent` 识别后调 OneBot `get_forward_msg` 拉子消息（限深 1 层/前 10 条/图 ≤2 张），渲染为文本摘要；② 人格 = 一个 Fish extension 实例（`fish` 默认 + `fish:<名>`），registry 全量安装，conversation 创建时经 `AgentChange.extensions` 按名持久绑定——`AgentState.extensions` 语义「数组=精确选择」，存量会话不写 selection 跟随 host 默认，天然零影响；会话映射键 `${chatKey}#${persona}`（默认人格保持原键 → 存量接续）；③ `/` 前缀指令在入站剥离后、gate 前拦截，仅主人，机械回复走 `fish.enqueue`（唯一出口），不进 conversation。

**技术栈：** TypeScript、pi-durable 1.4.0（Extension/AgentChange/defineDoc）、OneBot v11（get_forward_msg）、无新依赖。

## 全局约束

- prompt 硬约束：模型可见文案全在 `prompt/`（人格书、指令回执文案进 `prompt/messages.md` 并被 src 引用，防死文案红）；`src/` 无 ≥12 汉字字面量。
- 指令通道为宿主机械行为：`/` 消息不进 conversation、不进 gate、不进模型上下文；回复文案来自 messages.md，经 enqueue → outbox 唯一出口。
- 指令通道对一切 `/` 前缀的主人消息生效：已知指令执行并回执，未知指令回 cmd_unknown，均不进模型；非主人 `/` 消息按普通消息走原链路。人格状态按 chatKey 维度（群与主人私聊各自独立切换）；群周报固定走默认人格会话。
- ChatsDoc **保持 version 1 不升版**（defineDoc 无 migrate 时升版会令旧档读取直接抛 requires migration 错，部署即崩）；personas 字段访问规则：**读取侧一律非变更式 `doc?.personas?.[chatKey] ?? "默认"`，严禁对 snapshot() 结果赋值**（snapshot 返回活底值，赋值会污染 delta base 出幽灵字段）；`??= {}` 仅限 tx.doc 写路径。
- 人格切换语义：每 chatKey 维持「当前人格」状态（ChatsDoc 持久化，字段 personas）；切换只改状态与后续会话选择，**不新建/不删除会话**；切回某人格时按映射复用其既有 conversation。**Harness settings 必须显式钉住默认扩展列表 `extensions: [Fish默认]`**（HarnessSettings.extensions 缺省语义=全部已安装、后装者胜，不钉住则存量会话的 persona section 会被 fish:鲸鱼娘 顶替）。
- 人格名悬空回退：人格书被删后 ChatsDoc.personas 可能残留未注册名——group(persona) 收到未注册名时**回退默认人格键并 warn**（不崩溃、不建空人格会话）；启动告警文案如实：该会话失去全部 section 与工具（含 say）。
- 会话映射与 cwd：默认人格键 = 原 `chatKey`（存量会话零迁移）；人格 `X` 的键 = `${chatKey}#X`、cwd = `${safeName(chatKey)}#X`（工作区也隔离，符合「new session」语义）。
- 人格书目录 `prompt/personas/*.md`（文件名=人格名，中文名合法）；默认人格 = 现有 `prompt/persona.md` 不动；`prompt/personas/` 为空或缺失时仅剩默认人格，不报错。
- 人设图：`<mediaRoot>/personas/<名>.png`（运行时目录，不进 git）；存在时切换回复携带（enqueue 的 media 字段），人格书内注明路径与用途；缺失仅记日志不阻塞。**默认人格不配人设图（保持现状）**；非默认人格配图：鲸鱼娘（并行运维任务落位）、长征机（用户提供已落位）。
- forward 接收限额：仅展开一层、取前 10 条子消息、图片最多 2 张走既有 downloadImage 进 inbound；嵌套转发以「[嵌套转发]」占位不递归（同步阶段拿不到子消息数，占位不写 N）；`get_forward_msg` 失败时保留占位文本（「[转发合集，展开失败]」），不让整条消息失败。
- 不新增测试（用户未授权时）；除 T5 步骤 3 的部署提交外不得 commit；改动后 `npm test` 52 项必须全绿、`npm run prompts` 无意外条目。
- AGENTS.md 需补「人格与指令」小节（行为定义即文档）。

## 整体交付终态

| ID | 必要条件 | 验证方法与环境 | 通过判据 | 证据位置 | 覆盖任务 |
| --- | --- | --- | --- | --- | --- |
| F1 | 群里发合并转发后，鱼的消息上下文含子消息文本摘要（≤10 条、占位格式），其中图片（≤2 张）落 `media/inbound/` 且 look 可看；展开失败不影响整条消息进闸 | 部署后真机：向群发一条含图文的转发合集，@鱼问内容；查 chatlog 入站记录与 inbound 新文件；回看 transcript | 模型能复述转发的文字内容；inbound 出现转发内图片；无「这一轮没答上来」异常 | fish-console.log、chatlog、mini transcript | T1、T5 |
| F2 | 主人 `/查询可用人格` 机械回「默认、鲸鱼娘、长征机」（以实际人格书为准）；`/切换人格 鲸鱼娘` 机械回「切换完成，当前人格：鲸鱼娘」（有人设图则带图）；此后该群对话使用鲸鱼娘人格与独立会话；切回 `/切换人格 默认` 后接续切换前的默认会话（记忆连续） | 部署后真机三步操作；人格会话发消息能正常到达群里（路由修复生效）；重启后再切回仍记得之前内容（会话持久） | 指令秒回且不触发模型轮；鲸鱼娘会话人格生效（口吻变化）且消息可达；切回后默认会话记得切换前聊过什么 | NapCat 发送日志、群内对话 | T2、T3、T4、T5 |
| F3 | 非主人发 `/切换人格 鲸鱼娘` 不生效（按普通消息走 gate 链路）；未知指令（如 `/abc`）机械回未知提示；存量群（无人格状态）行为与现在完全一致 | 真机：非主人号发指令 + 未知指令；观察默认群对话无变化 | 非主人指令混入模型上下文也无切换效果；未知指令得到机械回复；存量会话 conversationId 不变 | chatlog、transcript | T4、T5 |
| F4 | 仓库约束：52 项测试全绿；死文案检查覆盖 cmd_* 新 key；`npm run prompts` 文件清单新增 personas/*.md 条目、「== 人格」段列出人格名单、无其它意外条目；AGENTS.md 已更新 | 本地 `npm test` + `npm run prompts` + 代码审查 | 全绿、清单仅含预期新增、AGENTS.md 含人格与指令说明 | 命令输出 | T1–T5 |

**完成规则：** 所有必要条件同时满足（F1/F2/F3 的真机部分在部署后由用户配合补验，代码交付以 F4 + 代码审查为准）。

**未满足时：** 持续 fix → test → 对照终态；真实阻塞记录并写明恢复下一步。

## DAG

```text
T1 (onebot forward) ──────────────────────┐
T2 (harness 人格 extension + group) ──> T4 (index 指令通道 + 接线) ──> T5 (验证部署)
T3 (人格书 + 指令文案) ──────────────────┘
```

## Waves

- Wave 1：T1、T2、T3（三者文件不相交，可并行）
- Wave 2：T4（等待 T2 的 group(persona)/Fish.personas 接口与 T3 的文案 key）
- Wave 3：T5（等待全部合入）

**关键路径：** T2 → T4 → T5。

---

### Task 1：合并转发接收（onebot.ts）

**Deps：** `none`

**WritePaths：** `src/qq/onebot.ts`

**Resources：** `none`

**Files：** Modify：`src/qq/onebot.ts`（parseEvent 约 326-370、OneBot 类加方法、downloadImage 复用）

**接口契约：**（parseEvent 是同步纯函数，拿不到 OneBot 实例——异步拉取按 replyIds 先例放在 #onFrame）
- Produces：
  - `parseEvent` 对 `seg.type === "forward"`：记录段 id 进返回值的 `forwardIds: string[]`，text 追加占位 `[转发合集，展开中]`（同步阶段拿不到子消息数，占位不写 N）；不做任何异步动作
  - `#onFrame`（onebot.ts:94-154，图片下载先例 118-127）：解析后若 forwardIds 非空，逐个调 `getForwardMsg(id)`（超时 5s，失败则把占位替换为 `[转发合集，展开失败]`），展开后：截前 10 条子消息，文本摘要回填进 msg.text（格式：`[转发合集 N 条]` 起头，每条 `①昵称: 文本`，子图行 `[图片#K]` 占位与直发图同格式、共用 images.length 计数避免替换错位，嵌套转发 `[嵌套转发]` 不递归，超限尾行 `…共 N 条`）；子消息图片段（≤2）推入 imageSegments 走既有 downloadImage 路径
  - `OneBot` 类新增 `async getForwardMsg(id: string): Promise<{ sender: { nickname?: string }, message: OneBotSegment[] }[] | null>`（封装 `call("get_forward_msg", { message_id: id })`，携带昵称供摘要使用）
- 摘要格式进模型上下文，机械可读。

**终态关联：** F1。

**验收标准：**
- [ ] 步骤 1：核对 NapCat 的 forward 段形态（OB11 array：`{type:"forward", data:{id}}`；以 src/qq/onebot.ts 现有 OneBotSegment 类型 + NapCat 文档为准；开发机无生产日志时允许以文档为准并标注，上线后 F1 真机复验兑底）
- [ ] 步骤 2：实现 `getForwardMsg`（超时 5s、单次调用、失败 null，返回含 sender 昵称）与 #onFrame 的展开回填（占位→摘要/失败占位；子图≤2 推入 imageSegments，沿用既有 downloadImage 的命名/魔数/大小逻辑，与 SD 隧道无关）；parseEvent 仅记 forwardIds 与占位，保持同步纯函数
- [ ] 步骤 3：`npm test` 全绿（onebot 相关既有测试不回归）；报告记录
- [ ] 建议（待用户授权）：`test/onebot.test.ts` 增补 forward 用例（mock get_forward_msg：正常/超深/失败三态）

---

### Task 2：人格 extension 工厂与 group(persona)（harness.ts + store.ts）

**Deps：** `none`

**WritePaths：** `src/harness.ts`、`src/store.ts`、`src/prompts.ts`、`scripts/prompts.ts`

**Resources：** `none`

**Files：** Modify：`src/harness.ts`（Fish extension 定义 133-141、group() 273-316、FishOptions/Fish 接口、openFish 的 settings 约 149）、`src/store.ts`（ChatsState）、`src/prompts.ts`（loadPrompts/auditPrompts 纳入 personas/*.md）、`scripts/prompts.ts`（「== 人格」摘要段列出 personas 名单，审查入口可见）

**接口契约：**
- Produces：
  - `makeFishExtension(name: string, persona: string, parts: {tools, prompts})`：现 `defineExtension({name:"fish",...})` 参数化；默认人格 `fish` 用 `prompts.persona`（行为不变），其余 `fish:<名>` 用人格书全文做 persona section
  - `openFish` 启动扫描 `promptRoot/personas/*.md`：每个建 extension 并 `registry.install`；`Fish.personas: string[]`（`["默认", ...文件名]`）
  - `group(groupKey, profile?, persona = "默认")`：映射/复用键 `persona === "默认" ? groupKey : groupKey + "#" + persona`；cwd 同理；`createConversation` 的 `agent` 加 `extensions: [对应人格 extension]`（默认人格不传 extensions，保持 host 默认，存量零影响）
  - `ChatsState` 加 `personas: Record<string, string>`（chatKey → 当前人格名，缺省视为"默认"）；**ChatsDoc version 保持 1**，读取/写入处 `doc.personas ??= {}` 防御（defineDoc 无 migrate 升版会令旧档读取抛错）
  - `Harness.open` settings 显式钉住 `extensions: [Fish默认实例]`（缺省语义=全部已安装后装者胜，不钉住则存量会话 persona section 被 fish:鲸鱼娘 顶替）；`src/prompts.ts` 的 loadPrompts 扫描 `promptRoot/personas/*.md` 进 `prompts.personas`（文件名→内容映射），auditPrompts 将该目录纳入清单；启动校验：人格文件名不得含 `#`、不得为「默认」，否则启动报错
  - 启动告警：ChatsDoc.chats 键里引用的人格名（#后缀）在注册名单中不存在时，log.warn 如实提示（该会话失去全部 section 与工具，含 say，仅剩 salvage 兕底；group() 对未注册名按全局约束回退默认人格）
- Consumes：pi-durable `AgentChange.extensions`（types.d.ts:385，存名不存对象）

**终态关联：** F2、F3。

**验收标准：**
- [ ] 步骤 1：核对 `AgentState.extensions` 语义（types.d.ts:350-355「An array selects exactly these extensions」）与 `registry.install` 同名替换规则（344-348），报告记录
- [ ] 步骤 2：实现工厂 + 注册 + group(persona) + ChatsState 扩展（version 1 不变）+ settings 钉默认扩展 + prompts.ts 纳入 personas；确认默认路径（无 personas 目录、无 # 键）与现状逐行为一致
- [ ] 步骤 3：`npm test` 全绿（durable 相关既有测试不回归）；报告记录
- [ ] 建议（待用户授权）：`test/durable.test.ts` 增补双人格会话隔离用例（同 chatKey 两人格 → 两 conversationId；默认键 = 原键）

---

### Task 3：鲸鱼娘人格书与指令文案（prompt/）

**Deps：** `none`（人格书调研需联网；人设图由并行运维任务落位，不属本任务）

**WritePaths：** `prompt/personas/鲸鱼娘.md`（新建）、`prompt/messages.md`

**Resources：** `none`（联网用 curl 加 UA；deepseek-search/exa 的 key 未配，勿调用）

**Files：** Create：`prompt/personas/鲸鱼娘.md`；Modify：`prompt/messages.md`（追加 4 个 key）

**接口契约：**
- Produces：`鲸鱼娘.md` 人格书——**身份要素按用户指定（不可违背）**：自称「本鱼」/「DeepSeek 智能助手」/「女仆」，**不使用溟月/溟目等社区 OC 名号**；**「大肥鱼」是社区通行外号：被群友这么叫时给傲娇的可爱反应（坚决否认自己肥），但自己从不主动自称大肥鱼**（她不觉得自己肥）。在此基础上联网调研（萌娘百科/维基/B 站，关键词 deepseek 鲸鱼娘/deepseek whale girl）补充形象细节（鲸鱼元素、DeepSeek 关联梗、口癖），报告列来源 URL；末尾固定一行「自己的人设图在 personas/鲸鱼娘.png，想展示形象时用 say 的 media 参数发它」。messages.md 新 key：
  - `cmd_personas: 可用人格：{{list}}（用 /切换人格 <名> 切换）`
  - `cmd_switched: 切换完成，当前人格：{{persona}}`
  - `cmd_bad_persona: 没有这个人格：{{persona}}。{{list}}`
  - `cmd_unknown: 不认识的指令：{{cmd}}。可用：/查询可用人格、/切换人格 <名>`
- Consumes：`none`

**终态关联：** F2、F3、F4。

**验收标准：**
- [ ] 步骤 1：读 `prompt/persona.md` 全文（格式/量级基线）+ 联网调研鲸鱼娘社区形象细节（多源交叉；完全无资料则停止报告而非编造；**身份要素以用户指定为硬约束，调研仅补充细节，冲突以用户指定为准**）
- [ ] 步骤 2：撰写人格书（用户指定的身份要素/自称/大肥鱼反应/优雅攻防为硬约束，调研补充形象与梗，中文；**篇幅不限（用户已放宽），内容优先丰满：家史细节、社区梗生态、语言风格示例都可展开**）与 4 条文案；模板变量与 T4 的 renderTemplate 调用一致
- [ ] 步骤 3：`npm run prompts`（personas/ 出现在清单）+ `npm test`（死文案：cmd_* 均未在 src 引用前会红——本任务的 key 将由 T4 引用，跨任务时序下先允许 T3 单独跑时以 grep 自查代替，最终以 T4 合入后全绿为准）；报告记录

---

### Task 4：/指令通道与人格接线（index.ts）

**Deps：** `T2`（理由：消费 `group(persona)`、`Fish.personas`、ChatsDoc.personas）；`T3`（理由：消费 cmd_* 文案 key 与人格名单）

**WritePaths：** `src/index.ts`

**Resources：** `none`

**Files：** Modify：`src/index.ts`（onMessage 剥离点之后约 307 行、conversationFor 218-227、启动期灌映射 414-417、import 区）

**接口契约：**
- Consumes：T2 的 `group(persona)/personas/ChatsDoc.personas`；T3 的 `cmd_*` 文案
- Produces：`handleCommand(msg): Promise<string | null>`（识别 `/指令`，仅主人；返回机械回复文本或 null=非指令；内部完成人格切换写 ChatsDoc）；`conversationFor(chatKey)` 改为先查当前人格再 `fish.group(chatKey, profile, persona)`，内存 conversations Map 键同步带人格后缀；**`chatKeys.set(conv.id, 原始 chatKey)`（刺离 #人格后缀）**——emit 路由按原始 chatKey 解析 groupId/userId，否则 `Number("123#鲸鱼娘")`=NaN 一条也发不出

**终态关联：** F2、F3。

**验收标准：**
- [ ] 步骤 1：核对 busy_reply 的 enqueue+drainLoop 用法（onMessage compacting 分支，作为机械回复先例）与 OutboundPayload 的 media 字段，报告记录
- [ ] 步骤 2：实现：位置在 bypass 剥离后、`gate.decide` 前——`/^\//` 且主人 → `handleCommand`；命中则不进 gate、不进模型。指令解析：`/查询可用人格`（精确）、`/切换人格\s+(\S+)`；未知 `/x` 回 cmd_unknown（同样拦截不进模型）；非主人 `/` 走原链路。**回执落点固定为切换前的当前人格会话**（outbox 是 per-conversation 文档；会话不存在则惰性创建默认会话，属可接受副作用）；切换动作本身绝不预建目标人格会话。回执 payload：`{ items:[文案], media: 人设图存在则 personas/<名>.png, quote: true, quoteId: msg.messageId, quoteForce: true, key: `cmd:${msg.messageId}` }`（幂等防崩溃重放重复），经 `fish.enqueue(convId, payload)` + `drainLoop()` 后 return；人格切换写 ChatsDoc（tx.doc 提交，`doc.personas ??= {}` 防御；**读取当前人格一律非变更式 `doc?.personas?.[chatKey] ?? "默认"`，严禁对 snapshot() 结果赋值**）。**启动期灌映射（index.ts:414-417）：存映射键剥离最后一个 `#` 后缀再灌 chatKeys**——否则重启后 drainLoop 先跑，人格会话积压 outbox 用未剥离键 emit → NaN → 3 次重试后丢弃且打断后续会话补发
- [ ] 步骤 3：`npm test` 全绿（cmd_* 死文案检查转绿，引用形态为 `messages["cmd_personas"]` 等精确字面量）；报告记录
- [ ] 建议（待用户授权）：index 级指令用例（mock fish：主人/非主人、已知/未知人格、切换后 conversationFor 键）

---

### Task 5：验证、部署与人设图

**Deps：** `T1`、`T2`、`T3`、`T4`

**WritePaths：** `AGENTS.md`、（线上）`~/鱼缸/var/media/personas/`

**Resources：** `none`（真机验证依赖 mini 与群，属用户配合）

**Files：** Modify：`AGENTS.md`（新增「人格与指令」小节）

**接口契约：** Consumes：T1–T4 全部交付。

**终态关联：** F1–F4 收口。

**验收标准：**
- [ ] 步骤 1：`npm test` + `npm run prompts` 全绿/清单符合（F4）
- [ ] 步骤 2：AGENTS.md 补「人格与指令」小节：指令表（两条+未知提示）、仅主人、会话键规则（默认原键/#人格）、人格书与人设图位置、forward 限额
- [ ] 步骤 3：commit（按 git-commit-convention 拆分：feat(forward)、feat(persona)；**提交必须纳入 prompt/personas/ 全部人格书（含并行产出的长征机.md）与 prompt/tools/say.md 的媒体路径说明修正**——deploy 走 macmini git pull，漏提交则线上人格名单不全；人格书若在部署后才合入，需再跑一次 deploy 供启动扫描注册）→ push → `fish.sh deploy`；报告中记录回滚残余风险（新代码回滚旧版后，旧版会把 #人格 键原样灌入，人格会话积压补发会 NaN 失败丢弃，默认会话不受影响）
- [ ] 步骤 4：人设图核验（不属代码）：确认 `~/鱼缸/var/media/personas/` 下已有 `鲸鱼娘.png`（并行找图任务落位）与 `长征机.png`（用户提供已落位）；默认人格无人设图属预期。缺失仅影响对应人格切换回复带图，不阻塞交付
- [ ] 步骤 5：真机验证清单输出给用户（F1 转发测试消息、F2 三步切换、F3 非主人指令），用户确认后计划完结

**停止条件（全部任务）：** pi-durable 实际接口与计划前提矛盾（如 AgentChange.extensions 行为不符）；需写入声明路径外文件；需新增测试或改 `.env` 既有内容；需动线上数据（fish.db 手工修改）——一律停止并报告阻塞事实。
