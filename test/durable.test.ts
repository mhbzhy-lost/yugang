/**
 * 两件"重启后还能接上"的事：
 *  1. 群 → conversationId 映射落盘，重开还是同一个会话
 *  2. say 先把消息写进 outbox 再发；崩在"写完了还没发"这一刻，重开后补发且只发一次
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
import { openNodeSqliteStorage } from "@earendil-works/pi-durable/storage/sqlite/node";
import { openFish } from "../src/harness.ts";

const ctx = BACKGROUND_CONTEXT;
const PROMPTS = fileURLToPath(new URL("../prompt", import.meta.url));

async function boot(dbPath: string, outbox: string[], failFirst = 0) {
  const faux = fauxProvider();
  const models = createModels();
  models.setProvider(faux.provider);
  let fails = failFirst;
  const fish = openFish({
    storage: await openNodeSqliteStorage(dbPath),
    models,
    model: { provider: faux.provider.id, modelId: faux.models[0].id },
    promptRoot: PROMPTS,
    mediaRoot: mkdtempSync(join(tmpdir(), "yg-m-")),
    workspaceRoot: mkdtempSync(join(tmpdir(), "yg-w-")),
    emit: (_id, payload) => {
      if (fails > 0) {
        fails--;
        throw new Error("网络抖了一下");
      }
      outbox.push(payload.items.join("|"));
    },
    react: () => {},
  });
  return { faux, fish };
}

test("群映射落盘：重开还是同一个会话", async () => {
  const db = join(mkdtempSync(join(tmpdir(), "yg-db-")), "fish.db");

  const first = await (await boot(db, [])).fish;
  const conv = await first.group("qq:group:42");
  const id = conv.id;
  await first.close();

  const second = await (await boot(db, [])).fish;
  try {
    const again = await second.group("qq:group:42");
    assert.equal(again.id, id, "重开之后会话变了，记忆接不上");
  } finally {
    await second.close();
  }
});

test("崩在发送前：重开后补发，且只补一次", async () => {
  const db = join(mkdtempSync(join(tmpdir(), "yg-db-")), "fish.db");
  const outbox: string[] = [];

  // 第一次：say 写进 outbox，但进程"崩"了，没 drain
  const built = await boot(db, outbox);
  const { faux } = built;
  const first = await built.fish;
  const conv = await first.group("qq:group:7");
  faux.setResponses([
    fauxAssistantMessage([fauxToolCall("say", { messages: ["在的"] })], { stopReason: "toolUse" }),
    fauxAssistantMessage("好了"),
  ]);
  await (await conv.submit({ type: "input", content: "在吗" }, ctx)).wait(ctx);
  assert.deepEqual(outbox, [], "还没 drain 就发出去了");
  await first.close();

  // 第二次：同一个 storage，drain 补发
  const second = await (await boot(db, outbox)).fish;
  try {
    const sent = await second.drain();
    assert.equal(sent, 1);
    assert.deepEqual(outbox, ["在的"]);

    const again = await second.drain();
    assert.equal(again, 0, "补发重复了");
    assert.deepEqual(outbox, ["在的"]);
  } finally {
    await second.close();
  }
});

test("发送失败会重试，不丢消息", async () => {
  const outbox: string[] = [];
  const built = await boot(join(mkdtempSync(join(tmpdir(), "yg-db-")), "fish.db"), outbox, 1);
  const { faux } = built;
  const open = await built.fish;
  try {
    const conv = await open.group("qq:group:9");
    faux.setResponses([
      fauxAssistantMessage([fauxToolCall("say", { messages: ["喂"] })], { stopReason: "toolUse" }),
      fauxAssistantMessage("好了"),
    ]);
    await (await conv.submit({ type: "input", content: "在吗" }, ctx)).wait(ctx);

    const sent = await open.drain();
    assert.equal(sent, 1);
    assert.deepEqual(outbox, ["喂"], "第一次失败后应该重试成功");
  } finally {
    await open.close();
  }
});
