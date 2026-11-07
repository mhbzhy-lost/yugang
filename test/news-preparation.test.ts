import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { buildNewsCandidateInput, renderNewsBroadcast, validateNewsDigest } from "../src/external/news-broadcast.ts";
import { createNewsFreeze, NewsFrozenError, splitNewsBurst } from "../src/external/news-freeze.ts";
import { createNewsJob, newsScheduledStartAt, type NewsJobDeps } from "../src/external/news-job.ts";
import {
  NEWS_MAX_ATTEMPTS,
  NEWS_RECOVERY_WINDOW_MS,
  newsOutboxKeyOf,
  newsRunKeyOf,
  type NewsFailStatus,
  type NewsPrepareStatus,
  type NewsPublishStatus,
  type NewsRunRecord,
  type NewsRunStore,
} from "../src/external/news-runs.ts";
import type { NewsTopicFeed } from "../src/external/news-client.ts";
import { loadFishConfig } from "../src/fish-config.ts";
import { createSession, MemoryStorage } from "@earendil-works/pi-durable";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { createNewsRunStore } from "../src/external/news-runs.ts";

const DAY = "2026-11-07";
const GROUP = "10001";
const CHAT = `qq:group:${GROUP}`;
const RUN_ID = newsRunKeyOf(DAY, GROUP);
const START = newsScheduledStartAt(DAY, "10:30", Date.now());
const PUBLISH = START + 10 * 60_000;
const FEEDS: NewsTopicFeed[] = [{
  topic: "AI",
  items: [{ title: "虚构模型发布", url: "https://example.com/ai", source: "ithome", publishedAt: "2026-11-07T00:00:00Z" }],
}];

interface Box { key: string; status: "queued" | "sending"; at: number }

class MemoryRuns implements NewsRunStore {
  runs = new Map<string, NewsRunRecord>();
  boxes = new Map<string, Box[]>();
  beforePublish?: () => void;
  afterPublish?: () => void;
  readHook?: () => Promise<void>;

  async read(day: string, group: string) {
    await this.readHook?.();
    const run = this.runs.get(newsRunKeyOf(day, group));
    return run ? structuredClone(run) : undefined;
  }
  async list() { return [...this.runs.values()].map((run) => structuredClone(run)); }
  async create(run: NewsRunRecord) {
    const key = newsRunKeyOf(run.localDay, run.targetGroup);
    if (this.runs.has(key)) return false;
    this.runs.set(key, structuredClone(run));
    return true;
  }
  async claim(day: string, group: string, now: number) {
    const run = this.runs.get(newsRunKeyOf(day, group));
    if (!run || run.state !== "preparing" || run.publishAt === undefined || run.attempts === undefined) return undefined;
    if (run.attempts >= NEWS_MAX_ATTEMPTS || now >= run.publishAt) return undefined;
    run.attempts++;
    return structuredClone(run);
  }
  async prepare(input: { day: string; group: string; attempt: number; conversationId: string; now: number; broadcast: { text: string; links: string[] } }): Promise<NewsPrepareStatus> {
    const run = this.runs.get(newsRunKeyOf(input.day, input.group));
    if (!run || run.state === "done" || run.state === "failed") return "terminal";
    if (run.state === "prepared" || run.attempts !== input.attempt || run.conversationId !== input.conversationId) return "stale";
    if (run.state !== "preparing") return "terminal";
    if (run.publishAt !== undefined && input.now >= run.publishAt) return "expired";
    run.state = "prepared";
    run.preparedAt = input.now;
    run.broadcast = structuredClone(input.broadcast);
    return "prepared";
  }
  async fail(day: string, group: string, reason: string, now: number): Promise<NewsFailStatus> {
    const run = this.runs.get(newsRunKeyOf(day, group));
    if (!run) return "stale";
    if (run.state === "prepared") return "prepared";
    if (run.state === "done") return "done";
    if (run.state !== "preparing" && run.state !== "running") return "stale";
    run.state = "failed";
    run.error = reason;
    run.finishedAt = now;
    return "failed";
  }
  async miss(day: string, group: string, now: number): Promise<NewsFailStatus> {
    const run = this.runs.get(newsRunKeyOf(day, group));
    if (!run || run.state !== "prepared" || run.publishAt === undefined) return "stale";
    if (now - run.publishAt <= NEWS_RECOVERY_WINDOW_MS) return "prepared";
    run.state = "failed";
    run.error = "missed_window";
    run.finishedAt = now;
    return "failed";
  }
  async publish(day: string, group: string, now: number): Promise<NewsPublishStatus> {
    this.beforePublish?.();
    const run = this.runs.get(newsRunKeyOf(day, group));
    if (!run) return "missing";
    if (run.state === "done") return "already_done";
    if (run.state !== "prepared" || !run.broadcast || !run.conversationId) return "not_prepared";
    const box = this.boxes.get(run.conversationId) ?? [];
    this.boxes.set(run.conversationId, box);
    const key = newsOutboxKeyOf(day, group);
    if (!box.some((item) => item.key === key)) box.push({ key, status: "queued", at: now });
    run.state = "done";
    run.finishedAt = now;
    this.afterPublish?.();
    return "done";
  }
}

