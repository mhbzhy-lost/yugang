/**
 * 轮级护栏：
 *  1. shouldRetryRoundAttempt：模型错误轮内重试门控——本轮一旦已通过 say_* 入队回复，
 *     即使收尾推理流中断（如 Google stream ended without a finish reason），也绝不重投
 *     整轮以免对同一条消息重复回复。
 *  2. createInFlightTracker：按 conversationId × RoundKind 引用计数的在途登记器，
 *     保证 @ 轮与自由拍/主动轮互斥退避，且两个并发 @ 轮互不提前清掉 busy。
 */
import type { SettledSubmissionRecord } from "@earendil-works/pi-durable";
import type { RoundKind } from "./tools/types.ts";

export interface RetryDecisionInput {
  status: SettledSubmissionRecord["status"];
  reason: string | undefined;
  attempt: number;
  maxAttempts: number;
  /** 本轮累计已通过 say_* 入队的出口次数。 */
  sayCount: number;
}

/** 仅在未成功、原因为 model_error、尚有重试余量、且本轮尚未开口时允许重试。 */
export function shouldRetryRoundAttempt(input: RetryDecisionInput): boolean {
  if (input.status === "done") return false;
  if (input.reason !== "model_error") return false;
  if (input.sayCount > 0) return false;
  return input.attempt < input.maxAttempts;
}

export interface InFlightTracker {
  register(id: string | number, kind: RoundKind): void;
  release(id: string | number, kind: RoundKind): void;
  isBusy(id: string | number): boolean;
  hasAmbient(id: string | number): boolean;
  waitAmbientClear(id: string | number, timeoutMs: number): Promise<boolean>;
}

/** 引用计数在途轮登记器：同 kind 多次登记须对称释放后才清零，避免并发 @ 轮互相提前解锁。 */
export function createInFlightTracker(): InFlightTracker {
  const counts = new Map<string, Map<RoundKind, number>>();
  const ambientWaiters = new Map<string, Set<(ok: boolean) => void>>();

  const hasAmbient = (id: string | number): boolean => {
    const map = counts.get(String(id));
    if (!map) return false;
    return (map.get("ambient") ?? 0) > 0 || (map.get("injection") ?? 0) > 0;
  };

  return {
    register(id, kind) {
      const key = String(id);
      const map = counts.get(key) ?? new Map<RoundKind, number>();
      map.set(kind, (map.get(kind) ?? 0) + 1);
      counts.set(key, map);
    },
    release(id, kind) {
      const key = String(id);
      const map = counts.get(key);
      if (!map) return;
      const next = (map.get(kind) ?? 0) - 1;
      if (next > 0) map.set(kind, next);
      else map.delete(kind);
      if (map.size === 0) counts.delete(key);
      // 在途 ambient/injection 清零才唤醒等待的 @ 轮（其它在途 @ 轮不阻塞它们）
      if (!hasAmbient(key)) {
        const waiters = ambientWaiters.get(key);
        if (waiters) {
          ambientWaiters.delete(key);
          for (const wake of waiters) wake(true);
        }
      }
    },
    isBusy(id) {
      const map = counts.get(String(id));
      return map !== undefined && map.size > 0;
    },
    hasAmbient,
    async waitAmbientClear(id, timeoutMs) {
      const key = String(id);
      const deadline = Date.now() + timeoutMs;
      for (;;) {
        if (!hasAmbient(key)) return true;
        const remaining = deadline - Date.now();
        if (remaining <= 0) return false;
        const woken = await new Promise<boolean>((resolve) => {
          let done = false;
          const finish = (ok: boolean): void => {
            if (done) return;
            done = true;
            clearTimeout(timer);
            const waiters = ambientWaiters.get(key);
            if (waiters) {
              waiters.delete(finish);
              if (waiters.size === 0) ambientWaiters.delete(key);
            }
            resolve(ok);
          };
          const timer = setTimeout(() => finish(false), remaining);
          const waiters = ambientWaiters.get(key) ?? new Set<(ok: boolean) => void>();
          waiters.add(finish);
          ambientWaiters.set(key, waiters);
        });
        if (!woken) return false;
      }
    },
  };
}
