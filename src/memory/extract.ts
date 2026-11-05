/**
 * 压缩期的记忆抽取器：用便宜模型从「结构化原始群聊转录」抽候选，机械对账成 patch。
 *
 * 对账四分类（T11 + 2026-11-05 时效性核对）：模型输出 candidates 数组，每条
 * {action: ADD|SUPERSEDE|EXPIRE, type: fact|profile|lore|card, subject, factId?
 * (SUPERSEDE/EXPIRE 必填), text?, quote?(EXPIRE 必填，逐字入站原文), signal[], confidence}；
 * SKIP 由模型报进 skipped 计数，不产出。SUPERSEDE 的 subject 不采信模型——由 known
 * 附带的 factId→subject 映射机械解析（解析不到就弃）。signal 两类（命中 people 名单 /
 * 与现有 fact 冲突）由代码机械重算，模型标注只作教学不作数据。confidence 只认
 * high/medium/low，缺失或未知值弃该条；low 在正常轮机械丢弃（复查轮放宽保留）。
 *
 * 安全边界：
 *   - transcript 由 compact.ts 的 renderMemoryTranscript 产生，只含
 *     fish.inbound / fish.eval / fish.outbound 白名单；宿主拼装的 user content 不在这里；
 *   - 模型输出全部当不可信数据：先机械解析 JSON（ExtractOutcome 三态：ok / empty /
 *     parse_failed——解析失败单独上报，不静默归零、不计零提取），再逐条 sanitize 过滤
 *     字段、主体、敏感模式与控制字符，最后按本次允许主体做第二道白名单过滤；
 *   - 失败只记录固定错误与错误类型，不打印 transcript、模型原文或任何可能含隐私的内容；
 *   - known（已知记忆）只存在于一次不可持久化的内部模型请求中，不写入
 *     conversation、pi.user 或 handoff，不能被主模型当作用户原话。
 */
import type { Models } from "@earendil-works/pi-ai/models";
import { localDay } from "../records/usage.ts";
import { renderTemplate, type PromptSet } from "../prompt/index.ts";
import {
  FACT_TEXT_CHARS,
  MEMORY_CAPS,
  MEMORY_EXPIRE_PER_PAGE,
  MEMORY_EXPIRE_QUOTE_CHARS,
  type ExtractSignals,
  type FactSource,
  type MemoryPatch,
} from "./index.ts";

export interface ExtractOptions {
  models: Models;
  model: { provider: string; modelId: string };
  prompts: PromptSet;
}

/** 主体格式：QQ 号或受控长度的 name: 昵称。 */
const SUBJECT_RE = /^(qq:\d{4,12}|name:[^\s:]{1,20})$/;
const FACT_ID_RE = /^f-[a-z0-9]{12,}$/;
const FACT_SOURCES: readonly FactSource[] = ["stated", "observed", "reported"];
const LORE_KINDS = ["word", "meme", "rule"] as const;
const CANDIDATE_ACTIONS = ["ADD", "SUPERSEDE", "EXPIRE"] as const;
const CANDIDATE_TYPES = ["fact", "profile", "lore", "card"] as const;
/** confidence 枚举（终审 #3 加严）：缺失或不认识的值整条丢弃，不再默认放行。 */
const CONFIDENCE_LEVELS = ["high", "medium", "low"] as const;

