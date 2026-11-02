/**
 * B 站客户端：频控内核 + 白名单端点 + 缺省筛选配置（外部计划决策 5/6/7，Task E1）。
 *
 * 频控六条路径（内联验证覆盖）：
 *   1. 白名单端点——URL 只由 endpointUrl 用 7 个枚举端点拼出，没有任何自由 URL 入口；
 *   2. 全局串行锁——所有请求排一条队，任意时刻只有一个在途请求；
 *   3. 同端点间隔——同一端点相邻两次请求起发时刻 ≥ sameEndpointIntervalMs（缺省 2000）；
 *   4. 每日预算——总请求数按 localDay 记账，持久 var/bili-budget.json，跨重启接续、跨天清零；
 *   5. 风控熔断——响应 code 为 -412/-352 时当日熔断该端点，后续调用直接抛可读错误；
 *   6. buvid3 复用——首次请求前经 finger/spi 获取，落 var/bili-state.json 长期复用，不重复获取。
 *
 * UA 与 Referer 钉死；fetch 用全局 fetch（可注入替换供测试）；返回值全部映射为本文件
 * 的具名接口，不透传原始 JSON、不使用 any。
 *
 * 文件尾是 var/bili-filters.json 的类型定义、缺省值（JSON 不支持注释，字段说明以这里的
 * TS 注释为准）与 mtime 热加载器，供工具层（bili_hot 等）共用。
 */
import { readFileSync, writeFileSync, existsSync, statSync } from "node:fs";
import { join } from "node:path";
import { localDay } from "../usage.ts";

export type BiliEndpoint = "popular" | "ranking" | "view" | "dm" | "reply" | "card" | "spi";

const API_ROOT = "https://api.bilibili.com";

/** 钉死的浏览器 UA 与 Referer：B 站游客接口对裸 UA 风控极重，不许调用方改。 */
const PINNED_UA =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36";
const PINNED_REFERER = "https://www.bilibili.com/";

export interface BiliEndpointParams {
  page?: number;
  rid?: number;
  bvid?: string;
  cid?: string;
  oid?: string | number;
  type?: number;
  mid?: string | number;
}

/**
 * 白名单端点的唯一 URL 来源：新增端点必须先加进这个 switch 和 BiliEndpoint，
 * 任何绕过它拼 URL 的调用都不存在。
 */
export function endpointUrl(endpoint: BiliEndpoint, params: BiliEndpointParams = {}): string {
  switch (endpoint) {
    case "popular":
      return `${API_ROOT}/x/web-interface/popular?ps=20&pn=${Math.max(1, Math.floor(params.page ?? 1))}`;
    case "ranking":
      return `${API_ROOT}/x/web-interface/ranking/v2?rid=${Math.max(0, Math.floor(params.rid ?? 0))}&type=all`;
    case "view":
      return `${API_ROOT}/x/web-interface/view?bvid=${encodeURIComponent(params.bvid ?? "")}`;
    case "dm":
      return `${API_ROOT}/x/v1/dm/list.so?oid=${encodeURIComponent(String(params.cid ?? ""))}`;
    case "reply":
      return `${API_ROOT}/x/v2/reply/main?type=${Math.max(0, Math.floor(params.type ?? 1))}&oid=${encodeURIComponent(String(params.oid ?? ""))}&mode=3`;
    case "card":
      return `${API_ROOT}/x/web-interface/card?mid=${encodeURIComponent(String(params.mid ?? ""))}&photo=false`;
    case "spi":
      return `${API_ROOT}/x/frontend/finger/spi`;
  }
}

/** BV 号的唯一校验（候选入库、view 查询都认这个）。 */
export function isValidBvid(bvid: string): boolean {
  return /^BV[0-9A-Za-z]{10}$/.test(bvid);
}

// —— 返回类型：全部映射成具名接口，原始 JSON 不出客户端 ——

export interface BiliOwner {
  mid: number;
  name: string;
}

export interface BiliStat {
  view: number;
  danmaku: number;
  reply: number;
  favorite: number;
  coin: number;
  share: number;
  like: number;
}

export interface BiliVideoCard {
  bvid: string;
  aid: number;
  title: string;
  desc: string;
  /** 视频时长（秒）。 */
  durationSeconds: number;
  /** 发布时间（Unix 秒）。 */
  pubdate: number;
  owner: BiliOwner;
  stat: BiliStat;
  /** 稿件 cid（弹幕拉取要用；个别榜单条目缺它，调用方自行判空）。 */
  cid?: number;
  pic?: string;
}

