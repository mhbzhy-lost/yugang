/**
 * bili_hot —— 逛 B 站的候选榜单（外部计划 Task E2）。
 *
 * 机械漏斗：榜单取数 → 已入库剔除 → 硬筛一票否决 → 软筛评分排序 → 紧凑行式返回。
 * 要点：
 *   - 多抓 4 倍（上限 50）再筛：筛选再严也不容易把榜单筛空；
 *   - 已入库 BV 过滤：fish.external_ammo 里 available/shared 的不再重复推荐
 *     （本工具只读；写入方与正式 doc 定义在 E4，token 形状必须与决策 4 一致）；
 *   - 规则命中逐条审计：只打元数据（BV + 规则名 + 数值/命中的正则来源），
 *     不打标题、简介、UP 名等内容；
 *   - 标题/UP/分区/简介全是不可信文本，出工具前统一过 sanitizeExternalText；
 *   - 筛选配置每轮现取（var/bili-filters.json mtime 热加载，主人改文件即生效）。
 *
 * UP 等级/认证的软筛信号不在这条查（每候选一次 card 请求会打爆每日预算），
 * 终选时由 bili_video 的 UP 评级承担；这里的软筛只用榜单自带的
 * 播放/赞/币/收藏/时长/简介。取数：popular 按 ps=20 分页翻 ceil(min(50, 4×limit)/20) 页，
 * rank 一次拉全榜截前 50；全部请求经 bili-client 共享单例（频控/预算/熔断全仓一份）。
 *
 * 漏斗本体 runBiliHotFunnel 是纯函数（注入假榜单即可内联验证，不必起会话）；
 * 说明文字与参数 Schema 唯一来自 TOOL.md manifest。
 */
import { defineDoc, defineTool, type ToolRegistration } from "@earendil-works/pi-durable";
import {
  compileFilterPatterns,
  createBiliFiltersLoader,
  type BiliClient,
  type BiliFilters,
  type BiliVideoCard,
  getBiliClient,
  isValidBvid,
} from "../../external/bili-client.ts";
import { sanitizeExternalText } from "../../external/sanitize.ts";
import { renderTemplate } from "../../prompts.ts";
import { manifestParameters, toolFullDescription } from "../manifest.ts";
import type { ToolManifest, ToolPackageDeps } from "../types.ts";

// =====================================================================================
// 排行榜分区枚举（写死，TOOL.md 的 rid enum 与这里一一对应）
// =====================================================================================

export interface BiliRankZone {
  rid: number;
  name: string;
}

/**
 * ranking/v2 实测接受的主分区号（2026-11-02 逐个 code=0 验证过）。
 * 数码/搞笑是子分区（95/138），该端点不收（code=-400），分别归科技/生活。
 */
export const BILI_RANK_ZONES: readonly BiliRankZone[] = [
  { rid: 0, name: "全站" },
  { rid: 1, name: "动画" },
  { rid: 4, name: "游戏" },
  { rid: 36, name: "知识" },
  { rid: 188, name: "科技" },
  { rid: 160, name: "生活" },
  { rid: 181, name: "影视" },
  { rid: 3, name: "音乐" },
  { rid: 5, name: "娱乐" },
  { rid: 23, name: "电影" },
];

// =====================================================================================
// fish.external_ammo 的读取投影（已入库 BV 过滤用）
// =====================================================================================

/** 弹药库条目（计划决策 4 的形状；本工具只读，写入方是 E4 的 ammo_submit）。 */
export interface ExternalAmmoItem {
  id: string;
  kind: string;
  bvid: string;
  title: string;
  summary: string;
  topic: string;
  pickedAt: number;
  ttlAt: number;
  state: "available" | "claimed" | "shared" | "expired";
}

export interface ExternalAmmoState {
  items: ExternalAmmoItem[];
}

/**
 * fish.external_ammo 的读取 token：E2 只需要读，先与工具包同住；kind/version/scope
 * 与计划决策 4 一致。E4 落正式 doc 定义时两边必须同形（或改成从一处导入）——
 * pi-durable 对语义不符的存档会当场抛错，不会静默错读。
 */
export const ExternalAmmoReadDoc = defineDoc<ExternalAmmoState>({
  kind: "fish.external_ammo",
  version: 1,
  scope: "session",
  initial: () => ({ items: [] }),
  checkpointWhen: () => true,
});

// =====================================================================================
// 参数与常量
// =====================================================================================

/** args 静态类型：与 TOOL.md 的参数 Schema 一一对应；运行时 Schema 只有 manifest 这一份。 */
interface BiliHotArgs {
  source: "popular" | "rank";
  rid?: number;
  limit?: number;
}

/** 文本字段各自的清洗上限（字）：行式返回要紧凑。 */
const LIMITS = { title: 60, name: 30, tname: 20, desc: 60 };

