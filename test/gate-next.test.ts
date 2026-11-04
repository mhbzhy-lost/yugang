/**
 * 门的 next-only 语义（开窗两态，legacy 判定已下线；合集不给 @ 之外的例外）：
 *  - @ 仍必答（含裸 @、@ 且回复合集）——@ 优先于一切窗口判定
 *  - 引用合集必须同时 @ 才展开（单独引用一律拒）；普通回复仍只是
 *    引用动作，不必答
 *  - 无 @ 的自带合集零成本拒掉（不展开、不进模型），合集 id 缓存在 onebot 解析层
 *    （闸前）无条件照记，不受本闸影响
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

test("引用合集没 @ 一律拒（不展开）；@ 了才展开", async () => {
  const gate = build();
  // 主体定案 2026-11-04：看合集得 @——单纯引用合集不给闸例外，open 态也不进模型
  const replied = await gate.decide({ msg: msg({ repliedForward: true }) });
  assert.equal(replied.enter, false, "引用合集但没有 @ 不该进模型");
  assert.equal(replied.reason, "next_pending");
  const open = await build({ isOpen: () => true }).decide({ msg: msg({ repliedForward: true }) });
  assert.equal(open.enter, false, "open 态也不放行引用合集");
  assert.equal(open.reason, "next_pending");

  // 普通回复（不是合集）不改变闸语义：非 @ 仍按开窗两态
  const plain = await gate.decide({ msg: msg({ replyIds: ["123"] }) });
  assert.equal(plain.enter, false);
  assert.equal(plain.reason, "next_pending");
});

test("无 @ 自带合集零成本拒掉（id 缓存照记在闸外）", async () => {
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