export interface BiliReply {
  rpid: number;
  like: number;
  /** 评论时间（Unix 秒）。 */
  ctime: number;
  message: string;
  mid: number;
  uname: string;
  /** 评论者等级（软筛 UP 评级参考）。 */
  level: number;
  /** 认证类型：-1 无、0 个人、1 机构。 */
  officialType: number;
}

export interface BiliUpCard {
  mid: number;
  name: string;
  fans: number;
  /** UP 主等级（0–6）。 */
  level: number;
  officialType: number;
  officialDesc?: string;
}

export interface BiliClientSnapshot {
  /** 预算记账日（localDay）。 */
  day: string;
  /** 今日已用请求数。 */
  used: number;
  /** 每日预算上限。 */
  budget: number;
  /** 同端点最小间隔（ms）。 */
  intervalMs: number;
  /** 当日已熔断的端点。 */
  tripped: BiliEndpoint[];
  /** 是否已持有 buvid3。 */
  hasBuvid3: boolean;
}

export interface BiliClientOptions {
  /** 持久化目录（预算与 buvid3 状态文件放这里）；缺省仓库 var/。 */
  varDir?: string;
  /** 每日总预算（全部端点合计）；缺省 60。0 = 当日拒绝一切请求。 */
  dailyBudget?: number;
  /** 同端点相邻请求最小间隔（ms）；缺省 2000，测试可注入小值加速。 */
  sameEndpointIntervalMs?: number;
  /** 单请求超时（ms）；缺省 20000。 */
  timeoutMs?: number;
  /** 时钟（可注入；预算按 localDay(now()) 记账）。 */
  now?: () => Date;
  /** fetch 注入（缺省全局 fetch）。 */
  fetchImpl?: typeof fetch;
  log?: (message: string) => void;
}

export interface BiliClient {
  /** 综合热门（一页 20 条）。 */
  popular(page?: number): Promise<BiliVideoCard[]>;
  /** 排行榜 v2（rid=0 为全站）。 */
  ranking(rid?: number): Promise<BiliVideoCard[]>;
  /** 单视频详情（含 cid）。 */
  view(bvid: string): Promise<BiliVideoCard>;
  /** 弹幕原始 XML（dm/list.so 是 XML 不是 JSON，解析归调用方）。 */
  danmakuXml(cid: string): Promise<string>;
  /** 热评（reply/main mode=3，type 缺省 1=视频）。 */
  hotReplies(oid: string | number, type?: number): Promise<BiliReply[]>;
  /** UP 主卡片（粉丝/等级/认证，软筛评级用）。 */
  upCard(mid: string | number): Promise<BiliUpCard>;
  /** 观测口：预算/熔断/buvid 现状（审计与验证用）。 */
  snapshot(): BiliClientSnapshot;
}

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
  return typeof value === "string" ? value : "";
}

function strArray(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((x): x is string => typeof x === "string") : [];
}

function mapCard(raw: unknown): BiliVideoCard {
  const r = rec(raw);
  const owner = rec(r["owner"]);
  const stat = rec(r["stat"]);
  const pic = r["pic"];
  return {
    bvid: strOf(r["bvid"]),
    aid: numOf(r["aid"]),
    title: strOf(r["title"]),
    desc: strOf(r["desc"]),
    durationSeconds: numOf(r["duration"]),
    pubdate: numOf(r["pubdate"]),
    owner: { mid: numOf(owner["mid"]), name: strOf(owner["name"]) },
    stat: {
      view: numOf(stat["view"]),
      danmaku: numOf(stat["danmaku"]),
      reply: numOf(stat["reply"]),
      favorite: numOf(stat["favorite"]),
      coin: numOf(stat["coin"]),
      share: numOf(stat["share"]),
      like: numOf(stat["like"]),
    },
    ...(r["cid"] !== undefined ? { cid: numOf(r["cid"]) } : {}),
    ...(typeof pic === "string" && pic ? { pic } : {}),
  };
}

