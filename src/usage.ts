/**
 * 用量记账。
 *
 * pi-durable 已经按会话记了 pi.usage（按 provider/model 与工具分桶），但那是累计值、只在 db 里。
 * 这里读出来、和上次的值求差、按天追加到 var/usage/<day>.jsonl。
 *
 * 存增量而不是累计值：按天按群直接 sum 就行，不用怕重复。
 */
import { appendFileSync, mkdirSync } from "node:fs";
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

export function createUsageLedger(root: string) {
  // 基线按「chat × conversation」记：人格切换（/切换人格）= 同一 chatKey 换新 conversation，
  // 累计值从旧会话的高位回落到新会话的低位是新会话的正常现象；按 chat 单维记会把
  // 回落全数钳零、整轮用量静默丢账（append 返回 null，usage.jsonl 和日志都不留痕）。
  const last = new Map<string, UsageSnapshot>();

  return {
    /** 传入该会话的累计用量；只有增长时才落一行。返回写入的增量或 null。
     *  conv 用来区分同一群的多个会话（人格切换后的新会话各自独立基线），不传则按 chat 记。 */
    append(chat: string, cumulative: UsageSnapshot, at: number, conv?: string): UsageRecord | null {
      const key = conv === undefined ? chat : `${chat}#${conv}`;
      const previous = last.get(key);
      last.set(key, cumulative);
      if (!previous) {
        // 首次见到这个会话：把它的历史累计也记一笔，否则重启前花的钱会丢
        if (cumulative.total === 0 && cumulative.cost === 0) return null;
        return write(chat, cumulative, at, conv);
      }

      const delta = diffUsage(cumulative, previous);
      if (delta.total === 0 && delta.cost === 0) return null;
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
