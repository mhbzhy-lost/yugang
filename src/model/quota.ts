/**
 * provider 额度/余额查询（运维侧，scripts/quota.ts 消费；不进鱼的工具面）。
 *
 * 支持四类真实查询：Google Antigravity（loadCodeAssist + fetchAvailableModels 配额桶）、
 * OpenAI Codex（/wham/usage 窗口）、DeepSeek（/user/balance 余额）、ZAI Coding Plan
 * （/api/monitor/usage/quota/limit）。其余 provider 标 unsupported，缺凭据标 unconfigured。
 *
 * 安全边界：
 * - 全部请求遵循 provider.proxy（createProxyFetch，非法/未配回落直连）；
 * - OAuth 过期刷新走 fileCredentialStore.modify 的跨进程文件锁，锁内复查是否已被其它进程
 *   刷新（OpenAI refresh_token 会轮换，必须锁内原子回写防丢 token）；--no-refresh 不写盘；
 * - 报告与错误文案一律经 redactSecrets 脱敏，结构化结果不含任何 access/refresh/key/clientSecret。
 */

import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { MODELS_CONFIG_PATH } from "../paths.ts";
import { readCredentialFile, type ModelRole, type ModelsFile, type ProviderConfig } from "./config.ts";
import { fileCredentialStore, type Credential, type OAuthCredential } from "../auth/credentials.ts";
import { refreshTokens as refreshGoogleTokens } from "../auth/google.ts";
import { refreshTokens as refreshOpenAiTokens } from "../auth/openai.ts";
import { createProxyFetch } from "../media/proxy-fetch.ts";
import {
  ANTIGRAVITY_BASE_URL,
  antigravityUserAgent,
  discoverProject,
  fetchAvailableModels,
} from "./google-code-assist.ts";

export type QuotaStatus = "ok" | "unsupported" | "unconfigured" | "expired" | "error";
export type QuotaKind = "antigravity" | "codex" | "deepseek" | "zai";

export interface QuotaRoleBinding {
  role: ModelRole;
  model: string;
}

/** 一个配额桶：同家族同 (remainingFraction, resetTime) 的模型折叠在一起。 */
export interface QuotaBucket {
  label: string;
  family?: string;
  remainingPercent?: number;
  usedPercent?: number;
  remaining?: number;
  total?: number;
  /** 重置时间，ms epoch。 */
  resetAt?: number;
  windowSeconds?: number;
  models?: string[];
}

export interface QuotaBalance {
  currency: string;
  totalBalance: string;
  grantedBalance: string;
  toppedUpBalance: string;
}

export interface QuotaTier {
  id?: string;
  name?: string;
}

export interface QuotaProviderReport {
  providerId: string;
  api?: string;
  baseUrl?: string;
  kind?: QuotaKind;
  status: QuotaStatus;
  roles: QuotaRoleBinding[];
  currentTier?: QuotaTier;
  paidTier?: QuotaTier;
  projectId?: string;
  /** codex plan_type / zai data.level。 */
  plan?: string;
  accountId?: string;
  available?: boolean;
  buckets?: QuotaBucket[];
  balances?: QuotaBalance[];
  credits?: string;
  /** 本次查询过程中刷新过 OAuth 凭据并回写。 */
  refreshed?: boolean;
  message?: string;
}

export interface QuotaReport {
  generatedAt: number;
  configSource: string;
  providers: QuotaProviderReport[];
  filterError?: { filter: string; available: string[] };
}

export interface QuotaQueryOptions {
  modelsPath?: string;
  credentialsPath?: string;
  providerFilter?: string;
  noRefresh?: boolean;
  fetchImpl?: typeof fetch;
}

const ROLE_ORDER: ModelRole[] = ["main", "vision", "image", "wan_image", "vision_fallback"];
const OAUTH_EXPIRY_MARGIN_MS = 60_000;

/** 带 HTTP 状态码的错误：401 触发受控刷新重试，其余直接进 error 报告。 */
class HttpStatusError extends Error {
  readonly status: number;

