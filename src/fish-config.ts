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

export type ThinkingLevel = "off" | "minimal" | "low" | "medium" | "high" | "xhigh" | "max";

const THINKING_LEVELS: readonly ThinkingLevel[] = ["off", "minimal", "low", "medium", "high", "xhigh", "max"];

/** 搭话总开关：legacy = 现行全部搭话判定；next = 按群定时开窗——closed 态非 @ 群消息统一 skip:next_pending，open 态 free_pass 走合并管线。 */
export type EngagementMode = "legacy" | "next";

const ENGAGEMENT_MODES: readonly EngagementMode[] = ["legacy", "next"];

/** next 搭话（engagement=next）的开窗参数；逐字段校验，非法告警保留缺省，热生效。 */
export interface EngageConfig {
  /** closed 相位时长（分钟）：非 @ 群消息 skip:next_pending，@ 恒必答。 */
  closedMinutes: number;
  /** open 相位时长（分钟）：非 @ 群消息 free_pass 走合并管线（非必答，零出口合法）。 */
  openMinutes: number;
  /** 开窗积压注入上限（条）：超出取最近 N 条（T3 消费；零出口翻倍后放宽到 windowRelaxCap）。 */
  windowSize: number;
  /** @ 轮背景条数（legacy 恒 10 不变，仅 next 消费）。 */
  mentionContextSize: number;
  /** 连续 N 个 open 窗全程零出口后，下窗注入尾部 nudge（T8 消费）。 */
  silenceThreshold: number;
  /** 零出口超 2×阈值后积压窗口放宽到此上限；recent 流水上限同步提升 max(30, windowRelaxCap)。 */
  windowRelaxCap: number;
  /** open 态分片节拍（秒）：每拍把窗内全部发送者的新消息合成一轮 ambient 提交（T14 消费）。 */
  shardSeconds: number;
  /** 群白名单（群号字符串）：engagement=next 仅对这些群生效；空 = 任何群都不进 next（fail-safe）。 */
  groups: string[];
}

export const ENGAGE_DEFAULTS: EngageConfig = {
  closedMinutes: 10,
  openMinutes: 3,
  windowSize: 20,
  mentionContextSize: 5,
  silenceThreshold: 3,
  windowRelaxCap: 30,
  groups: [],
  shardSeconds: 20,
};

/**
 * B 站弹药管线（外部计划 E1–E5）的行为参数：逛轮时点、硬截止、随机门、TTL 与预算。
 * 逐字段校验，非法告警保留缺省，热生效。
 */
export interface AmmoConfig {
  /** 每天逛 B 站的时点表（HH:MM，去重保序；24:00 = 当天末尾）。 */
  slots: string[];
  /** 单次逛轮的硬截止（分钟）：watchdog 到点收束，未提交候选丢弃。 */
  browseMinutes: number;
  /** open 窗随机门：每次开窗以这个概率决定本窗是否可分享一条外部弹药（0–1）。 */
  shareChance: number;
  /** 弹药入库后的存活时长（小时），过期惰性清理。 */
  ttlHours: number;
  /** bili-client 每日请求总预算（次），跨重启持久计数。 */
  dailyBudget: number;
  /** 单次逛轮最多入库的弹药条数。 */
  maxPicksPerRun: number;
}