function mapReply(raw: unknown): BiliReply {
  const r = rec(raw);
  const member = rec(r["member"]);
  const content = rec(r["content"]);
  const level = rec(member["level_info"]);
  const official = rec(member["official_verify"]);
  return {
    rpid: numOf(r["rpid"]),
    like: numOf(r["like"]),
    ctime: numOf(r["ctime"]),
    message: strOf(content["message"]),
    mid: numOf(member["mid"]),
    uname: strOf(member["uname"]),
    level: numOf(level["current_level"]),
    officialType: numOf(official["type"]),
  };
}

function mapUpCard(data: unknown): BiliUpCard {
  const d = rec(data);
  const card = rec(d["card"]);
  const level = rec(card["level_info"]);
  const official = rec(card["official_verify"]);
  const desc = official["desc"];
  return {
    mid: numOf(card["mid"]),
    name: strOf(card["name"]),
    fans: numOf(card["fans"]),
    level: numOf(level["current_level"]),
    officialType: numOf(official["type"]),
    ...(typeof desc === "string" && desc ? { officialDesc: desc } : {}),
  };
}

/** 每日预算的落盘形态：localDay 一变即清零。 */
interface BudgetFile {
  day: string;
  count: number;
}

/** buvid3 的落盘形态：获取一次长期复用。 */
interface BuvidFile {
  buvid3: string;
  buvid4?: string;
  acquiredAt: number;
}

