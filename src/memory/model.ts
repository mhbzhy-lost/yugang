/**
 * 长期记忆的数据模型、上限与渲染。
 *
 * 记忆存成 session 级 keyed document family（见 store.ts）：公共层 fish.memory
 * （key=人格名，默认人格为「默认」，见 memory-scope.ts 的 memoryKeyOf）与私有层
 * fish.memory.private（key=人格名@chatKey，仅该人格在来源会话可见）。写入入口只有
 * 审批通道（/记忆 指令与 scripts/memory.ts 的 --approve/--reject/--delete）：压缩链路只把
 * 抽取 patch 写进待审库 fish.memory.pending，未批准内容不进任何记忆 doc。
 * 渲染入口只有 system section（harness.ts）：公共 + 本会话私有两层合并渲染。
 *
 * 安全边界（改动 section 或 transcript 白名单前必读）：
 *   - 记忆只经 system section 注入，绝不进 user message；
 *   - 抽取只读结构化原始 entry（fish.inbound / fish.outbound），
 *     必须继续排除 pi.system、宿主任务文案和工具结果，否则自我污染闭环会复活；
 *   - renderMemory 只读，不写回任何字段（不写 lastUsedAt，不改 hits）；
 *   - 评价 fact（kind="feedback"）只由审批链机器装配（MemoryPatch.feedback 通道），
 *     抽取器不产（sanitizePatch 结构性忽略模型输出里的 feedback 键）；渲染加权置顶
 *     但不豁免任何上限，渲染期同样零写入；
 *   - applyPatch 必须深拷贝输入，不得原地改写 doc 或调用方状态；
 *   - 上限在 MEMORY_CAPS 里机械执行，任何 patch 施加后都不超上限。
 */
import { randomBytes } from "node:crypto";
import { defineEntry } from "@earendil-works/pi-durable";

export type FactSource = "stated" | "observed" | "reported";

/**
 * 评价 fact 的持久化 meta（FeedbackMeta 的持久化子集，决策 12）：长期 doc 只存
 * 方向 + 被评短摘要 + 统计一行 + 评价日期；quotedFrom / contextRefs / 20 条上下文 /
 * chatKey / persona 都不进长期 doc（只留待审条目），主人评语原文进 fact.text。
 */
export interface FeedbackFactMeta {
  direction: "好" | "差";
  /** 被评对象短摘要（≤ FEEDBACK_TARGET_SUMMARY_CHARS）。 */
  targetSummary: string;
  /** 当日统计一行（口径随文写明）。 */
  statsLine: string;
  /** 本地日期 YYYY-MM-DD（评价发生日，非批准日）。 */
  day: string;
}

export interface MemoryFact {
  id: string;
  subject: string;
  text: string;
  at: number;
  /** 被 supersede 命中后的失效时间；有效事实没有这个字段。 */
  invalidAt?: number;
  /** 审计链：取代它的那条新 fact 的 id（supersede 生效时由 applyPatch 回填）。 */
  supersededBy?: string;
  source: FactSource;
  /** reported 来源的转述人 subject。 */
  by?: string;
  /** 来源会话 chatKey：批准路径由宿主注入（待审条目的 originChatKey），不由模型决定。 */
  fromChat?: string;
  hits: number;
  /** 评价类 fact（/评 批准落地）：渲染加权置顶的唯一 kind，仅审批链机器装配。 */
  kind?: "feedback";
  /** 评价 fact 的持久化元数据（kind="feedback" 时必有）。 */
  meta?: FeedbackFactMeta;
}

export interface MemoryPerson {
  subject: string;
  names: string[];
  facts: MemoryFact[];
  style?: string;
  catchphrases: string[];
  updatedAt: number;
}

export interface MemoryCard {
  id: string;
  at: number;
  text: string;
  importance: number;
  keys: string[];
  subjects: string[];
}

