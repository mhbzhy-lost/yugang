# AGENTS.md

给改这个仓库的人（和 agent）看的维护约束。里面每一条都有对应的测试兜底；改了代码记得跑 `npm test`。

## 这是什么

一条活在 QQ 群里的鱼，跑在 pi-durable 上。一个 Conversation = 一个群。

```
群消息 → 闸（规则：@ 必答 / 其余非 @ 一律进自由拍收集器（2026-11-06 合并，开窗两态已退役））
       → 按发送者静默 10 秒合并（同一发送者整组提交，最后一条是引用锚点）
       → conversation.submit() → agent loop
                                 ├── thinking / 正文 / tool 调用  ✗ 不出境
                                 └── say_* / react / look
                                       ✓ 硬校验 → QQ
```

工具面：`say_words`/`say_media`/`say_meme`/`say_voice`（四个出口工具，共享每轮 3 次调用额度：
文字/图片/表情包/语音各一个，可引用，除语音外可点名 @ 群友）、`react`（只贴表情）、
`look`（看群里的图）、`meme`/`meme_add`（表情包检索与收录）、`meme_import`（主人本地批量导入的登记入口）、
`draw`（本地 SD 生图）、`gpt_image`（GPT Image 2 透传）、`search`/`video`（联网查）、
`bili_hot`/`bili_video`（自主浏览候选与元数据核实，实际观看走 `video`）、`tags`（danbooru 词表）；
以及主人专属的 `read`/`grep`/`write`（草稿区）、`tree`、`config`（改 fish.config.json 受控字段与 models 角色表）、`watch`（特别关注）
与 `restart`。

`draw` 使用 Windows ComfyUI 的固定 V8 API 工作流（`src/tools/draw/workflow.json`，SHA-256 固定校验），
通过 `COMFYUI_URL` 指向 macmini 的 `127.0.0.1:18190` SSH 隧道；不接受模型传入工作流、节点、模型名或地址。
文生图按初采样 30 步 → 可选手部修复（`hand_repair`，默认关）→ RealESRGAN anime_6B 2 倍超分 → 二次采样 30 步 → 人脸修复 → `PreviewImage` 输出；
文生图可选受控 `ratio`，默认 3:4；改图沿用参考图比例（尺寸对齐可能略有偏差）。文生图和改图默认均为 2 倍。`hsr` 用固定 LoRA 权重 0.7 经 28→52 层映射，
效果需人工确认；`ref` 是整图重绘，不是蒙版局部编辑，同样默认使用 RealESRGAN 2 倍超分与二次采样。图片通过 `type=temp` 取回本地 `gen/`，
Windows 输入上传限定 `yugang-ref-<uuid>.png`；计划任务 `Yugang-ComfyUI-RefCleanup` 使用
`scripts/comfy-ref-cleanup.ps1` 的对应副本，每小时在登录用户会话中尝试清理 24 小时以上专用文件，
ComfyUI 忙或队列状态不可用时不删除，不触碰其他 input。部署前须核对该任务与脚本已安装且可运行。
提交状态不明的画图在当前轮禁止重试，避免网络超时造成重复任务。

双人图固定走 `workflow-rs.json`（SHA-256 固定校验）：`RSMultiCharacterPrompts` 以左右点位
（0.4/0.6, 0.5）给两人独立提示，公共提示机械保证以 `2girls` 开头，`RSMultiCharacterSampler`
一次完成 30 步初始生成（seed 每次提交前随机），
之后 AnimeSharp 2 倍超分、低强度全图采样（16 步 / 0.30）与脸修（20 步 / 0.25）；**不做手修**。
双人请求可在 `characters[].character` 挂各自的角色 LoRA（映射到 `RSMultiCharacterPrompts` 的
`characterN_lora` 字段），不做 YOLO/SAM 分割、没有 Impact 回退分支。
`hand_repair` 只作用于单人图。

**入口只注册**（2026-11-05）：`src/index.ts` 不写任何业务逻辑，只有 `app.use(...)`
（消息链顺序）、`app.onFlush(...)`（debounce 整组提交）、`app.onStart/onStop(...)`
（启动/退出）和最后的 `bootRuntime()` / `app.start()`。实现都在 `src/app/runtime.ts`；
壳子 `src/app/app.ts` 零业务依赖。`test/index-registration.test.ts` 会挡住函数定义、
控制流和消息链顺序变更——想加入口逻辑，先把它放进对应的中间件或生命周期钩子。

**装配器也是注册表**（2026-11-05）：`src/harness.ts` 只有一排 `.install(...)`（工具面 →
扩展 → Harness → 启动迁移 → 压缩器 → drain → 记忆审批 → group → compact/enqueue/close），
每个 installer 一个文件在 `src/fish/`，链式执行器在 `src/fish/assembly.ts`。
`test/harness-assembly.test.ts` 锁住 install 顺序与“入口不再长逻辑”。新增能力 = 新 installer +
`openFish` 里加一行，不要把逻辑塞回 `harness.ts`。

**长期记忆按关注点拆在 `src/memory/`**（model / patch / pending / publicize / query / merge /
render），`src/memory/index.ts` 只是 barrel；安全边界注释在 `src/memory/model.ts` 顶部，外部
importer 继续从 `./memory/index.ts` 取，导入面不变。

## 硬约束

### 1. 模型能看到的文字只有两个来源：`prompt/` 下的 markdown 与 `src/tools/<name>/TOOL.md`

- 人格、运行时协议、宿主/共享层文案（`prompt/messages.md`）、压缩用的 handoff 提示词全在 `prompt/` 里；
  每个工具的说明、参数 Schema、使用指南与工具专属回执文案唯一来自 `src/tools/<name>/TOOL.md`（见第 2 条）
- 10 秒合并与入站 @ 的标注也一样：背景栏（`ctx_*`）、整组标记、要回的那一行、`@了你 / @了别人 / @了全体成员`
  全在 `prompt/messages.md`；`src/qq/debounce.ts` / `src/qq/gate.ts` 只负责拼装，不写文案
- `src/` 里不允许出现大段 prompt 字面量。`npm test` 会扫描（阈值：单条字面量 ≥ 12 个汉字）；
  `TOOL.md` 是唯一例外——它本来就是模型侧文字，只是随工具包放在 `src/tools/<name>/` 里
- 模板用 `{{name}}` 严格替换，缺变量直接抛错
- 想加宿主/共享层文案，加进 `prompt/messages.md`；想加某个工具的专属回执，加进它目录下的
  `messages.json`（key 不许与中心文件或其它工具重复，loader 合并时撞车直接启动失败）；
  想加新 prompt，加新文件并接到 `src/prompt/index.ts`

### 2. 工具 = `src/tools/<name>/TOOL.md + tool.ts` 工具包

**这是本仓库最容易违反的规则：模型能看到的工具说明只来自 TOOL.md，代码里不写第二份。**

- 一个工具包 = `src/tools/<name>/` 下的四件套：`TOOL.md`（frontmatter 摘要 + 使用指南）、
  `schema.json`（严格 JSON 参数 Schema）、`messages.json`（可选，工具专属回执文案）、
  `tool.ts`（实现）；目录名 = manifest `name` = 注册名。缺文件、重复名、目录对不上时
  `openFish()` 直接抛错起不来；`src/tools/loader.ts` 启动时做
  manifest ↔ factory 的双向一一对应校验，孤儿文档和没文档的实现都算错
- `TOOL.md` 只认 `name` + `description`（一句摘要）；`schema.json` 必须是**严格 JSON**
  （不许注释、尾逗号、远程 `$ref`），里面的 `parameters` 是唯一参数 Schema；
  `messages.json` 是严格 JSON 对象（`key: 文案`，key 名只认 `[a-z][a-z0-9_]*` 且不重复、
  文案非空，可含 `{{var}}`；文件可选）
