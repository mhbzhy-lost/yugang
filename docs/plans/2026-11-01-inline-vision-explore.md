# inline-vision 探索结论（T1）

> 对应计划 `docs/plans/2026-11-01-inline-vision.md` Task 1。五问五答，证据为 pi-durable / pi-ai 1.4.0 源码行号。

## (a) user message 的 image block 如何落 fish.db

`conversation.submit({type:"input", content, entry})` → `appendInput()`（`node_modules/@earendil-works/pi-durable/dist/harness/inbox.js:72-78`）：构造 `{role:"user", content, timestamp}` 整条放进 entry 的 `model` 数组（默认 kind=`pi.user`），`tx.appendEntry` 原样写入 fish.db 的会话文档。`content` 是 string 或 block 数组，**`ImageContent`（含 base64 `data`）原样 JSON 落库，无截断**（`truncate.js` 只处理工具输出）。结论：v1 接受 base64 入库，体积以换页节奏为界。

## (b) 换页摘要输入会不会收到 image block

不会。`src/compact.ts:173-183` 的 `entryText()` 只取 `entry.model[].content` 中 `type:"text"` 的 block（`:124` 的过滤同款）；image block 被静默跳过，handoff 提示词永远只看到文本。**T5 的 compact.ts 分支结论：无需改代码，仅加确认注释。**

## (c) 换页后新页上下文是否残留旧 image block

不会。`conversation.reset(handoff)`（`pi-durable/dist/harness/harness.js:46-53`）提交 `head:"self"` 的 ResetEntry，新页的 model 首条就是 handoff 纯文本；`inbox.js:91` 注释明确「entries appended before it leave the active range when it lands」——reset 之前的 entry（含图片）退出活跃上下文，仅留存在 DB 归档区。**活跃上下文干净。**

## (d) DB 体积控制的消息后处理/settle 钩子

pi-durable 1.4.0 未提供改写/修剪历史 entry 的公开 API（只有 append/reset 边界语义）；清理归档需要裸 SQL，超出 v1 范围。**v1 决策：不做后处理；DB 增长 = 50KB 级/张 × ≤2 张/轮 × 换页前的轮数，接受并以换页节奏为界；未来如需修剪另立任务。**

## (e) 非 Google 通道收到 image block 会发成什么（白名单排除证据）

- openai-completions（zai 等）：`pi-ai/dist/api/openai-completions.js:952-953、1101-1102` 把非 text user block 映射为 OpenAI 格式的 `image_url`——正是 `src/media/describe.ts` 头注释记载的当年把 zai 网关撞挂的载荷形态。
- openai-codex-responses：源码无 image/inlineData 处理路径（grep 无命中），codex 通道对图片输入的支持未知，不得作为 inline 通道。

**结论：inline 白名单限定 `{google-code-assist, antigravity-code-assist}` 是必要且充分的**——前者经 pi-ai `google-shared.js:160-178` 映射为 Gemini `inlineData`（今日真机验证可读），后者同族协议已实测；其余通道明确排除。
