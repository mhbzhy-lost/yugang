/**
 * 5 秒静默合并的状态机与背景栏。
 *
 * 这里锁的是几个真出过事的点：
 *  - 整组按「收到顺序」（arrivalSeq）排，锚点取最后收到的那条，不是最后处理完的那条
 *  - recent 只有 30 条，锚点可能已经被挤掉；背景只能取锚点之前的，不能把后来的话当背景
 *  - 有 id / 序号时不能拿「同人同话」去删背景（同一个人说两次同一句是两件事）
 *  - bypass 段可能落在整组中间，flush 时要取最近一条非空的
 *  - 会话 / 人格在首次 push 时绑住，5 秒内切人格不能把待定组送进新人格
 */
import test from "node:test";
import assert from "node:assert/strict";
import {
  createDebouncer,
  backgroundFor,
  lastPayload,
  type BurstMessage,
  type PendingBurst,
} from "../src/qq/debounce.ts";
import type { IncomingMessage } from "../src/qq/onebot.ts";

const CHAT = "qq:group:42";

function msg(overrides: Partial<IncomingMessage> & { userId: number; text: string }): IncomingMessage {
  return {
    chatKey: CHAT,
    nickname: "某人",
    mentionsBot: false,
    images: [],
    imageSegments: [],
    replyIds: [],
    ...overrides,
  };
}

/** 可手动触发的假时钟：push 会 clear 旧定时器，fireAll 只跑还活着的那批。 */
function fakeClock() {
  let next = 0;
  const timers = new Map<number, () => void>();
  return {
    setTimer(flush: () => void) {
      next += 1;
      timers.set(next, flush);
      return next as unknown as ReturnType<typeof setTimeout>;
    },
    clearTimer(timer: ReturnType<typeof setTimeout>) {
      timers.delete(timer as unknown as number);
    },
    fireAll() {
      const live = [...timers.values()];
      timers.clear();
      for (const flush of live) flush();
    },
    pendingCount() {
      return timers.size;
    },
  };
}

function setup() {
  const clock = fakeClock();
  const flushed: PendingBurst[] = [];
  const debouncer = createDebouncer({
    now: () => 1_000,
    setTimer: clock.setTimer,
    clearTimer: clock.clearTimer,
    onFlush: (burst) => {
      flushed.push(burst);
    },
  });
  return { clock, flushed, debouncer };
}

test("整组按 arrivalSeq 排，锚点取最后收到的那条（不是最后处理完的）", () => {
  const { clock, flushed, debouncer } = setup();
  // 入站补充是异步的：后收到的（seq 2）先处理完，先进来；先收到的（seq 1）后完成
  const second = msg({ userId: 7, text: "第二句", messageId: 2, arrivalSeq: 2 });
  const first = msg({ userId: 7, text: "第一句", messageId: 1, arrivalSeq: 1 });

  debouncer.push({ msg: second, text: "第二句" });
  const burst = debouncer.push({ msg: first, text: "第一句" });

  assert.deepEqual(burst.messages.map((m) => m.text), ["第一句", "第二句"], "整组没有按收到顺序排");
  assert.equal(burst.anchor.messageId, 2, "锚点必须是收到顺序最后一条，不是最后处理完的那条");

  clock.fireAll();
  assert.equal(flushed.length, 1);
  assert.equal(flushed[0].anchor.messageId, 2);
});

test("不同发送者的窗口互不干扰，A-B-A 里 B 只在背景", () => {
  const { debouncer } = setup();
  const a1 = msg({ userId: 7, nickname: "A", text: "我想说", messageId: 1, arrivalSeq: 1 });
  const b1 = msg({ userId: 8, nickname: "B", text: "插一句", messageId: 2, arrivalSeq: 2 });
  const a2 = msg({ userId: 7, nickname: "A", text: "两件事", messageId: 3, arrivalSeq: 3 });

  debouncer.push({ msg: a1, text: a1.text });
  debouncer.push({ msg: b1, text: b1.text });
  const burstA = debouncer.push({ msg: a2, text: a2.text });

  assert.equal(burstA.messages.length, 2, "同一发送者的两句应该在同一组");
  assert.equal(burstA.anchor.messageId, 3);
  assert.equal(debouncer.pending(CHAT, 8)?.messages.length, 1, "B 的窗口被 A 的 push 动了");

  const bucket = [a1, b1, a2].map((m) => ({
    arrivalSeq: m.arrivalSeq,
    messageId: m.messageId,
    userId: m.userId,
    nickname: m.nickname,
    text: m.text,
    at: 0,
  }));
  const background = backgroundFor(a2, bucket, burstA.messages);
  assert.deepEqual(background.map((line) => line.text), ["插一句"], "A 自己的第一句不该重复出现在背景里");
});

