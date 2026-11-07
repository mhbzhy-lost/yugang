/** 新闻备料运行的 durable 账本与原子迁移；所有写路径都在这里做 CAS。 */
import { defineDoc, type Harness } from "@earendil-works/pi-durable";
import type { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { OutboxDoc } from "../store.ts";
import { localDay } from "../records/usage.ts";

export const NEWS_RUNS_TTL_DAYS = 30;
export const NEWS_MAX_ATTEMPTS = 4;
export const NEWS_RECOVERY_WINDOW_MS = 2 * 60 * 60_000;

export interface NewsBroadcast {
  text: string;
  links: string[];
}

export interface NewsRunRecord {
  localDay: string;
  targetGroup: string;
  /** running 只用于读取旧账；新代码不会创建它。 */
  state: "running" | "preparing" | "prepared" | "done" | "failed";
  scheduledStartAt?: number;
  startedAt: number;
  publishAt?: number;
  attempts?: number;
  conversationId?: string;
  effectivePersona?: string;
  mappingKey?: string;
  preparedAt?: number;
  finishedAt?: number;
  broadcast?: NewsBroadcast;
  error?: string;
  /** 旧版审计字段，只读兼容。 */
  digest?: string;
}

export interface NewsRunsState {
  runs: Record<string, NewsRunRecord>;
}

export const NewsRunsDoc = defineDoc<NewsRunsState>({
  kind: "fish.news_runs",
  version: 1,
  scope: "session",
  initial: () => ({ runs: {} }),
  checkpointWhen: () => true,
});

export function newsRunKeyOf(day: string, group: string): string {
  return `${day} ${group}`;
}

export function newsOutboxKeyOf(day: string, group: string): string {
  return `news:${day}:${group}`;
}

export function isCompleteNewsRun(run: NewsRunRecord | undefined): run is NewsRunRecord & {
  scheduledStartAt: number;
  publishAt: number;
  attempts: number;
  conversationId: string;
  effectivePersona: string;
  mappingKey: string;
} {
  return run !== undefined
    && (run.state === "preparing" || run.state === "prepared")
    && typeof run.scheduledStartAt === "number"
    && typeof run.publishAt === "number"
    && typeof run.attempts === "number"
    && typeof run.conversationId === "string"
    && typeof run.effectivePersona === "string"
    && typeof run.mappingKey === "string";
}

export type NewsPrepareStatus = "prepared" | "stale" | "expired" | "terminal";
export type NewsFailStatus = "failed" | "prepared" | "done" | "stale";
export type NewsPublishStatus = "done" | "already_done" | "not_prepared" | "missing";

export interface NewsRunStore {
  read(day: string, group: string): Promise<NewsRunRecord | undefined>;
  list(): Promise<NewsRunRecord[]>;
  create(run: NewsRunRecord): Promise<boolean>;
  claim(day: string, group: string, now: number): Promise<NewsRunRecord | undefined>;
  prepare(input: {
    day: string;
    group: string;
    attempt: number;
    conversationId: string;
    now: number;
    broadcast: NewsBroadcast;
  }): Promise<NewsPrepareStatus>;
  fail(day: string, group: string, reason: string, now: number): Promise<NewsFailStatus>;
  miss(day: string, group: string, now: number): Promise<NewsFailStatus>;
  publish(day: string, group: string, now: number): Promise<NewsPublishStatus>;
}

export function createNewsRunStore(
  harness: Harness,
  ctx: typeof BACKGROUND_CONTEXT,
  wallNow: () => number = Date.now,
): NewsRunStore {
  const keyOf = newsRunKeyOf;
  const trimOld = (doc: NewsRunsState): void => {
    const horizon = localDay(wallNow() - NEWS_RUNS_TTL_DAYS * 86_400_000);
    for (const [key, run] of Object.entries(doc.runs)) {
      if (run.localDay < horizon) delete doc.runs[key];
    }
  };

  return {
    async read(day, group) {
      const doc = await harness.snapshot(NewsRunsDoc, ctx);
      return doc?.runs?.[keyOf(day, group)];
    },
    async list() {
      const doc = await harness.snapshot(NewsRunsDoc, ctx);
      return Object.values(doc?.runs ?? {});
    },
    async create(run) {
      return harness.commit(async (tx) => {
        const doc = await tx.doc(NewsRunsDoc);
        doc.runs ??= {};
        const key = keyOf(run.localDay, run.targetGroup);
        if (doc.runs[key] !== undefined) return false;
        doc.runs[key] = run;
        trimOld(doc);
        return true;
      }, ctx);
    },
    async claim(day, group, now) {
      return harness.commit(async (tx) => {
        const doc = await tx.doc(NewsRunsDoc);
        const run = doc.runs[keyOf(day, group)];
        if (!isCompleteNewsRun(run) || run.state !== "preparing") return undefined;
        if (run.attempts >= NEWS_MAX_ATTEMPTS || now >= run.publishAt) return undefined;
        run.attempts += 1;
        return { ...run };
      }, ctx);
    },
    async prepare(input) {
      return harness.commit(async (tx) => {
        const doc = await tx.doc(NewsRunsDoc);
        const run = doc.runs[keyOf(input.day, input.group)];
        if (!isCompleteNewsRun(run)) return "terminal";
        if (run.state === "prepared") return "stale";
        if (run.state !== "preparing") return "terminal";
        if (run.conversationId !== input.conversationId || run.attempts !== input.attempt) return "stale";
        // 截止必须取 commit 内的当前时间：调用方校验后的旧时间不能让越界 CAS 变成 prepared。
        const now = wallNow();
        if (now >= run.publishAt) return "expired";
        run.state = "prepared";
        run.preparedAt = now;
        run.broadcast = input.broadcast;
        run.error = undefined;
        return "prepared";
      }, ctx);
    },
    async fail(day, group, reason, now) {
      return harness.commit(async (tx) => {
        const doc = await tx.doc(NewsRunsDoc);
        const run = doc.runs[keyOf(day, group)];
        if (!run) return "stale";
        if (run.state === "prepared") return "prepared";
        if (run.state === "done") return "done";
        if (run.state !== "preparing" && run.state !== "running") return "stale";
        run.state = "failed";
        run.finishedAt = now;
        run.error = reason.slice(0, 120);
        return "failed";
      }, ctx);
    },
    async miss(day, group, now) {
      return harness.commit(async (tx) => {
        const doc = await tx.doc(NewsRunsDoc);
        const run = doc.runs[keyOf(day, group)];
        if (!run || run.state !== "prepared" || typeof run.publishAt !== "number") return "stale";
        if (now - run.publishAt <= NEWS_RECOVERY_WINDOW_MS) return "prepared";
        run.state = "failed";
        run.finishedAt = now;
        run.error = "missed_window";
        return "failed";
      }, ctx);
    },
    async publish(day, group, now) {
      return harness.commit(async (tx) => {
        const doc = await tx.doc(NewsRunsDoc);
        const run = doc.runs[keyOf(day, group)];
        if (!run) return "missing";
        if (run.state === "done") return "already_done";
        if (run.state !== "prepared" || !isCompleteNewsRun(run) || !run.broadcast) return "not_prepared";
        const outbox = await tx.doc(OutboxDoc, Number(run.conversationId));
        const key = newsOutboxKeyOf(day, group);
        if (!outbox.queue.some((item) => item.key === key)) {
          outbox.queue.push({
            items: [run.broadcast.text],
            at: now,
            key,
            status: "queued",
            attempts: 0,
          });
        }
        run.state = "done";
        run.finishedAt = now;
        run.error = undefined;
        return "done";
      }, ctx);
    },
  };
}