export interface MemoryLore {
  id: string;
  keys: string[];
  text: string;
  kind: "word" | "meme" | "rule";
  at: number;
  hits: number;
}

export interface MemoryState {
  version: 1;
  people: Record<string, MemoryPerson>;
  lore: MemoryLore[];
  cards: MemoryCard[];
  /** 主人评价 fact（/评 批准落地）：自指记忆，独立于 people；渲染加权置顶。 */
  feedback?: MemoryFact[];
  lastExtractAt?: number;
  /** 连续零提取页数（T11 抽取评价）：成功抽取出候选即清零，解析失败不动它。
   *  计数持久化在公共 doc（key=人格名），达 MEMORY_ZERO_EXTRACT_PAGES 触发一次复查
   *  与 /记忆 头部提示；由压缩链路的 savePendingMemories 读写。 */
  zeroStreak?: number;
}

export interface MemoryPatchPerson {
  subject: string;
  names?: string[];
  facts?: { text: string; source: FactSource; by?: string }[];
  style?: string;
  catchphrases?: string[];
}

export interface MemoryPatch {
  people?: MemoryPatchPerson[];
  lore?: { keys: string[]; text: string; kind: "word" | "meme" | "rule" }[];
  cards?: { text: string; importance: number; keys: string[]; subjects: string[] }[];
  supersede?: { subject: string; ids: string[] }[];
  /** 评价类（/评）：机器装配通道（buildFeedbackPending；T6 存量待审批准时由
   *  approvePending 映射）。抽取器不产——sanitizePatch 不读模型输出里的 feedback 键。 */
  feedback?: { text: string; meta: FeedbackFactMeta }[];
}

/** 评价包（/评）的机械上限：装配（buildFeedbackPending）与批准 apply 同源消费。 */
export const FEEDBACK_TARGET_SUMMARY_CHARS = 20;
export const FEEDBACK_MASTER_TEXT_CHARS = 200;

/**
 * 硬上限：写死在代码里，机械执行。
 * renderChars 是单次 section 渲染总长；knownChars 是喂给抽取器的已知记忆输入上限。
 */
export const MEMORY_CAPS: {
  people: number;
  factsPerPerson: number;
  textPerPerson: number;
  namesPerPerson: number;
  styleChars: number;
  catchphrasesPerPerson: number;
  catchphraseChars: number;
  lore: number;
  loreKeys: number;
  loreKeyChars: number;
  loreTextChars: number;
  cards: number;
  cardKeys: number;
  cardSubjects: number;
  cardTextChars: number;
  renderChars: number;
  knownChars: number;
  feedback: number;
  feedbackTextChars: number;
  feedbackTargetSummaryChars: number;
  feedbackStatsLineChars: number;
  feedbackRender: number;
} = {
  people: 12,
  factsPerPerson: 8,
  textPerPerson: 320,
  namesPerPerson: 5,
  styleChars: 120,
  catchphrasesPerPerson: 8,
  catchphraseChars: 24,
  lore: 40,
  loreKeys: 5,
  loreKeyChars: 10,
  loreTextChars: 60,
  cards: 60,
  cardKeys: 5,
  cardSubjects: 8,
  cardTextChars: 80,
  renderChars: 900,
  knownChars: 8000,
  // 评价 fact 的独立上限（决策 12）：feedback 不豁免 MEMORY_CAPS，淘汰照 at+hits 机械口径
  feedback: 20,
  feedbackTextChars: FEEDBACK_MASTER_TEXT_CHARS,
  feedbackTargetSummaryChars: FEEDBACK_TARGET_SUMMARY_CHARS,
  feedbackStatsLineChars: 120,
  feedbackRender: 3,
};

/** 单条 fact 文本上限（抽取提示词同值：facts 每条一句话）。 */
export const FACT_TEXT_CHARS = 40;

