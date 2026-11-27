import test from "node:test";
import assert from "node:assert/strict";
import { createScheduler, JOBS_TTL_DAYS } from "../src/external/scheduler.ts";
import { newsScheduledStartAt } from "../src/external/news-job.ts";

class FakeClock {
  nowMs: number;
  seq = 0;
  timers = new Map<number, { at: number; cb: () => void }>();

  constructor(iso: string) {
    this.nowMs = new Date(iso).getTime();
  }

  now = (): Date => new Date(this.nowMs);
  setTimer = (cb: () => void, ms: number): unknown => {
    const id = ++this.seq;
    this.timers.set(id, { at: this.nowMs + Math.max(0, ms), cb });
    return id;
  };
  clearTimer = (handle: unknown): void => {
    this.timers.delete(handle as number);
  };
  async advanceTo(iso: string): Promise<void> {
    const target = new Date(iso).getTime();
    for (;;) {
      const next = [...this.timers.entries()]
        .filter(([, t]) => t.at <= target)
        .sort((a, b) => a[1].at - b[1].at || a[0] - b[0])[0];
      if (!next) break;
      this.timers.delete(next[0]);
      this.nowMs = Math.max(this.nowMs, next[1].at);
      next[1].cb();
      for (let i = 0; i < 12; i++) await Promise.resolve();
    }
    this.nowMs = target;
    for (let i = 0; i < 12; i++) await Promise.resolve();
  }
}

test("scheduler：无 deps.jobs 时按 JOBS_TTL_DAYS 裁剪 memory 账本", async () => {
  const clock = new FakeClock("2026-11-01T10:00:00");
  const runs: string[] = [];
  let lastTickCb: (() => void) | undefined;
  const scheduler = createScheduler({
    slots: () => ["10:00"],
    onJob: async (_slot, date) => { runs.push(date); },
    now: clock.now,
    setTimer: (cb, ms) => {
      lastTickCb = cb;
      return clock.setTimer(cb, ms);
    },
    clearTimer: clock.clearTimer,
    jobTimeoutMs: () => 60_000,
  });
  scheduler.start();
  await clock.advanceTo("2026-11-01T10:01:00");
  assert.deepEqual(runs, ["2026-11-01"]);

  // 推进超过 JOBS_TTL_DAYS（8 天）后再次写入：旧条目应被裁剪
  await clock.advanceTo("2026-11-12T10:01:00");
  assert.ok(runs.includes("2026-11-12"));
  assert.equal(JOBS_TTL_DAYS, 8);

  // 把时钟拨回第 1 天并触发一轮 cycle()：第 1 天账本已被裁剪，因此会再次执行；第 11 天仍在 TTL 内，不会重复执行
  const countBefore = runs.length;
  clock.nowMs = new Date("2026-11-01T10:01:00").getTime();
  lastTickCb!();
  for (let i = 0; i < 12; i++) await Promise.resolve();
  assert.equal(runs.length, countBefore + 1, "超过 JOBS_TTL_DAYS 的 memory 记录应已被裁剪");
  scheduler.stop();
});

test("scheduler：stop() 后已排队的 cycle() 回调直接返回不再触发", async () => {
  const clock = new FakeClock("2026-11-01T09:59:50");
  const fired: string[] = [];
  let leakedCb: (() => void) | undefined;
  const scheduler = createScheduler({
    slots: () => ["10:00"],
    onJob: async (slot, date) => { fired.push(`${date} ${slot}`); },
    now: clock.now,
    setTimer: (cb, ms) => {
      leakedCb = cb;
      return clock.setTimer(cb, ms);
    },
    clearTimer: clock.clearTimer,
    jobTimeoutMs: () => 60_000,
  });
  scheduler.start();
  for (let i = 0; i < 6; i++) await Promise.resolve();
  assert.ok(leakedCb !== undefined);

  scheduler.stop();
  // 模拟定时器在 stop 前一刻已入微任务队列仍触发
  clock.nowMs = new Date("2026-11-01T10:00:05").getTime();
  leakedCb!();
  for (let i = 0; i < 6; i++) await Promise.resolve();
  assert.deepEqual(fired, [], "stop() 后 cycle() 应直接返回");
});

test('scheduler："24:00" 归一为次日 00:00，与 newsScheduledStartAt 一致且不在当天 00:00 误触', async () => {
  const clock = new FakeClock("2026-11-28T00:05:00");
  const fired: { slot: string; date: string; firedAt: number }[] = [];
  const scheduler = createScheduler({
    slots: () => ["24:00"],
    onJob: async (slot, date) => { fired.push({ slot, date, firedAt: clock.nowMs }); },
    now: clock.now,
    setTimer: clock.setTimer,
    clearTimer: clock.clearTimer,
    jobTimeoutMs: () => 60_000,
  });
  scheduler.start();
  // 刚启动在 2026-11-28 00:05:00（昨天 2026-11-27 24:00 = 今天 00:00 在补跑窗内）
  await clock.advanceTo("2026-11-28T23:59:00");
  // 次日 00:00（2026-11-29 00:00:00）触发 2026-11-28 的 24:00
  await clock.advanceTo("2026-11-29T00:00:05");
  scheduler.stop();

  const nov28Fire = fired.find((f) => f.date === "2026-11-28");
  assert.ok(nov28Fire !== undefined, "2026-11-28 24:00 应在 2026-11-29 00:00 触发");
  assert.equal(nov28Fire.firedAt, newsScheduledStartAt("2026-11-28", "24:00", clock.nowMs));
  assert.equal(fired.some((f) => f.date === "2026-11-28" && f.firedAt < new Date("2026-11-29T00:00:00").getTime()), false);
});
