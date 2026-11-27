# Inline 图片 Transcript 减负与当轮剥离 Implementation Plan

> **For agentic workers:** Implement this plan task-by-task in order. Work each step as written (test-first steps: write the test, watch it fail, implement minimally, watch it pass), check off each `- [ ]` step as it completes, and commit where the plan says commit. Do not start a task before the previous task's tests pass.

**Goal:** 治理搬史群等高图量群聊中 inline 图片把会话上下文与 `fish.db` 撑爆的问题：补齐 GIF 抽帧压缩与字节上限、消除换页 token 采样在错误轮的盲区、收紧自由拍带图上限、杜绝报错重试重复落盘带图消息，并在每轮结束后立刻剥离当轮 user entry 的 `image` block（不触碰更早历史以保全前缀 KV Cache）。

**Architecture:** 分两层落地且全部保持向后兼容与零 prompt 契约破坏：
- **第一层（止血 + 减少新落盘字节）**：在入站压图（`src/media/gif-frames.ts` 补齐 `-q:v` 输出选项与 50KB 字节上限）、换页采样（`src/compact.ts` 跳过 `error`/`aborted` 与零 usage）、自由拍规划（`src/qq/round-images.ts` 独立限额 4 图 × 2 帧）与轮内重试（`src/app/runtime.ts` 优先 `type: "continue"`，消除 3× 重复落盘）处止血。
- **第二层（模型上下文减负）**：新增 `src/round-image-strip.ts`，在 `submitRound` 的 `finally` 中按「`shiftScope` → `try/catch stripRoundImages` → `releaseTrackedInFlight`」顺序，通过 `pi-durable` 的 `conv.submit({ type: "write", entry: { kind: "fish.image_strip", edits } })` 仅替换本轮落盘的带图 user entry 为纯文本 messages，绝不修改更早轮次。注意 `ContextEdit` 属 append-only 覆盖，消除的是后续模型请求的 token/载荷与提前换页，不回收历史已落盘的 `fish.db` 字节（新落盘体积由第一层控制）。暂不放开跨轮 `look` 回查（用户已拍板先不管跨轮追问）。

**Tech Stack:** TypeScript（Node ESM `--experimental-strip-types` / `node --test`）、`@earendil-works/pi-durable` `1.5.2`、`ffmpeg`/`ffprobe`（生产容器）、`sips`（macOS）/ `sharp` worker（Linux 容器）。

**Spec:** 本对话根因定位与用户决策（2026-11-27：先做第一层全部四项 + 第二层「当轮结束立刻剥离」，暂不管跨轮追问 `look` 回查；`main` 基准提交 `51e9a3d`）。

## Global Constraints

- 严禁修改 `src/index.ts` 或 `src/harness.ts` 的注册结构（受 `test/index-registration.test.ts` 与 `test/harness-assembly.test.ts` 机械门禁约束）。
- 不新增未被 `src/` 引用的 `prompt/messages.md` 键（受 `test/prompts.test.ts` 死文案检查约束）；本次改动不涉及模型可见 prompt 文本变更。
- Git 操作优先使用 `git1`（不可用时回退 `git`）；commit 遵循 `type(scope): 中文祈使句`，禁止 AI 署名。
- 禁止在本地起鱼或触碰 macmini 生产 `var/fish.db`；所有验收在本地 `npm test` 下完成。
- `pi-durable` 写入的 `fish.image_strip` edit entry **严禁携带 `model` 或 `head` 字段**，且绝不传 `edits: []`。
- 不修改早于本轮的历史 entry（仅针对本轮实际落盘且含图的目标 `EntryId` 发起替换），以保全前置几十 k token 的 Prompt Cache 前缀命中。
- 涉及 `fauxProvider` 的错误轮测试**必须使用不可重试错误**（如 `errorMessage: "400 content_filter_1301"`），避免触发 `pi-durable` 内置重试（`isRetryableAssistantError`）导致 14 秒超时与多条错误 entry 噪声。

## Review Focus

