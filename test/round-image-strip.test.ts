import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { createModels } from "@earendil-works/pi-ai/models";
import { fauxAssistantMessage, fauxProvider, fauxToolCall } from "@earendil-works/pi-ai/providers/faux";
import type { Message } from "@earendil-works/pi-ai";
import { MemoryStorage, type Conversation, type EntryId, type SettledSubmissionRecord } from "@earendil-works/pi-durable";
import { openFish } from "../src/harness.ts";
import { MEMORY_ENGAGE_KIND, renderTranscript } from "../src/compact.ts";
import {
  IMAGE_STRIP_ENTRY_KIND,
  retrySubmissionMode,
  shouldFallbackContinueToInput,
  stripImagesFromMessages,
  stripRoundImages,
} from "../src/round-image-strip.ts";

const ctx = BACKGROUND_CONTEXT;
const PROMPTS = fileURLToPath(new URL("../prompt", import.meta.url));

function boot() {
  const faux = fauxProvider();
  const models = createModels();
  models.setProvider(faux.provider);
  const fish = openFish({
    storage: new MemoryStorage(),
    models,
    model: { provider: faux.provider.id, modelId: faux.models[0].id },
    promptRoot: PROMPTS,
    mediaRoot: mkdtempSync(join(tmpdir(), "yg-m-")),
    workspaceRoot: mkdtempSync(join(tmpdir(), "yg-w-")),
    emit: () => {},
    react: () => {},
  });
  return { faux, fish };
}

function countImageBlocks(messages: readonly Message[]): number {
  let n = 0;
  for (const m of messages) {
    if (!Array.isArray(m.content)) continue;
    for (const block of m.content) {
      if ((block as { type?: unknown })?.type === "image") n += 1;
    }
  }
  return n;
}

const IMG_BLOCK_1 = { type: "image" as const, data: Buffer.from("img-1").toString("base64"), mimeType: "image/jpeg" };
const IMG_BLOCK_2 = { type: "image" as const, data: Buffer.from("img-2").toString("base64"), mimeType: "image/jpeg" };

test("stripImagesFromMessages 剥离冻结消息中的 image block 且不修改原对象", () => {
  const origContent = Object.freeze([
    Object.freeze({ type: "text" as const, text: "看图 [图片#1 inbound/a.jpg]" }),
    Object.freeze({ ...IMG_BLOCK_1 }),
  ]);
  const origMsg = Object.freeze({
    role: "user" as const,
    content: origContent,
    timestamp: 12345,
  }) as unknown as Message;

  const res = stripImagesFromMessages([origMsg]);
  assert.equal(res.changed, true);
  assert.equal(res.messages.length, 1);
  assert.notEqual(res.messages[0], origMsg, "必须返回新对象，不能原地改冻结对象");
  assert.equal(res.messages[0].role, "user");
  assert.equal((res.messages[0] as { timestamp: number }).timestamp, 12345);
  assert.deepEqual(res.messages[0].content, [{ type: "text", text: "看图 [图片#1 inbound/a.jpg]" }]);
  assert.equal(origContent.length, 2, "原冻结数组不应被改动");

  // 无 image block 时 changed === false
  const plain = { role: "user" as const, content: "纯文本", timestamp: 99 } as unknown as Message;
  assert.equal(stripImagesFromMessages([plain]).changed, false);

  // 全为 image block 时保留空文本 block，不产出空数组
  const onlyImg = { role: "user" as const, content: [IMG_BLOCK_1], timestamp: 100 } as unknown as Message;
  const onlyRes = stripImagesFromMessages([onlyImg]);
  assert.equal(onlyRes.changed, true);
  assert.deepEqual(onlyRes.messages[0].content, [{ type: "text", text: "" }]);
});

