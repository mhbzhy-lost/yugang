import {
  FEEDBACK_MASTER_TEXT_CHARS,
  FEEDBACK_TARGET_SUMMARY_CHARS,
  newPendingId,
  type ExtractSignals,
  type FeedbackContextItem,
  type FeedbackFactMeta,
  type FeedbackMeta,
  type MemoryPatch,
  type MemoryState,
} from "./model.ts";
import { applyPatch } from "./patch.ts";

export interface PendingMemoryEntry {
  /** 代码生成的待审 id（p- + 18 位十六进制）：跨人格唯一，/记忆 同意/拒绝按它全局定位。 */
  id: string;
  /** 已 sanitize 的 patch 本体。 */
  patch: MemoryPatch;
  /** 来源会话的原始 chatKey（批准为「私有」时并入 人格名@该 chatKey 的私有 doc）。 */
  originChatKey: string;
  at: number;
  /** 评价类待审（/评，T6）：结构化元数据；批准时由审批链（T7）映射进 fact 的 kind/meta。 */
  feedback?: FeedbackMeta;
  /** 评价包的前 20 条会话全文：只存待审，批准后不进任何长期 doc（决策 12）。 */
  feedbackContext?: FeedbackContextItem[];
  /** 抽取信号（T11）：机械重算的候选信号计数，待审列表（/记忆 与 npm run memory --pending）展示用。 */
  signals?: ExtractSignals;
}

/** 待审库（fish.memory.pending）的 doc 值：每人格一个 family member，条目按时间正序。 */
export interface PendingMemoryState {
  version: 1;
  entries: PendingMemoryEntry[];
}

/**
 * 装配 /评 的待审条目（好差同构，方向只是字段）：评价内容在 feedback /
 * feedbackContext（/记忆 列表展示用）与 patch 的 feedback 通道（批准 apply 时映射进
 * fact 的 kind/meta，也让待审列表与批准回执的 summarizePatch 能出 meta 摘要）里
 * 各存一份；输入在本函数内机械截断（targetSummary / masterText / quotedFrom）。
 */
export function buildFeedbackPending(input: {
  direction: "好" | "差";
  targetSummary: string;
  statsLine: string;
  quotedFrom?: string;
  /** 引用链缺失的显式标注（终审 #6）：true 时待审 feedback 结构带上 quotedFromMissing，
   *  /记忆 列表据此展示「被引消息不可回溯」。 */
  quotedFromMissing?: true;
  context: FeedbackContextItem[];
  originChatKey: string;
  chatKey: string;
  persona: string;
  day: string;
  masterText: string;
  at: number;
}): PendingMemoryEntry {
  const clip = (text: string, max: number): string => text.replace(/[\u0000-\u001F\u007F]/g, "").trim().slice(0, max);
  const quoted = input.quotedFrom !== undefined ? clip(input.quotedFrom, 40) : undefined;
  return {
    id: newPendingId(),
    // patch 的 feedback 通道（T7）：批准 apply 时结构字段进 fact 的 kind/meta；
    // 20 条上下文只留在 feedbackContext，永不进长期 doc（决策 12）
    patch: {
      feedback: [
        {
          text: clip(input.masterText, FEEDBACK_MASTER_TEXT_CHARS),
          meta: {
            direction: input.direction,
            targetSummary: clip(input.targetSummary, FEEDBACK_TARGET_SUMMARY_CHARS),
            statsLine: clip(input.statsLine, 120),
            day: input.day,
          },
        },
      ],
    },
    originChatKey: input.originChatKey,
    at: input.at,
    feedback: {
      kind: "feedback",
      direction: input.direction,
      targetSummary: clip(input.targetSummary, FEEDBACK_TARGET_SUMMARY_CHARS),
      statsLine: clip(input.statsLine, 120),
      ...(quoted && quoted.length > 0 ? { quotedFrom: quoted } : {}),
      ...(input.quotedFromMissing === true ? { quotedFromMissing: true as const } : {}),
      contextRefs: input.context.map((item) => item.ref),
      chatKey: input.chatKey,
      persona: input.persona,
      day: input.day,
      masterText: clip(input.masterText, FEEDBACK_MASTER_TEXT_CHARS),
    },
    feedbackContext: input.context,
  };
}

/** 评价类待审条目的摘要（/记忆 列表与脚本共用）：哪条（targetSummary）+ 哪天；哪群在列表行模板里。 */
export function summarizeFeedback(meta: FeedbackMeta): string {
  return `评价${meta.direction}｜${meta.targetSummary}（${meta.day}）`;
}

/** 待审列表的 signal 标签（主人回执，非模型文案）：两类机械信号计数；零或缺失时返回空串。 */
export function signalsSuffix(signals: ExtractSignals | undefined): string {
  if (!signals || (signals.people <= 0 && signals.conflict <= 0)) return "";
  const parts: string[] = [];
  if (signals.people > 0) parts.push(`已知人物×${signals.people}`);
  if (signals.conflict > 0) parts.push(`事实冲突×${signals.conflict}`);
  return `（信号：${parts.join("、")}）`;
}

