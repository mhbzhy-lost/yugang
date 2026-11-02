/**
 * 压缩期的记忆抽取器：用便宜模型从「结构化原始群聊转录」抽一个结构化 patch。
 *
 * 安全边界：
 *   - transcript 由 compact.ts 的 renderMemoryTranscript 产生，只含
 *     fish.inbound / fish.outbound 白名单；宿主拼装的 user content 不在这里；
 *   - 模型输出全部当不可信数据：先机械解析 JSON，再 sanitizePatch 过滤字段、
 *     主体、敏感模式与控制字符，最后按本次允许主体做第二道白名单过滤；
 *   - 失败只记录固定错误与错误类型，不打印 transcript、模型原文或任何可能含隐私的内容；
 *   - known（已知记忆）只存在于一次不可持久化的内部模型请求中，不写入
 *     conversation、pi.user 或 handoff，不能被主模型当作用户原话。
 */
import type { Models } from "@earendil-works/pi-ai/models";
import { renderTemplate, type PromptSet } from "./prompts.ts";
import { FACT_TEXT_CHARS, MEMORY_CAPS, type FactSource, type MemoryPatch } from "./memory.ts";

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

/** 成功但没有候选：不是失败，空 patch 照样推进 lastExtractAt。 */
export function emptyPatch(): MemoryPatch {
  return { people: [], lore: [], cards: [], supersede: [] };
}

export async function extractMemories(
  options: ExtractOptions,
  input: { transcript: string; known: string; subjects: readonly { subject: string; name: string }[] },
): Promise<MemoryPatch | undefined> {
  const model = options.models.getModel(options.model.provider, options.model.modelId);
  if (!model) return undefined;

  const prompt = renderTemplate(options.prompts.memoryExtract, {
    transcript: input.transcript,
    known: input.known,
    subjects: input.subjects.map((entry) => entry.subject).join("\n"),
  });
  const stream = options.models.streamSimple(model, { messages: [{ role: "user", content: prompt }] });
  const message = await stream.result();
  const text = message.content
    .filter((block): block is { type: "text"; text: string } => block.type === "text")
    .map((block) => block.text)
    .join("\n");

  const start = text.indexOf("{");
  const end = text.lastIndexOf("}");
  if (start < 0 || end <= start) {
    console.error("[鱼缸] 记忆抽取失败", "no_json");
    return undefined;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(text.slice(start, end + 1));
  } catch (error) {
    console.error("[鱼缸] 记忆抽取失败", error instanceof Error ? error.constructor.name : typeof error);
    return undefined;
  }

  const patch = sanitizePatch(parsed);
  if (!patch) return undefined;
  return restrictSubjects(patch, allowedSubjects(input));
}

/**
 * 机械过滤（不依赖模型自觉）：字段形状、主体格式、来源、敏感模式与控制字符。
 * 任一条不合格就丢弃该条，不影响其它条；整个结构不可用才返回 undefined。
 * 评价类（/评，T7）不经过这里：feedback 通道是机器装配专用（buildFeedbackPending /
 * approvePending 存量映射），模型输出里的 feedback 键在这里被结构性丢弃——模型
 * 伪造不了 kind="feedback" 的 fact，也借不了加权置顶；抽取产出的候选照旧只进待审。
 */
export function sanitizePatch(raw: unknown): MemoryPatch | undefined {
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) return undefined;
  const source = raw as Record<string, unknown>;
  const people = asArray(source.people).flatMap(readPerson).filter((person) => person !== undefined);
  const lore = asArray(source.lore).flatMap(readLore).filter((item) => item !== undefined);
  const cards = asArray(source.cards).flatMap(readCard).filter((card) => card !== undefined);
  const supersede = asArray(source.supersede).flatMap(readSupersede).filter((item) => item !== undefined);
  return { people, lore, cards, supersede };
}

function asArray(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}

