# AGENTS.md

给改这个仓库的人（和 agent）看的维护约束。里面每一条都有对应的测试兜底；改了代码记得跑 `npm test`。

## 这是什么

一条活在 QQ 群里的鱼，跑在 pi-durable 上。一个 Conversation = 一个群。

```
群消息 → 闸（规则：@ 必答 / 回复合集 / 特别关注 / 限流）
       → 按发送者静默 5 秒合并（同一发送者整组提交，最后一条是引用锚点）
       → conversation.submit() → agent loop
                                 ├── thinking / 正文 / tool 调用  ✗ 不出境
                                 └── say / react / look
                                       ✓ 硬校验 → QQ
```

工具面：`say`（唯一出口，可拆条/引用/带图/带表情包/发语音/点名 @ 群友）、`react`（只贴表情）、
`look`（看群里的图）、`meme`/`meme_add`（表情包检索与收录）、`meme_import`（主人本地批量导入的登记入口）、
`draw`（本地 SD 生图）、`gpt_image`（GPT Image 2 透传）、`search`/`video`（联网查）、`tags`（danbooru 词表）；
以及主人专属的 `read`/`grep`/`write`（草稿区）、`tree`、`model`（切换各类能力使用的模型）、`watch`（特别关注）
与 `restart`。

## 硬约束

### 1. 模型能看到的文字只有两个来源：`prompt/` 下的 markdown 与 `src/tools/<name>/TOOL.md`

- 人格、运行时协议、工具回给模型的所有文案、压缩用的 handoff 提示词全在 `prompt/` 里；
  每个工具的说明、参数 Schema 和使用指南唯一来自 `src/tools/<name>/TOOL.md`（见第 2 条）
- 5 秒合并与入站 @ 的标注也一样：背景栏（`ctx_*`）、整组标记、要回的那一行、`@了你 / @了别人 / @了全体成员`
  全在 `prompt/messages.md`；`src/qq/debounce.ts` / `src/qq/gate.ts` 只负责拼装，不写文案
- `src/` 里不允许出现大段 prompt 字面量。`npm test` 会扫描（阈值：单条字面量 ≥ 12 个汉字）；
  `TOOL.md` 是唯一例外——它本来就是模型侧文字，只是随工具包放在 `src/tools/<name>/` 里
- 模板用 `{{name}}` 严格替换，缺变量直接抛错
- 想加一段新文案，加进 `prompt/messages.md`；想加新 prompt，加新文件并接到 `src/prompts.ts`

### 2. 工具 = `src/tools/<name>/TOOL.md + tool.ts` 工具包

**这是本仓库最容易违反的规则：模型能看到的工具说明只来自 TOOL.md，代码里不写第二份。**

- 一个工具包 = `src/tools/<name>/` 下的 `TOOL.md` + `tool.ts`，目录名 = manifest `name` = 注册名。
  缺块、重复名、目录对不上时 `openFish()` 直接抛错起不来；`src/tools/loader.ts` 启动时做
  manifest ↔ factory 的双向一一对应校验，孤儿文档和没文档的实现都算错
- `TOOL.md` 是**双元数据块**格式：顶部 frontmatter 只认 `name` + `description`（一句摘要）；
  第二块 `---tool-schema` / `---end-tool-schema` 必须是**严格 JSON**（不许注释、尾逗号、远程 `$ref`），
  里面的 `parameters` 是唯一参数 Schema；块之后的正文是非空使用指南，注册时与摘要拼成完整 description
- 解析与动态词表在 `src/tools/manifest.ts`：唯一受控扩展是 `meme.mood` 的
  `x-yugang-enum-from: "memeTags"`（启动时按 `prompt/meme-tags.md` 机械换成 enum），
  其它运行时改写模型所见 Schema 的通道一律拒绝
