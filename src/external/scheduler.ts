/**
 * 外部信息源的作业调度器 + fish.external_jobs 落库（外部计划决策 1/3/4，Task E1）。
 *
 * 职责与四条验证路径：
 *   1. 时点触发——每日按 slots（"HH:MM"，热读，每轮排程现取）触发 onJob；
 *   2. 错过补跑——启动后当天该 slot 未跑且距时点 ≤2h（CATCHUP_WINDOW_MS）补跑一次，
 *      超窗的落 skipped（missed_window），幂等 key = date + slot；
 *   3. 硬截止——onJob 超 jobTimeoutMs() 强制收束为 failed/failed_timeout，
 *      返回的 Promise 不再等待（取消在途 submission 是调用方的事，这里只做 watchdog）；
 *   4. 作业落库——状态机 pending|running|done|failed|skipped 写入 fish.external_jobs，
 *      生产用 jobsHandleOf(harness) 接线；不接 jobs 时退化为进程内 Map（重启丢补跑记忆）。
 *
 * 时钟与定时器全部注入（可注入时钟）：测试用假时钟内联验证四条路径；
 * 生产接线用 nodeTimers（unref，不挡进程退出）。
 *
 * "24:00" 这类端点时点按当天 00:00 触发与记账（date 键仍归当天）：跨零点的
 * 「前一天 24:00」与「当天 00:00」是同一瞬间，归一成当天零点后 evaluate/补跑口径自洽。
 */
import { BACKGROUND_CONTEXT, type Context } from "@earendil-works/chord/context";
import { defineDoc, type Harness } from "@earendil-works/pi-durable";
import { localDay } from "../records/usage.ts";

/** 错过时点的补跑窗口（决策 3：≤2h 补跑一次）。 */
export const CATCHUP_WINDOW_MS = 2 * 60 * 60_000;

/** 时点表热读的巡检上限：定时器最长睡这么久就醒来重排（新增时点 ≤1 分钟内生效）。 */
export const HOT_POLL_MS = 60_000;

/** 落库条目的保留天数：fish.external_jobs 只服务幂等判定与近期审计，老条目写入时顺手清。 */
export const JOBS_TTL_DAYS = 8;

export type ExternalJobState = "pending" | "running" | "done" | "failed" | "skipped";

export interface ExternalJobRecord {
  /** 本地日（localDay，"YYYY-MM-DD"），幂等 key 的一半。 */
  date: string;
  /** 触发时点（"HH:MM"），幂等 key 的另一半。 */
  slot: string;
  state: ExternalJobState;
  startedAt: number;
  finishedAt?: number;
  /** 失败原因；硬截止固定为 "failed_timeout"，错过补跑窗口固定为 "missed_window"。 */
  error?: string;
}

export interface ExternalJobsState {
  /** key = jobKeyOf(date, slot)。 */
  jobs: Record<string, ExternalJobRecord>;
}

/** 会话级文档：一条鱼一份作业账，跟着同一个 SQLite，重启后补跑判定接得上。 */
export const ExternalJobsDoc = defineDoc<ExternalJobsState>({
  kind: "fish.external_jobs",
  version: 1,
  scope: "session",
  initial: () => ({ jobs: {} }),
  checkpointWhen: () => true,
});

/** 幂等 key 的唯一拼法（date + slot），读写两边都走这里。 */
export function jobKeyOf(date: string, slot: string): string {
  return `${date} ${slot}`;
}

/** 读整份作业账（今天及 TTL 内的条目）；生产接 fish.harness。 */
export async function readJobs(
  harness: Harness,
  context: Context = BACKGROUND_CONTEXT,
): Promise<Record<string, ExternalJobRecord>> {
  const doc = await harness.snapshot(ExternalJobsDoc, context);
  return doc?.jobs ?? {};
}

/** 写一条作业记录（覆盖同 key 旧值），顺手清掉超 TTL 的老条目。 */
export async function writeJob(
  harness: Harness,
  record: ExternalJobRecord,
  context: Context = BACKGROUND_CONTEXT,
): Promise<void> {
  await harness.commit(async (tx) => {
    const doc = await tx.doc(ExternalJobsDoc);
    doc.jobs ??= {};
    doc.jobs[jobKeyOf(record.date, record.slot)] = record;
    const horizon = Date.now() - JOBS_TTL_DAYS * 86_400_000;
    for (const [key, job] of Object.entries(doc.jobs)) {
      if ((job.finishedAt ?? job.startedAt) < horizon) delete doc.jobs[key];
    }
  }, context);
}

/** 调度器的作业落库句柄：read/write 两个口，生产由 jobsHandleOf 绑到 harness。 */
export interface ExternalJobsHandle {
  read: () => Promise<Record<string, ExternalJobRecord>>;
  write: (record: ExternalJobRecord) => Promise<void>;
}

