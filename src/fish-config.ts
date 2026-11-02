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
}

export const ENGAGE_DEFAULTS: EngageConfig = {
  closedMinutes: 10,
  openMinutes: 3,
  windowSize: 20,
  mentionContextSize: 5,
  silenceThreshold: 3,
  windowRelaxCap: 30,
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

function num(raw: unknown): number | undefined {
  const n = typeof raw === "number" ? raw : typeof raw === "string" ? Number(raw) : NaN;
  return Number.isFinite(n) ? n : undefined;
}

function chance(raw: unknown): number | undefined {
  const n = num(raw);
  return n !== undefined && n >= 0 && n <= 1 ? n : undefined;
}

function parseFile(raw: unknown, problems: string[]): Partial<FishConfig> {
  if (!raw || typeof raw !== "object") {
    problems.push("fish.config.json 不是对象，整份忽略");
    return {};
  }
  const src = raw as Record<string, unknown>;
  const out: Partial<FishConfig> = {};

  const interval = num(src["ambientMinIntervalSeconds"]);
  if (interval !== undefined && interval >= 5 && interval <= 3600) out.ambientMinIntervalSeconds = interval;
  else if (src["ambientMinIntervalSeconds"] !== undefined) problems.push("ambientMinIntervalSeconds 必须在 5–3600，已忽略");

  if (src["ambientChance"] !== undefined || src["ambientChanceByGroup"] !== undefined) {
    problems.push("ambientChance[/ByGroup] 已废弃: 限流模式, 可删除");
  }

  const watched = chance(src["watchAmbientChance"]);
  if (watched !== undefined) out.watchAmbientChance = watched;
  else if (src["watchAmbientChance"] !== undefined) problems.push("watchAmbientChance 必须是 0–1，已忽略");

  const engagement = src["engagement"];
  if (typeof engagement === "string") {
    if (ENGAGEMENT_MODES.includes(engagement as EngagementMode)) out.engagement = engagement as EngagementMode;
    else problems.push(`engagement 只认 legacy/next：${engagement}，已忽略`);
  } else if (engagement !== undefined) {
    problems.push("engagement 必须是 legacy/next，已忽略");
  }

  const engage = src["engage"];
  if (engage !== undefined) {
    if (engage && typeof engage === "object" && !Array.isArray(engage)) {
      const e = engage as Record<string, unknown>;
      const parsed: Partial<EngageConfig> = {};
      const minutes = num(e["closedMinutes"]);
      if (minutes !== undefined && minutes >= 1 && minutes <= 240) parsed.closedMinutes = Math.floor(minutes);
      else if (e["closedMinutes"] !== undefined) problems.push("engage.closedMinutes 必须在 1–240，已忽略");

      const open = num(e["openMinutes"]);
      if (open !== undefined && open >= 1 && open <= 120) parsed.openMinutes = Math.floor(open);
      else if (e["openMinutes"] !== undefined) problems.push("engage.openMinutes 必须在 1–120，已忽略");

      const windowSize = num(e["windowSize"]);
      if (windowSize !== undefined && windowSize >= 1 && windowSize <= 100) parsed.windowSize = Math.floor(windowSize);
      else if (e["windowSize"] !== undefined) problems.push("engage.windowSize 必须在 1–100，已忽略");

      const mentionContext = num(e["mentionContextSize"]);
      if (mentionContext !== undefined && mentionContext >= 1 && mentionContext <= 30) parsed.mentionContextSize = Math.floor(mentionContext);
      else if (e["mentionContextSize"] !== undefined) problems.push("engage.mentionContextSize 必须在 1–30，已忽略");

      const silence = num(e["silenceThreshold"]);
      if (silence !== undefined && silence >= 1 && silence <= 50) parsed.silenceThreshold = Math.floor(silence);
      else if (e["silenceThreshold"] !== undefined) problems.push("engage.silenceThreshold 必须在 1–50，已忽略");

      const relaxCap = num(e["windowRelaxCap"]);
      if (relaxCap !== undefined && relaxCap >= 10 && relaxCap <= 100) parsed.windowRelaxCap = Math.floor(relaxCap);
      else if (e["windowRelaxCap"] !== undefined) problems.push("engage.windowRelaxCap 必须在 10–100，已忽略");

      // 合法字段并入缺省（部分非法只丢非法项），全非法则整块走缺省
      if (Object.keys(parsed).length > 0) out.engage = { ...ENGAGE_DEFAULTS, ...parsed };
    } else {
      problems.push("engage 必须是对象，已忽略");
    }
  }

  const level = src["thinkingLevel"];
  if (typeof level === "string") {
    if (THINKING_LEVELS.includes(level as ThinkingLevel)) out.thinkingLevel = level as ThinkingLevel;
    else problems.push(`thinkingLevel 不认识：${level}，已忽略`);
  }

  const compact = src["compact"];
  if (compact && typeof compact === "object" && !Array.isArray(compact)) {
    const c = compact as Record<string, unknown>;
    const maxEntries = num(c["maxEntries"]);
    const maxChars = num(c["maxChars"]);
    const next: { maxEntries?: number; maxChars?: number } = {};
    if (maxEntries !== undefined && maxEntries >= 1 && maxEntries <= 5000) next.maxEntries = Math.floor(maxEntries);
    else if (c["maxEntries"] !== undefined) problems.push("compact.maxEntries 必须在 1–5000，已忽略");
    if (maxChars !== undefined && maxChars >= 1000 && maxChars <= 200_000) next.maxChars = Math.floor(maxChars);
    else if (c["maxChars"] !== undefined) problems.push("compact.maxChars 必须在 1000–200000，已忽略");
    if (next.maxEntries !== undefined || next.maxChars !== undefined) {
      out.compact = { maxEntries: next.maxEntries ?? 200, maxChars: next.maxChars ?? 50_000 };
    }
  }

  const timeout = num(src["toolTimeoutSeconds"]);
  if (timeout !== undefined && timeout >= 5 && timeout <= 600) out.toolTimeoutSeconds = timeout;
  else if (src["toolTimeoutSeconds"] !== undefined) problems.push("toolTimeoutSeconds 必须在 5–600，已忽略");

  const cooldown = num(src["memeCooldownMinutes"]);
  if (cooldown !== undefined && cooldown >= 0 && cooldown <= 240) out.memeCooldownMinutes = cooldown;
  else if (src["memeCooldownMinutes"] !== undefined) problems.push("memeCooldownMinutes 必须在 0–240，已忽略");

  const salvage = src["salvagePlainReply"];
  if (typeof salvage === "boolean") out.salvagePlainReply = salvage;
  else if (salvage !== undefined) problems.push("salvagePlainReply 必须是 true/false，已忽略");

  const rawVoices = src["voices"];
  if (rawVoices && typeof rawVoices === "object" && !Array.isArray(rawVoices)) {
    const voices: FishConfig["voices"] = {};
    for (const [persona, value] of Object.entries(rawVoices as Record<string, unknown>)) {
      if (!value || typeof value !== "object") continue;
      const v = value as Record<string, unknown>;
      const url = typeof v["url"] === "string" ? v["url"].trim() : "";
      if (!url) {
        problems.push(`voices.${persona}.url 缺失，已忽略`);
        continue;
      }
      const speedRaw = num(v["speed"]);
      const speed = speedRaw !== undefined && speedRaw >= 0.5 && speedRaw <= 2 ? speedRaw : undefined;
      if (speedRaw !== undefined && speed === undefined) problems.push(`voices.${persona}.speed 必须在 0.5–2.0，已忽略`);
      voices[persona] = {
        url,
        ...(typeof v["referWav"] === "string" ? { referWav: v["referWav"] } : {}),
        ...(typeof v["referText"] === "string" ? { referText: v["referText"] } : {}),
        ...(typeof v["referLanguage"] === "string" ? { referLanguage: v["referLanguage"] } : {}),
        ...(speed !== undefined ? { speed } : {}),
      };
    }
    out.voices = voices;
  }

  const weekly = src["weeklyGroupId"];
  if (typeof weekly === "string" && /^\d+$/.test(weekly.trim())) out.weeklyGroupId = weekly.trim();
  else if (weekly !== undefined && weekly !== "") problems.push("weeklyGroupId 必须是群号（纯数字），已忽略");

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