test("锚点被 30 条 recent 挤掉时，背景不能取到锚点之后的消息", () => {
  // 群里刷屏：流水里只剩最近 30 条（11..40），锚点 seq=5 已经不在里面
  const bucket = Array.from({ length: 30 }, (_, index) => ({
    arrivalSeq: 11 + index,
    userId: 100 + index,
    nickname: `u${100 + index}`,
    text: `后来的第 ${11 + index} 条`,
    at: 0,
  }));
  const anchor = msg({ userId: 7, text: "锚点", messageId: 5, arrivalSeq: 5 });
  assert.deepEqual(backgroundFor(anchor, bucket, []), [], "锚点之前没有消息，后来的 30 条一条都不该当背景");
});

test("背景只取锚点之前，且整组自己不出现在背景里", () => {
  const bucket = Array.from({ length: 30 }, (_, index) => ({
    arrivalSeq: index + 1,
    userId: 100 + index,
    nickname: `u${100 + index}`,
    text: `t${index + 1}`,
    at: 0,
  }));
  const anchor = msg({ userId: 7, text: "锚点", messageId: 20, arrivalSeq: 20 });
  const burst: BurstMessage[] = [
    { userId: 7, nickname: "某人", text: "前一句", at: 0, mentionsBot: false, replyIds: [], messageId: 19, arrivalSeq: 19 },
    { userId: 7, nickname: "某人", text: "锚点", at: 0, mentionsBot: false, replyIds: [], messageId: 20, arrivalSeq: 20 },
  ];
  const background = backgroundFor(anchor, bucket, burst);
  assert.deepEqual(background.map((line) => line.text), ["t9", "t10", "t11", "t12", "t13", "t14", "t15", "t16", "t17", "t18"]);
});

test("有 id/序号时不拿「同人同话」误删背景；旧流水没有 id 才回退", () => {
  const anchor = msg({ userId: 7, text: "好", messageId: 3, arrivalSeq: 3 });
  const burst: BurstMessage[] = [
    { userId: 7, nickname: "A", text: "好", at: 0, mentionsBot: false, replyIds: [], messageId: 1, arrivalSeq: 1 },
    { userId: 7, nickname: "A", text: "好", at: 0, mentionsBot: false, replyIds: [], messageId: 3, arrivalSeq: 3 },
  ];
  const bucket = [
    { arrivalSeq: 1, messageId: 1, userId: 7, nickname: "A", text: "好", at: 0 },
    // 同一句「好」但是另一条消息（seq 2）：它是真背景，不能被 loose 匹配删掉
    { arrivalSeq: 2, messageId: 2, userId: 7, nickname: "A", text: "好", at: 0 },
    { arrivalSeq: 3, messageId: 3, userId: 7, nickname: "A", text: "好", at: 0 },
  ];
  assert.deepEqual(backgroundFor(anchor, bucket, burst).map((line) => line.messageId), [2]);

  // 旧流水：没有 seq / id，只能按「同人同话」回退（与改版前一致）
  const legacyBucket = [
    { userId: 7, nickname: "A", text: "好", at: 0 },
    { userId: 8, nickname: "B", text: "插话", at: 0 },
    { userId: 7, nickname: "A", text: "好", at: 0 },
  ];
  const legacyBurst: BurstMessage[] = [
    { userId: 7, nickname: "A", text: "好", at: 0, mentionsBot: false, replyIds: [] },
    { userId: 7, nickname: "A", text: "好", at: 0, mentionsBot: false, replyIds: [] },
  ];
  const legacyAnchor = msg({ userId: 7, text: "好" });
  assert.deepEqual(backgroundFor(legacyAnchor, legacyBucket, legacyBurst).map((line) => line.text), ["插话"]);
});

test("bypass 段取整组里最近一条非空的，不只看最后一条", () => {
  const burst: BurstMessage[] = [
    { userId: 7, nickname: "A", text: "画一只猫", at: 0, mentionsBot: false, replyIds: [], payload: "BYPASS" },
    { userId: 7, nickname: "A", text: "快点", at: 0, mentionsBot: false, replyIds: [] },
  ];
  assert.equal(lastPayload(burst), "BYPASS");
  assert.equal(lastPayload([...burst, { userId: 7, nickname: "A", text: "呢", at: 0, mentionsBot: false, replyIds: [], payload: "" }]), "BYPASS");
  assert.equal(lastPayload([]), undefined);
});

test("会话/人格在首次 push 时绑住，后续 push 改不动", () => {
  const { clock, flushed, debouncer } = setup();
  const first = msg({ userId: 7, text: "第一句", messageId: 1, arrivalSeq: 1 });
  const second = msg({ userId: 7, text: "第二句", messageId: 2, arrivalSeq: 2 });

  debouncer.push({ msg: first, text: first.text, binding: "persona-A" });
  // 5 秒里主人 /切换人格 了：新消息带着新人格进来，但不能把整组的落点改掉
  const burst = debouncer.push({ msg: second, text: second.text, binding: "persona-B" });
  assert.equal(burst.binding, "persona-A");

  // 被闸拦下的 follow-up 不带 binding 也不会把绑定抹掉
  debouncer.push({ msg: msg({ userId: 7, text: "第三句", messageId: 3, arrivalSeq: 3 }), text: "第三句" });
  assert.equal(debouncer.pending(CHAT, 7)?.binding, "persona-A");

  clock.fireAll();
  assert.equal(flushed[0].binding, "persona-A");
});
