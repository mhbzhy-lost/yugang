/**
 * 裸 @ 修复：
 *  - 只 @ 不带字的消息不再被丢弃，以最小占位文本进闸（进 chatlog 与 user message）
 *  - 非 @ 的空文本维持丢弃
 */
import test from "node:test";
import assert from "node:assert/strict";
import { parseEvent, completeAtNames, fillAtName, type OneBotEvent } from "../src/qq/onebot.ts";

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

test("@号码补昵称只改自己那个占位，不碰数字前缀相同的别人", () => {
  // @12 的号码是 @123 的前缀：不能把 @123 也改成 @张三(12)3
  assert.equal(fillAtName("@12 和 @123 都在", "12", "张三"), "@张三(12) 和 @123 都在");
  // 昵称里带 $& / $1 不能被当成替换模式（字符串模板 replace 会吃掉它们）
  assert.equal(fillAtName("@77 来", "77", "$&老哥"), "@$&老哥(77) 来");
  // 非法号码原样返回
  assert.equal(fillAtName("@all 集合", "all", "全体成员"), "@all 集合");
});

test("completeAtNames：名单里有的才补，空名 / @全体 / 非法号码跳过", async () => {
  const parsed = parseEvent(
    frame([
      { type: "at", data: { qq: 12 } },
      { type: "at", data: { qq: "all" } },
      { type: "text", data: { text: " 看 @123" } },
    ]),
    SELF,
  );
  assert.ok(parsed);
  await completeAtNames(parsed, (qq) => (qq === "12" ? " 张三 " : undefined));
  assert.match(parsed.text, /@张三\(12\)/, "合法号码应该补上昵称");
  assert.match(parsed.text, /@123/, "号码前缀相同的别人不能被改掉");
  assert.match(parsed.text, /@全体成员/, "@全体 保持标记");
  assert.equal(parsed.atOtherNames?.[0], "张三");
  assert.equal(parsed.mentions?.find((m) => m.qq === "12")?.name, "张三");

  const unknown = parseEvent(frame([{ type: "at", data: { qq: 12 } }, { type: "text", data: { text: " 你好" } }]), SELF);
  assert.ok(unknown);
  const before = unknown.text;
  await completeAtNames(unknown, () => "   ");
  assert.equal(unknown.text, before, "空名不能把正文改成 @(12)");
});