function describeError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export function createBiliClient(options: BiliClientOptions = {}): BiliClient {
  const varDir = options.varDir ?? defaultVarDir();
  const budgetPath = join(varDir, "bili-budget.json");
  const statePath = join(varDir, "bili-state.json");
  const budgetCap = Math.max(0, Math.floor(options.dailyBudget ?? 60));
  const intervalMs = Math.max(0, Math.floor(options.sameEndpointIntervalMs ?? 2000));
  const timeoutMs = Math.max(1, Math.floor(options.timeoutMs ?? 20_000));
  const now = options.now ?? (() => new Date());
  const doFetch = options.fetchImpl ?? fetch;
  const log = (message: string): void => {
    try {
      options.log?.(message);
    } catch {
      // 日志不许炸请求
    }
  };

  const today = (): string => localDay(now().getTime());

  // —— 每日预算（var/bili-budget.json 持久，跨重启接续、跨天清零）——
  let budget: BudgetFile | undefined;

  function currentBudget(): BudgetFile {
    const day = today();
    if (budget?.day !== day) {
      let count = 0;
      if (budget === undefined) {
        // 首次记账：把盘上今天的计数接过来（别的进程/上次运行花掉的要认）
        try {
          const raw = rec(JSON.parse(readFileSync(budgetPath, "utf8")));
          if (strOf(raw["day"]) === day) count = Math.max(0, numOf(raw["count"]));
        } catch {
          // 没有文件或坏文件：从 0 开始
        }
      }
      budget = { day, count };
      persistBudget();
    }
    return budget;
  }

  function persistBudget(): void {
    if (budget === undefined) return;
    try {
      writeFileSync(budgetPath, JSON.stringify(budget));
    } catch (error) {
      log(`预算落盘失败：${describeError(error)}`);
    }
  }

  // —— 风控熔断（内存态，按当日记；跨天自动失效）——
  const tripped = new Map<BiliEndpoint, string>();

  function assertLive(endpoint: BiliEndpoint): void {
    if (tripped.get(endpoint) === today()) {
      throw new Error(`B站 ${endpoint} 今日已熔断（-412/-352 风控）`);
    }
  }

  // —— 全局串行锁 + 同端点间隔 ——
  let chain: Promise<unknown> = Promise.resolve();
  const lastStartAt = new Map<BiliEndpoint, number>();

  function enqueue<T>(task: () => Promise<T>): Promise<T> {
    const run = chain.then(task, task);
    chain = run.then(
      () => undefined,
      () => undefined,
    );
    return run;
  }

  async function spacingWait(endpoint: BiliEndpoint): Promise<void> {
    const last = lastStartAt.get(endpoint);
    if (last === undefined || intervalMs <= 0) return;
    const wait = intervalMs - (now().getTime() - last);
    if (wait > 0) await new Promise<void>((resolve) => setTimeout(resolve, wait));
  }

  // —— buvid3：finger/spi 获取一次，落盘长期复用 ——
  let buvid: { buvid3: string; buvid4?: string } | undefined;
  let acquiring: Promise<void> | undefined;

  function buvidFromDisk(): { buvid3: string; buvid4?: string } | undefined {
    try {
      const raw = rec(JSON.parse(readFileSync(statePath, "utf8")));
      const b3 = strOf(raw["buvid3"]);
      if (!b3) return undefined;
      const b4 = strOf(raw["buvid4"]);
      return { buvid3: b3, ...(b4 ? { buvid4: b4 } : {}) };
    } catch {
      return undefined;
    }
  }

  function headers(): Record<string, string> {
    const base: Record<string, string> = {
      "user-agent": PINNED_UA,
      referer: PINNED_REFERER,
      accept: "application/json, text/plain, */*",
    };
    if (buvid) {
      base["cookie"] = buvid.buvid4 ? `buvid3=${buvid.buvid3}; buvid4=${buvid.buvid4}` : `buvid3=${buvid.buvid3}`;
    }
    return base;
  }

  async function acquireBuvid(): Promise<void> {
    // spi 自身不再触发 ensureBuvid（skipBuvid），否则自我递归
    const data = await send("spi", {}, { skipBuvid: true });
    const b3 = strOf(rec(data)["b_3"]);
    if (!b3) throw new Error("B站 finger/spi 未返回 buvid3");
    const b4 = strOf(rec(data)["b_4"]);
    buvid = { buvid3: b3, ...(b4 ? { buvid4: b4 } : {}) };
    const file: BuvidFile = { ...buvid, acquiredAt: now().getTime() };
    try {
      writeFileSync(statePath, JSON.stringify(file));
    } catch (error) {
      log(`buvid3 落盘失败：${describeError(error)}（本进程仍可用）`);
    }
  }

  async function ensureBuvid(): Promise<void> {
    if (buvid?.buvid3) return;
    if (buvid === undefined) buvid = buvidFromDisk();
    if (buvid?.buvid3) return;
    acquiring ??= acquireBuvid().finally(() => {
      acquiring = undefined;
    });
    await acquiring;
  }

  /** 发一个白名单请求并解析 B 站信封；dm 端点返回原始 XML 文本。 */
  async function send(
    endpoint: BiliEndpoint,
    params: BiliEndpointParams = {},
    opts: { skipBuvid?: boolean } = {},
  ): Promise<unknown> {
    assertLive(endpoint);
    if (!opts.skipBuvid) await ensureBuvid();
    return enqueue(async () => {
      assertLive(endpoint);
      const bucket = currentBudget();
      if (bucket.count >= budgetCap) {
        throw new Error(`B站日预算已用尽（${bucket.count}/${budgetCap}）`);
      }
      await spacingWait(endpoint);
      lastStartAt.set(endpoint, now().getTime());

      const ctrl = new AbortController();
      const timer = setTimeout(() => ctrl.abort(), timeoutMs);
      let res: Response;
      try {
        res = await doFetch(endpointUrl(endpoint, params), { headers: headers(), signal: ctrl.signal });
      } catch (error) {
        throw new Error(`B站请求失败（${endpoint}）`, { cause: error });
      } finally {
        clearTimeout(timer);
      }
      // 拿到响应即记账：风控与接口错误同样消耗预算
      bucket.count += 1;
      persistBudget();

      const raw = await res.text();
      if (endpoint === "dm") {
        if (!res.ok) throw new Error(`B站 HTTP ${res.status}（${endpoint}）`);
        return raw;
      }
      let env: unknown;
      try {
        env = JSON.parse(raw);
      } catch {
        if (!res.ok) throw new Error(`B站 HTTP ${res.status}（${endpoint}）`);
        throw new Error(`B站响应解析失败（${endpoint}）`);
      }
      const envelope = rec(env);
      const code = numOf(envelope["code"]);
      if (code === -412 || code === -352) {
        tripped.set(endpoint, today());
        throw new Error(`B站 ${endpoint} 触发风控（${code}），当日熔断`);
      }
      if (!res.ok) throw new Error(`B站 HTTP ${res.status}（${endpoint}）`);
      if (code !== 0) throw new Error(`B站接口 code=${code} ${strOf(envelope["message"]).slice(0, 40)}`);
      return envelope["data"];
    });
  }

  function list(endpoint: "popular" | "ranking", params: BiliEndpointParams): Promise<BiliVideoCard[]> {
    return (async () => {
      const data = rec(await send(endpoint, params));
      return arrOf(data["list"]).map(mapCard);
    })();
  }

  function arrOf(value: unknown): unknown[] {
    return Array.isArray(value) ? value : [];
  }

  return {
    popular(page?: number): Promise<BiliVideoCard[]> {
      return list("popular", { page });
    },
    ranking(rid?: number): Promise<BiliVideoCard[]> {
      return list("ranking", { rid });
    },
    async view(bvid: string): Promise<BiliVideoCard> {
      if (!isValidBvid(bvid)) throw new Error("BV 号格式不对");
      return mapCard(await send("view", { bvid }));
    },
    async danmakuXml(cid: string): Promise<string> {
      if (!/^\d{1,16}$/.test(cid)) throw new Error("cid 格式不对");
      return (await send("dm", { cid })) as string;
    },
    async hotReplies(oid: string | number, type?: number): Promise<BiliReply[]> {
      const data = rec(await send("reply", { oid, type }));
      return arrOf(data["replies"]).map(mapReply);
    },
    async upCard(mid: string | number): Promise<BiliUpCard> {
      return mapUpCard(await send("card", { mid }));
    },
    snapshot(): BiliClientSnapshot {
      const bucket = currentBudget();
      return {
        day: bucket.day,
        used: bucket.count,
        budget: budgetCap,
        intervalMs,
        tripped: [...tripped.entries()].filter(([, day]) => day === today()).map(([endpoint]) => endpoint),
        hasBuvid3: buvid?.buvid3 !== undefined,
      };
    },
  };
}