- 解析与动态词表在 `src/tools/manifest.ts`：TOOL.md frontmatter / schema.json / messages.json
  都在这里严格解析（TOOL.md 正文里出现旧块围栏直接报错）；
  唯一受控扩展是 meme `schema.json` 里的
  `"x-yugang-enum-from": "memeTags"`（启动时按 `prompt/meme-tags.md` 机械换成 enum），
  其它运行时改写模型所见 Schema 的通道一律拒绝
- 工具面分两层：四个 `say_*` / `react` / `tool_search` 初始可见（eager），其余已启用工具统一 `deferred: true`；
  模型先用中文/英文检索 `tool_search`，命中后从下一次模型请求起才能调用。`runtime` section
  （`prompt/runtime.md`）负责这条渐进加载协议，`tool_catalog` section 只列已启用工具的 `name + 摘要`
- 加一个工具 = 三处改动，缺一不可：

```
1. src/tools/<name>/TOOL.md     摘要 + 使用指南
2. src/tools/<name>/schema.json 严格 JSON 参数 Schema
3. src/tools/<name>/messages.json 工具专属回执文案（可选）
4. src/tools/<name>/tool.ts     defineTool，窄接口，Schema 只消费 manifest
5. src/tools/loader.ts          FACTORIES 名单里加一行
```

- 主人专属工具（`read`/`grep`/`write`/`tree`/`config`/`restart`/`watch`/`meme_add`/`meme_import`）
  没配 `MASTER_QQ` 时 factory 返回 `undefined`，不进 `agent.tools` / `agent.deferred` / `tool_catalog`；
  `TOOL.md` 仍随包存在，注册与否由 loader 按依赖现判，执行内核里的二次身份校验不变
- 旧 `prompt/tools/*.md` 平铺文档已删除，不要再建；工具专属回执/拒绝文案走各自 `messages.json`，
  宿主/共享层文案（出口策略码、fs 共用拒绝、`working_*`、`ctx_*`、`/` 指令回执等）
  继续走 `prompt/messages.md`。loader 启动时把两边合并成全局 messages 视图，消费侧统一
  `deps.prompts.messages["key"]`，任何 key 撞车（工具↔工具、工具↔中心）直接启动失败
- 审查入口：`npm run prompts` 列出 prompt 文件、全部工具包（路径/sha256/摘要/Schema 属性/文案 key/eager/deferred）、
  工具文案归属（中心条数 + 各工具块条数）、runtime 与 tool_catalog section、源码内嵌扫描结果

### 3. 能力面必须是可枚举的窄接口（2026-10 修订：主人解锁下有限自改）

禁止 shell / 脚本执行 / MCP server。读写与自改另设语义工具（`read`/`grep`/`write`/`tree`/`config`/`restart`）：
- `read` / `grep`：可读仓库与 `/tmp/yugang`；.env、config/auth.json、.git、node_modules、.trash 硬封禁
- `write`：**只能写 `/tmp/yugang`**（鱼的草稿区），仓库文件写不进去
- `config`：统一配置工具，仅主人私聊轮可用（群内轮拒绝）；改 `fish.config.json` 受控字段（白名单制，逐字段标注热加载 / 需重启，非法值拒绝不落盘）与 `config/models.json` 的 `models` 角色表（main / vision / vision_fallback / image，写完靠 `restart` 生效）；`models_probe` 可在切换前对任意已配置对话模型发一次最小真实请求，不改角色表，stopReason error/aborted 或空文本均判失败，错误文本先抹除凭据
- 身份闸（机械判定）：仅主人（MASTER_QQ）触发的轮里可用，execute 内核对 triggerOf 的 userId
- 全部操作打审计日志；自改大事故靠 git 回滚
- `meme_import`：只扫**固定目录** `<MEDIA_ROOT>/meme-inbox/`（不接受任何路径参数），只认图片直系子文件，
  符号链接 / 目录 / 非图片 / 超限一律跳过并逐项报给模型；仅主人触发的轮可用；每批最多 50 张，`cursor` 续批，
  同一轮的清单合并保留；登记结果只写入本轮 manifest，round 结束即清

主会话有一条条件式 inline 直读通道（docs/plans/2026-11-01-inline-vision.md）：`models.vision` 解析结果 == `models.main` 且 main 的 api 在白名单（`google-code-assist` / `antigravity-code-assist` 真机验证过；`openai-completions` 即 zai/deepseek 2026-11-02 经主人决定放开——describe 路径本就向该通道发 image_url，且附图已压到 ≤50KB；codex 适配器不支持图片输入，仍排除）时，锚点消息的图经压图（`src/media/shrink-image.ts`：1280px 上限 / 50KB 阈值 / q80 只降分辨率）后以 image block 直接附在本轮 user message 上（普通轮 ≤8 张，直发图优先、被回复的引用图排在后面；ref 缺失/压图失败跳过不阻塞）。**GIF 走抽帧多 block**（2026-11-06 实测：glm 网关对 image/gif 只解码首帧，token 按首帧分辨率计费、与体积帧数无关）：`src/media/gif-frames.ts` 等距抽 2-4 帧（按时长自适应、含首末）、每帧压到长边 ≤640px JPEG（静态图是 1280px），一个 GIF 占 1 个编号 N 个 block；行内标签带 `·动图N帧`、末尾标签声明帧序与同一性（社区实践：Qwen fps 语义 / MiniCPM image_id）；抽帧失败降级首帧。`/关看图` 同时关掉 inline 附图（止损：当年 zai 网关曾被无压图的大图撞挂）。图进 transcript 但换页即丢弃、摘要永远只吃文本。**编号标签始终带 inbound 路径**（`[图片#N inbound/…]`）：模型可直接把路径填给 draw / gpt_image，读图不必 look。**被回复的引用图两种读图模式都要给到模型**：inline 模式编号成 `[图片#N inbound/…]` 附压缩图（answer 轮与开窗 shard 批共用），look 模式在 `[引用原文]` 里保留 `[图片 inbound/…]` 并触发 look 提示（2026-11-05 修复：此前 `quoted.images` 从不渲染，回复一张图说「收图」时模型拿不到引用，收不了）。

读媒体目录的入口只有两处：`look` 只把图描述成文字；`draw` 的 `ref` 只读一张 `inbound/` 或 `gen/` 的图片当 img2img 初图。`look` 的额度：**普通一轮最多 2 张**。
唯一的受控例外是**导入轮**——主人本轮调过 `meme_import`、且这张图就在本轮 manifest 里时，
额度放宽到 manifest 数量（硬上限 50 张），可以逐张看、逐张用 `meme_add` 收。
这**不是**通用文件读取的回归：目录固定、身份固定（主人）、清单只活一轮、图仍然只从 `MEDIA_ROOT` 里读，
而且 `meme_add` 对本地导入的 ref 会机械核对「本轮 manifest 里有它、且这一轮模型真的见过它」
（inline 模式 = meme_import 结果里直接附过图并记 seen，fallback 模式 = look 过）。
**look 在 inline 模式（vision==main）下被机械锁死**（2026-11-06 主人裁定）：execute 入口直接拒绝，
图全部 inline 直读（普通轮/导入轮/ambient 轮的 GIF），没有任何剩余场景；fallback 模式照旧。
**导入轮 inline 化**：meme_import 结果直接附清单图（每批 ≤12 张、cursor 续批）并全部记 seen，
meme_add 的机械校验链零改动（「seen」语义覆盖两种模式）。**GIF 收录随 ambient 轮**
（静默收图轮已退役）：动图抽帧直附上下文 + 行内双边收录标记，收不收当场判断；
fallback 模式保留 inbound 路径由 look 转述。

原因：这些都是一条「通往一切的边」，而群里坐着的是可以被 prompt 注入的陌生人。
一个工具的危险性应该写在它的 `execute()` 里被人读到，而不是藏在模型能拼出来的命令行里。

要加读取能力，加「读某个确定目录下的某个确定文件」的工具，不要把通用 read 放回来。