class Clock {
  now = START;
  seq = 0;
  timers = new Map<number, { at: number; callback: () => void }>();
  setTimer = (callback: () => void, ms: number): unknown => {
    const id = ++this.seq;
    this.timers.set(id, { at: this.now + Math.max(0, ms), callback });
    return id;
  };
  clearTimer = (handle: unknown): void => { this.timers.delete(handle as number); };
  async advanceTo(at: number): Promise<void> {
    for (;;) {
      const due = [...this.timers.entries()]
        .filter(([, timer]) => timer.at <= at)
        .sort((a, b) => a[1].at - b[1].at || a[0] - b[0])[0];
      if (!due) break;
      this.timers.delete(due[0]);
      this.now = Math.max(this.now, due[1].at);
      due[1].callback();
      await flush();
    }
    this.now = at;
    await flush();
  }
}

async function flush(): Promise<void> {
  for (let index = 0; index < 12; index++) await Promise.resolve();
}

function runRecord(state: "preparing" | "prepared" = "preparing"): NewsRunRecord {
  return {
    localDay: DAY,
    targetGroup: GROUP,
    state,
    scheduledStartAt: START,
    startedAt: START,
    publishAt: PUBLISH,
    attempts: state === "prepared" ? 1 : 0,
    conversationId: "7",
    effectivePersona: "人格A",
    mappingKey: `${CHAT}#人格A`,
    ...(state === "prepared" ? { broadcast: { text: "虚构新闻 https://example.com/ai", links: ["https://example.com/ai"] } } : {}),
  };
}

function fixture(options: {
  store?: MemoryRuns;
  clock?: Clock;
  submit?: NewsJobDeps["submit"];
  collect?: NewsJobDeps["collect"];
  waitIdle?: NewsJobDeps["waitIdle"];
  drain?: NewsJobDeps["drain"];
} = {}) {
  const store = options.store ?? new MemoryRuns();
  const clock = options.clock ?? new Clock();
  const freeze = createNewsFreeze(() => clock.now);
  const candidates = new Map<string, unknown>();
  const calls = { submit: 0, collect: 0, abort: 0, drain: 0, compact: 0 };
  const logs: string[] = [];
  const deps: NewsJobDeps = {
    store,
    now: () => clock.now,
    collect: options.collect ?? (async () => { calls.collect++; return structuredClone(FEEDS); }),
    candidates: buildNewsCandidateInput,
    bind: async () => ({ conversationId: "7", effectivePersona: "人格A", mappingKey: `${CHAT}#人格A` }),
    bindExisting: async (run) => ({
      conversationId: run.conversationId!,
      effectivePersona: run.effectivePersona!,
      mappingKey: run.mappingKey!,
    }),
    freeze: (chatKey, run) => freeze.freeze(chatKey, {
      runId: newsRunKeyOf(run.localDay, run.targetGroup),
      conversationId: run.conversationId!,
      attempt: run.attempts!,
      publishAt: run.publishAt!,
    }),
    attempt: freeze.attempt,
    expire: freeze.expire,
    unfreeze: freeze.unfreeze,
    setCandidates: (key, value) => { if (value) candidates.set(key, value); else candidates.delete(key); },
    submit: options.submit ?? (async ({ run, attempt }) => {
      calls.submit++;
      await store.prepare({
        day: run.localDay,
        group: run.targetGroup,
        attempt,
        conversationId: run.conversationId!,
        now: clock.now,
        broadcast: { text: "虚构新闻 https://example.com/ai", links: ["https://example.com/ai"] },
      });
      return "done";
    }),
    waitIdle: options.waitIdle ?? (async () => true),
    abort: async () => { calls.abort++; },
    drain: options.drain ?? (async () => { calls.drain++; return 0; }),
    outbox: async (conversationId, key) => store.boxes.get(conversationId)?.find((item) => item.key === key)?.status ?? "absent",
    log: (message) => logs.push(message),
    setTimer: clock.setTimer,
    clearTimer: clock.clearTimer,
  };
  return { store, clock, freeze, candidates, calls, logs, deps, job: createNewsJob(deps) };
}