- 工具面分两层：`say` / `react` / `tool_search` 初始可见（eager），其余已启用工具统一 `deferred: true`；
  模型先用中文/英文检索 `tool_search`，命中后从下一次模型请求起才能调用。`runtime` section
  （`prompt/runtime.md`）负责这条渐进加载协议，`tool_catalog` section 只列已启用工具的 `name + 摘要`
- 加一个工具 = 三处改动，缺一不可：

```
1. src/tools/<name>/TOOL.md     摘要 + 严格 JSON Schema + 使用指南
2. src/tools/<name>/tool.ts     defineTool，窄接口，Schema 只消费 manifest
3. src/tools/loader.ts          FACTORIES 名单里加一行
```

- 主人专属工具（`read`/`grep`/`write`/`tree`/`model`/`restart`/`watch`/`meme_add`/`meme_import`）
  没配 `MASTER_QQ` 时 factory 返回 `undefined`，不进 `agent.tools` / `agent.deferred` / `tool_catalog`；
  `TOOL.md` 仍随包存在，注册与否由 loader 按依赖现判，执行内核里的二次身份校验不变
- 旧 `prompt/tools/*.md` 平铺文档已删除，不要再建；工具回执/拒绝文案继续走 `prompt/messages.md` 的 key
- 审查入口：`npm run prompts` 列出 prompt 文件、全部工具包（路径/sha256/摘要/Schema 属性/eager/deferred）、
  runtime 与 tool_catalog section、源码内嵌扫描结果

### 3. 能力面必须是可枚举的窄接口（2026-10 修订：主人解锁下有限自改）

禁止 shell / 脚本执行 / MCP server。读写与自改另设语义工具（`read`/`grep`/`write`/`tree`/`model`/`restart`）：
- `read` / `grep`：可读仓库与 `/tmp/yugang`；.env、config/auth.json、.git、node_modules、.trash 硬封禁
- `write`：**只能写 `/tmp/yugang`**（鱼的草稿区），仓库文件写不进去
- `model`：只改 `config/models.json` 的 `models` 角色表（main / vision / image），写完靠 `restart` 生效
- 身份闸（机械判定）：仅主人（MASTER_QQ）触发的轮里可用，execute 内核对 triggerOf 的 userId
- 全部操作打审计日志；自改大事故靠 git 回滚
- `meme_import`：只扫**固定目录** `<MEDIA_ROOT>/meme-inbox/`（不接受任何路径参数），只认图片直系子文件，
  符号链接 / 目录 / 非图片 / 超限一律跳过并逐项报给模型；仅主人触发的轮可用；每批最多 50 张，`cursor` 续批，
  同一轮的清单合并保留；登记结果只写入本轮 manifest，round 结束即清

读媒体目录的入口只有两处：`look` 只把图描述成文字；`draw` 的 `ref` 只读一张 `inbound/` 或 `gen/` 的图片当 img2img 初图。`look` 的额度：**普通一轮最多 2 张**。
唯一的受控例外是**导入轮**——主人本轮调过 `meme_import`、且这张图就在本轮 manifest 里时，
额度放宽到 manifest 数量（硬上限 50 张），可以逐张看、逐张用 `meme_add` 收。
这**不是**通用文件读取的回归：目录固定、身份固定（主人）、清单只活一轮、图仍然只从 `MEDIA_ROOT` 里读，
而且 `meme_add` 对本地导入的 ref 会机械核对「本轮 manifest 里有它、且这一轮成功 look 过」。

原因：这些都是一条「通往一切的边」，而群里坐着的是可以被 prompt 注入的陌生人。
一个工具的危险性应该写在它的 `execute()` 里被人读到，而不是藏在模型能拼出来的命令行里。

要加读取能力，加「读某个确定目录下的某个确定文件」的工具，不要把通用 read 放回来。

### 4. 出口只有一个

