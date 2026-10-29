/**
 * 门：@ 必答 + 随机粗筛（2026-10 起没有打分闸）。
 *  - 私聊只认主人，陌生人一律不进
 *  - 群里任何人 @ 硬通行，零模型调用
 *  - 其余消息（含主人的非 @）按 AMBIENT_CHANCE 随机放行，也不花模型调用
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
    ambientChance: 1,
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

test("非 @ 过随机粗筛：放行就进，不放行就沉默", async () => {
  const pass = build({ random: () => 0 });
  const entered = await pass.decide({ msg: msg({ userId: 1000 }), ...idle });
  assert.equal(entered.enter, true);
  assert.equal(entered.reason, "sampled");

  const drop = build({ random: () => 1, ambientChance: 0.05 });
  const dropped = await drop.decide({ msg: msg({ userId: 1000 }), ...idle });
  assert.equal(dropped.enter, false);
  assert.equal(dropped.reason, "sampled_out");
});

test("随机门每次只掷一次骰子：0.05 档下抽样分布对得上", async () => {
  const gate = build({ ambientChance: 0.05 });
  let entered = 0;
  for (let i = 0; i < 400; i++) {
    const decision = await gate.decide({ msg: msg(), ...idle });
    if (decision.enter) entered += 1;
  }
  // 期望 20 条；给足波动空间，只要不是「全进/全不进」这种明显错法即可
  assert.ok(entered > 0 && entered < 60, `400 条里进了 ${entered} 条`);
});

test("按群覆盖概率：0 的群只回 @", async () => {
  const gate = build({ ambientChance: 0.05, ambientChanceByGroup: { "42": 0, "43": 1 } });
  const quiet = await gate.decide({ msg: msg({ groupId: 42 }), ...idle });
  assert.equal(quiet.enter, false);
  assert.equal(quiet.reason, "sampled_out");

  const loud = await gate.decide({ msg: msg({ groupId: 43, chatKey: "qq:group:43" }), ...idle });
  assert.equal(loud.enter, true);
  assert.equal(loud.reason, "sampled");
});

test("群白名单与无 @ 合集仍然零成本拒掉", async () => {
  const gate = build({ groups: ["42"] });
  const other = await gate.decide({ msg: msg({ groupId: 99, chatKey: "qq:group:99" }), ...idle });
  assert.equal(other.reason, "group_not_allowed");

  const forward = await gate.decide({ msg: msg({ forwardIds: ["f1"] }), ...idle });
  assert.equal(forward.reason, "forward_ignored");
});