/**
 * 待审队列每人格上限：淘汰逻辑与日志都在，改小即恢复淘汰。
 * 观察期（2026-11）暂不设上限——先看积累速度，定了再改这个常量。
 */
export const MEMORY_PENDING_CAP: number = Infinity;

export function emptyPendingMemory(): PendingMemoryState {
  return { version: 1, entries: [] };
}

/** 四个候选数组全空 = 空 patch：不进待审库，但 lastExtractAt 照样推进。 */
export function isPatchEmpty(patch: MemoryPatch): boolean {
  return (
    (patch.people?.length ?? 0) === 0 &&
    (patch.lore?.length ?? 0) === 0 &&
    (patch.cards?.length ?? 0) === 0 &&
    (patch.supersede?.length ?? 0) === 0 &&
    (patch.feedback?.length ?? 0) === 0
  );
}

/**
 * 待审条目的内容摘要（给主人看的机械回执，不是模型文案）：
 * 计数 + 首个样本，来源人格与来源会话由调用方另行标注。
 */
export function summarizePatch(patch: MemoryPatch): string {
  const parts: string[] = [];
  const people = patch.people ?? [];
  const lore = patch.lore ?? [];
  const cards = patch.cards ?? [];
  if (people.length > 0) {
    const who = people[0].names?.[0] ?? people[0].subject;
    const sample = people[0].facts?.[0]?.text ?? people[0].style ?? "";
    parts.push(`人${people.length}｜${who}${sample ? ` ${sample}` : ""}`);
  }
  if (lore.length > 0) parts.push(`说法${lore.length}｜${lore[0].keys.join("/")} ${lore[0].text}`);
  if (cards.length > 0) parts.push(`卡片${cards.length}｜${cards[0].text}`);
  if ((patch.supersede?.length ?? 0) > 0) parts.push(`取代${patch.supersede!.length}`);
  // 评价类（/评）：待审列表（npm run memory --pending）与批准回执共用这个摘要，
  // 格式与 summarizeFeedback 同构（哪条 + 哪天）
  const feedback = patch.feedback ?? [];
  if (feedback.length > 0) {
    parts.push(`评价${feedback[0].meta.direction}｜${feedback[0].meta.targetSummary}（${feedback[0].meta.day}）`);
  }
  return parts.length > 0 ? parts.join("；") : "空";
}

/** 年龄短格式（Xh Ym / Xd Yh / Xm）：/记忆 头部汇总与脚本 --pending 共用。 */
export function formatAgeShort(ms: number): string {
  const minutes = Math.max(0, Math.floor(ms / 60_000));
  if (minutes < 1) return "0m";
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ${minutes % 60}m`;
  const days = Math.floor(hours / 24);
  return `${days}d ${hours % 24}h`;
}

/**
 * 同意一条待审：从待审 doc 摘掉该条，把 patch apply 进目标 doc（公共或私有）。
 * 来源会话（entry.originChatKey）作为 fromChat 注入，写进新 fact——溯源字段不由模型决定。
 * 评价类条目（/评）：patch.feedback 通道在 apply 时落成 kind="feedback" 的 fact；
 * T6 存量待审（patch 为空、结构在 entry.feedback 上）在这里映射进去。
 * 直接改写两个 draft（pi-durable 的 tx.doc 返回值就是可写 draft）；找不到该 id 返回 missing。
 */
export function approvePending(
  pending: PendingMemoryState,
  id: string,
  target: MemoryState,
  at: number,
): { status: "ok"; entry: PendingMemoryEntry } | { status: "missing" } {
  const index = pending.entries.findIndex((entry) => entry.id === id);
  if (index < 0) return { status: "missing" };
  const [entry] = pending.entries.splice(index, 1);
  // T6 存量评价待审：patch 为空、评价包在 entry.feedback 上——映射进 patch 的
  // feedback 通道再 apply；新装配（buildFeedbackPending）已直接写进 patch.feedback
  const patch = entry.feedback !== undefined && (entry.patch.feedback?.length ?? 0) === 0
    ? { ...entry.patch, feedback: [feedbackItemFromMeta(entry.feedback)] }
    : entry.patch;
  const next = applyPatch(target, patch, at, entry.originChatKey || undefined);
  target.people = next.people;
  target.lore = next.lore;
  target.cards = next.cards;
  if (next.feedback !== undefined) target.feedback = next.feedback;
  return { status: "ok", entry };
}

/** T6 存量待审条目（feedback 在条目上、patch 为空）→ patch.feedback 通道的映射。 */
function feedbackItemFromMeta(meta: FeedbackMeta): { text: string; meta: FeedbackFactMeta } {
  return {
    text: meta.masterText,
    meta: { direction: meta.direction, targetSummary: meta.targetSummary, statsLine: meta.statsLine, day: meta.day },
  };
}

/** 拒绝待审：单条 id 或 "all"（该 doc 全部）；返回删掉的条数。 */
export function rejectPending(pending: PendingMemoryState, id: string | "all"): number {
  const before = pending.entries.length;
  if (id === "all") pending.entries = [];
  else pending.entries = pending.entries.filter((entry) => entry.id !== id);
  return before - pending.entries.length;
}