/** 把 pi-durable harness 绑成调度器的落库句柄（E4 接线用：jobs: jobsHandleOf(fish.harness)）。 */
export function jobsHandleOf(harness: Harness, context: Context = BACKGROUND_CONTEXT): ExternalJobsHandle {
  return {
    read: () => readJobs(harness, context),
    write: (record) => writeJob(harness, record, context),
  };
}

/** 生产接线用定时器：unref 掉，不挡进程退出。 */
export const nodeTimers = {
  setTimer: (callback: () => void, ms: number): unknown => setTimeout(callback, ms).unref?.(),
  clearTimer: (handle: unknown): void => clearTimeout(handle as NodeJS.Timeout),
};

export interface SchedulerDeps {
  /** 时点表（"HH:MM"），热读：每次排程/巡检都现取，改配置不用重启。 */
  slots: () => readonly string[];
  /** 作业体：slot 到点调用，date 为触发当日 localDay；超 jobTimeoutMs() 未返回即收束。 */
  onJob: (slot: string, date: string) => Promise<void>;
  /** 时钟（可注入）。 */
  now: () => Date;
  /** 定时器注入（生产传 nodeTimers）。 */
  setTimer: (callback: () => void, ms: number) => unknown;
  clearTimer: (handle: unknown) => void;
  /** 单次作业硬截止（ms），每次起作业现读；超时标记 failed_timeout 且不再等待 Promise。 */
  jobTimeoutMs: () => number;
  /** 作业落库句柄；缺省仅进程内 Map（重启后补跑判定退化为「当天全都没跑过」）。 */
  jobs?: ExternalJobsHandle;
  /** 补跑窗口，缺省 CATCHUP_WINDOW_MS；测试可注入。 */
  catchupWindowMs?: () => number;
  log?: (message: string) => void;
}

export interface Scheduler {
  /** 启动：先跑一轮巡检（覆盖启动补跑），再排下一次定时。重复调用是空操作。 */
  start(): void;
  /** 停止：不再触发新作业；在途作业与它的 watchdog 照常收束落账。 */
  stop(): void;
}

interface SlotEntry {
  slot: string;
  /** 当天 00:00 起算的分钟数（"24:00" 归一为 0）。 */
  minutes: number;
}

