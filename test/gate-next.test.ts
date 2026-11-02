/**
 * 搭话总开关 engagement（fish.config.json → gate）：
 *  - legacy（缺省）各通路与改版前零变化：@ / 回复合集 / 特别关注 / 限流 / 无 @ 合集照旧
 *  - next：群里只认「直接 @ 鱼」——watched / watched_rate_pass / rate_pass / replied_forward
 *    四条通路全部失效，非 @ 群消息统一 skip:next_pending（不进模型）；私聊不受影响
 *  - `/` 指令与 GIF 收图轮在 index.ts 闸前机械拦截（不经过 gate），无闸层行为可断言；
 *    无 @ 合集的 id 缓存在 onebot 解析层（闸前）无条件照记，不受本开关影响——
 *    闸只把这类消息的 skip 理由从 forward_ignored 换成 next_pending
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

test("legacy（显式配置）各通路回归不变", async () => {
  let clock = 1_000_000;
  const gate = build({ engagement: "legacy", now: () => clock, watchedChance: 0.5, random: () => 0 });

  const mentioned = await gate.decide({ msg: msg({ mentionsBot: true }), ...idle });
  assert.equal(mentioned.enter, true);
  assert.equal(mentioned.reason, "mentioned");

  const replied = await gate.decide({ msg: msg({ repliedForward: true }), ...idle });
  assert.equal(replied.enter, true);
  assert.equal(replied.reason, "replied_forward");

  const forward = await gate.decide({ msg: msg({ forwardIds: ["f1"] }), ...idle });
  assert.equal(forward.enter, false);
  assert.equal(forward.reason, "forward_ignored");

  clock += 60_000; // @ 与回复合集刷新过计时：隔够窗口后普通消息才限流放行
  const plain = await gate.decide({ msg: msg(), ...idle });
  assert.equal(plain.enter, true);
  assert.equal(plain.reason, "rate_pass");

  clock += 5_000;
  const limited = await gate.decide({ msg: msg(), ...idle });
  assert.equal(limited.enter, false);
  assert.equal(limited.reason, "rate_limited");

  clock += 30_000;
  const watchedIn = await gate.decide({ msg: msg(), watched: true, ...idle });
  assert.equal(watchedIn.enter, true, "随机必中时关注者走 watched");
  assert.equal(watchedIn.reason, "watched");
});

test("缺省（不配置 engagement）= legacy，行为不变", async () => {
  const gate = build();
  const plain = await gate.decide({ msg: msg(), ...idle });
  assert.equal(plain.enter, true);
  assert.equal(plain.reason, "rate_pass");
});

test("next：@ 仍必答（含裸 @、@ 且回复合集）", async () => {
  const gate = build({ engagement: "next" });

  const bare = await gate.decide({ msg: msg({ mentionsBot: true }), ...idle });
  assert.equal(bare.enter, true);
  assert.equal(bare.reason, "mentioned");

  const replyWithAt = await gate.decide({ msg: msg({ mentionsBot: true, repliedForward: true }), ...idle });
  assert.equal(replyWithAt.enter, true, "@ 优先于回复合集，展开语义不变");
  assert.equal(replyWithAt.reason, "mentioned");
});

test("next：回复合集不再必答，非 @ 统一 next_pending", async () => {
  const gate = build({ engagement: "next" });
  const replied = await gate.decide({ msg: msg({ repliedForward: true }), ...idle });
  assert.equal(replied.enter, false, "回复鱼的内容只是引用动作，决定回复的是 @");
  assert.equal(replied.reason, "next_pending");
});

test("next：无 @ 合集也是 next_pending（id 缓存照记在闸外）", async () => {
  const gate = build({ engagement: "next" });
  const forward = await gate.decide({ msg: msg({ forwardIds: ["f1"] }), ...idle });
  assert.equal(forward.enter, false);
  assert.equal(forward.reason, "next_pending");
});

test("next：特别关注两条通路（随机门/限流门）都失效", async () => {
  let clock = 1_000_000;
  const gate = build({ engagement: "next", now: () => clock, watchedChance: 0.5 });

  const hit = await gate.decide({ msg: msg(), watched: true, ...idle }); // random 必中
  assert.equal(hit.enter, false);
  assert.equal(hit.reason, "next_pending");

  clock += 60_000; // 冷却早就够：legacy 下会是 watched_rate_pass
  const missed = await gate.decide({ msg: msg({ userId: 3001 }), watched: true, ...idle });
  assert.equal(missed.enter, false);
  assert.equal(missed.reason, "next_pending");
});

test("next：限流失效，不再有 rate_pass / rate_limited", async () => {
  let clock = 1_000_000;
  const gate = build({ engagement: "next", now: () => clock });

  const first = await gate.decide({ msg: msg(), ...idle });
  assert.equal(first.enter, false);
  assert.equal(first.reason, "next_pending");

  clock += 5_000;
  const second = await gate.decide({ msg: msg({ userId: 3002 }), ...idle });
  assert.equal(second.enter, false);
  assert.equal(second.reason, "next_pending");
});

test("next：私聊不受影响（主人进、陌生人拒）", async () => {
  const gate = build({ engagement: "next" });

  const master = await gate.decide({ msg: msg({ chatKey: "qq:private:1000", userId: 1000 }), ...idle });
  assert.equal(master.enter, true);
  assert.equal(master.reason, "private");

  const stranger = await gate.decide({ msg: msg({ chatKey: "qq:private:2000" }), ...idle });
  assert.equal(stranger.enter, false);
  assert.equal(stranger.reason, "stranger_private");
});

test("next：群白名单优先级不变", async () => {
  const gate = build({ engagement: "next", groups: ["42"] });
  const other = await gate.decide({ msg: msg({ groupId: 99, chatKey: "qq:group:99" }), ...idle });
  assert.equal(other.enter, false);
  assert.equal(other.reason, "group_not_allowed");
});

test("next 经 chances() 热切换：不重启即时生效，可切回", async () => {
  let clock = 1_000_000;
  let live: { minIntervalMs: number; watched: number; engagement: "legacy" | "next" } = {
    minIntervalMs: 30_000,
    watched: 0.5,
    engagement: "legacy",
  };
  const gate = build({ now: () => clock, chances: () => live });

  const legacyPass = await gate.decide({ msg: msg(), ...idle });
  assert.equal(legacyPass.enter, true);
  assert.equal(legacyPass.reason, "rate_pass");

  clock += 60_000;
  live = { ...live, engagement: "next" };
  const nextSkip = await gate.decide({ msg: msg(), ...idle });
  assert.equal(nextSkip.enter, false);
  assert.equal(nextSkip.reason, "next_pending");

  const stillAt = await gate.decide({ msg: msg({ mentionsBot: true }), ...idle });
  assert.equal(stillAt.enter, true, "切 next 后 @ 必答不变");

  clock += 60_000;
  live = { ...live, engagement: "legacy" };
  const backToLegacy = await gate.decide({ msg: msg(), ...idle });
  assert.equal(backToLegacy.enter, true, "切回 legacy 后限流判定恢复");
  assert.equal(backToLegacy.reason, "rate_pass");
});
