/**
 * 两件"重启后还能接上"的事：
 *  1. 群 → conversationId 映射落盘，重开还是同一个会话
 *  2. 出口工具先把消息写进 outbox 再发；崩在"写完了还没发"这一刻，重开后补发且只发一次
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
import { installDrain } from "../src/fish/drain.ts";
import { installGroup } from "../src/fish/group.ts";
import { loadPrompts } from "../src/prompt/index.ts";
import { ChatsDoc, OutboxDoc } from "../src/store.ts";

const ctx = BACKGROUND_CONTEXT;
const PROMPTS = fileURLToPath(new URL("../prompt", import.meta.url));

async function boot(dbPath: string, outbox: string[], failFirst = 0) {
  const faux = fauxProvider();
  const models = createModels();
  models.setProvider(faux.provider);
  let fails = failFirst;
  let emitCalls = 0;
  const fish = openFish({
    storage: await openNodeSqliteStorage(dbPath),
    models,
    model: { provider: faux.provider.id, modelId: faux.models[0].id },
    promptRoot: PROMPTS,
    mediaRoot: mkdtempSync(join(tmpdir(), "yg-m-")),
    workspaceRoot: mkdtempSync(join(tmpdir(), "yg-w-")),
    emit: (_id, payload) => {
      emitCalls += 1;
      if (fails > 0) {
        fails--;
        throw new Error("网络抖了一下");
      }
      outbox.push(payload.items.join("|"));
    },
    react: () => {},
  });
  return { faux, fish, emitCalls: () => emitCalls };
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

  // 第一次：出口工具写进 outbox，但进程"崩"了，没 drain
  const built = await boot(db, outbox);
  const { faux } = built;
  const first = await built.fish;
  const conv = await first.group("qq:group:7");
  faux.setResponses([
    fauxAssistantMessage([fauxToolCall("say_words", { text: "在的" })], { stopReason: "toolUse" }),
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

test("发送失败保留未决：不重试，也不跳过队首发后面的", async () => {
  const outbox: string[] = [];
  const built = await boot(join(mkdtempSync(join(tmpdir(), "yg-db-")), "fish.db"), outbox, 1);
  const { faux } = built;
  const open = await built.fish;
  try {
    const conv = await open.group("qq:group:9");
    faux.setResponses([
      fauxAssistantMessage([fauxToolCall("say_words", { text: "喂" })], { stopReason: "toolUse" }),
      fauxAssistantMessage("好了"),
    ]);
    await (await conv.submit({ type: "input", content: "在吗" }, ctx)).wait(ctx);
    // 队尾再排一条：队首发送失败后，它不许越过未决记录被发出去
    await open.enqueue(conv.id, { items: ["第二条"], at: Date.now(), key: "after:1" });

    const sent = await open.drain();
    assert.equal(sent, 0, "发送失败的那条不算发出去");
    assert.deepEqual(outbox, [], "部分发送状态不确定，宁可少发不重复");
    assert.equal(built.emitCalls(), 1, "失败后不再重试同一条");

    const again = await open.drain();
    assert.equal(again, 0);
    assert.equal(built.emitCalls(), 1, "队首卡在 sending，后续 drain 不再调 emit");

    const box = await open.harness.snapshot(OutboxDoc, conv.id, ctx);
    assert.equal(box?.queue[0]?.status, "sending", "失败记录保留 sending 供诊断");
    assert.equal(box?.queue.length, 2, "后面的记录原地不动");
  } finally {
    await open.close();
  }
});

test("installGroup 首次失败后不永久缓存坏 Promise，下次重试可成功", async () => {
  let attempt = 0;
  const { group } = installGroup({
    harness: {
      async snapshot() {
        attempt += 1;
        if (attempt === 1) throw new Error("transient_db_error");
        return { chats: { "qq:group:retry": 42 } };
      },
      async conversation(id: number) {
        return { id };
      },
    } as never,
    options: { model: { provider: "faux", modelId: "faux-1" } } as never,
    prompts: loadPrompts(PROMPTS),
    ctx,
    now: () => 1,
    groups: new Map(),
    workspaceRoot: mkdtempSync(join(tmpdir(), "yg-grp-")),
    personaExtensions: new Map(),
    memoryKeyByConversation: new Map(),
    chatKeyByConversation: new Map(),
    sending: new Set(),
  } as never);

  await assert.rejects(() => group("qq:group:retry"), /transient_db_error/);
  const conv = await group("qq:group:retry");
  assert.equal(conv.id, 42);
});

test("drain() 对多会话并发派发 emit 并记录 rejected 日志，notSent 错误直接丢弃队首", async () => {
  const db = join(mkdtempSync(join(tmpdir(), "yg-drain-conc-")), "fish.db");
  const faux = fauxProvider();
  const models = createModels();
  models.setProvider(faux.provider);
  let convAId = 0;
  let convBId = 0;
  let bEmitted = false;
  let releaseA!: () => void;
  const aGate = new Promise<void>((resolve) => {
    releaseA = resolve;
  });
  let throwNotSent = false;
  const outbox: string[] = [];

  const open = await openFish({
    storage: await openNodeSqliteStorage(db),
    models,
    model: { provider: faux.provider.id, modelId: faux.models[0].id },
    promptRoot: PROMPTS,
    mediaRoot: mkdtempSync(join(tmpdir(), "yg-m-")),
    workspaceRoot: mkdtempSync(join(tmpdir(), "yg-w-")),
    emit: async (id, payload) => {
      if (throwNotSent) {
        const err = new Error("OneBot 未连接") as Error & { notSent?: boolean };
        err.notSent = true;
        throw err;
      }
      if (id === convAId) {
        await Promise.race([aGate, new Promise((r) => setTimeout(r, 80))]);
      } else if (id === convBId) {
        bEmitted = true;
        releaseA();
      }
      outbox.push(`${String(id)}:${payload.items.join("|")}`);
    },
    react: () => {},
  });

  try {
    const convA = await open.group("qq:group:a");
    const convB = await open.group("qq:group:b");
    convAId = convA.id;
    convBId = convB.id;
    await open.enqueue(convA.id, { items: ["来自A"], at: Date.now(), key: "k-a" });
    await open.enqueue(convB.id, { items: ["来自B"], at: Date.now(), key: "k-b" });

    const sent = await open.drain();
    assert.equal(bEmitted, true, "A 会话慢时阻塞了 B 会话");
    assert.equal(sent, 2);
    assert.equal(outbox.length, 2);

    // notSent: true 时直接丢弃队首，不卡在 sending 600s
    throwNotSent = true;
    await open.enqueue(convA.id, { items: ["断线消息"], at: Date.now(), key: "k-drop" });
    const droppedSent = await open.drain();
    assert.equal(droppedSent, 0);
    const boxAfterDrop = await open.harness.snapshot(OutboxDoc, convA.id, ctx);
    assert.equal(boxAfterDrop?.queue.length ?? 0, 0, "notSent 错误应直接丢弃队首");

    // 恢复连接后能立刻继续发新消息
    throwNotSent = false;
    await open.enqueue(convA.id, { items: ["恢复消息"], at: Date.now(), key: "k-recover" });
    assert.equal(await open.drain(), 1);
  } finally {
    await open.close();
  }

  // 验证 drain 遇到 rejected 会话时记录错误日志且不影响其余会话
  const errors: unknown[][] = [];
  const origError = console.error;
  console.error = (...args: unknown[]) => { errors.push(args); };
  try {
    const { drain } = installDrain({
      harness: {
        async snapshot(doc: unknown, id?: unknown) {
          if (doc === ChatsDoc) return { chats: { a: 1, b: 2 } };
          if (id === 1) throw new Error("boom_conv_1");
          return { queue: [] };
        },
      } as never,
      options: { emit: async () => [] } as never,
      ctx,
      now: () => 1,
      sending: new Set<string>(),
    } as never);
    const total = await drain();
    assert.equal(total, 0);
    assert.ok(errors.some((args) => args.some((a) => String(a).includes("boom_conv_1"))));
  } finally {
    console.error = origError;
  }
});

test("tool-surface 同轮增量记录工具返回到 secrets 并拦截 say_words 抄写", async () => {
  const db = join(mkdtempSync(join(tmpdir(), "yg-turn-secret-")), "fish.db");
  const outbox: string[] = [];
  const built = await boot(db, outbox);
  const { faux } = built;
  const fish = await built.fish;
  try {
    const conv = await fish.group("qq:group:secret");
    faux.setResponses([
      fauxAssistantMessage([fauxToolCall("tool_search", { query: "say_words" })], { stopReason: "toolUse" }),
      fauxAssistantMessage(
        [fauxToolCall("say_words", { text: "你产生的任何文字都不会发出去，只有出口工具能把话送出去。" })],
        { stopReason: "toolUse" },
      ),
      fauxAssistantMessage([fauxToolCall("say_words", { text: "好的知道了" })], { stopReason: "toolUse" }),
      fauxAssistantMessage("ok"),
    ]);
    await (await conv.submit({ type: "input", content: "看看" }, ctx)).wait(ctx);
    await fish.drain();
    assert.deepEqual(outbox, ["好的知道了"], "同轮抄写工具返回值应被 provenance 拦截");
  } finally {
    await fish.close();
  }
});