test("当轮结算立刻剥离图片：本轮模型可见、下一轮零图片重放、摘要保留原文本", async () => {
  const { faux, fish } = boot();
  const open = await fish;
  try {
    const conv = await open.harness.root(ctx, {
      agent: { model: { provider: faux.provider.id, modelId: faux.models[0].id } },
    });

    const seenImagesPerCall: number[] = [];
    faux.setResponses([
      (reqCtx) => {
        seenImagesPerCall.push(countImageBlocks(reqCtx.messages));
        return fauxAssistantMessage([fauxToolCall("say_words", { text: "看到了" })], { stopReason: "toolUse" });
      },
      (reqCtx) => {
        seenImagesPerCall.push(countImageBlocks(reqCtx.messages));
        return fauxAssistantMessage("完");
      },
    ]);

    const sub = await conv.submit(
      {
        type: "input",
        content: [
          { type: "text", text: "> 消息起始\n[m:1] 群友: 看图 [图片#1 inbound/a.jpg]\n> 消息结束" },
          IMG_BLOCK_1,
          IMG_BLOCK_2,
        ],
        entry: { kind: MEMORY_ENGAGE_KIND },
      },
      ctx,
    );
    const settled = await sub.wait(ctx);
    assert.equal(settled.status, "done");
    assert.ok(settled.entry !== undefined);
    assert.deepEqual(seenImagesPerCall, [2, 2], "当轮工具多步推理期间模型应能看到本轮图片");

    const stripped = await stripRoundImages(conv, [settled.entry], ctx);
    assert.equal(stripped, 1);

    const viewAfter = await conv.context(ctx);
    assert.equal(countImageBlocks(viewAfter.messages), 0, "剥离后活跃上下文不应残留 image block");
    assert.match(JSON.stringify(viewAfter.messages), /\[图片#1 inbound\/a\.jpg\]/, "文本占位必须保留");
    const stripEntry = viewAfter.entries.find((e) => e.kind === IMAGE_STRIP_ENTRY_KIND);
    assert.ok(stripEntry, "应写入 fish.image_strip entry");
    assert.equal(stripEntry.model, undefined, "edit entry 严禁带 model 字段");
    assert.equal(stripEntry.head, undefined, "edit entry 严禁带 head 字段");

    // 下一轮纯文本请求：历史上下文里零图片
    let nextCallImages = -1;
    faux.setResponses([
      (reqCtx) => {
        nextCallImages = countImageBlocks(reqCtx.messages);
        return fauxAssistantMessage("ok");
      },
    ]);
    await (await conv.submit({ type: "input", content: "下一句" }, ctx)).wait(ctx);
    assert.equal(nextCallImages, 0, "下一轮送给模型的历史上下文应零图片");

    // 摘要 / 渲染仍读取原始文本（不丢内容）
    const rendered = await renderTranscript(conv);
    assert.ok(rendered.entries > 0);
  } finally {
    await open.close();
  }
});

test("只改当轮不动更早历史 + 幂等性 + 跨页忽略", async () => {
  const { faux, fish } = boot();
  const open = await fish;
  try {
    const conv = await open.harness.root(ctx, {
      agent: { model: { provider: faux.provider.id, modelId: faux.models[0].id } },
    });

    faux.setResponses([fauxAssistantMessage("r1"), fauxAssistantMessage("r2")]);
    const s1 = await (await conv.submit({
      type: "input",
      content: [{ type: "text", text: "第一轮" }, IMG_BLOCK_1],
    }, ctx)).wait(ctx);
    const s2 = await (await conv.submit({
      type: "input",
      content: [{ type: "text", text: "第二轮" }, IMG_BLOCK_2],
    }, ctx)).wait(ctx);
    assert.ok(s1.entry !== undefined && s2.entry !== undefined);

    // 仅剥第 2 轮，第 1 轮历史图片必须原样保留
    assert.equal(await stripRoundImages(conv, [s2.entry], ctx), 1);
    const view1 = await conv.context(ctx);
    assert.equal(countImageBlocks(view1.messages), 1, "第 1 轮图片不应被触碰");
    const stripCount1 = view1.entries.filter((e) => e.kind === IMAGE_STRIP_ENTRY_KIND).length;
    assert.equal(stripCount1, 1);

    // 幂等重调：不再写多余 entry
    assert.equal(await stripRoundImages(conv, [s2.entry], ctx), 0);
    const view2 = await conv.context(ctx);
    assert.equal(view2.entries.filter((e) => e.kind === IMAGE_STRIP_ENTRY_KIND).length, 1);

    // 换页后对旧页 entry 调用：安静返回 0
    await conv.reset("handoff", ctx);
    assert.equal(await stripRoundImages(conv, [s1.entry, s2.entry], ctx), 0);
    const view3 = await conv.context(ctx);
    assert.equal(view3.entries.filter((e) => e.kind === IMAGE_STRIP_ENTRY_KIND).length, 0);
  } finally {
    await open.close();
  }
});

test("并发忙态非阻塞入队，unanswered 写入返回 0", async () => {
  const { faux, fish } = boot();
  const open = await fish;
  try {
    const conv = await open.harness.root(ctx, {
      agent: { model: { provider: faux.provider.id, modelId: faux.models[0].id } },
    });

    faux.setResponses([fauxAssistantMessage("r1")]);
    const s1 = await (await conv.submit({
      type: "input",
      content: [{ type: "text", text: "轮A" }, IMG_BLOCK_1],
    }, ctx)).wait(ctx);
    assert.ok(s1.entry !== undefined);

    // 启动一个挂起的并发轮 B，使会话保持 busy
    let releaseB!: () => void;
    const gateB = new Promise<void>((resolve) => { releaseB = resolve; });
    let bStarted!: () => void;
    const waitBStart = new Promise<void>((resolve) => { bStarted = resolve; });

    faux.setResponses([
      async () => {
        bStarted();
        await gateB;
        return fauxAssistantMessage("rB");
      },
    ]);
    const subB = await conv.submit({ type: "input", content: "轮B" }, ctx);
    await waitBStart;

    // 忙态下剥图必须立即返回 1（已入队），绝不阻塞等 B 完成
    const t0 = Date.now();
    const n = await stripRoundImages(conv, [s1.entry], ctx);
    const elapsed = Date.now() - t0;
    assert.equal(n, 1);
    assert.ok(elapsed < 500, `忙态剥图不应阻塞等待在途轮（耗时 ${elapsed}ms）`);

    releaseB();
    await subB.wait(ctx);
    // B 结束后提交下一轮前，排队的 strip 写已生效（或随边界先于新输入落盘）
    let nextImages = -1;
    faux.setResponses([
      (reqCtx) => {
        nextImages = countImageBlocks(reqCtx.messages);
        return fauxAssistantMessage("rC");
      },
    ]);
    await (await conv.submit({ type: "input", content: "轮C" }, ctx)).wait(ctx);
    assert.equal(nextImages, 0, "入队的 strip 写必须在下一次推理前生效");

    // 伪造 unanswered 返回 0
    const fakeConv = {
      context: async () => ({
        entries: [{ id: 1 as EntryId, kind: "pi.user" }],
        contributions: [[{ role: "user", content: [{ type: "text", text: "hi" }, IMG_BLOCK_1], timestamp: 1 }]],
      }),
      submit: async () => ({
        status: async () => ({ status: "unanswered", reason: "stale" }),
      }),
    } as unknown as Conversation;
    assert.equal(await stripRoundImages(fakeConv, [1 as EntryId], ctx), 0);
  } finally {
    await open.close();
  }
});

test("轮内 model_error 重试走 type:continue 不重复落盘图片", async () => {
  assert.equal(retrySubmissionMode(true), "continue");
  assert.equal(retrySubmissionMode(false), "input");
  assert.equal(shouldFallbackContinueToInput({ status: "unanswered", reason: "nothing_to_answer" } as unknown as SettledSubmissionRecord), true);
  assert.equal(shouldFallbackContinueToInput({ status: "unanswered", reason: "model_error" } as unknown as SettledSubmissionRecord), false);

  const { faux, fish } = boot();
  const open = await fish;
  try {
    const conv = await open.harness.root(ctx, {
      agent: { model: { provider: faux.provider.id, modelId: faux.models[0].id } },
    });

    const reqImages: number[] = [];
    faux.setResponses([
      (reqCtx) => {
        reqImages.push(countImageBlocks(reqCtx.messages));
        return fauxAssistantMessage("", { stopReason: "error", errorMessage: "400 content_filter_1301" });
      },
      (reqCtx) => {
        reqImages.push(countImageBlocks(reqCtx.messages));
        return fauxAssistantMessage("重试成功");
      },
    ]);

    const first = await (await conv.submit({
      type: "input",
      content: [{ type: "text", text: "带图消息" }, IMG_BLOCK_1],
      entry: { kind: MEMORY_ENGAGE_KIND },
    }, ctx)).wait(ctx);
    assert.equal(first.status, "unanswered");
    assert.ok(first.entry !== undefined);

    const retry = await (await conv.submit({ type: "continue" }, ctx)).wait(ctx);
    assert.equal(retry.status, "done");
    assert.deepEqual(reqImages, [1, 1], "第 2 次 continue 重试仍完整携带第 1 次的原图");

    const view = await conv.context(ctx);
    const userEntries = view.entries.filter((e) => e.kind === MEMORY_ENGAGE_KIND || e.kind === "pi.user");
    assert.equal(userEntries.length, 1, "重试不应多写重复 pi.user entry");

    assert.equal(await stripRoundImages(conv, [first.entry], ctx), 1);
    assert.equal(countImageBlocks((await conv.context(ctx)).messages), 0);
  } finally {
    await open.close();
  }
});

test("强制换页后第 3 次尝试落在新页的图片也必须被剥离", async () => {
  const { faux, fish } = boot();
  const open = await fish;
  try {
    const conv = await open.harness.root(ctx, {
      agent: { model: { provider: faux.provider.id, modelId: faux.models[0].id } },
    });

    faux.setResponses([
      fauxAssistantMessage("", { stopReason: "error", errorMessage: "400 content_filter_1301" }),
      fauxAssistantMessage("新页成功"),
    ]);

    const attempt1 = await (await conv.submit({
      type: "input",
      content: [{ type: "text", text: "图1" }, IMG_BLOCK_1],
      entry: { kind: MEMORY_ENGAGE_KIND },
    }, ctx)).wait(ctx);
    assert.ok(attempt1.entry !== undefined);

    // 模拟第 3 次前强制换页
    await conv.reset("机械换页", ctx);
    const attempt3 = await (await conv.submit({
      type: "input",
      content: [{ type: "text", text: "图1" }, IMG_BLOCK_1],
    }, ctx)).wait(ctx);
    assert.equal(attempt3.status, "done");
    assert.ok(attempt3.entry !== undefined);

    // 传入旧页 entry1 与新页 entry3：仅剥离新页 entry3
    assert.equal(await stripRoundImages(conv, [attempt1.entry, attempt3.entry], ctx), 1);
    assert.equal(countImageBlocks((await conv.context(ctx)).messages), 0);
  } finally {
    await open.close();
  }
});

test("runtime.ts submitRound 接线契约：重试走 continue 回退、nudge 固定 input、finally 顺序正确", () => {
  const src = readFileSync(fileURLToPath(new URL("../src/app/runtime.ts", import.meta.url)), "utf8");
  const start = src.indexOf("export async function submitRound(");
  const end = src.indexOf("async function compactWithGuard(", start);
  assert.ok(start !== -1 && end > start);
  const body = src.slice(start, end);

  assert.match(body, /retrySubmissionMode\(/, "重试循环应接入 retrySubmissionMode");
  assert.match(body, /ConversationBusy/, "应处理 continue 的 ConversationBusy 回退");
  assert.match(body, /shouldFallbackContinueToInput\(/, "应处理 continue 的 nothing_to_answer 回退");
  assert.match(body, /runSubmission\("input",\s*submitContentOf\(nudgeText,\s*\[\]\)/, "zero_egress_nudge 必须固定使用 input 模式");

  // 验证 finally 块内顺序：shiftScope -> stripRoundImages -> releaseTrackedInFlight
  const innerFinally = body.indexOf("} finally {\n    // scope 队列满");
  assert.notEqual(innerFinally, -1, "未找到内层 finally 块");
  const finallyBlock = body.slice(innerFinally, innerFinally + 800);
  const idxShift = finallyBlock.indexOf("shiftScope(");
  const idxStrip = finallyBlock.indexOf("stripRoundImages(");
  const idxRelease = finallyBlock.indexOf("releaseTrackedInFlight()");
  assert.ok(idxShift !== -1 && idxStrip !== -1 && idxRelease !== -1, "finally 块缺少关键清理调用");
  assert.ok(idxShift < idxStrip && idxStrip < idxRelease, "finally 顺序必须为 shiftScope → stripRoundImages → releaseTrackedInFlight");
});
