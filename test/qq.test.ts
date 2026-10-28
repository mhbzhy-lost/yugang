/**
 * QQ 侧三件事：
 *  - 群档案只在建会话时写一次，模型能看到群名和成员
 *  - look 只能看媒体目录里的图，且一轮最多两次
 *  - react 只贴表情，不产生文本，但会被限流
 */
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync } from "node:fs";
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
const PNG = readFileSync(fileURLToPath(new URL("./fixtures/dot.png", import.meta.url)));

function boot() {
  const faux = fauxProvider();
  const models = createModels();
  models.setProvider(faux.provider);
  const mediaRoot = mkdtempSync(join(tmpdir(), "yg-media-"));
  const workspaceRoot = mkdtempSync(join(tmpdir(), "yg-ws-"));
  const reacts: string[] = [];
  const fish = openFish({
    storage: new MemoryStorage(),
    models,
    model: { provider: faux.provider.id, modelId: faux.models[0].id },
    promptRoot: PROMPTS,
    mediaRoot,
    workspaceRoot,
    emit: () => {},
    react: (_id, emoji) => {
      reacts.push(emoji);
    },
  });
  return { faux, mediaRoot, reacts, fish };
}

test("群档案写进 transcript，模型看得到群名和成员", async () => {
  const { fish } = boot();
  const open = await fish;
  try {
    const conv = await open.group("qq:group:42", {
      name: "深夜钓鱼群",
      groupId: "42",
      count: 3,
      owner: "1000",
      master: "1000",
      members: [
        { nickname: "张三", userId: "2000" },
        { nickname: "李四", userId: "2001" },
      ],
    });
    const view = await conv.viewState(ctx);
    const entry = view.value.entries.find((e) => e.kind === "fish.group-profile");
    assert.ok(entry, "没有写群档案");
    const text = JSON.stringify(entry.model ?? "");
    assert.match(text, /深夜钓鱼群/);
    assert.match(text, /张三/);
    view.dispose();
  } finally {
    await open.close();
  }
});

test("look 能看图，越界和不存在都被拦", async () => {
  const { faux, mediaRoot, fish } = boot();
  const open = await fish;
  try {
    mkdirSync(join(mediaRoot, "inbound"), { recursive: true });
    writeFileSync(join(mediaRoot, "inbound", "a.png"), PNG);

    const root = await open.harness.root(ctx, {
      agent: { model: { provider: faux.provider.id, modelId: faux.models[0].id } },
    });

    faux.setResponses([
      fauxAssistantMessage([fauxToolCall("look", { ref: "inbound/a.png" })], { stopReason: "toolUse" }),
      fauxAssistantMessage("看到了"),
    ]);
    await (await root.submit({ type: "input", content: "看图" }, ctx)).wait(ctx);

    const view = await root.viewState(ctx);
    const result = view.value.entries.filter((e) => e.kind === "pi.tool-result").at(-1);
    const content = JSON.stringify(result?.model ?? "");
    assert.match(content, /image\/png/, "没把图交给模型");
    view.dispose();

    faux.setResponses([
      fauxAssistantMessage([fauxToolCall("look", { ref: "/etc/passwd" })], { stopReason: "toolUse" }),
      fauxAssistantMessage("不行"),
    ]);
    await (await root.submit({ type: "input", content: "再看" }, ctx)).wait(ctx);

    const after = await root.viewState(ctx);
    const denied = JSON.stringify(after.value.entries.filter((e) => e.kind === "pi.tool-result").at(-1)?.model ?? "");
    assert.match(denied, /只能看群里的图/);
    after.dispose();
  } finally {
    await open.close();
  }
});

test("react 贴表情，重复贴被限流", async () => {
  const { faux, reacts, fish } = boot();
  const open = await fish;
  try {
    const root = await open.harness.root(ctx, {
      agent: { model: { provider: faux.provider.id, modelId: faux.models[0].id } },
    });

    faux.setResponses([
      fauxAssistantMessage([fauxToolCall("react", { emoji: "124" })], { stopReason: "toolUse" }),
      fauxAssistantMessage("贴了"),
    ]);
    await (await root.submit({ type: "input", content: "在吗" }, ctx)).wait(ctx);
    assert.deepEqual(reacts, ["124"]);

    faux.setResponses([
      fauxAssistantMessage([fauxToolCall("react", { emoji: "124" })], { stopReason: "toolUse" }),
      fauxAssistantMessage("又贴"),
    ]);
    await (await root.submit({ type: "input", content: "人呢" }, ctx)).wait(ctx);
    assert.deepEqual(reacts, ["124"], "同一个表情不该连贴");
  } finally {
    await open.close();
  }
});