  constructor(status: number, message: string) {
    super(message);
    this.status = status;
  }
}

function num(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function round1(value: number): number {
  return Math.round(value * 10) / 10;
}

function hostOf(baseUrl: string | undefined): string {
  if (!baseUrl) return "";
  try {
    return new URL(baseUrl).hostname;
  } catch {
    return "";
  }
}

function detectKind(providerId: string, provider: ProviderConfig): QuotaKind | undefined {
  const api = provider.api ?? "";
  const base = provider.baseUrl ?? "";
  const host = hostOf(base);
  if (api === "antigravity-code-assist" || providerId === "google-antigravity") return "antigravity";
  if (api === "openai-codex-responses" || providerId === "openai-codex") return "codex";
  if (providerId === "deepseek" || host === "api.deepseek.com") return "deepseek";
  if (providerId === "zai-coding-cn" || (host === "open.bigmodel.cn" && base.includes("/coding/"))) return "zai";
  return undefined;
}

/** 收集本 provider 已知的秘密字面量，用于错误文案脱敏（这些值永不进报告）。 */
function collectSecrets(credential: Credential | undefined, provider: ProviderConfig): string[] {
  const secrets: string[] = [];
  if (credential?.type === "api_key" && credential.key) secrets.push(credential.key);
  if (credential?.type === "oauth") {
    for (const field of ["access", "refresh", "clientId", "clientSecret"]) {
      const value = credential[field];
      if (typeof value === "string" && value.length >= 6) secrets.push(value);
    }
  }
  if (provider.oauthClient?.secret) secrets.push(provider.oauthClient.secret);
  return secrets;
}

/** 抹除已知秘密字面量 + 通用 Bearer/sk- 形态，错误文案才能安全出境。 */
export function redactSecrets(text: string, secrets: string[]): string {
  let out = text;
  for (const secret of secrets) {
    if (secret && secret.length >= 4) out = out.split(secret).join("***");
  }
  out = out.replace(/Bearer\s+[A-Za-z0-9._~+/=-]+/gi, "Bearer ***");
  out = out.replace(/\bsk-[A-Za-z0-9_-]{6,}/g, "***");
  return out;
}

function sanitizeError(error: unknown, secrets: string[]): string {
  const text = error instanceof Error ? error.message : String(error);
  return redactSecrets(text, secrets).slice(0, 300);
}

function isExpired(credential: OAuthCredential): boolean {
  return Date.now() >= credential.expires - OAUTH_EXPIRY_MARGIN_MS;
}

/**
 * 锁内刷新：force 未设时按过期时间判断（别的进程已刷新则复用）；force.usedAccess
 * 是 401 重试路径——锁内发现 access 已换说明别的进程刚刷过，同样复用不重复刷。
 */
async function refreshIfNeeded(args: {
  providerId: string;
  credentialsPath: string;
  credential: OAuthCredential;
  refreshFn: typeof refreshGoogleTokens;
  fetchImpl: typeof fetch;
  force?: { usedAccess: string };
}): Promise<{ credential: OAuthCredential; refreshed: boolean }> {
  const store = fileCredentialStore(args.credentialsPath);
  const result = await store.modify(args.providerId, async (current) => {
    if (!current || current.type !== "oauth") throw new Error("凭据不存在或不是 OAuth 条目，无法刷新");
    if (args.force) {
      if (current.access !== args.force.usedAccess) return undefined;
    } else if (!isExpired(current)) {
      return undefined;
    }
    return await args.refreshFn(current, undefined, args.fetchImpl);
  });
  const after = (result ?? args.credential) as OAuthCredential;
  return { credential: after, refreshed: after.access !== args.credential.access };
}

async function errorIfNotOk(response: Response, label: string): Promise<void> {
  if (response.ok) return;
  const text = await response.text().catch(() => "");
  throw new HttpStatusError(response.status, `${label} 失败 (${response.status}): ${text.slice(0, 200)}`);
}

// ---------- Antigravity ----------

function parseTier(value: unknown): QuotaTier | undefined {
  if (!value || typeof value !== "object") return undefined;
  const record = value as { id?: unknown; name?: unknown };
  const tier: QuotaTier = {
    ...(typeof record.id === "string" ? { id: record.id } : {}),
    ...(typeof record.name === "string" ? { name: record.name } : {}),
  };
  return tier.id || tier.name ? tier : undefined;
}

function parseQuotaInfo(value: unknown): { remainingFraction?: number; resetAt?: number } {
  if (!value || typeof value !== "object") return {};
  const record = value as { remainingFraction?: unknown; resetTime?: unknown };
  const remainingFraction = num(record.remainingFraction);
  let resetAt: number | undefined;
  if (typeof record.resetTime === "string") {
    const parsed = Date.parse(record.resetTime);
    if (!Number.isNaN(parsed)) resetAt = parsed;
  } else {
    const raw = num(record.resetTime);
    if (raw !== undefined) resetAt = raw < 1e12 ? raw * 1000 : raw;
  }
  return {
    ...(remainingFraction !== undefined ? { remainingFraction } : {}),
    ...(resetAt !== undefined ? { resetAt } : {}),
  };
}

const FAMILY_ORDER = ["Claude", "Gemini", "其它"];

function foldAntigravityBuckets(models: Record<string, { quotaInfo?: unknown }>): QuotaBucket[] {
  const buckets = new Map<string, QuotaBucket>();
  for (const [id, info] of Object.entries(models)) {
    const quota = parseQuotaInfo(info?.quotaInfo);
    if (quota.remainingFraction === undefined && quota.resetAt === undefined) continue;
    const family = /claude/i.test(id) ? "Claude" : /gemini/i.test(id) ? "Gemini" : "其它";
    const key = `${family}|${quota.remainingFraction ?? ""}|${quota.resetAt ?? ""}`;
    let bucket = buckets.get(key);
    if (!bucket) {
      bucket = {
        label: `${family} 配额`,
        family,
        models: [],
        ...(quota.remainingFraction !== undefined ? { remainingPercent: round1(quota.remainingFraction * 100) } : {}),
        ...(quota.resetAt !== undefined ? { resetAt: quota.resetAt } : {}),
      };
      buckets.set(key, bucket);
    }
    bucket.models!.push(id);
  }
  return [...buckets.values()].sort(
    (a, b) => FAMILY_ORDER.indexOf(a.family ?? "其它") - FAMILY_ORDER.indexOf(b.family ?? "其它"),
  );
}

async function queryAntigravity(
  provider: ProviderConfig,
  credential: OAuthCredential,
  accessToken: string,
  fetchImpl: typeof fetch,
): Promise<Partial<QuotaProviderReport>> {
  const baseUrl = (provider.baseUrl ?? ANTIGRAVITY_BASE_URL).replace(/\/+$/, "");
  const userAgent = provider.userAgent?.trim() || antigravityUserAgent();
  const loadResponse = await fetchImpl(`${baseUrl}/v1internal:loadCodeAssist`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      authorization: `Bearer ${accessToken}`,
      "user-agent": userAgent,
    },
    body: JSON.stringify({
      metadata: { ideType: "ANTIGRAVITY", platform: "PLATFORM_UNSPECIFIED", pluginType: "GEMINI" },
    }),
  });
  await errorIfNotOk(loadResponse, "loadCodeAssist");
  const load = (await loadResponse.json()) as {
    currentTier?: unknown;
    paidTier?: unknown;
    cloudaicompanionProject?: unknown;
  };
  const rawProject = load.cloudaicompanionProject;
  let projectId =
    typeof rawProject === "string" && rawProject.length > 0
      ? rawProject
      : typeof rawProject === "object" && rawProject !== null && typeof (rawProject as { id?: unknown }).id === "string"
        ? (rawProject as { id: string }).id
        : typeof credential.projectId === "string"
          ? credential.projectId
          : undefined;
  if (!projectId) {
    const discovered = await discoverProject(accessToken, "antigravity", fetchImpl, undefined, { baseUrl, userAgent });
    projectId = discovered.projectId;
  }
  if (!projectId) throw new Error("loadCodeAssist 未返回 project，无法查询模型配额");
  let models: Record<string, { quotaInfo?: unknown }>;
  try {
    models = await fetchAvailableModels(accessToken, projectId, fetchImpl, undefined, { baseUrl, userAgent });
  } catch (error) {
    // fetchAvailableModels 抛普通 Error（带状态码文本），转成 HttpStatusError 让 401 重试路径能识别。
    const message = error instanceof Error ? error.message : String(error);
    const match = /\((\d{3})\)/.exec(message);
    if (error instanceof Error && match) throw new HttpStatusError(Number(match[1]), message);
    throw error;
  }
  const currentTier = parseTier(load.currentTier);
  const paidTier = parseTier(load.paidTier);
  return {
    projectId,
    ...(currentTier ? { currentTier } : {}),
    ...(paidTier ? { paidTier } : {}),
    buckets: foldAntigravityBuckets(models),
  };
}

