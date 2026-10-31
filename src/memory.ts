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
 *   - applyPatch 必须深拷贝输入，不得原地改写 doc 或调用方状态；
 *   - 上限在 MEMORY_CAPS 里机械执行，任何 patch 施加后都不超上限。
 */
import { randomBytes } from "node:crypto";
import type { RoundScope } from "./memory-scope.ts";

export type FactSource = "stated" | "observed" | "reported";

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
  lastExtractAt?: number;
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
}

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
};

/** 单条 fact 文本上限（抽取提示词同值：facts 每条一句话）。 */
export const FACT_TEXT_CHARS = 40;

/** 渲染段预算：群里的说法 ≤200，单人 ≤240，卡片 ≤240。 */
const LORE_BUDGET = 200;
const PERSON_BUDGET = 240;
const CARDS_BUDGET = 240;

/** 结构化入站 entry：记忆抽取只读它，不读宿主拼装的 user content。 */
export interface MemoryInbound {
  chatKey: string;
  userId: string;
  nickname: string;
  text: string;
}

export const MEMORY_INBOUND_KIND = "fish.inbound";
export const MEMORY_GIF_KIND = "fish.gif_ingest";

export function emptyMemory(): MemoryState {
  return { version: 1, people: {}, lore: [], cards: [] };
}

/** id 一律代码生成：模型提供的 id 一律不采信。 */
function newId(prefix: "f" | "l" | "c" | "p"): string {
  return `${prefix}-${randomBytes(9).toString("hex")}`;
}

/** 待审条目 id：p- + 18 位十六进制（72 位随机），跨人格不撞；批准时全局队列内唯一定位。 */
export function newPendingId(): string {
  return newId("p");
}

function cleanText(value: string): string {
  return value.replace(/[\u0000-\u001F\u007F]/g, "").trim();
}

/** 去重用归一化：去空白与标点，忽略大小写。 */
function normalizeText(value: string): string {
  return value.replace(/[\s\p{P}\p{S}]/gu, "").toLowerCase();
}

/** lore 的身份是归一化后的完整 key 集合（排序后拼接，顺序无关）。 */
function loreSignature(keys: readonly string[]): string {
  return [...keys].map(normalizeText).sort().join("\u0001");
}

function personTextTotal(person: MemoryPerson): number {
  return person.facts.reduce((sum, fact) => sum + fact.text.length, 0);
}

/**
 * 施加一个（已 sanitize 的）patch，返回全新 state。fromChat 是来源会话 chatKey，
 * 由审批路径注入（待审条目的 originChatKey），写进本 patch 新建的每条 fact——
 * 来源不由模型决定。顺序：先 supersede 失效，再合并 people / lore / cards，
 * 回填 supersededBy 审计链，最后按上限淘汰。
 */