/** 运行时数据目录缺省值（与 index.ts 的 HOME 同源：仓库 var/，YUGANG_HOME 接线时显式传）。 */
export function defaultVarDir(): string {
  return join(import.meta.dirname, "..", "..", "var");
}

// =====================================================================================
// var/bili-filters.json —— 缺省筛选配置（决策 7：硬筛一票否决 + 软筛权重，mtime 热更新）。
// JSON 不支持注释，字段说明以下面的 TS 注释为准；文件里的数组都是字符串形式的正则。
// =====================================================================================

/** 软筛「达标线 + 得分」：指标 ≥ min 记 score 分。 */
export interface BiliScoreTier {
  min: number;
  score: number;
}

export interface BiliHardFilters {
  /** 播放下限：低于此值直接否（冷启动视频热度不可信）。 */
  minViews: number;
  /** 最小发布时长（小时）：发布不满 48h 的不进池——避开营销号刷量期（异常播放尚未清算）。 */
  minAgeHours: number;
  /** 标题党正则（标题命中即否）。 */
  titleBaitPatterns: string[];
  /** UC 词表（UC 导流/洗稿套话，标题或简介命中即否）。 */
  ucPatterns: string[];
  /** 盘点体正则（标题命中即否：盘点/排行/合集类泛滥且低质）。 */
  listiclePatterns: string[];
  /** 简介引流正则（简介命中即否：导流、带货、拉群）。 */
  promoDescPatterns: string[];
  /** UP 黑名单正则（UP 昵称命中即否，主人可自行追加）。 */
  upBlacklistPatterns: string[];
  /** AI 号昵称正则（UP 昵称命中即否）。 */
  aiNamePatterns: string[];
}

export interface BiliSoftFilters {
  /** 赞播比（like/view）分档：从高到低取第一个命中的档。 */
  likeViewTiers: BiliScoreTier[];
  /** 币播比（coin/view）达标线 + 得分。 */
  coinViewRatio: BiliScoreTier;
  /** 收藏比（favorite/view）达标线 + 得分。 */
  favViewRatio: BiliScoreTier;
  durationSeconds: {
    /** 最短可接受时长（秒），低于扣分。 */
    min: number;
    /** 最佳区间（秒）：时长内容密度最稳的甜点区。 */
    sweetMin: number;
    sweetMax: number;
    /** 最长可接受时长（秒），超过扣分。 */
    max: number;
    /** 落在甜点区的加分。 */
    sweetBonus: number;
    /** 落在 [min,max] 区间外的扣分。 */
    outOfRangePenalty: number;
  };
  /** 简介为空的扣分（懒搬运的弱信号）。 */
  emptyDescPenalty: number;
  /** UP 等级 → 得分（键 "0"-"6"）。 */
  upLevelScores: Record<string, number>;
  /** 带认证的 UP 加分。 */
  verifiedUpBonus: number;
  /** 软筛及格线：总分 ≥ passScore 才算过筛。 */
  passScore: number;
}

export interface BiliFilters {
  version: number;
  hard: BiliHardFilters;
  soft: BiliSoftFilters;
}

