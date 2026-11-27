/**
 * 轮外发消息（Fish.enqueue）写 fish.outbound transcript 与并发 drain 补冲测试。
 */
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { createModels } from "@earendil-works/pi-ai/models";
import { fauxProvider } from "@earendil-works/pi-ai/providers/faux";
import { MemoryStorage } from "@earendil-works/pi-durable";
import { openFish, SentmapDoc } from "../src/harness.ts";
import type { OutboundPayload } from "../src/tools/say-shared.ts";

const ROOT = fileURLToPath(new URL("..", import.meta.url));
const PROMPTS = join(ROOT, "prompt");
const ctx = BACKGROUND_CONTEXT;

function createTempDir(prefix: string): string {
  return mkdtempSync(join(tmpdir(), prefix));
}

function makeModels() {
  const models = createModels();
  models.setProvider(fauxProvider().provider);
  return models;
}

test("fish.enqueue：默认不写 transcript，recordTranscript=true 同事务写 fish.outbound 且 drain 后关联 sentmap", async (t) => {
  const mediaRoot = createTempDir("yg-enq-m-");
  const workspaceRoot = createTempDir("yg-enq-w-");
  t.after(() => {
    rmSync(mediaRoot, { recursive: true, force: true });
    rmSync(workspaceRoot, { recursive: true, force: true });
  });

  const emitted: OutboundPayload[] = [];
  let msgSeq = 9000;
  const fish = await openFish({
    storage: new MemoryStorage(),
    models: makeModels(),
    model: { provider: "faux", modelId: "faux-1" },
    promptRoot: PROMPTS,
    mediaRoot,
    workspaceRoot,
    emit: (_convId, payload) => {
      emitted.push(payload);
      return [++msgSeq];
    },
    react: () => {},
  });
  t.after(async () => {
    await fish.close();
  });

  const conv = await fish.group("qq:group:1001");
  const mechanical: OutboundPayload = {
    items: ["机械提示"],
    quote: false,
    at: Date.now(),
    key: "mech:1",
  };
  await fish.enqueue(conv.id, mechanical);

  const imagePayload: OutboundPayload = {
    items: [],
    media: "gen/test-async.png",
    quote: false,
    quoteId: 5001,
    quoteForce: true,
    at: Date.now(),
    key: `${String(conv.id)}:draw_remote:r1:test-async.png`,
  };
  await fish.enqueue(conv.id, imagePayload, { recordTranscript: true });

  const view = await conv.context(ctx);
  const outbounds = view.entries.filter((entry) => entry.kind === "fish.outbound");
  assert.equal(outbounds.length, 1, "仅 recordTranscript=true 的那条写入 fish.outbound");
  assert.deepEqual(outbounds[0]?.data, imagePayload);

  const sent = await fish.drain();
  assert.equal(sent, 2);
  assert.equal(emitted.length, 2);
  assert.equal(emitted[1]?.media, "gen/test-async.png");
  assert.equal(emitted[1]?.quoteId, 5001);
  assert.equal(emitted[1]?.quoteForce, true);

  // sentmap 只记录关联到 fish.outbound entryId 的第二条消息（msgId=9002）
  const sentmap = await fish.harness.snapshot(SentmapDoc, ctx);
  assert.equal(sentmap?.map["9001"], undefined, "无 transcript 的机械提示不进 sentmap");
  assert.equal(sentmap?.map["9002"]?.entryId, outbounds[0]?.id as number);
  assert.equal(sentmap?.map["9002"]?.conversationId, String(conv.id));
});

test("fish.drain：会话正在发送期间有新消息入队并触发 drain，当前发送结束后自动补冲不滞留", async (t) => {
  const mediaRoot = createTempDir("yg-drain-m-");
  const workspaceRoot = createTempDir("yg-drain-w-");
  t.after(() => {
    rmSync(mediaRoot, { recursive: true, force: true });
    rmSync(workspaceRoot, { recursive: true, force: true });
  });

  const emitted: string[] = [];
  let releaseFirst!: () => void;
  let notifyFirstEntered!: () => void;
  const waitFirstEntered = new Promise<void>((resolve) => {
    notifyFirstEntered = resolve;
  });
  const waitFirstRelease = new Promise<void>((resolve) => {
    releaseFirst = resolve;
  });

  const fish = await openFish({
    storage: new MemoryStorage(),
    models: makeModels(),
    model: { provider: "faux", modelId: "faux-1" },
    promptRoot: PROMPTS,
    mediaRoot,
    workspaceRoot,
    emit: async (_convId, payload) => {
      emitted.push(payload.key);
      if (payload.key === "k1") {
        notifyFirstEntered();
        await waitFirstRelease;
      }
      return [emitted.length];
    },
    react: () => {},
  });
  t.after(async () => {
    await fish.close();
  });

  const conv = await fish.group("qq:group:2002");
  await fish.enqueue(conv.id, { items: ["第一条"], quote: false, at: Date.now(), key: "k1" });

  // 第一趟 drain 开始发 k1 并卡在 emit 内
  const firstDrain = fish.drain();
  await waitFirstEntered;

  // 在 k1 仍发送途中，后台入队 k2 并并发调 drain（此时 sending 集合已含 conv.id）
  await fish.enqueue(conv.id, { items: [], media: "gen/k2.png", quote: false, at: Date.now(), key: "k2" }, { recordTranscript: true });
  const concurrentDrain = await fish.drain([conv.id]);
  assert.equal(concurrentDrain, 0, "并发 drain 不重入同一会话，而是登记补冲");

  // 放行 k1：第一趟 drain 结束后应自动把 k2 也冲出去
  releaseFirst();
  const total = await firstDrain;
  assert.equal(total, 2, "第一趟 drain 应顺带补冲并发期间新入队的 k2");
  assert.deepEqual(emitted, ["k1", "k2"]);
});
