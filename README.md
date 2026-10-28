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

鱼身上只有：
  一张嘴  say            唯一出口，硬校验
  手写的工具 src/tools/   能力扩展的唯一方式
```

## 为什么出口是一个 tool

不是因为 prompt 里写了"不要输出思考过程"——那只是请求，无法验证。这里做的是结构性的：

- **默认什么都发不出去。** 模型的正文、thinking、tool 调用参数全部留在 transcript 里。
- **出境必须是一次显式调用**，参数受结构校验，失败会作为 tool 错误回到模型，同一轮里改口重说。
- **`callers: ["model"]`**：脚本、嵌套工具调用（`api.executeTool`）都碰不到 `say`，绕不过校验。
- **拒绝不静默丢弃**：静默丢弃 = 群里一片死寂，而且模型永远学不会。

## 没有 bash，没有 skills，没有 MCP

一开始的设计是「两只手 bash + read，能力全靠 skills 脚本」。这个方案被推翻了，理由是
**bash 是一条通往一切的边**：能给模型 bash，等于给它整台机器；skills 把脚本挂在这条边上，
于是每加一项手艺都在扩大那条边。而群里坐着的是可以被 prompt 注入的陌生人。

现在的规则：

- **工具面 = 代码里的 `defineTool`**。`src/tools/` 下每个文件一个能力，注册在
  `src/tools/index.ts`。没有 shell，没有脚本解释器，没有 MCP server。
- **每个工具是一个狭窄的函数**：确定的入参、确定的路径、确定的副作用。想让它危险，
  得有人显式写一行危险的代码，而不是模型自己拼一条命令。
- **prompt 仍然全在 `prompt/tools/<name>.md`**：加一个工具 = 一个 `.ts` + 一个 `.md`，没有第三种位置。

**`read` 是现在唯一能碰到宿主文件的工具**，所以它被包了一层：路径必须落在本群工作目录或媒体目录里，
`/etc/passwd`、`~/.ssh/id_rsa` 一律拒绝（`src/tools/read.ts`）。拿掉 bash 之后 read 就成了那条
「通往一切的边」，不关它等于白关 bash。

代价：加能力要写 TypeScript、要重新部署。换来的是**能力面是可枚举的**——你把
`src/tools/index.ts` 看一遍，就知道这条鱼最坏能干什么，而且这个清单会出现在 `npm run prompts` 里。

## 工具注册表

```ts
// src/tools/index.ts
export function createTools(deps) {
  return [read, createDrawTool(deps)];   // 加一项能力就是往这里加一行
}
```

仓库里现在有三个工具：`say`（出口）、`read`（**只能在群工作目录与媒体目录内读**）、`draw`（占位画图）。
`draw` 的后端是本地生成的渐变图；换成 ComfyUI / 通义万相 / SiliconFlow 只改
`renderImage` 一个函数，工具契约和文案都不用动。

## 校验分两类

**结构性**（`src/egress/policy.ts`）：字数上限、换行上限、禁 markdown/列表/代码块/表格、禁绝对路径与
`sk-`/`Bearer` 等模式、媒体必须在 `MEDIA_ROOT` 内且文件头真是图片、每轮条数、每分钟条数、重复消息。

**溯源性**（`longestCommonSubstring`）：拿待发文本和本轮的 thinking / tool 结果做连续重合检测，
超过 24 字判为抄写。这不是语义判断，是**词面溯源**——正好命中"模型把推理粘进消息里"这个具体故障。

两类都是机械判定，不做"看起来像不像 AI"的猜测。

## 目录

```
src/
  harness.ts        openFish()：storage + models + registry(persona/ say) + 每群一个 conversation
  index.ts          OneBot ⇄ pi-durable 的接线、幂等表、入口
  egress/
    say.ts          唯一的出口工具；校验 → 落 fish.outbound 条目 → emit
    policy.ts       结构校验 + 溯源校验（纯函数，好测）
    ledger.ts       每群的出口账本：最近说了什么、本轮几条、secret 缓冲
    absorb.ts       把 transcript 里的 thinking / tool 结果喂给溯源校验
  prompt-lint.ts    扫描 src/ 里有没有内嵌 prompt（给审查用的护栏）
  prompts.ts        加载 prompt/ 下的 md，严格模板替换
  tools/
    index.ts        注册表：加一项能力就是往这里加一行
    read.ts         被收口的 read（只能读群工作目录 + 媒体目录）
    draw.ts         画图（占位后端，换真模型只改 renderImage）
  qq/
    onebot.ts       零依赖 OneBot v11 客户端（Node 内置 WebSocket）
    gate.ts         门外规则闸 + 群消息结构化包装
prompt/             模型能看到的一切文字（见 prompt/README.md）
test/               node --test，不需要网络和 API key
```

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

`npm test` 19 项，其中四条是设计约束：

1. **正文不出境**：脚本化的模型先 `say("在的")` 再输出长段正文，断言群里只收到前者。
2. **抄写被拦**：`say` 里塞入本轮 thinking 的片段，断言被拒、原因为 tool 错误、重说的那句才放行。
3. **工具面固定**：agent 的工具恰好是 `["say", "read", "draw"]`，且断言 `bash` 不存在。
4. **工具全链路**：模型调 `draw` 拿到真实文件，再 `say({text, media})`，断言路径进了 media、
   正文里没有混进文件名。

## 还没做（按优先级）

- **上下文不会自己收敛**：compaction 关着，群聊会一直长。需要按群 reset + handoff（摘要模板放 `prompt/`）。
- **durable 化出站**：`ledger` 现在在内存里，`sentThisRun` / `recent` 崩溃即丢。应改为 conversation doc，
  并让适配器从 `fish.outbound` 条目补齐未发送的消息（现在只在进程内存里 emit 一次）。
- **改写成话**：`say` 之前加一次无工具、无 transcript 的 speaker 调用，把工具结果压成一句人话。
- **审批通道**：L2 工具（发文件、改配置）走管理员私聊审批，群里默认 deny。
- **多群路由持久化**：`chatKeys` 在内存里，重启后靠 `createConversation` 重建；应持久化 group → conversationId。
- **上下文压缩**：群聊无限流，需要 `Conversation.compact()` 的触发策略。
- **协议端掉线告警**：`/api/healthz` 式的发送探针。
