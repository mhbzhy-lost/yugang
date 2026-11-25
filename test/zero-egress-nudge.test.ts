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

test("shouldNudgeZeroEgress：直发画图与重启工具豁免，需回复类工具（video）仍补跑", () => {
  // 远程静态生图 2026-11-25 收归 draw_remote：它经 outbox 机械直发，豁免零出口补跑；旧 gpt_image / wan_image 家族已退役
  assert.ok(DIRECT_EGRESS_TOOL_FAMILIES.has("draw_remote"), "draw_remote 应回执豁免零出口补跑");
  assert.ok(!DIRECT_EGRESS_TOOL_FAMILIES.has("gpt_image"), "gpt_image 工具已删除，不应再列为直发家族");
  assert.ok(!DIRECT_EGRESS_TOOL_FAMILIES.has("wan_image"), "wan_image 工具已删除，不应再列为直发家族");

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

  // video / meme_import / meme_add 虽会发 working_* 机械提示，但结果仍需模型调 say_* 回复
  for (const tool of ["video", "meme_import", "meme_add"]) {
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

test("runtime.ts：draw_remote 独立成家族，不被 draw_ 前缀吞并；宿主已装配热配置与超时", () => {
  const runtime = readFileSync(join(ROOT, "src/app/runtime.ts"), "utf8");

  // 家族推导只聚合本地管线变体（Review Focus #4）：旧的 tool.startsWith("draw_") 会把 draw_remote 算进 draw 家族，
  // 导致同轮先 draw 再 draw_remote 时「稍等」被去重掉、零出口豁免也串家族
  assert.ok(runtime.includes('const DRAW_VARIANTS = new Set(["draw_fast", "draw_interaction"])'), "家族推导应显式枚举本地变体");
  assert.ok(!runtime.includes('tool.startsWith("draw_")'), "不得再用 draw_ 前缀吞并 draw_remote");

  // 「正在执行」文案与超时表换成 draw_remote，旧的 gpt_image / wan_image 行全部摘除
  assert.ok(runtime.includes('case "draw_remote": return fish.prompts.messages["working_draw_remote"]'));
  assert.ok(!runtime.includes("working_gpt_image"), "working_gpt_image 文案已退役");
  assert.match(runtime, /draw_remote: 210/);
  assert.ok(!/\bgpt_image: \d+/.test(runtime), "超时表不应再有 gpt_image");
  assert.ok(!/\bwan_image: \d+/.test(runtime), "超时表不应再有 wan_image");

  // 宿主装配：热配置现读 + 适配器本体；旧 gptImage 通道构造已删（wanImage 留给 wan_gif）
  assert.ok(runtime.includes("drawRemote: () => fishConfig().config.drawRemote"), "应注入 drawRemote 热配置");
  assert.ok(runtime.includes("drawRemoteRun"), "应透传 drawRemoteRun 适配器");
  assert.ok(!/\bgptImage\b/.test(runtime), "runtime 不应再构造 gptImage 通道");
});

test("zero_egress_nudge 文案已在 messages.md 定义并接入 runtime.ts", () => {
  const prompts = loadPrompts(join(ROOT, "prompt"));
  assert.ok(prompts.messages["zero_egress_nudge"]?.includes("say_words"));

  const runtime = readFileSync(join(ROOT, "src/app/runtime.ts"), "utf8");
  assert.ok(runtime.includes("shouldNudgeZeroEgress("));
  assert.ok(runtime.includes('messages["zero_egress_nudge"]'));
});