export function applyPatch(state: MemoryState, patch: MemoryPatch, now: number, fromChat?: string): MemoryState {
  // 深拷贝：不原地改写 doc 或调用方状态
  const people: Record<string, MemoryPerson> = {};
  for (const person of Object.values(state.people)) {
    people[person.subject] = {
      ...person,
      names: [...person.names],
      facts: person.facts.map((fact) => ({ ...fact })),
      catchphrases: [...person.catchphrases],
    };
  }
  const lore: MemoryLore[] = state.lore.map((item) => ({ ...item, keys: [...item.keys] }));
  const cards: MemoryCard[] = state.cards.map((card) => ({ ...card, keys: [...card.keys], subjects: [...card.subjects] }));

  // supersede：命中同 subject 的有效 fact 才失效；不存在、subject 不匹配或已失效则忽略。
  // 失效的 fact 暂存，等新 fact 落地后回填 supersededBy 审计链（见 people 循环之后）
  const superseded: MemoryFact[] = [];
  for (const entry of patch.supersede ?? []) {
    const person = people[entry.subject];
    if (!person) continue;
    for (const fact of person.facts) {
      if (fact.invalidAt === undefined && entry.ids.includes(fact.id)) {
        fact.invalidAt = now;
        superseded.push(fact);
      }
    }
  }

  const newFactIds = new Map<string, string>();
  for (const incoming of patch.people ?? []) {
    const person: MemoryPerson = people[incoming.subject] ?? {
      subject: incoming.subject,
      names: [],
      facts: [],
      catchphrases: [],
      updatedAt: now,
    };
    people[incoming.subject] = person;

    for (const raw of incoming.names ?? []) {
      const name = cleanText(raw);
      if (name && !person.names.includes(name)) person.names.push(name);
    }
    person.names = person.names.slice(-MEMORY_CAPS.namesPerPerson);

    for (const raw of incoming.facts ?? []) {
      const text = cleanText(raw.text).slice(0, FACT_TEXT_CHARS);
      if (!text) continue;
      const existing = person.facts.find(
        (fact) => fact.invalidAt === undefined && normalizeText(fact.text) === normalizeText(text),
      );
      if (existing) {
        existing.hits += 1;
        continue;
      }
      const id = newId("f");
      if (!newFactIds.has(person.subject)) newFactIds.set(person.subject, id);
      person.facts.push({
        id,
        subject: person.subject,
        text,
        at: now,
        source: raw.source,
        ...(raw.by !== undefined ? { by: raw.by } : {}),
        ...(fromChat !== undefined && fromChat.length > 0 ? { fromChat } : {}),
        hits: 0,
      });
    }

    // style 只在提供非空值时替换，空值不能清掉已有风格
    if (typeof incoming.style === "string") {
      const style = cleanText(incoming.style).slice(0, MEMORY_CAPS.styleChars);
      if (style.length > 0) person.style = style;
    }

    for (const raw of incoming.catchphrases ?? []) {
      const phrase = cleanText(raw).slice(0, MEMORY_CAPS.catchphraseChars);
      if (phrase && !person.catchphrases.includes(phrase)) person.catchphrases.push(phrase);
    }
    person.catchphrases = person.catchphrases.slice(-MEMORY_CAPS.catchphrasesPerPerson);

    person.updatedAt = now;
  }

  // 审计链回填：被 supersede 的旧 fact 记下取代它的新 fact id（同 subject 首条新 fact）。
  // patch 只 supersede 不新增时无链可记，invalidAt 照样生效。
  for (const fact of superseded) {
    const replacement = newFactIds.get(fact.subject);
    if (replacement !== undefined) fact.supersededBy = replacement;
  }

  for (const incoming of patch.lore ?? []) {
    const keys = incoming.keys.map(cleanText).filter(Boolean);
    if (keys.length === 0) continue;
    const signature = loreSignature(keys);
    const existing = lore.find((item) => loreSignature(item.keys) === signature);
    if (existing) {
      existing.hits += 1;
      const text = cleanText(incoming.text);
      if (text) existing.text = text.slice(0, MEMORY_CAPS.loreTextChars);
      continue;
    }
    const text = cleanText(incoming.text).slice(0, MEMORY_CAPS.loreTextChars);
    if (!text) continue;
    lore.push({ id: newId("l"), keys, text, kind: incoming.kind, at: now, hits: 0 });
  }

  for (const incoming of patch.cards ?? []) {
    const text = cleanText(incoming.text).slice(0, MEMORY_CAPS.cardTextChars);
    if (!text) continue;
    const existing = cards.find((card) => normalizeText(card.text) === normalizeText(text));
    if (existing) {
      existing.keys = [...new Set([...existing.keys, ...incoming.keys])].slice(0, MEMORY_CAPS.cardKeys);
      existing.subjects = [...new Set([...existing.subjects, ...incoming.subjects])].slice(0, MEMORY_CAPS.cardSubjects);
      existing.importance = Math.max(existing.importance, incoming.importance);
      continue;
    }
    cards.push({
      id: newId("c"),
      at: now,
      text,
      importance: incoming.importance,
      keys: [...new Set(incoming.keys)].slice(0, MEMORY_CAPS.cardKeys),
      subjects: [...new Set(incoming.subjects)].slice(0, MEMORY_CAPS.cardSubjects),
    });
  }

  // 上限淘汰：机械执行，宁丢旧的，不破上限。时效口径：at + hits 组合——
  // 零命中且更旧的优先淘汰；渲染期零写入（不记 lastUsedAt，渲染只读）
  evictPeople(people);
  for (const person of Object.values(people)) evictFacts(person);
  evictList(lore, MEMORY_CAPS.lore, byAgeHits);
  evictList(cards, MEMORY_CAPS.cards, (a, b) => a.importance - b.importance || a.at - b.at);

  return {
    version: 1,
    people,
    lore,
    cards,
    ...(state.lastExtractAt !== undefined ? { lastExtractAt: state.lastExtractAt } : {}),
  };
}

