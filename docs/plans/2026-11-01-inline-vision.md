# 主会话直读图片（inline vision）实现计划

> **给执行 agent：** 必须逐任务执行本计划；步骤使用 `- [ ]` 复选框跟踪。只有整体交付终态全部验证通过，才算计划执行完成；未满足时持续修复与验证。执行方式由计划编写完成后的用户选择决定。

**目标：** 当主模型与视觉模型是同一个多模态模型时，群消息里的图片以 image block 直接进入鱼的主会话（原生看图）；两者不同时维持现状（独立 describe 轮），两条路径自动切换、互不影响。

**架构：** 入站管线在 round 提交点把锚点消息的图片（经统一压图模块处理后）作为 `ImageContent` block 附到 user message 上；harness 按「vision 解析结果 == main」判定 inline 模式；压缩换页与摘要天然只吃文本，image block 不进摘要。look 工具保留，服务历史图/背景图/跨会话图。

**技术栈：** pi-ai `ImageContent`（`{type:"image", data, mimeType}`，已确认 pi-ai 1.4.0 的 `convertMessages` 会把非 text 的 user block 映射为 Gemini `inlineData`）；macOS `sips`（双机 macOS，不新增 npm 依赖——deploy 不跑 npm install）；无新环境变量、无新配置入口。

## 背景：已定稿的设计决策与实测数据（勿重新探索）

本计划的设计参数来自 2026-11-01 与用户共同完成的真机实验（antigravity 通道 / gemini-3.5-flash-lite / 一张 874×1920 密集小字长截图）：

| 压缩档 | 字节 | 可读性 |
| --- | --- | --- |
| 260px q15 | 3.9KB | 几乎不可读 |
| 320px q80 | 19.8KB | 标题可读，数字/日期/BV 号系统性误读 |
| 480px q80 | 39.4KB | 仅随机大小写串（BV 号）差 2 字符 |
| **550px q80** | **49.2KB** | **字符级全对（含 BV 号、网速 94.1K/s）** |
| 1280px（现行 look 档） | 82KB | 全对 |

- **token 计费与字节/分辨率无关**：四档 input 恒定 1123 tok（该通道按图计费扁平）。「压字节省 token」不成立，压图的唯一意义是控制 payload 与存储体积。
- 由此定稿压图规格：**长边 >1280px → 缩到 1280px；此时若 >50KB → 质量固定 80、只降分辨率逐档下探到 ≤50KB；≤50KB 不再动**（50KB 是上限不是目标，小图原样通过；禁止对已达标图继续压）。
- 历史教训（`src/media/describe.ts` 文件头注释）：图片 inline 进主会话曾在旧网关（zai/glm 链路）上撞挂过网关。本计划的条件式路由（inline 仅发生在多模态主模型上）+ 50KB 压图 + 换页丢弃，是针对该教训的对策；`describe.ts` 的头注释需同步改写，避免误导后人。
- GIF 维持现状：静默收图轮、不 inline（首帧会丢语义）。
- `meme_import` 导入轮的本地图片不 inline（非群消息来源）。
- v1 已知边界（明确不做的，勿在执行中顺手扩）：**私聊不附图**（`src/index.ts:1204` 的私聊 submitRound 分支不经 debounce，维持现状走 look）；**被回复引用的图不附**（onebot 回复分支只把被引图落盘并写进文本 `[回复的图 ref]`，不进 `parsed.images`，`src/qq/onebot.ts:213` 起——仍靠 look）。

## 全局约束

