/**
 * 自由活动模式（engage.freeGroups）自检脚本——计划 docs/plans/2026-11-05-engage-free-mode.md 的 T8。
 *
 * 按终态 F1…F10 逐项断言并打印 PASS/FAIL，任一 FAIL 以非零码退出。
 * 只 import 纯模块（配置、状态机、模式判定、prompt 裁剪、渲染、config 工具的安全域纯函数）；
 * **不 import `src/app/runtime.ts`**——它在 import 期读 env 与模型配置，脚本起不来。
 *
 * 跑法：node scripts/verify-free-mode.ts
 */
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadFishConfig } from "../src/fish-config.ts";
import { createEngageNext, type EngageShardItem } from "../src/qq/engage-next.ts";
import { engageModeOf } from "../src/qq/engage-mode.ts";
import { runtimeTextOf } from "../src/qq/runtime-text.ts";
import { renderOpenMessageList, renderOpenQuotedText } from "../src/qq/round-input.ts";
import { fakeClock, localAt } from "./lib/fake-clock.ts";

const ROOT = join(import.meta.dirname, "..");
const GROUP = "qq:group:42";

let failures = 0;
function check(name: string, body: () => void | Promise<void>): Promise<void> {
  const done = (ok: boolean, error?: unknown): void => {
    if (ok) {
      console.log(`[${name}] PASS`);
      return;
    }
    failures += 1;
    console.error(`[${name}] FAIL ${error instanceof Error ? error.message : String(error)}`);
  };
  try {
    const result = body();
    if (result instanceof Promise) return result.then(() => done(true), (error: unknown) => done(false, error));
    done(true);
  } catch (error) {
    done(false, error);
  }
  return Promise.resolve();
}

/** 收集器里的一条（到达序 = seq，文本带序号便于断言顺序）。 */
function shardItem(seq: number): EngageShardItem {
  return { arrivalSeq: seq, messageId: 9000 + seq, userId: 1000 + seq, nickname: `甲${seq}`, text: `消息${seq}`, at: seq };
}

/** 自由模式的状态机壳：默认白天、无门、一拍 60 秒、上限 50。 */
function freeRig(options: {
  base?: number;
  busy?: () => boolean;
  yieldTo?: () => boolean;
  freeOf?: () => boolean;
  chance?: number;
  omitChance?: boolean;
  config?: () => Record<string, number>;
  random?: () => number;
  onShard?: (chatKey: string, items: readonly EngageShardItem[]) => void | Promise<void>;
} = {}) {
  const clock = fakeClock(options.base ?? localAt(10));
  const submits: { chatKey: string; items: readonly EngageShardItem[] }[] = [];
  const logs: string[] = [];
  const errors: string[] = [];
  const idles: { windowId: string; topic: string }[] = [];
  let randomCalls = 0;
  const engage = createEngageNext({
    groups: () => [GROUP],
    busy: options.busy ?? (() => false),
    ...(options.yieldTo !== undefined ? { yieldTo: options.yieldTo } : {}),
    onShard: (chatKey, items) => {
      submits.push({ chatKey, items });
      return options.onShard?.(chatKey, items);
    },
    onFreeIdle: (_chatKey, gate) => {
      idles.push(gate);
    },
    config: () =>
      options.config?.() ?? {
        freeSeconds: 60,
        ...(options.omitChance === true ? {} : { freeBrowseChance: options.chance ?? 0 }),
        freeBatchMax: 50,
      },
    now: clock.now,
    setTimer: clock.setTimer,
    clearTimer: clock.clearTimer,
    tickMs: 1_000,
    random: () => {
      randomCalls += 1;
      return options.random?.() ?? 0;
    },
    log: (message) => logs.push(message),
    onError: (error) => {
      errors.push(error instanceof Error ? error.message : String(error));
    },
  });
  return {
    engage,
    clock,
    submits,
    logs,
    idles,
    errors,
    randomCalls: () => randomCalls,
    /** 推进到「相位建立 + 一拍到期」：先跑 2 秒建相位，再跑一拍。 */
    beat(seconds = 60): void {
      clock.advance(2_000);
      clock.advance(seconds * 1_000);
    },
  };
}

