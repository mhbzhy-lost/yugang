/**
 * 上下文压缩：换页 + 备忘。
 *  - 只有「群友说的话 + 鱼发出去的话」进摘要，thinking / tool 调用 / tool 结果不进
 *  - 到阈值才压，压完 conversation.reset(handoff)
 *  - 摘要提示词来自 prompt/handoff.md
 */
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { createModels } from "@earendil-works/pi-ai/models";
import { fauxAssistantMessage, fauxProvider, fauxToolCall } from "@earendil-works/pi-ai/providers/faux";
import { MemoryStorage } from "@earendil-works/pi-durable";
import { openFish } from "../src/harness.ts";
import { renderTranscript } from "../src/compact.ts";

const ctx = BACKGROUND_CONTEXT;
const PROMPTS = fileURLToPath(new URL("../prompt", import.meta.url));

function boot(compact: { maxEntries: number; maxChars: number }) {
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
    compact,
    emit: () => {},
  });
  return { faux, fish };
}

test("摘要只收群友的话和鱼发出去的话", async () => {
  const { faux, fish } = boot({ maxEntries: 999, maxChars: 999_999 });
  const open = await fish;
  try {
    const root = await open.harness.root(ctx, {
      agent: { model: { provider: faux.provider.id, modelId: faux.models[0].id } },
    });

    faux.setResponses([
      fauxAssistantMessage([fauxToolCall("draw", { description: "一只鱼" })], { stopReason: "toolUse" }),
      fauxAssistantMessage([fauxToolCall("say", { text: "画好了" })], { stopReason: "toolUse" }),
      fauxAssistantMessage("内部独白，不该进摘要"),
    ]);
    await (await root.submit({ type: "input", content: "画个鱼" }, ctx)).wait(ctx);

    const rendered = await renderTranscript(root);
    assert.match(rendered.transcript, /群友: 画个鱼/);
    assert.match(rendered.transcript, /鱼: 画好了/);
    assert.ok(!rendered.transcript.includes("内部独白"), "模型正文进了摘要");
    assert.ok(!rendered.transcript.includes("draw"), "tool 调用进了摘要");
    assert.ok(!rendered.transcript.includes("画好了，路径"), "tool 结果进了摘要");
  } finally {
    await open.close();
  }
});

test("到阈值才压，压完写到 pi.reset 里", async () => {
  const { faux, fish } = boot({ maxEntries: 3, maxChars: 999_999 });
  const open = await fish;
  try {
    const root = await open.harness.root(ctx, {
      agent: { model: { provider: faux.provider.id, modelId: faux.models[0].id } },
    });

    // 第一轮：2 条（1 条群友 + 1 条鱼），还没有到 3 条阈值
    faux.setResponses([
      fauxAssistantMessage([fauxToolCall("say", { text: "在的" })], { stopReason: "toolUse" }),
      fauxAssistantMessage("好了"),
    ]);
    await (await root.submit({ type: "input", content: "在吗" }, ctx)).wait(ctx);

    const below = await open.compact(root);
    assert.equal(below.compacted, false, "没到阈值不该压");
    assert.equal(below.reason, "below_threshold");

    // 第二轮：再到 2 条，累计 4 条，过阈值
    faux.setResponses([
      fauxAssistantMessage([fauxToolCall("say", { text: "刚在刷手机" })], { stopReason: "toolUse" }),
      fauxAssistantMessage("好了"),
    ]);
    await (await root.submit({ type: "input", content: "干嘛呢" }, ctx)).wait(ctx);

    // 第三次：模型给出备忘
    faux.setResponses([fauxAssistantMessage("1. 群友在闲聊。2. 鱼说过自己在刷手机。")]);
    const done = await open.compact(root);
    assert.equal(done.compacted, true, "到阈值应该压");

    const view = await root.viewState(ctx);
    const reset = view.value.entries.find((e) => e.kind === "pi.reset");
    assert.ok(reset, "没有写入 pi.reset");
    assert.match(JSON.stringify(reset.model ?? ""), /鱼说过自己在刷手机/, "handoff 没进 reset");
    view.dispose();

    // 换页之后，上下文从备忘开始，旧对话不再在活跃 transcript 里
    const after = await renderTranscript(root);
    assert.ok(!after.transcript.includes("在吗"), "旧对话没有从活跃上下文里退场");
  } finally {
    await open.close();
  }
});

test("没配 compact 就永不压缩", async () => {
  const faux = fauxProvider();
  const models = createModels();
  models.setProvider(faux.provider);
  const fish = await openFish({
    storage: new MemoryStorage(),
    models,
    model: { provider: faux.provider.id, modelId: faux.models[0].id },
    promptRoot: PROMPTS,
    mediaRoot: mkdtempSync(join(tmpdir(), "yg-m-")),
    workspaceRoot: mkdtempSync(join(tmpdir(), "yg-w-")),
    emit: () => {},
  });
  try {
    const root = await fish.harness.root(ctx);
    const result = await fish.compact(root);
    assert.equal(result.compacted, false);
  } finally {
    await fish.close();
  }
});