1. **错误轮（含 `faux` 重算非零 usage、生产全零 usage、`aborted`）污染换页判断**：验证错误轮后 `latestRequestTokens` 严格等于上一正常轮的值（且阈值 `before + 1` 返回 `below_threshold`）；直接写入 `usage = 0` 的 `AssistantEntry` 与 `stopReason: "aborted"` 的 `AssistantEntry`，验证两者均被跳过并回退到前一条有效请求从而正常触发换页。
2. **重试期间 `type: "continue"` 遇到 `ConversationBusy` 或 `nothing_to_answer`**：当第 1 次尝试落盘后因 `model_error` 重试，单次 `runSubmission` 负责单一 submission 的登记与 `finally` 清理；回退逻辑放在外层重试循环中，若 `continue` 抛 `ConversationBusy` 或返回 `nothing_to_answer` 则干净回退到 `type: "input"`（绝不串用旧 `subId`）；第 3 次尝试前强制换页若 `cleared.compacted === true`，第 3 次必须走 `type: "input"` 并在轮末剥离新页 entry 的图片。
3. **零出口补跑与并发必答轮下的剥图时机 / 防死锁**：`zero_egress_nudge` 必须固定走 `mode: "input"`（不走 `continue`）；`stripRoundImages` 放在 `finally` 中且严格遵循 `shiftScope` → `try/catch stripRoundImages` → `releaseTrackedInFlight`（保证即使 `try` 内抛异常也会剥图、且绝不把上一轮 speaker scope 串进并发下一轮）；当 `conv.submit({ type: "write", ... })` 返回 `status === "queued"`（并发必答轮占住运行态）时**不 `await sub.wait()`** 避免阻塞死锁（`pi.inbox` 会在下一 boundary 优先落盘 write），返回已入队编辑数；`status === "unanswered"` 时返回 `0`。
4. **剥图幂等性、不可变对象安全与跨页兜底**：`stripRoundImages` 以 `view.contributions[i]` 为当前生效态基底（跳过已无 `image` block 的条目，实现幂等不重复写 entry），并新建 `Message` 对象（不原地修改 `pi-durable` 深冻结对象）；目标 `EntryId` 已被强制换页切出活跃页或 `settled.entry === undefined` 时安静返回 `0` 不写空 `edits`。
5. **GIF `-q:v` 选项位置、单帧超 50KB 压图与 `shrink` 失败降级**：`-q:v` 必须在 `-i <file>` 之后作为输出选项传入 `ffmpeg`（否则被当成输入选项导致抽帧失败）；单帧超过 50KB 经由 `shrink` 压回预算内；`shrink` 返回 `{ ok: false }` 或未变小时保留原抽出帧不丢帧。

---

## Task Partition & Dependencies

- **Task 1**（`src/media/gif-frames.ts`、`test/gif-frames.test.ts`）：Depends on `none`。
- **Task 2**（`src/compact.ts`、`test/compact.test.ts`）：Depends on `none`。
- **Task 3**（`src/qq/round-images.ts`、`test/quoted-images.test.ts`、`src/app/runtime.ts`）：Depends on `none`。
- **Task 4**（`src/round-image-strip.ts`、`test/round-image-strip.test.ts`、`src/app/runtime.ts`、`AGENTS.md`）：Depends on `Task 3`（同改 `src/app/runtime.ts`）。

*(若采用并发模式，可划分为 3 个文件零重叠组：组 A = Task 1，组 B = Task 2，组 C = Task 3 + Task 4 串行；鉴于总改动量紧凑且均汇总至 `npm test`，默认推荐串行执行。)*

---

### Task 1: GIF 抽帧补齐质量参数与 50KB 单帧字节上限

**Depends on:** `none`

**Files:**
- Modify: `src/media/gif-frames.ts:23-133`
- Create: `test/gif-frames.test.ts`

**Interfaces:**
- Consumes: `shrinkForModel`, `type ShrinkResult` from `src/media/shrink-image.ts`
- Produces:
  - `export const GIF_FRAME_LONG_SIDE = 640;`
  - `export const GIF_FRAME_QSCALE = "6";`
  - `export const GIF_FRAME_TARGET_BYTES = 50 * 1024;`
  - `export function buildGifExtractArgs(file: string, indices: readonly number[], outPattern: string): string[];`
  - `export function finalizeGifFrame(framePath: string, shrink?: (input: { file: string }) => ShrinkResult): Buffer | null;`
  - `export function extractGifFrames(file: string, maxFrames: number, shrink?: (input: { file: string }) => ShrinkResult): GifFramePlan;`

- [ ] **Step 1: Write the failing tests in `test/gif-frames.test.ts`**

*(注：本机开发机无 `ffmpeg`/`ffprobe`，单测针对导出纯函数与文件收尾逻辑做确定性验证，生产 Linux 容器执行完整 `ffmpeg` + `sharp` worker 链路。)*

