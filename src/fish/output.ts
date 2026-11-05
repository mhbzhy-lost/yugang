/**
 * 返回对象上的三个小方法（2026-11-05 从 harness.ts 拆出）：
 * compact / enqueue / close。单独装箱只是为了装配表里也能各占一行。
 */
import type { ConversationId, Harness } from "@earendil-works/pi-durable";
import type { Compactor } from "../compact.ts";
import { OutboxDoc } from "../store.ts";
import type { FishBase } from "./base.ts";
import type { Fish } from "./types.ts";

export function installCompact(state: { compactor: Compactor | undefined }): Pick<Fish, "compact"> {
  return {
    async compact(conversation, force) {
      if (!state.compactor) return { compacted: false, reason: "below_threshold" };
      return state.compactor.maybeCompact(conversation, force);
    },
  };
}

export function installEnqueue(state: FishBase & { harness: Harness }): Pick<Fish, "enqueue"> {
  return {
    async enqueue(conversationId: ConversationId, payload) {
      await state.harness.commit(async (tx) => {
        const doc = await tx.doc(OutboxDoc, conversationId);
        doc.queue.push({ ...payload, status: "queued", attempts: 0 });
      }, state.ctx);
    },
  };
}

export function installClose(state: { harness: Harness; ctx: FishBase["ctx"] }): Pick<Fish, "close"> {
  return {
    async close() {
      await state.harness.close(state.ctx);
    },
  };
}
