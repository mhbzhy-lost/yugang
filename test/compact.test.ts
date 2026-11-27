/**
 * 上下文压缩：换页 + 备忘。
 *  - 只有「群友说的话 + 鱼发出去的话」进摘要，thinking / tool 调用 / tool 结果不进
 *  - 到阈值才压，压完 conversation.reset(handoff)
 *  - 摘要提示词来自 prompt/handoff.md
 */
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { createModels } from "@earendil-works/pi-ai/models";
import { fauxAssistantMessage, fauxProvider, fauxToolCall } from "@earendil-works/pi-ai/providers/faux";
import { AssistantEntry, MemoryStorage } from "@earendil-works/pi-durable";
import { openFish } from "../src/harness.ts";
import { latestRequestTokens, renderTranscript } from "../src/compact.ts";
import { compactTokenLimitOf, loadFishConfig } from "../src/fish-config.ts";

const ctx = BACKGROUND_CONTEXT;
const PROMPTS = fileURLToPath(new URL("../prompt", import.meta.url));

function boot(compact: { maxTokens: number }) {
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
    react: () => {},
  });
  return { faux, fish };
}

test("摘要只收群友的话和鱼发出去的话", async () => {
  const { faux, fish } = boot({ maxTokens: 999_999 });
  const open = await fish;
  try {
    const root = await open.harness.root(ctx, {
      agent: { model: { provider: faux.provider.id, modelId: faux.models[0].id } },
    });

    faux.setResponses([
      fauxAssistantMessage([fauxToolCall("react", { emoji: "124" })], { stopReason: "toolUse" }),
      fauxAssistantMessage([fauxToolCall("say_words", { text: "画好了" })], { stopReason: "toolUse" }),
      fauxAssistantMessage("内部独白，不该进摘要"),
    ]);
    await (await root.submit({ type: "input", content: "画个鱼" }, ctx)).wait(ctx);

    const rendered = await renderTranscript(root);
    assert.match(rendered.transcript, /群友: 画个鱼/);
    assert.match(rendered.transcript, /我: 画好了/);
    assert.ok(!rendered.transcript.includes("内部独白"), "模型正文进了摘要");
    assert.ok(!rendered.transcript.includes("react"), "tool 调用进了摘要");
    assert.ok(!rendered.transcript.includes("贴上了"), "tool 结果进了摘要");
  } finally {
    await open.close();
  }
});

test("到 token 阈值才压，完整消息不被截断并写到 pi.reset 里", async () => {
  assert.equal(compactTokenLimitOf({ maxTokens: 100_000, byModel: { "google-antigravity": 90_000 } }, "google-antigravity", "gemini-3.8-flash-tiered"), 90_000);
  assert.equal(compactTokenLimitOf({ maxTokens: 100_000, byModel: { "google-antigravity": 90_000 } }, "zai-coding-cn", "glm-5.3-flash"), 100_000);
  assert.equal(compactTokenLimitOf({ maxTokens: 100_000, byModel: { "zai-coding-cn/glm-5.3-flash": 110_000 } }, "zai-coding-cn", "glm-5.3-flash"), 110_000);
  const legacyPath = join(mkdtempSync(join(tmpdir(), "yg-c-")), "fish.config.json");
  writeFileSync(legacyPath, JSON.stringify({ compact: { maxEntries: 200, maxChars: 50_000 } }));
  const legacy = loadFishConfig({ path: legacyPath });
  assert.equal(compactTokenLimitOf(legacy.config.compact, "google-antigravity", "gemini-3.8-flash-tiered"), 90_000);
  assert.equal(compactTokenLimitOf(legacy.config.compact, "zai-coding-cn", "glm-5.3-flash"), 100_000);
  const { faux, fish } = boot({ maxTokens: 2_700 });
  const open = await fish;
  try {
    const root = await open.harness.root(ctx, {
      agent: { model: { provider: faux.provider.id, modelId: faux.models[0].id } },
    });

    // 第一轮：faux usage 为零，还没到 2700 tokens 阈值
    faux.setResponses([
      fauxAssistantMessage([fauxToolCall("say_words", { text: "在的" })], { stopReason: "toolUse" }),
      fauxAssistantMessage("好了"),
    ]);
    await (await root.submit({ type: "input", content: "在吗" }, ctx)).wait(ctx);

    const below = await open.compact(root);
    assert.equal(below.compacted, false, JSON.stringify(below));
    assert.equal(below.reason, "below_threshold");

    // 第二轮：长消息把实际请求推过 2700 tokens；完整进入本轮后才换页
    const longMessage = "完整长消息".repeat(300);
    faux.setResponses([
      fauxAssistantMessage([fauxToolCall("say_words", { text: "刚在刷手机" })], { stopReason: "toolUse" }),
      fauxAssistantMessage("好了"),
    ]);
    await (await root.submit({ type: "input", content: `> 消息起始\n[m:100] 群友: ${longMessage}\n> 消息结束` }, ctx)).wait(ctx);

    // 第三次：模型给出剖面卡片的字段（严格 JSON：逐字引用经 substring 校验）
    faux.setResponses([fauxAssistantMessage('{"threads":[],"promises":[{"quote":"刚在刷手机","status":"open"}],"mood":"闲聊"}')]);
    const done = await open.compact(root);
    assert.equal(done.compacted, true, "到 token 阈值应该压");
    assert.ok((done.tokens ?? 0) >= 2_700);

    const view = await root.context(ctx);
    const reset = view.entries.find((e) => e.kind === "pi.reset");
    assert.ok(reset, "没有写入 pi.reset");
    assert.match(JSON.stringify(reset.model ?? ""), /「刚在刷手机」（未兑现）/, "handoff 没进 reset");
    assert.ok(JSON.stringify(reset).includes(longMessage), "触发阈值的长消息被截断了");

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
    react: () => {},
  });
  try {
    const root = await fish.harness.root(ctx);
    const result = await fish.compact(root);
    assert.equal(result.compacted, false);
  } finally {
    await fish.close();
  }
});

