/**
 * installMemoryAdmin：待审记忆的查看/同意/拒绝/删除与 /记忆 机械回执
 * （2026-11-05 从 harness.ts 拆出）。
 *
 * 全局单视图：所有注册人格的待审 doc 都看；人格书被删后残留的待审 doc 这里看不到
 * （用 npm run memory -- --pending 查）。id 生成时即跨人格唯一（72 位随机），
 * /记忆 同意/拒绝按 id 全局定位。
 */
import type { Harness } from "@earendil-works/pi-durable";
import {
  approvePending,
  deleteFactById,
  formatAgeShort,
  hasFact,
  rejectPending,
  signalsSuffix,
  summarizeFeedback,
  summarizePatch,
  MEMORY_PENDING_CAP,
  MEMORY_ZERO_EXTRACT_PAGES,
  type MemoryCommand,
  type PendingMemoryEntry,
} from "../memory/index.ts";
import { privateMemoryKeyOf } from "../memory/scope.ts";
import { renderTemplate } from "../prompt/index.ts";
import { ChatsDoc, MemoryDoc, MemoryPendingDoc, MemoryPrivateDoc } from "../store.ts";
import type { FishBase } from "./base.ts";
import { DEFAULT_PERSONA } from "./types.ts";

export interface MemoryAdminParts {
  pendingMemories(): Promise<{ persona: string; entries: PendingMemoryEntry[] }[]>;
  approveMemory(id: string, track: "公共" | "私有"): Promise<
    { status: "ok"; track: "公共" | "私有"; persona: string; originChatKey: string; digest: string }
      | { status: "missing" | "no_origin" }
  >;
  rejectMemory(id: string | "all"): Promise<number>;
  memoryCommandReply(chatKey: string, command: MemoryCommand): Promise<string>;
}