/** people 超 12：淘汰 updatedAt 最旧的人。 */
function evictPeople(people: Record<string, MemoryPerson>): void {
  const subjects = Object.keys(people);
  if (subjects.length <= MEMORY_CAPS.people) return;
  const ordered = subjects.sort((a, b) => people[a].updatedAt - people[b].updatedAt);
  for (const subject of ordered.slice(0, subjects.length - MEMORY_CAPS.people)) delete people[subject];
}

/**
 * 时效组合因子：零命中的优先沉底/淘汰，同层更旧优先，再按命中数低者优先。
 * 只用 at（入库时间）与 hits，纯机械；不引入任何渲染期写入。
 */
function byAgeHits<T extends { at: number; hits?: number }>(a: T, b: T): number {
  const zero = (item: T): number => ((item.hits ?? 0) === 0 ? 0 : 1);
  return zero(a) - zero(b) || a.at - b.at || (a.hits ?? 0) - (b.hits ?? 0);
}

/** 每人 facts 超 8 条或总字数超 320：先淘汰已失效的，再淘汰有效里的；两层内都按 at+hits 组合（零命中更旧优先）。 */
function evictFacts(person: MemoryPerson): void {
  const victim = (): MemoryFact | undefined => {
    const invalid = person.facts.filter((fact) => fact.invalidAt !== undefined).sort(byAgeHits)[0];
    return invalid ?? person.facts.filter((fact) => fact.invalidAt === undefined).sort(byAgeHits)[0];
  };
  while (person.facts.length > MEMORY_CAPS.factsPerPerson) {
    const drop = victim();
    if (!drop) break;
    person.facts.splice(person.facts.indexOf(drop), 1);
  }
  while (person.facts.length > 0 && personTextTotal(person) > MEMORY_CAPS.textPerPerson) {
    const drop = victim();
    if (!drop) break;
    person.facts.splice(person.facts.indexOf(drop), 1);
  }
}

/** 超限淘汰：victim 由 compare 排出（升序 = 最先淘汰）。lore 用 at+hits 组合，cards 按 importance 再 at。 */
function evictList<T extends { at: number }>(items: T[], cap: number, compare: (a: T, b: T) => number): void {
  while (items.length > cap) {
    const victim = [...items].sort(compare)[0];
    items.splice(items.indexOf(victim), 1);
  }
}

/**
 * 待审库的一条：压缩链路抽出的 patch，主人批准前只待在这里。
 * 未批准的 patch 不得 apply、不得注入 section、不得被模型看见。
 */
export interface PendingMemoryEntry {
  /** 代码生成的待审 id（p- + 18 位十六进制）：跨人格唯一，/记忆 同意/拒绝按它全局定位。 */
  id: string;
  /** 已 sanitize 的 patch 本体。 */
  patch: MemoryPatch;
  /** 来源会话的原始 chatKey（批准为「私有」时并入 人格名@该 chatKey 的私有 doc）。 */
  originChatKey: string;
  at: number;
}

/** 待审库（fish.memory.pending）的 doc 值：每人格一个 family member，条目按时间正序。 */
export interface PendingMemoryState {
  version: 1;
  entries: PendingMemoryEntry[];
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
    (patch.supersede?.length ?? 0) === 0
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
  const next = applyPatch(target, entry.patch, at, entry.originChatKey || undefined);
  target.people = next.people;
  target.lore = next.lore;
  target.cards = next.cards;
  return { status: "ok", entry };
}

/** 拒绝待审：单条 id 或 "all"（该 doc 全部）；返回删掉的条数。 */
export function rejectPending(pending: PendingMemoryState, id: string | "all"): number {
  const before = pending.entries.length;
  if (id === "all") pending.entries = [];
  else pending.entries = pending.entries.filter((entry) => entry.id !== id);
  return before - pending.entries.length;
}

/** 定位：该 fact id 是否在 state 里（遍历每个人物的 facts）。 */
export function hasFact(state: MemoryState, id: string): boolean {
  return Object.values(state.people).some((person) => person.facts.some((fact) => fact.id === id));
}

/**
 * 真删除一条 fact（从数组移除，区别于 supersede 的 invalidAt 失效——那条审计链保留
 * 历史，这里是彻底清除）。删除通道只有主人的私聊 /记忆 删除 与 scripts/memory.ts 的
 * --delete；命中返回 true。调用方负责打日志（只带 id 与所在 doc，不打印内容）。
 */