// ---------- OpenAI Codex ----------

/** 从 access JWT 的 `https://api.openai.com/auth` claim 解 chatgpt_account_id（凭据字段优先）。 */
function accountIdFromJwt(access: string): string | undefined {
  try {
    const parts = access.split(".");
    if (parts.length < 2) return undefined;
    const payload = JSON.parse(Buffer.from(parts[1]!, "base64url").toString("utf8")) as Record<string, unknown>;
    const auth = payload["https://api.openai.com/auth"];
    const id = auth && typeof auth === "object" ? (auth as { chatgpt_account_id?: unknown }).chatgpt_account_id : undefined;
    return typeof id === "string" && id.length > 0 ? id : undefined;
  } catch {
    return undefined;
  }
}

function formatWindow(seconds: number): string {
  if (seconds % 86400 === 0) return `${seconds / 86400}d`;
  if (seconds % 3600 === 0) return `${seconds / 3600}h`;
  if (seconds % 60 === 0) return `${seconds / 60}m`;
  return `${seconds}s`;
}

function parseCodexWindow(value: unknown, fallbackLabel: string): QuotaBucket | undefined {
  if (!value || typeof value !== "object") return undefined;
  const record = value as Record<string, unknown>;
  const usedPercent = num(record.used_percent);
  const minutes = num(record.window_minutes);
  const windowSeconds = num(record.limit_window_seconds) ?? num(record.window_seconds) ?? (minutes !== undefined ? minutes * 60 : undefined);
  let resetAt: number | undefined;
  const resetRaw = num(record.resets_at) ?? num(record.reset_at);
  if (resetRaw !== undefined) resetAt = resetRaw < 1e12 ? resetRaw * 1000 : resetRaw;
  else {
    const after = num(record.reset_after_seconds);
    if (after !== undefined) resetAt = Date.now() + after * 1000;
  }
  if (usedPercent === undefined && windowSeconds === undefined && resetAt === undefined) return undefined;
  return {
    label: windowSeconds !== undefined ? `${formatWindow(windowSeconds)} 窗口` : fallbackLabel,
    ...(usedPercent !== undefined ? { usedPercent, remainingPercent: round1(100 - usedPercent) } : {}),
    ...(windowSeconds !== undefined ? { windowSeconds } : {}),
    ...(resetAt !== undefined ? { resetAt } : {}),
  };
}

