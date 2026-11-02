/**
 * 工具即扩展：
 *  - 初始工具面只有 say_* 四出口 / react / tool_search，其余已启用工具全部 deferred（tool_search 加载）
 *  - 每个工具的说明逐字来自 src/tools/<name>/TOOL.md
 */
import test from "node:test";
import assert from "node:assert/strict";
import { resetRun } from "../src/egress/ledger.ts";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { createModels } from "@earendil-works/pi-ai/models";
import { fauxAssistantMessage, fauxProvider, fauxToolCall } from "@earendil-works/pi-ai/providers/faux";
import { MemoryStorage } from "@earendil-works/pi-durable";
import { openFish } from "../src/harness.ts";
import { loadToolManifests, toolFullDescription } from "../src/tools/manifest.ts";

const ctx = BACKGROUND_CONTEXT;
const PROMPTS = fileURLToPath(new URL("../prompt", import.meta.url));
const TOOL_ROOT = fileURLToPath(new URL("../src/tools/", import.meta.url));
const PNG = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.alloc(64, 7)]);

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
    react: () => {},
    master: "1",
  });
  return { faux, mediaRoot, outbox, fish };
}

test("工具面为窄接口：无 bash，自改工具已注册", async () => {
  const { fish } = boot();
  const open = await fish;
  try {
    const root = await open.harness.root(ctx);
    const agent = await root.agent(ctx);
    const names = agent.tools.map((t) => t.name);
    // 初始工具面：四个出口 say_*、轻回应 react 和按需加载的检索入口 tool_search
    assert.deepEqual(names, ["react", "say_media", "say_meme", "say_voice", "say_words", "tool_search"]);
    assert.ok(!names.includes("bash"), "bash 必须不存在");
    assert.ok(!names.includes("shell"), "shell 必须不存在");
    // 其余已启用工具（含 meme_import）全部等在 deferred 里，等 tool_search 加载
    assert.deepEqual(
      agent.deferred.map((t) => t.name),
      ["config", "draw", "gpt_image", "grep", "look", "meme", "meme_add", "meme_import", "read", "restart", "search", "tags", "tree", "video", "watch", "write"],
    );
  } finally {
    await open.close();
  }
});

test("say_* 每轮硬上限 3 次调用：四工具任意组合第 4 次拒，下一轮恢复", async () => {
  const { faux, mediaRoot, outbox, fish } = boot();
  const open = await fish;
  try {
    const root = await open.harness.root(ctx, {
      agent: { model: { provider: faux.provider.id, modelId: faux.models[0].id } },
    });
    mkdirSync(join(mediaRoot, "gen"), { recursive: true });
    writeFileSync(join(mediaRoot, "gen", "a.png"), PNG);

    // 同一轮四个出口工具混合调用三次（words+media+words），第四次以 tool 错误拒绝，不 emit
    faux.setResponses([
      fauxAssistantMessage([fauxToolCall("say_words", { text: "头一句" })], { stopReason: "toolUse" }),
      fauxAssistantMessage([fauxToolCall("say_media", { media: "gen/a.png" })], { stopReason: "toolUse" }),
      fauxAssistantMessage([fauxToolCall("say_words", { text: "第三句" })], { stopReason: "toolUse" }),
      fauxAssistantMessage([fauxToolCall("say_words", { text: "第四句" })], { stopReason: "toolUse" }),
      fauxAssistantMessage("说完了"),
    ]);
    const settled = await (await root.submit({ type: "input", content: "说两句" }, ctx)).wait(ctx);
    assert.equal(settled.status, "done");
    await open.drain([root.id]);
    assert.deepEqual(outbox.map((o) => o.text), ["头一句", "", "第三句"], "一轮内前三次开口落进 outbox（纯图那条无字）");
    assert.equal(outbox[1]?.media, "gen/a.png", "say_media 那次应带图");

    const view = await root.viewState(ctx);
    const results = view.value.entries.filter((e) => e.kind === "pi.tool-result");
    assert.ok(
      results.some((e) => JSON.stringify(e.model ?? "").includes("开口 3 次") ||
        JSON.stringify(e.model ?? "").includes("就此打住")),
      "第 4 次调用的拒绝没有以 tool 错误回给模型（say_once 文案）",
    );
    view.dispose();

    // 下一轮（新的一轮）恢复：上限按轮计，不株连。
    // 生产行为对齐：index.ts 在每条消息前 resetRun，这里同样重置轮内记账
    resetRun(root.id);
    faux.setResponses([
      fauxAssistantMessage([fauxToolCall("say_words", { text: "新一轮" })], { stopReason: "toolUse" }),
      fauxAssistantMessage("嗯"),
    ]);
    await (await root.submit({ type: "input", content: "再说" }, ctx)).wait(ctx);
    await open.drain([root.id]);
    assert.deepEqual(outbox.map((o) => o.text), ["头一句", "", "第三句", "新一轮"]);
  } finally {
    await open.close();
  }
});

test("工具说明逐字来自 src/tools/<name>/TOOL.md，缺文件就报错", async () => {
  const { fish } = boot();
  const open = await fish;
  try {
    const root = await open.harness.root(ctx);
    const agent = await root.agent(ctx);
    const manifests = loadToolManifests(TOOL_ROOT, { memeTags: open.prompts.memeTags });
    for (const tool of [...agent.tools, ...agent.deferred]) {
      const manifest = manifests.get(tool.name);
      assert.ok(manifest, `src/tools/${tool.name}/TOOL.md 不存在`);
      assert.equal(tool.description, toolFullDescription(manifest), `${tool.name} 的说明不是文件原文`);
    }
  } finally {
    await open.close();
  }
});
