import {
  FACT_TEXT_CHARS,
  MEMORY_CAPS,
  cleanText,
  loreSignature,
  newId,
  normalizeText,
  personTextTotal,
  type FeedbackFactMeta,
  type MemoryCard,
  type MemoryFact,
  type MemoryLore,
  type MemoryPatch,
  MEMORY_EXPIRE_PER_PAGE,
  MEMORY_EXPIRE_QUOTE_CHARS,
  type MemoryPerson,
  type MemoryState,
} from "./model.ts";

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
  const feedback: MemoryFact[] = (state.feedback ?? []).map((fact) => ({
    ...fact,
    ...(fact.meta !== undefined ? { meta: { ...fact.meta } } : {}),
  }));

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

  // EXPIRE（时效性淘汰，2026-11-05）：只置失效、不新增事实、不回填 supersededBy。
  // 顺序在 supersede 之后：同一 fact 被 supersede 命中时 invalidAt 已置位，这里自动跳过
  // （「有替代优先」在 apply 层也成立，不依赖上层过滤）。上限与抽取侧同源。
  let expiredCount = 0;
  for (const entry of patch.expire ?? []) {
    if (expiredCount >= MEMORY_EXPIRE_PER_PAGE) break;
    const person = people[entry.subject];
    if (!person) continue;
    const fact = person.facts.find((item) => item.id === entry.id && item.invalidAt === undefined);
    if (!fact) continue;
    fact.invalidAt = now;
    fact.expiredReason = entry.quote.slice(0, MEMORY_EXPIRE_QUOTE_CHARS);
    expiredCount += 1;
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

  // 评价 fact（/评 批准落地，T7）：机器通道（MemoryPatch.feedback，抽取器不产）。
  // 去重签名 = 方向 + 归一化原文 + 归一化被评摘要，重复批准只加 hits；上限与淘汰
  // 照 at+hits 机械口径执行（feedback 不豁免）。supersede 不适用于评价 fact——
  // 新评价不推翻旧评价，审计链语义照旧（supersede 仍只作用于 people 的 facts）
  for (const incoming of patch.feedback ?? []) {
    const text = cleanText(incoming.text).slice(0, MEMORY_CAPS.feedbackTextChars);
    if (!text) continue;
    const meta = cleanFeedbackMeta(incoming.meta);
    if (!meta) continue;
    const signature = feedbackSignature(meta.direction, text, meta.targetSummary);
    const existing = feedback.find(
      (fact) => fact.kind === "feedback" && fact.meta !== undefined && feedbackSignature(fact.meta.direction, fact.text, fact.meta.targetSummary) === signature,
    );
    if (existing) {
      existing.hits += 1;
      continue;
    }
    feedback.push({
      id: newId("f"),
      subject: FEEDBACK_FACT_SUBJECT,
      text,
      at: now,
      source: "stated",
      ...(fromChat !== undefined && fromChat.length > 0 ? { fromChat } : {}),
      hits: 0,
      kind: "feedback",
      meta,
    });
  }

  // 上限淘汰：机械执行，宁丢旧的，不破上限。时效口径：at + hits 组合——
  // 零命中且更旧的优先淘汰；渲染期零写入（不记 lastUsedAt，渲染只读）
  evictPeople(people);
  for (const person of Object.values(people)) evictFacts(person);
  evictList(lore, MEMORY_CAPS.lore, byAgeHits);
  evictList(cards, MEMORY_CAPS.cards, (a, b) => a.importance - b.importance || a.at - b.at);
  evictList(feedback, MEMORY_CAPS.feedback, byAgeHits);

  return {
    version: 1,
    people,
    lore,
    cards,
    ...(feedback.length > 0 ? { feedback } : {}),
    ...(state.lastExtractAt !== undefined ? { lastExtractAt: state.lastExtractAt } : {}),
    ...(state.zeroStreak !== undefined ? { zeroStreak: state.zeroStreak } : {}),
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
export function byAgeHits<T extends { at: number; hits?: number }>(a: T, b: T): number {
  const zero = (item: T): number => ((item.hits ?? 0) === 0 ? 0 : 1);
  return zero(a) - zero(b) || a.at - b.at || (a.hits ?? 0) - (b.hits ?? 0);
}

/** 评价 fact 的 subject 占位：它不属于任何 people 主体，永不参与主体匹配与 supersede。 */
export const FEEDBACK_FACT_SUBJECT = "master";

/** 评价 fact 的去重签名：方向 + 归一化原文 + 归一化被评摘要。 */
export function feedbackSignature(direction: string, text: string, targetSummary: string): string {
  return `${direction}\u0001${normalizeText(text)}\u0001${normalizeText(targetSummary)}`;
}

/** 评价 meta 的机械过滤：方向/日期必须合法，摘要与统计行截断；不合格整条丢弃（fail closed）。 */
function cleanFeedbackMeta(meta: FeedbackFactMeta): FeedbackFactMeta | undefined {
  if (meta.direction !== "好" && meta.direction !== "差") return undefined;
  if (typeof meta.day !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(meta.day)) return undefined;
  const targetSummary = cleanText(meta.targetSummary).slice(0, MEMORY_CAPS.feedbackTargetSummaryChars);
  const statsLine = cleanText(meta.statsLine).slice(0, MEMORY_CAPS.feedbackStatsLineChars);
  if (targetSummary.length === 0 || statsLine.length === 0) return undefined;
  return { direction: meta.direction, targetSummary, statsLine, day: meta.day };
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
