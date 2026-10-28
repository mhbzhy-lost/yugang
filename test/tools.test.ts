/**
 * 工具即扩展：
 *  - 鱼身上只有 say / react / look，没有 bash、没有 read、没有技能脚本
 *  - 每个工具的说明逐字来自 prompt/tools/*.md
 */
import test from "node:test";
import assert from "node:assert/strict";
import { resetRun } from "../src/egress/ledger.ts";
import { mkdtempSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { createModels } from "@earendil-works/pi-ai/models";
import { fauxAssistantMessage, fauxProvider, fauxToolCall } from "@earendil-works/pi-ai/providers/faux";
import { MemoryStorage } from "@earendil-works/pi-durable";
import { openFish } from "../src/harness.ts";

const ctx = BACKGROUND_CONTEXT;
const PROMPTS = fileURLToPath(new URL("../prompt", import.meta.url));

function boot() {
  const faux = fauxProvider();
  const models = createModels();
  models.setProvider(faux.provider);
  const mediaRoot = mkdtempSync(join(tmpdir(), "yg-media-"));
  const workspaceRoot = mkdtempSync(join(tmpdir(), "yg-ws-"));
  const outbox: { text: string; media?: string }[] = [];

  const fish = openFish({
    storage: new MemoryStorage(),
    models,
    model: { provider: faux.provider.id, modelId: faux.models[0].id },
    promptRoot: PROMPTS,
    mediaRoot,
    workspaceRoot,
    emit: (_id, payload) => {
      outbox.push({ text: payload.items.join("|"), media: payload.media });
    },
  });
  return { faux, mediaRoot, outbox, fish };
}

test("工具面只有 say / react / look，没有 bash", async () => {
  const { fish } = boot();
  const open = await fish;
  try {
    const root = await open.harness.root(ctx);
    const names = (await root.agent(ctx)).tools.map((t) => t.name);
    assert.deepEqual(names, ["say", "react", "look", "search", "video"]);
    assert.ok(!names.includes("bash"), "bash 必须不存在");
    assert.ok(!names.includes("read"), "read 也必须不存在");
  } finally {
    await open.close();
  }
});

test("say 每轮硬上限 1 次：同轮第二次报 tool 错，下一轮恢复", async () => {
  const { faux, outbox, fish } = boot();
  const open = await fish;
  try {
    const root = await open.harness.root(ctx, {
      agent: { model: { provider: faux.provider.id, modelId: faux.models[0].id } },
    });

    // 同一轮 say 两次：第一次放行，第二次以 tool 错误拒绝，不 emit
    faux.setResponses([
      fauxAssistantMessage([fauxToolCall("say", { messages: ["头一句"] })], { stopReason: "toolUse" }),
      fauxAssistantMessage([fauxToolCall("say", { messages: ["再来一句"] })], { stopReason: "toolUse" }),
      fauxAssistantMessage("说完了"),
    ]);
    const settled = await (await root.submit({ type: "input", content: "说两句" }, ctx)).wait(ctx);
    assert.equal(settled.status, "done");
    await open.drain([root.id]);
    assert.deepEqual(outbox.map((o) => o.text), ["头一句"], "一轮内只有第一次 say 落进 outbox");

    const view = await root.viewState(ctx);
    const results = view.value.entries.filter((e) => e.kind === "pi.tool-result");
    assert.ok(
      results.some((e) => JSON.stringify(e.model ?? "").includes("已经说过") ||
        JSON.stringify(e.model ?? "").includes("够了")),
      "第二次 say 的拒绝没有以 tool 错误回给模型（quota_run 或 say_once 任一文案）",
    );
    view.dispose();

    // 下一轮（新的一轮）恢复：上限按轮计，不株连。
    // 生产行为对齐：index.ts 在每条消息前 resetRun，这里同样重置轮内记账
    resetRun(root.id);
    faux.setResponses([
      fauxAssistantMessage([fauxToolCall("say", { messages: ["新一轮"] })], { stopReason: "toolUse" }),
      fauxAssistantMessage("嗯"),
    ]);
    await (await root.submit({ type: "input", content: "再说" }, ctx)).wait(ctx);
    await open.drain([root.id]);
    assert.deepEqual(outbox.map((o) => o.text), ["头一句", "新一轮"]);
  } finally {
    await open.close();
  }
});

test("工具说明逐字来自 prompt/tools/<name>.md，缺文件就报错", async () => {
  const { fish } = boot();
  const open = await fish;
  try {
    const root = await open.harness.root(ctx);
    const tools = (await root.agent(ctx)).tools;
    for (const tool of tools) {
      const prompt = open.prompts.tools[tool.name];
      assert.ok(prompt, `prompt/tools/${tool.name}.md 不存在`);
      assert.equal(tool.description, prompt.description, `${tool.name} 的说明不是文件原文`);
    }
  } finally {
    await open.close();
  }
});