/** 多抓倍数与上限：防筛空（合同：4 倍、上限 50）。 */
const FETCH_MULTIPLIER = 4;
const FETCH_CAP = 50;
const POPULAR_PAGE_SIZE = 20;

/** 注入口（内联验证用）；缺省走全仓单例 + var/bili-filters.json 热加载 + console 审计。 */
export interface BiliHotToolOptions {
  client?: BiliClient;
  filters?: () => BiliFilters;
  audit?: (line: string) => void;
}

// =====================================================================================
// 漏斗：去重 → 已入库剔除 → 硬筛 → 软筛排序 → 截 limit → 行式渲染
// =====================================================================================

/** 漏斗各段计数（审计汇总与返回尾行用）。 */
export interface BiliHotFunnelStats {
  candidates: number;
  inLibrary: number;
  hardVeto: number;
  softOut: number;
  returned: number;
}

/** 一次硬筛否决：规则名 + 元数据值（数值指标或命中的正则来源，不是文本内容）。 */
interface HardVeto {
  rule: string;
  value: string;
}

/** 硬筛正则的一次编译结果（每轮筛选编译一次，不逐条重复编译）。 */
interface CompiledHard {
  titleBait: RegExp[];
  uc: RegExp[];
  listicle: RegExp[];
  promoDesc: RegExp[];
  upBlacklist: RegExp[];
  aiName: RegExp[];
}

function compileHard(hard: BiliFilters["hard"], log?: (message: string) => void): CompiledHard {
  return {
    titleBait: compileFilterPatterns(hard.titleBaitPatterns, log),
    uc: compileFilterPatterns(hard.ucPatterns, log),
    listicle: compileFilterPatterns(hard.listiclePatterns, log),
    promoDesc: compileFilterPatterns(hard.promoDescPatterns, log),
    upBlacklist: compileFilterPatterns(hard.upBlacklistPatterns, log),
    aiName: compileFilterPatterns(hard.aiNamePatterns, log),
  };
}

/** 硬筛一票否决：按固定顺序逐规则验，命中即返回（审计只落规则名与元数据值）。 */
function hardVetoOf(card: BiliVideoCard, hard: BiliFilters["hard"], re: CompiledHard, nowMs: number): HardVeto | undefined {
  if (card.stat.view < hard.minViews) return { rule: "hard.minViews", value: String(card.stat.view) };
  const ageHours = Math.max(0, (nowMs / 1000 - card.pubdate) / 3600);
  if (ageHours < hard.minAgeHours) return { rule: "hard.minAgeHours", value: ageHours.toFixed(1) };
  const bait = re.titleBait.find((p) => p.test(card.title));
  if (bait) return { rule: "hard.titleBaitPatterns", value: bait.source };
  const uc = re.uc.find((p) => p.test(card.title) || p.test(card.desc));
  if (uc) return { rule: "hard.ucPatterns", value: uc.source };
  const listicle = re.listicle.find((p) => p.test(card.title));
  if (listicle) return { rule: "hard.listiclePatterns", value: listicle.source };
  const promo = re.promoDesc.find((p) => p.test(card.desc));
  if (promo) return { rule: "hard.promoDescPatterns", value: promo.source };
  const black = re.upBlacklist.find((p) => p.test(card.owner.name));
  if (black) return { rule: "hard.upBlacklistPatterns", value: black.source };
  const ai = re.aiName.find((p) => p.test(card.owner.name));
  if (ai) return { rule: "hard.aiNamePatterns", value: ai.source };
  return undefined;
}

/**
 * 软筛评分：赞/币/收藏相对播放的比例、时长带、简介空否。UP 等级/认证不在这条查
 * （每候选一次 card 请求打爆预算），终选由 bili_video 的 UP 评级承担。
 */
export function softScoreOf(card: BiliVideoCard, soft: BiliFilters["soft"]): number {
  const views = Math.max(1, card.stat.view);
  let score = 0;
  const likeView = card.stat.like / views;
  const tier = [...soft.likeViewTiers].sort((a, b) => b.min - a.min).find((t) => likeView >= t.min);
  if (tier) score += tier.score;
  if (card.stat.coin / views >= soft.coinViewRatio.min) score += soft.coinViewRatio.score;
  if (card.stat.favorite / views >= soft.favViewRatio.min) score += soft.favViewRatio.score;
  const dur = card.durationSeconds;
  if (dur >= soft.durationSeconds.sweetMin && dur <= soft.durationSeconds.sweetMax) {
    score += soft.durationSeconds.sweetBonus;
  } else if (dur < soft.durationSeconds.min || dur > soft.durationSeconds.max) {
    score -= soft.durationSeconds.outOfRangePenalty;
  }
  if (card.desc.trim() === "") score -= soft.emptyDescPenalty;
  return score;
}

