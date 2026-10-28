# prompt/

模型能看到的每一个字都在这个目录里。改动这里等于改动鱼的行为，所以让它可 diff、可审查。

| 文件 | 去哪 | 什么时候生效 |
|---|---|---|
| `persona.md` | system prompt 的 `persona` section | 每次请求 |
| `skills.md` | system prompt 的 `skills` section，`{{skills}}` 处填入手艺清单 | 每次请求 |
| `tools/say.md` | `say` 工具的 description + 参数说明 | 每次请求（工具定义） |
| `tools/bash.md` | 覆盖 pi-durable 自带的 `bash` 说明 | 每次请求 |
| `tools/read.md` | 覆盖 pi-durable 自带的 `read` 说明 | 每次请求 |
| `messages.md` | 工具回给模型的文案：拒绝理由 + 发送回执 | 被拒/成功时 |

规则：

- `{{name}}` 是严格替换，缺变量直接抛错——不允许半渲染的 prompt 上线
- `messages.md` 一行一条 `key: text`，缺 key 会在启动时报错
- `src/` 里不允许出现大段 prompt 字面量，`npm test` 会扫描（阈值：单条字面量 ≥ 12 个汉字）
- 想要看到实际渲染结果：`npm run prompts`

## pi-durable 自带注入的处理

- **compaction 已禁用**（`settings.compaction.enabled = false`）。否则上下文超限时库会中途注入一段
  它自己的总结提示词，我们既看不到也改不了。
- **system prompt 的 section 全部来自这里**。pi-durable 不添加任何内置 section，
  transcript 里的 `pi.system` 只会出现 `persona` 和 `skills`。
- 剩下两处库内固定文本无法覆盖，已记录在此以备审查：
  - `Tool result unavailable: history ends before this call completed.`（上下文被截断时的占位）
  - 工具被 harness 拦下时写入的 `<harness>[error] ...</harness>` 包裹格式
