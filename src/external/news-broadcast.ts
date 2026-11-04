/** 新闻成品与任务输入渲染：宿主和权威模板机械测试共用的无副作用入口。 */
import { renderTemplate } from "../prompts.ts";
import type { MessageTable } from "../qq/model-input.ts";
import type { NewsItem } from "./news-client.ts";
import { newsSourceLabelOf } from "./news-client.ts";

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

/** 新闻轮模型输入：[新闻播报] + 宿主成品。 */
export function renderNewsTask(messages: MessageTable, broadcast: string): string {
  const task = messages["news_broadcast_task"] ?? "";
  return task.length > 0 ? `${task}\n${broadcast}` : broadcast;
}
