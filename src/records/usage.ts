/**
 * 用量记账。
 *
 * pi-durable 已经按会话记了 pi.usage（按 provider/model 与工具分桶），但那是累计值、只在 db 里。
 * 这里读出来、和上次的值求差、按天追加到 var/usage/<day>.jsonl。
 *
 * 存增量而不是累计值：按天按群直接 sum 就行，不用怕重复。
 *
 * **基线必须持久化**（2026-11-14 修复）：pi.usage 是持久化累计值，而旧实现的基线
 * 只在进程内存。进程一重启，每个会话首轮都走「首次见到」分支把**全量历史累计**
 * 当成本轮增量再写一遍，按天 sum 就彻底坏了（实测单日出现 3.8 亿 token 的假记录，
 * 同一会话多次重启还会写出 cost 完全相同的重复条）。容器化后每次部署都重启，
 * 这个旧 bug 从「偶发」变成「每次部署必发」。
 */
import { appendFileSync, existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { UsageState } from "@earendil-works/pi-durable";

export interface UsageSnapshot {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
  total: number;
  cost: number;
}

export interface UsageRecord extends UsageSnapshot {
  at: number;
  day: string;
  chat: string;
  /** 产生这笔用量的 conversation id（可选）。旧记录没有该字段，按群聚合时直接忽略。 */
  conv?: string;
}

const EMPTY: UsageSnapshot = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0, cost: 0 };

export function sumUsage(state: Readonly<UsageState> | undefined): UsageSnapshot {
  if (!state) return { ...EMPTY };
  const total = { ...EMPTY };
  for (const bucket of [state.models, state.tools]) {
    for (const raw of Object.values(bucket)) {
      const usage = raw as unknown as {
        input?: number;
        output?: number;
        cacheRead?: number;
        cacheWrite?: number;
        totalTokens?: number;
        cost?: { total?: number };
      };
      total.input += usage.input ?? 0;
      total.output += usage.output ?? 0;
      total.cacheRead += usage.cacheRead ?? 0;
      total.cacheWrite += usage.cacheWrite ?? 0;
      total.total += usage.totalTokens ?? (usage.input ?? 0) + (usage.output ?? 0);
      total.cost += usage.cost?.total ?? 0;
    }
  }
  return total;
}

export function diffUsage(next: UsageSnapshot, prev: UsageSnapshot | undefined): UsageSnapshot {
  if (!prev) return next;
  return {
    input: Math.max(0, next.input - prev.input),
    output: Math.max(0, next.output - prev.output),
    cacheRead: Math.max(0, next.cacheRead - prev.cacheRead),
    cacheWrite: Math.max(0, next.cacheWrite - prev.cacheWrite),
    total: Math.max(0, next.total - prev.total),
    cost: Number(Math.max(0, next.cost - prev.cost).toFixed(6)),
  };
}

/** 按本地时区分天，跟原话簿一致；用 UTC 的话国内用户会觉得日期错一天。 */
export function localDay(at: number): string {
  const date = new Date(at);
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
}

/** 读基线；缺失或坏了都回退空 Map，但坏了要告警（会丢一轮增量精度）。 */
function loadBaseline(path: string): Map<string, UsageSnapshot> {
  if (!existsSync(path)) return new Map();
  try {
    const raw = JSON.parse(readFileSync(path, "utf8")) as Record<string, UsageSnapshot>;
    return new Map(Object.entries(raw));
  } catch (error) {
    console.error("[鱼缸] 用量基线读取失败，本轮增量可能不准", error instanceof Error ? error.message : error);
    return new Map();
  }
}

/** 原子写基线（tmp + rename）；写失败只告警，不阻断记账。 */
function saveBaseline(path: string, last: Map<string, UsageSnapshot>): void {
  try {
    mkdirSync(join(path, ".."), { recursive: true });
    const tmp = `${path}.tmp`;
    writeFileSync(tmp, JSON.stringify(Object.fromEntries(last)));
    renameSync(tmp, path);
  } catch (error) {
    console.error("[鱼缸] 用量基线写入失败", error instanceof Error ? error.message : error);
  }
}

export function createUsageLedger(root: string) {
  // 基线按「chat × conversation」记：人格切换（/切换人格）= 同一 chatKey 换新 conversation，
  // 累计值从旧会话的高位回落到新会话的低位是新会话的正常现象；按 chat 单维记会把
  // 回落全数钳零、整轮用量静默丢账（append 返回 null，usage.jsonl 和日志都不留痕）。
  const baselinePath = join(root, "baseline.json");
  const last = loadBaseline(baselinePath);

  return {
    /** 传入该会话的累计用量；只有增长时才落一行。返回写入的增量或 null。
     *  conv 用来区分同一群的多个会话（人格切换后的新会话各自独立基线），不传则按 chat 记。 */
    append(chat: string, cumulative: UsageSnapshot, at: number, conv?: string): UsageRecord | null {
      const key = conv === undefined ? chat : `${chat}#${conv}`;
      const previous = last.get(key);
      last.set(key, cumulative);
      if (!previous) {
        // 真正的首次（新群/新人格，或基线文件丢了）：此时累计值就是从 0 长起来的，
        // 记一笔等于记增量。**重启不再走这里**——基线已从 baseline.json 加载。
        if (cumulative.total === 0 && cumulative.cost === 0) return null;
        saveBaseline(baselinePath, last);
        return write(chat, cumulative, at, conv);
      }

      const delta = diffUsage(cumulative, previous);
      if (delta.total === 0 && delta.cost === 0) return null;
      saveBaseline(baselinePath, last);
      return write(chat, delta, at, conv);
    },
  };

  function write(chat: string, snapshot: UsageSnapshot, at: number, conv?: string): UsageRecord {
    const day = localDay(at);
    const record: UsageRecord = conv === undefined
      ? { ...snapshot, at, day, chat }
      : { ...snapshot, at, day, chat, conv };
    try {
      const dir = join(root, day);
      mkdirSync(dir, { recursive: true });
      appendFileSync(join(dir, "usage.jsonl"), `${JSON.stringify(record)}\n`);
    } catch (error) {
      console.error("[鱼缸] 用量写入失败", error instanceof Error ? error.message : error);
    }
    return record;
  }
}
