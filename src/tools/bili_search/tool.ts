/**
 * bili_search —— 按关键词搜 B 站视频（2026-11-25 重做，替换旧工具的固定分区榜单）。
 *
 * 候选来源是 DeepSeek Search（src/external/deepseek-search.ts 共享客户端）：
 * 模型传自由关键词，宿主自动拼 `site:bilibili.com/video` 与 `after:YYYY-MM-DD`
 * （缺省近 60 天，days: 0 不限时间），只认严格的 bilibili.com/video/BV… 路径
 * （biliVideoBvidOfUrl），不消耗 B 站 API 每日配额、不补齐播放/点赞元数据。
 *
 * 机械漏斗：严格 BV 过滤 + 多锚点去重（同 BV 带 #2/#5 或 query 只留首条）→
 * 时间窗兜底（days > 0 的首轮按 publishedAtMs 剔除超窗条目，无日期保留）→
 * 本群 fish.video_pool 去重（shared 永久 + seen 7 天）→ 4 条文本硬筛
 * （titleBait / uc / listicle / promoDesc，配置与 bili-client 共用）→ 紧凑行式返回。
 * 窗口内有效结果 < 3 条时在总预算内自动去掉 after: 放宽重搜一次并合并去重
 * （时间窗结果优先），放宽失败保留首次结果、如实不标已放宽。
 *
 * 资源与取消安全：整次执行（首呼 + 放宽）共享 24s 总预算（首呼 ≤14s，剩余 ≥4s
 * 才放宽），透传 context.abortSignal；写 VideoPoolDoc 前复查取消信号，中止/失败/
 * 空结果不占轮内额度（每轮最多 2 次，支持换词重试一次）、不写 seen。
 *
 * 输出行只含 BV 号、不含任何链接（标题/简介的内嵌 URL 已抹除）：分享链接必须
 * 经 video 实际观看后由宿主 canonical 渲染，防止 seen-links 白名单被提前污染。
 * 审计只打元数据（BV + 规则名 + 正则来源），不打标题/简介内容。
 *
 * 说明文字与参数 Schema 唯一来自 TOOL.md manifest（factory 只消费它）。
 */
import { LiveDoc, defineTool, type ConversationId, type ToolRegistration } from "@earendil-works/pi-durable";
import {
  SearchResponseError,
  cleanSearchText,
  deepseekSearch,
  type DeepSeekSearchItem,
} from "../../external/deepseek-search.ts";
import { compileFilterPatterns, createBiliFiltersLoader, type BiliFilters } from "../../external/bili-client.ts";
import { biliVideoBvidOfUrl } from "../../external/video-links.ts";
import {
  VideoPoolDoc,
  activeSeenOf,
  applyVideoPoolSeen,
  videoPoolKeyOf,
  type VideoPoolState,
} from "../../external/video-pool.ts";
import { renderTemplate } from "../../prompt/index.ts";
import { manifestParameters, toolFullDescription } from "../manifest.ts";
import type { ToolManifest, ToolPackageDeps } from "../types.ts";

// =====================================================================================
// 参数与常量
// =====================================================================================

/** 缺省时间窗（天）：只看最近 60 天内发布的视频；days: 0 不限时间。 */
export const DEFAULT_BILI_SEARCH_DAYS = 60;
/** 返回给模型的候选行数上限。 */
export const BILI_SEARCH_LIMIT = 10;
/** 单次向 DeepSeek Search 请求的结果条数（多抓再筛）。 */
export const BILI_SEARCH_FETCH_COUNT = 20;
/** 窗口内有效结果低于此数才触发自动放宽重搜。 */
export const BILI_SEARCH_FALLBACK_MIN = 3;
/** 每轮最多成功搜索次数（支持换词重试一次；空结果/失败/中止不计数）。 */
export const BILI_SEARCH_MAX_PER_ROUND = 2;
/** 整次执行（首呼 + 放宽）的总超时预算；外层工具超时缺省 30s，这里留足余量。 */
export const BILI_SEARCH_TOTAL_TIMEOUT_MS = 24_000;
/** 首次检索的超时上限。 */
export const BILI_SEARCH_PRIMARY_TIMEOUT_MS = 14_000;
/** 剩余预算低于此数不再放宽重搜（避免半截请求撞总预算）。 */
const FALLBACK_MIN_REMAINING_MS = 4_000;
/** B 站发布时间按 UTC+8 理解；after: 日期与行内发布日期同域切分。 */
const TZ_OFFSET_MS = 8 * 3_600_000;
const DAY_MS = 86_400_000;