- `src/` 里单条字符串字面量不得 ≥12 个汉字（`npm test` 扫描；`TOOL.md` 例外）。
- 模型能看到的文字只有 `prompt/` 下的 markdown 与 `src/tools/<name>/TOOL.md`；新增面向模型的文案一律进 `prompt/messages.md`，模板用 `{{name}}` 严格替换。
- 不新增 npm 依赖（图片处理只用 macOS `sips`；本地开发机与 mini 均为 macOS）。
- 不新增环境变量、不新增配置入口；inline 的启用条件是「`models.vision` 解析结果 == `models.main` **且** `main.api` ∈ 白名单 `{"google-code-assist", "antigravity-code-assist"}`」（`models.vision` 省略 = main，即删掉该行且主模型走 Gemini 通道即启用 inline）。白名单理由：inline 只在已真机验证过的通道开启；zai（openai-completions）等通道是 describe.ts 头注释记载的历史事故通道，明确排除。`/关看图`（`setLookDisabled`，`src/tools/look/tool.ts:56-64`）同时关闭 inline 附图，作为运行时止损开关。
- 不修改 pi-durable / pi-ai 的包内代码；行为差异全部在本仓实现。
- 未经用户授权不新增测试文件（本计划未获测试授权，测试只列建议）；`npm test` 基线为 **89 项全绿**。
- 不默认创建 commit。
- 出口只有 say；看图相关的一切仍不得把图片内容写进日志。

## 整体交付终态

| ID | 必须成立的条件 | 验证方法与环境 | 通过判据 | 证据位置 | 覆盖任务 |
| --- | --- | --- | --- | --- | --- |
| F1 | inline 模式（vision==main 且 api ∈ 白名单）下，锚点消息带图的轮次，user message 含 ≤2 个 image block，主模型不调 look 即能正确描述图中文字（用密集文字截图验证） | mini 真机：临时把 `models.vision` 指向与 main 相同（或删除该行）+ restart，群里发本次实验同款截图 @ 鱼 | 模型回复中含截图标题「成都街头女子被电瓶车撞倒…」级别的准确引用；look 未被调用 | mini `var/fish.db` 只读 sqlite 查询该轮 `pi.user` entry 的 `model[0].content`（chatlog 只记原始文本，看不到 block）+ 群内回复截图 | T3、T4 |
| F2 | 非 inline 模式（vision≠main，或 main.api 不在白名单）行为与现状完全一致：look/describe 链路一字不改（T2 已改为不动 look） | mini 真机：恢复 `models.vision: zai-coding-cn/glm-5.3-flash` + restart，发图 @ 鱼 | 走 describe 轮（日志出现看图链路），回复正常；`npm test` 89 项全绿 | mini 日志（`[鱼缸]` 前缀时间线） | T4、T7 |
| F3 | 压图模块符合规格：非 JPEG 输入一律转码 JPEG；长边 >1280px 缩到 1280px；此时若 >50KB 则 q80 只降分辨率按 50px 步长逐档下探至 ≤50KB（下限 400px，触底则接受）；JPEG 小图（≤1280px 且 ≤50KB）不重编码原样直返 | 本地一次性脚本（不进仓库）用 874×1920 测试图与小图各跑一遍 `shrinkForModel` | 密集截图产出 ≤50KB 且长边 ∈ [500,600]px（实验已验证 550px 字符级全对、480px 差 2 字符，阶梯步长 50 保证落在已验证区间）；JPEG 小图字节不变 | 脚本输出贴进执行报告 | T2 |
| F4 | 压缩换页后 image block 不进摘要、不留在活跃上下文；DB 中历史轮的图片体积有界 | mini 真机触发一次压缩（或等待自然压缩）后检查新页首条消息 | 摘要文本无图；新页上下文无 image block；`fish.db` 无异常膨胀 | mini `var/fish.db` 大小前后对比 + handoff 文本 | T1、T5 |
| F5 | inline 请求因图格式报 400 时，适配器剥掉图片 part 重试一次；内容审核类失败按现有轮失败语义处理 | 本地 mock SSE 服务返回一次图片相关 400 后放行，走 `streamSimple` | 第二次请求体不含 inlineData 且成功拿到文本；403 类不触发剥图重试 | mock 脚本输出 | T4 |
| F6 | `npm test` 89 项全绿、`npm run prompts` 无意外条目、源码内嵌扫描干净 | 本地 `npm test` 与 `npm run prompts` | 全绿、干净 | 终端输出 | T7 |
| F7 | GIF 静默收图轮、`meme_import` 导入轮、背景图（非锚点）路径行为不变 | mini 真机各发一例 | 收图轮静默、导入轮照旧、背景图仍需 look | mini 日志 | T3、T7 |

