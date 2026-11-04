/**
 * 新闻客户端：八源取数 + 源探活降级 + topic 两层映射（外部计划 E6，决策 11/13）。
 *
 * 源与端点（决策 11 的 sources 枚举一一对应）：
 *   - 60s / weibo_hot / baidu_hot：自建 60s 服务（vikiboss/60s，Docker loopback 4399，
 *     部署属运维）——/v2/60s、/v2/weibo、/v2/baidu/hot；本机没起服务时请求失败，
 *     走单源降级（不阻断其它源），验证用注入的 fixture fetch；
 *   - jiemian / huxiu / ithome / people：RSS 2.0，fast-xml-parser 受限解析
 *     （决策 13：响应 ≤2MB、超时 10s、实体展开限制，只取 title/link/pubDate/description≤200）；
 *   - zhihu_daily：知乎日报官方 API。
 *
 * 源探活冗余：健康状态只在内存（每次进程重启重探），单源失败降内容不阻断，
 * 状态翻转才落日志（一次性）；一次收集的全部源都失败才抛 NewsAllSourcesDownError。
 *
 * topic 两层映射（collectForTopics）：sources 取数 → keywords 命中优先 →
 * 未命中兜底（防关键词太窄空供料）→ exclude 标题黑名单（命中即丢）→
 * 去重 → 截 perTopicInput。输出统一 {title,url,source,publishedAt}，
 * 全部字段过 sanitizeExternalText / sanitizeUrl（E1）。
 *
 * 时钟、超时、fetch 全部可注入；不透传原始 JSON、不使用 any。
 */
import { XMLParser } from "fast-xml-parser";
import { sanitizeExternalText, sanitizeUrl } from "./sanitize.ts";

/** 60s 服务根地址（自建 Docker，缺省 loopback 4399；环境变量 SIXTY_BASE_URL 可覆盖缺省，测试注入 fixture 仍最高）。 */
export const DEFAULT_60S_API_ROOT = "http://127.0.0.1:4399";

/** 知乎日报官方 API（最新一期 stories）。 */
export const DEFAULT_ZHIHU_DAILY_API = "https://news-at.zhihu.com/api/4/news/latest";

/** RSS 源的缺省端点（RSS 2.0）；结构体可在构造时按源覆盖（如镜像/自建转发）。 */
export const DEFAULT_NEWS_FEEDS: Readonly<Record<RssSourceId, string>> = {
  // 界面已停官方 RSS：该地址恢复即自动可用；失效时按单源降级，可经 feeds 覆盖
  jiemian: "https://www.jiemian.com/rss/",
  huxiu: "https://rss.huxiu.com/",
  ithome: "https://www.ithome.com/rss/",
  people: "http://www.people.com.cn/rss/politics.xml",
};

/** 单源请求超时（决策 13：10s）。 */
export const NEWS_FETCH_TIMEOUT_MS = 10_000;

/** 单响应体量上限（决策 13：≤2MB）。 */
export const NEWS_MAX_RESPONSE_BYTES = 2 * 1024 * 1024;

/** 实体展开限制：全文实体引用总数上限（含 DTD 实体声明直接拒绝）。 */
export const NEWS_MAX_ENTITY_REFS = 20_000;

/** 单源条目上限（热榜/RSS 都远超每 topic 需要的池子，截住防内存膨胀）。 */
export const NEWS_MAX_ITEMS_PER_SOURCE = 60;

/** 标题与 description 的清洗上限（description≤200 属决策 13 解析范围）。 */
export const NEWS_TEXT_MAX = 200;

const PINNED_UA =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36";

/** 与 fish-config 的 NEWS_SOURCES 同集的窄类型（配置侧是 string，消费处再窄化）。 */
export type NewsSourceId =
  | "60s"
  | "jiemian"
  | "huxiu"
  | "ithome"
  | "people"
  | "zhihu_daily"
  | "weibo_hot"
  | "baidu_hot";

export const NEWS_SOURCE_IDS: readonly NewsSourceId[] = [
  "60s",
  "jiemian",
  "huxiu",
  "ithome",
  "people",
  "zhihu_daily",
  "weibo_hot",
  "baidu_hot",
];

type RssSourceId = "jiemian" | "huxiu" | "ithome" | "people";

