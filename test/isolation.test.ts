/**
 * 隔离性的最小证明：
 *  1. 只有 say() 的参数会出境；模型最终正文不会
 *  2. 从思考里抄来的文本会被硬拒绝，并作为 tool 错误回给模型
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
import { MemoryStorage } from "@earendil-works/pi-durable";
import { openFish } from "../src/harness.ts";
import { rememberSecrets } from "../src/egress/ledger.ts";

const ctx = BACKGROUND_CONTEXT;
const PROMPTS = fileURLToPath(new URL("../prompt", import.meta.url));


function mediaRoot(): string {
  return mkdtempSync(join(tmpdir(), "yugang-"));
}

test("模型正文不出境，只有 say 的 text 会", async () => {
  const faux = fauxProvider();
  const models = createModels();
  models.setProvider(faux.provider);

  faux.setResponses([
    fauxAssistantMessage([fauxToolCall("say", { messages: ["在的"] })], { stopReason: "toolUse" }),
    // 这一句是「模型的真实输出」，绝对不许进群
    fauxAssistantMessage("我已经调用 say 工具，把「在的」发送到群里了。"),
  ]);

  const outbox: string[] = [];
  const fish = await openFish({
    storage: new MemoryStorage(),
    models,
    model: { provider: faux.provider.id, modelId: faux.models[0].id },
    promptRoot: PROMPTS,
    workspaceRoot: mediaRoot(),
    mediaRoot: mediaRoot(),
    react: () => {},
    emit: (_id, payload) => {
      outbox.push(...payload.items);
    },
  });

  try {
    const root = await fish.harness.root(ctx, { agent: { model: { provider: faux.provider.id, modelId: faux.models[0].id } } });
    const submission = await root.submit({ type: "input", content: "在吗" }, ctx);
    const settled = await submission.wait(ctx);

    assert.equal(settled.status, "done");
    assert.deepEqual(outbox, ["在的"], "群里只应该收到 say 的参数");
    assert.ok(!outbox.join("\n").includes("我已经调用"), "模型正文泄漏了");
  } finally {
    await fish.close();
  }
});

test("从思考里抄来的话被拒，且以 tool 错误返回", async () => {
  const faux = fauxProvider();
  const models = createModels();
  models.setProvider(faux.provider);

  const secret = "我需要先分析一下这个群最近在聊什么然后再决定要不要说话以及说什么";
  const leaky = secret.slice(0, 40); // 40 字连续重合 > 24 阈值

  faux.setResponses([
    fauxAssistantMessage([fauxToolCall("say", { messages: [leaky] })], { stopReason: "toolUse" }),
    fauxAssistantMessage([fauxToolCall("say", { messages: ["刚在听你们聊"] })], { stopReason: "toolUse" }),
    fauxAssistantMessage("好了。"),
  ]);

  const outbox: string[] = [];
  const fish = await openFish({
    storage: new MemoryStorage(),
    models,
    model: { provider: faux.provider.id, modelId: faux.models[0].id },
    promptRoot: PROMPTS,
    workspaceRoot: mediaRoot(),
    mediaRoot: mediaRoot(),
    react: () => {},
    emit: (_id, payload) => {
      outbox.push(...payload.items);
    },
  });

  try {
    const root = await fish.harness.root(ctx, { agent: { model: { provider: faux.provider.id, modelId: faux.models[0].id } } });
    rememberSecrets(root.id, [secret]);

    const submission = await root.submit({ type: "input", content: "说话啊" }, ctx);
    const settled = await submission.wait(ctx);
    assert.equal(settled.status, "done");

    assert.deepEqual(outbox, ["刚在听你们聊"], "抄袭的那条必须被拦下，重说的那条要放行");

    const view = await root.viewState(ctx);
    const results = view.value.entries.filter((e) => e.kind === "pi.tool-result");
    const rejected = results.find((e) => JSON.stringify(e.model ?? "").includes("抄"));
    assert.ok(rejected, "拒绝原因没有以 tool 错误回给模型");
  } finally {
    await fish.close();
  }
});