**完成规则：** 所有必要条件同时满足，且验证证据对应当前交付版本，才能标记计划执行完成；仅完成任务步骤不能替代终态验证。

**未满足时：** 在已授权范围内持续 `fix → test（验证）→ 对照终态`，修复后重验受影响条件；真实阻塞记录为未完成，并写明恢复下一步。

## DAG

```text
T1 (探索：pi-durable 对 image block 的持久化/压缩行为) ──> T5 (生命周期实施)
T2 (inline 压图模块) ──> T3 (提交管线附图)
T3 ──> T4 (inline 路由与适配器降级)
T2 ──> T4
T1 ──> T4（降级设计需知悉持久化结论）
T3、T4、T5 ──> T6 (AGENTS.md/prompt 文案)
T3、T4、T5、T6 ──> T7 (整体验证)
```

## Waves

- Wave 1：T1、T2（可并行，无交集）
- Wave 2：T3、T5（T3 依赖 T2；T5 依赖 T1；两者无交集可并行）
- Wave 3：T4（依赖 T2 的压图接口、T3 的消息形状、T1 的持久化结论）
- Wave 4：T6
- Wave 5：T7

**关键路径：** T2 → T3 → T4 → T7。T1/T5/T6 不制约总工期。

---

### Task 1：探索 pi-durable 对 image block 的持久化与压缩行为

**Deps：** `none`

**WritePaths：**
- `docs/plans/2026-11-01-inline-vision-explore.md`（探索结论，新建）

**Resources：** `none`

**Files：**
- Create：`docs/plans/2026-11-01-inline-vision-explore.md`
- 只读：`node_modules/@earendil-works/pi-durable/`（版本 1.4.0）持久化与 compaction 相关源码、`src/compact.ts`、pi-ai `openai-completions.js`（问题 e）

**接口契约：**
- Consumes：`none`
- Produces：书面结论，必须回答五个问题并给出源码行级证据：(a) `conversation.submit()` 提交的 user message content blocks（含 `ImageContent`）如何落 `fish.db`（原样 JSON？截断？）；(b) `src/compact.ts` 的换页输入是否会收到 image block、handoff 提示词拿到的消息形状；(c) 压缩后新页的首条上下文里旧 image block 是否残留；(d) 若 DB 体积需要控制，pi-durable 是否提供消息后处理/settle 钩子可用（结论可以是没有，此时 v1 接受 base64 入库 + 依赖换页丢弃控制活跃上下文，DB 增长以换页节奏为界）；(e) 非 Google 通道收到 image block 会发成什么（pi-ai `openai-completions.js` 映射为 `image_url`？codex 通道行为？）——作为白名单排除决策的书面证据，不是开启它们的依据。

**终态关联：** `F4`（生命周期方案的事实基础）。

**验收标准：** 结论文档存在且四问各有源码引用（文件+行号）与一句话结论；T5 据此可直接实施。

- [ ] **步骤 1：定位 submit→持久化链路**
  在 pi-durable 源码中追 `conversation.submit()` 到存储写入，记录消息序列化对非文本 block 的处理。
- [ ] **步骤 2：定位 compaction 输入形状**
  核对 `src/compact.ts` 读取消息的方式与 pi-durable 传给它的消息形状，确认 image block 是否会进入摘要输入。
- [ ] **步骤 3：核对换页后上下文构造**
  确认新页 replay/首条消息的构造来源，判断旧 image block 是否残留于活跃上下文。
- [ ] **步骤 4：写结论文档**
  按接口契约四问成文，附文件行号证据。

---

### Task 2：inline 压图模块（shrinkForModel）

**Deps：** `none`

**WritePaths：**
- `src/media/shrink-image.ts`

**Resources：** `none`

**Files：**
- Create：`src/media/shrink-image.ts`
- Suggested Test（待用户授权）：`test/shrink-image.test.ts`