/**
 * 来源署名的中文显示名（decisions §5.7）：宿主渲染新闻成品时用这份映射，模型不写来源名。
 * 枚举 id 只用于配置/取数与审计，不进模型可见文本。
 */
export const NEWS_SOURCE_LABELS: Readonly<Record<NewsSourceId, string>> = {
  "60s": "60秒",
  jiemian: "界面",
  huxiu: "虎嗅",
  ithome: "IT之家",
  people: "人民网",
  zhihu_daily: "知乎日报",
  weibo_hot: "微博热搜",
  baidu_hot: "百度热搜",
};

/** 来源显示名：未知枚举原样回退（旧配置/新增源的兼容路径），不抛错。 */
export function newsSourceLabelOf(source: string): string {
  return (NEWS_SOURCE_LABELS as Readonly<Record<string, string>>)[source] ?? source;
}

export function isNewsSourceId(value: string): value is NewsSourceId {
  return (NEWS_SOURCE_IDS as readonly string[]).includes(value);
}

/** 统一输出条目：四个字段全部过 sanitize（title 清洗、url 只留 http/https）。 */
export interface NewsItem {
  title: string;
  url: string;
  source: NewsSourceId;
  /** ISO 8601（UTC）；源没有日期时用取数时刻。 */
  publishedAt: string;
}

/** 内部形态：多带一层 matchText（标题+简介小写化）供两层映射匹配，不出客户端。 */
interface CollectedItem extends NewsItem {
  matchText: string;
}

/** 单源健康状态（内存态，重启重探）。 */
export interface SourceHealth {
  ok: boolean;
  lastOkAt?: string;
  lastError?: string;
  failureStreak: number;
}

/** topic 供料入参：与 fish-config 的 NewsTopicConfig 结构同形。 */
export interface NewsTopicQuery {
  name: string;
  sources: readonly string[];
  keywords: readonly string[];
  exclude: readonly string[];
}

export interface NewsTopicFeed {
  topic: string;
  items: NewsItem[];
}

/** 全部需要的源都失败（决策 12：当日不发）——与普通单源错误可区分。 */
export class NewsAllSourcesDownError extends Error {
  readonly failed: string[];
  constructor(failed: string[]) {
    super(`新闻全源失败：${failed.join(" | ")}`);
    this.name = "NewsAllSourcesDownError";
    this.failed = failed;
  }
}

export interface NewsTimers {
  setTimer: (callback: () => void, ms: number) => unknown;
  clearTimer: (handle: unknown) => void;
}

const nodeTimers: NewsTimers = {
  setTimer: (callback, ms) => setTimeout(callback, ms).unref?.(),
  clearTimer: (handle) => clearTimeout(handle as NodeJS.Timeout),
};

export interface NewsClientOptions {
  /** 60s 服务根地址；缺省环境变量 SIXTY_BASE_URL，未设置/空值回退 loopback 4399。 */
  api60sRoot?: string;
  /** RSS 端点覆盖（按源）。 */
  feeds?: Partial<Record<RssSourceId, string>>;
  /** 知乎日报 API 覆盖。 */
  zhihuDailyApi?: string;
  /** 单请求超时 ms；缺省 NEWS_FETCH_TIMEOUT_MS。 */
  timeoutMs?: number;
  /** 响应上限字节；缺省 NEWS_MAX_RESPONSE_BYTES。 */
  maxResponseBytes?: number;
  /** fetch 注入（缺省全局 fetch）。 */
  fetchImpl?: typeof fetch;
  /** 时钟注入（无日期源的 publishedAt 与健康时间戳用它）。 */
  now?: () => Date;
  /** 定时器注入（超时用；缺省 unref 的 node 定时器）。 */
  timers?: NewsTimers;
  log?: (message: string) => void;
}

export interface NewsClient {
  /** 单源取数（含健康记账）；失败抛错，由调用方决定降级。 */
  fetchSource(source: NewsSourceId): Promise<NewsItem[]>;
  /** 健康状态快照（只含已探测过的源）。 */
  health(): Record<string, SourceHealth>;
  /** 按 topic 两层映射供料；一次收集内同源只取一次。全源失败抛 NewsAllSourcesDownError。 */
  collectForTopics(
    topics: readonly NewsTopicQuery[],
    limits: { perTopicInput: number },
  ): Promise<NewsTopicFeed[]>;
}