async function queryCodex(
  provider: ProviderConfig,
  credential: OAuthCredential,
  accessToken: string,
  fetchImpl: typeof fetch,
): Promise<Partial<QuotaProviderReport>> {
  const baseUrl = (provider.baseUrl ?? "https://chatgpt.com/backend-api").replace(/\/+$/, "").replace(/\/codex$/, "");
  const accountId =
    typeof credential.accountId === "string" && credential.accountId.length > 0
      ? credential.accountId
      : accountIdFromJwt(accessToken);
  const headers: Record<string, string> = {
    authorization: `Bearer ${accessToken}`,
    accept: "application/json",
    "user-agent": "codex-cli",
  };
  if (accountId) headers["chatgpt-account-id"] = accountId;
  const response = await fetchImpl(`${baseUrl}/wham/usage`, { headers });
  await errorIfNotOk(response, "wham/usage");
  const json = (await response.json()) as {
    plan_type?: unknown;
    rate_limit?: { primary_window?: unknown; secondary_window?: unknown };
    additional_rate_limits?: unknown;
    credits?: unknown;
  };
  const buckets: QuotaBucket[] = [];
  const primary = parseCodexWindow(json.rate_limit?.primary_window, "主窗口");
  if (primary) buckets.push(primary);
  const secondary = parseCodexWindow(json.rate_limit?.secondary_window, "次窗口");
  if (secondary) buckets.push(secondary);
  if (Array.isArray(json.additional_rate_limits)) {
    for (const entry of json.additional_rate_limits) {
      const nested = entry && typeof entry === "object" ? (entry as { rate_limit?: { primary_window?: unknown } }) : undefined;
      const bucket = parseCodexWindow(entry, "附加窗口") ?? parseCodexWindow(nested?.rate_limit?.primary_window, "附加窗口");
      if (bucket) buckets.push({ ...bucket, label: `附加 ${bucket.label}` });
    }
  }
  let credits: string | undefined;
  if (json.credits && typeof json.credits === "object") {
    const balance = (json.credits as { balance?: unknown }).balance;
    if (typeof balance === "number" || typeof balance === "string") credits = String(balance);
  }
  return {
    ...(typeof json.plan_type === "string" ? { plan: json.plan_type } : {}),
    ...(accountId ? { accountId } : {}),
    buckets,
    ...(credits !== undefined ? { credits } : {}),
  };
}

