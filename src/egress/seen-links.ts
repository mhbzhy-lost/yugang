/**
 * 本轮「模型见过的链接」白名单（2026-11-05）：出口侧允许写 URL 的唯一依据。
 *
 * 规则：`say_words` 的文本里出现的每个 http(s) 链接，都必须是**本轮工具结果里真的
 * 出现过**的那一条。工具结果（video 卡片、bili_video 卡片、search 摘要、新闻成品…）
 * 由宿主在工具执行返回后机械抽取登记；群友消息里的链接不算——想转发别人贴的链接，
 * 得先自己用工具打开一遍，让宿主把 canonical 链接还给模型。这样既不需要 videoBvid
 * 这类专用字段，也不允许模型凭空编 URL 或把陌生人塞进来的链接原样播出去。
 *
 * 生命周期与轮绑定：宿主在轮 settle 时 clearSeenLinks(round)，跨轮不残留（与
 * viewed 登记同款收口方式）；同一 conversation 只保留当前轮的集合，上限
 * SEEN_LINKS_CAP，超出丢最旧的，避免长轮把内存撑大。
 */

export const SEEN_LINKS_CAP = 40;

/** roundId（unknown，宿主传 LiveDoc 的 run.inputs[0]）→ 本轮见过的链接（按出现顺序）。 */
const seen = new Map<unknown, string[]>();

/** 从任意工具结果里抽 http(s) 链接：只认绝对 URL，去掉尾部标点，去重保序。 */
export function extractLinks(text: string): string[] {
  const out: string[] = [];
  // 只吃 ASCII URL 字符（RFC 3986 的 unreserved + reserved 常见集）：中文标点、全角括号
  // 与空格天然终止匹配，避免把「链接后面的中文」一起吃进去；尾部标点再削一次
  for (const match of text.matchAll(/https?:\/\/[A-Za-z0-9\-._~:/?#\[\]@!$&'()*+,;=%]+/g)) {
    const url = (match[0] ?? "").replace(/[.,;:!?]+$/, "");
    if (url.length === 0 || out.includes(url)) continue;
    out.push(url);
  }
  return out;
}

/** 登记本轮工具结果里出现过的链接（宿主在工具返回后调用；幂等、有上限）。 */
export function recordSeenLinks(round: unknown, urls: readonly string[]): void {
  if (round === undefined || urls.length === 0) return;
  const list = seen.get(round) ?? [];
  for (const url of urls) {
    if (!list.includes(url)) list.push(url);
  }
  while (list.length > SEEN_LINKS_CAP) list.shift();
  seen.set(round, list);
}

/** 本轮见过的链接；没登记过 = 空集（白名单为空 → 任何 URL 都会被拒）。 */
export function seenLinksOf(round: unknown): ReadonlySet<string> {
  return new Set(seen.get(round) ?? []);
}

/** 轮末清账（宿主 settle 时调用）：不残留到下一轮。 */
export function clearSeenLinks(round: unknown): void {
  seen.delete(round);
}

/** 测试/排障用：清空全部（生产不调用）。 */
export function clearAllSeenLinks(): void {
  seen.clear();
}
