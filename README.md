# 鱼缸

一条活在 QQ 群里的鱼，跑在 [pi-durable](https://www.npmjs.com/package/@earendil-works/pi-durable) 上。

一个 Conversation = 一个群。agent 有工具、有记忆、有崩溃恢复，但**唯一的出口是一个工具调用**。

```
群消息 ──► 规则闸（零 LLM）──► 按发送者静默 5 秒合并 ──► conversation.submit()
                                                              │
                                                        pi-durable 跑 agent loop
                                                        ├── thinking          ✗ 不出境
                                                        ├── tool calls        ✗ 不出境
                                                        ├── 正文              ✗ 不出境
                                                        └── say(..., mentions) ✓ 硬校验 → fish.outbound → QQ

鱼身上真正能把东西送出境的只有两个工具：
  say     出口：可拆条、可引用、可带图/表情包/语音，能点名 @ 群友，硬校验
  react   只贴表情，不说话
```

其余是可枚举的能力工具（`look` / `meme` / `search` / `video` / `draw` / `gpt_image` / `tags`）
和主人专属的工具（`meme_add` / `meme_import` / `read` / `grep` / `write` / `tree` / `model` / `restart` / `watch`）。
完整清单就是 `src/tools/loader.ts` 里那份 factory 名单。

## 为什么出口是一个 tool

不是因为 prompt 里写了"不要输出思考过程"——那只是请求，无法验证。这里做的是结构性的：

- **默认什么都发不出去。** 模型的正文、thinking、tool 调用参数全部留在 transcript 里。
- **出境必须是一次显式调用**，参数受结构校验，失败会作为 tool 错误回到模型，同一轮里改口重说。
- **`callers: ["model"]`**：脚本、嵌套工具调用（`api.executeTool`）都碰不到 `say`，绕不过校验。
- **拒绝不静默丢弃**：静默丢弃 = 群里一片死寂，而且模型永远学不会。

## 没有 bash、没有 skills、没有 MCP

先后被砍掉的东西，理由都一样：**它们都是「通往一切的边」**。

- `bash`：能给模型一条 shell，等于给整台机器
- `skills`：脚本挂在 bash 那条边上，每加一项手艺都在扩大那条边
- `delete` / `edit` / `test`：通用改写与执行能力，风险远大于收益（2026-11 收掉）

而群里坐着的是可以被 prompt 注入的陌生人。留下的东西必须**窄到能被一眼看完**。

现在的规则：

- **工具面 = `src/tools/<name>/` 工具包**。每个目录一份 `TOOL.md`（模型侧摘要 + 参数 Schema + 使用指南）
  加一个 `tool.ts`（窄接口），`src/tools/loader.ts` 统一发现注册。没有 shell，没有脚本解释器，没有 MCP server。
- **每个工具是一个狭窄的函数**：确定的入参、确定的路径、确定的副作用。想让它危险，
  得有人显式写一行危险的代码，而不是模型自己拼一条命令。
- **`read` / `grep` 能读仓库和 `/tmp/yugang`**；`.env`、`config/auth.json`、`.git`、`node_modules`、`.trash` 硬封禁。
- **`write` 只能写 `/tmp/yugang`**（鱼自己的草稿区），仓库文件写不进去；
  改模型配置用 `model` 管理工具，改完靠 `restart` 生效。
- **工具说明全在 `src/tools/<name>/TOOL.md`**：加一个工具 = 一个工具包目录 + loader 名单一行，没有第三种位置。

**唯一能读媒体图片的是 `look`**，它只能读 `MEDIA_ROOT` 里的图片，**普通一轮最多 2 张**。
唯一的受控例外是**导入轮**：主人调 `meme_import` 登记过的本地待收图，本轮额度按清单数量放宽（硬上限 50 张），
可以逐张看、逐张用 `meme_add` 收；清单只活当前这一轮，换轮即失效。
这不是通用文件读取的回归——目录固定、身份固定（主人）、清单只一轮、图仍然只从 `MEDIA_ROOT` 里读。
要加别读文件的能力，正确做法是写一个「读某个确定目录下的某个确定文件」的工具，
而不是把任意路径的通用读取放回来。

代价：加能力要写 TypeScript、要重新部署。换来的是**能力面是可枚举的**——你把
`src/tools/index.ts` 看一遍，就知道这条鱼最坏能干什么，而且这个清单会出现在 `npm run prompts` 里。

## 工具注册表

```ts
// src/tools/loader.ts（节选）
const FACTORIES: Readonly<Record<string, ToolPackageFactory>> = {
  draw: createDrawTool,
  look: createLookTool,
  // 加一项能力就是往这里加一行；manifest ↔ factory 双向一一对应，孤儿两边都算错
};
```

`say` / `react` / `tool_search` 初始可见（eager）；其余已启用工具统一 `deferred: true`，
模型先用 `tool_search`（中文/英文都行）检索，命中后从下一次模型请求起才能调用。
主人专属工具在没配 `MASTER_QQ` 时 factory 返回 `undefined`，不进任何工具面
（`agent.tools` / `agent.deferred` / `tool_catalog` 都没有它）。
每个工具的说明与参数 Schema 唯一来自它的 `TOOL.md`：顶部 frontmatter 摘要 +
`---tool-schema` 严格 JSON 块 + 正文使用指南；`tool_catalog` section 只注入 `name + 摘要`。

## 什么时候开口

门外三道机械规则，零模型调用：

```
1. 私聊只认主人（MASTER_QQ），陌生人一律不回
2. 群里任何人 @（含裸 @）必答；回复合并转发合集也必答
3. 特别关注者：先掷随机门（watchAmbientChance，中了直接回），没中再过 60s 门（冷却够也回）
   其余消息（含主人的非 @）：限流，同群两条被处理消息之间至少隔 ambientMinIntervalSeconds
```

入站 @ 是结构化的：`@鱼` / `@别人` / `@全体成员` 分开标注，只 @ 别人时会明确告诉模型「这些不是在叫你」。

放行之后还有两层：

- **5 秒静默合并**：放行的群消息不立刻提交，先按「群 + 发送者」攒 5 秒。同一发送者的新消息重置计时、整组继续加长，
  不同发送者互不干扰；静默满 5 秒才把整组提交一次。整组**最后一条是引用锚点**（A-B-A 里 B 只作背景），
  整组里任意一条 @鱼都算点名，锚点之前最多 10 条群消息进背景栏。
  主人 `/` 指令、私聊、群里 GIF 的静默收图轮都不走这条回复延时。
- **门内还可以沉默**：模型可以选择不调用 `say`——沉默是合法终态。

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

配置：`fish.config.json` 的 `compact.maxEntries` / `compact.maxChars`；摘要固定用主模型（`models.main`）。

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
    policy.ts       结构校验 + 溯源校验（纯函数，好测）
    ledger.ts       每群的出口账本：最近说了什么、本轮几条、secret 缓冲
    absorb.ts       把 transcript 里的 thinking / tool 结果喂给溯源校验
  prompt-lint.ts    扫描 src/ 里有没有内嵌 prompt（给审查用的护栏）
  prompts.ts        加载 prompt/ 下的 md（runtime / 人格 / 共享文案），严格模板替换
  compact.ts        换页：摊平对话 → 写备忘 → conversation.reset()
  chatlog.ts        原话簿：按群按天写流水（只给运维 skill 看，鱼看不到）
  tools/
    manifest.ts     TOOL.md 严格解析器（双元数据块 + 严格 JSON Schema + 动态词表）
    loader.ts       工具包发现注册：manifest ↔ factory 一一对应，eager/deferred 在这里定
    catalog.ts      tool_catalog section 渲染（只列 name + 顶部摘要）
    <name>/         19 个工具包，一包一目录：TOOL.md + tool.ts（say 是唯一出口，也住这里）
  media/
    meme-store.ts   表情包库（索引、md5 去重、入库）
  qq/
    onebot.ts       零依赖 OneBot v11 客户端（Node 内置 WebSocket）
    gate.ts         门外规则闸 + 群消息结构化包装（@ 目标 / 背景行渲染）
    debounce.ts     5 秒静默合并状态机 + 整组上下文渲染（背景 / 锚点 / 整组标记）
prompt/             模型能看到的一切文字（见 prompt/README.md）
test/               node --test，不需要网络和 API key
```

## 模型与凭据

**配置和凭据都是本机文件，模板进仓库。**

```
config/models.json         models 角色表 + provider 地址 + 模型清单 + 兼容值  ← gitignore，每台机器一份
config/models.example.json 模板，说明完整语法                              ← 进仓库
config/auth.json           只有 key                                        ← gitignore，权限 600
config/auth.example.json   模板，说明格式                                   ← 进仓库
```

首次使用 `cp config/models.example.json config/models.json`，之后只编辑这份被 gitignore 的本机文件；
换机器时各自维护一份，互不覆盖。

`var/` 只放运行时生成的东西（数据库、原话簿、媒体、幂等表），不放凭据。

模型选择只有一个入口：`config/models.json` 的 `models` 角色表。没有环境变量，也没有启动参数。

```json
{
  "models": {
    "main":   { "provider": "zai-coding-cn", "model": "glm-5.3-flash" },
    "vision": { "provider": "zai-coding-cn", "model": "glm-5.3-flash" },
    "image":  { "provider": "openai-codex",  "model": "gpt-image-2" }
  },
  "providers": {
    "zai-coding-cn": {
      "api": "openai-completions",
      "baseUrl": "https://open.bigmodel.cn/api/coding/paas/v4",
      "compat": { "maxTokensField": "max_tokens" },
      "models": [ { "id": "glm-5.3-flash", "contextWindow": 1000000, "maxTokens": 131072 } ]
    }
  }
}
```

三个角色：

| 角色 | 用途 | 省略时 |
|---|---|---|
| `main` | 主对话模型；压缩/备忘也用它 | 必填，缺了启动报错 |
| `vision` | `look` / `video` 的识图模型 | 与 `main` 完全相同 |
| `image` | `gpt_image` 透传通道：`provider` 决定用 `auth.json` 里哪条登录，`model` 是默认模型名 | `gpt_image` 不可用（不隐式兜底） |

旧配置里的 `default` 键已废弃：留着会直接报错，改成 `models.main`。

`providers.<name>.transport: "sse"` 是进程级流式传输设置（只取 `main` 的 provider）：
Node 的 WS 不吃 `--use-env-proxy`，过代理时必须写 `"sse"`。
`providers.<name>.proxy`（只认 http/https）让这一个 provider 的全部请求走隧道（模型流 / 生图 / token 刷新），
其它 provider 仍直连；codex 过代理必须同时写 `transport: "sse"`。

鱼自己能 `read` 这个文件；主人可以让它用 `model` 工具切换三个角色，改完用 `restart` 生效。

凭据只导一次，之后运行时不碰任何外部配置：

```bash
npm run creds import     # 从 ~/pi-config/pi/auth.json 导一次，写 config/auth.json（600）
npm run creds show       # 每个 provider 有没有 key、多少字符
npm run creds clear      # 删掉
npm run ping             # 读 models.json → 最小补全 → 打印三角色/耗时/用量
```

加模型：往本机 `config/models.json` 对应的 `providers.<name>.models[]` 里加一条，再把 `models.<角色>` 指过去。
换机器时重新 cp 一份模板、重新导一次凭据，各自维护。

`key` 只在内存里：不写 env、不进 prompt、不进 transcript，`describeModel()` 只报「已加载 / N 字符」和来源路径。

## 配置

```bash
cp .env.example .env      # 已经在仓库里给你放好一份了
npm run token             # 生成 OneBot token，同步到 .env 和 NapCat 配置
```

`.env` 里**只有四样必填**：

| 变量 | 是什么 |
|---|---|
| `ONEBOT_WS_URL` | 协议端 OneBot v11 正向 WS 地址，例如 `ws://127.0.0.1:3001` |
| `ONEBOT_TOKEN` | `npm run token` 生成（32 字节 base64url），别手写 |
| `MASTER_QQ` | 你的 QQ 号。私聊只认它；群里它的非 @ 消息同样走限流，主人或当前群特别关注者可以主动 @ 人 |
| `GROUPS` | 允许说话的群号，逗号分隔 |

其余行为参数不在 `.env` 里，在 `fish.config.json`（模板 `fish.config.example`，mtime 热加载）：
`ambientMinIntervalSeconds` / `watchAmbientChance` / `thinkingLevel` / `compact` / `memeCooldownMinutes` /
`toolTimeoutSeconds` / `voices`。**旧的 `AMBIENT_CHANCE` / `COOLDOWN_MS` / `DAILY_QUOTA` / `QUIET_HOURS` / `KEYWORDS`
已经下线，写进 `.env` 也不会生效**（旧 `AMBIENT_MIN_INTERVAL_SECONDS` / `WATCH_AMBIENT_CHANCE` 仍作为兜底，
但请改 `fish.config.json`）。**建议第一次先设 `GROUPS` 只放一个测试群。**

`npm start` / `probe` / `ops` / `ping` 都会自动读 `.env`（`--env-file-if-exists`），不用手动 export。

## 一条命令

```bash
npm run doctor     # 体检：缺什么、怎么补
npm run up         # 体检 → 等/拉协议端 → 起鱼；Ctrl-C 一起收
npm run down       # 收掉 up 起的进程
```

`npm run up` 会等协议端就绪（最多 5 分钟，期间你去扫码），就绪后再启动鱼。
如果想让 up 顺手拉起协议端，在 `.env` 里填 `PROTOCOL_CMD`。

协议端安装（下载 + 写 OneBot 配置）：

```bash
npm run protocol install    # 下载 NapCat 到 var/protocol/napcat，按 .env 写好 WS 服务
npm run protocol status     # 装了没、QQ 在不在、WS 通不通
```

macOS 走官方的 **NapCat-Mac-Installer**（GUI）：

```bash
# 已下载到 ~/Downloads/NapCatInstaller/NapCatInstaller.app
npm run protocol install   # 只写配置，指向 QQ 容器目录
```

然后打开安装器：选版本 → 安装 → 切换程序入口 NapCat → 启动 QQ → 扫码。
被系统拒绝时去「系统设置 → 隐私与安全性 → App 管理」放行。

配置位置随平台不同：macOS 是 `~/Library/Containers/com.tencent.qq/Data/Documents/napcat`，
其它平台是 `var/protocol/napcat`，`npm run protocol install` 会自己判断。

## 跑起来

```bash
npm install
npm test                 # 用 faux provider 跑，不需要 key

# 真跑：先有 NapCat / SnowLuma 的 OneBot v11 正向 WebSocket
export ONEBOT_WS_URL=ws://127.0.0.1:3001
export ONEBOT_TOKEN=...            # 没有就不填
# 模型在 config/models.json 的 models.main 里配，没有环境变量
# 说话频率在 fish.config.json 里调（ambientMinIntervalSeconds / watchAmbientChance），没有对应的 env 开关
npm start
```

数据落在 `var/`（SQLite + 幂等表），人格书在 `prompt/persona.md`（多人格在 `prompt/personas/`），
发图必须放在 `MEDIA_ROOT` 里；本地表情包待收目录是 `MEDIA_ROOT/meme-inbox/`。

## 已验证

`npm test` 86 项，其中四条是设计约束：

1. **正文不出境**：脚本化的模型先 `say("在的")` 再输出长段正文，断言群里只收到前者。
2. **抄写被拦**：`say` 里塞入本轮 thinking 的片段，断言被拒、原因为 tool 错误、重说的那句才放行。
3. **工具面可枚举**：初始 `agent.tools` 恰好是 say / react / tool_search，其余已启用工具
   （含 `meme_import`）在 `agent.deferred` 里等 `tool_search` 加载；且断言 `bash`、`shell` 都不存在。
4. **看图全链路**：模型调 `look` 拿到逐张文字视觉描述，图片不进入主会话；普通轮最多 2 张，
   导入轮仅对本轮 manifest 里的图片受控放宽到最多 50 张；越界路径（`/etc/passwd`）和非媒体路径被拦。

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

## 用量

`pi.usage` 是每个会话的累计值。每轮结束后读出来、和上次求差、按天落到 `var/usage/<day>/usage.jsonl`：

```bash
npm run ops usage              # 今天，按群排
npm run ops usage 2026-05-01
```

```
== 2026-05-01 用量
  qq:group:42                4700 tokens  (in 4000 / out 700 / cache 2800)  计费 0.0085
  qq:private:1000             580 tokens  (in 500 / out 80 / cache 100)  计费 0.0009
  合计 5280 tokens / 计费 0.0094
```

存增量不存累计：按天按群直接 sum 就行，重启也不会重复计。日期按本地时区切，和原话簿一致。

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
- **协议端掉线告警**：`/api/healthz` 式的发送探针。
