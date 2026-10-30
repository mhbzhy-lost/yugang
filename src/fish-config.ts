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

export interface FishConfig {
  /** 非 @ 消息进 loop 的概率（0–1）。 */
  ambientChance: number;
  /** 按群覆盖（群号 → 0–1）。 */
  ambientChanceByGroup: Record<string, number>;
  /** 特别关注者发言的概率（0–1）。 */
  watchAmbientChance: number;
  /** 思考档位；启动时写进会话 agent，改完重启才生效。 */
  thinkingLevel: ThinkingLevel;
  /** 换页阈值：条目数 / 字符数。 */
  compact: { maxEntries: number; maxChars: number };
  /** 单轮超时（秒）：一条消息进模型后超过这么久还没结束就丢弃，不再回过时的话。 */
  roundTimeoutSeconds: number;
  /** 表情包跨轮冷却（分钟）：同一群两次配图之间的最短间隔。 */
  memeCooldownMinutes: number;
  /** 按人格配置的语音：人格名 → TTS 参数。没有条目的人格没有语音能力。 */
  voices: Record<string, { url: string; referWav?: string; referText?: string; referLanguage?: string }>;
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

  const ambient = chance(src["ambientChance"]);
  if (ambient !== undefined) out.ambientChance = ambient;
  else if (src["ambientChance"] !== undefined) problems.push("ambientChance 必须是 0–1，已忽略");

  const groups = src["ambientChanceByGroup"];
  if (groups && typeof groups === "object" && !Array.isArray(groups)) {
    const byGroup: Record<string, number> = {};
    for (const [key, value] of Object.entries(groups as Record<string, unknown>)) {
      const v = chance(value);
      if (!/^\d+$/.test(key) || v === undefined) {
        problems.push(`ambientChanceByGroup[${key}] 不合法，已忽略`);
        continue;
      }
      byGroup[key] = v;
    }
    out.ambientChanceByGroup = byGroup;
  }

  const watched = chance(src["watchAmbientChance"]);
  if (watched !== undefined) out.watchAmbientChance = watched;
  else if (src["watchAmbientChance"] !== undefined) problems.push("watchAmbientChance 必须是 0–1，已忽略");

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

  const timeout = num(src["roundTimeoutSeconds"]);
  if (timeout !== undefined && timeout >= 5 && timeout <= 600) out.roundTimeoutSeconds = timeout;
  else if (src["roundTimeoutSeconds"] !== undefined) problems.push("roundTimeoutSeconds 必须在 5–600，已忽略");

  const cooldown = num(src["memeCooldownMinutes"]);
  if (cooldown !== undefined && cooldown >= 0 && cooldown <= 240) out.memeCooldownMinutes = cooldown;
  else if (src["memeCooldownMinutes"] !== undefined) problems.push("memeCooldownMinutes 必须在 0–240，已忽略");

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
      voices[persona] = {
        url,
        ...(typeof v["referWav"] === "string" ? { referWav: v["referWav"] } : {}),
        ...(typeof v["referText"] === "string" ? { referText: v["referText"] } : {}),
        ...(typeof v["referLanguage"] === "string" ? { referLanguage: v["referLanguage"] } : {}),
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
  const ambient = chance(env["AMBIENT_CHANCE"]);
  if (ambient !== undefined) out.ambientChance = ambient;

  const rawGroups = env["AMBIENT_CHANCE_BY_GROUP"]?.trim();
  if (rawGroups) {
    const byGroup: Record<string, number> = {};
    for (const pair of rawGroups.split(",")) {
      const [key, value] = pair.split(":").map((s) => s.trim());
      const v = chance(value);
      if (!key || !/^\d+$/.test(key) || v === undefined) {
        problems.push(`AMBIENT_CHANCE_BY_GROUP 里的 ${pair} 不合法，已忽略`);
        continue;
      }
      byGroup[key] = v;
    }
    out.ambientChanceByGroup = byGroup;
  }

  const watched = chance(env["WATCH_AMBIENT_CHANCE"]);
  if (watched !== undefined) out.watchAmbientChance = watched;

  const roundTimeout = num(env["ROUND_TIMEOUT_SECONDS"]);
  if (roundTimeout !== undefined && roundTimeout >= 5) out.roundTimeoutSeconds = roundTimeout;

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
  ambientChance: 0.1,
  ambientChanceByGroup: {},
  watchAmbientChance: 0.5,
  thinkingLevel: "low",
  compact: { maxEntries: 200, maxChars: 50_000 },
  memeCooldownMinutes: 8,
  voices: {},
  roundTimeoutSeconds: 60,
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
