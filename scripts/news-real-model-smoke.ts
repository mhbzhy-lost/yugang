/** 新闻全管线真实模型 smoke：隔离 SQLite/凭据，真实 agent loop，虚构新闻源与记录出口。 */
import { appendFileSync, copyFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { randomUUID } from "node:crypto";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { UsageDoc, type Conversation } from "@earendil-works/pi-durable";
import { openNodeSqliteStorage } from "@earendil-works/pi-durable/storage/sqlite/node";
import { openFish, type Fish } from "../src/harness.ts";
import { loadFishModels, type FishModelConfig } from "../src/model/config.ts";
import { createFishModels } from "../src/model/models.ts";
import { createNewsClient, type NewsTopicFeed } from "../src/external/news-client.ts";
import { buildNewsCandidateInput, renderNewsBroadcast, validateNewsDigest, type NewsCandidateInput } from "../src/external/news-broadcast.ts";
import { createNewsFreeze, NewsFrozenError } from "../src/external/news-freeze.ts";
import { createNewsJob, newsScheduledStartAt, type NewsJob } from "../src/external/news-job.ts";
import { createNewsRunStore, newsOutboxKeyOf, newsRunKeyOf, type NewsRunStore } from "../src/external/news-runs.ts";
import { OutboxDoc } from "../src/store.ts";
import { renderTemplate } from "../src/prompt/index.ts";
import { resetLook, resetRun } from "../src/egress/ledger.ts";
import { absorbSecrets } from "../src/egress/absorb.ts";
import { sumUsage } from "../src/records/usage.ts";
import { renderMessageList } from "../src/channels/qq/model-input.ts";
import { createEngageNext } from "../src/qq/engage-next.ts";
import type { RoundTrigger } from "../src/tools/types.ts";

const REPO = fileURLToPath(new URL("../", import.meta.url));
const RUN_ID = `${Date.now().toString(36)}-${randomUUID().slice(0, 8)}`;
const ROOT = join(REPO, "var", "local-driver", `news-smoke-${RUN_ID}`);
const EVIDENCE = join(ROOT, "evidence.jsonl");
let scenarioHome = ROOT;
const DAY = "2026-11-07";
const GROUP = "900001";
const OTHER_GROUP = "900002";
const CHAT = `qq:group:${GROUP}`;
const RUN_KEY = newsRunKeyOf(DAY, GROUP);
const START = newsScheduledStartAt(DAY, "10:30", Date.now());
const PUBLISH = START + 60_000;
const ctx = BACKGROUND_CONTEXT;
const FEEDS: NewsTopicFeed[] = [{
  topic: "AI",
  items: [
    { title: "AI 虚构模型开放新能力", url: "https://example.com/ai-1", source: "60s", publishedAt: "2026-11-07T00:00:00Z" },
    { title: "AI 虚构芯片开始量产", url: "https://example.com/ai-2", source: "60s", publishedAt: "2026-11-07T00:01:00Z" },
    { title: "虚构社区发布机器人比赛", url: "https://example.com/ai-3", source: "60s", publishedAt: "2026-11-07T00:02:00Z" },
  ],
}];

mkdirSync(join(ROOT, "config"), { recursive: true });
mkdirSync(join(ROOT, "media"), { recursive: true });
mkdirSync(join(ROOT, "workspace"), { recursive: true });
const modelsPath = join(ROOT, "config", "models.json");
const authPath = join(ROOT, "config", "auth.json");
copyFileSync(join(REPO, "config", "models.json"), modelsPath);
if (existsSync(join(REPO, "config", "auth.json"))) copyFileSync(join(REPO, "config", "auth.json"), authPath);
const selection = loadFishModels({ modelsPath, credentialsPath: authPath });
const mainConfig = selection.main;
process.chdir(ROOT);

function evidence(value: Record<string, unknown>): void {
  const row = { at: new Date().toISOString(), ...value };
  appendFileSync(EVIDENCE, JSON.stringify(row) + "\n");
  console.log(JSON.stringify(row).slice(0, 700));
}

const originalFetch = globalThis.fetch;
let providerDelay: { started: Promise<void>; release: Promise<void>; mark: () => void; open: () => void } | undefined;
globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
  const response = await originalFetch(input, init);
  if (providerDelay && String(input instanceof Request ? input.url : input).includes(new URL(mainConfig.baseUrl).host)) {
    providerDelay.mark();
    await providerDelay.release;
  }
  return response;
}) as typeof fetch;