**范围说明：** 本模块只服务 inline 附图路径；**look 的 shrink() 一字不改**（现行 ≤150KB 直发、保原 mime 的语义属于 describe 链路，属于「非 inline 模式现状」的一部分）。

**接口契约：**
- Consumes：`none`
- Produces：`src/media/shrink-image.ts` 导出
  `shrinkForModel(input: { file: string }): { ok: true; buffer: Buffer; mimeType: "image/jpeg" } | { ok: false; reason: string }`
  行为（输出恒为 JPEG，mime 恒为 image/jpeg）：(1) 魔数嗅探输入真实格式（复用/参照 `src/qq/onebot.ts` 的 sniff 思路）；JPEG 且长边 ≤1280px 且字节 ≤50KB → 不重编码、原字节直返；(2) 其它情况用 sips 转码 JPEG（GIF 防御性取首帧——上游 T3 已排除 GIF，这里只作兼容）；长边 >1280px 先缩到 1280px；(3) 若此时字节 >50KB，固定 `-s formatOptions 80`，长边按 1200/1150/1100/…/400（步长 50）逐档下探直到 ≤50KB；到 400px 仍超则接受该档返回（reason 附「触底」说明，不报错）。
- sips 调用沿用 `spawnSync` + 20s 超时写法，临时文件带随机后缀即用即删。

**终态关联：** `F3`。

**验收标准：** 874×1920 密集文字截图产出 ≤50KB 且长边 ∈ [500,600]px；JPEG 小图字节不变；PNG 小图被转码为 JPEG；`npm test` 全绿。

- [ ] **步骤 1：实现 shrinkForModel**
  按接口契约实现（含魔数嗅探与阶梯下探）。
- [ ] **步骤 2：一次性验证脚本（/tmp，不进仓库）**
  密集截图 / JPEG 小图 / PNG 小图三类输入各跑一次，输出尺寸/字节/分辨率贴报告；跑 `npm test`。

---

### Task 3：提交管线附图（锚点图 → image block）

**Deps：** `T2`（消费 `shrinkForModel` 的稳定接口与压图规格）

**WritePaths：**
- `src/qq/debounce.ts`
- `src/index.ts`
- `prompt/messages.md`

**Resources：** `none`

**Files：**
- Modify：`src/qq/debounce.ts`（burst 组装时收集本组图片的本地路径列表，随提交载荷传出）
- Modify：`src/index.ts`（round 提交点：按锚点优先取 ≤2 张图，`shrinkForModel` 压缩后构造 `ImageContent` block 附到 user message；超出部分与背景图走背景栏标注）
- Modify：`prompt/messages.md`（新增 key：`ctx_images_more`——背景栏「本组还有 N 张图未附上，需要时用 look」类文案，模板变量 `{{count}}`；以及锚点带图时的标注行 `ctx_image_attached`）

**接口契约：**
- Consumes：`shrinkForModel`（T2）。
- Produces：提交给 `conversation.submit()` 的 user message 形状（群聊路径 `src/index.ts:702` 唯一提交点；私聊分支不附图）：文本部分与现状完全一致（背景栏+锚点行，由 debounce `withContext()` + gate `renderForModel()` 拼装），其后附 0~2 个 `ImageContent` block；图片选取规则：锚点消息的图优先，不足 2 张时按 burst 内时间顺序补足；同轮去重（同文件只附一次）。
- **失败与边界规则（必须实现）**：图片 slot 的 `ref` 为空（下载失败，文本为 `[图片 读不到]`）、文件缺失、`shrinkForModel` 返回 `{ok:false}` → 一律跳过该图、不阻塞提交、不占用 2 张额度，保留原文本标记引导 look；GIF 不附；`meme_import` 导入轮不附；私聊不附；被回复引用的图不附（v1 已知边界，见全局约束）。

**终态关联：** `F1`（附图存在且正确）、`F7`（GIF/导入/背景图不变）。