// ---------- DeepSeek ----------

async function queryDeepSeek(
  provider: ProviderConfig,
  key: string,
  fetchImpl: typeof fetch,
): Promise<Partial<QuotaProviderReport>> {
  const base = (provider.baseUrl ?? "https://api.deepseek.com").replace(/\/+$/, "").replace(/\/v1$/, "");
  const response = await fetchImpl(`${base}/user/balance`, {
    headers: { authorization: `Bearer ${key}`, accept: "application/json" },
  });
  await errorIfNotOk(response, "user/balance");
  const json = (await response.json()) as {
    is_available?: unknown;
    balance_infos?: Array<{ currency?: unknown; total_balance?: unknown; granted_balance?: unknown; topped_up_balance?: unknown }>;
  };
  const balances: QuotaBalance[] = (Array.isArray(json.balance_infos) ? json.balance_infos : []).map((info) => ({
    currency: String(info.currency ?? ""),
    totalBalance: String(info.total_balance ?? ""),
    grantedBalance: String(info.granted_balance ?? ""),
    toppedUpBalance: String(info.topped_up_balance ?? ""),
  }));
  return { available: json.is_available === true, balances };
}

// ---------- ZAI Coding Plan ----------

const ZAI_UNIT_NAMES: Record<number, string> = { 3: "小时", 4: "天", 5: "月", 6: "周" };