```ts
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  buildGifExtractArgs,
  finalizeGifFrame,
  GIF_FRAME_QSCALE,
  GIF_FRAME_TARGET_BYTES,
} from "../src/media/gif-frames.ts";

test("ffmpeg 抽帧参数必须在 -i 之后显式携带输出选项 -q:v 与 640px 缩放", () => {
  const args = buildGifExtractArgs("/tmp/a.gif", [0, 5], "/tmp/out/f%03d.jpg");
  const inputIdx = args.indexOf("-i");
  const qIdx = args.indexOf("-q:v");
  assert.notEqual(inputIdx, -1);
  assert.notEqual(qIdx, -1, "缺少 -q:v 参数");
  assert.ok(qIdx > inputIdx, "-q:v 必须是位于 -i 之后的输出选项");
  assert.equal(args[qIdx + 1], GIF_FRAME_QSCALE);
  assert.equal(args.at(-1), "/tmp/out/f%03d.jpg");
  const vfIdx = args.indexOf("-vf");
  assert.notEqual(vfIdx, -1);
  assert.match(args[vfIdx + 1] ?? "", /scale=w=640:h=640/);
});

test("单帧不超过 50KB 时直接返回原字节，不调用 shrink；空文件返回 null", () => {
  const dir = mkdtempSync(join(tmpdir(), "yg-gif-"));
  try {
    const empty = join(dir, "empty.jpg");
    writeFileSync(empty, Buffer.alloc(0));
    assert.equal(finalizeGifFrame(empty), null);

    const file = join(dir, "small.jpg");
    const raw = Buffer.alloc(12 * 1024, 0xaa);
    writeFileSync(file, raw);
    let calls = 0;
    const out = finalizeGifFrame(file, () => {
      calls += 1;
      return { ok: true, buffer: Buffer.from("shrunk"), mimeType: "image/jpeg" };
    });
    assert.equal(calls, 0);
    assert.deepEqual(out, raw);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("单帧超过 50KB 时调用 shrink 压回预算内；shrink 失败或未变小则回退保留原帧", () => {
  const dir = mkdtempSync(join(tmpdir(), "yg-gif-"));
  try {
    const file = join(dir, "big.jpg");
    const big = Buffer.alloc(GIF_FRAME_TARGET_BYTES + 4096, 0xbb);
    writeFileSync(file, big);

    const smaller = Buffer.alloc(24 * 1024, 0xcc);
    const shrunk = finalizeGifFrame(file, () => ({ ok: true, buffer: smaller, mimeType: "image/jpeg" }));
    assert.deepEqual(shrunk, smaller);

    const failed = finalizeGifFrame(file, () => ({ ok: false, reason: "fail" }));
    assert.deepEqual(failed, big, "shrink 失败时应回退原帧，不能丢帧");

    const bigger = Buffer.alloc(big.length + 100, 0xdd);
    const notSmaller = finalizeGifFrame(file, () => ({ ok: true, buffer: bigger, mimeType: "image/jpeg" }));
    assert.deepEqual(notSmaller, big, "shrink 未变小时应保留原帧");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test test/gif-frames.test.ts`
Expected: FAIL with missing exports (`buildGifExtractArgs`, `finalizeGifFrame`, `GIF_FRAME_QSCALE`, `GIF_FRAME_TARGET_BYTES`).

- [ ] **Step 3: Implement quality output option & byte-budget compression in `src/media/gif-frames.ts`**

在 `src/media/gif-frames.ts` 中：
1. 引入 `shrinkForModel, type ShrinkResult`（来自 `./shrink-image.ts`）。
2. 将未使用的 `GIF_FRAME_QUALITY = "80"` 替换为导出常量 `GIF_FRAME_QSCALE = "6"` 与 `GIF_FRAME_TARGET_BYTES = 50 * 1024`。
3. 导出 `buildGifExtractArgs(file, indices, outPattern)`，返回 `["-y", "-loglevel", "error", "-i", file, "-vf", `${select},${frameScaleArgs().join(",")}`, "-fps_mode", "vfr", "-q:v", GIF_FRAME_QSCALE, outPattern]`（确保 `-q:v` 严格在 `-i` 之后、`outPattern` 之前）。
4. 导出 `finalizeGifFrame(framePath, shrink = shrinkForModel)`：读取 `framePath`；`buf.length === 0` 返回 `null`；`buf.length <= GIF_FRAME_TARGET_BYTES` 直接返回 `buf`；否则调用 `shrink({ file: framePath })`，仅在 `res.ok && res.buffer.length > 0 && res.buffer.length < buf.length` 时返回 `res.buffer`，其余回退返回原 `buf`。
5. `extractFrames(file, indices, shrink)` 使用 `buildGifExtractArgs` 和 `finalizeGifFrame`；`extractGifFrames(file, maxFrames, shrink = shrinkForModel)` 透传 `shrink`。