**验收标准：** 本地单进程冒烟（临时脚本构造带图/空 ref/缺文件的 burst 走到提交边界，断言：message 形状、≤2 张、去重、失败跳过不抛错）；文案 key 走模板替换，缺变量抛错；`npm test` 全绿。

- [ ] **步骤 1：debounce 收集图片引用**
  burst 内图片消息已有本地落盘路径（`media/inbound/`，onebot 下载+HEIC 归一后）；`PendingBurst.anchor.images` 已存在但 `BurstMessage` 无图字段——给 `BurstMessage` 补图引用列表，随提交载荷传出。
- [ ] **步骤 2：index.ts 构造 image block**
  `submitRound()`（`src/index.ts:666` 起）在构造 content 时调 `shrinkForModel`，按选取与失败规则附 block；仅群聊路径，私聊分支不动。
- [ ] **步骤 3：文案**
  `ctx_image_attached`（锚点行标注，渲染位置在 debounce `withContext()` 的锚点行构造处；私聊分支不经此路径）与 `ctx_images_more`（背景栏）进 `prompt/messages.md`，拼接处用模板替换。
- [ ] **步骤 4：冒烟脚本 + npm test**（含空 ref/缺文件用例）

---

### Task 4：inline 路由与适配器剥图降级

**Deps：** `T2`（压图规格事实）、`T3`（消息形状与提交点）、`T1`（持久化与非 Google 通道结论）

**WritePaths：**
- `src/index.ts`
- `src/api-google-code-assist.ts`
- `src/tools/look/tool.ts`（仅 `/关看图` 状态的共享读取点，不动 shrink/describe）

**Resources：** `none`

**说明：** 不改 `src/harness.ts`——openFish 不经手 user message，提交点在 index.ts，开关留在 index.ts 闭包内即可，避免死配置面。

**Files：**
- Modify：`src/index.ts`（`inlineImages = vision.providerId === main.providerId && vision.modelId === main.modelId && ["google-code-assist", "antigravity-code-assist"].includes(main.api)`，闭包内传给 `flushBurst`/`submitRound`；false 时不构造 image block——T3 步骤 2 的构造点接此开关；`/关看图` 禁用状态接入同一开关）
- Modify：`src/api-google-code-assist.ts`（剥图降级：stream 首次尝试收到 400 且错误体提及 image/inlineData/media 时，从请求 contents 的 parts 中移除所有 inlineData 后重试一次；仅一次；403/429/5xx 走现有重试与失败路径不变）
- Modify：`src/tools/look/tool.ts`（把 `setLookDisabled` 的状态存储改为模块级可读（如导出 `isLookDisabled()`），供 index.ts 开关消费；仅此一点）

**接口契约：**
- Consumes：T3 的 message 形状；T1 的结论（确认无额外约束）。
- Produces：行为契约——`models.vision` 省略或与 main 相同**且 api ∈ 白名单** → inline；否则现状；`/关看图` 同时关闭 inline 附图。适配器降级只对「图格式类 400」生效，重试请求不含 inlineData；白名单外通道无 inline、无降级需求。

**终态关联：** `F1`、`F2`、`F5`。

**验收标准：** mock SSE 一次 400（错误体含 inlineData 字样）后放行，第二次请求体无 inlineData 且成功；403 不触发剥图；mini 真机 inline 模式发图可读（F1）、恢复 vision=zai 后走 describe（F2）、`/关看图` 后发图不附；`npm test` 全绿。

- [ ] **步骤 1：路由开关（index.ts）**
  计算 inlineImages（含白名单与 /关看图 联动）并接入 T3 的附图构造点。
- [ ] **步骤 2：适配器剥图重试**
  在 google-code-assist 适配器的请求重试层实现：仅 400 + 错误体匹配 image 类关键词时，克隆 params、过滤 `request.contents[*].parts[*].inlineData`、重试一次；日志只打「剥图重试」不含图片内容。
- [ ] **步骤 3：mock 验证 + npm test**

---

### Task 5：生命周期（换页丢弃 / DB 策略）

**Deps：** `T1`（按其结论实施）