function parseZaiLimit(value: unknown): QuotaBucket | undefined {
  if (!value || typeof value !== "object") return undefined;
  const record = value as Record<string, unknown>;
  const unit = num(record.unit);
  const number = num(record.number);
  const usage = num(record.usage);
  const remaining = num(record.remaining);
  const percentage = num(record.percentage);
  const resetAt = num(record.nextResetTime);
  const label =
    unit !== undefined && ZAI_UNIT_NAMES[unit]
      ? `${number ?? 1}${ZAI_UNIT_NAMES[unit]}窗口`
      : `unit=${unit ?? "?"}×${number ?? "?"}`;
  const remainingPercent =
    usage !== undefined && usage > 0 && remaining !== undefined
      ? round1((remaining / usage) * 100)
      : percentage !== undefined
        ? round1(100 - percentage)
        : undefined;
  return {
    label,
    ...(remainingPercent !== undefined ? { remainingPercent } : {}),
    ...(percentage !== undefined ? { usedPercent: percentage } : {}),
    ...(remaining !== undefined ? { remaining } : {}),
    ...(usage !== undefined ? { total: usage } : {}),
    ...(resetAt !== undefined ? { resetAt } : {}),
  };
}

async function queryZai(
  provider: ProviderConfig,
  key: string,
  fetchImpl: typeof fetch,
): Promise<Partial<QuotaProviderReport>> {
  const origin = new URL(provider.baseUrl ?? "https://open.bigmodel.cn/api/coding/paas/v4").origin;
  const response = await fetchImpl(`${origin}/api/monitor/usage/quota/limit`, {
    headers: { authorization: `Bearer ${key}`, accept: "application/json" },
  });
  await errorIfNotOk(response, "quota/limit");
  const json = (await response.json()) as {
    code?: unknown;
    success?: unknown;
    msg?: unknown;
    data?: { level?: unknown; limits?: unknown };
  };
  if (json.code !== 200 && json.success !== true) {
    throw new Error(`quota/limit 返回异常 (code=${String(json.code)}): ${String(json.msg ?? "").slice(0, 120)}`);
  }
  const data = json.data ?? {};
  const buckets = (Array.isArray(data.limits) ? data.limits : [])
    .map(parseZaiLimit)
    .filter((bucket): bucket is QuotaBucket => bucket !== undefined);
  return {
    ...(typeof data.level === "string" ? { plan: data.level } : {}),
    buckets,
  };
}

// ---------- OAuth 编排（过期刷新 + 401 重试） ----------

async function queryOAuthProvider(args: {
  base: QuotaProviderReport;
  providerId: string;
  provider: ProviderConfig;
  kind: "antigravity" | "codex";
  credential: OAuthCredential;
  credentialsPath: string;
  noRefresh: boolean;
  fetchImpl: typeof fetch;
  secrets: string[];
}): Promise<QuotaProviderReport> {
  const { base, providerId, provider, kind, credentialsPath, noRefresh, fetchImpl, secrets } = args;
  const refreshFn = kind === "antigravity" ? refreshGoogleTokens : refreshOpenAiTokens;
  let credential = args.credential;
  let refreshed = false;
  const attempt = (accessToken: string) =>
    kind === "antigravity"
      ? queryAntigravity(provider, credential, accessToken, fetchImpl)
      : queryCodex(provider, credential, accessToken, fetchImpl);

  if (isExpired(credential)) {
    if (noRefresh) {
      return {
        ...base,
        status: "expired",
        message: "OAuth 凭据已过期，且启用了 --no-refresh 不刷新不写盘；去掉 --no-refresh 可自动刷新",
      };
    }
    const result = await refreshIfNeeded({ providerId, credentialsPath, credential, refreshFn, fetchImpl });
    credential = result.credential;
    refreshed = result.refreshed;
    secrets.push(credential.access, credential.refresh);
  }

  try {
    const partial = await attempt(credential.access);
    return { ...base, ...partial, ...(refreshed ? { refreshed: true } : {}) };
  } catch (error) {
    if (error instanceof HttpStatusError && error.status === 401) {
      if (noRefresh) {
        return {
          ...base,
          status: "expired",
          message: "接口返回 401（凭据已失效），且启用了 --no-refresh 不刷新；去掉 --no-refresh 可自动刷新",
        };
      }
      const result = await refreshIfNeeded({
        providerId,
        credentialsPath,
        credential,
        refreshFn,
        fetchImpl,
        force: { usedAccess: credential.access },
      });
      credential = result.credential;
      refreshed = refreshed || result.refreshed;
      secrets.push(credential.access, credential.refresh);
      const partial = await attempt(credential.access);
      return { ...base, ...partial, ...(refreshed ? { refreshed: true } : {}) };
    }
    throw error;
  }
}