- [ ] **Step 4: Run tests to verify pass**

Run: `node --test test/gif-frames.test.ts`
Expected: PASS (3/3 tests pass).

- [ ] **Step 5: Commit**

```bash
git1 add src/media/gif-frames.ts test/gif-frames.test.ts
git1 commit -m "fix(media): 为 GIF 抽帧补齐质量参数与 50KB 字节上限"
```

---

### Task 2: 换页 token 采样跳过错误轮与零 usage

**Depends on:** `none`

**Files:**
- Modify: `src/compact.ts:709-723`
- Modify: `test/compact.test.ts`

**Interfaces:**
- Consumes: `Conversation` from `@earendil-works/pi-durable`
- Produces: `export async function latestRequestTokens(conversation: Conversation): Promise<number | undefined>;`

- [ ] **Step 1: Write the failing tests in `test/compact.test.ts`**

在 `test/compact.test.ts` 导入 `AssistantEntry`（来自 `@earendil-works/pi-durable`）和 `latestRequestTokens`（来自 `../src/compact.ts`），新增 2 个测试（全部使用不可重试错误，避免触发 `pi-durable` 内置重试）：
1. **跳过 `stopReason: "error"` 与 `aborted`（防 `faux` 重算非零 usage 误导阈值）**：
   - 先正常跑一轮拿真实基准 `before = await latestRequestTokens(root)`（断言 `typeof before === "number" && before > 0`）；
   - 再用 `fauxAssistantMessage("", { stopReason: "error", errorMessage: "400 content_filter_1301" })` 跑一轮失败提交（faux 会为这条 error entry 计算比 `before` 更大的 `cacheRead`）；
   - 断言 `await latestRequestTokens(root) === before`（严格相等，不采纳错误轮重算出的更大 usage），且 `maybeCompact` 在阈值为 `before + 1` 时返回 `compacted: false, reason: "below_threshold"`；
   - 再通过 `open.harness.commit((tx) => tx.appendEntry(AssistantEntry, root.id, { model: [{ ...abortedMsg, stopReason: "aborted", usage: { ...zeroUsage, input: before + 50_000, totalTokens: before + 50_000 } }] }), ctx)` 写入一条带高额 usage 的 `aborted` entry，断言 `latestRequestTokens(root)` 仍严格等于 `before`。
