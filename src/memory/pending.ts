import { createHash } from "node:crypto";
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

export interface PendingMemoryItem {
  /** 完整子项选择器：`${父条目id}#${两位起序号}`；首次分配后永不复用。 */
  id: string;
  /** 拆分时的全局顺序；聚合只按它排序，不按 subject 合并或猜测。 */
  order: number;
  /** 可独立 apply 的最小 patch；替代事实的 supersede 与它绑定在同一项。 */
  patch: MemoryPatch;
}

export interface PendingMemoryEntry {
  /** 代码生成的待审 id（p- + 18 位十六进制）：跨人格唯一，/记忆 同意/拒绝按它全局定位。 */
  id: string;
  /** 已 sanitize 的 patch 本体；有 items 时必须是全部剩余 items 的聚合。 */
  patch: MemoryPatch;
  /** 可独立审批的候选；旧条目缺省，读取时从 effective patch 确定性派生。 */
  items?: PendingMemoryItem[];
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

/** 公共化只在内存准备；最终事务按 selector + 原始 patch 指纹校验后直接应用。 */
export interface MemoryApprovalPreparation {
  selector: string;
  expectedFingerprint: string;
  approvedPatch: MemoryPatch;
}

export type MemoryApprovalFailureStatus = "missing" | "changed" | "expire_mismatch" | "supersede_mismatch";

/** 非 ok 批准必须回滚：tx.doc 即使只读 initial，也可能在 commit 时创建空目标 doc。 */
export class MemoryApprovalAbort extends Error {
  readonly status: MemoryApprovalFailureStatus;
  constructor(status: MemoryApprovalFailureStatus) {
    super(`memory_approval:${status}`);
    this.status = status;
  }
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
  const id = newPendingId();
  // patch 的 feedback 通道（T7）：批准 apply 时结构字段进 fact 的 kind/meta；
  // 20 条上下文只留在 feedbackContext，永不进长期 doc（决策 12）
  const patch: MemoryPatch = {
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
  };
  const items = splitPendingPatch(id, patch);
  return {
    id,
    patch: aggregatePendingItems(items),
    items,
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

/**
 * 旧 T6 条目的 entry.feedback 只在这里映射一次；含 items 的新条目以 items 为事实源。
 * 所有展示、公共化与批准都从这里取 patch，避免两条入口对旧格式各写一套兼容逻辑。
 */
export function effectivePendingPatch(entry: PendingMemoryEntry): MemoryPatch {
  if (entry.items !== undefined) return aggregatePendingItems(entry.items);
  return entry.feedback !== undefined && (entry.patch.feedback?.length ?? 0) === 0
    ? { ...entry.patch, feedback: [feedbackItemFromMeta(entry.feedback)] }
    : entry.patch;
}

/** 把一次压缩的 patch 拆成可独立批准的最小项；同 subject 的取代绑定首个新事实。 */
export function splitPendingPatch(entryId: string, patch: MemoryPatch): PendingMemoryItem[] {
  const items: PendingMemoryItem[] = [];
  const add = (itemPatch: MemoryPatch): void => {
    const order = items.length;
    items.push({
      id: `${entryId}#${String(order + 1).padStart(2, "0")}`,
      order,
      patch: cloneJson(itemPatch),
    });
  };
  const notesBySubject = new Map<string, NonNullable<MemoryPatch["supersede"]>[number][]>();
  for (const note of patch.supersede ?? []) {
    const notes = notesBySubject.get(note.subject) ?? [];
    notes.push(note);
    notesBySubject.set(note.subject, notes);
  }
  const bound = new Set<NonNullable<MemoryPatch["supersede"]>[number]>();
  for (const person of patch.people ?? []) {
    if ((person.names?.length ?? 0) > 0 || (person.style?.length ?? 0) > 0 || (person.catchphrases?.length ?? 0) > 0) {
      add({
        people: [{
          subject: person.subject,
          ...(person.names !== undefined && person.names.length > 0 ? { names: person.names } : {}),
          ...(person.style !== undefined && person.style.length > 0 ? { style: person.style } : {}),
          ...(person.catchphrases !== undefined && person.catchphrases.length > 0 ? { catchphrases: person.catchphrases } : {}),
        }],
      });
    }
    let firstFact = true;
    for (const fact of person.facts ?? []) {
      const notes = firstFact ? (notesBySubject.get(person.subject) ?? []).filter((note) => !bound.has(note)) : [];
      for (const note of notes) bound.add(note);
      add({ people: [{ subject: person.subject, facts: [fact] }], ...(notes.length > 0 ? { supersede: notes } : {}) });
      firstFact = false;
    }
  }
  for (const item of patch.lore ?? []) add({ lore: [item] });
  for (const item of patch.cards ?? []) add({ cards: [item] });
  for (const note of patch.supersede ?? []) if (!bound.has(note)) add({ supersede: [note] });
  for (const item of patch.expire ?? []) add({ expire: [item] });
  for (const item of patch.feedback ?? []) add({ feedback: [item] });
  return items;
}

/** durable draft 可能是 Proxy，structuredClone 会拒绝；显式转成普通 JSON 值再聚合。 */
function cloneJson<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

/** 唯一聚合规则：按拆分顺序拼接，不按 subject 合并，兼容旧数据里的重复 people。 */
export function aggregatePendingItems(items: PendingMemoryItem[]): MemoryPatch {
  const patch: MemoryPatch = {};
  for (const item of [...items].sort((a, b) => a.order - b.order || a.id.localeCompare(b.id))) {
    for (const value of item.patch.people ?? []) (patch.people ??= []).push(cloneJson(value));
    for (const value of item.patch.lore ?? []) (patch.lore ??= []).push(cloneJson(value));
    for (const value of item.patch.cards ?? []) (patch.cards ??= []).push(cloneJson(value));
    for (const value of item.patch.supersede ?? []) (patch.supersede ??= []).push(cloneJson(value));
    for (const value of item.patch.expire ?? []) (patch.expire ??= []).push(cloneJson(value));
    for (const value of item.patch.feedback ?? []) (patch.feedback ??= []).push(cloneJson(value));
  }
  return patch;
}

export function pendingItems(entry: PendingMemoryEntry): PendingMemoryItem[] {
  return entry.items ?? splitPendingPatch(entry.id, effectivePendingPatch(entry));
}

/** 绑定替代事实的 supersede 与独立纯失效在审批详情中使用不同文案。 */
export function pendingItemHasReplacement(item: PendingMemoryItem): boolean {
  return (item.patch.people ?? []).some((person) => (person.facts?.length ?? 0) > 0);
}

/** 旧无 items 条目也可直接选择派生子项；完整父 id 始终选择全部剩余项。 */
export function findPendingSelection(
  entries: PendingMemoryEntry[],
  selector: string,
): { entry: PendingMemoryEntry; item: PendingMemoryItem | undefined; patch: MemoryPatch } | undefined {
  const mark = selector.lastIndexOf("#");
  const parentId = mark < 0 ? selector : selector.slice(0, mark);
  const suffix = mark < 0 ? undefined : selector.slice(mark + 1);
  if (suffix !== undefined && !/^\d{2,}$/.test(suffix)) return undefined;
  const entry = entries.find((candidate) => candidate.id === parentId);
  if (!entry) return undefined;
  if (suffix === undefined) return { entry, item: undefined, patch: effectivePendingPatch(entry) };
  const item = pendingItems(entry).find((candidate) => candidate.id === selector);
  return item ? { entry, item, patch: item.patch } : undefined;
}

/** 公共化 prepare 与最终 commit 的乐观锁：对象 key 排序，数组顺序保留。 */
export function fingerprintPatch(patch: MemoryPatch): string {
  return createHash("sha256").update(JSON.stringify(canonicalValue(patch))).digest("hex");
}

function canonicalValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonicalValue);
  if (value !== null && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value)
        .filter(([, child]) => child !== undefined)
        .sort(([a], [b]) => a.localeCompare(b))
        .map(([key, child]) => [key, canonicalValue(child)]),
    );
  }
  return value;
}