// ---------- 单 provider 与总入口 ----------

function rolesFor(file: ModelsFile, providerId: string): QuotaRoleBinding[] {
  const roles: QuotaRoleBinding[] = [];
  for (const role of ROLE_ORDER) {
    const ref = file.models?.[role];
    if (ref?.provider === providerId) roles.push({ role, model: ref.model });
  }
  return roles;
}

async function queryProvider(
  providerId: string,
  provider: ProviderConfig,
  roles: QuotaRoleBinding[],
  options: QuotaQueryOptions,
  credentialsPath: string,
): Promise<QuotaProviderReport> {
  const base: QuotaProviderReport = {
    providerId,
    ...(provider.api ? { api: provider.api } : {}),
    ...(provider.baseUrl ? { baseUrl: provider.baseUrl } : {}),
    status: "ok",
    roles,
  };
  const kind = detectKind(providerId, provider);
  const credential = readCredentialFile(credentialsPath, providerId) as Credential | undefined;
  const secrets = collectSecrets(credential, provider);
  const proxyFetch = provider.proxy ? createProxyFetch(provider.proxy) : undefined;
  const fetchImpl = options.fetchImpl ?? proxyFetch ?? fetch;

  if (!kind) {
    return { ...base, status: "unsupported", message: "暂无公开额度查询接口" };
  }
  base.kind = kind;
  if (!credential) {
    return { ...base, status: "unconfigured", message: "未配置凭据（config/auth.json 缺该 provider 条目）" };
  }
  try {
    if (kind === "antigravity" || kind === "codex") {
      if (credential.type !== "oauth") {
        return { ...base, status: "unconfigured", message: "该 provider 需要 OAuth 凭据，当前条目不是 oauth" };
      }
      return await queryOAuthProvider({
        base,
        providerId,
        provider,
        kind,
        credential,
        credentialsPath,
        noRefresh: options.noRefresh === true,
        fetchImpl,
        secrets,
      });
    }
    const key = credential.type === "api_key" ? credential.key : undefined;
    if (!key) {
      return { ...base, status: "unconfigured", message: "该 provider 需要 API key，当前凭据条目没有 key" };
    }
    const partial =
      kind === "deepseek" ? await queryDeepSeek(provider, key, fetchImpl) : await queryZai(provider, key, fetchImpl);
    return { ...base, ...partial };
  } catch (error) {
    return { ...base, status: "error", message: sanitizeError(error, secrets) };
  }
}

/** 并发查询全部（或过滤后的）provider；单家失败不阻断其它家。 */
export async function queryQuotas(options: QuotaQueryOptions = {}): Promise<QuotaReport> {
  const modelsPath = options.modelsPath ?? MODELS_CONFIG_PATH;
  if (!existsSync(modelsPath)) {
    throw new Error(`缺 ${modelsPath}：先 cp config/models.example.json config/models.json`);
  }
  let file: ModelsFile;
  try {
    file = JSON.parse(readFileSync(modelsPath, "utf8")) as ModelsFile;
  } catch (error) {
    throw new Error(`解析 ${modelsPath} 失败：${(error as Error).message}`);
  }
  if (!file.providers || typeof file.providers !== "object") {
    throw new Error(`${modelsPath} 缺 providers 表`);
  }
  const credentialsPath = options.credentialsPath ?? join(dirname(modelsPath), "auth.json");
  const available = Object.keys(file.providers);
  const generatedAt = Date.now();
  if (options.providerFilter && !available.includes(options.providerFilter)) {
    return {
      generatedAt,
      configSource: modelsPath,
      providers: [],
      filterError: { filter: options.providerFilter, available },
    };
  }
  const ids = options.providerFilter ? [options.providerFilter] : available;
  const providers = await Promise.all(
    ids.map((id) => queryProvider(id, file.providers[id]!, rolesFor(file, id), options, credentialsPath)),
  );
  return { generatedAt, configSource: modelsPath, providers };
}

