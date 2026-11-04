/**
 * onebot 水合 → debounce quoteFromReply 集成测试。
 *
 * 锁一个真上过线的 bug：#onFrame 水合回复后曾把 parsed.replyIds 清空，debounce 的
 * quoteFromReply（整组里任意一条是回复 → 这一轮仍然引用，AGENTS.md 第 7 节）
 * 从 a99a628 上线起就永远是 false，真回复轮（锚点是 QQ 回复、无 @、模型也没主动
 * quote）一直裸发。
 * 2026-11-04 decisions §3/§5.9 后引用原文不再拼进正文：水合产出结构化 quoted
 *（附加段由装配方后置渲染），正文只留当前消息本身；replyIds 保留语义不变。
 * 入站行渲染与 forwardIds / gate 行为不在本测试改动面内。
 */
import test from "node:test";
import assert from "node:assert/strict";
import { OneBot, type IncomingMessage, type OneBotEvent } from "../src/qq/onebot.ts";
import { createDebouncer, type PendingBurst } from "../src/qq/debounce.ts";

/** 假 WebSocket：connect() 立刻打开，send 的 API 调用当场回一个纯文本被引消息（李四：「原文」）。 */
class FakeSocket {
  static last: FakeSocket | undefined;
  readyState = 1;
  #listeners = new Map<string, ((event: { data?: unknown }) => void)[]>();

  constructor(_url: string) {
    FakeSocket.last = this;
    queueMicrotask(() => this.#fire("open", {}));
  }

  addEventListener(type: string, listener: (event: { data?: unknown }) => void): void {
    const list = this.#listeners.get(type) ?? [];
    list.push(listener);
    this.#listeners.set(type, list);
  }

  /** 测试用它把 QQ 消息帧喂进 OneBot。 */
  receive(frame: OneBotEvent): void {
    this.#fire("message", { data: JSON.stringify(frame) });
  }

  send(raw: string): void {
    const request = JSON.parse(raw) as { echo: string };
    const reply = {
      echo: request.echo,
      retcode: 0,
      data: {
        message: [{ type: "text", data: { text: "原文" } }],
        sender: { nickname: "李四" },
      },
    };
    queueMicrotask(() => this.#fire("message", { data: JSON.stringify(reply) }));
  }

  #fire(type: string, event: { data?: unknown }): void {
    for (const listener of this.#listeners.get(type) ?? []) listener(event);
  }
}

/** 建一条真 OneBot（走假 WebSocket），消息交给 handler；connect 后立刻还原全局 WebSocket。 */
async function boot(handler: (msg: IncomingMessage) => void): Promise<FakeSocket> {
  const original = globalThis.WebSocket;
  globalThis.WebSocket = FakeSocket as unknown as typeof WebSocket;
  try {
    const bot = new OneBot("ws://fake");
    await bot.connect();
    bot.onMessage(handler);
    return FakeSocket.last!;
  } finally {
    globalThis.WebSocket = original;
  }
}

/** 等异步水合（get_msg 往返）落定。 */
async function settle(): Promise<void> {
  for (let i = 0; i < 20; i += 1) await new Promise((resolve) => setImmediate(resolve));
}

function groupFrame(message: OneBotEvent["message"], messageId: number): OneBotEvent {
  return {
    post_type: "message",
    message_type: "group",
    self_id: 1000,
    group_id: 42,
    user_id: 2000,
    message_id: messageId,
    sender: { nickname: "张三" },
    message,
  };
}

/** 可手动触发的假时钟 debounce，风格同 debounce.test.ts。 */
function setup() {
  const flushed: PendingBurst[] = [];
  const timers = new Map<number, () => void>();
  let next = 0;
  const debouncer = createDebouncer({
    now: () => 1_000,
    setTimer: (flush) => {
      next += 1;
      timers.set(next, flush);
      return next as unknown as ReturnType<typeof setTimeout>;
    },
    clearTimer: (timer) => timers.delete(timer as unknown as number),
    onFlush: (burst) => flushed.push(burst),
  });
  return {
    debouncer,
    flushed,
    fireAll() {
      const live = [...timers.values()];
      timers.clear();
      for (const flush of live) flush();
    },
  };
}

test("真回复轮（无 @）：onebot 水合保留 replyIds，debounce quoteFromReply 为真", async () => {
  const { debouncer, flushed, fireAll } = setup();
  const socket = await boot((msg) => debouncer.push({ msg, text: msg.text }));

  // 张三回复了李四的「原文」，没 @ 鱼
  socket.receive(
    groupFrame(
      [
        { type: "reply", data: { id: "666" } },
        { type: "text", data: { text: "这句怎么讲" } },
      ],
      7,
    ),
  );
  await settle();
  fireAll();

  assert.equal(flushed.length, 1, "静默期满，整组要提交");
  const burst = flushed[0]!;
  assert.equal(burst.mustAnswer, false, "回复普通消息不是回复合集，也没 @，不该必答");
  assert.equal(burst.quoteFromReply, true, "整组里任意一条是回复 → 这一轮仍然引用；水合后清空 replyIds 曾让它永远为假");
  assert.deepEqual(burst.messages[0].replyIds, ["666"], "水合后 replyIds 必须保留");
  // 引用原文不再拼进正文（decisions §3）：正文只有当前消息，被引内容水合成结构化 quoted
  assert.equal(burst.messages[0].text, "这句怎么讲");
  assert.deepEqual(burst.messages[0].quoted, { id: "666", nickname: "李四", userId: "", text: "原文", images: [] });
});

test("整组语义：组里普通消息 + 回复消息，quoteFromReply 同样为真", async () => {
  const { debouncer, flushed, fireAll } = setup();
  const socket = await boot((msg) => debouncer.push({ msg, text: msg.text }));

  // 同一发送者：先一句普通的话，再补一条回复（引用锚点语义由 debounce 单测锁，这里只看整组）
  socket.receive(groupFrame([{ type: "text", data: { text: "先说一句" } }], 8));
  await settle();
  socket.receive(
    groupFrame(
      [
        { type: "reply", data: { id: "667" } },
        { type: "text", data: { text: "还有这个" } },
      ],
      9,
    ),
  );
  await settle();
  fireAll();

  assert.equal(flushed.length, 1, "同一发送者的两句要在同一组一起提交");
  const burst = flushed[0]!;
  assert.deepEqual(burst.messages.map((m) => m.text), ["先说一句", "还有这个"], "引用原文不再拼进正文，两句都只留当前消息本身");
  assert.equal(burst.messages[1].quoted?.text, "原文", "回复那条水合出结构化 quoted");
  assert.equal(burst.quoteFromReply, true, "整组里任意一条是回复就够，不必锚点本身是回复");
});

test("同链路普通消息（无回复段）：quoteFromReply 保持 false，不误挂引用", async () => {
  const { debouncer, flushed, fireAll } = setup();
  const socket = await boot((msg) => debouncer.push({ msg, text: msg.text }));

  socket.receive(groupFrame([{ type: "text", data: { text: "随便聊聊" } }], 10));
  await settle();
  fireAll();

  const burst = flushed[0]!;
  assert.equal(burst.quoteFromReply, false);
  assert.deepEqual(burst.messages[0].replyIds, []);
});