export function deleteFactById(state: MemoryState, id: string): boolean {
  for (const person of Object.values(state.people)) {
    const index = person.facts.findIndex((fact) => fact.id === id);
    if (index >= 0) {
      person.facts.splice(index, 1);
      return true;
    }
  }
  return false;
}

export type MemoryCommand =
  | { kind: "list" }
  | { kind: "approve"; id: string; track: "公共" | "私有" }
  | { kind: "reject"; id: string; all: boolean }
  | { kind: "delete"; id: string }
  | { kind: "usage" };

/**
 * 解析 /记忆 指令（闸前机械通道，不进模型）：
 * `/记忆` 列表；`/记忆 同意 <id> [公共|私有]`（缺省私有——默认最小可见面，公开是主动决定）；
 * `/记忆 拒绝 <id|全部>`；`/记忆 删除 <fact-id>`（真删除已入库的 fact，仅主人私聊通道生效）；
 * 其它 /记忆 开头的一律回用法。不是 /记忆 指令返回 undefined。
 */
export function parseMemoryCommand(text: string): MemoryCommand | undefined {
  if (text === "/记忆") return { kind: "list" };
  if (!text.startsWith("/记忆 ")) return undefined;
  const rest = text.slice("/记忆 ".length).trim();
  const approve = /^同意\s+(\S+)(?:\s+(公共|私有))?$/.exec(rest);
  if (approve) return { kind: "approve", id: approve[1], track: approve[2] === "公共" ? "公共" : "私有" };
  if (rest === "拒绝 全部") return { kind: "reject", id: "all", all: true };
  const reject = /^拒绝\s+(\S+)$/.exec(rest);
  if (reject) return { kind: "reject", id: reject[1], all: false };
  const del = /^删除\s+(\S+)$/.exec(rest);
  if (del) return { kind: "delete", id: del[1] };
  return { kind: "usage" };
}

/**
 * 渲染用两层合并（只读，不改任何 doc）：公共 doc + 本会话私有 doc 合成一个 MemoryState。
 * 同主体事实/说法/卡片按归一化身份去重，重复时保留 hits/importance 更高（平手取更新）的
 * 那条；style 私有层优先（更贴当前会话）。合并只服务 memory section 渲染，写路径仍是
 * 两个 doc 各自 applyPatch、各自上限淘汰。
 */
export function mergeMemoryStates(
  publicState: MemoryState | undefined,
  privateState: MemoryState | undefined,
): MemoryState {
  const pub = publicState ?? emptyMemory();
  const priv = privateState ?? emptyMemory();
  const clone = (person: MemoryPerson): MemoryPerson => ({
    ...person,
    names: [...person.names],
    facts: person.facts.map((fact) => ({ ...fact })),
    catchphrases: [...person.catchphrases],
  });

  const people: Record<string, MemoryPerson> = {};
  for (const person of Object.values(pub.people)) people[person.subject] = clone(person);
  for (const person of Object.values(priv.people)) {
    const existing = people[person.subject];
    if (!existing) {
      people[person.subject] = clone(person);
      continue;
    }
    existing.names = [...new Set([...existing.names, ...person.names])].slice(-MEMORY_CAPS.namesPerPerson);
    existing.facts = mergeFacts(existing.facts, person.facts);
    if (person.style) existing.style = person.style;
    existing.catchphrases = [...new Set([...existing.catchphrases, ...person.catchphrases])].slice(
      -MEMORY_CAPS.catchphrasesPerPerson,
    );
    existing.updatedAt = Math.max(existing.updatedAt, person.updatedAt);
  }

  const lore = mergeByIdentity(pub.lore, priv.lore, (item) => loreSignature(item.keys), (a, b) => b.hits - a.hits || b.at - a.at);
  const cards = mergeByIdentity(pub.cards, priv.cards, (card) => normalizeText(card.text), (a, b) => b.importance - a.importance || b.at - a.at);

  return {
    version: 1,
    people,
    lore,
    cards,
    lastExtractAt: [pub.lastExtractAt, priv.lastExtractAt].reduce<number | undefined>(
      (newest, at) => (at === undefined ? newest : newest === undefined ? at : Math.max(newest, at)),
      undefined,
    ),
  };
}