- 只有 `say` 能把东西发到 QQ，且必须 `callers: ["model"]`（脚本/嵌套调用不能绕）
- 任何新增工具都不许直接调用 `emit()`
- 校验失败必须以 tool 错误返回给模型（文案来自 `prompt/messages.md`），不许静默丢弃
- 主动 @ 不是第二个出口：它是 `say` 的 `mentions` 参数（去重后最多 3 个纯数字 QQ 号），
  只挂在第一条文本上，并随 outbox 一起持久化——重启补发还是同一条 @，不会静默降级成裸消息
- 主动 @ 的机械边界：禁 `all`/非数字；只能 @ **当前群的真实成员**（宿主现拉群成员名单核对，拿不到名单就拒）；
  `voice: true` + `mentions` 直接报错（语音没有文本气泡，@ 等于静默丢人）
- 主动 @ 的身份闸：只有**主人**或**当前群的特别关注者**被点名要求时才可以 @，其余一律以 tool 错误返回；
  私聊里没有「@谁」这回事，同样拒绝。号码应优先从可信上下文（「昵称(QQ)」背景行）填写，
  机械校验确认纯数字与当前群成员；来源本身靠 prompt 引导，代码不校验号码抄自哪句话
- 结构校验与溯源校验都是机械判定，不做「看起来像不像 AI」的猜测

### 5. 压缩走自己的实现

- **禁止打开 pi-durable 内置的 compaction**（它会在中途注入库里写死的提示词，不可审查）
- 压缩 = `src/compact.ts` 的换页 + `prompt/handoff.md` 的备忘
- 摘要只收「群友的话 + 鱼发出去的话」；thinking、tool 调用、tool 结果一律不进摘要

### 6. 模型与凭据

- **模型选择只有一个入口**：`config/models.json` 的 `models` 角色表（`main` / `vision` / `image`）。
  不允许用环境变量或启动参数选模型；旧 `default` 键会直接报错
- **配置是本机文件**：`config/models.json`（gitignore，每台机器一份）写 models 角色表、provider 地址、模型清单、
  网关兼容值；模板是 `config/models.example.json`（进仓库），首次使用 `cp config/models.example.json config/models.json`
- **凭据也是本机文件**：`config/auth.json`（gitignore，权限 600），只由 `npm run creds import` 写入；运行时**不读** `~/pi-config`
- `var/` 只放运行时产物（`fish.db` / `chatlog` / `media` / `sent.json`），不放凭据、不放配置
- 协议端配置由 `scripts/protocol.ts` 生成，**路径随平台**：macOS 在 QQ 容器目录，其它在 `var/protocol/napcat`
- 不要在 `config/models.json` / `config/models.example.json` 里写 key，`npm test` 会扫模板
- **key 只在内存里**：不进 prompt、不进 transcript、不进日志。`describeModel()` 只报"已加载 / N 字符"和来源路径
- 网关兼容值（`maxTokensField: max_tokens`）由 `src/model-config.ts` 的 `withCompat()` 兜底，模型自带 compat 可覆盖
- 换模型：编辑 `config/models.json` 的 `models.main` / `models.vision` / `models.image`（`vision` 省略 = main，
  `image` 省略 = `gpt_image` 不可用），改完让鱼 `restart` 生效；没有 `MODEL_PROVIDER` / `MODEL_ID` / `GATE_*` / `VISION_*` / `YUGANG_MODELS` 这类入口
- 验证：`npm run creds show` / `npm run ping`（都只报长度，不打印 key）
- **provider 级代理**：`config/models.json` 的 `providers.<id>.proxy`（只认 http/https）。配了它，这个 provider
  的**全部**请求走隧道（模型流、`gpt_image`、内部 OAuth 刷新），其它 provider 与 SD/QQ 仍直连；
  不设进程级的 `--use-env-proxy`（那会把 zai / deepseek 也拖进代理）。codex 过代理必须同时 `transport: "sse"`——
  WebSocket 不吃 fetch 注入；`main` / `vision` / `image` 复用同一个 provider 时共用这条代理

### 7. 主人与陌生人