export const AMMO_DEFAULTS: AmmoConfig = {
  slots: ["09:00", "12:00", "18:00", "24:00"],
  browseMinutes: 10,
  shareChance: 0.2,
  ttlHours: 48,
  dailyBudget: 60,
  maxPicksPerRun: 3,
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
  /** 每天播报时点（HH:MM）。 */
  at: string;
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

export interface FishConfig {
  /** 非 @、非特别关注的消息：同一群两条被处理消息之间的最短间隔（秒）。 */
  ambientMinIntervalSeconds: number;
  /** 特别关注者发言的概率（0–1）。 */
  watchAmbientChance: number;
  /** 搭话总开关：legacy（缺省）= 现行判定照旧；next = 定时开窗两态（节拍与上限见 engage）。 */
  engagement: EngagementMode;
  /** next 搭话开窗参数：closed/open 节拍、积压与背景上限、nudge 阈值（仅 next 消费）。 */
  engage: EngageConfig;
  /** B 站弹药管线参数：逛轮时点、硬截止、随机门、TTL、每日预算与单轮入库上限。 */
  ammo: AmmoConfig;
  /** 新闻播报管线参数：播报时点、目标群、topic 供料与输入/输出上限。 */
  news: NewsConfig;
  /** 出站配速（秒）：outbox drain 同会话相邻两次实际发送的最小间隔，防连珠炮（0 = 关闭）。 */
  sendPacingSeconds: number;
  /** 思考档位；启动时写进会话 agent，改完重启才生效。 */
  thinkingLevel: ThinkingLevel;
  /** 换页阈值：条目数 / 字符数。 */
  compact: { maxEntries: number; maxChars: number };
  /** 单次工具调用超时（秒）：某个工具卡住超过这么久就报错，不再干等。 */
  toolTimeoutSeconds: number;
  /** 表情包跨轮冷却（分钟）：同一群两次配图之间的最短间隔。 */
  memeCooldownMinutes: number;
  /** 模型忘调出口工具时的正文兜底（仅必答轮）：零出口时取正文首行过出口校验后补发；误发可关。 */
  salvagePlainReply: boolean;
  /** 按人格配置的语音：人格名 → TTS 参数。没有条目的人格没有语音能力。speed 为可选语速倍率（0.5–2.0，缺省原速）。 */
  voices: Record<string, { url: string; referWav?: string; referText?: string; referLanguage?: string; speed?: number }>;
  /** 周报发到哪个群；空 = 不发。 */
  weeklyGroupId?: string;
}

export interface ConfigLoadResult {
  config: FishConfig;
  source: "file" | "env" | "default" | "mixed";
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
  const maxEntries = num(c["maxEntries"]);
  const maxChars = num(c["maxChars"]);
  if (c["maxEntries"] !== undefined && (maxEntries === undefined || maxEntries < 1 || maxEntries > 5000)) {
    return { ok: false, reason: "compact.maxEntries 必须在 1–5000" };
  }
  if (c["maxChars"] !== undefined && (maxChars === undefined || maxChars < 1000 || maxChars > 200_000)) {
    return { ok: false, reason: "compact.maxChars 必须在 1000–200000" };
  }
  if (maxEntries === undefined && maxChars === undefined) return { ok: false, reason: "compact 至少要有 maxEntries 或 maxChars" };
  return {
    ok: true,
    value: { maxEntries: maxEntries !== undefined ? Math.floor(maxEntries) : 200, maxChars: maxChars !== undefined ? Math.floor(maxChars) : 50_000 },
  };
}

function checkSalvage(raw: unknown): FieldCheck {
  if (typeof raw === "boolean") return { ok: true, value: raw };
  return { ok: false, reason: "salvagePlainReply 必须是 true/false" };
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
    ["closedMinutes", "engage.closedMinutes 必须在 1–240"],
    ["openMinutes", "engage.openMinutes 必须在 1–120"],
    ["windowSize", "engage.windowSize 必须在 1–100"],
    ["mentionContextSize", "engage.mentionContextSize 必须在 1–30"],
    ["silenceThreshold", "engage.silenceThreshold 必须在 1–50"],
    ["windowRelaxCap", "engage.windowRelaxCap 必须在 10–100"],
    ["groups", "engage.groups 必须是群号字符串数组"],
    ["shardSeconds", "engage.shardSeconds 必须在 5–120"],
  ];
  const ranges: Record<string, [number, number]> = {
    closedMinutes: [1, 240],
    openMinutes: [1, 120],
    windowSize: [1, 100],
    mentionContextSize: [1, 30],
    silenceThreshold: [1, 50],
    windowRelaxCap: [10, 100],
    shardSeconds: [5, 120],
  };
  const parsed: Partial<EngageConfig> = {};
  const problems: string[] = [];
  let any = false;
  const known = new Set<string>(specs.map(([key]) => key));
  if (e["groups"] !== undefined) {
    const g = e["groups"];
    if (Array.isArray(g) && g.every((x) => typeof x === "string" && /^\d+$/.test(x))) {
      parsed.groups = [...new Set(g)];
      any = true;
    } else {
      problems.push("engage.groups 必须是群号数组，已回默认");
    }
  }
  for (const [key, reason] of specs) {
    if (key === "groups" || e[key] === undefined) continue;
    const [lo, hi] = ranges[key];
    const r = numberIn(reason, lo, hi, true)(e[key]);
    if (r.ok) {
      (parsed as Record<string, number>)[key] = r.value as number;
      any = true;
    } else {
      problems.push(`${reason}，已回默认`);
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
  return { ok: true, value: { ...ENGAGE_DEFAULTS, ...parsed }, ...(problems.length > 0 ? { problems } : {}) };
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
 * 合法照用」语义）；slots 里的坏时点剔除并告警；全部字段非法才整块拒绝。
 */
function checkAmmoBlock(raw: unknown): FieldCheck {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return { ok: false, reason: "ammo 必须是对象" };
  const a = raw as Record<string, unknown>;
  const parsed: Partial<AmmoConfig> = {};
  const problems: string[] = [];
  let any = false;

  if (a["slots"] !== undefined) {
    const list = a["slots"];
    if (Array.isArray(list) && list.length > 0) {
      const times: string[] = [];
      const check = checkTimeOfDay("ammo.slots");
      for (const item of list) {
        const r = check(item);
        if (r.ok) times.push(r.value as string);
        else problems.push(`${r.reason}，该时点已忽略`);
      }
      if (times.length > 0) {
        parsed.slots = [...new Set(times)];
        any = true;
      } else problems.push("ammo.slots 没有合法时点，已回默认");
    } else problems.push("ammo.slots 必须是非空 HH:MM 数组，已回默认");
  }

  const ranges: Array<[keyof AmmoConfig, number, number]> = [
    ["browseMinutes", 1, 60],
    ["ttlHours", 1, 168],
    ["dailyBudget", 10, 500],
    ["maxPicksPerRun", 1, 10],
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
  if (a["shareChance"] !== undefined) {
    const c = chance(a["shareChance"]);
    if (c !== undefined) {
      parsed.shareChance = c;
      any = true;
    } else problems.push("ammo.shareChance 必须是 0–1，已回默认");
  }

  // 未知嵌套键显式告警（与 engage 同款）：拼错的键名保留忽略语义，但 problems 必须可见
  const known = new Set<string>(["slots", "shareChance", ...ranges.map(([key]) => key)]);
  for (const key of Object.keys(a)) {
    if (known.has(key)) continue;
    problems.push(`ammo.${key} 不是受控字段，已忽略`);
  }
  if (!any) {
    return { ok: false, reason: problems.length > 0 ? `ammo 至少要有一个合法参数（${problems.join("；")}）` : "ammo 至少要有一个合法参数" };
  }
  return { ok: true, value: { ...AMMO_DEFAULTS, ...parsed }, ...(problems.length > 0 ? { problems } : {}) };
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

  const known = new Set<string>(["at", "targetGroup", "topics", "perTopicInput", "perTopicOutput"]);
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
  { name: "ambientMinIntervalSeconds", effect: "hot", check: numberIn("ambientMinIntervalSeconds 必须在 5–3600", 5, 3600) },
  { name: "watchAmbientChance", effect: "hot", check: numberIn("watchAmbientChance 必须是 0–1", 0, 1) },
  { name: "engagement", effect: "hot", check: oneOf("engagement 只认 legacy/next", ENGAGEMENT_MODES as readonly string[]) },
  { name: "engage", effect: "hot", check: checkEngageBlock },
  { name: "ammo", effect: "hot", check: checkAmmoBlock },
  { name: "news", effect: "hot", check: checkNewsBlock },
  { name: "sendPacingSeconds", effect: "hot", check: numberIn("sendPacingSeconds 必须在 0–60", 0, 60) },
  { name: "thinkingLevel", effect: "restart", check: oneOf("thinkingLevel 不认识", THINKING_LEVELS as readonly string[]) },
  { name: "compact", effect: "hot", check: checkCompact },
  { name: "toolTimeoutSeconds", effect: "restart", check: numberIn("toolTimeoutSeconds 必须在 5–600", 5, 600) },
  { name: "memeCooldownMinutes", effect: "hot", check: numberIn("memeCooldownMinutes 必须在 0–240", 0, 240) },
  { name: "salvagePlainReply", effect: "hot", check: checkSalvage },
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

function parseEnv(env: NodeJS.ProcessEnv, problems: string[]): Partial<FishConfig> {
  const out: Partial<FishConfig> = {};
  const interval = num(env["AMBIENT_MIN_INTERVAL_SECONDS"]);
  if (interval !== undefined && interval >= 5) out.ambientMinIntervalSeconds = interval;

  const watched = chance(env["WATCH_AMBIENT_CHANCE"]);
  if (watched !== undefined) out.watchAmbientChance = watched;

  const toolTimeout = num(env["TOOL_TIMEOUT_SECONDS"]);
  if (toolTimeout !== undefined && toolTimeout >= 5) out.toolTimeoutSeconds = toolTimeout;

  const level = env["THINKING_LEVEL"];
  if (level && THINKING_LEVELS.includes(level as ThinkingLevel)) out.thinkingLevel = level as ThinkingLevel;

  const maxEntries = num(env["COMPACT_MAX_ENTRIES"]);
  const maxChars = num(env["COMPACT_MAX_CHARS"]);
  if ((maxEntries !== undefined && maxEntries >= 1) || (maxChars !== undefined && maxChars >= 1000)) {
    out.compact = {
      maxEntries: maxEntries !== undefined && maxEntries >= 1 ? Math.floor(maxEntries) : 200,
      maxChars: maxChars !== undefined && maxChars >= 1000 ? Math.floor(maxChars) : 50_000,
    };
  }

  const weekly = env["WEEKLY_GROUP_ID"]?.trim();
  if (weekly && /^\d+$/.test(weekly)) out.weeklyGroupId = weekly;

  return out;
}

const DEFAULTS: FishConfig = {
  ambientMinIntervalSeconds: 60,
  watchAmbientChance: 0.5,
  engagement: "legacy",
  engage: ENGAGE_DEFAULTS,
  ammo: AMMO_DEFAULTS,
  news: NEWS_DEFAULTS,
  sendPacingSeconds: 6,
  thinkingLevel: "low",
  compact: { maxEntries: 200, maxChars: 50_000 },
  memeCooldownMinutes: 8,
  voices: {},
  toolTimeoutSeconds: 30,
  salvagePlainReply: true,
};

/** 读一次（不缓存），供热加载与启动各取所需。 */
export function loadFishConfig(options: { path?: string; env?: NodeJS.ProcessEnv } = {}): ConfigLoadResult {
  const env = options.env ?? process.env;
  const path = options.path ?? join(process.cwd(), "fish.config.json");
  const problems: string[] = [];

  const fromEnv = parseEnv(env, problems);
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
    ...fromEnv,
    ...fromFile,
    compact: { ...DEFAULTS.compact, ...(fromEnv.compact ?? {}), ...(fromFile.compact ?? {}) },
    engage: { ...DEFAULTS.engage, ...(fromEnv.engage ?? {}), ...(fromFile.engage ?? {}) },
    ammo: { ...DEFAULTS.ammo, ...(fromEnv.ammo ?? {}), ...(fromFile.ammo ?? {}) },
    news: { ...DEFAULTS.news, ...(fromEnv.news ?? {}), ...(fromFile.news ?? {}) },
  };

  const usesEnv = Object.keys(fromEnv).length > 0;
  const source: ConfigLoadResult["source"] = hasFile && usesEnv ? "mixed" : hasFile ? "file" : usesEnv ? "env" : "default";
  return { config, source, problems };
}

/**
 * 热加载包装：mtime 变了就重读；读坏了保留上一份好的配置。
 * 每次调用都有一次 statSync（µs 级），换取「改完立刻生效」。
 */
export function createConfigLoader(options: { path?: string; env?: NodeJS.ProcessEnv } = {}): () => ConfigLoadResult {
  const path = options.path ?? join(process.cwd(), "fish.config.json");
  let current = loadFishConfig({ ...options, path });
  let mtime = existsSync(path) ? statSync(path).mtimeMs : 0;

  for (const problem of current.problems) console.warn(`[鱼缸] 配置 ${problem}`);
  console.log(`[鱼缸] 配置来源 ${current.source === "file" ? path : current.source === "mixed" ? `${path} + .env` : current.source === "env" ? ".env" : "内置默认"}`);

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