/** 所有字段共用的明显隐私模式：手机号/连续 7 位以上数字、邮箱、URL、密钥样式。 */
const PRIVACY_RES: readonly RegExp[] = [
  /\d{7,}/,
  /[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+/,
  /https?:\/\/|www\./i,
  /(api[_-]?key|token|password|passwd|secret|密码|密钥)/i,
  /\b(sk|pk|ghp|gho|xoxb?)[-_a-zA-Z0-9]{10,}/i,
];

/** 所有字段共用的明显注入模式。 */
const INJECTION_RES: readonly RegExp[] = [/忽略(之前|以上|前面)/, /system prompt/i, /系统提示/, /ignore (all )?previous/i];

/** fact text 额外拒绝的指令式说法。 */
const FACT_INJECTION_RES: readonly RegExp[] = [/忽略/, /系统提示/, /system prompt/i, /ignore previous/i, /以后都/, /你必须/, /从现在开始/];

/**
 * 抽取结果三态（T11）：ok = 产出非空 patch；empty = 模型成功响应但没有值得记的
 * （零提取，计入连续计数）；parse_failed = 输出不是可解析的候选 JSON（单独上报，
 * 不计零提取——旧版会把未知形状归一成空 patch，把解析失败误判成零提取）。
 */
export type ExtractOutcome =
  | { status: "ok"; patch: MemoryPatch; signals: ExtractSignals; skipped: number }
  | { status: "empty"; skipped: number }
  | { status: "parse_failed"; reason: "no_json" | "bad_json" | "bad_shape" };

/** 可落库的两态（parse_failed 之外）：savePendingMemories 的载荷，ok 时进待审、empty 只推进计数。 */
export type ExtractSaved = Exclude<ExtractOutcome, { status: "parse_failed" }>;

export async function extractMemories(
  options: ExtractOptions,
  input: {
    transcript: string;
    known: string;
    subjects: readonly { subject: string; name: string }[];
    inboundTexts: readonly string[];
  },
  mode: { review: boolean } = { review: false },
): Promise<ExtractOutcome> {
  const model = options.models.getModel(options.model.provider, options.model.modelId);
  if (!model) throw new Error(`找不到记忆抽取用的模型：${options.model.provider}/${options.model.modelId}`);

  const prompt = renderTemplate(mode.review ? options.prompts.memoryExtractReview : options.prompts.memoryExtract, {
    transcript: input.transcript,
    known: input.known,
    subjects: input.subjects.map((entry) => entry.subject).join("\n"),
    today: localDay(Date.now()),
  });
  const stream = options.models.streamSimple(model, { messages: [{ role: "user", content: prompt }] });
  const message = await stream.result();
  // 网关拦截/断流只回来一条 error 消息（content 为空）：翻成异常走抽取失败通道，
  // 不算 parse_failed（那是「模型回了但输出不可解析」），也不算零提取
  if (message.stopReason === "error" || message.stopReason === "aborted") {
    throw new Error(`extract_${message.stopReason}`);
  }
  const text = message.content
    .filter((block): block is { type: "text"; text: string } => block.type === "text")
    .map((block) => block.text)
    .join("\n");

  const start = text.indexOf("{");
  const end = text.lastIndexOf("}");
  if (start < 0 || end <= start) return { status: "parse_failed", reason: "no_json" };
  let parsed: unknown;
  try {
    parsed = JSON.parse(text.slice(start, end + 1));
  } catch (error) {
    console.error("[鱼缸] 记忆抽取失败", error instanceof Error ? error.constructor.name : typeof error);
    return { status: "parse_failed", reason: "bad_json" };
  }

  const result = reconcileCandidates(parsed, input, mode);
  if (result === undefined) return { status: "parse_failed", reason: "bad_shape" };
  const { patch, skipped, signals } = result;
  // 非空判定必须覆盖全部通道：只数 people/lore/cards 会把「纯 supersede」和「纯 expire」
  // 的产出误判成 zero-extract（旧 bug 的同类，2026-11-05 审阅 A1）
  const total =
    (patch.people?.length ?? 0) +
    (patch.lore?.length ?? 0) +
    (patch.cards?.length ?? 0) +
    (patch.supersede?.length ?? 0) +
    (patch.expire?.length ?? 0) +
    (patch.feedback?.length ?? 0);
  if (total === 0) return { status: "empty", skipped };
  return { status: "ok", patch, signals, skipped };
}

/** known 文本行的机械解析结果：已知人物名单 + factId→subject 映射。 */
interface KnownIndex {
  people: Set<string>;
  idToSubject: Map<string, string>;
}

/**
 * 解析 known（已知事实）的结构：主体行「subject 昵称/昵称」开一个人物段，
 * 事实行「f-id YYYY-MM 事实文本」归属最近的主体行。SUPERSEDE 的 factId→subject
 * 机械解析与 people 信号（命中名单）都从这里来；与 harness 的 knownMemory 装配同格式。
 */
function indexKnown(known: string): KnownIndex {
  const people = new Set<string>();
  const idToSubject = new Map<string, string>();
  let current: string | undefined;
  for (const line of known.split(/\r?\n/)) {
    const first = line.trim().split(/\s+/)[0] ?? "";
    if (FACT_ID_RE.test(first)) {
      if (current !== undefined) idToSubject.set(first, current);
    } else if (SUBJECT_RE.test(first)) {
      current = first;
      people.add(first);
    }
  }
  return { people, idToSubject };
}

/** 对账中间产物：候选 sanitize 后合并的 patch、SKIP 计数与机械信号。 */
interface Reconciled {
  patch: MemoryPatch;
  skipped: number;
  signals: ExtractSignals;
}

/**
 * 三分类对账（不依赖模型自觉的机械部分）：
 *   - 顶层形状不合格（不是对象 / candidates 不是数组）→ undefined（parse_failed）；
 *   - 每条候选逐个 sanitize：action 只认 ADD/SUPERSEDE，type 只认 fact/profile/lore/card，
 *     任一字段不合格就弃该条（不影响其它条）；
 *   - SUPERSEDE 仅允许 type=fact（终审 #3：profile/lore/card 一律丢弃，不降级成 ADD）；
 *   - SUPERSEDE：factId 必须在 known 的 id→subject 映射里命中，subject 以机械解析为准，
 *     模型写的 subject 不采信；未命中就弃（没命中 known 里的 id 就不写）；
 *   - confidence 只认 high/medium/low，缺失或未知值弃该条；low 正常轮机械丢弃
 *     （复查轮放宽保留——复查正是为零提取兜底）；
 *   - signal 机械重算：people = 候选主体命中已知人物名单（card 看任一 subject），
 *     conflict = SUPERSEDE 有效解析；模型标注的 signal 不采信。
 */
export function reconcileCandidates(
  raw: unknown,
  input: {
    known: string;
    subjects: readonly { subject: string; name: string }[];
    /** EXPIRE 的证据域：本页**入站原文**（fish.inbound.data.text）。刻意不含鱼自己的
     *  outbound 与主人评价——否则鱼可以拿自己的推测自证「这条事实过期了」。 */
    inboundTexts: readonly string[];
  },
  mode: { review: boolean },
): Reconciled | undefined {
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) return undefined;
  const source = raw as Record<string, unknown>;
  const rawCandidates = source["candidates"];
  if (!Array.isArray(rawCandidates)) return undefined;
  const skippedRaw = source["skipped"];
  const skipped = typeof skippedRaw === "number" && Number.isFinite(skippedRaw) ? Math.max(0, Math.min(99, Math.floor(skippedRaw))) : 0;

  const known = indexKnown(input.known);
  const allowed = allowedSubjects(input);
  const peopleBySubject = new Map<string, AccPerson>();
  const lore: NonNullable<MemoryPatch["lore"]> = [];
  const cards: NonNullable<MemoryPatch["cards"]> = [];
  const supersede: NonNullable<MemoryPatch["supersede"]> = [];
  const expire: NonNullable<MemoryPatch["expire"]> = [];
  const signals: ExtractSignals = { people: 0, conflict: 0, expired: 0 };
  const supersededIds = new Set<string>();
  // EXPIRE 去重（D3）：同一 factId 同页只收一次；一条 quote 只支持一个 factId。
  const expiredIds = new Set<string>();
  const usedQuotes = new Set<string>();

  for (const item of rawCandidates) {
    if (typeof item !== "object" || item === null) continue;
    const candidate = item as Record<string, unknown>;
    const action = candidate["action"];
    const type = candidate["type"];
    if (typeof action !== "string" || !CANDIDATE_ACTIONS.includes(action as (typeof CANDIDATE_ACTIONS)[number])) continue;
    if (typeof type !== "string" || !CANDIDATE_TYPES.includes(type as (typeof CANDIDATE_TYPES)[number])) continue;
    const confidence = candidate["confidence"];
    // confidence 加严（终审 #3）：只认枚举值，缺失/未知值弃该条；
    // low 正常轮机械丢弃（试金石的机械兜底）；复查轮放宽：low 也收，交主人筛
    if (typeof confidence !== "string" || !CONFIDENCE_LEVELS.includes(confidence as (typeof CONFIDENCE_LEVELS)[number])) continue;
    if (confidence === "low" && !mode.review) continue;
    // SUPERSEDE / EXPIRE 只允许 type=fact：profile/lore/card 没有可被取代/失效的 id，
    // 越权标注一律丢弃、不降级成 ADD
    if ((action === "SUPERSEDE" || action === "EXPIRE") && type !== "fact") continue;

    // EXPIRE（时效性淘汰）：只认 factId + 逐字 quote，不造事实、不进 people 累加器
    if (action === "EXPIRE") {
      // 防误杀（D3）：过时判定比「记新的」危险得多，复查轮也不放宽 confidence
      if (confidence !== "high") continue;
      const entry = readExpire(candidate, known, input.inboundTexts ?? []);
      if (!entry) continue;
      if (expiredIds.has(entry.id) || usedQuotes.has(entry.quote)) continue;
      expiredIds.add(entry.id);
      usedQuotes.add(entry.quote);
      if (entry.signalPeople) signals.people += 1;
      expire.push(entry.patchEntry);
      continue;
    }

    if (type === "fact") {
      const fact = readFact(candidate, action, known);
      if (!fact) continue;
      if (fact.signalPeople) signals.people += 1;
      if (action === "SUPERSEDE") {
        signals.conflict += 1;
        if (!supersededIds.has(fact.factId)) {
          supersededIds.add(fact.factId);
          supersede.push({ subject: fact.person.subject, ids: [fact.factId] });
        }
      }
      const person = personOf(peopleBySubject, fact.person.subject);
      person.facts.push(fact.fact);
      continue;
    }
    if (type === "profile") {
      const person = readProfile(candidate);
      if (!person) continue;
      const existing = personOf(peopleBySubject, person.subject);
      if (person.names !== undefined) existing.names = [...(existing.names ?? []), ...person.names];
      if (person.style !== undefined && person.style.length > 0) existing.style = person.style;
      if (person.catchphrases !== undefined) {
        existing.catchphrases = [...(existing.catchphrases ?? []), ...person.catchphrases];
      }
      continue;
    }
    if (type === "lore") {
      const item2 = readLore(candidate);
      if (item2) lore.push(item2);
      continue;
    }
    const card = readCard(candidate);
    if (card) {
      cards.push(card);
      if (card.subjects.some((subject) => known.people.has(subject))) signals.people += 1;
    }
  }

  const people: NonNullable<MemoryPatch["people"]> = [...peopleBySubject.values()]
    .filter((person) => person.facts.length + person.names.length + (person.style !== undefined ? 1 : 0) + person.catchphrases.length > 0)
    .map((person) => ({
      subject: person.subject,
      ...(person.names.length > 0 ? { names: person.names } : {}),
      ...(person.facts.length > 0 ? { facts: person.facts } : {}),
      ...(person.style !== undefined ? { style: person.style } : {}),
      ...(person.catchphrases.length > 0 ? { catchphrases: person.catchphrases } : {}),
    }));
  // 「有替代优先」（D6）：整批解析完再过滤，不依赖候选在 JSON 里的先后顺序
  const expireFinal = expire.filter((entry) => !supersededIds.has(entry.id)).slice(0, MEMORY_EXPIRE_PER_PAGE);
  signals.expired = expireFinal.length;
  const patch = restrictSubjects({ people, lore, cards, supersede, expire: expireFinal }, allowed);
  return { patch, skipped, signals };
}