/** 缺省筛选配置：与 var/bili-filters.json 的落盘内容一致；调研阈值的可调缺省，主人改文件即生效。 */
export const DEFAULT_BILI_FILTERS: BiliFilters = {
  version: 1,
  hard: {
    minViews: 1000,
    minAgeHours: 48,
    titleBaitPatterns: ["震惊", "惊呆", "吓死", "99%的人", "不转不是", "速看", "马上删", "看完删", "删前", "胆小勿入", "内幕曝光", "最后一天", "转发这条"],
    ucPatterns: ["UC[-_ ]?(头条|浏览器)", "UC[-_ ]?(震惊部|编辑部)", "UC[-_ ]?资讯", "不看后悔", "后悔没看", "史上最[全强]", "国外网友", "老外看[傻呆蒙]", "吓坏", "不明真相"],
    listiclePatterns: ["盘点", "排行[榜行]", "TOP\\s*\\d+", "top\\s*\\d+", "[0-9０-９]+个", "[0-9０-９]+款", "[0-9０-９]+部", "合集", "年度大盘点"],
    promoDescPatterns: ["(关注|私信|加).{0,4}(领|送|进群|拿)", "(微信|公众号|QQ|qq)[:：\\s]*[0-9a-zA-Z_\\-]{5,}", "(淘宝|拼多多|京东)搜索", "优惠券|领券|折扣|返利", "(点击|戳).{0,4}(链接|购买|下单)", "全网最低", "主页(查看|领取)", "(限时|仅限).{0,4}(优惠|特价)"],
    upBlacklistPatterns: ["^UC[0-9a-zA-Z_\\-]{5,}$", "营销号", "搬运(工|社)?$", "剪辑侠", "网赚", "薅羊毛", "素材君", "^每日?(推荐|分享|剪辑)$"],
    aiNamePatterns: ["^AI(说|看|聊|讲)", "^AI(观察|实验室)", "^AI(剪辑|视频)", "^AI(先生|小姐)", "AI(生成|出品|制作)", "GPT(说|聊|看)", "人工智能(实验室|观察)", "^AI[-_ ]?[0-9a-zA-Z]+$", "(全自动|一键)生成"],
  },
  soft: {
    likeViewTiers: [
      { min: 0.08, score: 30 },
      { min: 0.05, score: 20 },
      { min: 0.03, score: 10 },
    ],
    coinViewRatio: { min: 0.02, score: 15 },
    favViewRatio: { min: 0.05, score: 10 },
    durationSeconds: { min: 45, sweetMin: 180, sweetMax: 1200, max: 5400, sweetBonus: 10, outOfRangePenalty: 15 },
    emptyDescPenalty: 8,
    upLevelScores: { "0": -20, "1": -15, "2": -8, "3": 0, "4": 5, "5": 10, "6": 15 },
    verifiedUpBonus: 5,
    passScore: 40,
  },
};

function numOr(value: unknown, fallback: number): number {
  const n = typeof value === "number" ? value : NaN;
  return Number.isFinite(n) ? n : fallback;
}

function tierOr(value: unknown, fallback: BiliScoreTier): BiliScoreTier {
  const t = rec(value);
  if (t["min"] === undefined || t["score"] === undefined) return fallback;
  return { min: numOr(t["min"], fallback.min), score: numOr(t["score"], fallback.score) };
}