/** 有效事实按归一化文本去重：重复保留 hits 更高（平手取更新）的那条；失效事实原样保留。 */
function mergeFacts(a: MemoryFact[], b: MemoryFact[]): MemoryFact[] {
  const out = a.map((fact) => ({ ...fact }));
  for (const fact of b) {
    if (fact.invalidAt === undefined) {
      const dup = out.find((item) => item.invalidAt === undefined && normalizeText(item.text) === normalizeText(fact.text));
      if (dup) {
        if (fact.hits > dup.hits || (fact.hits === dup.hits && fact.at > dup.at)) out[out.indexOf(dup)] = { ...fact };
        continue;
      }
    }
    out.push({ ...fact });
  }
  return out;
}

/** 按身份签名去重合并两个列表：重复保留 score 更高的那条（平手由 score 的次级键裁决）。 */
function mergeByIdentity<T extends { at: number }>(
  a: T[],
  b: T[],
  identity: (item: T) => string,
  score: (x: T, y: T) => number,
): T[] {
  const out = a.map((item) => ({ ...item }));
  for (const item of b) {
    const dup = out.find((existing) => identity(existing) === identity(item));
    if (dup) {
      if (score(dup, item) > 0) out[out.indexOf(dup)] = { ...item };
      continue;
    }
    out.push({ ...item });
  }
  return out;
}

/**
 * 渲染本轮相关的记忆（只读）。没有 scope 时返回 undefined——历史 cards 不主动展示。
 * 输出按预算组装：群里的说法 → 关于在场的人 → 你还记得；总长超 renderChars 时按完整行从后往前裁。
 */
export function renderMemory(state: MemoryState, scope: RoundScope | undefined, messages: Record<string, string>): string | undefined {
  if (!scope) return undefined;
  const loreHeader = sectionSafe(messages["memory_lore_header"] ?? "");
  const peopleHeader = sectionSafe(messages["memory_people_header"] ?? "");
  const cardsHeader = sectionSafe(messages["memory_cards_header"] ?? "");

  const blocks: string[][] = [];

  // 群里的说法：scope.text 命中任一 keys，最多 5 条，≤200 字。排序与淘汰同口径：
  // 零命中的沉底（at+hits 组合），其余更新在前
  const loreLines: string[] = [];
  if (loreHeader) loreLines.push(loreHeader);
  const hitLore = state.lore
    .filter((item) => item.keys.some((key) => hit(scope.text, key)))
    .sort((a, b) => recencyRank(b) - recencyRank(a) || b.at - a.at || b.hits - a.hits)
    .slice(0, 5);
  for (const item of hitLore) {
    const line = `- ${item.keys.map(sectionSafe).join("/")}：${sectionSafe(item.text)}`;
    if (loreLines.join("\n").length + line.length + 1 > LORE_BUDGET) break;
    loreLines.push(line);
  }
  if (loreLines.length > (loreHeader ? 1 : 0)) blocks.push(loreLines);

  // 关于在场的人：前 3 位说话人，每人 ≤240 字（最近 3 条有效事实 + style + 口头禅）
  const speakers = scope.speakers.slice(0, 3);
  const peopleLines: string[] = [];
  if (peopleHeader) peopleLines.push(peopleHeader);
  for (const speaker of speakers) {
    const person = matchPerson(state.people, speaker);
    if (!person) continue;
    const block = personBlock(person, speaker.name);
    if (block && peopleLines.join("\n").length + block.length + 1 <= PERSON_BUDGET + (peopleHeader ? peopleHeader.length + 1 : 0)) {
      peopleLines.push(block);
    }
  }
  if (peopleLines.length > (peopleHeader ? 1 : 0)) blocks.push(peopleLines);

  // 你还记得：只取当前 text/subject 相关的 cards，importance 降序最多 2 条，≤240 字
  const cardLines: string[] = [];
  if (cardsHeader) cardLines.push(cardsHeader);
  const speakerSubjects = new Set(scope.speakers.map((speaker) => speaker.subject));
  const hitCards = state.cards
    .filter((card) => card.keys.some((key) => hit(scope.text, key)) || card.subjects.some((subject) => speakerSubjects.has(subject)))
    .sort((a, b) => b.importance - a.importance || b.at - a.at)
    .slice(0, 2);
  for (const card of hitCards) {
    const line = `- （${monthAnchor(card.at)}）${sectionSafe(card.text)}`;
    if (cardLines.join("\n").length + line.length + 1 > CARDS_BUDGET) break;
    cardLines.push(line);
  }
  if (cardLines.length > (cardsHeader ? 1 : 0)) blocks.push(cardLines);

  const headers = new Set([loreHeader, peopleHeader, cardsHeader].filter((line) => line.length > 0));
  const lines = blocks.flat();
  // 总长超 renderChars：按完整行从后往前裁，不截断标记
  while (lines.length > 0 && lines.join("\n").length > MEMORY_CAPS.renderChars) lines.pop();
  // 裁完只剩标题的行也一并去掉，避免空 section
  while (lines.length > 0 && headers.has(lines[lines.length - 1])) lines.pop();
  if (lines.length === 0) return undefined;
  return lines.join("\n");
}

