import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DEFAULT_LIMITS, longestCommonSubstring, validateOutbound, type EgressContext } from "../src/egress/policy.ts";

const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 0]);

function ctx(over: Partial<EgressContext> = {}): EgressContext {
  return {
    limits: { ...DEFAULT_LIMITS, mediaRoot: "/tmp/yugang-media" },
    now: 1_000_000,
    recent: [],
    sentThisRun: 0,
    secrets: [],
    ...over,
  };
}

test("正常一句话放行", () => {
  assert.equal(validateOutbound({ messages: ["在的，刚在刷手机"] }, ctx()), null);
});

test("长文放行，多行仍被拒", () => {
  assert.equal(validateOutbound({ messages: ["字".repeat(200)] }, ctx()), null); // 字数上限已按主人要求移除
  assert.equal(validateOutbound({ messages: ["一\n二\n三\n四"] }, ctx())?.code, "too_many_lines");
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

test("配额与去重", () => {
  assert.equal(validateOutbound({ messages: ["嗯"] }, ctx({ sentThisRun: 4 }))?.code, "quota_run");
  const recent = Array.from({ length: 8 }, () => ({ text: "别的", at: 999_000 }));
  assert.equal(validateOutbound({ messages: ["嗯"] }, ctx({ recent }))?.code, "quota_minute");
  assert.equal(validateOutbound({ messages: ["在的"] }, ctx({ recent: [{ text: "在的。", at: 999_500 }] }))?.code, "duplicate");
});

test("溯源：连续重合超过阈值判为抄袭", () => {
  const secret = "我先看看他刚才说的是什么意思然后决定怎么接这句话比较自然一点";
  assert.ok(longestCommonSubstring(secret.slice(0, 30), secret) >= 24);
  assert.equal(validateOutbound({ messages: [secret.slice(0, 30)] }, ctx({ secrets: [secret] }))?.code, "provenance");
  assert.equal(validateOutbound({ messages: ["你们在聊啥呢"] }, ctx({ secrets: [secret] })), null);
});