// ===== 原始 JSON 的窄化工具（同 bili-client 的套路，不透传原始结构） =====

interface RawRecord {
  [key: string]: unknown;
}

function rec(value: unknown): RawRecord {
  return value !== null && typeof value === "object" && !Array.isArray(value) ? (value as RawRecord) : {};
}

function numOf(value: unknown): number {
  const n = typeof value === "number" ? value : typeof value === "string" ? Number(value) : NaN;
  return Number.isFinite(n) ? n : 0;
}

function strOf(value: unknown): string {
  return typeof value === "string" ? value : typeof value === "number" && Number.isFinite(value) ? String(value) : "";
}

function arrOf(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** RSS 值节点可能是字符串、数字或混合内容对象（取 #text）。 */
function textOf(value: unknown): string {
  if (typeof value === "string") return value;
  if (typeof value === "number" && Number.isFinite(value)) return String(value);
  if (value !== null && typeof value === "object") return strOf(rec(value)["#text"]);
  return "";
}

/** 简介里的 HTML 标签换成空格（只在匹配文本里做，不产出给模型）。 */
function stripTags(value: string): string {
  return value.replace(/<[^>]*>/g, " ");
}

// ===== 日期规整：全部归一成 UTC ISO =====

/**
 * 未知/无法解析时退到 fallback（取数时刻）。中国媒体源的裸日期（YYYY-MM-DD[ HH:MM[:SS]]
 * 与知乎 YYYYMMDD）按 +08:00 读，避免宿主时区漂移；RFC822 由 Date 原生解析。
 */
function toIsoDate(value: unknown, fallback: Date): string {
  let parsed: Date | undefined;
  if (typeof value === "number" && Number.isFinite(value) && value > 0) {
    parsed = new Date(value > 1e12 ? value : value * 1000);
  } else if (typeof value === "string" && value.trim().length > 0) {
    const s = value.trim();
    let m = /^(\d{4})(\d{2})(\d{2})$/.exec(s);
    if (m) {
      parsed = new Date(`${m[1]}-${m[2]}-${m[3]}T00:00:00+08:00`);
    } else if ((m = /^(\d{4}-\d{2}-\d{2})(?:[ T](\d{2}:\d{2}(?::\d{2})?))?$/.exec(s))) {
      const time = m[2] === undefined ? "00:00:00" : m[2].length === 5 ? `${m[2]}:00` : m[2];
      parsed = new Date(`${m[1]}T${time}+08:00`);
    } else {
      const t = new Date(s);
      parsed = Number.isNaN(t.getTime()) ? undefined : t;
    }
  }
  const chosen = parsed !== undefined && !Number.isNaN(parsed.getTime()) ? parsed : fallback;
  return chosen.toISOString();
}

// ===== RSS 受限解析（fast-xml-parser） =====

const xmlParser = new XMLParser({
  ignoreAttributes: true,
  parseTagValue: false,
  parseAttributeValue: false,
  trimValues: true,
  processEntities: true,
  textNodeName: "#text",
  isArray: (name: string) => name === "item",
});

/** 解析前硬边界：拒绝 DTD 实体声明（billion laughs 载体），实体引用总数封顶。 */
function assertRssGuards(text: string): void {
  if (/<!ENTITY/i.test(text)) throw new Error("含 DTD 实体声明");
  const refs = text.match(/&[a-zA-Z#][a-zA-Z0-9]{0,10};g?/g) ?? [];
  if (refs.length > NEWS_MAX_ENTITY_REFS) throw new Error(`实体引用过多(${refs.length})`);
}

/** 只支持 RSS 2.0 的 rss.channel.item；字段只取 title/link/pubDate/description。 */
function parseRssRawItems(text: string): RawRecord[] {
  assertRssGuards(text);
  const parsed: unknown = xmlParser.parse(text);
  const channel = rec(rec(rec(parsed)["rss"])["channel"]);
  return arrOf(channel["item"]).filter((entry): entry is RawRecord => entry !== null && typeof entry === "object" && !Array.isArray(entry));
}

export function createNewsClient(options: NewsClientOptions = {}): NewsClient {
  const api60sRoot = (options.api60sRoot ?? (process.env.SIXTY_BASE_URL || DEFAULT_60S_API_ROOT)).replace(/\/+$/, "");
  const feeds: Readonly<Record<RssSourceId, string>> = { ...DEFAULT_NEWS_FEEDS, ...options.feeds };
  const zhihuDailyApi = options.zhihuDailyApi ?? DEFAULT_ZHIHU_DAILY_API;
  const timeoutMs = Math.max(1, Math.floor(options.timeoutMs ?? NEWS_FETCH_TIMEOUT_MS));
  const maxBytes = Math.max(1, Math.floor(options.maxResponseBytes ?? NEWS_MAX_RESPONSE_BYTES));
  const doFetch = options.fetchImpl ?? fetch;
  const now = options.now ?? (() => new Date());
  const timers = options.timers ?? nodeTimers;
  const log = (message: string): void => {
    try {
      options.log?.(message);
    } catch {
      // 日志不许炸取数
    }
  };

  // ===== 带体量上限与超时的文本请求 =====

  /** 读响应体并封顶：超限即 cancel 下载（不再 abort 信号，避免与超时语义混淆）。 */
  async function readBodyCapped(res: Response): Promise<string> {
    const reader = res.body?.getReader();
    if (reader === undefined) {
      const text = await res.text();
      if (Buffer.byteLength(text, "utf8") > maxBytes) throw new Error(`响应超限(>${maxBytes}B)`);
      return text;
    }
    const chunks: Uint8Array[] = [];
    let total = 0;
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      if (value === undefined) continue;
      total += value.byteLength;
      if (total > maxBytes) {
        await reader.cancel().catch(() => undefined);
        throw new Error(`响应超限(>${maxBytes}B)`);
      }
      chunks.push(value);
    }
    const merged = new Uint8Array(total);
    let offset = 0;
    for (const chunk of chunks) {
      merged.set(chunk, offset);
      offset += chunk.byteLength;
    }
    return new TextDecoder("utf-8").decode(merged);
  }

  async function requestText(url: string): Promise<string> {
    const ctrl = new AbortController();
    const timer = timers.setTimer(() => ctrl.abort(), timeoutMs);
    try {
      const res = await doFetch(url, {
        headers: { "user-agent": PINNED_UA, accept: "application/rss+xml, application/xml;q=0.9, application/json;q=0.8, */*;q=0.8" },
        signal: ctrl.signal,
        redirect: "follow",
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const declared = Number(res.headers.get("content-length") ?? "");
      if (Number.isFinite(declared) && declared > maxBytes) throw new Error(`响应超限(${declared}B)`);
      return await readBodyCapped(res);
    } catch (error) {
      if (ctrl.signal.aborted) throw new Error(`超时(>${timeoutMs}ms)`);
      throw new Error(messageOf(error));
    } finally {
      timers.clearTimer(timer);
    }
  }

  async function requestJson(url: string): Promise<unknown> {
    const text = await requestText(url);
    try {
      return JSON.parse(text);
    } catch {
      throw new Error("响应不是 JSON");
    }
  }

  // ===== 清洗边界：所有源的字段在这里收口 =====

  function toItem(
    source: NewsSourceId,
    rawTitle: unknown,
    rawUrl: unknown,
    rawDate: unknown,
    rawDesc?: unknown,
  ): CollectedItem | undefined {
    const title = sanitizeExternalText(strOf(rawTitle), { maxLen: NEWS_TEXT_MAX });
    const url = sanitizeUrl(strOf(rawUrl));
    if (title.length === 0 || url === undefined) return undefined;
    const desc = sanitizeExternalText(stripTags(strOf(rawDesc)), { maxLen: NEWS_TEXT_MAX });
    return {
      title,
      url,
      source,
      publishedAt: toIsoDate(rawDate, now()),
      matchText: `${title} ${desc}`.toLowerCase(),
    };
  }

  function toPublic(item: CollectedItem): NewsItem {
    return { title: item.title, url: item.url, source: item.source, publishedAt: item.publishedAt };
  }

  // ===== 各源解析 =====

  /** 60s：data.news 为字符串或 {title,link} 混排；全天共用 data.link 这篇 canonical 文章。 */
  function parse60s(json: unknown): CollectedItem[] {
    const envelope = rec(json);
    if (numOf(envelope["code"]) !== 200) throw new Error(`60s code=${numOf(envelope["code"])}`);
    const data = rec(envelope["data"]);
    const dayLink = strOf(data["link"]);
    const date = data["created_at"] ?? data["date"];
    const out: CollectedItem[] = [];
    for (const entry of arrOf(data["news"])) {
      const item =
        typeof entry === "string"
          ? toItem("60s", entry, dayLink, date)
          : toItem("60s", rec(entry)["title"], strOf(rec(entry)["link"]) || dayLink, date, rec(entry)["description"]);
      if (item !== undefined) out.push(item);
      if (out.length >= NEWS_MAX_ITEMS_PER_SOURCE) break;
    }
    if (out.length === 0) throw new Error("60s 无可用条目");
    return out;
  }

  /** 热榜（/v2/weibo、/v2/baidu/hot）：字段名按各家宽容取，日期缺省取数时刻。 */
  function parseHotList(json: unknown, source: "weibo_hot" | "baidu_hot"): CollectedItem[] {
    const envelope = rec(json);
    if (numOf(envelope["code"]) !== 200) throw new Error(`${source} code=${numOf(envelope["code"])}`);
    const out: CollectedItem[] = [];
    for (const entry of arrOf(envelope["data"])) {
      const r = rec(entry);
      const url = strOf(r["url"]) || strOf(r["link"]) || strOf(r["url_m"]) || strOf(r["url_pc"]);
      const item = toItem(
        source,
        strOf(r["title"]) || strOf(r["word"]) || strOf(r["query"]),
        url,
        r["created_at"] ?? undefined,
        r["desc"] ?? r["detail"],
      );
      if (item !== undefined) out.push(item);
      if (out.length >= NEWS_MAX_ITEMS_PER_SOURCE) break;
    }
    if (out.length === 0) throw new Error(`${source} 无可用条目`);
    return out;
  }

  function parseRss(text: string, source: RssSourceId): CollectedItem[] {
    const out: CollectedItem[] = [];
    for (const entry of parseRssRawItems(text)) {
      const item = toItem(source, entry["title"], entry["link"], entry["pubDate"], entry["description"]);
      if (item !== undefined) out.push(item);
      if (out.length >= NEWS_MAX_ITEMS_PER_SOURCE) break;
    }
    if (out.length === 0) throw new Error(`${source} 无可用条目`);
    return out;
  }

  /** 知乎日报：stories[].url 缺失时退 daily.zhihu.com/story/{id}；date 为 YYYYMMDD。 */
  function parseZhihuDaily(json: unknown): CollectedItem[] {
    const root = rec(json);
    const date = root["date"];
    const out: CollectedItem[] = [];
    for (const entry of arrOf(root["stories"])) {
      const r = rec(entry);
      const id = strOf(r["id"]);
      const url = strOf(r["url"]) || (id.length > 0 ? `https://daily.zhihu.com/story/${id}` : "");
      const item = toItem("zhihu_daily", r["title"], url, date, r["hint"]);
      if (item !== undefined) out.push(item);
      if (out.length >= NEWS_MAX_ITEMS_PER_SOURCE) break;
    }
    if (out.length === 0) throw new Error("zhihu_daily 无可用条目");
    return out;
  }

  // ===== 健康记账（内存 + 状态翻转一次性日志） =====

  interface HealthState {
    ok: boolean;
    lastOkAt?: string;
    lastError?: string;
    failureStreak: number;
  }

  const healthStates = new Map<NewsSourceId, HealthState>();

  function markOk(source: NewsSourceId): void {
    const prev = healthStates.get(source);
    if (prev !== undefined && !prev.ok) log(`新闻源 ${source} 恢复`);
    healthStates.set(source, { ok: true, lastOkAt: now().toISOString(), failureStreak: 0 });
  }

  function markDown(source: NewsSourceId, message: string): void {
    const prev = healthStates.get(source);
    const streak = (prev?.failureStreak ?? 0) + 1;
    // 翻转才报：连续失败只刷 streak，不刷屏
    if (prev === undefined || prev.ok) log(`新闻源 ${source} 不可用：${message}`);
    healthStates.set(source, { ok: false, lastError: message, failureStreak: streak });
  }

  async function fetchRaw(source: NewsSourceId): Promise<CollectedItem[]> {
    switch (source) {
      case "60s":
        return parse60s(await requestJson(`${api60sRoot}/v2/60s`));
      case "weibo_hot":
        return parseHotList(await requestJson(`${api60sRoot}/v2/weibo`), "weibo_hot");
      case "baidu_hot":
        return parseHotList(await requestJson(`${api60sRoot}/v2/baidu/hot`), "baidu_hot");
      case "zhihu_daily":
        return parseZhihuDaily(await requestJson(zhihuDailyApi));
      case "jiemian":
      case "huxiu":
      case "ithome":
      case "people":
        return parseRss(await requestText(feeds[source]), source);
    }
  }

  async function fetchWithHealth(source: NewsSourceId): Promise<CollectedItem[]> {
    try {
      const items = await fetchRaw(source);
      markOk(source);
      return items;
    } catch (error) {
      markDown(source, messageOf(error).slice(0, 80));
      throw error;
    }
  }

  // ===== topic 两层映射 =====

  const warnedUnknown = new Set<string>();

  async function collectForTopics(
    topics: readonly NewsTopicQuery[],
    limits: { perTopicInput: number },
  ): Promise<NewsTopicFeed[]> {
    const cap = Math.max(1, Math.floor(limits.perTopicInput));
    const queries = topics.map((topic) => {
      const sources: NewsSourceId[] = [];
      for (const raw of topic.sources) {
        const id = String(raw);
        if (isNewsSourceId(id)) {
          if (!sources.includes(id)) sources.push(id);
        } else if (!warnedUnknown.has(id)) {
          warnedUnknown.add(id);
          log(`未知新闻源，已忽略：${id}`);
        }
      }
      return {
        name: strOf(topic.name),
        sources,
        keywords: topic.keywords.map((k) => String(k).toLowerCase().trim()).filter((k) => k.length > 0),
        exclude: topic.exclude.map((k) => String(k).toLowerCase().trim()).filter((k) => k.length > 0),
      };
    });

    const needed = [...new Set(queries.flatMap((query) => query.sources))];
    const loaded = new Map<NewsSourceId, CollectedItem[]>();
    const failures: string[] = [];
    await Promise.all(
      needed.map(async (source) => {
        try {
          loaded.set(source, await fetchWithHealth(source));
        } catch (error) {
          failures.push(`${source}:${messageOf(error).slice(0, 60)}`);
        }
      }),
    );
    if (needed.length > 0 && loaded.size === 0) throw new NewsAllSourcesDownError(failures);

    return queries.map((query) => {
      const pool = query.sources.flatMap((source) => loaded.get(source) ?? []);
      // exclude 黑名单：标题命中即丢（简介不参与，误伤面更小）
      const kept = pool.filter((item) => !query.exclude.some((word) => item.title.toLowerCase().includes(word)));
      // 第一层：keywords 命中（标题+简介）优先；第二层：未命中按源顺序兜底
      const hits = kept.filter((item) => query.keywords.some((word) => item.matchText.includes(word)));
      const hitSet = new Set(hits);
      const fallback = kept.filter((item) => !hitSet.has(item));
      // 去重：url+title 联合键（60s 全天共用一篇 canonical 链接，纯 url 会把
      // 一天的十几条误杀成一条）
      const seen = new Set<string>();
      const items: NewsItem[] = [];
      for (const item of [...hits, ...fallback]) {
        const key = `${item.url}\n${item.title}`;
        if (seen.has(key)) continue;
        seen.add(key);
        items.push(toPublic(item));
        if (items.length >= cap) break;
      }
      return { topic: query.name, items };
    });
  }

  return {
    async fetchSource(source: NewsSourceId): Promise<NewsItem[]> {
      if (!isNewsSourceId(source)) throw new Error(`未知新闻源：${source}`);
      return (await fetchWithHealth(source)).map(toPublic);
    },
    health(): Record<string, SourceHealth> {
      const out: Record<string, SourceHealth> = {};
      for (const [source, state] of healthStates) {
        out[source] = {
          ok: state.ok,
          failureStreak: state.failureStreak,
          ...(state.lastOkAt !== undefined ? { lastOkAt: state.lastOkAt } : {}),
          ...(state.lastError !== undefined ? { lastError: state.lastError } : {}),
        };
      }
      return out;
    },
    collectForTopics,
  };
}
