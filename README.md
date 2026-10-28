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

鱼身上只有三样东西：
  两只手  bash + read   能力扩展全部是 skills/<name>/SKILL.md + 脚本，用 bash 跑
  一张嘴  say           唯一出口
```

## 为什么出口是一个 tool

不是因为 prompt 里写了"不要输出思考过程"——那只是请求，无法验证。这里做的是结构性的：

- **默认什么都发不出去。** 模型的正文、thinking、tool 调用参数全部留在 transcript 里。
- **出境必须是一次显式调用**，参数受结构校验，失败会作为 tool 错误回到模型，同一轮里改口重说。
- **`callers: ["model"]`**：脚本、嵌套工具调用（`api.executeTool`）都碰不到 `say`，绕不过校验。
- **拒绝不静默丢弃**：静默丢弃 = 群里一片死寂，而且模型永远学不会。

## 为什么只有 bash + read

**能力扩展不该长在宿主上。** 每加一个能力就改一次宿主代码、装一次依赖、重启一次进程，
最后你会得到一个 90 个工具的怪物，prompt 里塞满它这辈子用不上的工具说明。

skills 的做法是把能力放回磁盘：

```
skills/draw/
  SKILL.md            name + description + 步骤（模型按需 read，不占常驻上下文）
  scripts/make.mjs    纯标准库脚本，用 bash 跑
```

常驻上下文里每个 skill 只占一行：名字 + 什么时候用 + 路径。要做什么事，模型自己
`read` 那个 SKILL.md，再 `bash` 跑脚本。加一项能力 = 扔一个目录进去，不重启、不改代码。

`say` 是例外，而且必须是工具：如果"说话"是一个 skill 脚本，那脚本就得知道群号，
而且任何 bash 命令都能写那个出口文件——校验就形同虚设。**说必须是能力，不能是副作用。**

## 三条命令之外没有别的

- `bash` 的 `prepare` 钩子会：不继承宿主环境变量（key 不进 shell）、cwd 锁在本群 workspace、
  拦掉 `rm -rf /` / `sudo` / `mkfs` / `ssh` / 写 `/etc` 这类自杀命令
- 脚本能拿到 `$YUGANG_SKILL_DIR`、`$YUGANG_MEDIA_ROOT`、`$YUGANG_WORKSPACE`
- ⚠️ 这不是沙箱。真隔离请上容器或 seatbelt/bwrap；这份代码里的 bash 依然是一个全权限 shell

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
  skills.ts         扫描 SKILL.md，渲染成 prompt 里的一行一项
  sandbox.ts        bash 的 prepare：环境、cwd、自杀命令拦截
  qq/
    onebot.ts       零依赖 OneBot v11 客户端（Node 内置 WebSocket）
    gate.ts         门外规则闸 + 群消息结构化包装
skills/
  draw/             画图（纯标准库生成 PNG，走 $YUGANG_MEDIA_ROOT）
  meme/             本地表情包挑选
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

`npm test` 12 项，其中三条是设计约束：

1. **正文不出境**：脚本化的模型先 `say("在的")` 再输出长段正文，断言群里只收到前者。
2. **抄写被拦**：`say` 里塞入本轮 thinking 的片段，断言被拒、原因为 tool 错误、重说的那句才放行。
3. **技能全链路**：模型按 SKILL.md 用 bash 跑 `skills/draw` 的脚本，再 `say({text, media})`，
   断言产出的图片路径进了 media、正文里没有混进 `[IMAGE:...]`，并且 agent 的工具恰好是
   `["bash", "read", "say"]`。

## 还没做（按优先级）

- **durable 化出站**：`ledger` 现在在内存里，`sentThisRun` / `recent` 崩溃即丢。应改为 conversation doc，
  并让适配器从 `fish.outbound` 条目补齐未发送的消息（现在只在进程内存里 emit 一次）。
- **改写成话**：`say` 之前加一次无工具、无 transcript 的 speaker 调用，把工具结果压成一句人话。
- **审批通道**：L2 工具（发文件、改配置）走管理员私聊审批，群里默认 deny。
- **多群路由持久化**：`chatKeys` 在内存里，重启后靠 `createConversation` 重建；应持久化 group → conversationId。
- **上下文压缩**：群聊无限流，需要 `Conversation.compact()` 的触发策略。
- **协议端掉线告警**：`/api/healthz` 式的发送探针。