2. **跳过线上全零 usage 错误条目并正常触发换页**：
   - 在已超过阈值的会话里，通过 `open.harness.commit((tx) => tx.appendEntry(AssistantEntry, root.id, { model: [{ ...baseMsg, stopReason: "error", errorMessage: "Google stream ended without a finish reason", usage: zeroUsage }] }), ctx)` 追加一条与生产完全一致的全零 usage 错误 entry；再追加一条 `stopReason: "stop"` 但 `usage` 为全零的异常 entry；
   - 断言 `await latestRequestTokens(root) === before`（不是 `0`），且设置阈值 `before` 时 `open.compact(root)` 返回 `compacted: true`（而不是 `below_threshold`）。

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test test/compact.test.ts`
Expected: FAIL — `latestRequestTokens` 未导出，或返回错误轮的增大值 / `0` 导致严格相等断言与换页断言失败。

- [ ] **Step 3: Fix and export `latestRequestTokens` in `src/compact.ts:709-723`**

导出 `latestRequestTokens(conversation)`，倒序扫描 `pi.assistant` 的每条 `message`：
1. 若 `stopReason === "error" || stopReason === "aborted"`，直接 `continue`；
2. 取 `usage?.input` 与 `usage?.cacheRead`，仅当两者均为有限数字（`Number.isFinite`）且 `total = input + cacheRead > 0` 时返回 `total`；否则 `continue` 继续向前找最近一条有效请求（全页无有效请求时返回 `undefined`）。

- [ ] **Step 4: Run tests to verify pass**

Run: `node --test test/compact.test.ts`
Expected: PASS (all existing + new tests pass, execution < 2s).

- [ ] **Step 5: Commit**

```bash
git1 add src/compact.ts test/compact.test.ts
git1 commit -m "fix(compact): 换页 token 采样跳过错误轮与零用量记录"
```

---

### Task 3: 自由拍独立收紧 inline 图片与 GIF 帧数上限

**Depends on:** `none`

**Files:**
- Modify: `src/qq/round-images.ts:10-115`
- Modify: `src/app/runtime.ts:875-877,1340-1358`
- Modify: `test/quoted-images.test.ts`

**Interfaces:**
- Consumes: `planInlineImages` from `src/qq/round-images.ts`
- Produces:
  - `export const INLINE_IMAGE_MAX = 8;`
  - `export const GIF_MAX_FRAMES = 4;`
  - `export const SHARD_INLINE_IMAGE_MAX = 4;`
  - `export const SHARD_GIF_MAX_FRAMES = 2;`
  - `export interface InlineImageLimits { maxImages?: number; maxGifFrames?: number; }`
  - `export function planInlineImages(refs, mediaRoot, inline, messages, shrink?, gifFramesOf?, limits?: InlineImageLimits): InlineImagePlan;`

- [ ] **Step 1: Write the failing tests in `test/quoted-images.test.ts`**

在 `test/quoted-images.test.ts` 末尾新增 2 个测试：
1. 传入 6 张存在的静态图片 ref，以 `{ maxImages: SHARD_INLINE_IMAGE_MAX, maxGifFrames: SHARD_GIF_MAX_FRAMES }` 调用 `planInlineImages`：断言只编号并产出 **4** 张（`SHARD_INLINE_IMAGE_MAX`），超出部分不进 `blocks`；同时传入 GIF ref 用 spy 捕获 `gifFramesOf(file, maxFrames)` 的实参，断言缺省为 `GIF_MAX_FRAMES`（`4`），传自由拍限额时为 `SHARD_GIF_MAX_FRAMES`（`2`）。
2. 接线契约测试：读取 `src/app/runtime.ts` 的 `submitShardRound` 函数体，断言其调用 `planInlineImages` 时传入了 `SHARD_INLINE_IMAGE_MAX` 与 `SHARD_GIF_MAX_FRAMES`。

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test test/quoted-images.test.ts`
Expected: FAIL — `SHARD_INLINE_IMAGE_MAX` / `SHARD_GIF_MAX_FRAMES` 未导出，`submitShardRound` 未传自由拍限额。

- [ ] **Step 3: Implement optional limits in `src/qq/round-images.ts` and wire `submitShardRound` in `src/app/runtime.ts`**

1. 在 `src/qq/round-images.ts` 导出 `INLINE_IMAGE_MAX = 8`、`GIF_MAX_FRAMES = 4`、`SHARD_INLINE_IMAGE_MAX = 4`、`SHARD_GIF_MAX_FRAMES = 2` 及 `InlineImageLimits`；`planInlineImages` 新增第 7 个可选参数 `limits?: InlineImageLimits`，读取 `const maxImages = limits?.maxImages ?? INLINE_IMAGE_MAX`、`const maxGifFrames = limits?.maxGifFrames ?? GIF_MAX_FRAMES`。若调用方未显式传入 `gifFramesOf` 且传了自定义 `shrink`，默认 `gifFramesOf` 仍走 `extractGifFrames(file, maxFrames, shrink)`，保持静态图与 GIF 压缩注入一致；现有调用点保持 100% 向后兼容。
2. 在 `src/app/runtime.ts` 导入 `SHARD_INLINE_IMAGE_MAX, SHARD_GIF_MAX_FRAMES`，在 `submitShardRound`（`:1348`）调用 `planInlineImages(refs, config.mediaRoot, inline, fish.prompts.messages, undefined, undefined, { maxImages: SHARD_INLINE_IMAGE_MAX, maxGifFrames: SHARD_GIF_MAX_FRAMES })`。
3. 同步更新 `src/app/runtime.ts:875` `submitRound` 参数 `imageBlocks` 的过时注释（移除「≤2 张」）。

- [ ] **Step 4: Run tests to verify pass**

Run: `node --test test/quoted-images.test.ts test/model-input-templates.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git1 add src/qq/round-images.ts src/app/runtime.ts test/quoted-images.test.ts
git1 commit -m "perf(qq): 收紧自由拍单拍 inline 图片数与 GIF 帧数上限"
```

---

### Task 4: 轮内重试去重（`type: "continue"`）与当轮结算立刻剥离图片（`fish.image_strip`）

**Depends on:** `Task 3`

**Files:**
- Create: `src/round-image-strip.ts`
- Modify: `src/app/runtime.ts:913-1056`
- Modify: `AGENTS.md`（同步文档中关于 inline 图片生命周期与自由拍限额的描述）
- Create: `test/round-image-strip.test.ts`