/** 四个候选数组全空 = 空 patch：不进待审库，但 lastExtractAt 照样推进。 */
export function isPatchEmpty(patch: MemoryPatch): boolean {
  return (
    (patch.people?.length ?? 0) === 0 &&
    (patch.lore?.length ?? 0) === 0 &&
    (patch.cards?.length ?? 0) === 0 &&
    (patch.supersede?.length ?? 0) === 0 &&
    (patch.expire?.length ?? 0) === 0 &&
    (patch.feedback?.length ?? 0) === 0
  );
}

/**
 * EXPIRE 的批准前预检（D9）：返回目标 doc 里找不到、已失效或 subject 不符的 fact id。
 * 空数组 = 全部能在该层落地。抽成纯函数供审批链与自检脚本共用。
 */
export function missingExpireTargets(state: MemoryState | undefined, patch: MemoryPatch): string[] {
  const missing: string[] = [];
  for (const note of patch.expire ?? []) {
    const person = state?.people[note.subject];
    const hit = person?.facts.some((fact) => fact.id === note.id && fact.invalidAt === undefined) === true;
    if (!hit) missing.push(note.id);
  }
  return missing;
}

/** SUPERSEDE 同样禁止静默 no-op；目标缺失/已失效时整次批准失败并保留待审。 */
export function missingSupersedeTargets(state: MemoryState | undefined, patch: MemoryPatch): string[] {
  const missing: string[] = [];
  for (const note of patch.supersede ?? []) {
    const person = state?.people[note.subject];
    for (const id of note.ids) {
      const hit = person?.facts.some((fact) => fact.id === id && fact.invalidAt === undefined) === true;
      if (!hit) missing.push(id);
    }
  }
  return missing;
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
  if ((patch.expire?.length ?? 0) > 0) parts.push(`淘汰${patch.expire!.length}`);
  // 评价类（/评）：待审列表（npm run memory --pending）与批准回执共用这个摘要，
  // 格式与 summarizeFeedback 同构（哪条 + 哪天）
  const feedback = patch.feedback ?? [];
  if (feedback.length > 0) {
    parts.push(`评价${feedback[0].meta.direction}｜${feedback[0].meta.targetSummary}（${feedback[0].meta.day}）`);
  }
  return parts.length > 0 ? parts.join("；") : "空";
}

