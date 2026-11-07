/** 可注入的新闻备料状态机：调度、恢复、硬截止与机械发布共用同一条路径。 */
import type { NewsCandidateInput } from "./news-broadcast.ts";
import type { NewsTopicFeed } from "./news-client.ts";
import {
  NEWS_MAX_ATTEMPTS,
  NEWS_RECOVERY_WINDOW_MS,
  isCompleteNewsRun,
  newsRunKeyOf,
  type NewsRunRecord,
  type NewsRunStore,
} from "./news-runs.ts";

export interface NewsJobBinding {
  conversationId: string;
  effectivePersona: string;
  mappingKey: string;
}

export interface NewsJobDeps {
  store: NewsRunStore;
  now(): number;
  collect(): Promise<NewsTopicFeed[]>;
  candidates(feeds: readonly NewsTopicFeed[]): NewsCandidateInput;
  bind(chatKey: string): Promise<NewsJobBinding>;
  bindExisting(run: NewsRunRecord): Promise<NewsJobBinding | undefined>;
  freeze(chatKey: string, run: NewsRunRecord): void;
  attempt(chatKey: string, runId: string, attempt: number): void;
  expire(chatKey: string, runId: string): void;
  unfreeze(chatKey: string, runId: string): void;
  setCandidates(runId: string, value: { feeds: NewsTopicFeed[]; input: NewsCandidateInput } | undefined): void;
  submit(input: {
    run: NewsRunRecord;
    chatKey: string;
    attempt: number;
    feeds: NewsTopicFeed[];
    candidates: NewsCandidateInput;
    deadline: number;
  }): Promise<string>;
  waitIdle(run: NewsRunRecord, deadline: number): Promise<boolean>;
  abort(conversationId: string): Promise<void>;
  drain(conversationId: string): Promise<number>;
  outbox(conversationId: string, key: string): Promise<"absent" | "queued" | "sending">;
  log(message: string): void;
  setTimer(callback: () => void, ms: number): unknown;
  clearTimer(timer: unknown): void;
}

export function newsScheduledStartAt(date: string, slot: string, now: number): number {
  const [year, month, day] = date.split("-").map(Number);
  const [hour, minute] = slot.split(":").map(Number);
  if (hour === 24) return new Date(year!, month! - 1, day! + 1, 0, minute ?? 0, 0, 0).getTime();
  const at = new Date(year!, month! - 1, day!, hour, minute, 0, 0).getTime();
  return Number.isFinite(at) ? at : now;
}