test("R1 冻结与 ambient 竞态由最终闸拒绝并整拍回收", async () => {
  const freeze = createNewsFreeze(() => START);
  freeze.freeze(CHAT, { runId: RUN_ID, conversationId: "7", attempt: 1, publishAt: PUBLISH });
  assert.throws(() => freeze.assert(CHAT, "7", { kind: "ambient", mentionsBot: false }), NewsFrozenError);
  const batch = [{ id: 1 }, { id: 2 }];
  const recycled: number[] = [];
  try {
    freeze.assert(CHAT, "7", { kind: "ambient", mentionsBot: false });
  } catch (error) {
    assert.ok(error instanceof NewsFrozenError);
    recycled.push(...batch.map((item) => item.id));
  }
  assert.deepEqual(recycled, [1, 2]);
  freeze.attempt(CHAT, RUN_ID, 1);
  assert.doesNotThrow(() => freeze.assert(CHAT, "7", {
    kind: "news", mentionsBot: false, newsRunId: RUN_ID, newsAttempt: 1,
  }));
});

test("R2 混合 burst 拆成 @ 机械接待与非 @ 回收", () => {
  const split = splitNewsBurst([
    { id: 1, mentionsBot: true },
    { id: 2, mentionsBot: false },
    { id: 3, mentionsBot: true },
    { id: 4, mentionsBot: false },
  ]);
  assert.deepEqual(split.mentions.map((item) => item.id), [1, 3]);
  assert.deepEqual(split.nonMentions.map((item) => item.id), [2, 4]);
});

test("R3 取料越过 deadline 后不得起模型，超时解冻并落账", async () => {
  let release!: (feeds: NewsTopicFeed[]) => void;
  const pending = new Promise<NewsTopicFeed[]>((resolve) => { release = resolve; });
  const f = fixture({ collect: () => pending });
  const starting = f.job.start("10:30", DAY, CHAT, 10);
  await flush();
  await f.clock.advanceTo(PUBLISH);
  release(FEEDS);
  await starting;
  assert.equal(f.calls.submit, 0);
  assert.equal((await f.store.read(DAY, GROUP))?.error, "news_timeout");
  assert.equal(f.freeze.has(CHAT), false);
});

test("R4 第 4 次失败与成功并发只有一个终局，旧 attempt 不能覆盖", async () => {
  const f = fixture({ submit: async ({ run, attempt }) => {
    f.calls.submit++;
    if (attempt < NEWS_MAX_ATTEMPTS) return "done";
    const [prepared, failed] = await Promise.all([
      f.store.prepare({ day: DAY, group: GROUP, attempt, conversationId: "7", now: f.clock.now, broadcast: { text: "ok", links: ["https://example.com/ai"] } }),
      f.store.fail(DAY, GROUP, "attempts_exhausted", f.clock.now),
    ]);
    assert.equal(prepared, "prepared");
    assert.equal(failed, "prepared");
    assert.equal(await f.store.prepare({ day: DAY, group: GROUP, attempt: attempt - 1, conversationId: "7", now: f.clock.now, broadcast: { text: "stale", links: ["x"] } }), "stale");
    return "done";
  } });
  await f.job.start("10:30", DAY, CHAT, 10);
  assert.equal(f.calls.submit, NEWS_MAX_ATTEMPTS);
  assert.equal((await f.store.read(DAY, GROUP))?.state, "prepared");
  await f.clock.advanceTo(PUBLISH);
  assert.equal((await f.store.read(DAY, GROUP))?.state, "done");
});