// ---------- 纯函数格式化 ----------

export function formatLocalTime(ms: number): string {
  const date = new Date(ms);
  const pad = (value: number) => String(value).padStart(2, "0");
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}`;
}

const STATUS_TEXT: Record<QuotaStatus, string> = {
  ok: "ok",
  unsupported: "unsupported",
  unconfigured: "unconfigured",
  expired: "凭据过期",
  error: "查询失败",
};

function tierText(tier: QuotaTier): string {
  if (tier.name && tier.id) return `${tier.name}(${tier.id})`;
  return tier.name ?? tier.id ?? "";
}

/** 纯函数：结构化报告 → 中文可读文本（时间按本地时区）。 */
export function formatQuotaReport(report: QuotaReport): string {
  const lines: string[] = [];
  lines.push(`provider 额度报告 · ${formatLocalTime(report.generatedAt)}`);
  lines.push(`配置：${report.configSource}`);
  if (report.filterError) {
    lines.push(`未找到 provider「${report.filterError.filter}」，已配置：${report.filterError.available.join(", ")}`);
    return lines.join("\n");
  }
  for (const provider of report.providers) {
    const roles = provider.roles.map((binding) => `${binding.role}: ${binding.model}`).join("、") || "未绑定角色";
    lines.push("");
    lines.push(`[${provider.providerId}] ${STATUS_TEXT[provider.status]} · 角色 ${roles}`);
    if (provider.baseUrl) lines.push(`  端点：${provider.baseUrl}`);
    if (provider.message) lines.push(`  ${provider.message}`);
    if (provider.refreshed) lines.push("  （OAuth 凭据已自动刷新并回写）");
    if (provider.currentTier || provider.paidTier) {
      const parts: string[] = [];
      if (provider.currentTier) parts.push(`current=${tierText(provider.currentTier)}`);
      if (provider.paidTier) parts.push(`paid=${tierText(provider.paidTier)}`);
      lines.push(`  套餐：${parts.join(" ")}`);
    }
    if (provider.projectId) lines.push(`  project：${provider.projectId}`);
    if (provider.plan) lines.push(`  套餐：${provider.plan}`);
    if (provider.accountId) lines.push(`  账号：${provider.accountId}`);
    if (provider.available !== undefined) lines.push(`  余额可用：${provider.available ? "是" : "否"}`);
    for (const bucket of provider.buckets ?? []) {
      const parts: string[] = [];
      if (bucket.remainingPercent !== undefined) parts.push(`剩余 ${bucket.remainingPercent}%`);
      if (bucket.usedPercent !== undefined) parts.push(`已用 ${bucket.usedPercent}%`);
      if (bucket.remaining !== undefined && bucket.total !== undefined) parts.push(`剩余量 ${bucket.remaining}/${bucket.total}`);
      if (bucket.resetAt !== undefined) parts.push(`重置 ${formatLocalTime(bucket.resetAt)}`);
      lines.push(`  ${bucket.label}：${parts.join(" · ")}`);
      if (bucket.models?.length) {
        lines.push(
          bucket.models.length > 6
            ? `    模型（共 ${bucket.models.length} 个）：${bucket.models.slice(0, 6).join(", ")} 等`
            : `    模型：${bucket.models.join(", ")}`,
        );
      }
    }
    for (const balance of provider.balances ?? []) {
      lines.push(`  余额 ${balance.currency}：总 ${balance.totalBalance}（充值 ${balance.toppedUpBalance} / 赠送 ${balance.grantedBalance}）`);
    }
    if (provider.credits !== undefined) lines.push(`  credits：${provider.credits}`);
  }
  return lines.join("\n");
}