### 4. 出口只有一族

- 只有 `say_words` / `say_media` / `say_meme` / `say_voice` 能把东西发到 QQ，且都必须
  `callers: ["model"]`（脚本/嵌套调用不能绕）；四工具共享每轮 3 次**调用**额度（无豁免、
  被拒不计数），额度规划守则（画图/表情包/语音保开口防吞）在 `prompt/runtime.md`
- 任何新增工具都不许直接调用 `emit()`
- 校验失败必须以 tool 错误返回给模型（文案来自 `prompt/messages.md` 或该工具 `TOOL.md` 的 tool-messages 块），不许静默丢弃
- 主动 @ 不是第二个出口：它是 `say_words` / `say_media` / `say_meme` 的 `mentions` 参数
  （去重后最多 3 个纯数字 QQ 号；图片消息 @ 段挂图前），并随 outbox 一起持久化——
  重启补发还是同一条 @，不会静默降级成裸消息
- 主动 @ 的机械边界：禁 `all`/非数字；只能 @ **当前群的真实成员**（宿主现拉群成员名单核对，拿不到名单就拒）；
  `say_voice` 没有 `mentions` 参数（语音没有文本气泡，@ 等于静默丢人）
- 主动 @ 的身份闸按轮类型：answer 轮沿用「被点名」语义——只有**主人**或**当前群的
  特别关注者**叫你点名时才可以 @，其余一律以 tool 错误返回；私聊里没有「@谁」这回事，同样拒绝。
  ambient / injection 轮（自由拍 / 主动交流机会）没有「被点名」一说，为白名单制：
  @ 目标 ∈ {主人} ∪ 本群特别关注者且为真实成员即可，宿主记审计日志。已接受的放宽面：自由拍内
  普通群友可诱导鱼 @ 主人/特别关注者（拍子本就是自由交流时段，白名单外的目标仍被机械拦截）。
  号码应优先从可信上下文（「昵称(QQ)」背景行）填写，机械校验确认纯数字与
  当前群成员；来源本身靠 prompt 引导，代码不校验号码抄自哪句话
- 结构校验与溯源校验都是机械判定，不做「看起来像不像 AI」的猜测

### 5. 压缩走自己的实现（2026-11 重构：剖面卡片 + transcript 尾巴）

- **换页只按 token 阈值**（2026-11-07）：最近一次普通模型请求的 `input + cacheRead` 达到
  `compact.maxTokens`（缺省 100000）或 `compact.byModel` 的 provider / provider/model 覆盖值
  （`google-antigravity` 缺省 90000）后，等完整轮次结束再换页；不按消息条数/字数，不截断当前消息。
  旧 `maxEntries/maxChars` 仅作退役告警，不参与触发。config set 支持对象 JSON 字符串和点路径合并写入
- **禁止打开 pi-durable 内置的 compaction**（它会在中途注入库里写死的提示词，不可审查）
- 压缩 = `src/compact.ts` 的换页 + `prompt/handoff.md` 的剖面提示词 + `prompt/messages.md` 的渲染模板（时间头与卡片，降级与剖面共用）
- 换页新页结构 = **剖面卡片（≤300 字）+ 被压缩页尾部最近 50 条标准历史消息**：卡片字段 = 本页时间范围（纯机械）、活跃成员 top≤5（纯机械统计 fish.inbound 结构化数据）、进行中的话头/梗 ≤5（LLM 逐字引用原文短语附 [m:id] 锚点，禁转述）、这个群员的未完话头与承诺（LLM 逐字引用）、氛围一行（LLM）；**尾巴只从被压缩页 transcript 机械投影**（不碰 recent/chatlog，不把鱼没见过的消息伪装成已读），保持真实 entry 顺序，统一为 `[历史消息]` + 标准消息列表，引用/合集附件后置；旧窗口说明、旧账、工具过程不进尾部，旧数据缺真实 ID 时不伪造。engage_tick 背景板行也进尾巴（T12 裁定：背景板也是模型见过的内容），但不进摘要输入
- 三道机械防线：逐字引用 substring 校验（quote/锚点必须命中本页 transcript 或上一页剖面原文，否则丢条目）；事务性（卡片校验通过才 reset，失败保留原页）；有界重试（3 次）耗尽走机械降级换页（时间头 + 尾巴原文，共用 `mechanicalTail` 纯函数，任何模型不再参与），不许在失败页死循环
- 跨页字段级合并：上一页剖面从 pi.reset head 提取（提取失败按首换页处理），还开着的话头/未兑现承诺 verbatim 带入、完结的标掉，不重新叙事、不 summary-of-summary
- 摘要只收「群友的话 + 鱼发出去的话」；thinking、tool 调用、tool 结果、stopReason:error 的空 assistant entry 一律不进摘要也不进尾巴；inline 附图的 image block 同样不进（compact 的 entryText 只取 text block），随换页退出活跃上下文

### 6. 模型与凭据

- **模型选择只有一个入口**：`config/models.json` 的 `models` 角色表（`main` / `vision` / `image` / `vision_fallback`）。
  不允许用环境变量或启动参数选模型；旧 `default` 键会直接报错
- **配置是本机文件**：`config/models.json`（gitignore，每台机器一份）写 models 角色表、provider 地址、模型清单、
  网关兼容值；模板是 `config/models.example.json`（进仓库），首次使用 `cp config/models.example.json config/models.json`
- **凭据也是本机文件**：`config/auth.json`（gitignore，权限 600），只由 `npm run creds import` 写入；运行时**不读** `~/pi-config`
- **动图需要另一条通道的 key**（2026-11-05）：`gpt_image` 的 `output_format: "gif"` 走 `api.openai.com`
  （官方 Images API，按张计费），key 放 `config/auth.json` 的 `openai` 条目（`api_key`）；
  Codex 订阅后端对任何 2.6 型号的 GIF 请求都返回 `400 GIF output is not enabled for this request`，
  没有 key 时工具回执会明确说「只能出静态图」。`OPENAI_BASE_URL` 只作 API 根地址覆盖（可选）
- **所有路径只有一个基准：仓库根**（`src/paths.ts` 的 `REPO_ROOT`，可用 `YUGANG_ROOT` 显式覆盖，
  不填按源码位置推导）。数据目录 `DATA_HOME`、媒体 `MEDIA_ROOT`、工作区 `WORKSPACE_ROOT`、
  prompt `PROMPT_ROOT`、`fish.config.json`、`config/models.json` 全部从它派生；
  `src/` 与 `scripts/` 都从这里取，**不许再各自拼相对路径**（2026-11-05：runtime 搬进 `src/app/`
  后按 `..` 算根，数据目录漂到 `src/var`，线上跑空库两小时而运维脚本还在读旧库）
- 默认数据目录是仓库 `var/`（可用 `YUGANG_HOME` 整体覆盖），只放运行时产物
  （`fish.db` / `chatlog` / `media` / `sent.json`），不放凭据、不放配置；启动日志会打一行
  `[鱼缸] 数据目录 …`，路径一对不上先看它
- 协议端配置由 `scripts/protocol.ts` 生成，**路径随平台**：macOS 在 QQ 容器目录，其它在 `var/protocol/napcat`
- 不要在 `config/models.json` / `config/models.example.json` 里写 key，`npm test` 会扫模板
- **key 只在内存里**：不进 prompt、不进 transcript、不进日志。`describeModel()` 只报"已加载 / N 字符"和来源路径
- 网关兼容值（`maxTokensField: max_tokens`）由 `src/model/config.ts` 的 `withCompat()` 兜底，模型自带 compat 可覆盖
- 换模型：编辑 `config/models.json` 的 `models.main` / `models.vision` / `models.vision_fallback` / `models.image`
  （`vision` 省略 = main，`image` 省略 = `gpt_image` 不可用，`vision_fallback` 省略 = 无兜底），改完让鱼 `restart` 生效；没有 `MODEL_PROVIDER` / `MODEL_ID` / `GATE_*` / `VISION_*` / `YUGANG_MODELS` 这类入口