/** F1：engage 四键的校验、默认值与默认数组不共享引用。 */
async function f1(): Promise<void> {
  const dir = mkdtempSync(join(tmpdir(), "yugang-free-"));
  const path = join(dir, "fish.config.json");
  const write = (value: unknown): void => writeFileSync(path, JSON.stringify(value));
  const load = () => loadFishConfig({ path });

  write({ engage: { freeSeconds: 30, freeBrowseChance: 0.5, freeBatchMax: 10, answerContextSize: 20 } });
  const valid = load();
  assert.equal(valid.config.engage.freeSeconds, 30);
  assert.equal(valid.config.engage.freeBrowseChance, 0.5);
  assert.equal(valid.config.engage.freeBatchMax, 10);
  assert.equal(valid.config.engage.answerContextSize, 20);

  write({ engage: { freeSeconds: 30 } });
  assert.equal(load().config.engage.answerContextSize, undefined, "answerContextSize 缺省不设（全量未读）");

  write({ engage: { answerContextSize: 0, freeSeconds: 30 } });
  const badCtx = load();
  assert.equal(badCtx.config.engage.answerContextSize, undefined, "越界 answerContextSize 回默认（不设）");
  assert.equal(badCtx.problems.filter((p) => p.includes("answerContextSize")).length, 1);

  write({ engage: { freeGroups: ["42"] } });
  assert.equal(load().problems.filter((p) => p.includes("freeGroups 不是受控字段")).length, 1, "freeGroups 已废弃必须告警");

  write({ engage: { freeSeconds: 5, freeBrowseChance: 2, freeBatchMax: 0 } });
  const allBad = load();
  assert.equal(allBad.problems.filter((p) => p.includes("至少要有一个合法参数")).length, 1, "全非法整块拒绝");

  write({ engage: { freeSeconds: 30, freeBrowseChance: 2, freeBatchMax: 0 } });
  const bad = load();
  assert.equal(bad.config.engage.freeSeconds, 30);
  assert.equal(bad.config.engage.freeBrowseChance, 0.03, "越界回默认");
  assert.equal(bad.config.engage.freeBatchMax, 50, "越界回默认");
  assert.equal(bad.problems.filter((p) => p.includes("已回默认")).length, 2, "每个非法键各一条告警");

  write({});
  const defaults = load();
  assert.equal(defaults.config.engage.freeSeconds, 60);
  assert.equal(defaults.config.engage.freeBrowseChance, 0.03);
  assert.equal(defaults.config.engage.freeBatchMax, 50);
  assert.equal(defaults.config.engage.answerContextSize, undefined);
}

/** F2：collectShard 懒建相位总是收；无 onPhase/silenceOf 兼容 API。 */
async function f2(): Promise<void> {
  const rig = freeRig();
  assert.equal(rig.engage.collectShard(GROUP, shardItem(1)), true, "相位没建也该收");
  assert.equal(typeof (rig.engage as { isOpen?: unknown }).isOpen, "undefined", "isOpen API 已随开窗模式退役");
  rig.engage.start();
  rig.clock.advance(300_000);
  assert.equal(rig.submits.length, 1, "收集器里的消息该被提交");
  rig.engage.stop();
}

/** F3：60 秒一拍合并、跨拍不合并、freeSeconds 热改下一拍生效、热加入白名单立刻接管。 */
async function f3(): Promise<void> {
  let freeSeconds = 60;
  const rig = freeRig({ config: () => ({ freeSeconds, freeBrowseChance: 0, freeBatchMax: 50 }) });
  rig.engage.start();
  rig.clock.advance(2_000);
  for (const seq of [1, 2, 3, 4, 5]) rig.engage.collectShard(GROUP, shardItem(seq));
  rig.clock.advance(60_000);
  assert.equal(rig.submits.length, 1);
  assert.deepEqual(rig.submits[0]?.items.map((m) => m.arrivalSeq), [1, 2, 3, 4, 5]);
  rig.engage.collectShard(GROUP, shardItem(6));
  rig.clock.advance(60_000);
  assert.equal(rig.submits.length, 2);
  assert.deepEqual(rig.submits[1]?.items.map((m) => m.arrivalSeq), [6]);
  freeSeconds = 15;
  rig.engage.collectShard(GROUP, shardItem(7));
  rig.clock.advance(15_000);
  assert.equal(rig.submits.length, 3, "热改后下一拍必须按新拍长触发");
  assert.deepEqual(rig.submits[2]?.items.map((m) => m.arrivalSeq), [7]);
  rig.engage.stop();
}