class Clock {
  now = START;
  private seq = 0;
  private timers = new Map<number, { at: number; callback: () => void }>();
  setTimer = (callback: () => void, ms: number): unknown => {
    const id = ++this.seq;
    this.timers.set(id, { at: this.now + Math.max(0, ms), callback });
    return id;
  };
  clearTimer = (handle: unknown): void => { this.timers.delete(handle as number); };
  async advanceTo(at: number): Promise<void> {
    for (;;) {
      const next = [...this.timers.entries()].filter(([, timer]) => timer.at <= at)
        .sort((a, b) => a[1].at - b[1].at || a[0] - b[0])[0];
      if (!next) break;
      this.timers.delete(next[0]);
      this.now = Math.max(this.now, next[1].at);
      next[1].callback();
      await flush();
    }
    this.now = at;
    await flush();
  }
}

async function flush(): Promise<void> {
  for (let index = 0; index < 16; index++) await Promise.resolve();
}

async function waitFor(check: () => Promise<boolean>, timeoutMs = 10_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    if (await check()) return;
    if (Date.now() >= deadline) throw new Error("wait_for_timeout");
    await new Promise<void>((resolve) => setTimeout(resolve, 10));
  }
}

function deepToolCalls(node: unknown, out: string[]): void {
  if (Array.isArray(node)) {
    for (const item of node) deepToolCalls(item, out);
    return;
  }
  if (!node || typeof node !== "object") return;
  const record = node as Record<string, unknown>;
  if (record["type"] === "toolCall" && typeof record["name"] === "string") out.push(record["name"]);
  for (const value of Object.values(record)) if (value && typeof value === "object") deepToolCalls(value, out);
}

interface Harness {
  fish: Fish;
  store: NewsRunStore;
  job: NewsJob;
  clock: Clock;
  freeze: ReturnType<typeof createNewsFreeze>;
  conv: Conversation;
  triggers: Map<string, RoundTrigger>;
  emitted: { conversationId: string; key: string; items: string[] }[];
  calls: { newsSubmit: number; ordinarySubmit: number; abort: number };
  submitOrdinary: (conversation: Conversation, text: string, kind?: "answer" | "ambient") => Promise<string>;
  close: () => Promise<void>;
}