export interface BiliHotFunnelResult {
  rows: string[];
  stats: BiliHotFunnelStats;
}

/**
 * 纯函数漏斗：去重 → 已入库剔除 → 硬筛一票否决 → 软筛评分排序 → 截 limit → 行式渲染。
 * 每次规则命中经 deps.audit 打一行元数据；zoneName 是 rank 源的分区名兜底
 * （榜单条目缺 tname 时用请求的分区名顶上）。
 */
export function runBiliHotFunnel(
  raw: readonly BiliVideoCard[],
  limit: number,
  deps: {
    filters: BiliFilters;
    /** bvid → state：available/shared 才算已入库（claimed 在途、expired 过期不算）。 */
    inLibrary: ReadonlyMap<string, string>;
    zoneName?: string;
    audit: (line: string) => void;
    nowMs: number;
  },
): BiliHotFunnelResult {
  const audit = deps.audit;

  // 1) 去重 + BV 形校验（跨页会重复，榜单偶尔混入怪条目）
  const seen = new Set<string>();
  const candidates = raw.filter((card) => {
    if (!isValidBvid(card.bvid) || seen.has(card.bvid)) return false;
    seen.add(card.bvid);
    return true;
  });

  // 2) 已入库剔除（元数据审计：BV + 状态）
  const fresh = candidates.filter((card) => {
    const state = deps.inLibrary.get(card.bvid);
    if (state === undefined) return true;
    audit(`BV=${card.bvid} rule=in_library value=${state}`);
    return false;
  });

  // 3) 硬筛一票否决（正则来源是配置元数据，不是内容）
  const re = compileHard(deps.filters.hard, audit);
  const survivors: BiliVideoCard[] = [];
  let hardVeto = 0;
  for (const card of fresh) {
    const veto = hardVetoOf(card, deps.filters.hard, re, deps.nowMs);
    if (veto === undefined) {
      survivors.push(card);
      continue;
    }
    hardVeto += 1;
    audit(`BV=${card.bvid} rule=${veto.rule} value=${veto.value}`);
  }

  // 4) 软筛：评分降序（同分看赞、再看 BV 定序），低于及格线淘汰并逐条审计分数
  const scored = survivors
    .map((card) => ({ card, score: softScoreOf(card, deps.filters.soft) }))
    .sort((a, b) => b.score - a.score || b.card.stat.like - a.card.stat.like || (a.card.bvid < b.card.bvid ? -1 : 1));
  const passing = scored.filter(({ card, score }) => {
    if (score >= deps.filters.soft.passScore) return true;
    audit(`BV=${card.bvid} rule=soft.passScore value=${score}`);
    return false;
  });
  const picked = passing.slice(0, limit);

  // 5) 行式渲染：全部文本字段过 sanitizeExternalText
  const rows = picked.map(({ card }) => renderRow(card, deps.nowMs, deps.zoneName));
  const stats: BiliHotFunnelStats = {
    candidates: candidates.length,
    inLibrary: candidates.length - fresh.length,
    hardVeto,
    softOut: survivors.length - passing.length,
    returned: rows.length,
  };
  audit(`funnel candidates=${stats.candidates} in_library=${stats.inLibrary} hard_veto=${stats.hardVeto} soft_out=${stats.softOut} returned=${stats.returned}`);
  return { rows, stats };
}

// =====================================================================================
// 渲染与取数
// =====================================================================================

function fmtCount(n: number): string {
  const v = Math.max(0, Math.floor(n));
  if (v >= 100_000_000) return `${(v / 100_000_000).toFixed(1)}亿`;
  if (v >= 10_000) return `${(v / 10_000).toFixed(1)}万`;
  return String(v);
}

function fmtDuration(seconds: number): string {
  const total = Math.max(0, Math.floor(seconds));
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = total % 60;
  const pad = (n: number): string => String(n).padStart(2, "0");
  return h > 0 ? `${h}:${pad(m)}:${pad(s)}` : `${m}:${pad(s)}`;
}

function fmtAge(seconds: number): string {
  const s = Math.max(0, seconds);
  if (s < 3600) return `${Math.max(1, Math.floor(s / 60))}分钟前`;
  if (s < 86_400) return `${Math.floor(s / 3600)}小时前`;
  if (s < 30 * 86_400) return `${Math.floor(s / 86_400)}天前`;
  if (s < 365 * 86_400) return `${Math.floor(s / (30 * 86_400))}个月前`;
  return `${Math.floor(s / (365 * 86_400))}年前`;
}