**Interfaces:**
- Consumes: `Conversation`, `ConversationBusy`, `ContextEdit`, `EntryId`, `SettledSubmissionRecord` from `@earendil-works/pi-durable`; `Context` from `@earendil-works/chord/context`; `Message` from `@earendil-works/pi-ai`
- Produces (in `src/round-image-strip.ts`):
  - `export const IMAGE_STRIP_ENTRY_KIND = "fish.image_strip";`
  - `export function stripImagesFromMessages(messages: readonly Message[]): { changed: boolean; messages: Message[] };`
  - `export async function stripRoundImages(conv: Conversation, entryIds: readonly EntryId[], context: Context): Promise<number>;`
  - `export function retrySubmissionMode(hasPlacedEntryOnCurrentPage: boolean): "continue" | "input";`
  - `export function shouldFallbackContinueToInput(result: SettledSubmissionRecord): boolean;`

- [ ] **Step 1: Write the failing tests in `test/round-image-strip.test.ts`**

在 `test/round-image-strip.test.ts` 中复用 `MemoryStorage` + `fauxProvider` + `openFish` 编写以下 7 个测试（所有模拟错误均使用不可重试错误 `errorMessage: "400 content_filter_1301"`）：
1. **纯函数 `stripImagesFromMessages`**：
   - 将含 `text` + `image` block 的冻结（`Object.freeze`）`UserMessage` 剥离为新建对象（仅留 `text` block，保留 `role`/`timestamp`，不修改原冻结对象），`changed === true`；
   - 无 `image` block 时 `changed === false`；
   - 全为 `image` block 时补 `[{ type: "text", text: "" }]`。
2. **当轮结算立刻剥离（真 `pi-durable` 会话）**：
   - 提交带 2 个 `image` block 的 `fish.engage_tick` 输入；
   - 验证第 1 轮推理时 faux 收到这 2 个 `image` block；
   - 结算后调用 `stripRoundImages(conv, [settled.entry], ctx)` 返回 `1`；
   - 断言：`view.messages` 中该 user message 无 `image` block 且保留 `[图片#1 inbound/a.jpg]` 文本；`fish.image_strip` entry 无 `model` 字段、无 `head` 字段；第 2 轮纯文本请求送给模型的历史上下文零 `image` block；`renderTranscript(conv)` 仍包含原文本行。
3. **只改当轮不动更早轮次 + 幂等性 + 跨页忽略**：
   - 连续提交两轮带图输入，仅对第 2 轮 `entryId` 调 `stripRoundImages` → 返回 `1`，第 1 轮图片未被改动、第 2 轮图片已剥离；
   - 对第 2 轮 `entryId` 再次调用 `stripRoundImages` → 幂等返回 `0`，且 `view.entries` 中 `fish.image_strip` 计数不增加；
   - `conv.reset("handoff")` 后对旧页 `entryId` 调用 `stripRoundImages` → 返回 `0`，不写空 `edits`。
4. **并发忙态非阻塞入队与 `unanswered` 返回 `0`**：
   - 使用挂起的 faux response 让会话保持 busy（模拟并发必答轮 B 正在运行），调用 `stripRoundImages(conv, [entryA], ctx)`：断言在 500ms 内立刻返回 `1`（不阻塞等待 B 结束！）；放行 B 后验证 `pi.inbox` 中的 `fish.image_strip` 已落盘且后续上下文不含 `entryA` 的图片；
   - 单元测试伪 `Conversation` 返回 `status: "unanswered"` 的 write submission：断言 `stripRoundImages` 返回 `0`。
5. **轮内 `model_error` 重试走 `type: "continue"` 不重复落盘图片**：
   - 验证 `retrySubmissionMode(true) === "continue"`、`retrySubmissionMode(false) === "input"`、`shouldFallbackContinueToInput` 对 `nothing_to_answer` 返回 `true`、对 `model_error` 返回 `false`；
   - 真 `pi-durable` 会话中：第 1 次带图 `type: "input"` 遇不可重试 `stopReason: "error"`；第 2 次走 `conv.submit({ type: "continue" }, ctx)`，faux 返回正常回复 → 断言活跃页仅 1 条带图 user entry（无重复 `pi.user`），第 2 次请求仍完整收到原带图 user message，随后 `stripRoundImages` 剥离该唯一 entry。
6. **强制换页后第 3 次尝试落在新页的图片也被剥离**：
   - 第 1 次失败 → `conv.reset("handoff")` → 第 3 次 `type: "input"` 带图落在新页（`entry3`）→ 调 `stripRoundImages(conv, [entry1, entry3], ctx)` 返回 `1`（只剥离新页 `entry3`，跳过旧页 `entry1`），新页后续请求零图片。