/** args 静态类型：与 schema.json 一一对应；运行时 Schema 只有 manifest 这一份。 */
interface BiliSearchArgs {
  query: string;
  days?: number;
}

/** 注入口（测试用）：search 可替换；缺省走共享客户端 + var/bili-filters.json 热加载 + console 审计。 */
export interface BiliSearchToolOptions {
  search?: typeof deepseekSearch;
  filters?: () => BiliFilters;
  audit?: (line: string) => void;
}

// =====================================================================================
// 查询词规整与拼接
// =====================================================================================

/** 模型手写的检索算子（site:/after:/before:，可带 +/- 前缀）：精准剥离，不吞后续中文词。 */
const SEARCH_OPERATOR_RE = /[+-]?(?:site|after|before):[A-Za-z0-9._:/-]+/g;

/** 剥算子 + 收敛空白；长度校验（UTF-16 .length 1..80）在 execute 层做。 */
export function normalizeBiliSearchQuery(rawQuery: string): string {
  return rawQuery.replace(SEARCH_OPERATOR_RE, " ").replace(/\s+/g, " ").trim();
}

/** ms → UTC+8 的 YYYY-MM-DD（after: 算子与行内发布日期共用）。 */
function utc8DateOf(ms: number): string {
  return new Date(ms + TZ_OFFSET_MS).toISOString().slice(0, 10);
}

/** 拼接最终检索词：site 限定 + 关键词 + （days > 0 时）after: 起始日。24 + 80 + 17 = 121 ≤ 128。 */
export function buildBiliSearchQuery(cleanedQuery: string, days: number, nowMs: number): string {
  const base = `site:bilibili.com/video ${cleanedQuery}`;
  if (days <= 0) return base;
  return `${base} after:${utc8DateOf(nowMs - days * DAY_MS)}`;
}

// =====================================================================================
// 标题/简介清洗
// =====================================================================================

/** B 站页面标题的站名后缀（实测形态）：_哔哩哔哩_bilibili[ - 时长] / _哔哩哔哩bilibili[_频道] / _游戏热门视频。 */
const TITLE_SUFFIX_RES: readonly RegExp[] = [
  /_哔哩哔哩_bilibili(?:\s*-\s*[\d:]+)?\s*$/i,
  /_哔哩哔哩bilibili(?:_[^_]+)?\s*$/i,
  /_游戏热门视频\s*$/,
];

/** 清洗（含内嵌 URL 抹除）后剥站名后缀；剥完为空兜底「无标题」。 */
export function cleanBiliVideoTitle(rawTitle: string): string {
  let title = cleanSearchText(rawTitle, 200);
  for (const re of TITLE_SUFFIX_RES) title = title.replace(re, "");
  title = title.trim();
  return title.length > 0 ? title : "无标题";
}