/**
 * 连续零提取页数阈值（T11，决策 17）：按人格累计，达阈值触发一次复查模式
 * （宽松提示词重跑本页，只一次不循环；失败不清计数、不阻塞换页）与
 * /记忆 待审头部的「近 N 页零提取」提示。常量写死，暂不配置化。
 */
export const MEMORY_ZERO_EXTRACT_PAGES = 5;

/**
 * 待审条目携带的抽取信号（T11）：两类机械可得项的计数——代码从 known 与候选
 * 本身机械重算，不采信模型输出里的 signal 标注；只进待审列表展示，不参与 apply。
 */
export interface ExtractSignals {
  /** 「命中 people 名单」：候选主体在已知记忆（公共+当前私有合并）的人物名单里。 */
  people: number;
  /** 「与现有 fact 冲突」：SUPERSEDE 候选且 factId 在已知事实里机械解析成功。 */
  conflict: number;
}

/** 渲染段预算：群里的说法 ≤200，单人 ≤240，卡片 ≤240，主人评价 ≤300。 */
/** 结构化入站 entry：记忆抽取只读它，不读宿主拼装的 user content。 */
export interface MemoryInbound {
  chatKey: string;
  userId: string;
  nickname: string;
  text: string;
}

export const MEMORY_INBOUND_KIND = "fish.inbound";
export const MEMORY_GIF_KIND = "fish.gif_ingest";

// ── 主人评价（/评，T6）的类型与契约 ────────────────────────────────────────

/** 主人评价事件 entry 的 kind（决策 11b）：书记性 entry（无 model 字段，不进模型上下文），
 *  进记忆抽取白名单（compact.renderMemoryTranscript）、排除摘要（renderCountedEntries）。 */
export const MEMORY_EVAL_KIND = "fish.eval";

/** /评 评价包里「前 20 条会话摘要」的一条：只从结构化 entry（fish.inbound / fish.outbound）
 *  组装，不从宿主渲染文本反解析；ref = 对应 transcript entry 的 id（即 FeedbackMeta.contextRefs）。 */
export interface FeedbackContextItem {
  ref: string;
  /** fish = 鱼的发言；member = 群友原话。 */
  role: "fish" | "member";
  /** member 的 QQ 号（fish 时缺省）。 */
  qq?: string;
  /** member 的昵称（fish 时缺省）。 */
  nickname?: string;
  /** 摘要文本（已截断）。 */
  text: string;
}

/** 被评 outbound 条目的快照（含引用链锚点 quoteId）。 */
export interface EvalTargetSnapshot {
  entryId: number;
  at: number;
  items: string[];
  media?: string;
  voice?: string;
  quoteId?: number | string;
}

/** fish.eval entry 的结构化载荷：评价事件全量快照（好差同构，方向只是字段）。 */
export interface EvalEventData {
  direction: "好" | "差";
  /** 主人评语原文（≤ FEEDBACK_MASTER_TEXT_CHARS）。 */
  masterText: string;
  /** 被评对象短摘要（≤ FEEDBACK_TARGET_SUMMARY_CHARS）。 */
  targetSummary: string;
  /** 指向型定位是否降级（sentmap 未命中，按最近一条 outbound 评价）。 */
  degraded: boolean;
  target?: EvalTargetSnapshot;
  /** 引用链：鱼当时回的那条原始消息（按 quoteId 从 recent 解析）；不可得时缺省 = 标注缺失。 */
  quotedFrom?: { qq: string; nickname: string; text: string };
  /** 引用链缺失的显式标注（终审 #6）：true = 这次评价没有可回溯的引用链（sentmap 未命中、
   *  私聊/语音出口不在 sentmap、recent 里查不到被引原文），与「没带 quotedFrom 字段」区分开。 */
  quotedFromMissing?: true;
  /** 前 20 条会话摘要（结构化）。 */
  context: FeedbackContextItem[];
  /** 涉及群员清单（被引消息作者 + 上下文成员，结构化快照）。 */
  members: { qq: string; nickname: string }[];
  chatKey: string;
  persona: string;
  /** 本地日期 YYYY-MM-DD。 */
  day: string;
}