/** 对账期的人物累积器：facts / profile 字段按 subject 累加，拼 patch 时再剔空段。 */
interface AccPerson {
  subject: string;
  names: string[];
  facts: { text: string; source: FactSource; by?: string }[];
  style?: string;
  catchphrases: string[];
}

/** Map 里没有就建空人物骨架，facts / profile 字段随后累加。 */
function personOf(map: Map<string, AccPerson>, subject: string): AccPerson {
  let person = map.get(subject);
  if (!person) {
    person = { subject, names: [], facts: [], catchphrases: [] };
    map.set(subject, person);
  }
  return person;
}

/**
 * EXPIRE 候选：只要 factId + 逐字 quote + 机械解析出的 subject。
 * 证据闸（D2）：quote 先过与 safeShort 同款的过滤（限长/控制字符/隐私/注入），再要求它是
 * **本页入站原文集合**里某一条的 substring——扁平 transcript 里含鱼自己的发言，不能当证据域。
 */
function readExpire(
  candidate: Record<string, unknown>,
  known: KnownIndex,
  inboundTexts: readonly string[],
): { id: string; quote: string; signalPeople: boolean; patchEntry: { subject: string; id: string; quote: string } } | undefined {
  const rawId = candidate["factId"];
  if (typeof rawId !== "string" || !FACT_ID_RE.test(rawId.trim())) return undefined;
  const id = rawId.trim();
  const subject = known.idToSubject.get(id);
  if (subject === undefined) return undefined;
  const quote = safeShort(candidate["quote"], MEMORY_EXPIRE_QUOTE_CHARS);
  if (quote === undefined) return undefined;
  if (!inboundTexts.some((text) => text.includes(quote))) return undefined;
  return { id, quote, signalPeople: known.people.has(subject), patchEntry: { subject, id, quote } };
}