**WritePaths：**
- `src/compact.ts`
- `src/media/describe.ts`（仅头注释改写）

**Resources：** `none`

**Files：**
- Modify：`src/compact.ts`（若 T1 结论表明 image block 会进入摘要输入：在喂给摘要器前过滤掉 image block，只留文本；若结论表明不会进入：仅加注释确认）
- Modify：`src/media/describe.ts`（文件头注释改写：说明条件式 inline 已上线——同模型直读、异模型仍走本层；50KB 压图与换页丢弃是对当年网关事故的对策）

**接口契约：**
- Consumes：T1 结论文档 `docs/plans/2026-11-01-inline-vision-explore.md`。
- Produces：换页后新页活跃上下文无 image block；摘要文本不含图片内容。

**终态关联：** `F4`。

**验收标准：** mini 真机触发一次压缩后：handoff/摘要无图、新页上下文干净、`fish.db` 体积前后对比无异常增长（数量级记录即可）。

- [ ] **步骤 1：按 T1 结论改 compact.ts（或确认无需改）**
- [ ] **步骤 2：describe.ts 头注释改写**
- [ ] **步骤 3：真机压缩验证并记录 fish.db 前后体积**

---

### Task 6：文档与提示词收口

**Deps：** `T3`（附图行为定形）、`T4`（路由行为定形）、`T5`（生命周期定形）

**WritePaths：**
- `AGENTS.md`
- `prompt/messages.md`（若 T3 已加全则本任务只核对）

**Resources：** `none`

**Files：**
- Modify：`AGENTS.md` 第 3 节（媒体入口：新增「主会话 inline——vision==main 且 api ∈ 白名单 {google-code-assist, antigravity-code-assist} 时锚点图 ≤2 张直接进 user message；`/关看图` 同时关闭 inline；GIF/导入轮/背景图/私聊/被回复引用图仍走 look 与收图轮」）、第 5 节（压缩：注明 image block 不进摘要、换页丢弃）；顺手把命令节除旧的「86 项」改为「89 项」

**接口契约：**
- Consumes：T3/T4/T5 的最终行为。
- Produces：文档与实际行为一致。

**终态关联：** `F6`（配套的 prompts 审查干净）。

**验收标准：** `npm run prompts` 无意外条目、内嵌扫描干净；AGENTS.md 描述与实现一一对应。

- [ ] **步骤 1：AGENTS.md §3/§5 改写**
- [ ] **步骤 2：`npm run prompts` 复核**

---

### Task 7：整体验证与真机回归

**Deps：** `T3`、`T4`、`T5`、`T6`

**WritePaths：**
- `none`（只读验证；发现问题回写上游任务）

**Resources：** mini 真机（部署窗口由用户定）；本地 `npm test`

**Files：**
- `none`

**接口契约：**
- Consumes：全部上游交付物。
- Produces：F1~F7 的验证证据汇总（写入执行报告）。

**终态关联：** `F1`~`F7` 全部。

**验收标准：** 按「整体交付终态」表逐项执行并记录证据；任一条件不满足则按完成规则循环修复复验。

- [ ] **步骤 1：本地全量检查**
  `npm test`（89 项）+ `npm run prompts`。
- [ ] **步骤 2：mini 部署 + F1/F2/F4/F7 真机验证**
  部署需用户确认窗口；inline 与非 inline 各验证一轮，压缩触发一次，GIF/导入/背景图各一例。
- [ ] **步骤 3：证据汇总**
  每项 F 条件记录命令/操作、结果与证据位置；未满足项按完成规则处理。

---

## 授权与边界备注

- 本计划未获新增测试授权；`test/shrink-image.test.ts` 等仅当用户明示授权后创建。
- 未获 commit 授权；执行中不创建提交。
- mini 真机操作（部署、发图验证、压缩触发）需用户配合或明确授权窗口。
- 本会话 Goal feature 未启用（`plan_execute` 未注册），执行走常规 Subagent-Driven / Inline 路径，无 Goal 流程保障。