/** F4：自主门只在空拍掷、宵禁恒关、概率 0 恒关、有消息/忙时不掷。 */
async function f4(): Promise<void> {
  const open = freeRig({ chance: 1, random: () => 0 });
  open.engage.start();
  open.beat();
  assert.equal(open.idles.length, 1, "空拍 + 门开应回调一次");
  const gate = open.engage.videoBrowseGateOf(GROUP);
  assert.equal(gate?.open, true);
  assert.ok(gate?.windowId.startsWith("free-"), "windowId 必须是 free- 前缀");
  assert.ok((gate?.topic.length ?? 0) > 0);
  open.engage.stop();

  const closed = freeRig({ chance: 0, random: () => 0 });
  closed.engage.start();
  closed.beat();
  assert.equal(closed.idles.length, 0);
  assert.notEqual(closed.engage.videoBrowseGateOf(GROUP)?.open, true);
  closed.engage.stop();

  const curfew = freeRig({ base: localAt(3), chance: 1, random: () => 0 });
  curfew.engage.start();
  curfew.beat();
  assert.equal(curfew.idles.length, 0, "宵禁内不掷门不回调");
  assert.equal(curfew.randomCalls(), 0, "宵禁内不消耗随机数");
  assert.equal(curfew.engage.videoBrowseGateOf(GROUP), undefined);
  // 宵禁拍有消息也不提交（2026-11-06 合并：夜里不主动起 ambient 轮）
  curfew.engage.collectShard(GROUP, shardItem(1));
  curfew.clock.advance(60_000);
  assert.equal(curfew.submits.length, 0, "宵禁内不提交 ambient 拍");
  curfew.engage.stop();

  const withMessages = freeRig({ chance: 1, random: () => 0 });
  withMessages.engage.start();
  withMessages.clock.advance(2_000);
  withMessages.engage.collectShard(GROUP, shardItem(1));
  withMessages.clock.advance(60_000);
  assert.equal(withMessages.submits.length, 1);
  assert.equal(withMessages.idles.length, 0, "有消息的拍不掷门");
  assert.equal(withMessages.randomCalls(), 0);
  assert.equal(withMessages.engage.videoBrowseGateOf(GROUP), undefined);
  withMessages.engage.stop();

  const busy = freeRig({ chance: 1, busy: () => true, random: () => 0 });
  busy.engage.start();
  busy.beat();
  assert.equal(busy.idles.length, 0);
  assert.equal(busy.randomCalls(), 0, "忙时不掷门");
  busy.engage.stop();

  // 宿主没传 freeBrowseChance 时状态机必须按 0.03 兜底（不是恒关）
  const fallback = freeRig({ omitChance: true, random: () => 0 });
  fallback.engage.start();
  fallback.beat();
  assert.equal(fallback.idles.length, 1, "缺省概率必须是 0.03");
  fallback.engage.stop();
}

/** F5：开窗两态退役后的源码形态：无 onPhase/recentOf/backlogOf deps。 */
async function f5(): Promise<void> {
  const engage = readFileSync(join(ROOT, "src", "qq", "engage-next.ts"), "utf8");
  for (const gone of ["onPhase", "recentOf", "backlogOf", "enterClosed", "enterOpen", "scheduleShard", "handOffToWindow", "EngagePhase"]) {
    assert.ok(!engage.includes(gone), `engage-next.ts 不应再出现 ${gone}`);
  }
  assert.ok(engage.includes("freeBeat"), "freeBeat 是唯一拍驱动");
}

/** F6：背压不丢（忙时整拍顺延）、提交失败整拍回收、有 @ 组时让行。 */
async function f6(): Promise<void> {
  let busy = true;
  const rig = freeRig({ busy: () => busy });
  rig.engage.start();
  rig.clock.advance(2_000);
  rig.engage.collectShard(GROUP, shardItem(1));
  rig.engage.collectShard(GROUP, shardItem(2));
  rig.clock.advance(60_000);
  assert.equal(rig.submits.length, 0, "忙时不提交");
  rig.engage.collectShard(GROUP, shardItem(3));
  rig.clock.advance(60_000);
  assert.equal(rig.submits.length, 0);
  busy = false;
  rig.clock.advance(60_000);
  assert.equal(rig.submits.length, 1);
  assert.deepEqual(rig.submits[0]?.items.map((m) => m.arrivalSeq), [1, 2, 3]);
  rig.engage.stop();

  let rejectOnce = true;
  const recycling = freeRig({
    onShard: () => {
      if (rejectOnce) {
        rejectOnce = false;
        return Promise.reject(new Error("boom"));
      }
      return undefined;
    },
  });
  recycling.engage.start();
  recycling.clock.advance(2_000);
  recycling.engage.collectShard(GROUP, shardItem(1));
  recycling.clock.advance(60_000);
  await Promise.resolve();
  recycling.clock.advance(60_000);
  assert.equal(recycling.submits.length, 2, "失败那拍要被回收重提");
  assert.deepEqual(recycling.submits[1]?.items.map((m) => m.arrivalSeq), [1]);
  recycling.engage.stop();

  let yieldNow = true;
  const yielding = freeRig({ yieldTo: () => yieldNow });
  yielding.engage.start();
  yielding.clock.advance(2_000);
  yielding.engage.collectShard(GROUP, shardItem(1));
  yielding.clock.advance(60_000);
  assert.equal(yielding.submits.length, 0, "有 pending @ 组时让行");
  yieldNow = false;
  yielding.clock.advance(60_000);
  assert.equal(yielding.submits.length, 1);
  assert.deepEqual(yielding.submits[0]?.items.map((m) => m.arrivalSeq), [1]);
  yielding.engage.stop();
}

