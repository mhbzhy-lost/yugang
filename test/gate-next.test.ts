/**
 * 门的 next-only 语义（开窗两态，legacy 判定已下线）：
 *  - @ 仍必答（含裸 @、@ 且回复合集）——@ 优先于一切窗口判定
 *  - 回复合集不再必答：回复鱼的内容只是引用动作，决定回复的是 @
 *  - 无 @ 合集不再单独丢弃（forward_ignored 已删），非 @ 统一按开窗两态；
 *    合集 id 缓存在 onebot 解析层（闸前）无条件照记，不受本闸影响
 *  - 特别关注/限流判定已随 legacy 删除：关注与否不再影响闸，非 @ 同样两态
 *  - `/` 指令与 GIF 收图轮在 index.ts 闸前机械拦截（不经过 gate），无闸层行为可断言
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
    ...over,
  });
}

test("@ 仍必答（含裸 @、@ 且回复合集）", async () => {
  const gate = build();

  const bare = await gate.decide({ msg: msg({ mentionsBot: true }) });
  assert.equal(bare.enter, true);
  assert.equal(bare.reason, "mentioned");

  const replyWithAt = await gate.decide({ msg: msg({ mentionsBot: true, repliedForward: true }) });
  assert.equal(replyWithAt.enter, true, "@ 优先于回复合集，展开语义不变");
  assert.equal(replyWithAt.reason, "mentioned");

  const duringClosed = await build({ isOpen: () => false }).decide({ msg: msg({ mentionsBot: true }) });
  assert.equal(duringClosed.enter, true, "closed 态 @ 照样必答");
  assert.equal(duringClosed.reason, "mentioned");
});

test("回复合集不再必答，非 @ 统一 next_pending", async () => {
  const gate = build();
  const replied = await gate.decide({ msg: msg({ repliedForward: true }) });
  assert.equal(replied.enter, false, "回复鱼的内容只是引用动作，决定回复的是 @");
  assert.equal(replied.reason, "next_pending");
});

test("无 @ 合集也是 next_pending（id 缓存照记在闸外）", async () => {
  const gate = build();
  const forward = await gate.decide({ msg: msg({ forwardIds: ["f1"] }) });
  assert.equal(forward.enter, false);
  assert.equal(forward.reason, "next_pending");
});

test("特别关注者的非 @ 消息同样按开窗两态（关注判定已不在闸内）", async () => {
  const closed = build();
  const pending = await closed.decide({ msg: msg({ userId: 3001 }) });
  assert.equal(pending.enter, false);
  assert.equal(pending.reason, "next_pending");

  const open = build({ isOpen: () => true });
  const passed = await open.decide({ msg: msg({ userId: 3001 }) });
  assert.equal(passed.enter, true);
  assert.equal(passed.reason, "free_pass");
});

test("私聊不受影响（主人进、陌生人拒）", async () => {
  const gate = build();

  const master = await gate.decide({ msg: msg({ chatKey: "qq:private:1000", userId: 1000 }) });
  assert.equal(master.enter, true);
  assert.equal(master.reason, "private");

  const stranger = await gate.decide({ msg: msg({ chatKey: "qq:private:2000" }) });
  assert.equal(stranger.enter, false);
  assert.equal(stranger.reason, "stranger_private");
});

test("群白名单优先级不变", async () => {
  const gate = build({ groups: ["42"], isOpen: () => true });
  const other = await gate.decide({ msg: msg({ groupId: 99, chatKey: "qq:group:99" }) });
  assert.equal(other.enter, false);
  assert.equal(other.reason, "group_not_allowed");
});
