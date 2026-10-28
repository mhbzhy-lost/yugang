/**
 * 两份持久状态，都在 pi-durable 的 session 里，跟着同一个 SQLite：
 *
 *   fish.chats    群 → conversationId 映射（重启后会话不变，记忆接得上）
 *   fish.outbox   待发出的消息（崩在"committed 但还没发"这一刻也不丢）
 *
 * 文档都是小 JSON，checkpointWhen 一律返回 true：每次存整份，不做增量。
 */
import { defineDoc } from "@earendil-works/pi-durable";
import type { OutboundPayload } from "./egress/say.ts";

export interface ChatsState {
  /** chatKey（qq:group:123）→ conversationId */
  chats: Record<string, number>;
}

export interface OutboxRecord extends OutboundPayload {
  status: "queued" | "sending";
  attempts: number;
}

export interface OutboxState {
  queue: OutboxRecord[];
}

export const ChatsDoc = defineDoc<ChatsState>({
  kind: "fish.chats",
  version: 1,
  scope: "session",
  initial: () => ({ chats: {} }),
  checkpointWhen: () => true,
});

export const OutboxDoc = defineDoc<OutboxState>({
  kind: "fish.outbox",
  version: 1,
  scope: "conversation",
  history: "latest",
  fork: "current",
  initial: () => ({ queue: [] }),
  checkpointWhen: () => true,
});