const ZERO_USAGE = {
  input: 0,
  output: 0,
  cacheRead: 0,
  cacheWrite: 0,
  totalTokens: 0,
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
};

test("latestRequestTokens 跳过 error 与 aborted 条目，不被错误轮重算的 usage 污染", async () => {
  const faux = fauxProvider();
  const models = createModels();
  models.setProvider(faux.provider);
  let maxTokens = 999_999;
  const open = await openFish({
    storage: new MemoryStorage(),
    models,
    model: { provider: faux.provider.id, modelId: faux.models[0].id },
    promptRoot: PROMPTS,
    mediaRoot: mkdtempSync(join(tmpdir(), "yg-m-")),
    workspaceRoot: mkdtempSync(join(tmpdir(), "yg-w-")),
    compact: { maxTokens: 999_999, limits: () => ({ maxTokens }) },
    emit: () => {},
    react: () => {},
  });
  try {
    const root = await open.harness.root(ctx, {
      agent: { model: { provider: faux.provider.id, modelId: faux.models[0].id } },
    });

    faux.setResponses([
      fauxAssistantMessage([fauxToolCall("say_words", { text: "在的" })], { stopReason: "toolUse" }),
      fauxAssistantMessage("好了"),
    ]);
    await (await root.submit({ type: "input", content: `> 消息起始\n[m:1] 群友: ${"正常消息".repeat(120)}\n> 消息结束` }, ctx)).wait(ctx);

    const before = await latestRequestTokens(root);
    assert.equal(typeof before, "number");
    assert.ok((before ?? 0) > 0, `期望首轮有效 token > 0，实际 ${String(before)}`);

    // 不可重试错误轮：faux 会重算更大的 cacheRead，未修复实现会采纳错误轮数值
    faux.setResponses([
      fauxAssistantMessage("", { stopReason: "error", errorMessage: "400 content_filter_1301" }),
    ]);
    await (await root.submit({ type: "input", content: `> 消息起始\n[m:2] 群友: ${"触发错误".repeat(60)}\n> 消息结束` }, ctx)).wait(ctx);

    assert.equal(await latestRequestTokens(root), before, "错误轮不应覆盖上一正常轮的 token 采样");
    maxTokens = (before as number) + 1;
    const below = await open.compact(root);
    assert.equal(below.compacted, false, "阈值高于正常轮时不应受错误轮 usage 误触发换页");
    assert.equal(below.reason, "below_threshold");
    assert.equal(below.tokens, before);

    // aborted 条目即使携带高额 usage 也必须跳过
    const aborted = {
      ...fauxAssistantMessage("", { stopReason: "aborted" }),
      usage: { ...ZERO_USAGE, input: (before as number) + 50_000, totalTokens: (before as number) + 50_000 },
    };
    await open.harness.commit(async (tx) => {
      await tx.appendEntry(AssistantEntry, root.id, { model: [aborted] });
    }, ctx);
    assert.equal(await latestRequestTokens(root), before, "aborted 条目不应覆盖正常轮采样");
  } finally {
    await open.close();
  }
});

test("latestRequestTokens 跳过线上全零 usage 错误条目，换页正常触发", async () => {
  const faux = fauxProvider();
  const models = createModels();
  models.setProvider(faux.provider);
  let maxTokens = 999_999;
  const open = await openFish({
    storage: new MemoryStorage(),
    models,
    model: { provider: faux.provider.id, modelId: faux.models[0].id },
    promptRoot: PROMPTS,
    mediaRoot: mkdtempSync(join(tmpdir(), "yg-m-")),
    workspaceRoot: mkdtempSync(join(tmpdir(), "yg-w-")),
    compact: { maxTokens: 999_999, limits: () => ({ maxTokens }) },
    emit: () => {},
    react: () => {},
  });
  try {
    const root = await open.harness.root(ctx, {
      agent: { model: { provider: faux.provider.id, modelId: faux.models[0].id } },
    });

    faux.setResponses([
      fauxAssistantMessage([fauxToolCall("say_words", { text: "收到" })], { stopReason: "toolUse" }),
      fauxAssistantMessage("好了"),
    ]);
    await (await root.submit({ type: "input", content: `> 消息起始\n[m:10] 群友: ${"高图量消息".repeat(150)}\n> 消息结束` }, ctx)).wait(ctx);

    const before = await latestRequestTokens(root);
    assert.ok(typeof before === "number" && before > 0);

    // 模拟线上流中断写入的全零 usage 错误条目 + 异常零 usage 条目
    const zeroErr = {
      ...fauxAssistantMessage("", { stopReason: "error", errorMessage: "Google stream ended without a finish reason" }),
      usage: ZERO_USAGE,
    };
    const zeroStop = {
      ...fauxAssistantMessage("空"),
      usage: ZERO_USAGE,
    };
    await open.harness.commit(async (tx) => {
      await tx.appendEntry(AssistantEntry, root.id, { model: [zeroErr] });
      await tx.appendEntry(AssistantEntry, root.id, { model: [zeroStop] });
    }, ctx);

    assert.equal(await latestRequestTokens(root), before, "全零 usage 条目不应把采样归零");

    maxTokens = before;
    faux.setResponses([fauxAssistantMessage('{"threads":[],"promises":[],"mood":"闲聊"}')]);
    const done = await open.compact(root);
    assert.equal(done.compacted, true, "回退到上一有效轮 token 后应正常触发换页");
    assert.equal(done.tokens, before);
  } finally {
    await open.close();
  }
});
