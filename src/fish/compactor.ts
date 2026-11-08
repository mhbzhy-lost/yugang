/**
 * installCompactor：上下文压缩 + 记忆抽取的接线（2026-11-05 从 harness.ts 拆出）。
 *
 * 压缩器本身在 src/compact.ts；这里只负责把模型、prompt、harness、公共/私有记忆
 * doc 的读写口接上。没有 options.compact 时返回 undefined（不压）。
 */
import type { Harness } from "@earendil-works/pi-durable";
import { createCompactor, MemoryExtractError, type Compactor } from "../compact.ts";
import { aggregatePendingItems, isPatchEmpty, mergeMemoryStates, monthAnchor, newPendingId, splitPendingPatch, MEMORY_CAPS, MEMORY_PENDING_CAP } from "../memory/index.ts";
import { privateMemoryKeyOf } from "../memory/scope.ts";
import { MemoryDoc, MemoryPendingDoc, MemoryPrivateDoc } from "../store.ts";
import type { FishBase } from "./base.ts";

export function installCompactor(
  state: FishBase & { harness: Harness },
): { compactor: Compactor | undefined } {
  const { options, models, prompts, harness, ctx, now } = state;
  if (!options.compact) return { compactor: undefined };

  const compactor = createCompactor({
    models,
    model: options.compact.model ?? options.model,
    prompts,
    selfOf: options.selfOf,
    maxTokens: options.compact.maxTokens ?? 100_000,
    ...(options.compact.limits ? { limits: options.compact.limits } : {}),
    onError: (error) => {
      if (error instanceof MemoryExtractError) console.error("[鱼缸] 记忆抽取失败", error.message);
      else console.error("[鱼缸] 压缩失败", error instanceof Error ? error.message : error);
    },
    // 记忆抽取与 handoff 各自的模型；缺省都落在 handoff 模型上（比主模型便宜一档即可）
    extract: {
      models,
      model: options.compact.memoryModel ?? options.compact.model ?? options.model,
      prompts,
    },
    memoryKeyOf: (conversationId) => state.memoryKeyByConversation.get(String(conversationId)),
    // 已知记忆（T11）：公共 doc + 当前会话私有 doc 的合并渲染（mergeMemoryStates，
    // 同主体事实去重），行格式与抽取器的机械解析同构：主体行「subject 昵称/昵称」、
    // 事实行「f-id YYYY-MM 事实」——SUPERSEDE 的 factId→subject 解析与 people 信号
    // 都从这份结构里机械读出。known 只喂给一次内部抽取请求，不写入会话。
    knownMemory: async (memoryKey, conversationId) => {
      const originChatKey = state.chatKeyByConversation.get(String(conversationId));
      const privKey = originChatKey ? privateMemoryKeyOf(memoryKey, originChatKey) : undefined;
      const pubSnap = await harness.snapshot(MemoryDoc, memoryKey, ctx);
      const privSnap = privKey !== undefined ? await harness.snapshot(MemoryPrivateDoc, privKey, ctx) : undefined;
      const merged = mergeMemoryStates(pubSnap, privSnap);
      const subjects = Object.values(merged.people).map((person) => ({
        subject: person.subject,
        name: person.names[0] ?? person.subject,
      }));
      // 已知记忆只喂给一次内部抽取请求；总长封顶 knownChars；不写入 conversation、pi.user 或 handoff
      const lines = Object.values(merged.people).flatMap((person) => [
        `${person.subject} ${person.names.join("/")}`,
        ...person.facts.filter((fact) => fact.invalidAt === undefined).map((fact) => `${fact.id} ${monthAnchor(fact.at)} ${fact.text}`),
      ]);
      const text = lines.reduce(
        (out, line) => (out.length + line.length + 1 <= MEMORY_CAPS.knownChars ? `${out}${out ? "\n" : ""}${line}` : out),
        "",
      );
      return { text, subjects };
    },
    // 只入待审库：patch 不直接 apply，主人批准后才进公共/私有 doc（审批闸硬约束）。
    // originChatKey 由 harness 的 conversation→chatKey 映射解析；同一 commit 内读改
    // 同一 family member，不能先在 commit 外 snapshot 再整份覆盖（后写会把先写的吃掉）。
    // 零提取计数（T11）：empty 累计、ok 清零（解析失败不进这里，不计零提取）；返回更新后的
    // 计数驱动压缩链路的复查模式（达 MEMORY_ZERO_EXTRACT_PAGES 重跑本页一次）
    savePendingMemories: async (memoryKey, outcome, conversationId) => {
      const originChatKey = state.chatKeyByConversation.get(String(conversationId)) ?? "";
      let zeroStreak = 0;
      await harness.commit(async (tx) => {
        const extractedAt = now();
        if (outcome.status === "ok" && !isPatchEmpty(outcome.patch)) {
          const pending = await tx.doc(MemoryPendingDoc, memoryKey, memoryKey);
          const id = newPendingId();
          const items = splitPendingPatch(id, outcome.patch);
          pending.entries.push({
            id,
            patch: aggregatePendingItems(items),
            items,
            originChatKey,
            at: extractedAt,
            // 抽取信号（T11）：机械重算的计数，只进待审列表展示；两类都为零时不占字段
            ...(outcome.signals.people > 0 || outcome.signals.conflict > 0 ? { signals: outcome.signals } : {}),
          });
          // 待审淘汰：超上限挤掉最旧（观察期 MEMORY_PENDING_CAP=Infinity 不生效）。
          // 只打 id 与人格名，被淘汰条目的内容不进日志（隐私）
          while (pending.entries.length > MEMORY_PENDING_CAP) {
            const evicted = pending.entries.shift();
            if (evicted !== undefined) console.log(`[鱼缸] 记忆待审淘汰 ${evicted.id} ${memoryKey}`);
          }
        }
        // 空 patch 不进待审，但 lastExtractAt 照样推进（待审写入即推进）；
        // 零提取累计 / 命中清零（解析失败不进这里，不计零提取）
        const doc = await tx.doc(MemoryDoc, memoryKey, memoryKey);
        doc.lastExtractAt = extractedAt;
        const previous = typeof doc.zeroStreak === "number" ? doc.zeroStreak : 0;
        zeroStreak = outcome.status === "empty" ? previous + 1 : 0;
        doc.zeroStreak = zeroStreak;
      }, ctx);
      return { zeroStreak };
    },
  });

  return { compactor };
}