/** 一条候选的紧凑行：标题|UP|分区|时长|播放/赞/币|发布相对时间|简介≤60|BV。 */
function renderRow(card: BiliVideoCard, nowMs: number, zoneFallback?: string): string {
  const title = sanitizeExternalText(card.title, { maxLen: LIMITS.title });
  const up = sanitizeExternalText(card.owner.name, { maxLen: LIMITS.name });
  const zone = sanitizeExternalText(card.tname ?? zoneFallback ?? "", { maxLen: LIMITS.tname }) || "未知";
  const stats = `${fmtCount(card.stat.view)}/${fmtCount(card.stat.like)}/${fmtCount(card.stat.coin)}`;
  const age = fmtAge(nowMs / 1000 - card.pubdate);
  const desc = sanitizeExternalText(card.desc, { maxLen: LIMITS.desc });
  return [title, up, zone, fmtDuration(card.durationSeconds), stats, age, desc, card.bvid].join("|");
}

/** 榜单取数：popular 翻 ceil(min(50, 4×limit)/20) 页（4 倍防筛空）；rank 一次拉全榜截前 50。 */
async function fetchCandidates(
  client: BiliClient,
  source: "popular" | "rank",
  rid: number,
  limit: number,
): Promise<BiliVideoCard[]> {
  if (source === "rank") {
    return (await client.ranking(rid)).slice(0, FETCH_CAP);
  }
  const pages = Math.min(3, Math.max(1, Math.ceil(Math.min(FETCH_CAP, limit * FETCH_MULTIPLIER) / POPULAR_PAGE_SIZE)));
  const out: BiliVideoCard[] = [];
  for (let page = 1; page <= pages; page += 1) {
    const cards = await client.popular(page);
    if (cards.length === 0) break;
    out.push(...cards);
    if (out.length >= FETCH_CAP) break;
  }
  return out.slice(0, FETCH_CAP);
}

// =====================================================================================
// 工具注册
// =====================================================================================

/**
 * bili_hot 工具：模型侧只见 TOOL.md；执行侧是上面的机械漏斗。
 * loader 对非 eager 工具统一加 deferred，factory 本体不写。
 */
export function createBiliHotTool(manifest: ToolManifest, deps: ToolPackageDeps, options: BiliHotToolOptions = {}): ToolRegistration {
  const messages = deps.prompts.messages;
  const getFilters = options.filters ?? createBiliFiltersLoader();
  const audit = options.audit ?? ((line: string): void => {
    console.log(`[bili_hot 审计] ${line}`);
  });

  return defineTool({
    name: manifest.name,
    description: toolFullDescription(manifest),
    callers: ["model"],
    parameters: manifestParameters<BiliHotArgs>(manifest),
    execute: async (args, api, context) => {
      const source = args.source === "rank" ? "rank" : "popular";
      const limit = Math.min(20, Math.max(1, Math.floor(args.limit ?? 10)));
      const zone = source === "rank" ? BILI_RANK_ZONES.find((z) => z.rid === (args.rid ?? 0)) : undefined;
      if (source === "rank" && zone === undefined) {
        throw new Error(messages["bili_hot_bad_rid"] ?? "分区号不认识");
      }

      // 已入库 BV（全部库内状态，终验 #3 修复）：available/claimed/shared/expired 都算已入库——
      // applyAmmoSubmit 对任意状态的同 BV 都判重，榜单候选不该再浪费请求与轮次去撞库内条目
      const ammo = await api.snapshot(ExternalAmmoReadDoc, context);
      const inLibrary = new Map<string, string>();
      for (const item of ammo?.items ?? []) {
        inLibrary.set(item.bvid, item.state);
      }

      let cards: BiliVideoCard[];
      try {
        cards = await fetchCandidates(options.client ?? getBiliClient(), source, zone?.rid ?? 0, limit);
      } catch (error) {
        const reason = error instanceof Error ? error.message : String(error);
        throw new Error(renderTemplate(messages["bili_hot_failed"] ?? "榜单没拿到", { reason }));
      }

      const nowMs = deps.now?.() ?? Date.now();
      const { rows, stats } = runBiliHotFunnel(cards, limit, {
        filters: getFilters(),
        inLibrary,
        zoneName: zone?.name,
        audit,
        nowMs,
      });
      if (rows.length === 0) {
        return { output: [{ type: "text", text: messages["bili_hot_empty"] ?? "bili_hot_empty" }] };
      }
      const text = [
        messages["bili_hot_header"] ?? "",
        ...rows,
        renderTemplate(messages["bili_hot_stats"] ?? "", {
          candidates: String(stats.candidates),
          in_library: String(stats.inLibrary),
          hard_veto: String(stats.hardVeto),
          soft_out: String(stats.softOut),
          returned: String(stats.returned),
        }),
      ]
        .filter((line) => line.length > 0)
        .join("\n");
      return { output: [{ type: "text", text }] };
    },
  });
}