- 验证：`npm run creds show` / `npm run ping`（都只报长度，不打印 key）
- **provider 级代理**：`config/models.json` 的 `providers.<id>.proxy`（只认 http/https）。配了它，这个 provider
  的**全部**请求走隧道（模型流、`gpt_image`、内部 OAuth 刷新），其它 provider 与 SD/QQ 仍直连；
  不设进程级的 `--use-env-proxy`（那会把 zai / deepseek 也拖进代理）。codex 过代理必须同时 `transport: "sse"`——
  WebSocket 不吃 fetch 注入；`main` / `vision` / `image` / `vision_fallback` 复用同一个 provider 时共用这条代理。
  google-antigravity（Antigravity 通道）是 AI Pro 订阅的**现通道**——个人账户 2026-06-18 起 gemini-cli
  通道整体停用，新登录一律走它；端点 `daily-cloudcode-pa.sandbox.googleapis.com`，同款 provider 代理
  （token 刷新的 `oauth2.googleapis.com` 一并进隧道）。oauthClient 同样只放本机 `config/models.json` 的
  `providers.google-antigravity.oauthClient`（模板空串占位）；登录 `npm run login -- google-antigravity`，
  回调页是 `http://localhost:51121/oauth-callback`，无头机打不开是正常的，把地址栏整条 URL 复制回来。
  2026-11-07 实测：旧 `antigravity/1.11.5` 与旧 Gemini x-goog/client-metadata 头会被整通道拒绝，
  现按真实平台发送当前 IDE User-Agent；`providers.google-antigravity.userAgent` 可覆盖完整值，
  端点必须保持 sandbox（生产端点实测 429）。`npm run ping` 对 stopReason:error/aborted 必须非零退出
- **OAuth client 常量只放本机配置**：Antigravity 的 id/secret 只写本机 `config/models.json` 的
  `providers.google-antigravity.oauthClient`（模板留空串占位），源码里不出现——git 里含明文 client 会被
  GitHub push protection 拦推送；登录成功后 client 随凭据落盘（`config/auth.json`），token 刷新从
  凭据自带字段读，不依赖启动配置

### 7. 主人与陌生人

- 私聊只认 `MASTER_QQ`，陌生人一律不回、不记录进 transcript
- 群消息只认白名单（`GROUPS`），名单外的群一律不进
- 入站 @ 是结构化信息：入站解析把 `@鱼` / `@别人` / `@全体成员` 分开（`mentions[]` 的 `kind: bot | other | all`），
  兼容字段 `mentionsBot` 仍只表示「@ 了鱼」；模型看到的是「@了你 / @了别人 / @了全体成员」的标注，
  只 @ 别人时会明确写「这些都不是在叫你」，免得把别人的对话当成点名
- **指向性标签（2026-11-05）**：单条消息只要 @ 了别人、或引用了别人的消息（且没 @ 鱼），
  消息行就多一个 `[此消息的接收对象是X，不是你]`（`prompt/messages.md` 的 `message_target_other`，
  标签顺序 `m → 回复 → 转发合集 → @ → 接收对象 → 主人/特别关注`）。**@ 与引用同时出现以 @ 为准**；
  `@鱼` 走 `[这条消息@了你]` 不加这个标签，`@全体成员` 也不加（它本来就包含鱼），引用的若是
  鱼自己发的消息（`quoted.fromSelf`，入站按 `self_id` 机械判定）同样不加。名单由解析层给出、
  渲染层只做格式，模型侧不参与判断
- 名单内判定一行版（2026-11-06 合并：自由活动模式是唯一搭话机制，开窗两态已退役）：
  任何人 @（含裸 @）必答；其余非 @ 群消息一律 `enter:free_pass` 进自由拍收集器；无 @ 的
  自带/引用合集仍 `skip:next_pending` 零成本拒掉。回复合集不构成例外（回复鱼或回复合集都只是
  引用动作，决定回复与展开的都是 @）。`@全体成员` / `@别人` 不置 mentionsBot，天然按非 @ 处理
- **自由拍是默认搭话行为**（`src/qq/engage-next.ts` 状态机，每 tick 现读配置，群表直取 `.env GROUPS`
  ——安全域即行为域）：非 @ 消息按 `engage.freeSeconds`（缺省 60 秒，15–3600，热加载；
  `engage.byGroup` 可按群号差异化覆盖——大群单独拉长拍/收紧上限，未覆盖回落全局）一拍合并成
  一轮 ambient——**空拍不提交**（拍子继续走），单拍超过 `engage.freeBatchMax`（缺省 50）时丢最旧、
  计数进日志（收集器唯一的有损点）。@ 仍走 10 秒必答通道；会话在途时整拍并入下一拍，**有正在攒的
  @ 组时本拍让行**（`yieldTo`）。空拍才掷一次自主门 `engage.freeBrowseChance`（缺省 0.03，清醒时段
  ≈31 次/天上限，宵禁恒关），门开才提交 `[主动交流机会]`；掷门与提交同拍、忙则不掷。
  **宵禁（本地 00:00–08:00）拍内不提交也不掷门**（消息留收集器顺延到早上第一拍，夜间高流量群
  拍间超限丢最旧是接受损耗；@ 必答不受影响，夜里群聊照常进 recent，白天 @ 时作为背景可见）。
  批内消息带 `replyIds`/`quoted`，一拍里能看到 `[回复了m:id]` 与列表后的 `[引用原文]`
  （与 @ 轮同款渲染，批内图统一 inline 编号）
- **搭话输入统一为标准消息列表**：没有 `[这条消息@了你]` 就不构成必答。零新增空拍不再由沉默、
  nudge、旧账或弹药触发，只在空拍一次 `engage.freeBrowseChance` 门开时提交 `[主动交流机会]`，
  当前会话可自行 `bili_hot` 找候选、`video` 实际观看后把「推荐语 + 链接」用 `say_words` 发出去；
  ambient 拍不携带 browse 授权。末条自言禁言的机械边界仍生效（分享素材要带 `share: true`）。
- **闸放行 ≠ 立刻提交**：放行的群消息按「群 + 发送者」攒 **10 秒静默**（窗口固定，没有环境变量、没有最长等待），
  同一发送者的新消息取消旧计时并继续加长，不同发送者互不干扰；静默满 10 秒才把整组提交一次
  （这套按发送者的合并只管 @ 必答轮；非 @ free_pass 消息不进这里，改投自由拍收集器——
  按 `engage.freeSeconds`（缺省 60 秒）一拍，全部发送者合并成一轮）
- 整组语义：**最后一条是引用锚点**（A-B-A 里 B 只能进背景，不可能顶掉 A 的位置）；整组里任意一条 @鱼 → 整组必答；
  整组里任意一条是回复 → 这一轮仍然引用。@（answer）轮背景由 `engage.answerContextSize` 控制
  （可选，热加载）：不设 = 从已读标记（lastSeenByModel）到锚点的**全部未读**（recent 30 条是
  天然上限）；设 N = 锚点前最近 N 条再剔已读，截断外的未读视为已读丢弃。**已读标记不受配置影响**
  （2026-11-06 主人裁定）：每次实际注入群消息的唤醒轮（@ 轮 / ambient 拍）结束都无条件推满到
  recent 末条——锚点后与提交期间新到的消息按已读处理；纯输出任务轮（browse/remind/news）
  不注入群消息、不推标记。@ 轮整组本体不属背景板、照常注入
- **主人不入特别关注名单**：`watch add` 对 master QQ 直接以 tool 错误拒绝，宿主装载/变更名单时再滤一次
  （双保险，旧文档脏数据进不了内存镜像）；主人的消息行带「[主人]」标记（与 [特别关注] 互斥、
  master 优先，「你主人」标注保留），特别关注者带「[特别关注]」锚点行打标
