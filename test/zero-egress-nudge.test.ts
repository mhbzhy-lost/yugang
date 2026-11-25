import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { loadPrompts } from "../src/prompt/index.ts";
import { DIRECT_EGRESS_TOOL_FAMILIES, shouldNudgeZeroEgress } from "../src/zero-egress-nudge.ts";

const ROOT = fileURLToPath(new URL("..", import.meta.url));

test("shouldNudgeZeroEgress：仅在 answer 轮正常结束且零出口时补跑一次", () => {
  // 典型场景：@ 或私聊必答轮，模型只吐裸文本未调 say_*
  assert.equal(
    shouldNudgeZeroEgress({ roundKind: "answer", status: "done", sayCount: 0, alreadyNudged: false }),
    true,
  );

  // 已补跑过 1 次：绝不再次补跑（防死循环）
  assert.equal(
    shouldNudgeZeroEgress({ roundKind: "answer", status: "done", sayCount: 0, alreadyNudged: true }),
    false,
  );

  // 已经调过 say_*：不补跑
  assert.equal(
    shouldNudgeZeroEgress({ roundKind: "answer", status: "done", sayCount: 1, alreadyNudged: false }),
    false,
  );

  // 非 answer 轮（自由拍/主动浏览/新闻）：零出口合法，绝不补跑
  for (const roundKind of ["ambient", "injection", "news"] as const) {
    assert.equal(
      shouldNudgeZeroEgress({ roundKind, status: "done", sayCount: 0, alreadyNudged: false }),
      false,
    );
  }

  // 非正常结束（报错/取消）：走错误分支，不补跑
  assert.equal(
    shouldNudgeZeroEgress({ roundKind: "answer", status: "unanswered", sayCount: 0, alreadyNudged: false }),
    false,
  );
});

test("shouldNudgeZeroEgress：直发画图与重启工具豁免，需回复类工具（video/gpt_image）仍补跑", () => {
  for (const tool of DIRECT_EGRESS_TOOL_FAMILIES) {
    assert.equal(
      shouldNudgeZeroEgress({
        roundKind: "answer",
        status: "done",
        sayCount: 0,
        workingTools: new Set([tool]),
        alreadyNudged: false,
      }),
      false,
      `${tool} 应豁免零出口补跑`,
    );
  }

  // video / gpt_image / meme_import / meme_add 虽会发 working_* 机械提示，但结果仍需模型调 say_* 回复
  for (const tool of ["video", "gpt_image", "meme_import", "meme_add"]) {
    assert.equal(
      shouldNudgeZeroEgress({
        roundKind: "answer",
        status: "done",
        sayCount: 0,
        workingTools: new Set([tool]),
        alreadyNudged: false,
      }),
      true,
      `${tool} 未调 say_* 仍应触发补跑`,
    );
  }
});

test("zero_egress_nudge 文案已在 messages.md 定义并接入 runtime.ts", () => {
  const prompts = loadPrompts(join(ROOT, "prompt"));
  assert.ok(prompts.messages["zero_egress_nudge"]?.includes("say_words"));

  const runtime = readFileSync(join(ROOT, "src/app/runtime.ts"), "utf8");
  assert.ok(runtime.includes("shouldNudgeZeroEgress("));
  assert.ok(runtime.includes('messages["zero_egress_nudge"]'));
});
