import type { RoundScope } from "./scope.ts";
import {
  MEMORY_CAPS,
  type FeedbackFactMeta,
  type MemoryFact,
  type MemoryPerson,
  type MemoryState,
} from "./model.ts";
import { byAgeHits } from "./patch.ts";

/** 渲染段预算：群里的说法 ≤200，单人 ≤240，卡片 ≤240，主人评价 ≤300。 */
const LORE_BUDGET = 200;
const PERSON_BUDGET = 240;
const CARDS_BUDGET = 240;
const FEEDBACK_BUDGET = 300;

/** 在场画像最多渲染几位说话人（T10 画像在场优先）：scope.speakers 由宿主构造
 *  （锚点发送者 + 最近背景发言者，顺序即优先级），这里再机械封顶。 */
const PRESENCE_SPEAKERS_CAP = 5;

export function renderMemory(state: MemoryState, scope: RoundScope | undefined, messages: Record<string, string>): string | undefined {
  if (!scope) return undefined;
  const loreHeader = sectionSafe(messages["memory_lore_header"] ?? "");
  const peopleHeader = sectionSafe(messages["memory_people_header"] ?? "");
  const cardsHeader = sectionSafe(messages["memory_cards_header"] ?? "");

  const blocks: string[][] = [];

  // 主人评价（/评 批准落地的 feedback fact）：机械加权置顶——本块永远排在 section
  // 最前（feedback 加权是 at+hits 之外的额外机械规则；块内排序仍照 at+hits 组合：
  // 零命中沉底、更新的在前）；renderChars 裁剪从后往前，评价块因此最后才被裁。
  // 渲染只读（零写入），一行摘要 = meta（方向/日期/被评摘要/统计）与 text（主人原话）
  const feedbackLines: string[] = [];
  const topFeedback = [...(state.feedback ?? [])]
    .filter((fact): fact is MemoryFact & { kind: "feedback"; meta: FeedbackFactMeta } =>
      fact.invalidAt === undefined && fact.kind === "feedback" && fact.meta !== undefined)
    .sort((a, b) => byAgeHits(b, a))
    .slice(0, MEMORY_CAPS.feedbackRender);
  for (const fact of topFeedback) {
    const line = `- 主人评价${fact.meta.direction}（${fact.meta.day}）：${sectionSafe(fact.text)}｜针对：${sectionSafe(fact.meta.targetSummary)}｜${sectionSafe(fact.meta.statsLine)}`;
    if (feedbackLines.join("\n").length + line.length + 1 > FEEDBACK_BUDGET) break;
    feedbackLines.push(line);
  }
  if (feedbackLines.length > 0) blocks.push(feedbackLines);

  // 关于在场的人（画像在场优先，T10）：scope.speakers 顺序 = 注入优先级（锚点发送者
  // 在前、最近背景发言者其后），机械封顶 PRESENCE_SPEAKERS_CAP 位；每人 ≤240 字
  // （最近 3 条有效事实 + style + 口头禅，personBlock 自限 PERSON_BUDGET，事实带
  // YYYY-MM 锚点）。本块排在说法/卡片之前：renderChars 从后往前裁时，先保住的正是在场画像
  const speakers = scope.speakers.slice(0, PRESENCE_SPEAKERS_CAP);
  const peopleLines: string[] = [];
  if (peopleHeader) peopleLines.push(peopleHeader);
  for (const speaker of speakers) {
    const person = matchPerson(state.people, speaker);
    if (!person) continue;
    const block = personBlock(person, speaker.name);
    if (block) peopleLines.push(block);
  }
  if (peopleLines.length > (peopleHeader ? 1 : 0)) blocks.push(peopleLines);

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

/** 时间锚点：YYYY-MM（本地时区）。渲染 fact/卡片时附带，让模型分得清陈年旧事与近况；
 *  压缩链路的 known 事实行同款消费（T11）。 */
export function monthAnchor(at: number): string {
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
