/**
 * installDrain：outbox 两阶段发送 + fish.sentmap 记账（2026-11-05 从 harness.ts 拆出）。
 *
 * 发送语义不变：队首卡在 sending 就不动、过期条丢弃、绝不重试/跳过队首。
 */
import type { ConversationId, Harness } from "@earendil-works/pi-durable";
import { ChatsDoc, OutboxDoc } from "../store.ts";
import { SentmapDoc } from "./docs.ts";
import type { FishBase } from "./base.ts";

export interface DrainParts {
  drainConversation(conversationId: ConversationId): Promise<number>;
  drain(extra?: readonly ConversationId[]): Promise<number>;
}

export function installDrain(state: FishBase & { harness: Harness }): DrainParts {
  const { harness, options, ctx, now } = state;

  /** sentmap 保留窗口：30 天滚动清理（drain 写入时顺手淘汰过期项）。 */
  const SENTMAP_TTL_MS = 30 * 24 * 60 * 60 * 1000;

  /** 幂等 key → fish.outbound transcript entry id：outbox 记录与 entry 在同一次提交里落库，
   *  用 key 关联（fish.enqueue 的机械消息没有 entry，返回 undefined）。 */
  async function outboundEntryIdOf(conversationId: ConversationId, key: string): Promise<number | undefined> {
    const conversation = await harness.conversation(conversationId, ctx);
    if (!conversation) return undefined;
    const view = await conversation.viewState(ctx);
    try {
      let found: number | undefined;
      for (const entry of view.value.entries) {
        if (entry.kind === "fish.outbound" && (entry.data as { key?: unknown } | undefined)?.key === key) {
          found = entry.id as number;
        }
      }
      return found;
    } finally {
      view.dispose();
    }
  }

  /** drain 后记 sentmap（决策 11b）：每条实际发出的 QQ 消息 id → outbound entryId，30 天滚动
   *  清理。失败只打日志不阻塞 drain（定位链路宁可少记，不影响发送语义）。 */
  async function recordSentmap(conversationId: ConversationId, key: string, sentIds: readonly (number | string)[]): Promise<void> {
    if (sentIds.length === 0) return;
    try {
      const entryId = await outboundEntryIdOf(conversationId, key);
      if (entryId === undefined) return;
      const at = now();
      await harness.commit(async (tx) => {
        const doc = await tx.doc(SentmapDoc);
        for (const id of sentIds) doc.map[String(id)] = { conversationId: String(conversationId), entryId, at };
        const cutoff = at - SENTMAP_TTL_MS;
        for (const [id, value] of Object.entries(doc.map)) {
          if (value.at < cutoff) delete doc.map[id];
        }
      }, ctx);
    } catch (error) {
      console.error("[鱼缸] sentmap 记录失败", error instanceof Error ? error.message : error);
    }
  }

  async function drainConversation(conversationId: ConversationId): Promise<number> {
    let sent = 0;
    for (;;) {
      // 只看队首：sending 在队首意味着上一次发送中断（发出多少不确定），整个会话停在这里——
      // 不翻回 queued、不重试，也绝不跳过它去发后面的 queued（宁可少发不重复）
      const box = await harness.snapshot(OutboxDoc, conversationId, ctx);
      const head = box?.queue[0];
      if (!head) return sent;
      if (head.status === "sending") return sent;

      // 陈年消息不补：超过 10 分钟的排队消息直接丢弃。原先设 2 分钟，
      // 但模型慢时（比如走订阅的 codex 一轮 30–90 秒）消息会在队列里等到过期，
      // 表现就是「鱼想回了，但回复被当成过期丢了」。10 分钟足够覆盖正常慢轮。
      if (now() - head.at > 600_000) {
        await harness.commit(async (tx) => {
          const doc = await tx.doc(OutboxDoc, conversationId);
          const index = doc.queue.findIndex((item) => item.key === head.key);
          if (index >= 0) doc.queue.splice(index, 1);
        }, ctx);
        console.log(`[鱼缸] 丢弃过期消息（${Math.round((now() - head.at) / 1000)}s 前）`);
        continue;
      }

      // 出站配速已下沉到 onebot 实际发送层（每条物理消息发送前按会话等待，见 src/qq/onebot.ts
      // 的 #pacedSend）：条目级等待只隔开 outbox 条目，挡不住一条 payload 拆出的多条物理消息。
      // 等待窗口随之下挪进发送段（标 sending 之后）：等待中进程退出，这条消息停在 sending
      // 不重发（宁少勿答）——两阶段语义不变，崩溃窗口从「等待中」变成「等待+发送中」。

      // 先标 sending 再发：崩在这中间的消息状态是"不确定"，重启时不重发（宁可少发不重复）
      await harness.commit(async (tx) => {
        const doc = await tx.doc(OutboxDoc, conversationId);
        const record = doc.queue.find((item) => item.key === head.key);
        if (record) record.status = "sending";
      }, ctx);

      try {
        const result = await options.emit(conversationId, {
          items: head.items,
          ...(head.media === undefined ? {} : { media: head.media }),
          // voice 也要透传：和 quoteId 一样，漏一个字段就等于整条消息丢一半
          ...(head.voice === undefined ? {} : { voice: head.voice }),
          // 主动 @ 跟 outbox 一起持久化：重启后补发必须还是同一条 @，不能静默降级成裸消息
          ...(head.mentions === undefined ? {} : { mentions: head.mentions }),
          quote: head.quote,
          // 引用绑定全链路贯通：早期漏传这两个字段，靠 lastMessageId 回退掩盖（会错位）；
          // 回退删除后 @ 场景全部裸发——不传，引用的真实修复在这里
          ...(head.quoteId !== undefined ? { quoteId: head.quoteId } : {}),
          ...(head.quoteForce !== undefined ? { quoteForce: head.quoteForce } : {}),
          at: head.at,
          key: head.key,
        });
        // 发送链记账（T6，/评 定位）：每条实际发出的 QQ 消息写 fish.sentmap
        await recordSentmap(conversationId, head.key, Array.isArray(result) ? result : []);
      } catch (error) {
        // 部分发送失败只记成功条目：emit 可能把已发出的 id 挂在错误的 sentIds 上
        //（onebot.SendFailure 约定），成功记完再沿用既有语义（保留 sending 不重试）。
        const partial = (error as { sentIds?: unknown }).sentIds;
        const extra = Array.isArray(partial)
          ? partial.filter((id): id is number | string => typeof id === "number" || typeof id === "string")
          : [];
        if (extra.length > 0) await recordSentmap(conversationId, head.key, extra);
        // 发送异常 = 不确定状态（sendGroup 可能已发出第一条文本和第一条 @）：保留 sending
        // 供诊断，绝不翻回 queued 重试——重试会把可能已送达的内容再发一遍。停止本会话的
        // 后续 drain（不能跳过队首发后面的记录），其余会话不受影响。
        console.error(
          `[鱼缸] ${String(conversationId)} 发送失败，保留 sending 不重试：` +
            `${error instanceof Error ? error.message : error}`,
        );
        return sent;
      }

      // 实际发送成功的记账收尾：配速时钟与末条自言标记都已在 onebot 层逐条处理
      // （#pacedSend 记钟 + onSent 逐条回调），drain 只负责摘除队列条目。
      await harness.commit(async (tx) => {
        const doc = await tx.doc(OutboxDoc, conversationId);
        const index = doc.queue.findIndex((item) => item.key === head.key);
        if (index >= 0) doc.queue.splice(index, 1);
      }, ctx);
      sent++;
    }
  }

  async function drain(extra: readonly ConversationId[] = []): Promise<number> {
    const snapshot = await harness.snapshot(ChatsDoc, ctx);
    const ids = new Set<ConversationId>([...Object.values(snapshot?.chats ?? {}), ...extra]);
    let total = 0;
    for (const conversationId of ids) {
      if (state.sending.has(String(conversationId))) continue;
      state.sending.add(String(conversationId));
      try {
        total += await drainConversation(conversationId);
      } finally {
        state.sending.delete(String(conversationId));
      }
    }
    return total;
  }

  return { drainConversation, drain };
}