async function openHarness(existing?: { clock?: Clock }): Promise<Harness> {
  const clock = existing?.clock ?? new Clock();
  const storage = await openNodeSqliteStorage(join(scenarioHome, "fish.db"));
  const triggers = new Map<string, RoundTrigger>();
  const emitted: Harness["emitted"] = [];
  const calls = { newsSubmit: 0, ordinarySubmit: 0, abort: 0 };
  const freeze = createNewsFreeze(() => clock.now);
  const candidates = new Map<string, { feeds: NewsTopicFeed[]; input: NewsCandidateInput }>();
  let messageId = 1;
  const fish = await openFish({
    storage,
    models: createFishModels(mainConfig),
    model: { provider: mainConfig.providerId, modelId: mainConfig.modelId },
    promptRoot: join(REPO, "prompt"),
    mediaRoot: join(scenarioHome, "media"),
    workspaceRoot: join(scenarioHome, "workspace"),
    now: () => clock.now,
    triggerOf: (roundId) => triggers.get(String(roundId)),
    silentOf: (roundId) => triggers.get(String(roundId))?.kind === "news",
    newsPrepare: async (input) => {
      const separator = input.runId.indexOf(" ");
      const day = input.runId.slice(0, separator);
      const group = input.runId.slice(separator + 1);
      const run = await store.read(day, group);
      if (!run || run.state !== "preparing" || run.conversationId !== input.conversationId || run.attempts !== input.attempt) {
        return { status: "rejected", reason: "stale_attempt" };
      }
      if (run.publishAt !== undefined && clock.now >= run.publishAt) return { status: "rejected", reason: "news_timeout" };
      const cached = candidates.get(input.runId);
      if (!cached) return { status: "rejected", reason: "candidates_missing" };
      const checked = validateNewsDigest(input.digest, cached.feeds, cached.input, 5);
      if (!checked.ok) return { status: "rejected", reason: checked.reason };
      const broadcast = renderNewsBroadcast(day, checked.digest, cached.input.index, fish.prompts.messages);
      if (!broadcast.text || broadcast.links.length === 0) return { status: "rejected", reason: "render_empty" };
      const status = await store.prepare({ day, group, attempt: input.attempt, conversationId: input.conversationId, now: clock.now, broadcast });
      return status === "prepared" ? { status: "prepared" } : { status: "rejected", reason: status };
    },
    emit: (conversationId, payload) => {
      emitted.push({ conversationId: String(conversationId), key: payload.key, items: [...payload.items] });
      return [messageId++];
    },
    react: () => {},
  });
  const store = createNewsRunStore(fish.harness, ctx, () => clock.now);
  const conv = await fish.group(CHAT, {
    groupId: GROUP,
    count: 2,
    master: "",
    members: [{ nickname: "虚构群友", userId: "10001" }],
  });

  async function submitRound(conversation: Conversation, content: string, trigger: RoundTrigger, deadline?: number): Promise<string> {
    const chatKey = conversation === conv ? CHAT : `qq:group:${OTHER_GROUP}`;
    freeze.assert(chatKey, String(conversation.id), trigger);
    if (deadline !== undefined && clock.now >= deadline) throw new Error("news_timeout");
    await absorbSecrets(conversation);
    resetRun(conversation.id);
    resetLook(conversation.id);
    freeze.assert(chatKey, String(conversation.id), trigger);
    if (deadline !== undefined && clock.now >= deadline) throw new Error("news_timeout");
    const submission = await conversation.submit({
      type: "input",
      content,
      entry: { kind: "fish.engage_tick" },
    }, ctx);
    triggers.set(String(submission.id), trigger);
    try {
      const settled = await submission.wait(ctx);
      const usage = await fish.harness.snapshot(UsageDoc, conversation.id, ctx);
      evidence({ stage: "usage", kind: trigger.kind, usage: sumUsage(usage) });
      return String(settled.status);
    } finally {
      triggers.delete(String(submission.id));
    }
  }

  const newsClient = createNewsClient({
    fetchImpl: async () => new Response(JSON.stringify({
      code: 200,
      data: {
        created_at: "2026-11-07 10:00:00",
        news: FEEDS[0]!.items.map((item) => ({ title: item.title, link: item.url })),
      },
    }), { status: 200, headers: { "content-type": "application/json" } }),
  });
  const job = createNewsJob({
    store,
    now: () => clock.now,
    collect: () => newsClient.collectForTopics([{ name: "AI", sources: ["60s"], keywords: ["AI"], exclude: [] }], { perTopicInput: 20 }),
    candidates: buildNewsCandidateInput,
    bind: async () => ({ conversationId: String(conv.id), effectivePersona: "默认", mappingKey: CHAT }),
    bindExisting: async (run) => {
      const existingConv = await fish.harness.conversation(Number(run.conversationId), ctx);
      if (!existingConv) return undefined;
      return { conversationId: String(existingConv.id), effectivePersona: run.effectivePersona!, mappingKey: run.mappingKey! };
    },
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
    submit: async (input) => {
      calls.newsSubmit++;
      const content = renderTemplate(fish.prompts.newsDigest, { topics: input.candidates.prompt, max: "5" });
      return submitRound((await fish.harness.conversation(Number(input.run.conversationId), ctx))!, content, {
        kind: "news",
        mentionsBot: false,
        newsRunId: newsRunKeyOf(input.run.localDay, input.run.targetGroup),
        newsAttempt: input.attempt,
      }, input.deadline);
    },
    waitIdle: async () => true,
    abort: async (conversationId) => {
      calls.abort++;
      const target = await fish.harness.conversation(Number(conversationId), ctx);
      await target?.abort(ctx);
    },
    drain: async (conversationId) => fish.drain([Number(conversationId)]),
    outbox: async (conversationId, key) => {
      const box = await fish.harness.snapshot(OutboxDoc, Number(conversationId), ctx);
      return box?.queue.find((item) => item.key === key)?.status ?? "absent";
    },
    log: (message) => evidence({ stage: "job", message }),
    setTimer: clock.setTimer,
    clearTimer: clock.clearTimer,
  });

  return {
    fish,
    store,
    job,
    clock,
    freeze,
    conv,
    triggers,
    emitted,
    calls,
    submitOrdinary: async (conversation, text, kind = "answer") => {
      calls.ordinarySubmit++;
      const content = renderMessageList([{
        messageId: 800 + calls.ordinarySubmit,
        userId: "10001",
        nickname: "虚构群友",
        text,
        mentionsBot: kind === "answer",
        replyIds: [],
      }], fish.prompts.messages, "group");
      return submitRound(conversation, content, { kind, mentionsBot: kind === "answer", userId: 10001 });
    },
    close: async () => {
      job.stop();
      await fish.close();
      await (storage as unknown as { close?: () => Promise<void> }).close?.();
    },
  };
}