function readPerson(raw: unknown): MemoryPatch["people"] {
  if (typeof raw !== "object" || raw === null) return [];
  const source = raw as Record<string, unknown>;
  const subject = typeof source.subject === "string" ? source.subject.trim() : "";
  if (!SUBJECT_RE.test(subject)) return [];

  const names = asArray(source.names)
    .map((value) => safeShort(value, 20))
    .filter((value): value is string => value !== undefined);

  const facts = asArray(source.facts).flatMap((value) => {
    if (typeof value !== "object" || value === null) return [];
    const fact = value as Record<string, unknown>;
    const text = safeShort(fact.text, FACT_TEXT_CHARS, FACT_INJECTION_RES);
    if (text === undefined) return [];
    const factSource = fact.source;
    if (typeof factSource !== "string" || !FACT_SOURCES.includes(factSource as FactSource)) return [];
    // stated / observed 不接受伪造的 by；reported 的 by 只做格式检查（白名单在 extractMemories 里）
    const by = fact.by;
    if (by !== undefined) {
      if (factSource !== "reported") return [];
      if (typeof by !== "string" || !SUBJECT_RE.test(by.trim())) return [];
      return [{ text, source: factSource as FactSource, by: by.trim() }];
    }
    if (factSource === "reported") return [];
    return [{ text, source: factSource as FactSource }];
  });

  const style = source.style === undefined ? undefined : safeShort(source.style, MEMORY_CAPS.styleChars);
  const catchphrases = asArray(source.catchphrases)
    .map((value) => safeShort(value, MEMORY_CAPS.catchphraseChars))
    .filter((value): value is string => value !== undefined);

  if (names.length === 0 && facts.length === 0 && style === undefined && catchphrases.length === 0) return [];
  return [{ subject, names, facts, ...(style !== undefined ? { style } : {}), catchphrases }];
}

function readLore(raw: unknown): MemoryPatch["lore"] {
  if (typeof raw !== "object" || raw === null) return [];
  const source = raw as Record<string, unknown>;
  const keys = asArray(source.keys)
    .map((value) => safeShort(value, MEMORY_CAPS.loreKeyChars))
    .filter((value): value is string => value !== undefined)
    .slice(0, MEMORY_CAPS.loreKeys);
  if (keys.length === 0) return [];
  const text = safeShort(source.text, MEMORY_CAPS.loreTextChars);
  if (text === undefined) return [];
  const kind = source.kind;
  if (typeof kind !== "string" || !LORE_KINDS.includes(kind as (typeof LORE_KINDS)[number])) return [];
  return [{ keys, text, kind: kind as (typeof LORE_KINDS)[number] }];
}

function readCard(raw: unknown): MemoryPatch["cards"] {
  if (typeof raw !== "object" || raw === null) return [];
  const source = raw as Record<string, unknown>;
  const text = safeShort(source.text, MEMORY_CAPS.cardTextChars);
  if (text === undefined) return [];
  const keys = asArray(source.keys)
    .map((value) => safeShort(value, 10))
    .filter((value): value is string => value !== undefined)
    .slice(0, MEMORY_CAPS.cardKeys);
  if (keys.length === 0) return [];
  const subjects = asArray(source.subjects)
    .map((value) => (typeof value === "string" ? value.trim() : ""))
    .filter((value) => SUBJECT_RE.test(value))
    .slice(0, MEMORY_CAPS.cardSubjects);
  const importance = source.importance;
  if (typeof importance !== "number" || !Number.isFinite(importance)) return [];
  return [{ text, importance: Math.min(5, Math.max(1, Math.round(importance))), keys, subjects }];
}

function readSupersede(raw: unknown): MemoryPatch["supersede"] {
  if (typeof raw !== "object" || raw === null) return [];
  const source = raw as Record<string, unknown>;
  const subject = typeof source.subject === "string" ? source.subject.trim() : "";
  if (!SUBJECT_RE.test(subject)) return [];
  const ids = asArray(source.ids)
    .map((value) => (typeof value === "string" ? value.trim() : ""))
    .filter((value) => FACT_ID_RE.test(value))
    .slice(0, MEMORY_CAPS.factsPerPerson);
  if (ids.length === 0) return [];
  return [{ subject, ids }];
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
 * 第二道主体白名单：sanitizePatch 只验格式，这里把主体限制到本次允许集合，
 * 防止模型用对话正文里提到的陌生 QQ 号把事实归给第三人。返回值不含 feedback
 * 通道（抽取器不产评价 fact，见 sanitizePatch 的边界注释）。
 */
function restrictSubjects(patch: MemoryPatch, allowed: ReadonlySet<string>): MemoryPatch {
  const people = (patch.people ?? [])
    .filter((person) => allowed.has(person.subject))
    .map((person) => ({
      ...person,
      facts: person.facts.filter((fact) => fact.by === undefined || allowed.has(fact.by)),
    }));
  const lore = patch.lore ?? [];
  const cards = (patch.cards ?? []).map((card) => ({ ...card, subjects: card.subjects.filter((subject) => allowed.has(subject)) }));
  const supersede = (patch.supersede ?? []).filter((entry) => allowed.has(entry.subject));
  return { people, lore, cards, supersede };
}
