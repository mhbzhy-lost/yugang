/**
 * 门外的规则闸（零 LLM）。
 *
 * 作用只有一个：别让群里的每句话都进 agent loop。
 * 门内还有一次机会——模型可以选择不调用 say()，那才是「沉默」的终态。
 */
import type { IncomingMessage } from "./onebot.ts";

export interface GateOptions {
  /** 群里不带 @ 时，这句话有多大概率触发一轮（0~1）。 */
  ambientChance: number;
  /** 同一群两次进 loop 的最小间隔（毫秒）。 */
  cooldownMs: number;
  /** 命中这些词也要进 loop，比如鱼的名字。 */
  keywords: readonly string[];
  /** 只在白名单群里主动接话；空数组 = 所有群。 */
  groups: readonly string[];
  random?: () => number;
  now?: () => number;
}

export function createGate(options: GateOptions) {
  const random = options.random ?? Math.random;
  const now = options.now ?? Date.now;
  const lastAt = new Map<string, number>();

  return {
    shouldEnter(msg: IncomingMessage): boolean {
      if (msg.chatKey.startsWith("qq:private:")) return true;
      if (options.groups.length > 0 && !options.groups.includes(String(msg.groupId))) return false;

      const addressed = msg.mentionsBot || options.keywords.some((k) => msg.text.includes(k));
      const prev = lastAt.get(msg.chatKey) ?? 0;
      if (!addressed && now() - prev < options.cooldownMs) return false;
      if (!addressed && random() > options.ambientChance) return false;

      lastAt.set(msg.chatKey, now());
      return true;
    },
  };
}

/** 群消息的结构化包装：身份与内容分开，避免群员把指令混进 system。 */
export function renderForModel(msg: IncomingMessage, selfId: number): string {
  const where = msg.groupId ? `群${msg.groupId}` : "私聊";
  const reply = msg.messageId ? ` 回复msg:${msg.messageId}` : "";
  const addressed = msg.mentionsBot || String(msg.userId) === String(selfId) ? " 对你说话" : "";
  return `[${where} | ${msg.nickname}(${msg.userId})${reply}${addressed}] ${msg.text}`;
}
