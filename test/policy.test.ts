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
  assert.equal(validateOutbound({ text: "在的，刚在刷手机" }, ctx()), null);
});

test("过长与多行被拒", () => {
  assert.match(validateOutbound({ text: "字".repeat(200) }, ctx())!, /太长/);
  assert.match(validateOutbound({ text: "一\n二\n三\n四" }, ctx())!, /换行太多/);
});

test("markdown 结构被拒（思考 dump 的典型特征）", () => {
  assert.match(validateOutbound({ text: "## 结论\n好的" }, ctx())!, /标题/);
  assert.match(validateOutbound({ text: "- 第一\n- 第二" }, ctx())!, /列表/);
  assert.match(validateOutbound({ text: "```js\n1\n```" }, ctx())!, /代码块/);
  assert.match(validateOutbound({ text: "**重点**是这样" }, ctx())!, /加粗/);
});

test("绝对路径与密钥被拒", () => {
  assert.match(validateOutbound({ text: "我看了 ~/fish.md" }, ctx())!, /绝对路径/);
  assert.match(validateOutbound({ text: "key 是 sk-abcdefgh1234" }, ctx())!, /API key/);
});

test("媒体必须在白名单目录内且真是图片", () => {
  const root = mkdtempSync(join(tmpdir(), "yg-"));
  const good = join(root, "a.png");
  writeFileSync(good, PNG);
  const limits = { ...DEFAULT_LIMITS, mediaRoot: root };

  assert.equal(validateOutbound({ text: "看", media: good }, ctx({ limits })), null);
  assert.match(validateOutbound({ text: "看", media: "/etc/passwd" }, ctx({ limits }))!, /不在媒体目录/);
  assert.match(validateOutbound({ text: "看", media: join(root, "missing.png") }, ctx({ limits }))!, /找不到/);

  const fake = join(root, "b.png");
  writeFileSync(fake, "not an image at all");
  assert.match(validateOutbound({ text: "看", media: fake }, ctx({ limits }))!, /文件头不是图片/);
});

test("配额与去重", () => {
  assert.match(validateOutbound({ text: "嗯" }, ctx({ sentThisRun: 3 }))!, /够了/);
  const recent = Array.from({ length: 6 }, () => ({ text: "别的", at: 999_000 }));
  assert.match(validateOutbound({ text: "嗯" }, ctx({ recent }))!, /一分钟内/);
  assert.match(
    validateOutbound({ text: "在的" }, ctx({ recent: [{ text: "在的。", at: 999_500 }] }))!,
    /一模一样/,
  );
});

test("溯源：连续重合超过阈值判为抄袭", () => {
  const secret = "我先看看他刚才说的是什么意思然后决定怎么接这句话比较自然一点";
  assert.ok(longestCommonSubstring(secret.slice(0, 30), secret) >= 24);
  assert.match(
    validateOutbound({ text: secret.slice(0, 30) }, ctx({ secrets: [secret] }))!,
    /抄的/,
  );
  assert.equal(validateOutbound({ text: "你们在聊啥呢" }, ctx({ secrets: [secret] })), null);
});