/** 缺省值兜底的规整：文件缺字段/类型不对时逐项回缺省，绝不把坏配置带进筛选。 */
function normalizeFilters(raw: unknown): BiliFilters {
  const d = DEFAULT_BILI_FILTERS;
  const root = rec(raw);
  const hard = rec(root["hard"]);
  const soft = rec(root["soft"]);
  const duration = rec(soft["durationSeconds"]);
  const levels = rec(soft["upLevelScores"]);
  const upLevelScores: Record<string, number> = {};
  for (const [key, value] of Object.entries(levels)) {
    if (typeof value === "number" && Number.isFinite(value)) upLevelScores[key] = value;
  }
  return {
    version: numOr(root["version"], d.version),
    hard: {
      minViews: numOr(hard["minViews"], d.hard.minViews),
      minAgeHours: numOr(hard["minAgeHours"], d.hard.minAgeHours),
      titleBaitPatterns: strArray(hard["titleBaitPatterns"]).length > 0 ? strArray(hard["titleBaitPatterns"]) : d.hard.titleBaitPatterns,
      ucPatterns: strArray(hard["ucPatterns"]).length > 0 ? strArray(hard["ucPatterns"]) : d.hard.ucPatterns,
      listiclePatterns: strArray(hard["listiclePatterns"]).length > 0 ? strArray(hard["listiclePatterns"]) : d.hard.listiclePatterns,
      promoDescPatterns: strArray(hard["promoDescPatterns"]).length > 0 ? strArray(hard["promoDescPatterns"]) : d.hard.promoDescPatterns,
      upBlacklistPatterns: strArray(hard["upBlacklistPatterns"]).length > 0 ? strArray(hard["upBlacklistPatterns"]) : d.hard.upBlacklistPatterns,
      aiNamePatterns: strArray(hard["aiNamePatterns"]).length > 0 ? strArray(hard["aiNamePatterns"]) : d.hard.aiNamePatterns,
    },
    soft: {
      likeViewTiers: Array.isArray(soft["likeViewTiers"]) && soft["likeViewTiers"].length > 0
        ? (soft["likeViewTiers"] as unknown[]).map((t, i) => tierOr(t, d.soft.likeViewTiers[i] ?? { min: 0, score: 0 }))
        : d.soft.likeViewTiers,
      coinViewRatio: tierOr(soft["coinViewRatio"], d.soft.coinViewRatio),
      favViewRatio: tierOr(soft["favViewRatio"], d.soft.favViewRatio),
      durationSeconds: {
        min: numOr(duration["min"], d.soft.durationSeconds.min),
        sweetMin: numOr(duration["sweetMin"], d.soft.durationSeconds.sweetMin),
        sweetMax: numOr(duration["sweetMax"], d.soft.durationSeconds.sweetMax),
        max: numOr(duration["max"], d.soft.durationSeconds.max),
        sweetBonus: numOr(duration["sweetBonus"], d.soft.durationSeconds.sweetBonus),
        outOfRangePenalty: numOr(duration["outOfRangePenalty"], d.soft.durationSeconds.outOfRangePenalty),
      },
      emptyDescPenalty: numOr(soft["emptyDescPenalty"], d.soft.emptyDescPenalty),
      upLevelScores: Object.keys(upLevelScores).length > 0 ? upLevelScores : d.soft.upLevelScores,
      verifiedUpBonus: numOr(soft["verifiedUpBonus"], d.soft.verifiedUpBonus),
      passScore: numOr(soft["passScore"], d.soft.passScore),
    },
  };
}

function readFiltersFile(path: string): { filters: BiliFilters; problem?: string } {
  try {
    return { filters: normalizeFilters(JSON.parse(readFileSync(path, "utf8"))) };
  } catch (error) {
    return { filters: DEFAULT_BILI_FILTERS, problem: describeError(error) };
  }
}

/**
 * 筛选配置热加载器（决策 7：mtime 热更新）：文件变更即重读，缺文件/坏文件回缺省并告警一次。
 * 返回取值函数，调用方每轮筛选现取（µs 级 stat）。
 */
export function createBiliFiltersLoader(options: { varDir?: string } = {}): () => BiliFilters {
  const path = join(options.varDir ?? defaultVarDir(), "bili-filters.json");
  const mtimeOf = (): number => {
    try {
      return existsSync(path) ? statSync(path).mtimeMs : -1;
    } catch {
      return -1;
    }
  };
  let mtime = mtimeOf();
  let current = readFiltersFile(path);
  if (current.problem) console.warn(`[鱼缸] bili-filters.json 回缺省：${current.problem}`);
  return () => {
    const now = mtimeOf();
    if (now !== mtime) {
      mtime = now;
      current = readFiltersFile(path);
      if (current.problem) console.warn(`[鱼缸] bili-filters.json 回缺省：${current.problem}`);
    }
    return current.filters;
  };
}

/** 把 JSON 里的正则字符串编译成 RegExp（忽略大小写）；非法条目跳过并告警，不炸筛选。 */
export function compileFilterPatterns(patterns: readonly string[], log?: (message: string) => void): RegExp[] {
  const out: RegExp[] = [];
  for (const pattern of patterns) {
    try {
      out.push(new RegExp(pattern, "i"));
    } catch {
      log?.(`筛选正则非法，已跳过：${pattern}`);
    }
  }
  return out;
}