/** fish.eval 的 typed entry token（宿主 appendEntry 用，data = EvalEventData）。 */
export const MemoryEvalEntry = defineEntry<EvalEventData>(MEMORY_EVAL_KIND);

/**
 * 主人评价（/评）的结构化元数据——**T7（feedback 数据模型与渲染加权）的输入契约，冻结于
 * 2026-11-02**：批准 apply 时评价包结构字段进 MemoryFact.meta（决策 12：长期 doc 只存
 * target 短摘要 + 统计一行；20 条上下文全文只留在待审条目的 feedbackContext，不进长期 doc；
 * 公共化脱敏对 meta 结构同构保留）。
 * 上限机械执行：targetSummary ≤ FEEDBACK_TARGET_SUMMARY_CHARS（20）、
 * masterText ≤ FEEDBACK_MASTER_TEXT_CHARS（200）；超出部分装配时截断。
 */
export interface FeedbackMeta {
  kind: "feedback";
  direction: "好" | "差";
  /** 被评对象短摘要（≤20 字；指向型 = 被评发言首句截断，范围型 = 当日整体表现）。 */
  targetSummary: string;
  /** 当日统计一行（口径随文写明）。 */
  statsLine: string;
  /** 引用链摘要（鱼当时回的那条原始消息，短字符串）；不可得时缺省 = 标注缺失。 */
  quotedFrom?: string;
  /** 引用链缺失的显式标注（终审 #6）：与 quotedFrom 互斥，/记忆 列表按它补「被引消息不可回溯」。
   *  只留在待审条目上（展示用），不进长期 doc（FeedbackFactMeta 保持冻结口径）。 */
  quotedFromMissing?: true;
  /** 前 20 条会话的 entry 引用（内容全文在待审条目的 feedbackContext）。 */
  contextRefs: string[];
  chatKey: string;
  persona: string;
  /** 本地日期 YYYY-MM-DD。 */
  day: string;
  /** 主人评语原文（≤200 字）。 */
  masterText: string;
}

/** FeedbackMeta 的机械上限（常量定义在文件前部，与 MEMORY_CAPS 的 feedback* 同源）。 */

export function emptyMemory(): MemoryState {
  return { version: 1, people: {}, lore: [], cards: [] };
}

/** id 一律代码生成：模型提供的 id 一律不采信。 */
export function newId(prefix: "f" | "l" | "c" | "p"): string {
  return `${prefix}-${randomBytes(9).toString("hex")}`;
}

/** 待审条目 id：p- + 18 位十六进制（72 位随机），跨人格不撞；批准时全局队列内唯一定位。 */
export function newPendingId(): string {
  return newId("p");
}

export function cleanText(value: string): string {
  return value.replace(/[\u0000-\u001F\u007F]/g, "").trim();
}

/** 去重用归一化：去空白与标点，忽略大小写。 */
export function normalizeText(value: string): string {
  return value.replace(/[\s\p{P}\p{S}]/gu, "").toLowerCase();
}

/** lore 的身份是归一化后的完整 key 集合（排序后拼接，顺序无关）。 */
export function loreSignature(keys: readonly string[]): string {
  return [...keys].map(normalizeText).sort().join("\u0001");
}

export function personTextTotal(person: MemoryPerson): number {
  return person.facts.reduce((sum, fact) => sum + fact.text.length, 0);
}

/**
 * 施加一个（已 sanitize 的）patch，返回全新 state。fromChat 是来源会话 chatKey，
 * 由审批路径注入（待审条目的 originChatKey），写进本 patch 新建的每条 fact——
 * 来源不由模型决定。顺序：先 supersede 失效，再合并 people / lore / cards，
 * 回填 supersededBy 审计链，最后按上限淘汰。
 */