/** "HH:MM" 解析；只认 00:00–23:59 与 24:00（后者归一为当天 0 分）。 */
function parseSlot(slot: string): number | undefined {
  const m = /^(\d{1,2}):(\d{2})$/.exec(slot.trim());
  if (!m) return undefined;
  const h = Number(m[1]);
  const min = Number(m[2]);
  if (h === 24 && min === 0) return 0;
  if (h > 23 || min > 59) return undefined;
  return h * 60 + min;
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export function createScheduler(deps: SchedulerDeps): Scheduler {
  const memory = new Map<string, ExternalJobRecord>();
  const warnedSlots = new Set<string>();
  let started = false;
  let stopped = false;
  let evaluating = false;
  let tickTimer: unknown;

  const log = (message: string): void => {
    try {
      deps.log?.(message);
    } catch {
      // 日志回调不许炸调度
    }
  };

  /** 时点表现取 + 解析 + 去重 + 排序；非法条目只告警一次。 */
  function validSlots(): SlotEntry[] {
    const seen = new Map<number, SlotEntry>();
    for (const raw of deps.slots()) {
      const minutes = parseSlot(String(raw));
      if (minutes === undefined) {
        if (!warnedSlots.has(String(raw))) {
          warnedSlots.add(String(raw));
          log(`非法时点已忽略：${String(raw)}`);
        }
        continue;
      }
      if (!seen.has(minutes)) seen.set(minutes, { slot: String(raw).trim(), minutes });
    }
    return [...seen.values()].sort((a, b) => a.minutes - b.minutes);
  }

  /** 某天的时点对应的具体时刻（"24:00" 已归一为 0 分 = 当天零点）。 */
  function slotTimeOn(day: Date, minutes: number): Date {
    return new Date(day.getFullYear(), day.getMonth(), day.getDate(), Math.floor(minutes / 60), minutes % 60, 0, 0);
  }

  /** 下一个严格晚于 from 的时点时刻（今天找不到就看明天；无有效时点返回 undefined）。 */
  function nextFireAt(from: Date): Date | undefined {
    let best: Date | undefined;
    for (const offset of [0, 1]) {
      const day = new Date(from.getFullYear(), from.getMonth(), from.getDate() + offset);
      for (const entry of validSlots()) {
        const at = slotTimeOn(day, entry.minutes);
        if (at.getTime() > from.getTime() && (best === undefined || at < best)) best = at;
      }
    }
    return best;
  }

  async function readAll(): Promise<Record<string, ExternalJobRecord>> {
    if (deps.jobs) return await deps.jobs.read();
    return Object.fromEntries(memory);
  }

  async function writeRecord(record: ExternalJobRecord): Promise<void> {
    if (deps.jobs) {
      await deps.jobs.write(record);
      return;
    }
    memory.set(jobKeyOf(record.date, record.slot), record);
  }

  /**
   * 该 slot 今天是否已经不该再跑：有终态记录（done/failed/skipped），或
   * running 且未超时（还在跑）。running 但早已超过硬截止的视为上次进程死掉的残账，允许重跑。
   */
  function settled(record: ExternalJobRecord | undefined, nowMs: number, timeoutMs: number): boolean {
    if (!record) return false;
    if (record.state === "running") return nowMs - record.startedAt <= timeoutMs;
    return true;
  }

  /** 起一次作业：先记 running，race(作业体, watchdog)，先到者收束落账。 */
  async function runJob(slot: string, date: string): Promise<void> {
    const startedAt = deps.now().getTime();
    const timeoutMs = Math.max(1, deps.jobTimeoutMs());
    await writeRecord({ date, slot, state: "running", startedAt });
    log(`job 开始：${date} ${slot}`);

    let watchdog: unknown;
    const work = (async () => deps.onJob(slot, date))();
    const outcome = await Promise.race([
      work.then(
        () => ({ kind: "done" }),
        (error: unknown) => ({ kind: "error", error }),
      ),
      new Promise<{ kind: "timeout" }>((resolve) => {
        watchdog = deps.setTimer(() => resolve({ kind: "timeout" }), timeoutMs);
      }),
    ]);
    if (watchdog !== undefined) deps.clearTimer(watchdog);

    const finishedAt = deps.now().getTime();
    if (outcome.kind === "timeout") {
      // 硬截止：work 的 Promise 不等待（上面已挂了 rejection 处理，不会 unhandled），
      // 取消在途 submission 由调用方负责
      await writeRecord({ date, slot, state: "failed", startedAt, finishedAt, error: "failed_timeout" });
      log(`job 硬截止收束：${date} ${slot}（>${timeoutMs}ms）`);
      return;
    }
    if (outcome.kind === "error") {
      await writeRecord({ date, slot, state: "failed", startedAt, finishedAt, error: messageOf(outcome.error) });
      log(`job 失败：${date} ${slot} ${messageOf(outcome.error)}`);
      return;
    }
    await writeRecord({ date, slot, state: "done", startedAt, finishedAt });
    log(`job 完成：${date} ${slot}`);
  }

  /** 巡检：把今天所有「已到点、未跑、在补跑窗内」的 slot 按时间顺序跑一遍；超窗的落 skipped。 */
  async function evaluate(): Promise<void> {
    const now = deps.now();
    const nowMs = now.getTime();
    const date = localDay(nowMs);
    const windowMs = deps.catchupWindowMs?.() ?? CATCHUP_WINDOW_MS;
    const jobs = await readAll();
    const due: SlotEntry[] = [];
    const expired: string[] = [];
    for (const entry of validSlots()) {
      const at = slotTimeOn(now, entry.minutes);
      if (at.getTime() > nowMs) continue;
      if (settled(jobs[jobKeyOf(date, entry.slot)], nowMs, Math.max(1, deps.jobTimeoutMs()))) continue;
      if (nowMs - at.getTime() <= windowMs) due.push(entry);
      else expired.push(entry.slot);
    }
    for (const slot of expired) {
      await writeRecord({ date, slot, state: "skipped", startedAt: nowMs, finishedAt: nowMs, error: "missed_window" });
      log(`slot 超出补跑窗，记 skipped：${date} ${slot}`);
    }
    for (const entry of due) {
      if (stopped) return;
      await runJob(entry.slot, date);
    }
  }

  async function cycle(): Promise<void> {
    if (evaluating) return;
    evaluating = true;
    try {
      await evaluate();
    } catch (error) {
      log(`巡检失败：${messageOf(error)}`);
    } finally {
      evaluating = false;
      armNext();
    }
  }

  function armNext(): void {
    if (stopped) return;
    if (tickTimer !== undefined) deps.clearTimer(tickTimer);
    const now = deps.now();
    const next = nextFireAt(now);
    // 无有效时点或时点很远时也最多睡 HOT_POLL_MS：时点表是热读的，改了要尽快接管
    const delay = next === undefined ? HOT_POLL_MS : Math.max(0, Math.min(next.getTime() - now.getTime(), HOT_POLL_MS));
    tickTimer = deps.setTimer(() => {
      tickTimer = undefined;
      void cycle();
    }, delay);
  }

  return {
    start(): void {
      if (started) return;
      started = true;
      stopped = false;
      log(`scheduler 启动（时点 ${deps.slots().join("/")}）`);
      void cycle();
    },
    stop(): void {
      stopped = true;
      if (tickTimer !== undefined) {
        deps.clearTimer(tickTimer);
        tickTimer = undefined;
      }
    },
  };
}
