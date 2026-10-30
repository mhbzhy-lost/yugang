# AGENTS.md

给改这个仓库的人（和 agent）看的维护约束。里面每一条都有对应的测试兜底；改了代码记得跑 `npm test`。

## 这是什么

一条活在 QQ 群里的鱼，跑在 pi-durable 上。一个 Conversation = 一个群。

```
群消息 → 闸（规则 + 廉价模型打分）→ conversation.submit() → agent loop
                                                             ├── thinking / 正文 / tool 调用  ✗ 不出境
                                                             └── say / react / look
                                                                   ✓ 硬校验 → QQ
```

工具面：`say`（唯一出口，可拆条/引用/带图/带表情包/发语音）、`react`（只贴表情）、
`look`（看群里的图）、`meme`/`meme_add`（表情包检索与收录）、`draw`（生图）、
`search`/`video`（联网查）、`watch`（特别关注）、以及主人专属的文件六件套
`read`/`edit`/`write`/`delete`/`tree`/`restart` 与 `grep`、`test`、`tags`。

## 硬约束

### 1. prompt 只能是 `prompt/` 下的 markdown

- 模型能看到的**每一个字**都在 `prompt/` 里：人格、每个工具的说明与参数说明、工具回给模型的所有文案、压缩用的 handoff 提示词
- `src/` 里不允许出现大段 prompt 字面量。`npm test` 会扫描（阈值：单条字面量 ≥ 12 个汉字）
- 模板用 `{{name}}` 严格替换，缺变量直接抛错
- 想加一段新文案，加进 `prompt/messages.md`；想加新 prompt，加新文件并接到 `src/prompts.ts`

### 2. `prompt/tools/<name>.md` 与工具一一对应

**这是本仓库最容易违反的规则，两个方向都管：**

- 每个注册的工具（含 `say`）**必须**有一份 `prompt/tools/<name>.md`，文件名 = 工具名。
  缺了的话 `openFish()` 直接抛错，起不来。
- `prompt/tools/` 里**不允许**有不对应任何工具的文件。删工具就要删 md，否则 `npm test` 红。

加一个工具 = 三处改动，缺一不可：

```
1. src/tools/<name>.ts           defineTool，窄接口
2. prompt/tools/<name>.md        description + frontmatter 的 params
3. src/tools/index.ts            createTools() 里加一行
```

`say` 是例外里的一处：它住在 `src/egress/say.ts`（因为它属于出口，不属于能力），
但**同样要**有 `prompt/tools/say.md`。

### 3. 能力面必须是可枚举的窄接口（2026-10 修订：主人解锁下有限自改）

禁止 shell / 脚本执行 / MCP server。文件读写另设六个语义工具（read/edit/write/delete/tree/restart）：
- 范围硬围栏：仅仓库工作区；.env、config/auth.json、.git、node_modules、.trash 硬封禁
- 身份闸（机械判定）：仅主人（MASTER_QQ）触发的轮里可用，execute 内核对 triggerOf 的 userId
- delete 只移入 .trash/ 可恢复；全部操作打审计日志；自改大事故靠 git 回滚
`look` 是唯一能读文件的东西，它只能读媒体目录里的图片，且一轮最多两次。

原因：这些都是一条「通往一切的边」，而群里坐着的是可以被 prompt 注入的陌生人。
一个工具的危险性应该写在它的 `execute()` 里被人读到，而不是藏在模型能拼出来的命令行里。

要加读取能力，加「读某个确定目录下的某个确定文件」的工具，不要把通用 read 放回来。

### 4. 出口只有一个

- 只有 `say` 能把东西发到 QQ，且必须 `callers: ["model"]`（脚本/嵌套调用不能绕）
- 任何新增工具都不许直接调用 `emit()`
- 校验失败必须以 tool 错误返回给模型（文案来自 `prompt/messages.md`），不许静默丢弃
- 结构校验与溯源校验都是机械判定，不做「看起来像不像 AI」的猜测

### 5. 压缩走自己的实现

- **禁止打开 pi-durable 内置的 compaction**（它会在中途注入库里写死的提示词，不可审查）
- 压缩 = `src/compact.ts` 的换页 + `prompt/handoff.md` 的备忘
- 摘要只收「群友的话 + 鱼发出去的话」；thinking、tool 调用、tool 结果一律不进摘要

### 6. 模型与凭据