7. **`src/app/runtime.ts` 接线契约检查**：
   - 读取 `src/app/runtime.ts` `submitRound` 函数体，验证：
     - 重试循环接入 `retrySubmissionMode`、`ConversationBusy`、`shouldFallbackContinueToInput`；
     - `zero_egress_nudge` 固定以 `"input"` 模式提交；
     - `finally` 块内严格按顺序出现：`shiftScope` → `stripRoundImages`（包裹在独立 `try/catch` 内）→ `releaseTrackedInFlight`。

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test test/round-image-strip.test.ts`
Expected: FAIL with `ERR_MODULE_NOT_FOUND` for `../src/round-image-strip.ts`.

- [ ] **Step 3: Implement `src/round-image-strip.ts`**

在 `src/round-image-strip.ts` 实现：
1. `IMAGE_STRIP_ENTRY_KIND = "fish.image_strip"`。
2. `stripImagesFromMessages(messages)`：始终返回新建 `Message` 浅拷贝对象（绝不修改 `pi-durable` 深冻结的 `view.contributions`）；若 `Array.isArray(msg.content)` 且存在 `block?.type === "image"`，过滤掉 `image` block（若全空则补 `[{ type: "text", text: "" }]`）并标记 `changed = true`。
3. `stripRoundImages(conv, entryIds, context)`：
   - 去重 `entryIds`，为空直接返回 `0`。
   - 调用 `const view = await conv.context(context)`，按同下标遍历 `view.entries` 与 `view.contributions`：
     - 仅命中 `targetSet` 的 entry 才处理；
     - 基底严格取 `view.contributions[i]`（当前生效 messages）；调用 `stripImagesFromMessages(effective)`，仅当 `changed === true` 时推入 `{ target: entry.id, action: "replace", messages }`。
   - 若 `edits.length === 0` 直接返回 `0`（绝不提交空 `edits: []`）。
   - 调用 `const sub = await conv.submit({ type: "write", entry: { kind: IMAGE_STRIP_ENTRY_KIND, edits } }, context)`；读取 `const rec = await sub.status(context)`：
     - `rec.status === "unanswered"` → 返回 `0`；
     - `rec.status === "done"` 或 `rec.status === "queued"`（并发忙态已安全进入 `pi.inbox`，会在下一 boundary 优先于新输入落盘，不 `await sub.wait()` 避免死锁）→ 返回 `edits.length`。
4. `retrySubmissionMode(hasPlacedEntryOnCurrentPage)` 与 `shouldFallbackContinueToInput(result)`。

- [ ] **Step 4: Wire retry deduplication and round-end image stripping into `src/app/runtime.ts` and sync `AGENTS.md`**

在 `src/app/runtime.ts` 的 `submitRound`（`:913-1056`）中：
1. 引入 `ConversationBusy`（来自 `@earendil-works/pi-durable`）及 `retrySubmissionMode, shouldFallbackContinueToInput, stripRoundImages`（来自 `../round-image-strip.ts`）。
2. 保持 `runSubmission` 单提交职责（只管一次 `conv.submit` + 对应单个 `subId` 的 `triggerOf`/`videos`/`bypass`/`sayCalled` 登记与 `finally` 清理），签名扩展为支持 `mode: "input" | "continue"`：
   - `mode === "continue"` 时提交 `{ type: "continue" }`；
   - `mode === "input"` 时按既有逻辑提交 `{ type: "input", content: payloadContent, entry: ... }`。
3. 在重试循环（`:999-1020`）中跟踪 `placedImageEntries: EntryId[] = []` 与 `hasPlacedEntryOnCurrentPage = false`：
   - 第 3 次尝试前 `compactWithGuard(conv, true, chatKey)` 若 `cleared.compacted === true`，置 `hasPlacedEntryOnCurrentPage = false`；
   - 每次尝试按 `attempt === 1 ? "input" : retrySubmissionMode(hasPlacedEntryOnCurrentPage)` 选择提交模式；
   - 若走 `"continue"` 时抛出 `ConversationBusy` 或结算结果满足 `shouldFallbackContinueToInput(run.result)`，外层立即干净回退调一次 `runSubmission("input", submitContent, false)`（旧 `subId` 已由 `runSubmission` 的 `finally` 清理完毕，绝不串号）；
   - 每次有效提交结算后：若 `run.result.entry !== undefined`，置 `hasPlacedEntryOnCurrentPage = true`，且当 `imageBlocks.length > 0` 时将 `run.result.entry` 推入 `placedImageEntries`。
4. `zero_egress_nudge`（`:1034`）显式以 `"input"` 模式调用 `runSubmission("input", submitContentOf(nudgeText, []), false)`。
5. 将图片剥离放进 `try/finally` 的 **`finally` 块内**，严格遵循顺序：
   ```ts
   } finally {
     if (scopeToken !== undefined) shiftScope(String(conv.id), scopeToken);
     if (placedImageEntries.length > 0) {
       try {
         await stripRoundImages(conv, placedImageEntries, ctx);
       } catch (stripError) {
         console.warn("[鱼缸] 剥离本轮历史图片失败", chatKey, stripError instanceof Error ? stripError.message : stripError);
       }
     }
     releaseTrackedInFlight();
   }
   ```
   保证：正常结束、重试失败、零出口补跑或 `try` 内提前抛异常，都会在释放 `scope` 后立刻剥离当轮图片且绝不阻断 `releaseTrackedInFlight()`。
6. 同步更新 `AGENTS.md` 中相关一两句说明（自由拍带图限额 4 图 × 2 帧、GIF 抽帧带质量与 50KB 上限、当轮结束通过 `fish.image_strip` 剥离图片上下文）。

- [ ] **Step 5: Run targeted tests and full test suite**

Run: `node --test test/round-image-strip.test.ts && npm test`
Expected: `test/round-image-strip.test.ts` 全部通过，且全量 `npm test`（含 `index-registration`、`harness-assembly`、`prompts`、`compact`、`quoted-images`、`model-input-templates`、`zero-egress-nudge`）全绿。

- [ ] **Step 6: Commit**

```bash
git1 add src/round-image-strip.ts src/app/runtime.ts test/round-image-strip.test.ts AGENTS.md
git1 commit -m "feat(runtime): 轮内重试复用原输入并在轮末立刻剥离历史图片"
```

---

## Independent Plan Review Record

- **Reviewer:** Fresh read-only `pi-worker` (`tier: "heavy"`, `zai-coding-cn/glm-5.4`, task `2d304757-0cb7-4f6a-98d6-091dd6a494a2`, HEAD `51e9a3d`).
- **Resolved Critical findings:**
  - **C1** (`faux` 对 error/aborted 重算 usage 导致测试假通过 + 未覆盖生产全零 usage) → 已改为严格相等断言 `latestRequestTokens === before` + `before + 1` 返回 `below_threshold` + `harness.commit` 直接写入全零 `AssistantEntry` 与 `aborted` 条目。
  - **C2** (`pi-durable` 对可重试错误触发内置 14s 重试) → 已写入 Global Constraints 与全部测试，统一钉死不可重试错误（如 `400 content_filter_1301`）。
  - **C3** (剥图放 `try` 尾部且 `await sub.wait()` 在并发必答轮下阻塞并串用 `scope`、异常路径漏剥) → 已移入 `finally`（`shiftScope` → `try/catch stripRoundImages` → `releaseTrackedInFlight`），且忙态 `status === "queued"` 时不阻塞等待 `wait()`。
- **Resolved Suggestions & Minors:**
  - **S1** (`nudge` 固定 `"input"` mode)、**S2** (`runSubmission` 单提交生命周期 + 外层回退)、**S3** (补 `submitShardRound` 接线契约测试)、**S4** (补忙态非阻塞、`unanswered` 返回 `0`、`finally` 顺序契约测试)、**S5** (断言 `-q:v` 在 `-i` 之后、`shrink` 透传、注明本机无 `ffmpeg`)、**S6** (同步更新 `AGENTS.md`)、**S7** (Architecture 明确 `ContextEdit` 不回收历史 `fish.db` 字节)、**M1/M2/M4** (行号校准、仅取 `view.contributions` 且深冻结对象新建、`unanswered` 返回 `0`) 均已吸收。
- **Intentionally deferred:**
  - **S3 部分（`slice(0, maxImages)` 保留早图 vs 最新图）**：保持既有顺序与 `@` 轮（直发图优先于引用图）一致，不改变编号语义；
  - **M5（Linux 容器超 50KB 单帧逐帧 `spawnSync` sharp worker）**：加入 `-q:v 6` 后 640px GIF 帧绝大多数已 ≤50KB，仅极少数高噪帧触发 `shrink`，实际开销极低，无需提前复杂化批量 worker；
  - **跨轮追问回查 `look`**：用户明确要求本阶段先不处理。
