/**
 * 自由活动模式时序测试（2026-11-06 合并：docs/plans/2026-11-06-engage-merge-free-only.md F5）。
 *
 * 状态机层用 fakeClock 驱动真实 createEngageNext；flag（lastSeenByModel）推进语义在
 * runtime.ts 私有（import 期读 env/模型配置，测试起不来），按 verify-free-mode 的先例
 * 用源码形态断言钉住接线。
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { createEngageNext, type EngageShardItem } from "../src/qq/engage-next.ts";
import { fakeClock, localAt } from "../scripts/lib/fake-clock.ts";

const ROOT = fileURLToPath(new URL("..", import.meta.url));
const GROUP = "qq:group:42";

function shardItem(seq: number): EngageShardItem {
  return { arrivalSeq: seq, messageId: 9000 + seq, userId: 1000 + seq, nickname: `甲${seq}`, text: `消息${seq}`, at: seq };
}

interface Rig {
  engage: ReturnType<typeof createEngageNext>;
  clock: ReturnType<typeof fakeClock>;
  submits: { chatKey: string; items: readonly EngageShardItem[] }[];
  stop(): void;
}

function rig(options: { base?: number; busy?: () => boolean; yieldTo?: () => boolean } = {}): Rig {
  const clock = fakeClock(options.base ?? localAt(10));
  const submits: { chatKey: string; items: readonly EngageShardItem[] }[] = [];
  const engage = createEngageNext({
    groups: () => [GROUP],
    busy: options.busy ?? (() => false),
    ...(options.yieldTo !== undefined ? { yieldTo: options.yieldTo } : {}),
    onShard: (chatKey, items) => {
      submits.push({ chatKey, items });
    },
    config: () => ({ freeSeconds: 60, freeBrowseChance: 0, freeBatchMax: 50 }),
    now: clock.now,
    setTimer: clock.setTimer,
    clearTimer: clock.clearTimer,
    tickMs: 1_000,
    random: () => 0.9,
  });
  engage.start();
  return {
    engage,
    clock,
    submits,
    stop: () => engage.stop(),
  };
}

test("自由拍：到期一次性提交收集器全部消息，保到达序", () => {
  const r = rig();
  r.clock.advance(2_000);
  for (const seq of [1, 2, 3]) r.engage.collectShard(GROUP, shardItem(seq));
  r.clock.advance(60_000);
  assert.equal(r.submits.length, 1);
  assert.deepEqual(r.submits[0]?.items.map((m) => m.arrivalSeq), [1, 2, 3]);
  r.stop();
});

test("宵禁拍：有消息也不提交，消息保留到白天第一拍（2026-11-06 合并语义）", () => {
  // 凌晨 3 点起跑
  const r = rig({ base: localAt(3) });
  r.clock.advance(2_000);
  r.engage.collectShard(GROUP, shardItem(1));
  r.engage.collectShard(GROUP, shardItem(2));
  r.clock.advance(60_000);
  assert.equal(r.submits.length, 0, "宵禁内不提交 ambient 拍");
  // 推进到早上 8 点后（localAt(3) + 5h = 8 点）
  r.clock.advance(5 * 3_600_000 - 62_000);
  r.clock.advance(60_000);
  assert.equal(r.submits.length, 1, "白天第一拍要把夜里攒的消息提交");
  assert.deepEqual(r.submits[0]?.items.map((m) => m.arrivalSeq), [1, 2], "夜里保留的消息不能丢");
  r.stop();
});

test("flag 推满：answer 与 ambient 轮都推进到 recent 末条（源码形态断言）", () => {
  const runtime = readFileSync(`${ROOT}src/app/runtime.ts`, "utf8");
  // flushBurst（answer 轮）：burst 本体 + recent 末条一起取 max
  assert.ok(
    runtime.includes("advanceSeenSeq(conv.id, maxArrivalSeq([...burst.messages, ...latest]))"),
    "answer 轮必须无条件推满到 recent 末条",
  );
  // submitShardRound（ambient 轮）：fresh + recent 末条一起取 max
  assert.ok(
    runtime.includes("advanceSeenSeq(conv.id, maxArrivalSeq([...fresh, ...latestItems]))"),
    "ambient 轮必须无条件推满到 recent 末条",
  );
});

test("纯输出任务轮（browse/remind/news）不推进 flag（源码形态断言）", () => {
  const runtime = readFileSync(`${ROOT}src/app/runtime.ts`, "utf8");
  const submitBrowse = runtime.indexOf("async function submitBrowseOpportunity");
  const submitBrowseEnd = runtime.indexOf("}", runtime.indexOf("await submitRound", submitBrowse));
  const browseBody = runtime.slice(submitBrowse, submitBrowseEnd);
  assert.ok(submitBrowse > 0, "submitBrowseOpportunity 必须存在");
  assert.ok(!browseBody.includes("advanceSeenSeq"), "自主轮不注入群消息，不得推 flag");
});

test("@ 轮背景两态：answerContextSize 缺省全量、设了截最近 N（backgroundFor 纯函数）", async () => {
  const { backgroundFor } = await import("../src/qq/debounce.ts");
  const bucket = Array.from({ length: 30 }, (_, index) => ({
    arrivalSeq: index + 1,
    userId: 100 + index,
    nickname: `u${index}`,
    text: `t${index + 1}`,
    at: 0,
  }));
  const anchor = {
    chatKey: "qq:group:42",
    userId: 7,
    nickname: "甲",
    text: "锚点",
    mentionsBot: true,
    messageId: 20,
    arrivalSeq: 20,
    images: [],
    imageSegments: [],
    replyIds: [],
    at: 0,
  };
  const burst = [
    { userId: 7, nickname: "甲", text: "锚点", at: 0, mentionsBot: true, replyIds: [], messageId: 20, arrivalSeq: 20 },
  ];
  const full = backgroundFor(anchor as never, bucket, burst);
  assert.equal(full.length, 19, "缺省全量（锚点前 19 条，seq 1-19 减 burst 内 1 条）");
  const capped = backgroundFor(anchor as never, bucket, burst, 5);
  assert.deepEqual(capped.map((line) => line.text), ["t15", "t16", "t17", "t18", "t19"], "设了 N=5 取最近 5 条");
});