test("R4 durable prepare 在 commit 内重取时间，截止后不能 prepared", async () => {
  let now = PUBLISH - 1;
  const session = createSession(new MemoryStorage());
  const store = createNewsRunStore(session, BACKGROUND_CONTEXT, () => now);
  await store.create(runRecord());
  await store.claim(DAY, GROUP, now);
  const input = {
    day: DAY,
    group: GROUP,
    attempt: 1,
    conversationId: "7",
    now,
    broadcast: { text: "过截止的成品", links: ["https://example.com/ai"] },
  };
  now = PUBLISH;
  assert.equal(await store.prepare(input), "expired");
  assert.equal((await store.read(DAY, GROUP))?.state, "preparing");
});

test("R5 prepared 与 timeout failed 并发时仍转发布", async () => {
  const store = new MemoryRuns();
  store.runs.set(RUN_ID, runRecord("prepared"));
  assert.equal(await store.fail(DAY, GROUP, "news_timeout", PUBLISH), "prepared");
  assert.equal(await store.publish(DAY, GROUP, PUBLISH), "done");
  assert.equal(store.boxes.get("7")?.length, 1);
});

test("R6 publish 与 recover 并发只入队一次", async () => {
  const store = new MemoryRuns();
  store.runs.set(RUN_ID, runRecord("prepared"));
  const f = fixture({ store });
  let concurrentRecovery: Promise<void> | undefined;
  store.beforePublish = () => {
    concurrentRecovery = f.job.recover((group) => `qq:group:${group}`);
  };
  await f.clock.advanceTo(PUBLISH);
  await f.job.recover((group) => `qq:group:${group}`);
  await concurrentRecovery;
  await f.job.recover((group) => `qq:group:${group}`);
  assert.equal(store.boxes.get("7")?.length, 1);
  assert.equal(f.calls.submit, 0);
});

test("R7 发布 commit 前后故障均可恢复且不重复入队", async () => {
  const store = new MemoryRuns();
  store.runs.set(RUN_ID, runRecord("prepared"));
  store.beforePublish = () => { throw new Error("before_commit"); };
  const first = fixture({ store });
  await first.job.recover((group) => `qq:group:${group}`);
  await first.clock.advanceTo(PUBLISH);
  assert.equal(store.boxes.size, 0);
  store.beforePublish = undefined;
  store.afterPublish = () => { throw new Error("after_commit"); };
  const second = fixture({ store });
  await second.job.recover((group) => `qq:group:${group}`);
  await second.clock.advanceTo(PUBLISH);
  await second.job.recover((group) => `qq:group:${group}`);
  assert.equal(store.boxes.get("7")?.length, 1);
});

test("R8 prepared 重启只发布；preparing 续剩余次数；陈旧成品不补发", async () => {
  const preparedStore = new MemoryRuns();
  preparedStore.runs.set(RUN_ID, runRecord("prepared"));
  const prepared = fixture({ store: preparedStore });
  await prepared.job.recover((group) => `qq:group:${group}`);
  await prepared.clock.advanceTo(PUBLISH);
  assert.equal(prepared.calls.submit, 0);
  assert.equal(preparedStore.boxes.get("7")?.length, 1);

  const preparingStore = new MemoryRuns();
  const preparingRun = runRecord();
  preparingRun.attempts = 2;
  preparingStore.runs.set(RUN_ID, preparingRun);
  const preparing = fixture({ store: preparingStore });
  await preparing.job.recover((group) => `qq:group:${group}`);
  assert.equal(preparing.calls.submit, 1);

  const staleStore = new MemoryRuns();
  staleStore.runs.set(RUN_ID, runRecord("prepared"));
  const stale = fixture({ store: staleStore });
  await stale.clock.advanceTo(PUBLISH + NEWS_RECOVERY_WINDOW_MS + 1);
  await stale.job.recover((group) => `qq:group:${group}`);
  assert.equal((await staleStore.read(DAY, GROUP))?.error, "missed_window");
  assert.equal(staleStore.boxes.size, 0);
});

