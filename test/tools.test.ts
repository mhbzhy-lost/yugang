/**
 * 工具即扩展：
 *  - 鱼身上只有 say / react / look，没有 bash、没有 read、没有技能脚本
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
    assert.deepEqual(names, ["say", "react", "look"]);
    assert.ok(!names.includes("bash"), "bash 必须不存在");
    assert.ok(!names.includes("read"), "read 也必须不存在");
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
