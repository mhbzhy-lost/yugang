/**
 * fish.config.json —— 可让鱼自己调的行为参数。
 *
 * 与 .env 的分工：
 *   .env            机器/身份/凭据/安全边界（MASTER_QQ、GROUPS、token、路径、模型选择），鱼无权改
 *   fish.config.json 纯行为调参（随机门概率、思考档、换页阈值、周报群），鱼可以读写
 *
 * 热生效：每次取值都 stat mtime，文件变了就重读，改完下一轮即生效，不需要重启。
 * 校验：数值越界/枚举不对时保留旧值（或默认值）并打一行告警，绝不让鱼把自己调成刷屏机器。
 * 优先级：fish.config.json > .env > 内置默认（旧 env 仍认，避免线上配置一夜失效）。
 */
import { existsSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { FISH_CONFIG_PATH } from "./paths.ts";

export type ThinkingLevel = "off" | "minimal" | "low" | "medium" | "high" | "xhigh" | "max";

const THINKING_LEVELS: readonly ThinkingLevel[] = ["off", "minimal", "low", "medium", "high", "xhigh", "max"];

/** 搭话模式标记（兼容 harness 的 runtime 裁剪）：next = 开窗两态；free = 自由活动模式
 *  （专用白名单群恒可搭话、60 秒一拍合并）；非群会话（私聊 / worker）标 legacy 以裁掉
 *  runtime 的窗口协议小节（行为与历史一致），不再有开关语义。 */
export type EngagementMode = "legacy" | "free";

/** 搭话参数（2026-11-06 合并：自由活动模式唯一，开窗两态已退役）；逐字段校验，非法告警保留缺省，热生效。 */
export interface EngageConfig {
  /** 自由活动模式的拍长（秒，15–3600，缺省 60）：一拍把这段时间内全部发送者的非 @ 消息合成一轮。 */
  freeSeconds: number;
  /** 空拍时的自主开口概率（0–1，缺省 0.03）：门开才提交「主动交流机会」；0 = 恒关；宵禁恒关。 */
  freeBrowseChance: number;
  /** 单拍提交上限（条，1–200，缺省 50）：超出留最近 N 条、丢弃最旧并计数留日志——唯一收集器有损点。 */
  freeBatchMax: number;
  /** @ 轮背景条数（1–100，可选）：不设 = 全量未读（补到 lastmsg flag，recent 30 条天然上限）；
   *  设了 = 锚点前最近 N 条再剔已读，截断外的未读按主人裁定视为已读丢弃。已读标记本身
   *  不受它影响（每次唤醒轮无条件推满到最新消息）。 */
  answerContextSize?: number;
  /** 按群覆盖（群号 → 差异化参数）：命中键覆盖全局缺省，未命中键/群用全局值。
   *  大群降频的专用旋钮（如 freeSeconds 拉到 1200 = 20 分钟看一眼）。 */
  byGroup?: Record<string, EngageGroupOverride>;
}

/** engage.byGroup 的单群覆盖形状：全部可选，只覆盖显式给出的键。 */
export interface EngageGroupOverride {
  freeSeconds?: number;
  freeBrowseChance?: number;
  freeBatchMax?: number;
  answerContextSize?: number;
}

/** engage 参数的运行侧合并视图（消费点统一走它，不各自读 config.engage）。 */
export interface EngageSettings {
  freeSeconds: number;
  freeBrowseChance: number;
  freeBatchMax: number;
  answerContextSize?: number;
}

/** chatKey（含 #人格 后缀也认前缀）→ engage 参数：按群覆盖命中优先，未命中用全局缺省。 */
export function engageSettingsOf(config: { engage: EngageConfig }, chatKey: string): EngageSettings {
  const matched = /^qq:group:(\d+)/.exec(chatKey);
  const override = matched !== null ? config.engage.byGroup?.[matched[1]!] : undefined;
  return {
    freeSeconds: override?.freeSeconds ?? config.engage.freeSeconds,
    freeBrowseChance: override?.freeBrowseChance ?? config.engage.freeBrowseChance,
    freeBatchMax: override?.freeBatchMax ?? config.engage.freeBatchMax,
    ...(override?.answerContextSize !== undefined || config.engage.answerContextSize !== undefined
      ? { answerContextSize: override?.answerContextSize ?? config.engage.answerContextSize }
      : {}),
  };
}

export const ENGAGE_DEFAULTS: EngageConfig = {
  freeSeconds: 60,
  freeBrowseChance: 0.03,
  freeBatchMax: 50,
};

/**
 * B 站弹药管线（外部计划 E1–E5）的行为参数：逛轮时点、硬截止、随机门、TTL、预算与空库补货目标。
 * 逐字段校验，非法告警保留缺省，热生效。
 * 【2026-11-04 模型输入计划 T3】弹药管线已停用：这些字段保留为兼容配置（config 工具仍受理），
 * 不再驱动 worker 逛轮/分享；仅 dailyBudget 在 video.dailyBudget 缺省时作回退。
 */
export interface AmmoConfig {
  /** 每天逛 B 站的时点表（HH:MM，去重保序；24:00 = 当天末尾）。 */
  slots: string[];
  /** 单次逛轮的硬截止（分钟）：watchdog 到点收束，未提交候选丢弃。 */
  browseMinutes: number;
  /** 弹药入库后的存活时长（小时），过期惰性清理。 */
  ttlHours: number;
  /** bili-client 每日请求总预算（次），跨重启持久计数。 */
  dailyBudget: number;
  /** 单次逛轮最多入库的弹药条数。 */
  maxPicksPerRun: number;
  /** 空库自动补货目标（0–20）：库内可分享条目为 0 时自动起一轮逛轮，maxPicks 定格为该值；0 = 关闭。 */
  refillTarget: number;
}

export const AMMO_DEFAULTS: AmmoConfig = {
  // 缺省空表（2026-11-04 计划 T1）：不按时刻起轮，逛轮由空库事件驱动补货（maybeRefillAmmo）触发
  slots: [],
  browseMinutes: 10,
  ttlHours: 48,
  dailyBudget: 60,
  maxPicksPerRun: 3,
  refillTarget: 5,
};

/**
 * 视频浏览管线的行为参数：单轮观看上限与 B 站每日预算。逐字段校验，非法告警保留缺省，
 * 热生效。主动门概率在 engage.freeBrowseChance（2026-11-06 开窗两态退役，
 * 旧开窗门概率已删）；取代已停用的 ammo 管线：旧 ammo.dailyBudget 仅在
 * video.dailyBudget 缺省时作回退（见 loadFishConfig）。
 */
export interface VideoConfig {
  /** 单个 browse 轮内实际观看视频的次数上限（缺省 5；T4 的 video 工具消费）。 */
  browseMaxViewsPerRound: number;
  /** bili-client 每日请求总预算（次，缺省 60），跨重启持久计数；取代 ammo.dailyBudget。 */
  dailyBudget: number;
}

export const VIDEO_DEFAULTS: VideoConfig = {
  browseMaxViewsPerRound: 5,
  dailyBudget: 60,
};

/** 新闻 topic 的来源枚举：与新闻客户端（外部计划 E6）的取数实现一一对应。 */
export const NEWS_SOURCES: readonly string[] = [
  "60s",
  "jiemian",
  "huxiu",
  "ithome",
  "people",
  "zhihu_daily",
  "weibo_hot",
  "baidu_hot",
];

/** 单个新闻 topic：按 sources+keywords 取料，exclude 词表先过滤（如娱乐圈）。 */
export interface NewsTopicConfig {
  /** topic 名（播报分节标题）。 */
  name: string;
  /** 取料来源（NEWS_SOURCES 的非空子集）。 */
  sources: string[];
  /** 关键词命中表（sources+keywords 两层映射的第一层）。 */
  keywords: string[];
  /** 排除词表（标题命中即剔除）。 */
  exclude: string[];
}

/** 新闻播报管线（外部计划 E6–E7）的行为参数。逐字段校验，非法告警保留缺省，热生效。 */
export interface NewsConfig {
  /** 每天开始备料时点（HH:MM）。 */
  at: string;
  /** 备料窗口分钟数（1–30，缺省 10）；到点停止备料并机械入队。 */
  preparationMinutes: number;
  /** 播报目标群号（纯数字）；空串 = 不启用。必须是 .env GROUPS 白名单内的群号——域校验在运行时消费处（E7），这里只做格式校验。 */
  targetGroup: string;
  /** 播报 topic 表；显式给 topics 就整体覆盖缺省五 topic。 */
  topics: NewsTopicConfig[];
  /** 每 topic 送模型的输入上限（条）。 */
  perTopicInput: number;
  /** 每 topic 输出的新闻条数上限。 */
  perTopicOutput: number;
}

/** 缺省五 topic（AI/时政/军事/科技数码/趣闻二次元）；趣闻二次元带娱乐圈 exclude 词表，词表可热改。 */
export const NEWS_DEFAULTS: NewsConfig = {
  at: "10:30",
  preparationMinutes: 10,
  targetGroup: "",
  topics: [
    { name: "AI", sources: ["60s", "huxiu", "ithome", "zhihu_daily"], keywords: ["AI", "人工智能", "大模型", "机器学习", "AIGC"], exclude: [] },
    { name: "时政", sources: ["people", "60s", "jiemian"], keywords: ["时政", "国内", "国际", "外交", "政策"], exclude: [] },
    { name: "军事", sources: ["60s", "people", "weibo_hot"], keywords: ["军事", "国防", "军演", "战机", "军舰"], exclude: [] },
    { name: "科技数码", sources: ["ithome", "huxiu", "zhihu_daily"], keywords: ["科技", "数码", "手机", "芯片", "发布会"], exclude: [] },
    {
      name: "趣闻二次元",
      sources: ["weibo_hot", "baidu_hot", "zhihu_daily"],
      keywords: ["趣闻", "热梗", "二次元", "动漫", "游戏"],
      exclude: ["明星", "综艺", "出轨", "官宣恋情", "红毯", "颁奖礼", "八卦", "热搜第一"],
    },
  ],
  perTopicInput: 20,
  perTopicOutput: 5,
};

export interface CompactConfig {
  /** 默认单次请求上下文阈值（tokens）；完整轮次结束后才换页，不截断消息。 */
  maxTokens: number;
  /** provider 或 provider/model → token 阈值；精确模型键优先于 provider 键。 */
  byModel: Record<string, number>;
}

/** 当前主模型实际使用的换页阈值：精确 provider/model 覆盖优先，其次 provider，最后默认。 */
export function compactTokenLimitOf(config: CompactConfig, provider: string, modelId: string): number {
  return config.byModel[`${provider}/${modelId}`] ?? config.byModel[provider] ?? config.maxTokens;
}

export interface FishConfig {
  /** next 搭话开窗参数：closed/open 节拍、积压与背景上限、nudge 阈值。 */
  engage: EngageConfig;
  /** B 站弹药管线参数（已停用，兼容保留）：仅 dailyBudget 在 video.dailyBudget 缺省时作回退。 */
  ammo: AmmoConfig;
  /** 视频浏览管线参数：open 空窗主动门概率、单轮观看上限与 B 站每日预算。 */
  video: VideoConfig;
  /** 新闻备料管线参数：开始时点、准备窗口、目标群、topic 供料与输入/输出上限。 */
  news: NewsConfig;
  /** 出站配速（秒）：outbox drain 同会话相邻两次实际发送的最小间隔，防连珠炮（0 = 关闭）。 */
  sendPacingSeconds: number;
  /** 思考档位；启动时写进会话 agent，改完重启才生效。 */
  thinkingLevel: ThinkingLevel;
  /** 换页阈值：按实际请求 tokens，支持按模型覆盖。 */
  compact: CompactConfig;
  /** 单次工具调用超时（秒）：某个工具卡住超过这么久就报错，不再干等。 */
  toolTimeoutSeconds: number;
  /** 表情包跨轮冷却（分钟）：同一群两次配图之间的最短间隔。 */
  memeCooldownMinutes: number;
  /** 模型忘调出口工具时的正文兜底（仅必答轮）：零出口时取正文首行过出口校验后补发；误发可关。 */
  salvagePlainReply: boolean;
  /**
   * GIF 自动收图豁免（2026-11-10 改配置）：true = 群里来的 inbound/ 动图允许鱼自己在
   * ambient 轮判断入库（行内双边收录标记引导）；false（缺省）= 动图同静态图，
   * 只有主人点头的轮才能收 meme_add。
   */
  gifAutoCollect: boolean;
  /** 按人格配置的语音：人格名 → TTS 参数。没有条目的人格没有语音能力。speed 为可选语速倍率（0.5–2.0，缺省原速）。 */
  voices: Record<string, { url: string; referWav?: string; referText?: string; referLanguage?: string; speed?: number }>;
  /** 周报发到哪个群；空 = 不发。 */
  weeklyGroupId?: string;
}

export interface ConfigLoadResult {
  config: FishConfig;
  source: "file" | "default";
  problems: string[];
}

/** 受控字段生效语义：hot = fish.config.json 热加载（mtime 变了下一轮生效）；restart = 写盘后需重启进程。 */
export type FishConfigEffect = "hot" | "restart";

/** 单字段校验结果：ok 时 value 是规整后可直接写盘的值；失败 reason 是完整告警文案（不含结尾「，已忽略」）。
 *  ok 且 problems 非空 = 部分字段非法已回默认（终审 #5）：合法字段照用，逐字段告警由 parseFile / config 工具透出。 */
export type FieldCheck = { ok: true; value: unknown; problems?: string[] } | { ok: false; reason: string };

/** fish.config.json 受控字段规格：config 工具的白名单与 parseFile 共用这一份，别处不得另写校验。 */
export interface FishConfigFieldSpec {
  /** 顶层字段名（白名单 key）。 */
  name: string;
  /** 生效语义：config 工具的 read 清单与 set 回执按它标注。 */
  effect: FishConfigEffect;
  /** 校验并规整一个值。 */
  check: (raw: unknown) => FieldCheck;
}

function num(raw: unknown): number | undefined {
  const n = typeof raw === "number" ? raw : typeof raw === "string" ? Number(raw) : NaN;
  return Number.isFinite(n) ? n : undefined;
}

function chance(raw: unknown): number | undefined {
  const n = num(raw);
  return n !== undefined && n >= 0 && n <= 1 ? n : undefined;
}

/** 数值范围校验；floor 为真时向下取整（compact 子字段的现行行为）。 */
function numberIn(reason: string, min: number, max: number, floor = false) {
  return (raw: unknown): FieldCheck => {
    const n = num(raw);
    if (n === undefined || n < min || n > max) return { ok: false, reason };
    return { ok: true, value: floor ? Math.floor(n) : n };
  };
}

/** 枚举校验：只认 values 里的字符串值，其余（含非字符串）拒绝并带上收到的值。 */
function oneOf(body: string, values: readonly string[]) {
  return (raw: unknown): FieldCheck => {
    if (typeof raw === "string" && values.includes(raw)) return { ok: true, value: raw };
    return { ok: false, reason: typeof raw === "string" ? `${body}：${raw}` : body };
  };
}

function checkCompact(raw: unknown): FieldCheck {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return { ok: false, reason: "compact 必须是对象" };
  const c = raw as Record<string, unknown>;
  const problems: string[] = [];
  for (const legacy of ["maxEntries", "maxChars"]) {
    if (c[legacy] !== undefined) problems.push(`compact.${legacy} 已停用，换页只按 tokens`);
  }
  const maxTokens = c["maxTokens"] === undefined ? 100_000 : num(c["maxTokens"]);
  if (maxTokens === undefined || maxTokens < 1_000 || maxTokens > 1_000_000) {
    return { ok: false, reason: "compact.maxTokens 必须在 1000–1000000" };
  }
  const byModel: Record<string, number> = {};
  const rawOverrides = c["byModel"];
  if (rawOverrides !== undefined && (!rawOverrides || typeof rawOverrides !== "object" || Array.isArray(rawOverrides))) {
    return { ok: false, reason: "compact.byModel 必须是 provider/model 到 token 阈值的对象" };
  }
  for (const [key, rawLimit] of Object.entries((rawOverrides ?? {}) as Record<string, unknown>)) {
    const limit = num(rawLimit);
    const validKey = /^[^\s/]+(?:\/[^\s/]+)?$/.test(key);
    if (!validKey || limit === undefined || limit < 1_000 || limit > 1_000_000) {
      problems.push(`compact.byModel.${key || "(空键)"} 非法，已忽略`);
      continue;
    }
    byModel[key] = Math.floor(limit);
  }
  for (const key of Object.keys(c)) {
    if (!["maxTokens", "byModel", "maxEntries", "maxChars"].includes(key)) problems.push(`compact.${key} 不是受控字段，已忽略`);
  }
  return {
    ok: true,
    value: {
      maxTokens: Math.floor(maxTokens),
      // 未写 byModel 时保留内置覆盖；只有显式写 {} 才是清空全部模型覆盖。
      ...(rawOverrides !== undefined ? { byModel } : {}),
    },
    ...(problems.length > 0 ? { problems } : {}),
  };
}

function checkSalvage(raw: unknown): FieldCheck {
  if (typeof raw === "boolean") return { ok: true, value: raw };
  return { ok: false, reason: "salvagePlainReply 必须是 true/false" };
}

function checkGifAutoCollect(raw: unknown): FieldCheck {
  if (typeof raw === "boolean") return { ok: true, value: raw };
  return { ok: false, reason: "gifAutoCollect 必须是 true/false" };
}

function checkVoices(raw: unknown): FieldCheck {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return { ok: false, reason: "voices 必须是对象" };
  const voices: Record<string, { url: string; referWav?: string; referText?: string; referLanguage?: string; speed?: number }> = {};
  for (const [persona, value] of Object.entries(raw as Record<string, unknown>)) {
    if (!value || typeof value !== "object" || Array.isArray(value)) return { ok: false, reason: `voices.${persona} 必须是对象` };
    const v = value as Record<string, unknown>;
    const url = typeof v["url"] === "string" ? v["url"].trim() : "";
    if (!url) return { ok: false, reason: `voices.${persona}.url 缺失` };
    const speedRaw = num(v["speed"]);
    const speed = speedRaw !== undefined && speedRaw >= 0.5 && speedRaw <= 2 ? speedRaw : undefined;
    if (speedRaw !== undefined && speed === undefined) return { ok: false, reason: `voices.${persona}.speed 必须在 0.5–2.0` };
    voices[persona] = {
      url,
      ...(typeof v["referWav"] === "string" ? { referWav: v["referWav"] } : {}),
      ...(typeof v["referText"] === "string" ? { referText: v["referText"] } : {}),
      ...(typeof v["referLanguage"] === "string" ? { referLanguage: v["referLanguage"] } : {}),
      ...(speed !== undefined ? { speed } : {}),
    };
  }
  return { ok: true, value: voices };
}

function checkWeeklyGroup(raw: unknown): FieldCheck {
  if (raw === "") return { ok: true, value: "" }; // 空串 = 不发周报
  if (typeof raw === "string" && /^\d+$/.test(raw.trim())) return { ok: true, value: raw.trim() };
  return { ok: false, reason: "weeklyGroupId 必须是群号（纯数字）" };
}

/**
 * 受控字段白名单（config 工具与 parseFile 的唯一来源）。
 * 逐字段的说明文案在 src/tools/config/TOOL.md 的字段表，两边必须同步改。
 */
/**
 * engage 块的校验（config 工具 set 与 parseFile 共用这一份，区间以此处为准）：
 * 逐字段校验，非法字段回默认并记入 problems（终审 #5：保留「非法回默认、合法照用」
 * 语义但必须告警）；全部非法才整块拒绝。
 */
function checkEngageBlock(raw: unknown): FieldCheck {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return { ok: false, reason: "engage 必须是对象" };
  const e = raw as Record<string, unknown>;
  const specs: Array<[keyof EngageConfig, string]> = [
    ["freeSeconds", "engage.freeSeconds 必须在 15–3600"],
    ["freeBrowseChance", "engage.freeBrowseChance 必须是 0–1"],
    ["freeBatchMax", "engage.freeBatchMax 必须在 1–200"],
    ["answerContextSize", "engage.answerContextSize 必须在 1–100"],
  ];
  const ranges: Record<string, [number, number]> = {
    freeSeconds: [15, 3600],
    freeBrowseChance: [0, 1],
    freeBatchMax: [1, 200],
    answerContextSize: [1, 100],
  };
  const parsed: Partial<EngageConfig> = {};
  const problems: string[] = [];
  let any = false;
  const known = new Set<string>([...specs.map(([key]) => key), "byGroup"]);
  for (const [key, reason] of specs) {
    if (e[key] === undefined) continue;
    const [lo, hi] = ranges[key];
    // freeBrowseChance 是概率（允许小数），其余是条数/秒数（向下取整）
    const r = numberIn(reason, lo, hi, key !== "freeBrowseChance")(e[key]);
    if (r.ok) {
      (parsed as Record<string, number>)[key] = r.value as number;
      any = true;
    } else {
      problems.push(`${reason}，已回默认`);
    }
  }
  // byGroup：按群覆盖。键必须纯数字群号，值按与全局同款范围逐键校验（非法键剔除并告警，
  // 覆盖块整体非法则丢弃该群覆盖）；answerContextSize 同语义（undefined = 不覆盖，回落全局）
  if (e["byGroup"] !== undefined) {
    const rawBy = e["byGroup"];
    if (!rawBy || typeof rawBy !== "object" || Array.isArray(rawBy)) {
      problems.push("engage.byGroup 必须是对象（群号 → 参数覆盖）");
    } else {
      const kept: Record<string, EngageGroupOverride> = {};
      let keptAny = false;
      for (const [group, rawOv] of Object.entries(rawBy as Record<string, unknown>)) {
        if (!/^\d+$/.test(group)) {
          problems.push(`engage.byGroup 键 ${group} 不是群号，已剔除`);
          continue;
        }
        if (!rawOv || typeof rawOv !== "object" || Array.isArray(rawOv)) {
          problems.push(`engage.byGroup.${group} 必须是对象，已剔除`);
          continue;
        }
        const ov: Record<string, number> = {};
        for (const [key, reason] of specs) {
          const raw = (rawOv as Record<string, unknown>)[key];
          if (raw === undefined) continue;
          const [lo, hi] = ranges[key];
          const r = numberIn(`engage.byGroup.${group}.${reason}`, lo, hi, key !== "freeBrowseChance")(raw);
          if (r.ok) ov[key] = r.value as number;
          else problems.push(`engage.byGroup.${group}.${reason}，已剔除该键`);
        }
        for (const key of Object.keys(rawOv as Record<string, unknown>)) {
          if (!known.has(key)) problems.push(`engage.byGroup.${group}.${key} 不是受控字段，已忽略`);
        }
        if (Object.keys(ov).length > 0) {
          kept[group] = ov;
          keptAny = true;
        }
      }
      if (keptAny) {
        parsed.byGroup = kept;
        any = true;
      }
    }
  }
  // 未知嵌套键显式告警（终验 #8）：拼错的键名不再静默——保留忽略语义，但 problems 必须可见
  for (const key of Object.keys(e)) {
    if (known.has(key)) continue;
    problems.push(`engage.${key} 不是受控字段，已忽略`);
  }
  if (!any) {
    return { ok: false, reason: problems.length > 0 ? `engage 至少要有一个合法参数（${problems.join("；")}）` : "engage 至少要有一个合法参数" };
  }
  const value: EngageConfig = { ...ENGAGE_DEFAULTS, ...parsed };
  return { ok: true, value, ...(problems.length > 0 ? { problems } : {}) };
}

/** HH:MM 时点校验：00:00–23:59，另认 24:00（当天末尾）；合法时返回 trim 后的原样字符串。 */
function checkTimeOfDay(label: string) {
  return (raw: unknown): FieldCheck => {
    const text = typeof raw === "string" ? raw.trim() : "";
    const m = /^(\d{2}):(\d{2})$/.exec(text);
    const hh = m ? Number(m[1]) : NaN;
    const mm = m ? Number(m[2]) : NaN;
    const valid = m !== null && (hh === 24 ? mm === 0 : hh <= 23 && mm <= 59);
    if (!valid) return { ok: false, reason: `${label} 必须是 HH:MM 时点` };
    return { ok: true, value: text };
  };
}

/**
 * ammo 块的校验（config 工具 set 与 parseFile 共用这一份，区间以此处为准）：
 * 逐字段校验，非法字段回默认并记入 problems（沿用 checkEngageBlock 的「非法回默认、
 * 合法照用」语义）；slots 空表合法（事件驱动补货的缺省形态）、坏时点剔除并告警；
 * 全部字段非法才整块拒绝。
 */
function checkAmmoBlock(raw: unknown): FieldCheck {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return { ok: false, reason: "ammo 必须是对象" };
  const a = raw as Record<string, unknown>;
  const parsed: Partial<AmmoConfig> = {};
  const problems: string[] = [];
  let any = false;

  if (a["slots"] !== undefined) {
    const list = a["slots"];
    if (Array.isArray(list)) {
      const times: string[] = [];
      const check = checkTimeOfDay("ammo.slots");
      for (const item of list) {
        const r = check(item);
        if (r.ok) times.push(r.value as string);
        else problems.push(`${r.reason}，该时点已忽略`);
      }
      // 空表合法（2026-11-04 计划 T1）：空表 = 纯事件驱动补货；坏时点剔除后合法时点照用
      parsed.slots = [...new Set(times)];
      any = true;
    } else problems.push("ammo.slots 必须是 HH:MM 数组，已回默认");
  }

  const ranges: Array<[keyof AmmoConfig, number, number]> = [
    ["browseMinutes", 1, 60],
    ["ttlHours", 1, 168],
    ["dailyBudget", 10, 500],
    ["maxPicksPerRun", 1, 10],
    ["refillTarget", 0, 20],
  ];
  for (const [key, lo, hi] of ranges) {
    if (a[key] === undefined) continue;
    const r = numberIn(`ammo.${key} 必须在 ${lo}–${hi}`, lo, hi, true)(a[key]);
    if (r.ok) {
      (parsed as Record<string, number>)[key] = r.value as number;
      any = true;
    } else {
      problems.push(`${r.reason}，已回默认`);
    }
  }
  // 未知嵌套键显式告警（与 engage 同款）：拼错的键名保留忽略语义，但 problems 必须可见
  const known = new Set<string>(["slots", ...ranges.map(([key]) => key)]);
  for (const key of Object.keys(a)) {
    if (known.has(key)) continue;
    problems.push(`ammo.${key} 不是受控字段，已忽略`);
  }
  if (!any) {
    return { ok: false, reason: problems.length > 0 ? `ammo 至少要有一个合法参数（${problems.join("；")}）` : "ammo 至少要有一个合法参数" };
  }
  return { ok: true, value: { ...AMMO_DEFAULTS, ...parsed }, ...(problems.length > 0 ? { problems } : {}) };
}

/**
 * video 块的校验（config 工具 set 与 parseFile 共用这一份，区间以此处为准）：
 * 逐字段校验，非法字段回默认并记入 problems（沿用 checkAmmoBlock 的「非法回默认、
 * 合法照用」语义）；全部字段非法才整块拒绝。
 */
function checkVideoBlock(raw: unknown): FieldCheck {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return { ok: false, reason: "video 必须是对象" };
  const v = raw as Record<string, unknown>;
  const parsed: Partial<VideoConfig> = {};
  const problems: string[] = [];
  let any = false;

  const ranges: Array<[keyof VideoConfig, number, number]> = [
    ["browseMaxViewsPerRound", 1, 20],
    ["dailyBudget", 10, 500],
  ];
  for (const [key, lo, hi] of ranges) {
    if (v[key] === undefined) continue;
    const r = numberIn(`video.${key} 必须在 ${lo}–${hi}`, lo, hi, true)(v[key]);
    if (r.ok) {
      (parsed as Record<string, number>)[key] = r.value as number;
      any = true;
    } else {
      problems.push(`${r.reason}，已回默认`);
    }
  }

  // 未知嵌套键显式告警（与 engage/ammo 同款）：拼错的键名保留忽略语义，但 problems 必须可见
  const known = new Set<string>(ranges.map(([key]) => key));
  for (const key of Object.keys(v)) {
    if (known.has(key)) continue;
    problems.push(`video.${key} 不是受控字段，已忽略`);
  }
  if (!any) {
    return { ok: false, reason: problems.length > 0 ? `video 至少要有一个合法参数（${problems.join("；")}）` : "video 至少要有一个合法参数" };
  }
  return { ok: true, value: { ...VIDEO_DEFAULTS, ...parsed }, ...(problems.length > 0 ? { problems } : {}) };
}

/** 字符串数组（topic 的 keywords/exclude）：结构非法返回 undefined，由调用方回空并告警。 */
function stringList(raw: unknown): string[] | undefined {
  if (!Array.isArray(raw) || !raw.every((x) => typeof x === "string")) return undefined;
  return raw as string[];
}

/** topics 数组校验：坏 topic 整条剔除并告警，合法 topic 照用；结构非法（非数组）返回 undefined（回缺省五 topic）。 */
function checkNewsTopics(raw: unknown, problems: string[]): NewsTopicConfig[] | undefined {
  if (!Array.isArray(raw)) {
    problems.push("news.topics 必须是 topic 数组，已回默认");
    return undefined;
  }
  const topics: NewsTopicConfig[] = [];
  raw.forEach((item, index) => {
    if (!item || typeof item !== "object" || Array.isArray(item)) {
      problems.push(`news.topics[${index}] 必须是对象，已忽略`);
      return;
    }
    const t = item as Record<string, unknown>;
    // topic 内未知键同样显式告警（嵌套 topics 的 key 校验）
    for (const key of Object.keys(t)) {
      if (key === "name" || key === "sources" || key === "keywords" || key === "exclude") continue;
      problems.push(`news.topics[${index}].${key} 不是受控字段，已忽略`);
    }
    const name = typeof t["name"] === "string" ? t["name"].trim() : "";
    if (!name) {
      problems.push(`news.topics[${index}].name 必须是非空字符串，已忽略`);
      return;
    }
    const sourcesRaw = t["sources"];
    const sources = Array.isArray(sourcesRaw)
      ? [...new Set(sourcesRaw.filter((s): s is string => typeof s === "string" && NEWS_SOURCES.includes(s)))]
      : [];
    if (sources.length === 0) {
      problems.push(`news.topics[${index}].sources 必须是来源枚举，该 topic 已忽略`);
      return;
    }
    if (Array.isArray(sourcesRaw) && sources.length < new Set(sourcesRaw).size) {
      problems.push(`news.topics[${index}].sources 有来源不在枚举内，已剔除`);
    }
    const keywords = stringList(t["keywords"]);
    if (keywords === undefined && t["keywords"] !== undefined) problems.push(`news.topics[${index}].keywords 必须是字符串数组，已回空`);
    const exclude = stringList(t["exclude"]);
    if (exclude === undefined && t["exclude"] !== undefined) problems.push(`news.topics[${index}].exclude 必须是字符串数组，已回空`);
    topics.push({ name, sources, keywords: keywords ?? [], exclude: exclude ?? [] });
  });
  return topics;
}

/**
 * news 块的校验（config 工具 set 与 parseFile 共用这一份，区间以此处为准）：
 * 逐字段校验，非法字段回默认并记入 problems；targetGroup 只做格式校验（纯数字群号或空串），
 * GROUPS 白名单域校验在运行时消费处（E7）；全部字段非法才整块拒绝。
 */
function checkNewsBlock(raw: unknown): FieldCheck {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return { ok: false, reason: "news 必须是对象" };
  const n = raw as Record<string, unknown>;
  const parsed: Partial<NewsConfig> = {};
  const problems: string[] = [];
  let any = false;

  if (n["at"] !== undefined) {
    const r = checkTimeOfDay("news.at")(n["at"]);
    if (r.ok) {
      parsed.at = r.value as string;
      any = true;
    } else problems.push(`${r.reason}，已回默认`);
  }

  if (n["targetGroup"] !== undefined) {
    const g = n["targetGroup"];
    if (g === "" || (typeof g === "string" && /^\d+$/.test(g.trim()))) {
      parsed.targetGroup = typeof g === "string" ? g.trim() : "";
      any = true;
    } else problems.push("news.targetGroup 必须是数字群号，已回默认");
  }

  const ranges: Array<[keyof NewsConfig, number, number]> = [
    ["preparationMinutes", 1, 30],
    ["perTopicInput", 1, 20],
    ["perTopicOutput", 1, 5],
  ];
  for (const [key, lo, hi] of ranges) {
    if (n[key] === undefined) continue;
    const r = numberIn(`news.${key} 必须在 ${lo}–${hi}`, lo, hi, true)(n[key]);
    if (r.ok) {
      (parsed as Record<string, number>)[key] = r.value as number;
      any = true;
    } else {
      problems.push(`${r.reason}，已回默认`);
    }
  }

  if (n["topics"] !== undefined) {
    const topics = checkNewsTopics(n["topics"], problems);
    if (topics !== undefined) {
      parsed.topics = topics;
      any = true;
    }
  }

  const known = new Set<string>(["at", "targetGroup", "preparationMinutes", "topics", "perTopicInput", "perTopicOutput"]);
  for (const key of Object.keys(n)) {
    if (known.has(key)) continue;
    problems.push(`news.${key} 不是受控字段，已忽略`);
  }
  if (!any) {
    return { ok: false, reason: problems.length > 0 ? `news 至少要有一个合法参数（${problems.join("；")}）` : "news 至少要有一个合法参数" };
  }
  return { ok: true, value: { ...NEWS_DEFAULTS, ...parsed }, ...(problems.length > 0 ? { problems } : {}) };
}

export const FISH_CONFIG_FIELDS: readonly FishConfigFieldSpec[] = [
  { name: "engage", effect: "hot", check: checkEngageBlock },
  { name: "ammo", effect: "hot", check: checkAmmoBlock },
  { name: "video", effect: "hot", check: checkVideoBlock },
  { name: "news", effect: "hot", check: checkNewsBlock },
  { name: "sendPacingSeconds", effect: "hot", check: numberIn("sendPacingSeconds 必须在 0–60", 0, 60) },
  { name: "thinkingLevel", effect: "restart", check: oneOf("thinkingLevel 不认识", THINKING_LEVELS as readonly string[]) },
  { name: "compact", effect: "hot", check: checkCompact },
  { name: "toolTimeoutSeconds", effect: "restart", check: numberIn("toolTimeoutSeconds 必须在 5–600", 5, 600) },
  { name: "memeCooldownMinutes", effect: "hot", check: numberIn("memeCooldownMinutes 必须在 0–240", 0, 240) },
  { name: "salvagePlainReply", effect: "hot", check: checkSalvage },
  { name: "gifAutoCollect", effect: "hot", check: checkGifAutoCollect },
  { name: "voices", effect: "hot", check: checkVoices },
  { name: "weeklyGroupId", effect: "hot", check: checkWeeklyGroup },
];

function parseFile(raw: unknown, problems: string[]): Partial<FishConfig> {
  if (!raw || typeof raw !== "object") {
    problems.push("fish.config.json 不是对象，整份忽略");
    return {};
  }
  const src = raw as Record<string, unknown>;
  const out: Partial<FishConfig> = {};

  if (src["ambientChance"] !== undefined || src["ambientChanceByGroup"] !== undefined) {
    problems.push("ambientChance[/ByGroup] 已废弃: 限流模式, 可删除");
  }
  // legacy 搭话判定下线（2026-11）：旧配置里的四个字段不再受控，提醒清理而非静默忽略
  for (const gone of ["engagement", "ambientMinIntervalSeconds", "watchAmbientChance"]) {
    if (src[gone] !== undefined) problems.push(`${gone} 已随 legacy 搭话判定下线，可删除`);
  }

  // 白名单循环：不在 FISH_CONFIG_FIELDS 里的顶层键一律不认；字段校验与告警文案只有这一份
  for (const spec of FISH_CONFIG_FIELDS) {
    const rawValue = src[spec.name];
    if (rawValue === undefined) continue;
    const result = spec.check(rawValue);
    if (result.ok) {
      (out as Record<string, unknown>)[spec.name] = result.value;
      // 部分字段非法已回默认的（engage 块），逐字段告警照常透出（终审 #5）
      for (const problem of result.problems ?? []) problems.push(problem);
    } else problems.push(`${result.reason}，已忽略`);
  }
  return out;
}

const DEFAULTS: FishConfig = {
  engage: ENGAGE_DEFAULTS,
  ammo: AMMO_DEFAULTS,
  video: VIDEO_DEFAULTS,
  news: NEWS_DEFAULTS,
  sendPacingSeconds: 6,
  thinkingLevel: "low",
  compact: { maxTokens: 100_000, byModel: { "google-antigravity": 90_000 } },
  memeCooldownMinutes: 8,
  voices: {},
  toolTimeoutSeconds: 30,
  salvagePlainReply: true,
  gifAutoCollect: false,
};

/** 读一次（不缓存），供热加载与启动各取所需。 */
export function loadFishConfig(options: { path?: string } = {}): ConfigLoadResult {
  const path = options.path ?? FISH_CONFIG_PATH;
  const problems: string[] = [];

  // 行为参数不再认任何 env 变量（2026-11-06 清理）：全部走 fish.config.json / 缺省
  let fromFile: Partial<FishConfig> = {};
  let hasFile = false;
  if (existsSync(path)) {
    try {
      fromFile = parseFile(JSON.parse(readFileSync(path, "utf8")), problems);
      hasFile = true;
    } catch (error) {
      problems.push(`fish.config.json 解析失败：${error instanceof Error ? error.message : String(error)}`);
    }
  }

  const config: FishConfig = {
    ...DEFAULTS,
    ...fromFile,
    compact: { ...DEFAULTS.compact, ...(fromFile.compact ?? {}) },
    engage: { ...DEFAULTS.engage, ...(fromFile.engage ?? {}) },
    ammo: { ...DEFAULTS.ammo, ...(fromFile.ammo ?? {}) },
    video: { ...DEFAULTS.video, ...(fromFile.video ?? {}) },
    news: { ...DEFAULTS.news, ...(fromFile.news ?? {}) },
  };

  // 旧 ammo.dailyBudget 回退（2026-11-04 模型输入计划 T3）：文件里没给新的 video.dailyBudget
  // 而旧 ammo 块带了值时沿用旧值，避免线上存量配置一夜失效；新值在场时旧字段不再参与
  if (fromFile.video?.dailyBudget === undefined && fromFile.ammo?.dailyBudget !== undefined) {
    config.video = { ...config.video, dailyBudget: fromFile.ammo.dailyBudget };
  }

  const source: ConfigLoadResult["source"] = hasFile ? "file" : "default";
  return { config, source, problems };
}

/**
 * 热加载包装：mtime 变了就重读；读坏了保留上一份好的配置。
 * 每次调用都有一次 statSync（µs 级），换取「改完立刻生效」。
 */
export function createConfigLoader(options: { path?: string; env?: NodeJS.ProcessEnv } = {}): () => ConfigLoadResult {
  const path = options.path ?? FISH_CONFIG_PATH;
  let current = loadFishConfig({ ...options, path });
  let mtime = existsSync(path) ? statSync(path).mtimeMs : 0;

  for (const problem of current.problems) console.warn(`[鱼缸] 配置 ${problem}`);
  console.log(`[鱼缸] 配置来源 ${current.source === "file" ? path : "内置默认"}`);

  return () => {
    const now = existsSync(path) ? statSync(path).mtimeMs : 0;
    if (now !== mtime) {
      mtime = now;
      const next = loadFishConfig({ ...options, path });
      for (const problem of next.problems) console.warn(`[鱼缸] 配置 ${problem}`);
      // 读坏了（解析失败）就沿用旧配置，避免鱼一次手抖把线上打崩
      if (next.problems.some((p) => p.includes("解析失败"))) return current;
      console.log(`[鱼缸] 配置已热更新（${next.source}）`);
      current = next;
    }
    return current;
  };
}