test("R9 队首 sending 时新闻只排队，不跳过且冻结解除", async () => {
  const store = new MemoryRuns();
  store.runs.set(RUN_ID, runRecord("prepared"));
  store.boxes.set("7", [{ key: "old", status: "sending", at: START }]);
  const f = fixture({ store, drain: async () => 0 });
  await f.clock.advanceTo(PUBLISH);
  await f.job.recover((group) => `qq:group:${group}`);
  assert.deepEqual(store.boxes.get("7")?.map((item) => item.key), ["old", newsOutboxKeyOf(DAY, GROUP)]);
  assert.equal(store.boxes.get("7")?.[0]?.status, "sending");
  assert.equal(f.freeze.has(CHAT), false);
});

test("R10 冻结期切人格不改变 run 绑定，解冻后普通轮才走新会话", async () => {
  const f = fixture();
  await f.job.start("10:30", DAY, CHAT, 10);
  const run = await f.store.read(DAY, GROUP);
  assert.equal(run?.conversationId, "7");
  assert.equal(run?.effectivePersona, "人格A");
  assert.throws(() => f.freeze.assert(CHAT, "8", {
    kind: "news", mentionsBot: false, newsRunId: RUN_ID, newsAttempt: 1,
  }), NewsFrozenError);
  await f.clock.advanceTo(PUBLISH);
  assert.doesNotThrow(() => f.freeze.assert(CHAT, "8", { kind: "answer", mentionsBot: true }));
});

test("R11 新闻路径无 compact；其它群与私聊不受冻结影响", async () => {
  const f = fixture();
  await f.job.start("10:30", DAY, CHAT, 10);
  await f.clock.advanceTo(PUBLISH);
  const runtime = readFileSync(new URL("../src/app/runtime.ts", import.meta.url), "utf8");
  assert.ok(runtime.includes('if (roundKind === "news") return settled.status;'));
  assert.ok(runtime.includes('if (roundKind !== "news" && attempt === MAX_MODEL_ATTEMPTS'));
  assert.doesNotThrow(() => f.freeze.assert("qq:group:20002", "9", { kind: "ambient", mentionsBot: false }));
  assert.doesNotThrow(() => f.freeze.assert("qq:private:1", "10", { kind: "answer", mentionsBot: false }));
});

test("R12 存储悬挂时安全看门狗仍解冻且不伪造 durable 终态", async () => {
  const store = new MemoryRuns();
  let hang = false;
  store.readHook = async () => { if (hang) await new Promise<void>(() => {}); };
  const f = fixture({ store, submit: () => { f.calls.submit++; return new Promise<string>(() => {}); } });
  const starting = f.job.start("10:30", DAY, CHAT, 10);
  await flush();
  hang = true;
  await f.clock.advanceTo(PUBLISH + 5_000);
  assert.equal(f.freeze.has(CHAT), false);
  assert.equal(store.runs.get(RUN_ID)?.state, "preparing");
  await f.job.recover((group) => `qq:group:${group}`);
  assert.equal(f.calls.submit, 1, "看门狗只解冻，不释放执行权另起备料");
  void starting;
});

test("新闻配置与候选成品校验守住窗口合同", () => {
  const config = loadFishConfig().config.news;
  assert.equal(config.preparationMinutes, 10);
  const input = buildNewsCandidateInput(FEEDS);
  const valid = validateNewsDigest({
    sections: [{ topic: "AI", items: [{ summary: "模型发布新能力", sourceRef: "0" }] }],
    closing: "今天先聊这些",
  }, FEEDS, input, 5);
  assert.equal(valid.ok, true);
  if (valid.ok) {
    const rendered = renderNewsBroadcast(DAY, valid.digest, input.index, {
      news_header: "「{{date}} 新闻速递」",
      news_topic: "▸ {{topic}}",
      news_item: "· {{summary}}（{{source}}）{{url}}",
      news_closing: "——{{closing}}",
    });
    assert.ok(rendered.text.length <= 500);
    assert.deepEqual(rendered.links, ["https://example.com/ai"]);
  }
  assert.equal(validateNewsDigest({
    sections: [{ topic: "AI", items: [{ summary: "错 topic 引用", sourceRef: "1" }] }], closing: "",
  }, FEEDS, input, 5).ok, false);
});