/** 简介优先 snippet；空时回退 summary 首个非空行（去 # 前缀），避开侧边栏推荐噪音。 */
function briefOf(item: DeepSeekSearchItem): string {
  const snippet = cleanSearchText(item.rawSnippet, 60);
  if (snippet.length > 0) return snippet;
  const firstLine = item.rawSummary.split(/\r?\n/).map((line) => line.trim()).find((line) => line.length > 0) ?? "";
  return cleanSearchText(firstLine.replace(/^#+\s*/, ""), 60);
}

// =====================================================================================
// 漏斗：严格 BV 过滤去重 → 时间窗兜底 → 去重表剔除 → 文本硬筛 → 行式渲染
// =====================================================================================

/** 漏斗各段计数（审计汇总与返回尾行用）。 */
export interface BiliSearchFunnelStats {
  raw: number;
  bili: number;
  inLibrary: number;
  hardVeto: number;
  returned: number;
}

export interface BiliSearchFunnelResult {
  rows: string[];
  stats: BiliSearchFunnelStats;
  /** 与 rows 一一对应的规范 BV（调用方用它记「已展示」seen）。 */
  bvids: string[];
}

/** 硬筛正则的一次编译结果（每次漏斗编译一次，不逐条重复编译）。 */
interface CompiledHard {
  titleBait: RegExp[];
  uc: RegExp[];
  listicle: RegExp[];
  promoDesc: RegExp[];
}

function matchRule(patterns: readonly RegExp[], text: string, rule: string): { rule: string; value: string } | undefined {
  const hit = patterns.find((re) => re.test(text));
  return hit === undefined ? undefined : { rule, value: hit.source };
}

/**
 * 纯函数漏斗（注入假结果即可内联验证）：
 * 严格 /video/BV 过滤 + 同 BV 多锚点去重（保留排序最靠前的一条）→ minPublishedAtMs
 * 时间窗兜底（无日期条目保留）→ inLibrary 剔除 → 4 条文本硬筛 → 截 limit → 行式渲染。
 * 规则命中逐条审计元数据（BV + 规则名 + 正则来源），不打标题/简介内容。
 */
export function runBiliSearchFunnel(
  items: readonly DeepSeekSearchItem[],
  limit: number,
  deps: {
    filters: BiliFilters;
    /** bvid → state：去重表里仍生效的条目（shared 永久 + 未过期 seen）。 */
    inLibrary: ReadonlyMap<string, string>;
    audit: (line: string) => void;
    /** days > 0 的首轮兜底：早于此时刻的已解析日期条目剔除；放宽轮不传。 */
    minPublishedAtMs?: number;
  },
): BiliSearchFunnelResult {
  const audit = deps.audit;

  // 1) 严格 BV 提取 + 去重 + 时间窗兜底（超窗条目不占 BV 名额）
  const seen = new Set<string>();
  const unique: { bvid: string; item: DeepSeekSearchItem }[] = [];
  for (const item of items) {
    const bvid = biliVideoBvidOfUrl(item.url);
    if (bvid === undefined || seen.has(bvid)) continue;
    if (deps.minPublishedAtMs !== undefined && item.publishedAtMs !== undefined && item.publishedAtMs < deps.minPublishedAtMs) continue;
    seen.add(bvid);
    unique.push({ bvid, item });
  }

  // 2) 去重表剔除（元数据审计：BV + 状态）
  const fresh = unique.filter(({ bvid }) => {
    const state = deps.inLibrary.get(bvid);
    if (state === undefined) return true;
    audit(`BV=${bvid} rule=in_library value=${state}`);
    return false;
  });

  // 3) 文本硬筛一票否决（无播放/UP 元数据，只保留 4 条文本规则；正则来源是配置元数据）
  const hard = deps.filters.hard;
  const re: CompiledHard = {
    titleBait: compileFilterPatterns(hard.titleBaitPatterns, audit),
    uc: compileFilterPatterns(hard.ucPatterns, audit),
    listicle: compileFilterPatterns(hard.listiclePatterns, audit),
    promoDesc: compileFilterPatterns(hard.promoDescPatterns, audit),
  };
  const survivors: { bvid: string; item: DeepSeekSearchItem; title: string; brief: string }[] = [];
  let hardVeto = 0;
  for (const entry of fresh) {
    const title = cleanBiliVideoTitle(entry.item.rawTitle);
    const brief = briefOf(entry.item);
    const veto =
      matchRule(re.titleBait, title, "hard.titleBaitPatterns") ??
      matchRule(re.uc, title, "hard.ucPatterns") ??
      matchRule(re.uc, brief, "hard.ucPatterns") ??
      matchRule(re.listicle, title, "hard.listiclePatterns") ??
      matchRule(re.promoDesc, brief, "hard.promoDescPatterns");
    if (veto !== undefined) {
      hardVeto += 1;
      audit(`BV=${entry.bvid} rule=${veto.rule} value=${veto.value}`);
      continue;
    }
    survivors.push({ ...entry, title, brief });
  }

  // 4) 行式渲染：标题|发布|简介|BV；字段内竖线换全角，内嵌 URL 已在清洗时抹除
  const picked = survivors.slice(0, limit);
  const rows = picked.map(({ bvid, item, title, brief }) => {
    const t = cleanSearchText(title, 60).replaceAll("|", "｜") || "无标题";
    const b = cleanSearchText(brief, 60).replaceAll("|", "｜");
    const date = item.publishedAtMs !== undefined ? utc8DateOf(item.publishedAtMs) : "日期未知";
    return [t, date, b, bvid].join("|");
  });
  const stats: BiliSearchFunnelStats = {
    raw: items.length,
    bili: unique.length,
    inLibrary: unique.length - fresh.length,
    hardVeto,
    returned: rows.length,
  };
  audit(`funnel raw=${stats.raw} bili=${stats.bili} in_library=${stats.inLibrary} hard_veto=${stats.hardVeto} returned=${stats.returned}`);
  return { rows, stats, bvids: picked.map((entry) => entry.bvid) };
}

// =====================================================================================
// 工具注册
// =====================================================================================

/** conversationId → 当前轮搜索计数（成功留账；空结果/失败/中止递减释放）。 */
const BILI_SEARCHED = new Map<ConversationId, { round: unknown; count: number }>();

/**
 * bili_search 工具：模型侧只见 TOOL.md；执行侧是上面的机械漏斗。
 * loader 对非 eager 工具统一加 deferred，factory 本体不写；缺 searchKey 仍注册
 * （与 search 一致），仅 execute 时抛 bili_search_nokey。
 */
export function createBiliSearchTool(manifest: ToolManifest, deps: ToolPackageDeps, options: BiliSearchToolOptions = {}): ToolRegistration {
  const messages = deps.prompts.messages;
  const search = options.search ?? deepseekSearch;
  const getFilters = options.filters ?? createBiliFiltersLoader();
  const audit = options.audit ?? ((line: string): void => {
    console.log(`[bili_search 审计] ${line}`);
  });
  const clock = deps.now ?? Date.now;

  return defineTool({
    name: manifest.name,
    description: toolFullDescription(manifest),
    callers: ["model"],
    parameters: manifestParameters<BiliSearchArgs>(manifest),
    execute: async (args, api, context) => {
      const query = normalizeBiliSearchQuery(typeof args.query === "string" ? args.query : "");
      if (query.length < 1 || query.length > 80) {
        throw new Error(messages["bili_search_query"] ?? "bili_search_query");
      }
      const days = args.days ?? DEFAULT_BILI_SEARCH_DAYS;
      if (!Number.isInteger(days) || days < 0 || days > 365) {
        throw new Error(messages["bili_search_bad_days"] ?? "bili_search_bad_days");
      }
      if (!deps.searchKey) {
        throw new Error(messages["bili_search_nokey"] ?? "bili_search_nokey");
      }

      // 每轮限 2 次：轮标识与 search / 出口工具同源。缺轮标识拒绝，避免无法绑定额度。
      const live = await api.snapshot(LiveDoc, api.conversationId, context);
      const round = live?.run?.inputs?.[0];
      if (round === undefined || round === null) {
        throw new Error(messages["bili_search_round_missing"] ?? "bili_search_round_missing");
      }
      // 检查与占位之间没有 await：同一会话/轮的并发调用不会一起越过上限。
      let lease = BILI_SEARCHED.get(api.conversationId);
      if (lease === undefined || !Object.is(lease.round, round)) {
        lease = { round, count: 0 };
        BILI_SEARCHED.set(api.conversationId, lease);
      }
      if (lease.count >= BILI_SEARCH_MAX_PER_ROUND) {
        throw new Error(messages["bili_search_used"] ?? "bili_search_used");
      }
      lease.count += 1;
      const held = lease;
      const release = (): void => {
        if (BILI_SEARCHED.get(api.conversationId) === held) {
          held.count -= 1;
          if (held.count <= 0) BILI_SEARCHED.delete(api.conversationId);
        }
      };

      // 本群去重表（chatKey 绑定）：shared 永久挡、seen 只挡 7 天；租约占位后即进 try，
      // 任何快照/配置/检索异常都确保 release 归还本轮额度。
      const nowMs = clock();
      const startedAt = nowMs;
      const poolKey = videoPoolKeyOf(deps.chatKeyOf?.(String(api.conversationId)), api.conversationId);
      const signal = context?.abortSignal;
      // 首轮时间窗兜底：多放 1 天容差，避免时区/边界误杀
      const minPublishedAtMs = days > 0 ? nowMs - (days + 1) * DAY_MS : undefined;

      try {
        const pool = (await api.snapshot(VideoPoolDoc, poolKey, context)) as VideoPoolState | undefined;
        const activeSeen = activeSeenOf(pool, nowMs);
        const inLibrary = new Map<string, string>();
        for (const poolItem of pool?.items ?? []) {
          if (poolItem.state === "seen" && !activeSeen.has(poolItem.bvid)) continue;
          inLibrary.set(poolItem.bvid, poolItem.state);
        }
        const filters = getFilters();
        const primaryItems = await search({
          apiKey: deps.searchKey,
          query: buildBiliSearchQuery(query, days, nowMs),
          count: BILI_SEARCH_FETCH_COUNT,
          timeoutMs: BILI_SEARCH_PRIMARY_TIMEOUT_MS,
          signal,
        });
        let result = runBiliSearchFunnel(primaryItems, BILI_SEARCH_LIMIT, { filters, inLibrary, audit, minPublishedAtMs });
        let fallbackUsed = false;
        if (days > 0 && result.rows.length < BILI_SEARCH_FALLBACK_MIN) {
          const remaining = BILI_SEARCH_TOTAL_TIMEOUT_MS - (clock() - startedAt);
          if (remaining >= FALLBACK_MIN_REMAINING_MS) {
            try {
              const more = await search({
                apiKey: deps.searchKey,
                query: buildBiliSearchQuery(query, 0, nowMs),
                count: BILI_SEARCH_FETCH_COUNT,
                timeoutMs: remaining,
                signal,
              });
              // 合并去重：时间窗内首轮排最前 → 放宽重搜结果次之 → 首轮超窗旧条目垫底（避免旧条目挤掉窗口内与放宽命中）
              const inWindowPrimary: DeepSeekSearchItem[] = [];
              const outOfWindowPrimary: DeepSeekSearchItem[] = [];
              for (const entry of primaryItems) {
                if (minPublishedAtMs !== undefined && entry.publishedAtMs !== undefined && entry.publishedAtMs < minPublishedAtMs) {
                  outOfWindowPrimary.push(entry);
                } else {
                  inWindowPrimary.push(entry);
                }
              }
              result = runBiliSearchFunnel(
                [...inWindowPrimary, ...more, ...outOfWindowPrimary],
                BILI_SEARCH_LIMIT,
                { filters, inLibrary, audit },
              );
              fallbackUsed = true;
            } catch (error) {
              // 放宽失败：网络/取消原样上抛；SearchResponseError 时保留首次 1–2 条，如实不标放宽
              if (!(error instanceof SearchResponseError)) throw error;
              if (result.rows.length === 0) throw error;
            }
          }
        }
        if (result.rows.length === 0) {
          release();
          return { output: [{ type: "text", text: messages["bili_search_empty"] ?? "bili_search_empty" }] };
        }
        // 写池前复查取消信号：中止路径不记 seen、不占额度
        if (signal?.aborted) throw signal.reason ?? new Error("aborted");
        try {
          await api.commit(async (tx) => {
            const doc = await tx.doc(VideoPoolDoc, poolKey);
            applyVideoPoolSeen(doc, result.bvids, nowMs);
          }, context);
        } catch (error) {
          console.warn("[鱼缸] bili_search 展示记账失败", error instanceof Error ? error.message : error);
        }
        const text = [
          messages["bili_search_header"] ?? "",
          ...result.rows,
          renderTemplate(messages["bili_search_stats"] ?? "", {
            raw: String(result.stats.raw),
            bili: String(result.stats.bili),
            in_library: String(result.stats.inLibrary),
            hard_veto: String(result.stats.hardVeto),
            returned: String(result.stats.returned),
            fallback_note: fallbackUsed ? renderTemplate(messages["bili_search_fallback_note"] ?? "", { days: String(days) }) : "",
          }),
        ]
          .filter((line) => line.length > 0)
          .join("\n");
        // 成功：计数留在 BILI_SEARCHED 里就是本轮的账，同轮第 3 次一律 bili_search_used。
        return { output: [{ type: "text", text }] };
      } catch (error) {
        release();
        // AbortError 与网络异常原样透出；仅 SearchResponseError 翻为 bili_search_failed。
        if (!(error instanceof SearchResponseError)) throw error;
        throw new Error(renderTemplate(messages["bili_search_failed"] ?? "bili_search_failed", {
          query,
          reason: error.message,
        }));
      }
    },
  });
}