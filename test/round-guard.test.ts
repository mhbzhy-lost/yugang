import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { createInFlightTracker, shouldRetryRoundAttempt } from "../src/round-guard.ts";

test("shouldRetryRoundAttempt：已通过 say_* 开口的轮次遇到收尾 model_error 绝不重试", () => {
  assert.equal(
    shouldRetryRoundAttempt({ status: "unanswered", reason: "model_error", attempt: 1, maxAttempts: 3, sayCount: 0 }),
    true,
  );
  assert.equal(
    shouldRetryRoundAttempt({ status: "unanswered", reason: "model_error", attempt: 1, maxAttempts: 3, sayCount: 1 }),
    false,
    "已开口入队的尝试不能因为收尾流中断而重投整轮",
  );
  assert.equal(
    shouldRetryRoundAttempt({ status: "done", reason: undefined, attempt: 1, maxAttempts: 3, sayCount: 0 }),
    false,
  );
  assert.equal(
    shouldRetryRoundAttempt({ status: "unanswered", reason: "aborted", attempt: 1, maxAttempts: 3, sayCount: 0 }),
    false,
  );
  assert.equal(
    shouldRetryRoundAttempt({ status: "unanswered", reason: "model_error", attempt: 3, maxAttempts: 3, sayCount: 0 }),
    false,
  );
});

test("createInFlightTracker：支持引用计数，两个并发 answer 轮不会互相提前清掉 busy", () => {
  const tracker = createInFlightTracker();
  assert.equal(tracker.isBusy(100), false);
  assert.equal(tracker.hasAmbient(100), false);

  tracker.register(100, "answer");
  tracker.register(100, "answer");
  assert.equal(tracker.isBusy(100), true);
  assert.equal(tracker.hasAmbient(100), false);

  tracker.release(100, "answer");
  assert.equal(tracker.isBusy(100), true, "第二个 answer 仍在途时会话仍应为忙");

  tracker.release(100, "answer");
  assert.equal(tracker.isBusy(100), false);

  // 多余 release 幂等安全
  tracker.release(100, "answer");
  assert.equal(tracker.isBusy(100), false);
});

test("createInFlightTracker：ambient/injection 在途时阻塞 waitAmbientClear，清零即唤醒，超时返回 false", async () => {
  const tracker = createInFlightTracker();
  tracker.register(200, "ambient");
  tracker.register(200, "answer");
  assert.equal(tracker.hasAmbient(200), true);

  let woke = false;
  const waiting = tracker.waitAmbientClear(200, 1000).then((ok) => {
    woke = ok;
    return ok;
  });

  // 释放 answer 不应唤醒等待 ambient 的队列
  tracker.release(200, "answer");
  await new Promise((r) => setTimeout(r, 15));
  assert.equal(woke, false);

  // 释放 ambient 立即唤醒
  tracker.release(200, "ambient");
  assert.equal(await waiting, true);
  assert.equal(tracker.isBusy(200), false);

  // 超时路径返回 false
  tracker.register(201, "injection");
  assert.equal(await tracker.waitAmbientClear(201, 20), false);
  tracker.release(201, "injection");
});

test("runtime.ts 接线契约：submitRound 必须登记在途、已开口不重试且失败前有开口时冲刷 outbox", () => {
  const src = readFileSync(fileURLToPath(new URL("../src/app/runtime.ts", import.meta.url)), "utf8");
  const start = src.indexOf("export async function submitRound(");
  const end = src.indexOf("async function compactWithGuard(", start);
  assert.ok(start !== -1 && end > start);
  const body = src.slice(start, end);

  assert.match(body, /if\s*\(trackInFlight\)\s*\{[\s\S]*inFlight\.register\(conv\.id,\s*roundKind\)/, "submitRound 必须真实调用 inFlight.register");
  assert.match(body, /shouldRetryRoundAttempt\(/, "重试条件必须走 shouldRetryRoundAttempt（含 sayCount 门控）");
  assert.match(body, /totalSayCount\s*>\s*0[\s\S]*await drainLoop\(\)/, "已开口但收尾失败的轮次也必须 drainLoop 发出已入队回复");
});