- 私聊只认 `MASTER_QQ`，陌生人一律不回、不记录进 transcript
- 群消息只认白名单（`GROUPS`），名单外的群一律不进
- 入站 @ 是结构化信息：入站解析把 `@鱼` / `@别人` / `@全体成员` 分开（`mentions[]` 的 `kind: bot | other | all`），
  兼容字段 `mentionsBot` 仍只表示「@ 了鱼」；模型看到的是「@了你 / @了别人 / @了全体成员」的标注，
  只 @ 别人时会明确写「这些都不是在叫你」，免得把别人的对话当成点名
- 名单内判定一行版：任何人 @（含裸 @）必答；回复合集必答 → 特别关注者**先掷随机门**（中了直接回），没中再过 60s 门（冷却够也回）→ 其余消息（含主人的非 @）走**限流**：同一群两条被处理消息之间至少隔 `ambientMinIntervalSeconds`（默认 60 秒）
- 为什么不是随机门：沉寂很久突然有人说话时，随机门可能一声不吭；限流模式下「安静久了的第一条必进」，更像有人在听。打分闸、作息/配额/冷却早已下线；鱼想沉默也可以在门内不调 say
- **闸放行 ≠ 立刻提交**：放行的群消息按「群 + 发送者」攒 **5 秒静默**（窗口固定，没有环境变量、没有最长等待），
  同一发送者的新消息取消旧计时并继续加长，不同发送者互不干扰；静默满 5 秒才把整组提交一次
- 整组语义：**最后一条是引用锚点**（A-B-A 里 B 只能进背景，不可能顶掉 A 的位置）；整组里任意一条 @鱼 → 整组必答；
  整组里任意一条是回复 → 这一轮仍然引用。锚点之前的群消息最多取 **10 条**做背景，整组不会在背景里重复出现
- 不走这条回复延时的三条路径：主人的 `/` 指令（闸前机械回执）、私聊（保持即时语义）、GIF 静默收图轮
  （群里来 `.gif` 时起的静默轮，只判断收不收表情包，这一轮不许说话）
- 待定窗口只活在内存里：重启时没 flush 的窗口直接丢弃，宁可少答一句，也不要补一句陈年旧话

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
- `meme` 工具参数是 `mood`（字面量联合：一级情绪词，或特殊分支「按标签」）+ 可选 `tags`（二级筛选，能力给到、不引导使用）；
  「按标签」不属于一级词表，只用于目标不是情绪时按 tags/caption 全库检索，且必须至少一个 tags（缺失按 tool error 拒）；
  一级词表本身与 `meme_add` 至少一个一级词的机械约束不变
- 系统提示里的「表情包库存」section 每次请求现算（每个词几张），空库不占位
- 一级词查空时退回字面匹配兜底——防止迁移没跑完就把功能变哑
- **本地批量导入**（2026-10 新增）：主人把图放进 `<MEDIA_ROOT>/meme-inbox/`，在群里让鱼导入；
  鱼先调 `meme_import` 登记（固定目录、每批最多 50 张、`cursor` 续批），再**逐张** `look`（导入轮额度 = manifest 数量，
  上限 50；普通轮仍然只有 2 张），最后由**主模型**结合当前群聊逐张调 `meme_add` 打标
- 清单只属于当前 round：换轮/异常/中断都清掉，跨轮、不在清单里、或没在本轮成功 look 过的
  `meme-inbox/` 引用会被 `meme_add` 拒；
  群友不能借这条路径收本地图（`meme_import` 与本地导入的 `meme_add` 都只认主人触发的轮）
- 仍然保留：md5 去重（同一张内容不重复入库）；群里 `.gif` 的自动收图（静默轮，只认 `inbound/` 的动图，
  不能拿来绕开本地导入的清单）
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
npm test           # 86 项，含上面每条约束的兜底
npm run prompts    # 列出 prompt 文件 + sha256 + 19 个工具包（TOOL.md 摘要/Schema/eager/deferred）+ 内嵌扫描结果
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
