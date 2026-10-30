/**
 * 门：@ 必答 + 限流（2026-10 第二次改版：随机门换成最短间隔）。
 *  - 私聊只认主人，陌生人一律不进
 *  - 群里任何人 @ 硬通行，零模型调用；回复合集同样必答
 *  - 特别关注者仍走随机门
 *  - 其余消息（含主人的非 @）：同一群两条被处理消息之间至少隔 ambientMinIntervalSeconds
 */
import test from "node:test";
import assert from "node:assert/strict";
import { createGate, type GateOptions } from "../src/qq/gate.ts";
import type { IncomingMessage } from "../src/qq/onebot.ts";

const MASTER = "1000";

function msg(over: Partial<IncomingMessage> = {}): IncomingMessage {
  return {
    chatKey: "qq:group:42",
    groupId: 42,
    userId: 2000,
    nickname: "张三",
    text: "今天好热",
    mentionsBot: false,
    images: [],
    imageSegments: [],
    replyIds: [],
    ...over,
  };
}

function build(over: Partial<GateOptions> = {}) {
  return createGate({
    master: MASTER,
    groups: [],
    dailyQuota: 10,
    cooldownMs: 60_000,
    ambientMinIntervalMs: 30_000,
    ...over,
  });
}

const idle = { recent: [], lastSpokeAt: 0, spokenToday: 0 };

test("陌生人私聊不进，主人的私聊直接进", async () => {
  const gate = build();
  const stranger = await gate.decide({ msg: msg({ chatKey: "qq:private:2000" }), ...idle });
  assert.equal(stranger.enter, false);
  assert.equal(stranger.reason, "stranger_private");

  const master = await gate.decide({ msg: msg({ chatKey: "qq:private:1000", userId: 1000 }), ...idle });
  assert.equal(master.enter, true);
});

test("任何群友 @ 都硬通行", async () => {
  const gate = build();
  const mentioned = await gate.decide({ msg: msg({ mentionsBot: true }), ...idle });
  assert.equal(mentioned.enter, true);
  assert.equal(mentioned.reason, "mentioned");
});

test("限流：安静够久的第一条放行，紧接着的都被拦", async () => {
  let clock = 1_000_000;
  const gate = build({ now: () => clock });

  const first = await gate.decide({ msg: msg(), ...idle });
  assert.equal(first.enter, true);
  assert.equal(first.reason, "rate_pass");

  clock += 5_000;
  const second = await gate.decide({ msg: msg(), ...idle });
  assert.equal(second.enter, false);
  assert.equal(second.reason, "rate_limited");

  clock += 30_000;
  const third = await gate.decide({ msg: msg(), ...idle });
  assert.equal(third.enter, true, "间隔够了应该再放行");
});

test("限流按群独立计数", async () => {
  let clock = 1_000_000;
  const gate = build({ now: () => clock });
  await gate.decide({ msg: msg({ groupId: 42 }), ...idle });
  const other = await gate.decide({ msg: msg({ groupId: 43, chatKey: "qq:group:43" }), ...idle });
  assert.equal(other.enter, true, "别的群不该被这个群的计时挡住");
});

test("@ 与回复合集必答，并且会刷新该群的计时", async () => {
  let clock = 1_000_000;
  const gate = build({ now: () => clock });

  const mentioned = await gate.decide({ msg: msg({ mentionsBot: true }), ...idle });
  assert.equal(mentioned.enter, true);
  assert.equal(mentioned.reason, "mentioned");

  const right = await gate.decide({ msg: msg(), ...idle });
  assert.equal(right.enter, false, "@ 刚处理过，闲聊要等间隔");
  assert.equal(right.reason, "rate_limited");

  clock += 30_000;
  const replied = await gate.decide({ msg: msg({ repliedForward: true }), ...idle });
  assert.equal(replied.enter, true);
  assert.equal(replied.reason, "replied_forward");
});

test("特别关注：冷却够了直接回，不看随机", async () => {
  const gate = build({ random: () => 1, watchedChance: 0.5 }); // 随机必不中
  const first = await gate.decide({ msg: msg(), watched: true, ...idle });
  assert.equal(first.enter, true, "安静够久时关注者应当直接进");
  assert.equal(first.reason, "watched_rate_pass");
});

test("特别关注：冷却没到才掷随机门", async () => {
  let clock = 1_000_000;
  const pass = build({ now: () => clock, random: () => 0, watchedChance: 0.5 });
  await pass.decide({ msg: msg(), ...idle }); // 普通消息占掉冷却
  clock += 5_000;
  const watchedIn = await pass.decide({ msg: msg(), watched: true, ...idle });
  assert.equal(watchedIn.enter, true);
  assert.equal(watchedIn.reason, "watched");

  const drop = build({ now: () => clock, random: () => 1, watchedChance: 0.5 });
  await drop.decide({ msg: msg(), ...idle });
  clock += 5_000;
  const watchedOut = await drop.decide({ msg: msg(), watched: true, ...idle });
  assert.equal(watchedOut.enter, false);
  assert.equal(watchedOut.reason, "watched_sampled_out");
});

test("群白名单与无 @ 合集仍然零成本拒掉", async () => {
  const gate = build({ groups: ["42"] });
  const other = await gate.decide({ msg: msg({ groupId: 99, chatKey: "qq:group:99" }), ...idle });
  assert.equal(other.reason, "group_not_allowed");

  const forward = await gate.decide({ msg: msg({ forwardIds: ["f1"] }), ...idle });
  assert.equal(forward.reason, "forward_ignored");
});
