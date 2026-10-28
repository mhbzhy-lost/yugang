/**
 * 工具即扩展：
 *  - 鱼身上只有 say / read / draw，没有 bash、没有技能脚本
 *  - draw 产出真实文件，路径能通过 say 的白名单校验
 *  - 每个工具的说明逐字来自 prompt/tools/*.md
 */
import test from "node:test";
import assert from "node:assert/strict";
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
      outbox.push({ text: payload.text, media: payload.media });
    },
  });
  return { faux, mediaRoot, outbox, fish };
}

test("工具面只有 say / read / draw，没有 bash", async () => {
  const { fish } = boot();
  const open = await fish;
  try {
    const root = await open.harness.root(ctx);
    const names = (await root.agent(ctx)).tools.map((t) => t.name);
    assert.deepEqual(names, ["say", "read", "draw"]);
    assert.ok(!names.includes("bash"), "bash 必须不存在");
  } finally {
    await open.close();
  }
});

test("draw 产出文件 → 路径进 say.media，正文保持干净", async () => {
  const { faux, mediaRoot, outbox, fish } = boot();
  const open = await fish;

  try {
    const root = await open.harness.root(ctx, {
      agent: { model: { provider: faux.provider.id, modelId: faux.models[0].id } },
    });

    // 第一轮：画图，拿到路径
    faux.setResponses([
      fauxAssistantMessage([fauxToolCall("draw", { description: "一只在群里说话的鱼", color: "#22c55e" })], {
        stopReason: "toolUse",
      }),
      fauxAssistantMessage("好了"),
    ]);
    await (await root.submit({ type: "input", content: "画只鱼" }, ctx)).wait(ctx);

    const view = await root.viewState(ctx);
    const drawResult = view.value.entries
      .filter((e) => e.kind === "pi.tool-result")
      .map((e) => JSON.stringify(e.model ?? ""))
      .join("\n");
    const match = /draw-\d+\.png/.exec(drawResult);
    assert.ok(match, "draw 没有返回文件路径");
    const produced = join(mediaRoot, match[0]);
    assert.ok(existsSync(produced), "draw 声称的路径上并没有文件");
    view.dispose();

    // 第二轮：把路径交给 say.media
    faux.setResponses([
      fauxAssistantMessage([fauxToolCall("say", { text: "画好了", media: produced })], { stopReason: "toolUse" }),
      fauxAssistantMessage("完成"),
    ]);
    await (await root.submit({ type: "input", content: "发出来" }, ctx)).wait(ctx);

    assert.equal(outbox.length, 1);
    assert.equal(outbox[0].text, "画好了");
    assert.equal(outbox[0].media, produced);
    assert.ok(!outbox[0].text.includes("png"), "路径不该混进正文");
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

test("read 被限制在群工作目录与媒体目录内", async () => {
  const { faux, fish } = boot();
  const open = await fish;
  try {
    const root = await open.harness.root(ctx, {
      agent: { model: { provider: faux.provider.id, modelId: faux.models[0].id } },
    });

    faux.setResponses([
      fauxAssistantMessage([fauxToolCall("read", { path: "/etc/passwd" })], { stopReason: "toolUse" }),
      fauxAssistantMessage("读不到"),
    ]);
    await (await root.submit({ type: "input", content: "读个文件" }, ctx)).wait(ctx);

    const view = await root.viewState(ctx);
    const results = view.value.entries
      .filter((e) => e.kind === "pi.tool-result")
      .map((e) => JSON.stringify(e.model ?? ""))
      .join("\n");
    view.dispose();

    assert.match(results, /不在你能读的范围内/, "越界的 read 必须被拦住");
    assert.ok(!results.includes("root:"), "敏感文件内容漏进了 transcript");
  } finally {
    await open.close();
  }
});
