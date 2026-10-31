/**
 * 三份持久状态，都在 pi-durable 的 session 里，跟着同一个 SQLite：
 *
 *   fish.chats    群 → conversationId 映射（重启后会话不变，记忆接得上）
 *   fish.outbox   待发出的消息（崩在"committed 但还没发"这一刻也不丢）
 *   fish.watch    该会话的特别关注名单（主人点名要留意的群友 + 自由备注）
 *   fish.memory   长期记忆（keyed family：key 是人格名，一个人格一份）
 *
 * 文档都是小 JSON，checkpointWhen 一律返回 true：每次存整份，不做增量。
 */
import { defineDoc, defineDocFamily } from "@earendil-works/pi-durable";
import type { OutboundPayload } from "./tools/say/tool.ts";
import { emptyMemory, type MemoryState } from "./memory.ts";

export interface ChatsState {
  /** chatKey（qq:group:123）→ conversationId；人格会话的键是 `chatKey#人格名` */
  chats: Record<string, number>;
  /** chatKey → 当前人格名；旧档没有这个字段，读取侧一律 `doc?.personas?.[chatKey] ?? "默认"`，写侧先 `??= {}`。 */
  personas?: Record<string, string>;
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
  initial: () => ({ chats: {}, personas: {} }),
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

export interface WatchedPerson {
  /** 被关注者的 QQ 号（字符串，和入站消息的 userId 同源）。 */
  userId: string;
  /** 主人提到的称呼，可空；只作提示，识别仍以 QQ 号为准。 */
  name?: string;
  /** 自由备注：怎么称呼他、他是什么人、见面要做什么，都写这里。 */
  note: string;
  at: number;
}

export interface WatchState {
  people: WatchedPerson[];
}

/**
 * 特别关注名单：会话级文档（人格之间天然隔离），换页（compact）不会动它，
 * 每次请求由 section 重新渲染进 system prompt，等价于人格书那种常驻预填充信息。
 */
export const WatchDoc = defineDoc<WatchState>({
  kind: "fish.watch",
  version: 1,
  scope: "conversation",
  history: "latest",
  fork: "current",
  initial: () => ({ people: [] }),
  checkpointWhen: () => true,
});

/**
 * 长期记忆：session 级 keyed family，key = 人格名（默认人格为「默认」）。
 * 与对话 transcript 物理分离：换页（compact）只重置 entries，不动它；
 * 一个人格在所有会话（各群、私聊）的压缩都并入同一个 doc，模拟「一个个体
 * 的一份记忆」；不同人格互不可见。写入入口只有压缩链路（compact.ts 的
 * saveMemories）；读取入口只有 memory section（harness.ts）与只读脚本
 * （scripts/memory.ts）。
 */
export const MemoryDoc = defineDocFamily<MemoryState, string>({
  kind: "fish.memory",
  version: 1,
  family: true,
  scope: "session",
  initial: (_chatKey) => emptyMemory(),
  checkpointWhen: () => true,
});