export function createNewsJob(deps: NewsJobDeps) {
  const active = new Set<string>();
  const expired = new Set<string>();
  const timers = new Map<string, { deadline: unknown; watchdog: unknown }>();
  const submitting = new Set<string>();

  const clearTimers = (key: string): void => {
    const current = timers.get(key);
    if (!current) return;
    deps.clearTimer(current.deadline);
    deps.clearTimer(current.watchdog);
    timers.delete(key);
  };

  const finish = (key: string, chatKey: string): void => {
    clearTimers(key);
    deps.unfreeze(chatKey, key);
    deps.setCandidates(key, undefined);
    active.delete(key);
    expired.delete(key);
    submitting.delete(key);
  };

  const publish = async (run: NewsRunRecord, chatKey: string): Promise<void> => {
    const key = newsRunKeyOf(run.localDay, run.targetGroup);
    try {
      const result = await deps.store.publish(run.localDay, run.targetGroup, deps.now());
      if (result !== "done" && result !== "already_done") throw new Error(`publish_${result}`);
      deps.log(`新闻已入队 ${key}`);
      finish(key, chatKey);
      const sent = await deps.drain(run.conversationId!);
      const box = await deps.outbox(run.conversationId!, `news:${run.localDay}:${run.targetGroup}`);
      deps.log(`新闻发送核对 ${key} sent=${sent} outbox=${box}`);
    } catch (error) {
      deps.log(`新闻发布失败 ${key} ${error instanceof Error ? error.message : String(error)}`);
      finish(key, chatKey);
    }
  };

  const onDeadline = async (run: NewsRunRecord, chatKey: string): Promise<void> => {
    const key = newsRunKeyOf(run.localDay, run.targetGroup);
    expired.add(key);
    deps.expire(chatKey, key);
    let current: NewsRunRecord | undefined;
    try {
      current = await deps.store.read(run.localDay, run.targetGroup);
    } catch (error) {
      deps.log(`新闻截止读账失败 ${key} ${error instanceof Error ? error.message : String(error)}`);
      deps.unfreeze(chatKey, key);
      return;
    }
    if (current?.state === "prepared") {
      await publish(current, chatKey);
      return;
    }
    deps.unfreeze(chatKey, key);
    if (submitting.has(key)) {
      try { await deps.abort(run.conversationId!); } catch (error) {
        deps.log(`新闻中止失败 ${key} ${error instanceof Error ? error.message : String(error)}`);
      }
    }
    try {
      const failed = await deps.store.fail(run.localDay, run.targetGroup, "news_timeout", deps.now());
      if (failed === "prepared" && current) {
        const latest = await deps.store.read(run.localDay, run.targetGroup);
        if (latest) await publish(latest, chatKey);
        return;
      }
      deps.log(`新闻失败 ${key} news_timeout`);
    } catch (error) {
      deps.log(`新闻超时落账失败 ${key} ${error instanceof Error ? error.message : String(error)}`);
    }
    finish(key, chatKey);
  };

  const arm = (run: NewsRunRecord, chatKey: string): void => {
    const key = newsRunKeyOf(run.localDay, run.targetGroup);
    clearTimers(key);
    const left = Math.max(0, run.publishAt! - deps.now());
    const deadline = deps.setTimer(() => { void onDeadline(run, chatKey); }, left);
    const watchdog = deps.setTimer(() => {
      deps.log(`新闻安全看门狗解冻 ${key}`);
      deps.unfreeze(chatKey, key);
      // 看门狗只解除内存冻结；执行权仍由原协程持有，避免存储恢复后recover另起重复备料/发布。
    }, Math.max(0, run.publishAt! + 5_000 - deps.now()));
    timers.set(key, { deadline, watchdog });
  };

  const execute = async (initial: NewsRunRecord, chatKey: string, recover: boolean): Promise<void> => {
    const key = newsRunKeyOf(initial.localDay, initial.targetGroup);
    if (active.has(key)) return;
    if (!isCompleteNewsRun(initial)) {
      await deps.store.fail(initial.localDay, initial.targetGroup, "invalid_run", deps.now());
      return;
    }
    active.add(key);
    expired.delete(key);
    deps.freeze(chatKey, initial);
    arm(initial, chatKey);

    if (initial.state === "prepared") {
      if (deps.now() >= initial.publishAt) await publish(initial, chatKey);
      return;
    }
    if (deps.now() >= initial.publishAt) {
      await deps.store.fail(initial.localDay, initial.targetGroup, "news_timeout", deps.now());
      finish(key, chatKey);
      return;
    }

    let cached: { feeds: NewsTopicFeed[]; input: NewsCandidateInput } | undefined;
    try {
      for (;;) {
        if (expired.has(key) || deps.now() >= initial.publishAt) return;
        let current = await deps.store.read(initial.localDay, initial.targetGroup);
        if (!current || current.state !== "preparing") {
          if (current?.state === "prepared") return;
          finish(key, chatKey);
          return;
        }
        const claimed = await deps.store.claim(initial.localDay, initial.targetGroup, deps.now());
        if (!claimed) {
          current = await deps.store.read(initial.localDay, initial.targetGroup);
          if (current?.state === "prepared") return;
          const result = await deps.store.fail(initial.localDay, initial.targetGroup,
            (current?.attempts ?? 0) >= NEWS_MAX_ATTEMPTS ? "attempts_exhausted" : "news_timeout", deps.now());
          if (result === "prepared") return;
          deps.log(`新闻失败 ${key} ${result}`);
          finish(key, chatKey);
          return;
        }
        if (!cached) {
          let feeds: NewsTopicFeed[];
          try {
            feeds = await deps.collect();
          } catch (error) {
            deps.log(`新闻取料失败 ${key} ${error instanceof Error ? error.message : String(error)}`);
            if (claimed.attempts! < NEWS_MAX_ATTEMPTS && deps.now() < initial.publishAt) continue;
            throw error;
          }
          if (expired.has(key) || deps.now() >= initial.publishAt) return;
          const present = feeds.filter((feed) => feed.items.length > 0);
          if (present.length === 0) {
            cached = undefined;
            continue;
          }
          cached = { feeds: present, input: deps.candidates(present) };
          deps.setCandidates(key, cached);
        }
        deps.attempt(chatKey, key, claimed.attempts!);
        if (!(await deps.waitIdle(claimed, initial.publishAt))) continue;
        if (expired.has(key) || deps.now() >= initial.publishAt) return;
        deps.log(`新闻备料尝试 ${key} ${claimed.attempts}/${NEWS_MAX_ATTEMPTS}${recover ? " recover" : ""}`);
        submitting.add(key);
        try {
          await deps.submit({
            run: claimed,
            chatKey,
            attempt: claimed.attempts!,
            feeds: cached.feeds,
            candidates: cached.input,
            deadline: initial.publishAt,
          });
        } catch (error) {
          deps.log(`新闻备料轮失败 ${key} ${error instanceof Error ? error.message : String(error)}`);
        } finally {
          submitting.delete(key);
        }
        current = await deps.store.read(initial.localDay, initial.targetGroup);
        if (current?.state === "prepared") {
          deps.log(`新闻备料完成 ${key}`);
          return;
        }
        if (expired.has(key) || deps.now() >= initial.publishAt) return;
        if ((current?.attempts ?? claimed.attempts) >= NEWS_MAX_ATTEMPTS) {
          const result = await deps.store.fail(initial.localDay, initial.targetGroup, "attempts_exhausted", deps.now());
          if (result === "prepared") return;
          deps.log(`新闻失败 ${key} attempts_exhausted`);
          finish(key, chatKey);
          return;
        }
      }
    } catch (error) {
      if (!expired.has(key) && deps.now() < initial.publishAt) {
        const reason = error instanceof Error ? error.message : String(error);
        const current = await deps.store.read(initial.localDay, initial.targetGroup).catch(() => undefined);
        if (current?.state !== "prepared") {
          await deps.store.fail(initial.localDay, initial.targetGroup, reason, deps.now()).catch(() => "stale");
          deps.log(`新闻失败 ${key} ${reason.slice(0, 120)}`);
          finish(key, chatKey);
        }
      }
    }
  };

  return {
    async start(slot: string, date: string, chatKey: string, preparationMinutes: number): Promise<void> {
      const key = newsRunKeyOf(date, chatKey.slice("qq:group:".length));
      if (active.has(key)) return;
      const prior = await deps.store.read(date, chatKey.slice("qq:group:".length));
      if (prior) {
        if (prior.state === "done" || prior.state === "failed") {
          deps.log(`新闻跳过 ${key}（已 ${prior.state}）`);
          return;
        }
        await execute(prior, chatKey, true);
        return;
      }
      const binding = await deps.bind(chatKey);
      const scheduledStartAt = newsScheduledStartAt(date, slot, deps.now());
      const run: NewsRunRecord = {
        localDay: date,
        targetGroup: chatKey.slice("qq:group:".length),
        state: "preparing",
        scheduledStartAt,
        startedAt: deps.now(),
        publishAt: scheduledStartAt + preparationMinutes * 60_000,
        attempts: 0,
        ...binding,
      };
      if (!(await deps.store.create(run))) return;
      await execute(run, chatKey, false);
    },

    async recover(chatKeyFor: (group: string) => string): Promise<void> {
      const runs = await deps.store.list();
      for (const run of runs) {
        if (run.state === "done" || run.state === "failed") continue;
        const chatKey = chatKeyFor(run.targetGroup);
        const key = newsRunKeyOf(run.localDay, run.targetGroup);
        if (active.has(key)) continue;
        if (run.state === "running" || !isCompleteNewsRun(run)) {
          await deps.store.fail(run.localDay, run.targetGroup, "legacy_running", deps.now());
          continue;
        }
        if (run.state === "prepared" && deps.now() - run.publishAt! > NEWS_RECOVERY_WINDOW_MS) {
          await deps.store.miss(run.localDay, run.targetGroup, deps.now());
          continue;
        }
        if (run.state === "preparing" && deps.now() >= run.publishAt!) {
          await deps.store.fail(run.localDay, run.targetGroup, "news_timeout", deps.now());
          continue;
        }
        const binding = await deps.bindExisting(run);
        if (!binding) {
          await deps.store.fail(run.localDay, run.targetGroup, "conversation_missing", deps.now());
          continue;
        }
        const bound = { ...run, ...binding };
        if (run.state === "prepared" && deps.now() >= run.publishAt!) {
          deps.freeze(chatKey, bound);
          active.add(key);
          await publish(bound, chatKey);
          continue;
        }
        await execute(bound, chatKey, true);
      }
    },

    stop(): void {
      for (const key of [...timers.keys()]) clearTimers(key);
      active.clear();
      submitting.clear();
    },
  };
}

export type NewsJob = ReturnType<typeof createNewsJob>;
