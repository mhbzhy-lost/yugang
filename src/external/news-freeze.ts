/** 目标群新闻冻结的内存态与最终提交准入；durable run 仍是恢复事实源。 */
import type { RoundTrigger } from "../tools/types.ts";

export class NewsFrozenError extends Error {
  readonly chatKey: string;
  constructor(chatKey: string) {
    super("news_frozen");
    this.name = "NewsFrozenError";
    this.chatKey = chatKey;
  }
}

export interface NewsFreezeState {
  runId: string;
  conversationId: string;
  attempt: number;
  publishAt: number;
  expired: boolean;
}

export function createNewsFreeze(now: () => number = Date.now) {
  const states = new Map<string, NewsFreezeState>();
  return {
    has(chatKey: string): boolean {
      return states.has(chatKey);
    },
    freeze(chatKey: string, state: Omit<NewsFreezeState, "expired">): void {
      states.set(chatKey, { ...state, expired: false });
    },
    expire(chatKey: string, runId: string): void {
      const current = states.get(chatKey);
      if (current?.runId === runId) current.expired = true;
    },
    unfreeze(chatKey: string, runId: string): void {
      if (states.get(chatKey)?.runId === runId) states.delete(chatKey);
    },
    attempt(chatKey: string, runId: string, attempt: number): void {
      const current = states.get(chatKey);
      if (current?.runId === runId) current.attempt = attempt;
    },
    assert(chatKey: string, conversationId: string, trigger: RoundTrigger): void {
      const current = states.get(chatKey);
      if (!current) return;
      if (trigger.kind === "news"
        && trigger.newsRunId === current.runId
        && conversationId === current.conversationId
        && trigger.newsAttempt === current.attempt
        && !current.expired
        && now() < current.publishAt) return;
      throw new NewsFrozenError(chatKey);
    },
  };
}

/** 混合 burst 拆分：@ 机械接待，非 @ 回原收集器；顺序在各自轨道内不变。 */
export function splitNewsBurst<T extends { mentionsBot: boolean }>(messages: readonly T[]): {
  mentions: T[];
  nonMentions: T[];
} {
  return {
    mentions: messages.filter((message) => message.mentionsBot),
    nonMentions: messages.filter((message) => !message.mentionsBot),
  };
}