/** 人物匹配：先按 subject 精确匹配；没有精确 QQ 人物才按 name:<名> 匹配，同名多于一个宁可不注入。 */
function matchPerson(people: Record<string, MemoryPerson>, speaker: { subject: string; name: string }): MemoryPerson | undefined {
  const exact = people[speaker.subject];
  if (exact) return exact;
  const nameKey = `name:${speaker.name}`;
  const byName = Object.values(people).filter((person) => person.subject === nameKey);
  return byName.length === 1 ? byName[0] : undefined;
}

/** 渲染排序的时效因子：零命中沉底（与淘汰方向相反），其余更新在前。 */
function recencyRank(item: { hits: number }): number {
  return item.hits === 0 ? 0 : 1;
}

/** 时间锚点：YYYY-MM（本地时区）。渲染 fact/卡片时附带，让模型分得清陈年旧事与近况。 */
function monthAnchor(at: number): string {
  const date = new Date(at);
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}`;
}

/** 单人一行：事实在前（带 YYYY-MM 锚点），风格与口头禅在后；超预算时从后往前丢整段。 */
function personBlock(person: MemoryPerson, display: string): string | undefined {
  const facts = person.facts
    .filter((fact) => fact.invalidAt === undefined)
    .sort((a, b) => b.at - a.at)
    .slice(0, 3);
  const segments: string[] = [];
  const factText = facts
    .filter((fact) => sectionSafe(fact.text).length > 0)
    .map((fact) => `${sectionSafe(fact.text)}（${monthAnchor(fact.at)}）`)
    .join("；");
  if (factText) segments.push(factText);
  if (person.style) segments.push(`风格：${sectionSafe(person.style)}`);
  if (person.catchphrases.length > 0) segments.push(`口头禅：${person.catchphrases.map(sectionSafe).join(" / ")}`);
  if (segments.length === 0) return undefined;
  const total = () => `- ${sectionSafe(display)}：${segments.join("；")}`.length;
  while (total() > PERSON_BUDGET && segments.length > 1) segments.pop();
  if (total() > PERSON_BUDGET) {
    // 单段仍超预算：截断该段（保持完整行，不产生标记碎片）
    const over = total() - PERSON_BUDGET;
    segments[0] = segments[0].slice(0, Math.max(1, segments[0].length - over));
  }
  return `- ${sectionSafe(display)}：${segments.join("；")}`;
}

/** 命中判定：正文里出现该 key（忽略首尾空白）即算命中。 */
function hit(text: string, key: string): boolean {
  const needle = key.trim();
  return needle.length > 0 && text.includes(needle);
}

/**
 * section 整体（标题 + 正文）：body 为空或没有 scope 时不注入（undefined）。
 * 标题拼装也在这里：harness 的 memory section 只调这一个函数，四处文案 key
 * 的引用都留在本文件，messages.md 不会出现死文案。
 */
export function renderMemorySection(
  state: MemoryState,
  scope: RoundScope | undefined,
  messages: Record<string, string>,
): string | undefined {
  const body = renderMemory(state, scope, messages);
  if (!body) return undefined;
  const header = messages["memory_section_header"] ?? "";
  return [header, body].filter((line) => line.length > 0).join("\n");
}

/**
 * section-safe 处理：移除控制字符、空字节与 `<...>` 标记。
 * 记忆内容不能闭合 `<memory>` 或伪造新的 section 标记。
 */
function sectionSafe(text: string): string {
  return text
    .replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g, "")
    .replace(/<[^<>\n]*>/g, "")
    .trim();
}