/** fact 候选：ADD 看模型给的 subject（仍要过格式），SUPERSEDE 只信 factId→subject 机械解析。 */
function readFact(
  candidate: Record<string, unknown>,
  action: string,
  known: KnownIndex,
): { person: { subject: string }; fact: { text: string; source: FactSource; by?: string }; factId: string; signalPeople: boolean } | undefined {
  const text = safeShort(candidate["text"], FACT_TEXT_CHARS, FACT_INJECTION_RES);
  if (text === undefined) return undefined;
  const factSource = candidate["source"];
  if (typeof factSource !== "string" || !FACT_SOURCES.includes(factSource as FactSource)) return undefined;
  const by = candidate["by"];
  let fact: { text: string; source: FactSource; by?: string };
  if (by !== undefined) {
    if (factSource !== "reported") return undefined;
    if (typeof by !== "string" || !SUBJECT_RE.test(by.trim())) return undefined;
    fact = { text, source: factSource as FactSource, by: by.trim() };
  } else {
    if (factSource === "reported") return undefined;
    fact = { text, source: factSource as FactSource };
  }

  let subject: string;
  if (action === "SUPERSEDE") {
    const factId = candidate["factId"];
    if (typeof factId !== "string" || !FACT_ID_RE.test(factId.trim())) return undefined;
    // subject 机械解析：known 附带的 id→subject 映射说了算，模型写的 subject 不采信
    const resolved = known.idToSubject.get(factId.trim());
    if (resolved === undefined) return undefined;
    subject = resolved;
    return { person: { subject }, fact, factId: factId.trim(), signalPeople: known.people.has(subject) };
  }
  const rawSubject = candidate["subject"];
  if (typeof rawSubject !== "string" || !SUBJECT_RE.test(rawSubject.trim())) return undefined;
  subject = rawSubject.trim();
  return { person: { subject }, fact, factId: "", signalPeople: known.people.has(subject) };
}

