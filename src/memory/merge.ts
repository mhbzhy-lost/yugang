import {
  MEMORY_CAPS,
  emptyMemory,
  loreSignature,
  normalizeText,
  type MemoryFact,
  type MemoryPerson,
  type MemoryState,
} from "./model.ts";
import { byAgeHits, feedbackSignature } from "./patch.ts";

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
  // 评价 fact：同签名去重（方向+原文+被评摘要），保留 hits 更高（平手取更新）的那条
  const feedback = mergeByIdentity(
    pub.feedback ?? [],
    priv.feedback ?? [],
    (fact) =>
      fact.kind === "feedback" && fact.meta !== undefined
        ? feedbackSignature(fact.meta.direction, fact.text, fact.meta.targetSummary)
        : `id:${fact.id}`,
    (a, b) => b.hits - a.hits || b.at - a.at,
  );

  return {
    version: 1,
    people,
    lore,
    cards,
    ...(feedback.length > 0 ? { feedback } : {}),
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
 * 输出按预算组装：主人评价 → 关于在场的人 → 群里的说法 → 你还记得；总长超 renderChars
 * 时按完整行从后往前裁。块序即机械优先级（T10 画像在场优先）：当前轮/当前群在场说话人
 * 的画像块排在说法与卡片之前，预算紧张时先保住的是在场画像；主人评价永远最前（T7）。
 */
