/**
 * 鱼缸自己的 durable doc/entry 定义（2026-11-05 从 harness.ts 拆出）。
 *
 * 只放 `fish.*` 的文档形状；`harness.ts` 继续 re-export，外部 importer（runtime.ts）
 * 不用改。store.ts 自己的 fish.chats / fish.outbox / fish.watch 不在这里。
 */
import { defineDoc, defineEntry } from "@earendil-works/pi-durable";

/** 群档案作为一条 system 消息放进 transcript，只在建会话时写一次。 */
export const GroupProfileEntry = defineEntry("fish.group-profile");

/** fish.sentmap 的一条：实际发出的 QQ 消息 id → outbound entry（评价定位链路的唯一事实源）。 */
export interface SentmapEntry {
  /** 被评 outbound 条目所在的会话。 */
  conversationId: string;
  /** fish.outbound transcript entry 的 id（按 outbox 幂等 key 关联解析）。 */
  entryId: number;
  at: number;
}

export interface SentmapState {
  version: 1;
  /** QQ 消息 id（字符串化）→ 映射；30 天滚动清理（drain 写入时顺手淘汰）。 */
  map: Record<string, SentmapEntry>;
}

/**
 * 发送回执映射（/评 指向型定位，决策 11b B2①）：drain 每条实际发出的 QQ 消息
 * 在此记 sentMessageId → outbound entryId；fish.enqueue 的机械消息（busy/cmd/working
 * 等）没有 transcript entry，不在此列。部分发送失败只记成功条目。
 */
export const SentmapDoc = defineDoc<SentmapState>({
  kind: "fish.sentmap",
  version: 1,
  scope: "session",
  initial: () => ({ version: 1, map: {} }),
  checkpointWhen: () => true,
});