/** profile 候选（names / style / catchphrases）：与旧 readPerson 的字段过滤同款。 */
function readProfile(candidate: Record<string, unknown>): { subject: string; names?: string[]; style?: string; catchphrases?: string[] } | undefined {
  const rawSubject = candidate["subject"];
  if (typeof rawSubject !== "string" || !SUBJECT_RE.test(rawSubject.trim())) return undefined;
  const subject = rawSubject.trim();
  const names = asArray(candidate["names"])
    .map((value) => safeShort(value, 20))
    .filter((value): value is string => value !== undefined)
    .slice(0, MEMORY_CAPS.namesPerPerson);
  const styleRaw = candidate["style"];
  const style = styleRaw === undefined ? undefined : safeShort(styleRaw, MEMORY_CAPS.styleChars);
  const catchphrases = asArray(candidate["catchphrases"])
    .map((value) => safeShort(value, MEMORY_CAPS.catchphraseChars))
    .filter((value): value is string => value !== undefined)
    .slice(0, MEMORY_CAPS.catchphrasesPerPerson);
  if (names.length === 0 && style === undefined && catchphrases.length === 0) return undefined;
  return { subject, ...(names.length > 0 ? { names } : {}), ...(style !== undefined ? { style } : {}), ...(catchphrases.length > 0 ? { catchphrases } : {}) };
}