- 不走这条回复延时的两条路径：主人的 `/` 指令（闸前机械回执）、私聊（保持即时语义）
  （GIF 静默收图轮已于 2026-11-06 退役：动图随 ambient 轮进上下文，双边收录标记当场判断）
- 待定窗口只活在内存里：重启时没 flush 的窗口直接丢弃，宁可少答一句，也不要补一句陈年旧话

### 8. 重启必须能接上

- 群 → conversationId 存在 session doc `fish.chats`，`group()` 先查映射再决定建不建
- 待发消息存在 conversation doc `fish.outbox`，出口工具只入队，宿主 `drain()` 负责发
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

- `prompt/meme-tags.md` 是**受控词表**（13 个情绪词），`src/prompt/index.ts` 读成 `memeTags`，代码里不写死
- `meme_add` 打标**必须**含至少一个一级词（机械校验）；自由词随便加，但不参与一级检索
- `meme` 工具参数是 `mood`（字面量联合：一级情绪词，或特殊分支「按标签」）+ 可选 `tags`（二级筛选，能力给到、不引导使用）；
  「按标签」不属于一级词表，只用于目标不是情绪时按 tags/caption 全库检索，且必须至少一个 tags（缺失按 tool error 拒）；
  一级词表本身与 `meme_add` 至少一个一级词的机械约束不变
- 系统提示里**没有**表情包库存 section（2026-11 移除：动态库存每次请求现算，表情库一有增减就
  打穿 openai-completions 前缀缓存）。库存不预告：模型侧由 `meme` 的 TOOL.md 引导直接按一级词
  检索，库存以检索结果为准；检索无命中时的回执（`meme_no_mood` / `meme_no_tag`）仍附带
  当前库存概览，那是 tool 结果不是 system 注入，不影响缓存
- 一级词查空时退回字面匹配兜底——防止迁移没跑完就把功能变哑
- **本地批量导入**（2026-10 新增；2026-11-06 inline 化）：主人把图放进 `<MEDIA_ROOT>/meme-inbox/`，在群里让鱼导入；
  鱼先调 `meme_import` 登记（固定目录、`cursor` 续批：inline 模式每批 ≤12 张且结果直接附图全部记 seen，
  fallback 模式每批最多 50 张、再逐张 `look`），最后由**主模型**结合当前群聊逐张调 `meme_add` 打标
- 清单只属于当前 round：换轮/异常/中断都清掉，跨轮、不在清单里、或没在本轮真正见过（inline 附过 / look 过）的
  `meme-inbox/` 引用会被 `meme_add` 拒；
  群友不能借这条路径收本地图（`meme_import` 与本地导入的 `meme_add` 都只认主人触发的轮）
- 仍然保留：md5 去重（同一张内容不重复入库）。**静默收图轮已退役**（2026-11-06 主人裁定）：
  GIF 不再起专门轮次，随 ambient 轮进上下文（inline 抽帧 + 行内双边标记
  「值得收就用meme_add收它，不值得就不收」，收不收当场判断；fallback 模式 GIF 保留
  inbound 路径由 look 转述）。`fish.gif_ingest` entry kind 只剩历史数据，
  compact 的排除口径继续认它。
- 存量补标：`scripts/migrate-memes.ts`（规则映射）与 `scripts/retag-memes.ts`（flash 读 caption/tags 判词，
  **不许**新增词表外的 tag、不许改 caption，写回前备份 + 重读合并）

### 13. 合并转发合集：三条触发路径

- **展开的唯一前提是 @ 了鱼**，回复本身只是引用动作，不构成指令
- **自带合集且 @**：展开
- **引用合集且 @**：展开被引的那条（`repliedForward` 只在「引用 + @」时置位）
- **@ 且文字提到「合集/转发」**：补展开本群 10 分钟内最近那条没展开的合集（缓存只存 id，不预拉内容）
- 无 @ 的合集（自带或引用）一律零成本丢弃、不进模型（自带合集只记 id 到缓存）
- **背景栏里的合集只留短标记**：一次展开 10 条起，连发十条合集会把上下文撑爆；
  鱼看不到背景里的合集内容是**设计如此**
- 展开结果以 `[转发合集 N 条]` 开头，鱼据此知道这些内容属于一个合集

### 14. 语音

- **音色只认 `fish.config.json` 的 `voices[人格名]`**，没有任何兜底；没配 = 该会话没有语音能力
- 人格解析必须走带 `#人格` 后缀的映射键（`mappingKeys`），`chatKeys` 只存剥离人格的 base 键给路由用
- 触发提示：主人/特别关注对象的过闸轮以 0.3 概率追加一条 `[本轮要求] 必须使用 say_voice 回复` 的任务行；**看到提示必须用语音**
- 出口限制：一轮一条附件（图/表情包/语音互斥）、台词 ≤200 字、超长/含失败一律以 tool 错误返回
- 服务端：GPT-SoVITS 常驻本机（launchd 托管；9884 爱莉希雅 v4 自训 elysia、9881 桑多涅、9882 凯尔希；
  9880 为旧 v2 保留可回滚，9883 为落选 v2ProPlus 试听实例，保留 7 天后回收），依赖 `~/nltk_data` 的
  `cmudict` + `averaged_perceptron_tagger*`——**缺了会返回 200 + 0 字节空音频**（英文 g2p 抛 LookupError）
- 语音实例由鱼缸启动链拉起（`npm run tts up`），plist `RunAtLoad=false` 不开机自启，`KeepAlive` 崩溃自愈；
  状态/拉起/收起统一走 `npm run tts [status|up|down]`，活跃实例集以 `fish.config.json` 的 `voices` 端口为准
  （单一事实源，换端口只改配置不改代码），遗留 plist 不参与拉起/收起
- 空结果重试一次（第二次用 `text_language=auto`），合成超时默认 120 秒（`say_voice` 工具层覆盖 250 秒，
  覆盖空响应重试一次的最坏情况）
- 语速：`voices` 条目支持可选 `speed`（语速倍率 0.5–2.0，缺省不传 = 原速），如凯尔希 0.9

### 15. 可观测性

- 日志统一带 `HH:MM:SS` 前缀（`src/index.ts` 启动时包一层 console），排查按时间对齐
- 单次工具调用超时 30 秒（`fish.config` 的 `toolTimeoutSeconds`），个别重耗时工具按 `toolTimeoutOverrides`
  单独放宽（代码内置：say_voice 250s / video 90s / gpt_image 210s / draw 600s——单角色全管线约 2 分钟，
  双角色管线约 2 分钟内，含备转余量），超时以 tool 错误返回，
  **没有整轮超时**

### 16. 长期记忆（审批闸 + 公共/私有双轨）

- **按人格隔离的双层结构**：公共层 `fish.memory`（key=人格名，默认人格 = `默认`；
  `memoryKeyOf()` 是唯一实现，谁也不许自己写一份）与私有层 `fish.memory.private`
  （key=`人格名@chatKey`，`privateMemoryKeyOf()` 是唯一实现）。每个人格是一个独立个体：
  它的公共层在全部会话（各群、主人私聊、未来渠道）共享并互相合并；私有层只在该人格的
  **来源会话**注入；**不同人格之间禁止共享**。既定语义：主人私聊里告诉某人格的事，
  经批准为公共后可能在该人格出现的其它群浮现——抽取提示词的隐私过滤与渲染时的
  在场/关键词门槛照常生效