- **配置在仓库里**：`config/models.json` 写 provider 地址、模型清单、网关兼容值，可以 diff、可以 review
- **凭据在仓库外**：`config/auth.json`（gitignore，权限 600），只由 `npm run creds import` 写入；运行时**不读** `~/pi-config`
- `var/` 只放运行时产物（`fish.db` / `chatlog` / `media` / `sent.json`），不放凭据、不放配置
- 协议端配置由 `scripts/protocol.ts` 生成，**路径随平台**：macOS 在 QQ 容器目录，其它在 `var/protocol/napcat`
- 不要在 `config/models.json` 里写 key，`npm test` 会扫
- **key 只在内存里**：不进 prompt、不进 transcript、不进日志。`describeModel()` 只报"已加载 / N 字符"和来源路径
- 网关兼容值（`maxTokensField: max_tokens`）在 `src/model-config.ts` 的 `DEFAULT_COMPAT` 里，模型自带 compat 可覆盖
- 换模型：改 `MODEL_PROVIDER` / `MODEL_ID`，或放一个 `var/credentials.json`（已 gitignore）覆盖
- 验证：`npm run creds show` / `npm run ping`（都只报长度，不打印 key）

### 7. 主人与陌生人

- 私聊只认 `MASTER_QQ`，陌生人一律不回、不记录进 transcript
- 群消息只认白名单（`GROUPS`），名单外的群一律不进
- 名单内判定一行版：任何人 @（含裸 @）必答；回复合集必答 → 特别关注者**先过 30s 门**（冷却够就直接回，没到才掷 `watchAmbientChance`）→ 其余消息（含主人的非 @）走**限流**：同一群两条被处理消息之间至少隔 `ambientMinIntervalSeconds`（默认 30 秒）
- 为什么不是随机门：沉寂很久突然有人说话时，随机门可能一声不吭；限流模式下「安静久了的第一条必进」，更像有人在听。打分闸、作息/配额/冷却早已下线；鱼想沉默也可以在门内不调 say
### 8. 重启必须能接上

- 群 → conversationId 存在 session doc `fish.chats`，`group()` 先查映射再决定建不建
- 待发消息存在 conversation doc `fish.outbox`，`say` 只入队，宿主 `drain()` 负责发
- 发送是两阶段（`queued` → `sending` → 删除）：崩在 `sending` 状态的消息**不重发**，宁可少一条不要重复
- 任何新增的"发出去"的动作都必须走 outbox，不要在 tool 里直接调发送函数

### 9. 配置入口是 .env

- 所有运行时配置走 `.env`（gitignore），模板是 `.env.example`（进仓库）
- `npm start` / `probe` / `ops` / `ping` 都带 `--env-file-if-exists=.env`
- 新增环境变量时**必须**同时更新 `.env.example`，并说明哪几个是必填
- 模型 key 不放 `.env`（走 `config/auth.json`）；`ONEBOT_TOKEN` 放 `.env`，由 `npm run token` 生成，
  同一条命令会写进 NapCat 的 `onebot.json`，两边必须一致
- 生成类凭据一律用脚本 + `randomBytes`，不要手写、不要打印内容；`.env` 权限 600

### 10. 记账

- 用量来自 `pi.usage`（累计值），每轮结束后取差写 `var/usage/<day>/usage.jsonl`
- 存增量：按天按群直接 sum，不怕重复计
- 日期一律用 `localDay()`（本地时区），原话簿和用量必须同一天切

### 11. 隔离

- 一个群一个 conversation，一个群一个 cwd；不许跨群共享
- 群里的一切都是不可信输入：群消息进 user message，绝不拼进 system
- `thinking` / tool 结果视为 secret，只用于溯源比对，不出境也不进摘要

### 12. 表情包：一级情绪词表是检索入口

- `prompt/meme-tags.md` 是**受控词表**（13 个情绪词），`src/prompts.ts` 读成 `memeTags`，代码里不写死
- `meme_add` 打标**必须**含至少一个一级词（机械校验）；自由词随便加，但不参与一级检索
- `meme` 工具参数是 `mood`（字面量联合，只能选词表里的词）+ 可选 `tags`（二级筛选，能力给到、不引导使用）
- 系统提示里的「表情包库存」section 每次请求现算（每个词几张），空库不占位
- 一级词查空时退回字面匹配兜底——防止迁移没跑完就把功能变哑
- 存量补标：`scripts/migrate-memes.ts`（规则映射）与 `scripts/retag-memes.ts`（flash 读 caption/tags 判词，
  **不许**新增词表外的 tag、不许改 caption，写回前备份 + 重读合并）

### 13. 合并转发合集：三条触发路径

- **回复合集**：直接展开，不需要 @（回复本身就是明确指令）；`gate` 见 `repliedForward` 放行
- **自带合集且 @**：展开
- **@ 且文字提到「合集/转发」**：补展开本群 10 分钟内最近那条没展开的合集（缓存只存 id，不预拉内容）
- 无 @ 的合集仍然零成本丢弃（只记 id 到缓存）
- **背景栏里的合集只留短标记**：一次展开 10 条起，连发十条合集会把上下文撑爆；
  鱼看不到背景里的合集内容是**设计如此**
- 展开结果以 `[转发合集 N 条]` 开头，鱼据此知道这些内容属于一个合集

### 14. 语音