/** 单个子项的完整资料摘要；事实/说法/卡片等复用 summarizePatch 的原文口径。 */
export function summarizePendingItem(item: PendingMemoryItem): string {
  const people = item.patch.people ?? [];
  const hasFacts = people.some((person) => (person.facts?.length ?? 0) > 0);
  if (people.length > 0 && !hasFacts) {
    return people.map((person) => [
      person.subject,
      person.names?.join("/"),
      person.style,
      person.catchphrases?.join("/"),
    ].filter((value) => value !== undefined && value.length > 0).join(" · ")).join("；");
  }
  if ((item.patch.feedback?.length ?? 0) > 0) {
    return item.patch.feedback!.map((feedback) => `${summarizePatch({ feedback: [feedback] })} · ${feedback.text}`).join("；");
  }
  return summarizePatch(item.patch);
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
 * 在同一 writable transaction 内批准父条目或一个子项。
 * 公共化结果只通过 approvedPatch 传入，不写回 pending；expectedFingerprint 防止等待期间
 * 选择集合变化后应用旧脱敏快照。失效预检、apply 与 pending 删除同成同败。
 * 返回值只含纯值，调用方不得在 commit 外读取 draft。
 */
export function approvePending(
  pending: PendingMemoryState,
  selector: string,
  target: MemoryState,
  at: number,
  options?: { expectedFingerprint?: string; approvedPatch?: MemoryPatch },
): { status: "ok"; digest: string; remaining: number; originChatKey: string }
  | { status: "missing" | "changed" | "expire_mismatch" | "supersede_mismatch" } {
  const selection = findPendingSelection(pending.entries, selector);
  if (!selection) return { status: "missing" };
  const { entry, item, patch } = selection;
  if (options?.expectedFingerprint !== undefined && fingerprintPatch(patch) !== options.expectedFingerprint) {
    return { status: "changed" };
  }
  if (missingExpireTargets(target, patch).length > 0) return { status: "expire_mismatch" };
  if (missingSupersedeTargets(target, patch).length > 0) return { status: "supersede_mismatch" };
  const appliedPatch = options?.approvedPatch ?? patch;
  const next = applyPatch(target, appliedPatch, at, entry.originChatKey || undefined);
  target.people = next.people;
  target.lore = next.lore;
  target.cards = next.cards;
  if (next.feedback !== undefined) target.feedback = next.feedback;

  const index = pending.entries.findIndex((candidate) => candidate.id === entry.id);
  let remaining = 0;
  if (item === undefined) {
    pending.entries.splice(index, 1);
  } else {
    const remainingItems = pendingItems(entry).filter((candidate) => candidate.id !== item.id);
    remaining = remainingItems.length;
    if (remainingItems.length === 0) pending.entries.splice(index, 1);
    else {
      entry.items = remainingItems;
      entry.patch = aggregatePendingItems(remainingItems);
    }
  }
  return {
    status: "ok",
    digest: summarizePatch(appliedPatch),
    remaining,
    originChatKey: entry.originChatKey,
  };
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