async function toolCalls(conv: Conversation): Promise<string[]> {
  const view = await conv.viewState(ctx);
  try {
    const calls: string[] = [];
    for (const entry of view.value.entries) if (entry.kind === "pi.assistant") deepToolCalls(entry.model, calls);
    return calls;
  } finally {
    view.dispose();
  }
}

const verdicts = new Map<string, { status: "pass" | "fail"; expected: string; observed: string }>();
function verdict(name: string, ok: boolean, expected: string, observed: string): void {
  verdicts.set(name, { status: ok ? "pass" : "fail", expected, observed });
  evidence({ stage: "verdict", name, status: ok ? "pass" : "fail", expected, observed });
}

async function normalPreparation(): Promise<Harness> {
  const h = await openHarness();
  await h.job.start("10:30", DAY, CHAT, 1);
  return h;
}

async function scenarioN1(): Promise<void> {
  const h = await normalPreparation();
  try {
    const prepared = await h.store.read(DAY, GROUP);
    const calls = await toolCalls(h.conv);
    await h.clock.advanceTo(PUBLISH);
    await waitFor(async () => (await h.store.read(DAY, GROUP))?.state === "done");
    const done = await h.store.read(DAY, GROUP);
    const news = h.emitted.filter((item) => item.key === newsOutboxKeyOf(DAY, GROUP));
    const ok = prepared?.state === "prepared"
      && calls.includes("tool_search") && calls.includes("news_prepare")
      && !calls.some((name) => name.startsWith("say_"))
      && done?.state === "done" && news.length === 1;
    verdict("N1", ok, "真实人格经 tool_search/news_prepare 备料并唯一机械发布",
      `prepared=${prepared?.state} done=${done?.state} news=${news.length} calls=${calls.join(",")}`);
    evidence({ stage: "N1", modelCalls: h.calls, toolCalls: calls, run: done, emitted: h.emitted });
  } finally {
    await h.close();
  }
}