- **音色只认 `fish.config.json` 的 `voices[人格名]`**，没有任何兜底；没配 = 该会话没有语音能力
- 人格解析必须走带 `#人格` 后缀的映射键（`mappingKeys`），`chatKeys` 只存剥离人格的 base 键给路由用
- 触发提示：主人/特别关注对象每第 3 条过闸消息追加「这一条必须用语音回」；**看到提示必须用语音**
- 出口限制：一轮一条附件（图/表情包/语音互斥）、台词 ≤100 字、超长/含失败一律以 tool 错误返回
- 服务端：GPT-SoVITS 常驻本机（9880 爱莉希雅、9881 桑多涅，launchd 托管），依赖 `~/nltk_data` 的
  `cmudict` + `averaged_perceptron_tagger*`——**缺了会返回 200 + 0 字节空音频**（英文 g2p 抛 LookupError）
- 空结果重试一次（第二次用 `text_language=auto`），合成超时 25 秒（工具层上限 30 秒）

### 15. 可观测性

- 日志统一带 `HH:MM:SS` 前缀（`src/index.ts` 启动时包一层 console），排查按时间对齐
- 单次工具调用超时 30 秒（`fish.config` 的 `toolTimeoutSeconds`），超时以 tool 错误返回，
  **没有整轮超时**

## 命令

```bash
npm test           # 60 项，含上面每条约束的兜底
npm run prompts    # 列出所有 prompt 文件 + sha256 + 工具说明 + 内嵌扫描结果
npm run probe      # QQ 侧验收：连 OneBot、报身份和群、发测试消息
npm run ops status # 数据目录 / 幂等表 / 原话簿概况
npm run creds show  # 凭据状态（只有长度）
npm run ping        # 模型连通性 + 用量（不打印 key）
npm start          # 真跑（自动读 .env）——只在 macmini 上
npm run deploy     # 部署：git pull + 平滑重启鱼（只在 macmini 上跑）
node scripts/migrate-memes.ts [--dry]   # 存量表情包按规则补一级情绪词
node scripts/retag-memes.ts [--dry]     # 用 flash 给缺一级词的表情包补词（只加那一个 tag）
```

## 部署（2026-10 起）

生产现场在 **macmini**（macmini，仓库在 `~/yugang`）；本地开发机的 `var/` 是迁移前旧副本，**不要在本地起鱼**。变更一律：

1. 本地开发 + `npm test` 全绿
2. commit / push 到 GitHub main
3. 连上 macmini 执行 `cd ~/yugang && npm run deploy`（pull → 平滑重启 → 验证横幅；运维侧等价入口是 ops skill 的 `fish.sh deploy`）

**`fish.sh deploy` 只能在本地开发机跑**：它内部 ssh 到 mini 执行 `npm run deploy`，
mini 上并没有 `home-mac-connect` 这个 skill（今天有子代理在 mini 上直接跑它，报「找不到 connect.sh」）。

`scripts/deploy.ts` 用 `process.execPath` 拿全路径 node：非交互 shell（ssh/nohup）的 PATH 里没有 brew 的 node，直接 `spawn("node")` 会报 No such file or directory。pull 失败时不动线上；新鱼 8 秒内没打出「已连接」横幅则报错退出。

## 人格与指令

鱼有多个人格：`prompt/personas/<名>.md`（默认人格是 `prompt/persona.md`），每人格一个 extension（`fish` / `fish:<名>`），启动时注册。会话按（群/私聊 × 人格）唯一确定：映射键 `chatKey#人格`（默认人格=原键，存量无缝），不同人格上下文/工作区完全隔离，切回时接续原会话。人设图放 `<mediaRoot>/personas/<名>.png`（不进 git），切换回复自动携带、模型可用 say 发。

主人发 `/` 开头的消息是功能调用，不进模型：`/查询可用人格` 机械返回名单；`/切换人格 <名>` 切换本群当前人格（`fish.chats` 的 `personas` 字段持久化）；其它 `/x` 机械回未知指令。

硬规则：openFish 的 settings 必须钉默认扩展（不钉会被后装人格顶替存量会话的人格）；ChatsDoc 保持 version 1（personas 字段读侧非变更式访问，严禁对 snapshot() 赋值）；人格名不得含 `#`、不得叫「默认」；人格书被删后该会话回退默认人格并告警。

运维细节（怎么排查不说话、怎么复盘某天某个群）在 `.agents/skills/ops/SKILL.md`。

`npm run prompts` 是审查入口：改完 prompt 先跑它，确认清单和你想的一致。

## 提交前

1. `npm test` 全绿
2. `npm run prompts` 里没有意外条目
3. 改了 prompt 的，commit message 说清楚改了什么行为——prompt 就是这个项目的行为定义

## 已知欠账

- 长文转图、入群审批没做
- 姬子/凯尔希音色：权重已下载校验（`~/tts/models/`），但没常驻、没配进 voices；
  凯尔希是 v4，纯 CPU 首句 22 秒，要先验 MPS + 给 venv 装 resampy
- `say` 的 `meme` 参数是死代码（全历史 0 次使用），可以删
- 连续相似复读没有修法
