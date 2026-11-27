import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  DEFAULT_LIMITS,
  findProvenanceLeak,
  longestCommonSubstring,
  validateMedia,
  validateOutbound,
  type EgressContext,
} from "../src/egress/policy.ts";
import {
  clearAllSeenLinks,
  clearSeenLinks,
  recordSeenLinks,
  seenLinksOf,
} from "../src/egress/seen-links.ts";
import { absorbSecrets, recordTurnSecret } from "../src/egress/absorb.ts";
import { clearSecrets, ledgerOf } from "../src/egress/ledger.ts";

const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 0]);

function ctx(over: Partial<EgressContext> = {}): EgressContext {
  return {
    limits: { ...DEFAULT_LIMITS, mediaRoot: "/tmp/yugang-media" },
    now: 1_000_000,
    recent: [],
    secrets: [],
    ...over,
  };
}

test("正常一句话放行", () => {
  assert.equal(validateOutbound({ messages: ["在的，刚在刷手机"] }, ctx()), null);
});

test("长文与多行均放行", () => {
  assert.equal(validateOutbound({ messages: ["字".repeat(200)] }, ctx()), null); // 字数上限已移除
  assert.equal(validateOutbound({ messages: ["一\n二\n三\n四"] }, ctx()), null); // 换行限制已移除
});

test("markdown 结构被拒（思考 dump 的典型特征）", () => {
  assert.equal(validateOutbound({ messages: ["## 结论\n好的"] }, ctx())?.code, "markdown");
  assert.equal(validateOutbound({ messages: ["- 第一\n- 第二"] }, ctx())?.code, "markdown");
  assert.equal(validateOutbound({ messages: ["```js\n1\n```"] }, ctx())?.code, "markdown");
  assert.equal(validateOutbound({ messages: ["**重点**是这样"] }, ctx())?.code, "markdown");
});

test("绝对路径与密钥被拒", () => {
  assert.equal(validateOutbound({ messages: ["我看了 ~/fish.md"] }, ctx())?.code, "secret");
  assert.equal(validateOutbound({ messages: ["key 是 sk-abcdefgh1234"] }, ctx())?.code, "secret");
});

test("媒体必须在白名单目录内且真是图片", () => {
  const root = mkdtempSync(join(tmpdir(), "yg-"));
  const good = join(root, "a.png");
  writeFileSync(good, PNG);
  const limits = { ...DEFAULT_LIMITS, mediaRoot: root };

  assert.equal(validateOutbound({ messages: ["看"], media: good }, ctx({ limits })), null);
  assert.equal(validateOutbound({ messages: ["看"], media: "/etc/passwd" }, ctx({ limits }))?.code, "media_outside");
  assert.equal(validateOutbound({ messages: ["看"], media: join(root, "missing.png") }, ctx({ limits }))?.code, "media_missing");

  const fake = join(root, "b.png");
  writeFileSync(fake, "not an image at all");
  assert.equal(validateOutbound({ messages: ["看"], media: fake }, ctx({ limits }))?.code, "media_magic");
});

test("空消息配图放行与去重", () => {
  // 出口拆成四工具后无字发图是常态：空 messages + media/voice 放行，三皆空才拒 empty
  const root = mkdtempSync(join(tmpdir(), "yg-empty-"));
  const good = join(root, "a.png");
  writeFileSync(good, PNG);
  const limits = { ...DEFAULT_LIMITS, mediaRoot: root };
  assert.equal(validateOutbound({ messages: [] }, ctx({ limits }))?.code, "empty");
  assert.equal(validateOutbound({ messages: [], media: good }, ctx({ limits })), null);
  const recent = Array.from({ length: 8 }, () => ({ text: "别的", at: 999_000 }));
  assert.equal(validateOutbound({ messages: ["嗯"] }, ctx({ recent })), null); // 每分钟条数限制已移除，不再拒
  assert.equal(validateOutbound({ messages: ["在的"] }, ctx({ recent: [{ text: "在的。", at: 999_500 }] }))?.code, "duplicate");
});

test("溯源：连续重合超过阈值判为抄袭", () => {
  const secret = "我先看看他刚才说的是什么意思然后决定怎么接这句话比较自然一点";
  assert.ok(longestCommonSubstring(secret.slice(0, 30), secret) >= 24);
  assert.equal(validateOutbound({ messages: [secret.slice(0, 30)] }, ctx({ secrets: [secret] }))?.code, "provenance");
  assert.equal(validateOutbound({ messages: ["你们在聊啥呢"] }, ctx({ secrets: [secret] })), null);
});

test("seen-links 统一按 String(round) 存取与清空", () => {
  clearAllSeenLinks();
  recordSeenLinks(42, ["https://a.test"]);
  assert.equal(seenLinksOf("42").has("https://a.test"), true);
  clearSeenLinks("42");
  assert.equal(seenLinksOf(42).size, 0);
  assert.equal(seenLinksOf("42").size, 0);
});

test("absorbSecrets 感知 headId 换页重置游标、截断 thinking 且支持增量 recordTurnSecret", async () => {
  const convId = "conv-absorb-test";
  clearSecrets(convId);
  let headId = 10;
  let entries: unknown[] = [
    { kind: "pi.tool-result", model: { content: "第一页工具输出内容超过二十四个字的秘密片段在这里" } },
    { kind: "pi.tool-result", model: { content: "第一页第二条" } },
  ];
  const fakeConv = {
    id: convId,
    async context() {
      return { head: { id: headId }, entries };
    },
  };
  await absorbSecrets(fakeConv as never);
  assert.ok(ledgerOf(convId).secrets.length >= 2);

  // 模拟换页后 entries.length 变小且 head.id 变化，thinking 超过 4000 字
  clearSecrets(convId);
  headId = 20;
  const longThinking = `秘密前缀超过二十四个字符一定要被截断检查到${"哈".repeat(4500)}`;
  entries = [
    { kind: "pi.assistant", model: [{ content: [{ type: "thinking", thinking: longThinking }] }] },
  ];
  await absorbSecrets(fakeConv as never);
  assert.equal(ledgerOf(convId).secrets.length, 1, "换页后应重置游标重新扫描");
  assert.equal(ledgerOf(convId).secrets[0]?.length, 4000, "thinking 应截断至 4000 字符");

  // 增量 recordTurnSecret 立即可被 findProvenanceLeak 命中
  clearSecrets(convId);
  const turnSecret = "这是同轮刚刚执行完的工具返回内容应该立刻进入溯源防泄漏集合";
  recordTurnSecret(convId, turnSecret);
  assert.ok(findProvenanceLeak(turnSecret, ledgerOf(convId).secrets) !== null);
});

test("longestCommonSubstring 支持早退与超长输入不溢出，validateMedia 只读文件头 16B", () => {
  const big = "x".repeat(70_000);
  assert.equal(longestCommonSubstring(big, big), 70_000);
  assert.equal(longestCommonSubstring("a".repeat(200), "a".repeat(200), 24), 24);

  const root = mkdtempSync(join(tmpdir(), "yg-head-"));
  const file = join(root, "big.png");
  const bigTail = Buffer.alloc(1024 * 1024, 0x41);
  PNG.copy(bigTail, 0);
  writeFileSync(file, bigTail);
  assert.equal(validateMedia(file, { ...DEFAULT_LIMITS, mediaRoot: root }), null);
});
