/**
 * 门：next-only 判定（2026-11 起 legacy 搭话判定已下线，限流/随机门/回复合集不再参与）。
 *  - 私聊只认主人，陌生人一律不进
 *  - 群里任何人 @（含裸 @）硬通行，零模型调用
 *  - 其余非 @ 群消息按开窗两态：open → free_pass，closed / 未跟踪 → next_pending
 */
import test from "node:test";
import assert from "node:assert/strict";
import { createGate, type GateOptions } from "../src/qq/gate.ts";
import type { IncomingMessage } from "../src/channels/qq/onebot.ts";

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

test("陌生人私聊不进，主人的私聊直接进", async () => {
  const gate = build();
  const stranger = await gate.decide({ msg: msg({ chatKey: "qq:private:2000" }) });
  assert.equal(stranger.enter, false);
  assert.equal(stranger.reason, "stranger_private");

  const master = await gate.decide({ msg: msg({ chatKey: "qq:private:1000", userId: 1000 }) });
  assert.equal(master.enter, true);
  assert.equal(master.reason, "private");
});

test("任何群友 @ 都硬通行", async () => {
  const gate = build();
  const mentioned = await gate.decide({ msg: msg({ mentionsBot: true }) });
  assert.equal(mentioned.enter, true);
  assert.equal(mentioned.reason, "mentioned");
});

test("自由模式：GROUPS 群非 @ 一律 free_pass（无 closed/open 相位）", async () => {
  const gate = build();
  const passed = await gate.decide({ msg: msg() });
  assert.equal(passed.enter, true);
  assert.equal(passed.reason, "free_pass");
  // 无相位可翻：重复判定稳定
  const again = await gate.decide({ msg: msg() });
  assert.equal(again.enter, true);
  assert.equal(again.reason, "free_pass");
});

test("群白名单照旧拒掉名单外的群", async () => {
  const gate = build({ groups: ["42"] });
  const other = await gate.decide({ msg: msg({ groupId: 99, chatKey: "qq:group:99" }) });
  assert.equal(other.enter, false);
  assert.equal(other.reason, "group_not_allowed");
});
