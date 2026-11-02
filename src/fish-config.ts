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

export interface FishConfig {
  /** 非 @、非特别关注的消息：同一群两条被处理消息之间的最短间隔（秒）。 */
  ambientMinIntervalSeconds: number;
  /** 特别关注者发言的概率（0–1）。 */
  watchAmbientChance: number;
  /** 搭话总开关：legacy（缺省）= 现行判定照旧；next = 定时开窗两态（节拍与上限见 engage）。 */
  engagement: EngagementMode;
  /** next 搭话开窗参数：closed/open 节拍、积压与背景上限、nudge 阈值（仅 next 消费）。 */
  engage: EngageConfig;
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
  if (!any) {
    return { ok: false, reason: problems.length > 0 ? `engage 至少要有一个合法参数（${problems.join("；")}）` : "engage 至少要有一个合法参数" };
  }
  return { ok: true, value: { ...ENGAGE_DEFAULTS, ...parsed }, ...(problems.length > 0 ? { problems } : {}) };
}

export const FISH_CONFIG_FIELDS: readonly FishConfigFieldSpec[] = [
  { name: "ambientMinIntervalSeconds", effect: "hot", check: numberIn("ambientMinIntervalSeconds 必须在 5–3600", 5, 3600) },
  { name: "watchAmbientChance", effect: "hot", check: numberIn("watchAmbientChance 必须是 0–1", 0, 1) },
  { name: "engagement", effect: "hot", check: oneOf("engagement 只认 legacy/next", ENGAGEMENT_MODES as readonly string[]) },
  { name: "engage", effect: "hot", check: checkEngageBlock },
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
