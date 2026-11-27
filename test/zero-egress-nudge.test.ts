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

test("shouldNudgeZeroEgress：直发画图与重启工具豁免，需回复类工具（video / draw_remote）仍补跑", () => {
  // draw_remote 已改为异步立即返回（2026-11-27），取消机械「稍等」提示，本轮须由模型调 say_words 告知群友，不再豁免零出口补跑
  assert.ok(!DIRECT_EGRESS_TOOL_FAMILIES.has("draw_remote"), "draw_remote 已改异步即时返回，不再豁免零出口补跑");
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

  // video / meme_import / meme_add / draw_remote 均需模型本轮调 say_* 回复
  for (const tool of ["video", "meme_import", "meme_add", "draw_remote"]) {
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

test("runtime.ts：draw_remote 改为异步投递（取消 working_draw_remote 与 210s 超时覆盖，停机优先 abort）", () => {
  const runtime = readFileSync(join(ROOT, "src/app/runtime.ts"), "utf8");

  // 家族推导只聚合本地管线变体
  assert.ok(runtime.includes('const DRAW_VARIANTS = new Set(["draw_fast", "draw_interaction"])'), "家族推导应显式枚举本地变体");
  assert.ok(!runtime.includes('tool.startsWith("draw_")'), "不得再用 draw_ 前缀吞并其它 draw_* 工具");

  // 异步 draw_remote 不再发机械「稍等」，不再设 210s 工具超时覆盖
  assert.ok(!runtime.includes("working_draw_remote"), "异步 draw_remote 已退役 working_draw_remote 机械提示");
  assert.ok(!runtime.includes("working_gpt_image"), "working_gpt_image 文案已退役");
  assert.ok(!/\bdraw_remote: \d+/.test(runtime), "异步 draw_remote 立即返回，不再需要工具超时覆盖");
  assert.ok(!/\bgpt_image: \d+/.test(runtime), "超时表不应再有 gpt_image");
  assert.ok(!/\bwan_image: \d+/.test(runtime), "超时表不应再有 wan_image");

  // 宿主装配：热配置现读 + 适配器本体 + 异步投递（写 transcript + 冲刷）+ 停机取消信号
  assert.ok(runtime.includes("drawRemote: () => fishConfig().config.drawRemote"), "应注入 drawRemote 热配置");
  assert.ok(runtime.includes("drawRemoteRun"), "应透传 drawRemoteRun 适配器");
  assert.ok(runtime.includes("deliverDrawRemote:"), "应注入异步出图投递回调 deliverDrawRemote");
  assert.ok(runtime.includes("recordTranscript: true"), "异步出图投递应同事务写入 fish.outbound transcript");
  assert.ok(runtime.includes("drawRemoteSignal: drawRemoteAbort.signal"), "应注入停机取消信号");
  assert.match(runtime, /export async function drainOnStop[\s\S]*?drawRemoteAbort\.abort\(\)[\s\S]*?fish\.drain\(\)/, "drainOnStop 必须在 fish.drain 与 closeOnebot 之前先中止后台 draw_remote");
  assert.ok(!/\bgptImage\b/.test(runtime), "runtime 不应再构造 gptImage 通道");
});

test("zero_egress_nudge 文案已在 messages.md 定义并接入 runtime.ts", () => {
  const prompts = loadPrompts(join(ROOT, "prompt"));
  assert.ok(prompts.messages["zero_egress_nudge"]?.includes("say_words"));

  const runtime = readFileSync(join(ROOT, "src/app/runtime.ts"), "utf8");
  assert.ok(runtime.includes("shouldNudgeZeroEgress("));
  assert.ok(runtime.includes('messages["zero_egress_nudge"]'));
});
