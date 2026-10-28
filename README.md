# 鱼缸

一条活在 QQ 群里的鱼，跑在 [pi-durable](https://www.npmjs.com/package/@earendil-works/pi-durable) 上。

一个 Conversation = 一个群。agent 有工具、有记忆、有崩溃恢复，但**唯一的出口是一个工具调用**。

```
群消息 ──► 规则闸（零 LLM）──► conversation.submit()
                                      │
                                pi-durable 跑 agent loop
                                ├── thinking      ✗ 不出境
                                ├── tool calls    ✗ 不出境
                                ├── 正文          ✗ 不出境
                                └── say(text, media)  ✓ 硬校验 → fish.outbound → QQ
```

## 为什么出口是一个 tool

不是因为 prompt 里写了"不要输出思考过程"——那只是请求，无法验证。这里做的是结构性的：

- **默认什么都发不出去。** 模型的正文、thinking、tool 调用参数全部留在 transcript 里。
- **出境必须是一次显式调用**，参数受结构校验，失败会作为 tool 错误回到模型，同一轮里改口重说。
- **`callers: ["model"]`**：脚本、嵌套工具调用（`api.executeTool`）都碰不到 `say`，绕不过校验。
- **拒绝不静默丢弃**：静默丢弃 = 群里一片死寂，而且模型永远学不会。

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
  qq/
    onebot.ts       零依赖 OneBot v11 客户端（Node 内置 WebSocket）
    gate.ts         门外规则闸 + 群消息结构化包装
persona/fish.md     人格书
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

`npm test` 覆盖两件事：

1. **正文不出境**：脚本化的模型先 `say("在的")` 再输出长段正文，断言群里只收到前者。
2. **抄写被拦**：`say` 里塞入本轮 thinking 的片段，断言被拒、原因为 tool 错误、重说的那句才放行。

## 还没做（按优先级）

- **durable 化出站**：`ledger` 现在在内存里，`sentThisRun` / `recent` 崩溃即丢。应改为 conversation doc，
  并让适配器从 `fish.outbound` 条目补齐未发送的消息（现在只在进程内存里 emit 一次）。
- **改写成话**：`say` 之前加一次无工具、无 transcript 的 speaker 调用，把工具结果压成一句人话。
- **审批通道**：L2 工具（发文件、改配置）走管理员私聊审批，群里默认 deny。
- **多群路由持久化**：`chatKeys` 在内存里，重启后靠 `createConversation` 重建；应持久化 group → conversationId。
- **上下文压缩**：群聊无限流，需要 `Conversation.compact()` 的触发策略。
- **协议端掉线告警**：`/api/healthz` 式的发送探针。