/** F7：单拍超限丢最旧、只提交最近 N 条并留丢弃条数日志。 */
async function f7(): Promise<void> {
  const rig = freeRig();
  rig.engage.start();
  rig.clock.advance(2_000);
  for (let seq = 1; seq <= 200; seq += 1) rig.engage.collectShard(GROUP, shardItem(seq));
  rig.clock.advance(60_000);
  assert.equal(rig.submits.length, 1);
  assert.equal(rig.submits[0]?.items.length, 50);
  assert.equal(rig.submits[0]?.items[0]?.arrivalSeq, 151, "留下的必须是最新 50 条");
  assert.equal(rig.submits[0]?.items[49]?.arrivalSeq, 200);
  assert.ok(rig.logs.some((line) => line.includes("超限丢弃 150 条")), "丢弃条数必须进日志");
  rig.engage.stop();
}

/** F8：runtime 文案按模式分流，且 prompt 里确实有这一段。 */
async function f8(): Promise<void> {
  const base = "前言\n\n自由活动群：B\n\n结尾";
  const free = runtimeTextOf(base, "free");
  assert.ok(free.includes("自由活动群"), "free 保留自由活动段");
  const legacy = runtimeTextOf(base, "legacy");
  assert.ok(!legacy.includes("自由活动群"), "legacy 裁掉自由活动段");
  const prompt = readFileSync(join(ROOT, "prompt", "runtime.md"), "utf8");
  assert.ok(prompt.split("\n").some((line) => line.startsWith("自由活动群")), "prompt/runtime.md 缺少自由活动群段");
}

/** F9：模式判定（free|legacy）与 runtime 接线形态。 */
async function f9(): Promise<void> {
  assert.equal(engageModeOf("qq:group:42", ["42"]), "free");
  assert.equal(engageModeOf("qq:group:7", ["42"]), "legacy", "域外群号 legacy");
  assert.equal(engageModeOf("qq:private:1", ["42"]), "legacy");
  const runtime = readFileSync(join(ROOT, "src", "app", "runtime.ts"), "utf8");
  assert.ok(runtime.includes("engageGroupsIncludes(config.groups, chatKey)"), "在途登记仍由 engageNextOf（只查 GROUPS）决定");
  assert.ok(runtime.includes("engagementOf: (chatKey: string) => engageModeOf("), "engagementOf 必须走 engageModeOf");
  const tool = readFileSync(join(ROOT, "src", "tools", "config", "tool.ts"), "utf8");
  assert.ok(!tool.includes("freeGroupsOutsideEnv"), "freeGroups 安全域闸已随字段退役删除");
}

/** F10：批内回复关系渲染（[回复了m:id] + 列表后 [引用原文]，批内图仍是 inbound 路径）。 */
async function f10(): Promise<void> {
  const messages: Record<string, string> = {};
  const list = renderOpenMessageList(
    [
      { messageId: 1, userId: 1, nickname: "甲", text: "在回你", replyIds: ["100"] },
      { messageId: 2, userId: 2, nickname: "乙", text: "[图片 inbound/x.png]" },
    ],
    messages,
    () => false,
    () => false,
  );
  assert.ok(list.includes("[回复了m:100]"), "批内回复关系要渲染");
  assert.ok(list.includes("[图片 inbound/x.png]"), "批内图保持 inbound 路径");
  assert.ok(!list.includes("[引用原文]"), "引用原文是列表后的附加段");
  const quoted = renderOpenQuotedText(
    [
      { messageId: 1, userId: 1, nickname: "甲", text: "在回你", quoted: { id: "100", nickname: "丙", userId: "3", text: "原文内容", images: [] } },
      { messageId: 2, userId: 2, nickname: "乙", text: "又引一次", quoted: { id: "100", nickname: "丙", userId: "3", text: "原文内容", images: [] } },
    ],
    messages,
  );
  assert.ok(quoted.includes("[引用原文][m:100]"));
  assert.ok(quoted.includes("原文内容"));
  assert.equal(quoted.split("[引用原文]").length - 1, 1, "同一被引消息只渲染一次");
  const plain = renderOpenQuotedText([{ messageId: 3, userId: 3, nickname: "丁", text: "没引用" }], messages);
  assert.equal(plain, "");
}

async function main(): Promise<void> {
  await check("F1", f1);
  await check("F2", f2);
  await check("F3", f3);
  await check("F4", f4);
  await check("F5", f5);
  await check("F6", f6);
  await check("F7", f7);
  await check("F8", f8);
  await check("F9", f9);
  await check("F10", f10);
  if (failures > 0) {
    console.error(`自由活动模式自检失败：${failures} 项`);
    process.exitCode = 1;
    return;
  }
  console.log("自由活动模式自检全部通过");
}

await main();
