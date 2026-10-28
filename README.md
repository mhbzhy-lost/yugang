# 鱼缸

一条活在 QQ 群里的鱼，跑在 [pi-durable](https://www.npmjs.com/package/@earendil-works/pi-durable) 上。

一个 Conversation = 一个群。agent 有工具、有记忆、有崩溃恢复，但**唯一的出口是一个工具调用**。

```
群消息 ──► 规则闸（零 LLM）──► conversation.submit()
                                      │
                                pi-durable 跑 agent loop
                                ├── thinking          ✗ 不出境
                                ├── tool calls        ✗ 不出境
                                ├── 正文              ✗ 不出境
                                └── say(text, media)  ✓ 硬校验 → fish.outbound → QQ

鱼身上只有三个工具：
  say     出口：可拆条、可引用、可带图，硬校验
  react   只贴表情，不说话
  look    看群里的图（唯一能读文件的东西，只能读媒体目录的图片）
```

## 为什么出口是一个 tool

不是因为 prompt 里写了"不要输出思考过程"——那只是请求，无法验证。这里做的是结构性的：

- **默认什么都发不出去。** 模型的正文、thinking、tool 调用参数全部留在 transcript 里。
- **出境必须是一次显式调用**，参数受结构校验，失败会作为 tool 错误回到模型，同一轮里改口重说。
- **`callers: ["model"]`**：脚本、嵌套工具调用（`api.executeTool`）都碰不到 `say`，绕不过校验。
- **拒绝不静默丢弃**：静默丢弃 = 群里一片死寂，而且模型永远学不会。

## 没有 bash、没有 read、没有 skills、没有 MCP

先后被砍掉的三样东西，理由都一样：**它们都是「通往一切的边」**。

- `bash`：能给模型一条 shell，等于给整台机器
- `skills`：脚本挂在 bash 那条边上，每加一项手艺都在扩大那条边
- `read`：pi-durable 自带的 read 能读任意绝对路径，`/etc/passwd`、`~/.ssh/id_rsa` 都进得了上下文

而群里坐着的是可以被 prompt 注入的陌生人。留下的东西必须**窄到能被一眼看完**。

现在的规则：

- **工具面 = 代码里的 `defineTool`**。`src/tools/` 下每个文件一个能力，注册在
  `src/tools/index.ts`。没有 shell，没有脚本解释器，没有 MCP server。
- **每个工具是一个狭窄的函数**：确定的入参、确定的路径、确定的副作用。想让它危险，
  得有人显式写一行危险的代码，而不是模型自己拼一条命令。
- **prompt 仍然全在 `prompt/tools/<name>.md`**：加一个工具 = 一个 `.ts` + 一个 `.md`，没有第三种位置。

**唯一能读文件的是 `look`**，而它只能读 `MEDIA_ROOT` 里的图片，一轮最多两次。
要加别读文件的能力，正确做法是写一个「读某个确定目录下的某个确定文件」的工具，
而不是把通用的 read 放回来。

代价：加能力要写 TypeScript、要重新部署。换来的是**能力面是可枚举的**——你把
`src/tools/index.ts` 看一遍，就知道这条鱼最坏能干什么，而且这个清单会出现在 `npm run prompts` 里。

## 工具注册表

```ts
// src/tools/index.ts
export function createTools(deps) {
  return [createLookTool(deps)];   // 加一项能力就是往这里加一行
}
```

`say` 和 `react` 属于出口，注册在 `src/egress/`；`look` 是普通能力，在 `src/tools/`。

## 什么时候开口

三层，从便宜到贵：

```
1. 规则（零成本）  私聊只认主人；@ 必答；作息；每群日配额；冷却
2. 抽样（零成本）  AMBIENT_CHANCE，绝大多数消息到这就被丢掉了
3. 打分（一次便宜模型调用） prompt/gate.md：该不该接这句，score ≥ 0.5 才进
```

门内还有第四层：模型可以选择不调用 `say`——沉默是合法终态。

## 记性

| 层 | 载体 | 寿命 |
|---|---|---|
| 群档案 | transcript 里一条 `fish.group-profile` system 消息 | 整个会话 |
| 人物档 | `prompt/people.md` → system section `people` | 永久（手工维护） |
| 对话 | transcript | 到下一次换页 |
| 换页备忘 | `prompt/handoff.md` 生成的 handoff | 跨换页 |

## 上下文压缩：换页 + 备忘

群聊会一直长，而 pi-durable 自带的 compaction 会在中途注入一段它自己的提示词——看不到也改不了，所以关掉了。
换页是自己实现的：

```
攒到阈值（默认 80 条 或 12000 字）
  → 把「群友说的话 + 鱼发出去的话」摊平（thinking / tool 调用 / tool 结果一律不进）
  → 用一个便宜模型读 prompt/handoff.md，写一段备忘
  → conversation.reset(handoff)   # 换一页，旧对话退出活跃上下文
```

几个刻意的选择：

- **摘要只收对话本身**。tool 结果里有路径、命令输出、外部返回，进摘要就是下一次泄漏的来源。
- **换页发生在这一轮正常结束之后**，不在模型跑到一半时动上下文。
- **摘要失败就不换页**，宁可继续攒着——半截的换页比不换页危险。
- 备忘会被当成鱼自己的记忆（第一行固定「（前情）」），不是别人对它说的话。

配置：`COMPACT_PROVIDER` / `COMPACT_MODEL_ID`（默认用主模型）、`COMPACT_MAX_ENTRIES`、`COMPACT_MAX_CHARS`。

## 校验分两类

**结构性**（`src/egress/policy.ts`）：字数上限、换行上限、禁 markdown/列表/代码块/表格、禁绝对路径与
`sk-`/`Bearer` 等模式、媒体必须在 `MEDIA_ROOT` 内且文件头真是图片、每轮条数、每分钟条数、重复消息。

**溯源性**（`longestCommonSubstring`）：拿待发文本和本轮的 thinking / tool 结果做连续重合检测，
超过 24 字判为抄写。这不是语义判断，是**词面溯源**——正好命中"模型把推理粘进消息里"这个具体故障。

两类都是机械判定，不做"看起来像不像 AI"的猜测。

## 目录

```
src/
  harness.ts        openFish()：storage + models + registry(persona + tools) + 每群一个 conversation
  index.ts          OneBot ⇄ pi-durable 的接线、幂等表、入口
  egress/
    say.ts          唯一的出口工具；校验 → 落 fish.outbound 条目 → emit
    policy.ts       结构校验 + 溯源校验（纯函数，好测）
    ledger.ts       每群的出口账本：最近说了什么、本轮几条、secret 缓冲
    absorb.ts       把 transcript 里的 thinking / tool 结果喂给溯源校验
  prompt-lint.ts    扫描 src/ 里有没有内嵌 prompt（给审查用的护栏）
  prompts.ts        加载 prompt/ 下的 md，严格模板替换
  compact.ts        换页：摊平对话 → 写备忘 → conversation.reset()
  chatlog.ts        原话簿：按群按天写流水（只给运维 skill 看，鱼看不到）
  tools/
    index.ts        注册表：加一项能力就是往这里加一行
    look.ts         看群里的图（唯一能读文件的工具，只读媒体目录）
  qq/
    onebot.ts       零依赖 OneBot v11 客户端（Node 内置 WebSocket）
    gate.ts         门外规则闸 + 群消息结构化包装
prompt/             模型能看到的一切文字（见 prompt/README.md）
test/               node --test，不需要网络和 API key
```

## 模型与凭据

**配置在仓库里，凭据在仓库外。**

```
config/models.json       provider 地址、模型清单、网关兼容值   ← 进仓库，可 diff 可 review
config/auth.json         只有 key                              ← gitignore，权限 600
config/auth.example.json 模板，说明格式                         ← 进仓库
```

`var/` 只放运行时生成的东西（数据库、原话簿、媒体、幂等表），不放凭据。

`config/models.json` 是自己的一份配置，不依赖 `~/pi-config` 是否存在：

```json
{
  "default": { "provider": "qoder-pool", "model": "DeepSeek-Flash" },
  "providers": {
    "qoder-pool": {
      "api": "openai-completions",
      "baseUrl": "http://classi.jini.zeroling.com:8080/qoder/v1",
      "compat": { "maxTokensField": "max_tokens" },
      "models": [ { "id": "DeepSeek-Flash", "contextWindow": 1000000, "maxTokens": 32000 } ]
    }
  }
}
```

凭据只导一次，之后运行时不碰任何外部配置：

```bash
npm run creds import     # 从 ~/pi-config/pi/auth.json 导一次，写 config/auth.json（600）
npm run creds show       # 每个 provider 有没有 key、多少字符
npm run creds clear      # 删掉
npm run ping             # 读凭据 → 最小补全 → 打印模型/耗时/用量
```

只抄了 `DeepSeek-Flash` 一个模型。要加别的，往 `models[].` 里加一条即可——同网关下的
`DeepSeek-V4-Pro`、`Kimi-K3.1-Pro` 都在 `~/pi-config` 里能查到参数。

换机器只要重新导一次凭据；换模型改 `MODEL_PROVIDER` / `MODEL_ID`。

`key` 只在内存里：不写 env、不进 prompt、不进 transcript，`describeModel()` 只报「已加载 / N 字符」和来源路径。

## 跑起来

```bash
npm install
npm test                 # 用 faux provider 跑，不需要 key

# 真跑：先有 NapCat / SnowLuma 的 OneBot v11 正向 WebSocket
export ONEBOT_WS_URL=ws://127.0.0.1:3001
export ONEBOT_TOKEN=...            # 没有就不填
export MODEL_PROVIDER=deepseek     # 任意 pi-ai provider
export MODEL_ID=deepseek-v4-flash
export AMBIENT_CHANCE=0.06         # 不带 @ 时进 loop 的概率
export COOLDOWN_MS=90000           # 同群两次进 loop 的最小间隔
export KEYWORDS=阿鱼,鱼缸           # 命中就进 loop
npm start
```

数据落在 `var/`（SQLite + 幂等表），人格书在 `persona/fish.md`，发图必须放在 `MEDIA_ROOT` 里。

## 已验证

`npm test` 33 项，其中四条是设计约束：

1. **正文不出境**：脚本化的模型先 `say("在的")` 再输出长段正文，断言群里只收到前者。
2. **抄写被拦**：`say` 里塞入本轮 thinking 的片段，断言被拒、原因为 tool 错误、重说的那句才放行。
3. **工具面固定**：agent 的工具恰好是 `["say", "react", "look"]`，且断言 `bash`、`read` 都不存在。
4. **看图全链路**：模型调 `look` 拿到 image block，越界路径（`/etc/passwd`）被拦。

## 重启之后

两件事落盘了，所以重启不会失忆、也不会丢消息：

| 状态 | 存在哪 | 重启后 |
|---|---|---|
| 群 → conversationId | session doc `fish.chats` | 接回同一个会话，transcript 和记忆都在 |
| 待发消息 | conversation doc `fish.outbox` | `fish.drain()` 补发，幂等键保证不重复 |

发送是两阶段的：`queued` → 标记 `sending` → 发出 → 从队列删掉。

- 崩在标记前：重启后还是 `queued`，会补发
- 崩在标记后：状态是"不确定"，**不重发**——群里重复一条比少一条更糟
- 发送抛错：退回 `queued` 重试，三次失败才丢弃并报错

## 运维

没有 Web 后台。运维走项目级 skill：`.agents/skills/ops/SKILL.md`，coding agent 进仓库会自动加载。

```bash
node scripts/ops.ts status     # 数据目录 / 幂等表 / 原话簿概况
node scripts/ops.ts digest     # 复盘某天某个群聊了什么
node scripts/ops.ts probe      # QQ 侧连通性
```

## 还没做（按优先级）

- **durable 化出站**：`ledger` 现在在内存里，`sentThisRun` / `recent` 崩溃即丢。应改为 conversation doc，
  并让适配器从 `fish.outbound` 条目补齐未发送的消息（现在只在进程内存里 emit 一次）。
- **改写成话**：`say` 之前加一次无工具、无 transcript 的 speaker 调用，把工具结果压成一句人话。
- **审批通道**：L2 工具（发文件、改配置）走管理员私聊审批，群里默认 deny。
- **多群路由持久化**：`chatKeys` 在内存里，重启后靠 `createConversation` 重建；应持久化 group → conversationId。
- **上下文压缩**：群聊无限流，需要 `Conversation.compact()` 的触发策略。
- **协议端掉线告警**：`/api/healthz` 式的发送探针。