function readLore(candidate: Record<string, unknown>): NonNullable<MemoryPatch["lore"]>[number] | undefined {
  const keys = asArray(candidate["keys"])
    .map((value) => safeShort(value, MEMORY_CAPS.loreKeyChars))
    .filter((value): value is string => value !== undefined)
    .slice(0, MEMORY_CAPS.loreKeys);
  if (keys.length === 0) return undefined;
  const text = safeShort(candidate["text"], MEMORY_CAPS.loreTextChars);
  if (text === undefined) return undefined;
  const kind = candidate["kind"];
  if (typeof kind !== "string" || !LORE_KINDS.includes(kind as (typeof LORE_KINDS)[number])) return undefined;
  return { keys, text, kind: kind as (typeof LORE_KINDS)[number] };
}

function readCard(candidate: Record<string, unknown>): NonNullable<MemoryPatch["cards"]>[number] | undefined {
  const text = safeShort(candidate["text"], MEMORY_CAPS.cardTextChars);
  if (text === undefined) return undefined;
  const keys = asArray(candidate["keys"])
    .map((value) => safeShort(value, 10))
    .filter((value): value is string => value !== undefined)
    .slice(0, MEMORY_CAPS.cardKeys);
  if (keys.length === 0) return undefined;
  const subjects = asArray(candidate["subjects"])
    .map((value) => (typeof value === "string" ? value.trim() : ""))
    .filter((value) => SUBJECT_RE.test(value))
    .slice(0, MEMORY_CAPS.cardSubjects);
  const importance = candidate["importance"];
  if (typeof importance !== "number" || !Number.isFinite(importance)) return undefined;
  return { text, importance: Math.min(5, Math.max(1, Math.round(importance))), keys, subjects };
}

function asArray(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}

/**
 * 通用短文本过滤：trim、限长、拒绝换行/控制字符、`<>` 标记、明显注入与隐私模式。
 * 不合格返回 undefined（该条丢弃）。
 */
function safeShort(value: unknown, max: number, extraInjections: readonly RegExp[] = INJECTION_RES): string | undefined {
  if (typeof value !== "string") return undefined;
  const text = value.trim();
  if (text.length === 0 || text.length > max) return undefined;
  if (/[\u0000-\u001F\u007F]/.test(text)) return undefined;
  if (text.includes("<") || text.includes(">")) return undefined;
  for (const pattern of [...extraInjections, ...PRIVACY_RES]) {
    if (pattern.test(text)) return undefined;
  }
  return text;
}

/** 允许主体集合：本次 subjects（结构化入站 + 已知人物）与 known 文本行首的主体。 */
function allowedSubjects(input: { known: string; subjects: readonly { subject: string; name: string }[] }): Set<string> {
  const allowed = new Set<string>();
  for (const entry of input.subjects) {
    if (SUBJECT_RE.test(entry.subject)) allowed.add(entry.subject);
  }
  for (const line of input.known.split(/\r?\n/)) {
    const first = line.trim().split(/\s+/)[0] ?? "";
    if (SUBJECT_RE.test(first)) allowed.add(first);
  }
  return allowed;
}

/**
 * 第二道主体白名单：候选解析只验格式，这里把主体限制到本次允许集合，
 * 防止模型用对话正文里提到的陌生 QQ 号把事实归给第三人。返回值不含 feedback
 * 通道（抽取器不产评价 fact，评价只走审批链机器装配）。
 */
function restrictSubjects(patch: MemoryPatch, allowed: ReadonlySet<string>): MemoryPatch {
  const people = (patch.people ?? [])
    .filter((person) => allowed.has(person.subject))
    .map((person) => ({
      ...person,
      facts: (person.facts ?? []).filter((fact) => fact.by === undefined || allowed.has(fact.by)),
    }));
  const lore = patch.lore ?? [];
  const cards = (patch.cards ?? []).map((card) => ({ ...card, subjects: card.subjects.filter((subject) => allowed.has(subject)) }));
  const supersede = (patch.supersede ?? []).filter((entry) => allowed.has(entry.subject));
  // 新字段必须显式带上：这个函数是「重建 patch」，漏一个字段就等于整条通道失效
  const expire = (patch.expire ?? []).filter((entry) => allowed.has(entry.subject));
  return { people, lore, cards, supersede, expire };
}