async function scenarioN2(): Promise<void> {
  const h = await normalPreparation();
  let recoveredPromise: Promise<string> | undefined;
  const engage = createEngageNext({
    groups: () => [CHAT],
    busy: () => h.freeze.has(CHAT),
    onShard: () => {
      recoveredPromise = h.submitOrdinary(h.conv, "冻结期保留的非 @ 消息恢复处理", "ambient");
      return recoveredPromise;
    },
    config: () => ({ freeSeconds: 1, freeBrowseChance: 0, freeBatchMax: 50 }),
    now: () => h.clock.now,
    setTimer: h.clock.setTimer,
    clearTimer: h.clock.clearTimer,
    freeMs: 1_000,
  });
  try {
    const prepared = await h.store.read(DAY, GROUP);
    engage.start();
    if (h.freeze.has(CHAT)) {
      await h.fish.enqueue(h.conv.id, {
        items: [h.fish.prompts.messages["news_preparing_reply"]!],
        quote: true,
        quoteId: 501,
        quoteForce: true,
        at: Date.now(),
        key: `news-preparing:${DAY}:501`,
      });
      engage.collectShard(CHAT, {
        userId: 10001,
        nickname: "虚构群友",
        text: "冻结期保留的非 @ 消息",
        at: h.clock.now,
        messageId: 502,
        arrivalSeq: 502,
        replyIds: [],
      });
      await h.fish.drain([h.conv.id]);
    }
    const other = await h.fish.group(`qq:group:${OTHER_GROUP}`);
    const otherStatus = await h.submitOrdinary(other, "另一个群的 @ 消息：只回复两个字：在的");
    const ordinaryBeforeDeadline = h.calls.ordinarySubmit;
    await h.clock.advanceTo(PUBLISH);
    await waitFor(async () => (await h.store.read(DAY, GROUP))?.state === "done");
    if (h.freeze.has(CHAT)) throw new NewsFrozenError(CHAT);
    await h.clock.advanceTo(PUBLISH + 1_000);
    if (!recoveredPromise) throw new Error("ambient_not_recycled");
    const recovered = await recoveredPromise;
    const newsIndex = h.emitted.findIndex((item) => item.key === newsOutboxKeyOf(DAY, GROUP));
    const mechanicalIndex = h.emitted.findIndex((item) => item.key === `news-preparing:${DAY}:501`);
    const ok = prepared?.state === "prepared" && mechanicalIndex >= 0 && otherStatus === "done"
      && ordinaryBeforeDeadline === 1 && h.calls.ordinarySubmit === 2
      && recovered === "done" && newsIndex > mechanicalIndex;
    verdict("N2", ok, "目标群 @ 机械接待、非 @ 留拍恢复、其它群可响应",
      `mechanical=${mechanicalIndex} news=${newsIndex} other=${otherStatus} recovered=${recovered} ordinary=${h.calls.ordinarySubmit}`);
    evidence({ stage: "N2", modelCalls: h.calls, emitted: h.emitted, freeze: h.freeze.has(CHAT), recovered });
  } finally {
    engage.stop();
    await h.close();
  }
}

async function scenarioN3(): Promise<void> {
  let mark!: () => void;
  let open!: () => void;
  const started = new Promise<void>((resolve) => { mark = resolve; });
  const release = new Promise<void>((resolve) => { open = resolve; });
  providerDelay = { started, release, mark, open };
  const h = await openHarness();
  try {
    const starting = h.job.start("10:30", DAY, CHAT, 1);
    await Promise.race([started, new Promise<void>((_, reject) => setTimeout(() => reject(new Error("provider_not_called")), 60_000))]);
    await h.clock.advanceTo(PUBLISH);
    open();
    await starting;
    await waitFor(async () => (await h.store.read(DAY, GROUP))?.state === "failed");
    const run = await h.store.read(DAY, GROUP);
    const news = h.emitted.filter((item) => item.key === newsOutboxKeyOf(DAY, GROUP));
    const ok = run?.state === "failed" && run.error === "news_timeout" && news.length === 0 && !h.freeze.has(CHAT);
    verdict("N3", ok, "真实响应在途越过 deadline 后 stale 后续不发布且解冻",
      `state=${run?.state} error=${run?.error} news=${news.length} freeze=${h.freeze.has(CHAT)} abort=${h.calls.abort}`);
    evidence({ stage: "N3", modelCalls: h.calls, run, emitted: h.emitted });
  } finally {
    open();
    providerDelay = undefined;
    await h.close();
  }
}

