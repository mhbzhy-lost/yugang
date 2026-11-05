/**
 * 被回复的引用图：look 与 inline 两种读图模式都必须给到模型（2026-11-05 主人反馈）。
 *
 * 现场：主人回复一张 jpg 说「收图」@ 鱼，引用原文渲染成「」，模型拿不到 inbound 引用，
 * 既没法 look 也没法 meme_add，只能把「收图」当玩笑接。
 *
 * 规则：
 *  - look 模式（inline 关闭）：引用原文里出现 `[图片 inbound/…]`，并触发 look 提示；
 *  - inline 模式：引用图参与本轮编号（直发图优先），原文里变成 `[图片#N]`，
 *    压缩 image block 按编号附在消息末尾；
 *  - GIF 不 inline（也没有静默收图轮可依赖），但 look 模式仍给引用和提示。
 */
import test from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { loadPrompts } from "../src/prompts.ts";
import { planRoundImages } from "../src/qq/round-images.ts";
import { withContext, type BurstMessage } from "../src/qq/debounce.ts";
import type { IncomingMessage } from "../src/qq/onebot.ts";
import type { QuotedMessage } from "../src/qq/model-input.ts";
import type { ShrinkResult } from "../src/media/shrink-image.ts";

const PROMPTS = fileURLToPath(new URL("../prompt", import.meta.url));
const messages = loadPrompts(PROMPTS).messages;
const mediaRoot = mkdtempSync(join(tmpdir(), "yg-quoted-"));
const JPG = "inbound/replied.jpg";
const JPG_DIRECT = "inbound/direct.jpg";
const GIF = "inbound/replied.gif";
mkdirSync(join(mediaRoot, "inbound"), { recursive: true });
for (const ref of [JPG, JPG_DIRECT, GIF]) writeFileSync(join(mediaRoot, ref), "fixture");

const shrink = (_input: { file: string }): ShrinkResult => ({
  ok: true,
  buffer: Buffer.from("compressed"),
  mimeType: "image/jpeg",
});

const GROUP = "qq:group:659976571";

function quoted(refs: readonly string[]): QuotedMessage {
  return { id: "111784281", nickname: "遐蝶小姐的狗", userId: "2928390812", text: "", images: refs };
}

function burstLine(quotedMessage: QuotedMessage, text = "收图"): BurstMessage {
  return {
    arrivalSeq: 2,
    messageId: 844685635,
    userId: 2928390812,
    nickname: "遐蝶小姐的狗",
    text,
    at: 2,
    mentionsBot: true,
    replyIds: ["111784281"],
    quoted: quotedMessage,
  };
}

function anchor(partial: Partial<IncomingMessage> = {}): IncomingMessage {
  return {
    chatKey: GROUP,
    groupId: 659976571,
    messageId: 844685635,
    userId: 2928390812,
    nickname: "遐蝶小姐的狗",
    text: "收图",
    mentionsBot: true,
    mentions: [],
    images: [],
    imageSegments: [],
    replyIds: ["111784281"],
    ...partial,
  } as IncomingMessage;
}

test("look 模式：引用图出现在 [引用原文] 里，并触发 look 提示", () => {
  const q = quoted([JPG]);
  const plan = planRoundImages(anchor(), [burstLine(q)], mediaRoot, false, messages, shrink);
  assert.equal(plan.blocks.length, 0, "look 模式不该有 image block");
  assert.equal(plan.lookHint, true, "引用图没触发 look 提示");
  const round = withContext(anchor(), [], plan.messages, { master: "", messages, imageNumbers: plan.numbers });
  assert.match(round.content, new RegExp(`\\[引用原文\\]\\[m:111784281\\] 遐蝶小姐的狗\\(2928390812\\)：「\\[图片 ${JPG}\\]」`));
});

test("inline 模式：引用图参与编号，原文变 [图片#1]，压缩图按编号在后", () => {
  const q = quoted([JPG]);
  const plan = planRoundImages(anchor(), [burstLine(q)], mediaRoot, true, messages, shrink);
  assert.equal(plan.numbers.get(JPG), 1, "引用图没拿到编号");
  assert.equal(plan.blocks.length, 1);
  assert.deepEqual(plan.tags, [messages["image_compressed_tag"]?.replace("{{n}}", "1") ?? "[图片#1 压缩图]"]);
  assert.equal(plan.lookHint, false, "已 inline 的图不该再提示 look");
  const round = withContext(anchor(), [], plan.messages, { master: "", messages, imageNumbers: plan.numbers });
  assert.match(round.content, /\[引用原文\]\[m:111784281\] 遐蝶小姐的狗\(2928390812\)：「\[图片#1\]」/);
});

test("inline 模式：直发图优先编号，引用图排在后面", () => {
  const direct = anchor({
    text: `看看这个 [图片 ${JPG_DIRECT}]`,
    images: [{ ref: JPG_DIRECT }],
    replyIds: ["111784281"],
  });
  const plan = planRoundImages(
    direct,
    [burstLine(quoted([JPG]), `看看这个 [图片 ${JPG_DIRECT}]`)],
    mediaRoot,
    true,
    messages,
    shrink,
  );
  assert.equal(plan.numbers.get(JPG_DIRECT), 1, "直发图应该先编号");
  assert.equal(plan.numbers.get(JPG), 2, "引用图应该排在直发图之后");
  const round = withContext(direct, [], plan.messages, { master: "", messages, imageNumbers: plan.numbers });
  assert.match(round.content, /「\[图片#2\]」/);
  assert.match(round.content, /看看这个 \[图片#1\]/);
});

test("look 模式：引用 GIF 不 inline，但保留引用并提示 look", () => {
  const q = quoted([GIF]);
  const plan = planRoundImages(anchor(), [burstLine(q)], mediaRoot, false, messages, shrink);
  assert.equal(plan.numbers.has(GIF), false, "GIF 不该 inline");
  assert.equal(plan.lookHint, true, "引用 GIF 没有别的读取路径，应提示 look");
  const round = withContext(anchor(), [], plan.messages, { master: "", messages, imageNumbers: plan.numbers });
  assert.match(round.content, new RegExp(`「\\[图片 ${GIF}\\]」`));
});

test("引用图与文字同时存在时都保留，读图失败标记不误伤", () => {
  const q = { ...quoted([JPG]), text: "这是我刚发的" };
  const round = withContext(anchor(), [], [burstLine(q)], { master: "", messages });
  assert.match(round.content, /「这是我刚发的 \[图片 inbound\/replied\.jpg\]」/);
});
