/**
 * 长期记忆的数据模型、上限与渲染。
 *
 * 记忆存成 session 级 keyed document family（fish.memory，见 store.ts），
 * key 是去掉人格后缀的原始 chatKey（见 memory-scope.ts 的 memoryKeyOf）。
 * 写入入口只有压缩链路（compact.ts）；渲染入口只有 system section（harness.ts）。
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
  source: FactSource;
  /** reported 来源的转述人 subject。 */
  by?: string;
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
function newId(prefix: "f" | "l" | "c"): string {
  return `${prefix}-${randomBytes(9).toString("hex")}`;
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
 * 施加一个（已 sanitize 的）patch，返回全新 state。
 * 顺序：先 supersede 失效，再合并 people / lore / cards，最后按上限淘汰。
 */
export function applyPatch(state: MemoryState, patch: MemoryPatch, now: number): MemoryState {
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

  // supersede：命中同 subject 的有效 fact 才失效；不存在、subject 不匹配或已失效则忽略
  for (const entry of patch.supersede ?? []) {
    const person = people[entry.subject];
    if (!person) continue;
    for (const fact of person.facts) {
      if (fact.invalidAt === undefined && entry.ids.includes(fact.id)) fact.invalidAt = now;
    }
  }

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
      person.facts.push({
        id: newId("f"),
        subject: person.subject,
        text,
        at: now,
        source: raw.source,
        ...(raw.by !== undefined ? { by: raw.by } : {}),
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

  // 上限淘汰：机械执行，宁丢旧的，不破上限
  evictPeople(people);
  for (const person of Object.values(people)) evictFacts(person);
  evictList(lore, MEMORY_CAPS.lore);
  evictList(cards, MEMORY_CAPS.cards);

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

/** 每人 facts 超 8 条或总字数超 320：先淘汰已失效且 at 最旧，再淘汰有效且 at 最旧。 */
function evictFacts(person: MemoryPerson): void {
  const victim = (): MemoryFact | undefined => {
    const invalid = person.facts.filter((fact) => fact.invalidAt !== undefined).sort((a, b) => a.at - b.at)[0];
    return invalid ?? person.facts.filter((fact) => fact.invalidAt === undefined).sort((a, b) => a.at - b.at)[0];
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

/** lore 按 hits 最低再按 at 最旧；cards 按 importance 最低再按 at 最旧。 */
function evictList<T extends { at: number }>(items: T[], cap: number, score?: (item: T) => number): void {
  if (score === undefined) {
    while (items.length > cap) {
      const victim = [...items].sort((a, b) => a.at - b.at)[0];
      items.splice(items.indexOf(victim), 1);
    }
    return;
  }
  while (items.length > cap) {
    const victim = [...items].sort((a, b) => score(a) - score(b) || a.at - b.at)[0];
    items.splice(items.indexOf(victim), 1);
  }
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

  // 群里的说法：scope.text 命中任一 keys，最多 5 条，≤200 字
  const loreLines: string[] = [];
  if (loreHeader) loreLines.push(loreHeader);
  const hitLore = state.lore
    .filter((item) => item.keys.some((key) => hit(scope.text, key)))
    .sort((a, b) => b.hits - a.hits || b.at - a.at)
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
    const line = `- ${sectionSafe(card.text)}`;
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

/** 单人一行：事实在前，风格与口头禅在后；超预算时从后往前丢整段。 */
function personBlock(person: MemoryPerson, display: string): string | undefined {
  const facts = person.facts
    .filter((fact) => fact.invalidAt === undefined)
    .sort((a, b) => b.at - a.at)
    .slice(0, 3);
  const segments: string[] = [];
  const factText = facts.map((fact) => sectionSafe(fact.text)).filter(Boolean).join("；");
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
 * section-safe 处理：移除控制字符、空字节与 `<...>` 标记。
 * 记忆内容不能闭合 `<memory>` 或伪造新的 section 标记。
 */
function sectionSafe(text: string): string {
  return text
    .replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g, "")
    .replace(/<[^<>\n]*>/g, "")
    .trim();
}