async function scenarioN4(): Promise<void> {
  const first = await normalPreparation();
  const prepared = await first.store.read(DAY, GROUP);
  const callsBefore = first.calls.newsSubmit;
  await first.close();
  const second = await openHarness();
  try {
    await Promise.all([
      second.job.recover((group) => `qq:group:${group}`),
      second.job.recover((group) => `qq:group:${group}`),
      second.job.start("10:30", DAY, CHAT, 1),
    ]);
    await second.clock.advanceTo(PUBLISH);
    await waitFor(async () => (await second.store.read(DAY, GROUP))?.state === "done");
    await second.job.recover((group) => `qq:group:${group}`);
    const run = await second.store.read(DAY, GROUP);
    const news = second.emitted.filter((item) => item.key === newsOutboxKeyOf(DAY, GROUP));
    const ok = prepared?.state === "prepared" && run?.state === "done" && news.length === 1 && second.calls.newsSubmit === 0;
    verdict("N4", ok, "prepared 同库重开只恢复发布，recover/scheduler 单飞不重复",
      `before=${prepared?.state} after=${run?.state} news=${news.length} newModelCalls=${second.calls.newsSubmit} oldModelCalls=${callsBefore}`);
    evidence({ stage: "N4", modelCalls: second.calls, run, emitted: second.emitted });
  } finally {
    await second.close();
  }
}

async function scenarioN5(): Promise<void> {
  const h = await normalPreparation();
  try {
    await h.fish.harness.commit(async (tx) => {
      const box = await tx.doc(OutboxDoc, h.conv.id);
      box.queue.unshift({ items: ["虚构阻塞头"], at: Date.now(), key: "blocked-head", status: "sending", attempts: 0 });
    }, ctx);
    await h.clock.advanceTo(PUBLISH);
    await waitFor(async () => (await h.store.read(DAY, GROUP))?.state === "done");
    const run = await h.store.read(DAY, GROUP);
    const box = await h.fish.harness.snapshot(OutboxDoc, h.conv.id, ctx);
    const news = box?.queue.filter((item) => item.key === newsOutboxKeyOf(DAY, GROUP)) ?? [];
    const ok = run?.state === "done" && box?.queue[0]?.key === "blocked-head" && box.queue[0]?.status === "sending"
      && news.length === 1 && !h.freeze.has(CHAT)
      && !h.emitted.some((item) => item.key === newsOutboxKeyOf(DAY, GROUP));
    verdict("N5", ok, "队首 sending 不跳过，新闻只入队一次且冻结解除",
      `state=${run?.state} head=${box?.queue[0]?.key}/${box?.queue[0]?.status} queuedNews=${news.length} sentNews=${h.emitted.length}`);
    evidence({ stage: "N5", modelCalls: h.calls, run, queue: box?.queue.map((item) => ({ key: item.key, status: item.status })), emitted: h.emitted });
  } finally {
    await h.close();
  }
}

const scenarios: Record<string, () => Promise<void>> = {
  N1: scenarioN1,
  N2: scenarioN2,
  N3: scenarioN3,
  N4: scenarioN4,
  N5: scenarioN5,
};

const selected = (process.argv[2] ?? "N1,N2,N3,N4,N5").split(",").map((name) => name.trim().toUpperCase()).filter(Boolean);
try {
  for (const name of selected) {
    const scenario = scenarios[name];
    if (!scenario) throw new Error(`unknown scenario ${name}`);
    try {
      scenarioHome = join(ROOT, name.toLowerCase());
      mkdirSync(join(scenarioHome, "media"), { recursive: true });
      mkdirSync(join(scenarioHome, "workspace"), { recursive: true });
      await scenario();
    } catch (error) {
      verdict(name, false, "scenario completes", error instanceof Error ? error.message : String(error));
    }
  }
} finally {
  globalThis.fetch = originalFetch;
}

for (const name of selected) {
  const result = verdicts.get(name) ?? { status: "fail" as const, expected: "executed", observed: "not-run" };
  console.log(`${name}: ${result.status} | ${result.observed}`);
}
const failed = [...verdicts].filter(([, result]) => result.status !== "pass");
evidence({ stage: "summary", runId: RUN_ID, root: ROOT, verdicts: Object.fromEntries(verdicts), failed: failed.map(([name]) => name) });
if (failed.length > 0 || verdicts.size !== selected.length || selected.some((name) => !verdicts.has(name))) process.exitCode = 1;
