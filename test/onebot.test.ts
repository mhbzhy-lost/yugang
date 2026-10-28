/**
 * 裸 @ 修复：
 *  - 只 @ 不带字的消息不再被丢弃，以最小占位文本进闸（进 chatlog 与 user message）
 *  - 非 @ 的空文本维持丢弃
 */
import test from "node:test";
import assert from "node:assert/strict";
import { parseEvent, type OneBotEvent } from "../src/qq/onebot.ts";

const SELF = 1000;

function frame(message: OneBotEvent["message"]): OneBotEvent {
  return {
    post_type: "message",
    message_type: "group",
    group_id: 42,
    user_id: 2000,
    message_id: 7,
    sender: { nickname: "张三" },
    message,
  };
}

test("裸 @（只 @ 不带字）不丢弃，占位文本进链路", () => {
  const parsed = parseEvent(frame([{ type: "at", data: { qq: SELF } }, { type: "text", data: { text: "" } }]), SELF);
  assert.ok(parsed, "裸 @ 被丢了，用户观感是鱼不理人");
  assert.equal(parsed.mentionsBot, true);
  assert.ok(parsed.text.trim().length > 0, "占位文本不能是空的，否则后面还是被当空消息丢掉");
  assert.match(parsed.text, /@/);
});

test("非 @ 的空文本维持丢弃", () => {
  const empty = parseEvent(frame([{ type: "text", data: { text: "   " } }]), SELF);
  assert.equal(empty, null);

  // @ 了别人（不是鱼）的空文本也不进
  const other = parseEvent(frame([{ type: "at", data: { qq: 9999 } }, { type: "text", data: { text: "" } }]), SELF);
  assert.equal(other, null);
});

test("带正文的 @ 行为不变", () => {
  const parsed = parseEvent(frame([{ type: "at", data: { qq: SELF } }, { type: "text", data: { text: " 在吗" } }]), SELF);
  assert.ok(parsed);
  assert.equal(parsed.mentionsBot, true);
  assert.equal(parsed.text, "在吗");
});
