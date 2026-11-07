/** 新闻成品与任务输入渲染：宿主和权威模板机械测试共用的无副作用入口。 */
import { renderTemplate } from "../prompt/index.ts";
import type { MessageTable } from "../qq/model-input.ts";
import type { NewsItem, NewsTopicFeed } from "./news-client.ts";
import { newsSourceLabelOf } from "./news-client.ts";
import { sanitizeExternalText } from "./sanitize.ts";

export const NEWS_BROADCAST_MAX_CHARS = 500;

export interface NewsDigestItem { summary: string; sourceRef: string }
export interface NewsDigestSection { topic: string; items: NewsDigestItem[] }
export interface NewsDigest { sections: NewsDigestSection[]; closing: string }

/** 按 topic 顺序裁剪到预算内，链接只从宿主 sourceRef 索引渲染。 */
export function renderNewsBroadcast(
  day: string,
  digest: NewsDigest,
  index: ReadonlyMap<string, NewsItem>,
  messages: MessageTable,
  budgetChars = NEWS_BROADCAST_MAX_CHARS,
): { text: string; links: string[] } {
  const headerTpl = messages["news_header"] ?? "";
  const topicTpl = messages["news_topic"] ?? "";
  const itemTpl = messages["news_item"] ?? "";
  const closingTpl = messages["news_closing"] ?? "";
  if (headerTpl.length === 0 || topicTpl.length === 0 || itemTpl.length === 0) return { text: "", links: [] };
  const closingLine = digest.closing.length > 0 && closingTpl.length > 0 ? renderTemplate(closingTpl, { closing: digest.closing }) : "";
  const lines: string[] = [];
  const links: string[] = [];
  let used = 0;
  const add = (line: string, limit: number): boolean => {
    if (line.length === 0) return false;
    const sep = lines.length > 0 ? 1 : 0;
    if (used + sep + line.length > limit) return false;
    lines.push(line);
    used += sep + line.length;
    return true;
  };
  if (!add(renderTemplate(headerTpl, { date: day }), budgetChars)) return { text: "", links: [] };
  const reserved = closingLine.length > 0 && used + 1 + closingLine.length <= budgetChars ? closingLine.length + 1 : 0;
  const itemBudget = budgetChars - reserved;
  for (const section of digest.sections) {
    const entries = section.items.flatMap((item) => {
      const news = index.get(item.sourceRef);
      return news ? [{ line: renderTemplate(itemTpl, { summary: item.summary, source: newsSourceLabelOf(news.source), url: news.url }), url: news.url }] : [];
    });
    const block = [renderTemplate(topicTpl, { topic: section.topic }), ...entries.map((entry) => entry.line)];
    let fits = 0;
    let size = used;
    for (const line of block) {
      const sep = size > 0 ? 1 : 0;
      if (size + sep + line.length > itemBudget) break;
      size += sep + line.length;
      fits += 1;
    }
    if (fits <= 1) break;
    for (let i = 0; i < fits; i++) add(block[i]!, itemBudget);
    for (const entry of entries.slice(0, fits - 1)) links.push(entry.url);
    if (fits < block.length) break;
  }
  add(closingLine, budgetChars);
  return { text: lines.join("\n"), links };
}

export interface NewsCandidateInput {
  prompt: string;
  index: Map<string, NewsItem>;
  refsByTopic: Map<string, Set<string>>;
}

/** 标题级候选输入：URL 只在宿主索引里，模型只看 sourceRef 与标题。 */
export function buildNewsCandidateInput(feeds: readonly NewsTopicFeed[]): NewsCandidateInput {
  const index = new Map<string, NewsItem>();
  const refsByTopic = new Map<string, Set<string>>();
  const blocks: string[] = [];
  let seq = 0;
  for (const feed of feeds) {
    const lines: string[] = [];
    const refs = new Set<string>();
    for (const item of feed.items) {
      const ref = String(seq++);
      index.set(ref, item);
      refs.add(ref);
      lines.push(`[${ref}] ${item.title}`);
    }
    refsByTopic.set(feed.topic, refs);
    blocks.push([`## ${feed.topic}`, ...lines].join("\n"));
  }
  return { prompt: blocks.join("\n\n"), index, refsByTopic };
}

function objectOf(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined;
}

function exactKeys(value: Record<string, unknown>, expected: readonly string[]): boolean {
  const actual = Object.keys(value).sort();
  const wanted = [...expected].sort();
  return actual.length === wanted.length && actual.every((key, index) => key === wanted[index]);
}

function cleanText(value: unknown, max: number): string | undefined {
  if (typeof value !== "string" || [...value].length > max) return undefined;
  const cleaned = sanitizeExternalText(value, { maxLen: max });
  if (!cleaned || /(?:https?:\/\/|www\.)/i.test(cleaned)) return undefined;
  return cleaned;
}

export type NewsDigestValidation =
  | { ok: true; digest: NewsDigest }
  | { ok: false; reason: string };

/** 工具与确定性测试共用的严格结构校验；不采信模型提供的 URL。 */
export function validateNewsDigest(
  raw: unknown,
  feeds: readonly NewsTopicFeed[],
  candidates: NewsCandidateInput,
  perTopicOutput: number,
): NewsDigestValidation {
  const root = objectOf(raw);
  if (!root || !exactKeys(root, ["sections", "closing"]) || !Array.isArray(root["sections"])) {
    return { ok: false, reason: "shape" };
  }
  const byTopic = new Map<string, NewsDigestSection>();
  const usedRefs = new Set<string>();
  for (const value of root["sections"]) {
    const section = objectOf(value);
    if (!section || !exactKeys(section, ["topic", "items"]) || !Array.isArray(section["items"])) {
      return { ok: false, reason: "section_shape" };
    }
    const topic = typeof section["topic"] === "string" ? section["topic"] : "";
    const allowedRefs = candidates.refsByTopic.get(topic);
    if (!allowedRefs || byTopic.has(topic) || section["items"].length > perTopicOutput) {
      return { ok: false, reason: "topic_or_limit" };
    }
    const items: NewsDigestItem[] = [];
    for (const value of section["items"]) {
      const item = objectOf(value);
      if (!item || !exactKeys(item, ["summary", "sourceRef"])) return { ok: false, reason: "item_shape" };
      const sourceRef = typeof item["sourceRef"] === "string" ? item["sourceRef"].trim() : "";
      const summary = cleanText(item["summary"], 60);
      if (!summary || !allowedRefs.has(sourceRef) || usedRefs.has(sourceRef)) {
        return { ok: false, reason: "source_or_summary" };
      }
      usedRefs.add(sourceRef);
      items.push({ summary, sourceRef });
    }
    byTopic.set(topic, { topic, items });
  }
  const sections: NewsDigestSection[] = [];
  for (const feed of feeds) {
    const section = byTopic.get(feed.topic);
    if (!section) return { ok: false, reason: "missing_topic" };
    byTopic.delete(feed.topic);
    if (section.items.length > 0) sections.push(section);
  }
  if (byTopic.size > 0 || sections.length === 0) return { ok: false, reason: "empty_or_unknown" };
  const closing = cleanText(root["closing"], 30);
  if (closing === undefined) return { ok: false, reason: "closing" };
  return { ok: true, digest: { sections, closing } };
}
