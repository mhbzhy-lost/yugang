# prompt/

模型能看到的文字分两处：人格与共享文案在这个目录，每个工具的说明、参数 Schema 和使用指南
在 `src/tools/<name>/TOOL.md`（格式合同见仓库 `AGENTS.md` 第 2 条）。改动任何一处都等于改动鱼的行为，
所以让它可 diff、可审查。

| 文件 | 去哪 | 什么时候生效 |
|---|---|---|
| `runtime.md` | system prompt 的 `runtime` section：输入信任边界、出口协议、渐进加载，人格无关 | 每次请求 |
| `persona.md` | system prompt 的 `persona` section | 每次请求 |
| `ops.md` | 运维书，管理工具（`model` / `restart`）的使用约束，system section `ops` | 每次请求 |
| `people.md` | 人物档，随每条请求注入（system section `people`） | 每次请求 |
| `group-profile.md` | 群档案模板，建会话时渲染一次写进 transcript | 每个群第一次 |
| `handoff.md` | 上下文压缩时让模型写备忘的提示词，`{{transcript}}` 处填入对话 | 换页时 |
| `messages.md` | 共享文案：拒绝理由 + 发送回执 + section 标签（含 tool_catalog / tool_search 的模板行） | 被拒/成功时 |
| `meme-tags.md` | 表情包一级情绪词表（受控词表，动态解析进 `meme.mood` 的 enum） | 每次请求 |

现在实际在用的文件：`runtime.md`、`persona.md`、`ops.md`、`people.md`、`group-profile.md`、
`handoff.md`、`messages.md`、`meme-tags.md`、`personas/*.md`。
工具说明不在本目录：它们唯一来自 `src/tools/<name>/TOOL.md`（顶部摘要 + `---tool-schema`
严格 JSON Schema + 正文使用指南），由 `src/tools/loader.ts` 注册；旧 `prompt/tools/*.md`
平铺文档已删除，不要再建。
`npm test` 会检查两件事，防止这里变成垃圾堆：

- `messages.md` 里每一条都必须被代码引用（错误码集合 ∪ `messages["x"]` 字面量）
- 每个 `src/tools/<name>/TOOL.md` 都要对应一个真实注册的工具（manifest ↔ loader 名单双向校验）

规则：

- `{{name}}` 是严格替换，缺变量直接抛错——不允许半渲染的 prompt 上线
- `messages.md` 一行一条 `key: text`，缺 key 会在启动时报错；工具回执只引 key，不在代码里写文案
- `src/` 里不允许出现大段 prompt 字面量，`npm test` 会扫描（阈值：单条字面量 ≥ 12 个汉字）；
  `TOOL.md` 是唯一例外——它本来就是模型侧文字，只是随工具包放在 `src/tools/<name>/` 里
- **加一个工具 = `src/tools/<name>/` 放 `TOOL.md` + `tool.ts`，并在 `src/tools/loader.ts` 的
  factory 名单加一行**，没有第三种位置；除 `say` / `react` / `tool_search` 外都默认 deferred，
  模型先 `tool_search` 搜到才能用
- 想要看到实际渲染结果（含全部工具包、runtime、tool_catalog 与 eager/deferred）：`npm run prompts`

## pi-durable 自带注入的处理

- **compaction 已禁用**（`settings.compaction.enabled = false`）。否则上下文超限时库会中途注入一段
  它自己的总结提示词，我们既看不到也改不了。
- **system prompt 的 section 全部来自本项目扩展**。pi-durable 不添加任何内置 section，
  transcript 里的 `pi.system` 只会出现 `runtime` / `persona` / `tool_catalog` / `ops` / `people`
  / `watched` / `meme_tags`（后两者按需占位）。
- 剩下两处库内固定文本无法覆盖，已记录在此以备审查：
  - `Tool result unavailable: history ends before this call completed.`（上下文被截断时的占位）
  - 工具被 harness 拦下时写入的 `<harness>[error] ...</harness>` 包裹格式