- **压缩只入待审（审批闸）**：写入入口只有压缩链路（`compact.ts` 的 `savePendingMemories`，
  同一 commit 内读改，同一人格多个会话并发压缩不会互相覆盖），且只写进待审库
  `fish.memory.pending`（key=人格名；条目 `{id, patch, items, originChatKey, at}`，id 由代码生成、
  跨人格唯一）。一次压缩的 patch 拆成稳定子项 `父id#NN`：人物资料/单条事实/说法/卡片/评价
  各自独立；supersede 绑定同 subject 首个新事实，expire 独立。父 patch 始终是剩余 items
  的聚合，旧无 items 条目读取时确定性派生。**未批准的 patch 永不进任何记忆 doc、永不注入 section、永不被模型看见**。
  待审上限 `MEMORY_PENDING_CAP`（观察期 2026-11 暂不设限，改小常量即恢复淘汰，
  淘汰时打 `[鱼缸] 记忆待审淘汰 <id> <人格名>`，内容不进日志）；每次成功压缩都推进
  `lastExtractAt`（待审写入即推进，空 patch 不进待审但也推进）；抽取失败不阻塞换页。
  没有 `remember` 工具、没有定时任务、没有主动回忆
- **批准双轨（写通道只有两处）**：主人私聊的 `/记忆` 机械指令（闸前通道，不进模型）与
  `scripts/memory.ts` 的 `--approve` / `--reject` / `--delete`。私聊 `/记忆` 是**全局单视图**：列出所有
  人格的待审（不按当前会话人格过滤），每批标签含来源人格 + 来源会话 + 剩余子项数，最旧在前，
  头部带 `待审 N 批 / 最早 Xh Ym前` 汇总；`/记忆 查看 <父id>` 展开全部剩余子项的 id、原文与
  失效影响；`/记忆 同意 <父id|子项id> [公共|私有]`（**缺省=私有**，最小可见面是默认，
  公开是主动决定；私有=AI 不经手、原样并入来源会话私有 doc，公共=AI 脱敏后并入人格公共 doc）。
  批准子项只应用该项，其余子项保留原 id；父 id 批准 = 采纳全部剩余项，父 id 拒绝 = 清除全部剩余项。
  `/记忆 拒绝 <父id|全部>`；selector 不存在回错误。**群内 `/记忆` 只回引导语，无任何副作用**
  （不按群预选/过滤）。批准时两层 doc 各自独立执行上限与淘汰（`applyPatch`，两个 doc 分别 apply）
- **外部写库必须重启鱼**（2026-11-05 搬史群事故）：pi-durable 的 id 计数器是**进程内存值**，
  只在启动时从库读一次。脚本/CLI 写完同一个 `var/fish.db` 后，线上进程的计数器就过期，
  它下一次提交必然撞号（`ID xxx already belongs to document`），pi-durable 随即判会话损坏
  ——该群从此刻起**提交全失败、静默到重启**（事故里还叠加了 outbox 队首卡死，见 drain 一条）。
  因此 `npm run memory` 的 `--approve/--reject/--delete` 在检测到活鱼时**直接拒绝**（要 `--force`
  明确认风险），且用完**必须重启鱼**；首选让线上进程自己写——主人私聊的 `/记忆` 是同一套审批语义
- **公共批准先过 AI 脱敏（私有不脱敏）**：`同意 <id> 公共`（私聊指令与脚本 `--approve <id> 公共`
  同语义）在 `applyPatch` 前把 patch 文本字段（facts/lore/cards 的 text；subject/keys/结构不动）
  交给便宜模型按 `prompt/memory-publicize.md` 改写——去掉指向来源群的身份信息，让表述在该
  人格任何会话都成立；模型与压缩抽取同源（memoryModel 链，缺省同主模型）。模型输出全部当
  不可信数据：改写必须重过 `sanitizePatch` 同款机械过滤并保持结构同构（文本外的字段一律以原
  patch 为准重建）才允许 apply。**公共化只在内存 prepare，不写回待审**：最终事务重新解析
  selector、校验原始选择 patch 的 canonical SHA-256 fingerprint，再直接应用脱敏 patch；
  等待期间其它请求改变了剩余子项就返回 changed，旧快照不得复活子项或串入另一轨道。
  改写失败该次公共批准以错误回执终止（fail closed，不降级、不原样入库），可重试或改批私有。
  missing/changed/失效预检失败都回滚整个事务，连空目标 doc 也不创建。回执展示改写后的关键文本；
  误伤可用 `/记忆 删除` 兜底。日志只带 id 与结果状态（`[鱼缸] 记忆公共化脱敏 <id> ok|failed <reason>`），不打印内容
- **只经 system section 注入**：记忆文本只从 `memory` section 进模型，**绝不允许拼进 user
  message**；当前会话可见 = 公共 doc + 本会话私有 doc 现算 key 后合并渲染
  （`mergeMemoryStates`，总预算 ≤900 字；块序 = 机械优先级：主人评价 → 在场画像 →
  说法 → 卡片），私有层绝不注入非来源会话；
  渲染只读（不写 `lastUsedAt`）；无 scope 或无可渲染内容时不占位。抽取器只读结构化
  原始 entry（`fish.inbound` 的 data / `fish.outbound` 的 items），必须排除 `pi.system`、
  宿主任务文案、工具结果与旧收图轮历史 entry（`fish.gif_ingest`，机制已退役但排除口径保留），否则「记忆→抽取→记忆」的自我污染闭环会复活
- **群友画像（2026-11，T10）**：画像的唯一载体是 `fish.memory` 的 people 结构——
  subject=QQ 号（`qq:NNN`），印象条目按 QQ 键累积叠加（同 subject 合并去重、fact 自带
  at 时间戳、渲染附 YYYY-MM 锚点），享既有 supersede / MEMORY_CAPS 上限与 at+hits
  淘汰（大群旧画像按 updatedAt 让位），**不建第二套画像存储**。渲染在场优先：当前轮
  在场说话人（scope.speakers，锚点在前、最多 5 位）的画像块在 ≤900 字预算内先于
  说法/卡片可见（纯机械加权，feedback 置顶不变，渲染只读）。
  `prompt/people.md` 只保留主人/关系等静态设定（不属群友画像、不迁移），「群里的人/
  梗」类动态内容由记忆链路维护；抽取提示词（`prompt/memory-extract.md`）要求在与
  某人的交流中持续提炼对其的新印象，照旧只进待审、不直接落库
- **抽取评价机制（2026-11，T11）**：抽取提示词是唯一源（`prompt/memory-extract.md`，
  复查宽松版在 `prompt/memory-extract-review.md`，均接 `src/prompt/index.ts`）——试金石
  「未来对话会受益吗」（durable ✅ / 不可证伪模糊断言 ❌）+ few-shot 正反例（正例含
  新群友身份/梗的来历/主人的约定/对鱼的纠正/对某人的新印象/热梗缩写黑话 lore：
  无法从字面理解且群友有解释或可推断，keys=原话≤10 字、text=释义≤60 字含首次出现
  月份锚点；反例含「在吗」「哈哈哈」、纯情绪宣泄、一次性闲聊），confidence low
  不报（计入 skipped，正常轮代码层也机械丢弃；复查轮放宽保留）。模型输出是
  candidates 四分类对账：ADD / SUPERSEDE（factId 必填，subject 由 known 附带的
  id→subject 映射机械解析、不采信模型写的 subject，未命中即弃）/ EXPIRE（时效性淘汰，
  见下条）/ SKIP（仅计数不产出）。
  `ExtractOutcome` 三态 ok/empty/parse_failed：解析失败单独上报、不计零提取也不推进
  lastExtractAt（修正旧版把未知形状归一成空 patch 的误判）。known = 公共 doc +
  当前会话私有 doc 的合并渲染（事实行带 YYYY-MM 锚点；SUPERSEDE 可能指向私有层事实，
  /记忆 的「将失效」原文查找覆盖私有层）。零提取按人格连续计数（`MemoryState.zeroStreak`
  持久化在公共 doc，阈值常量 `MEMORY_ZERO_EXTRACT_PAGES=5`）：达阈值 → /记忆 待审头部
  打「近 N 页压缩零提取」+ 压缩链路用宽松提示词重跑本页一次（只一次不循环；失败不清
  计数、不阻塞换页）。待审列表（/记忆 与 `npm run memory --pending`）展示 signal 标签
  （已知人物/事实冲突，代码机械重算、不采信模型标注）；不自动 DELETE