export function installMemoryAdmin(state: FishBase & { harness: Harness }): MemoryAdminParts {
  const { harness, prompts, ctx, now } = state;
  const personaKeys = [DEFAULT_PERSONA, ...Object.keys(prompts.personas)];

  async function pendingMemoriesLocal(): Promise<{ persona: string; entries: PendingMemoryEntry[] }[]> {
    const views: { persona: string; entries: PendingMemoryEntry[] }[] = [];
    for (const persona of personaKeys) {
      const snapshot = await harness.snapshot(MemoryPendingDoc, persona, ctx);
      const entries = [...(snapshot?.entries ?? [])].sort((a, b) => a.at - b.at);
      if (entries.length > 0) views.push({ persona, entries });
    }
    return views;
  }

  async function approveMemoryLocal(id: string, track: "公共" | "私有") {
    for (const persona of personaKeys) {
      const snapshot = await harness.snapshot(MemoryPendingDoc, persona, ctx);
      const entry = snapshot?.entries.find((item) => item.id === id);
      if (!entry) continue;
      if (track === "私有" && !entry.originChatKey) return { status: "no_origin" as const };
      const targetKey = track === "私有" ? privateMemoryKeyOf(persona, entry.originChatKey) : persona;
      const digest = summarizePatch(entry.patch);
      const originChatKey = entry.originChatKey;
      try {
        await harness.commit(async (tx) => {
          const pending = await tx.doc(MemoryPendingDoc, persona, persona);
          const target = await tx.doc(track === "私有" ? MemoryPrivateDoc : MemoryDoc, targetKey, targetKey);
          const result = approvePending(pending, id, target, now());
          if (result.status === "missing") throw new Error("memory_pending_missing");
        }, ctx);
      } catch (error) {
        // 并发下条目刚好被批掉：回 missing；其它错误照实抛给宿主日志
        if (error instanceof Error && error.message === "memory_pending_missing") return { status: "missing" as const };
        throw error;
      }
      return { status: "ok" as const, track, persona, originChatKey, digest };
    }
    return { status: "missing" as const };
  }

  async function rejectMemoryLocal(id: string | "all"): Promise<number> {
    let removed = 0;
    for (const persona of personaKeys) {
      const snapshot = await harness.snapshot(MemoryPendingDoc, persona, ctx);
      if (!snapshot || snapshot.entries.length === 0) continue;
      if (id !== "all" && !snapshot.entries.some((item) => item.id === id)) continue;
      await harness.commit(async (tx) => {
        const pending = await tx.doc(MemoryPendingDoc, persona, persona);
        removed += rejectPending(pending, id);
      }, ctx);
    }
    return removed;
  }

  /** 某人格的全部私有层 doc key（人格名@chatKey）：从 ChatsDoc 的映射键推导（chatKey 或
   *  chatKey#人格 → 人格@chatKey）。known 是公共+当前私有的合并渲染（T11），supersede
   *  id 可能指向私有层事实，/记忆 的「将失效」原文查找要覆盖它们。 */
  async function privateKeysOf(persona: string): Promise<string[]> {
    const chats = await harness.snapshot(ChatsDoc, ctx);
    const keys = new Set<string>();
    for (const mappingKey of Object.keys(chats?.chats ?? {})) {
      const mark = mappingKey.lastIndexOf("#");
      const owner = mark > 0 ? mappingKey.slice(mark + 1) : DEFAULT_PERSONA;
      const base = mark > 0 ? mappingKey.slice(0, mark) : mappingKey;
      if (owner === persona) keys.add(`${persona}@${base}`);
    }
    return [...keys];
  }

  /** 删除通道（/记忆 删除，仅主人私聊）：按全局唯一的 fact id 在该人格公共层与全部
   * 私有层 doc 里定位并真删除（从数组移除，区别于 supersede 的 invalidAt 失效）。
   * 私有层候选 key 由 ChatsDoc 的映射键推导（chatKey 或 chatKey#人格 → 人格@chatKey）；
   * 人格书已删的残留 doc 只有 scripts/memory.ts --delete 能查到。宿主日志只带
   * id 与所在 doc key，不打印记忆内容。 */
  async function deleteMemoryLocal(id: string): Promise<{ status: "ok"; doc: string } | { status: "missing" }> {
    const chats = await harness.snapshot(ChatsDoc, ctx);
    const privateKeys = new Set<string>();
    for (const mappingKey of Object.keys(chats?.chats ?? {})) {
      const mark = mappingKey.lastIndexOf("#");
      const persona = mark > 0 ? mappingKey.slice(mark + 1) : DEFAULT_PERSONA;
      const base = mark > 0 ? mappingKey.slice(0, mark) : mappingKey;
      privateKeys.add(`${persona}@${base}`);
    }
    const candidates: { token: typeof MemoryDoc | typeof MemoryPrivateDoc; key: string }[] = [
      ...personaKeys.map((persona) => ({ token: MemoryDoc as typeof MemoryDoc, key: persona })),
      ...[...privateKeys].map((key) => ({ token: MemoryPrivateDoc as typeof MemoryPrivateDoc, key })),
    ];
    for (const candidate of candidates) {
      const snapshot = await harness.snapshot(candidate.token, candidate.key, ctx);
      if (!snapshot || !hasFact(snapshot, id)) continue;
      const removed = await harness.commit(async (tx) => {
        const doc = await tx.doc(candidate.token, candidate.key, candidate.key);
        return deleteFactById(doc, id);
      }, ctx);
      if (removed) {
        console.log(`[鱼缸] 记忆删除 ${id} ${candidate.key}`);
        return { status: "ok", doc: candidate.key };
      }
      // 并发下刚好被删掉：继续找下一候选
    }
    return { status: "missing" };
  }

  async function memoryCommandReply(chatKey: string, command: MemoryCommand): Promise<string> {
    const messages = prompts.messages;
    // 群内 /记忆 一律只回引导语：无任何副作用（不预选、不过滤、不列部分内容）
    if (chatKey.startsWith("qq:group:")) return messages["cmd_memory_group"] ?? "";
    if (command.kind === "usage") return messages["cmd_memory_usage"] ?? "";
    if (command.kind === "approve") {
      const result = await approveMemoryLocal(command.id, command.track);
      if (result.status === "missing") return renderTemplate(messages["cmd_memory_missing"] ?? "", { id: command.id });
      if (result.status === "no_origin") return renderTemplate(messages["cmd_memory_no_origin"] ?? "", { id: command.id });
      return renderTemplate(messages["cmd_memory_ok"] ?? "", { track: result.track, digest: result.digest });
    }
    if (command.kind === "reject") {
      const removed = await rejectMemoryLocal(command.id);
      if (removed === 0) return renderTemplate(messages["cmd_memory_missing"] ?? "", { id: command.id });
      return command.all
        ? renderTemplate(messages["cmd_memory_rejected_all"] ?? "", { count: String(removed) })
        : renderTemplate(messages["cmd_memory_rejected"] ?? "", { id: command.id });
    }
    if (command.kind === "delete") {
      // 真删除：从公共层与全部私有层 doc 里按全局唯一 id 定位并移除；日志在 deleteMemoryLocal 里
      const result = await deleteMemoryLocal(command.id);
      if (result.status === "missing") return renderTemplate(messages["cmd_memory_delete_missing"] ?? "", { id: command.id });
      return renderTemplate(messages["cmd_memory_deleted"] ?? "", { id: command.id, doc: result.doc });
    }
    // 列表：全局单视图（所有人格），最旧在前——最先会被淘汰的排最前，头部给汇总行。
    // 含 supersede 的条目附「将失效」行：原文从该人格公共 doc 与各私有 doc 现查
    // （T11 起 known 是公共+当前私有的合并渲染，supersede id 可能指向私有层事实；
    // 查不到就只标 id）
    const views = await pendingMemoriesLocal();
    const entries = views
      .flatMap((view) => view.entries.map((entry) => ({ entry, persona: view.persona })))
      .sort((a, b) => a.entry.at - b.entry.at);
    // 零提取头部提示（T11）：全部注册人格里，连续零提取达阈值（常量 5）的在汇总头部
    // 各打一行——抽取器长期零产出时主人应该第一眼看到（哪怕当前没有待审条目）
    const zeroHints: string[] = [];
    for (const persona of personaKeys) {
      const snapshot = await harness.snapshot(MemoryDoc, persona, ctx);
      const streak = snapshot?.zeroStreak ?? 0;
      if (streak >= MEMORY_ZERO_EXTRACT_PAGES) {
        zeroHints.push(renderTemplate(messages["cmd_memory_zero_extract"] ?? "", { pages: String(streak), persona }));
      }
    }
    if (entries.length === 0) {
      return zeroHints.length > 0 ? [...zeroHints, messages["cmd_memory_empty"] ?? ""].join("\n") : messages["cmd_memory_empty"] ?? "";
    }
    const header = renderTemplate(messages["cmd_memory_list_header"] ?? "", {
      count: String(entries.length),
      age: formatAgeShort(now() - entries[0].entry.at),
    });
    // fact id → 原文：公共 doc + 该人格全部私有 doc（ChatsDoc 映射键推导 persona@chatKey）
    const factTexts = new Map<string, Map<string, string>>();
    const factTextOf = async (persona: string, id: string): Promise<string> => {
      let table = factTexts.get(persona);
      if (!table) {
        table = new Map(
          Object.values((await harness.snapshot(MemoryDoc, persona, ctx))?.people ?? {}).flatMap((person) =>
            person.facts.map((fact) => [fact.id, fact.text] as const),
          ),
        );
        for (const privKey of await privateKeysOf(persona)) {
          const priv = await harness.snapshot(MemoryPrivateDoc, privKey, ctx);
          for (const person of Object.values(priv?.people ?? {})) {
            for (const fact of person.facts) if (!table.has(fact.id)) table.set(fact.id, fact.text);
          }
        }
        factTexts.set(persona, table);
      }
      return table.get(id) ?? "";
    };
    const shown = entries.slice(0, 30);
    const lines: string[] = [];
    for (const { entry, persona } of shown) {
      lines.push(
        renderTemplate(messages["cmd_memory_entry"] ?? "", {
          id: entry.id,
          persona,
          origin: entry.originChatKey || "-",
          age: formatAgeShort(now() - entry.at),
          // 评价类待审（/评）展示关联摘要：哪条（targetSummary）+ 哪天；哪群在 origin 列里；
          // 引用链查不到的评价保留「被引消息不可回溯」标注（终验 #6，文案 key 化）；
          // 普通抽取条目附 signal 标签（T11：已知人物/事实冲突，机械重算的计数）
          digest: (entry.feedback
            ? summarizeFeedback(entry.feedback)
              + (entry.feedback.quotedFromMissing === true ? messages["memory_feedback_missing_quote"] ?? "" : "")
            : summarizePatch(entry.patch)) + signalsSuffix(entry.signals),
        }),
      );
      for (const note of entry.patch.supersede ?? []) {
        for (const id of note.ids) {
          const text = await factTextOf(persona, id);
          lines.push(renderTemplate(messages["cmd_memory_supersede_note"] ?? "", { id, text: text || "-" }));
        }
      }
    }
    const rest = entries.length - shown.length;
    return [
      header,
      ...zeroHints,
      ...lines,
      ...(rest > 0 ? [renderTemplate(messages["cmd_memory_more"] ?? "", { count: String(rest) })] : []),
    ].join("\n");
  }

  return { pendingMemories: pendingMemoriesLocal, approveMemory: approveMemoryLocal, rejectMemory: rejectMemoryLocal, memoryCommandReply };
}
