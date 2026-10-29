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

工具面（当前三个）：`say`（出口，可拆条/引用/带图）、`react`（只贴表情）、`look`（看群里的图）。

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
- 名单内判定一行版：任何人 @（含裸 @）必答 → 非 @ 消息（不分主人）先过 AMBIENT_CHANCE 随机粗筛 → 筛过的过一次便宜打分（prompt/gate.md）才进；作息/配额/冷却已下线，鱼想沉默也可以在门内不调 say
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

## 命令

```bash
npm test           # 48 项，含上面每条约束的兜底
npm run prompts    # 列出所有 prompt 文件 + sha256 + 工具说明 + 内嵌扫描结果
npm run probe      # QQ 侧验收：连 OneBot、报身份和群、发测试消息
npm run ops status # 数据目录 / 幂等表 / 原话簿概况
npm run creds show  # 凭据状态（只有长度）
npm run ping        # 模型连通性 + 用量（不打印 key）
npm start          # 真跑（自动读 .env）
```

运维细节（怎么排查不说话、怎么复盘某天某个群）在 `.agents/skills/ops/SKILL.md`。

`npm run prompts` 是审查入口：改完 prompt 先跑它，确认清单和你想的一致。

## 提交前

1. `npm test` 全绿
2. `npm run prompts` 里没有意外条目
3. 改了 prompt 的，commit message 说清楚改了什么行为——prompt 就是这个项目的行为定义

## 已知欠账

- 语音、长文转图、合并转发、入群审批都没做