- **时效性核对（2026-11-05）**：抽取先核对「已知事实」还有没有成立，再挑新东西。
  判失效只认三类证据：本人说变了、群友明确更正/反驳（含反驳鱼说过的过时话）、旧事已收尾；
  「事实很旧」不是依据。`EXPIRE` 候选必须带**逐字 quote（≤60 字）**，机械校验要求它是
  本页**入站原文**（`fish.inbound.data.text`）的 substring——证据域刻意不含鱼自己的
  outbound 与主人评价，否则等于允许「自己的推测」自证。防误杀：`EXPIRE` 恒 `high`-only
  （复查轮也不放宽）、每页 ≤ `MEMORY_EXPIRE_PER_PAGE`（5）、同 factId 去重、一条 quote
  只支持一条失效；有替代品的仍走 SUPERSEDE（整批解析完用最终 supersededIds 过滤掉
  EXPIRE，不看候选顺序）。EXPIRE 与 SUPERSEDE 都在**最终批准事务内**做双轨预检：目标 doc
  必须包含该有效 fact 且 subject 相符，否则回滚并保留待审（早期预检不能代替事务内重读，
  否则目标已变化时 applyPatch 静默不命中、待审却被删）。失效只置
  `invalidAt` + `expiredReason`，**不写** `supersededBy`，条目保留可追溯（没有一键恢复）。
- **上限写死在 `src/memory/model.ts` 的 `MEMORY_CAPS`**：人 ≤12、每人事实 ≤8 且总字数 ≤320、
  names ≤5、style ≤120 字、口头禅 ≤8 条且每条 ≤24 字、lore ≤40（key ≤5 个且每个 ≤10 字、
  text ≤60 字）、cards ≤60（text ≤80 字、keys ≤5、subjects ≤8）、单次 section 渲染 ≤900 字、
  已知记忆输入 ≤8000 字。冲突不删除：`supersede` 置 `invalidAt` 并同时回填
  `supersededBy`（取代它的那条新 fact id，审计链），渲染只认有效事实。淘汰与排序是
  **at（入库时间）+ hits 的纯机械组合**：零命中且更旧的优先淘汰/沉底（people facts 超限
  淘汰、lore/cards 的渲染排序与超限淘汰都纳入）；**渲染期零写入**（不记 lastUsedAt，
  渲染只读）。渲染 fact 与卡片时附 `YYYY-MM` 时间锚点，陈年旧事与近况分得清
- **fact 溯源**：每条 fact 带可选 `fromChat`（来源 chatKey），由宿主在批准路径注入
  （待审条目的 `originChatKey` → `applyPatch` 写进新 fact），不由模型决定；
  `npm run memory -- --persona` 详情里逐条可见（「来自 …」），/记忆 待审列表的来源会话照旧展示。
  待审列表和子项详情里含 supersede 的条目附「将失效：<fact-id> <原文>」标注（原文从该人格
  公共 doc 与相关私有 doc 现查）；绑定替代事实的子项明确写「将随本项失效」，供主人直接看到
  原子取代影响，文案 key 在 `prompt/messages.md`）
- **删除通道（真删，区别于 supersede 的失效）**：主人私聊 `/记忆 删除 <fact-id>`（群内只回引导语）
  与 `npm run memory -- --delete <fact-id>`：按全局唯一 fact id 在该人格公共层与全部私有层 doc
  里定位并从数组真删除；日志只打 id 与所在 doc（`[鱼缸] 记忆删除 <id> <doc>`），不打印内容；
  找不到回错误。线上 /记忆 只覆盖已注册人格（残留 doc 用脚本查删），脚本与指令同语义
- **模型输出全部当不可信数据**：`sanitizePatch` 对字段/主体/敏感模式/控制字符做机械过滤，
  主体再过一道本次允许集合白名单；fact id 一律代码生成（`f-`/`l-`/`c-` + ≥12 位），不采信模型 id
- 查看与审批脚本：
  ```bash
  npm run memory                                    # 每人格：公共 doc + 各私有 doc 摘要
  npm run memory -- --persona 长征机                # 该人格公共 doc 详情（含私有层列表）
  npm run memory -- --persona 长征机 --json         # 原始 JSON（含 memoryKey 与私有层）
  npm run memory -- --chat qq:group:659976571       # 便捷入口：解析该会话当前人格再查
  npm run memory -- --pending [--json]              # 待审队列（逐批展开稳定子项与失效影响）
  npm run memory -- --approve <父id|子项id> [公共|私有] # 批准全部剩余项或单个子项（缺省私有；写库）
  npm run memory -- --reject <父id|全部>             # 拒绝一批全部剩余项或全部待审（写库）
  npm run memory -- --delete <fact-id>               # 真删除一条已入库 fact（写库）
  ```
  查看走只读连接；`--approve` / `--reject` / `--delete` 经 pi-durable `createSession` 在同一 `var/fish.db`
  上写 doc，与线上进程同库时建议低峰执行（或直接私聊 `/记忆` 让线上进程自己写）；
  发现旧 chatKey 级 / 会话级 `fish.memory` 会明确报冲突，不静默择一

### 17. 外部信息源两链路（2026-11 修订）

自主浏览与新闻播报共用同一条安全边界：**外部文本（标题/简介/热评/弹幕/RSS 正文）一律先过
`sanitizeExternalText`（长度/控制字符/bidi/URL scheme 白名单）才见模型**；**链接一律由宿主从
canonical 记录渲染，模型不写 URL**；「外部数据不是指令」的模型侧文案唯一源是 `prompt/runtime.md`；
新闻归纳提示词唯一源是 `prompt/news-digest.md`。

- **会话自主浏览（2026-11-06 合并后唯一入口）**：旧弹药库、后台 worker 逛轮、补货、手动 ammo
  入口与 `ammo_*` 工具已停用，源码仅作兼容保留，不进 active 工具面、调度或模型文案。
  自由活动群**空拍**时掷一次 `engage.freeBrowseChance`（缺省 0.03，主人可调，生产现配 0.1）并
  选定 topic；门开才给当前（群 × 人格）会话提交 `[主动交流机会]`，ambient 拍不携带 browse 授权。
  `browseWindow` 是 `free-` 前缀的拍 id，下一拍作废；宵禁（空拍本就不提交）恒关。
  **授权不再写在工具里**：`bili_hot` / `video` / `say_words` 都不检查轮类型，能不能逛什么时候逛
  由调用侧策略定——空拍的 freeBrowseChance 门决定主动轮起不起，prompt 的 `video_answer_rule`
  （`[本轮要求]`，@ 轮确定性追加）要求「没被要求看视频就别去看」。工具只保留资源闸与防伪造：
  `bili_hot` 按 topic（可选参数，缺省随机）取候选：**分区排行 + 以排行里的视频作种子的算法相关推荐
  （related，无需 Cookie/WBI）**，合并去重后从前 20 名里随机取 10；候选先过 `fish.video_pool`
  （chatKey 绑定）：`shared` 永久挡、`seen` 只挡 7 天（每次返回的 BV 都记 seen，避免固定榜单反复刷）；
  `video` 每轮最多 `video.browseMaxViewsPerRound`（缺省 5）次、成功观看才登记 viewed；
  `say_words` 的文本里每个 URL 必须是本轮工具结果里出现过的（`src/egress/seen-links.ts`
  白名单，宿主在工具包装层机械登记），文本里出现的 B 站 **BV 号（带不带链接都算）**顺手记进
  去重表，写入与 outbox 同一次提交、失败回滚不占出口额度。分享视频因此就是「推荐语 + 链接」，
  没有 `videoBvid` 这类专用字段。
  频控内核 `src/external/bili-client.ts` 的白名单端点、串行锁、同端点 ≥2s、-412/-352 熔断与
  buvid3 复用不变，每日预算改读 `video.dailyBudget`（缺省 60，旧 `ammo.dailyBudget` 只作回退）。
  **`fish.video_pool` 是 chatKey 绑定的去重表**（2026-11-05 改绑，session scope，key = 群号/私聊号）：
  同一个群里换人格看同一份历史，不同群互不干扰；不做全局库存或跨会话 claim。只记「已分享过」
  的视频（不发只看），所以 bili_hot 的候选过滤能挡住重复分享。
  **抄写检查豁免链接**：出口白名单要求原样抄工具结果里的 canonical 链接，所以
  `findProvenanceLeak` 比对前先把两侧 http(s) 链接抹掉（`src/egress/policy.ts` 的 `maskUrls`）——
  否则「必须带链接」与「不许抄工具结果」直接冲突，模型只能退回只发 BV 号（2026-11-05 事故）。
  代价：secret 本身就是一条 URL（或敏感内容全在 URL 内）时，溯源比对会被整条跳过；
  密钥/token/绝对路径仍由独立的 `findSecret` 机械规则兜底。
- **新闻备料与机械播报管线（2026-11-07 重构）**：`news.at`（缺省 10:30）是开始备料时点，
  `news.preparationMinutes`（缺省 10，1–30，热加载）决定目标群准备窗口。窗口内目标群普通模型响应冻结：
  @ 只经 outbox 机械回复「正在准备新闻哦，请稍后。」且不补答，非 @ 仍记原话簿/recent/自由拍收集器，
  解冻后按原到达序处理；其它群和私聊不受影响，主人 `/` 指令照常。取料仍由 `src/external/news-client.ts`
  的 60s/RSS/知乎日报八源完成，单源失败降级；目标群必须 ∈ `.env GROUPS`。
  新闻轮绑定**开始时目标群当前人格的既有 Conversation**，由该人格先经 `tool_search` 加载 deferred
  `news_prepare`，再提交结构化 sections/closing 选材（topic/sourceRef 严格校验、summary≤60 字、closing≤30 字），
  全程禁 `say_*`、跳过正文兜底与轮后 compact；首次 + 最多 3 次重试，全部尝试不得越过 publishAt。
  宿主渲染 ≤500 字成品（canonical 链接只按 sourceRef 索引），到点在同一个 harness commit 内完成稳定 key
  `news:<day>:<group>` 的 outbox 入队与 `fish.news_runs` prepared→done，再解冻并 drain；FIFO 保证新闻先于
  解冻后的普通回复，入队不冒充 QQ 送达。run 全状态 CAS（preparing/prepared/done/failed）、run-key single-flight、
  独立 deadline 与 publishAt+5 秒安全看门狗共同保证失败/存储悬挂也解冻；启动 `recoverNewsRuns` 直接恢复非终态，
  prepared 不重复备料，超过 2 小时的陈旧成品记 missed_window 不补发。旧 30 分钟 `awaitNewsSlot`、defer_giveup
  和 scheduled answer 的 `say_words` 播报路径已删除。
- 部署依赖：60s 是 macmini 上的自建 Docker 服务（镜像固定、loopback、健康检查、升级回滚的 runbook
  见 `docs/plans/2026-11-02-external-ammo.md` 附录）；RSS/知乎日报无自建依赖；60s 不可达只降级不阻断。

## 命令

```bash
npm test           # 166 项，含上面每条约束与新闻 R1–R12 竞态矩阵的兜底
npm run prompts    # 列出 prompt 文件 + sha256 + 27 个工具包（TOOL.md 摘要/Schema/文案 key/eager/deferred）+ 文案归属 + 内嵌扫描结果
npm run smoke:news # 新闻 N1–N5 + 生产 runtime 竞态 smoke（真实模型、隔离 SQLite/凭据、虚构新闻源，不接 QQ）
npm run probe      # QQ 侧验收：连 OneBot、报身份和群、发测试消息
npm run ops status # 数据目录 / 幂等表 / 原话簿概况
npm run memory     # 长期记忆查看与审批（--persona / --chat / --json / --pending / --approve / --reject，见第 16 节）
npm run creds show  # 凭据状态（只有长度）
npm run login -- google-antigravity [--browser | --finish '<授权码>']  # Antigravity 登录（只有浏览器流程；openai-codex 同入口）
npm run ping        # 模型连通性 + 用量（不打印 key）
npm start          # 真跑（自动读 .env）——只在 macmini 上
npm run deploy     # 部署：git pull + 平滑重启鱼（只在 macmini 上跑）
npm run tts [status|up|down]  # 语音实例状态/拉起/收起（macmini 上跑）
node scripts/migrate-memes.ts [--dry]   # 存量表情包按规则补一级情绪词
node scripts/retag-memes.ts [--dry]     # 用 flash 给缺一级词的表情包补词（只加那一个 tag）
```

## 部署（2026-10 起）

生产现场在 **macmini**（macmini，仓库在 `~/yugang`）。数据目录默认在仓库 `var/`（macmini 迁移时一度搬到
`~/鱼缸/var`，现已回归仓库）；本地开发机仓库里的 `var/` 是迁移前旧副本，与新默认并存，**不要在本地起鱼**。变更一律：

1. 本地开发 + `npm test` 全绿
2. commit / push 到 GitHub main
3. 连上 macmini 执行 `cd ~/yugang && npm run deploy`（pull → 平滑重启 → 验证横幅；运维侧等价入口是 ops skill 的 `fish.sh deploy`）

**`fish.sh deploy` 只能在本地开发机跑**：它内部 ssh 到 mini 执行 `npm run deploy`，
mini 上并没有 `home-mac-connect` 这个 skill（今天有子代理在 mini 上直接跑它，报「找不到 connect.sh」）。

`scripts/deploy.ts` 用 `process.execPath` 拿全路径 node：非交互 shell（ssh/nohup）的 PATH 里没有 brew 的 node，直接 `spawn("node")` 会报 No such file or directory。pull 失败时不动线上；新鱼 8 秒内没打出「已连接」横幅则报错退出。

**部署前置依赖检查**（`scripts/lib/deps.ts`）在收旧鱼之前跑：
- `package-lock.json` 变了或 `node_modules` 缺失时执行 `npm install --omit=dev`；失败则中止部署，旧鱼继续跑。
- 新闻配置了 `news.targetGroup` 时 ensure 60s：健康检查 → 容器在就 start/restart → 容器不在就（缺镜像先 pull）按
  `--restart always` + `127.0.0.1:4399:4399` 起容器。60s 起不来只告警、不阻塞鱼启停（新闻按单源降级）。
- `npm run up` 也会在新闻启用时 ensure 60s；`npm run doctor` 会报 Node 依赖 / 60s / ffmpeg / video python 的体检结果。

新闻/B 站两管线依赖 macmini 上的自建 60s 服务（`vikiboss/60s` Docker，loopback 绑定 4399，`--restart always`）：
镜像默认浮动 tag `vikiboss/60s`，生产建议用 `SIXTY_IMAGE=vikiboss/60s@sha256:<digest>` 固定；健康检查端点是
`GET /health`（返回 `ok`，60s 源码实际端点，没有 `/healthz`）。完整 runbook（起容器命令、探活、升级与回滚步骤）
在 `docs/plans/2026-11-02-external-ammo.md` 的部署 runbook 附录；RSS/知乎日报走公网直连，无自建依赖。

## 人格与指令

鱼有多个人格：`prompt/personas/<名>.md`（默认人格是 `prompt/persona.md`），每人格一个 extension（`fish` / `fish:<名>`），启动时注册。会话按（群/私聊 × 人格）唯一确定：映射键 `chatKey#人格`（默认人格=原键，存量无缝），不同人格上下文/工作区完全隔离，切回时接续原会话。人设图放 `<mediaRoot>/personas/<名>.png`（不进 git），切换回复自动携带、模型可用出口工具发。

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
- 姬子音色：权重已下载校验（`~/tts/models/`），未常驻、未配 voices
- 连续相似复读没有修法
