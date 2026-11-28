/**
 * provider 额度/余额查询（运维侧，scripts/quota.ts 消费；不进鱼的工具面）。
 *
 * 支持两类公开 API key 查询：DeepSeek（/user/balance 余额）、ZAI Coding Plan
 * （/api/monitor/usage/quota/limit）。订阅制渠道（含 CLIProxyAPI 代理的 Codex / Claude / Gemini）
 * 及无公开额度接口的 provider 统一标 unsupported，缺有效 API key 标 unconfigured。
 *
 * 安全边界：
 * - 全部请求遵循 provider.proxy（createProxyFetch，非法/未配回落直连）；
 * - 报告与错误文案一律经 redactSecrets 脱敏，结构化结果不含任何 key/token。
 */

import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { MODELS_CONFIG_PATH } from "../paths.ts";
import { readCredentialFile, type ModelRole, type ModelsFile, type ProviderConfig } from "./config.ts";
import { createProxyFetch } from "../media/proxy-fetch.ts";

export type QuotaStatus = "ok" | "unsupported" | "unconfigured" | "error";
export type QuotaKind = "deepseek" | "zai";

export interface QuotaRoleBinding {
  role: ModelRole;
  model: string;
}

export interface QuotaBucket {
  label: string;
  remainingPercent?: number;
  usedPercent?: number;
  remaining?: number;
  total?: number;
  /** 重置时间，ms epoch。 */
  resetAt?: number;
}

export interface QuotaBalance {
  currency: string;
  totalBalance: string;
  grantedBalance: string;
  toppedUpBalance: string;
}

export interface QuotaProviderReport {
  providerId: string;
  api?: string;
  baseUrl?: string;
  kind?: QuotaKind;
  status: QuotaStatus;
  roles: QuotaRoleBinding[];
  /** zai data.level。 */
  plan?: string;
  available?: boolean;
  buckets?: QuotaBucket[];
  balances?: QuotaBalance[];
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
  fetchImpl?: typeof fetch;
}

const ROLE_ORDER: ModelRole[] = ["main", "vision", "image", "wan_image", "vision_fallback"];
const QUOTA_REQUEST_TIMEOUT_MS = 15_000;
const UNCONFIGURED_API_KEY_MESSAGE = "未配置 API key（config/auth.json 缺该 provider 的有效 key）";
const UNSUPPORTED_MESSAGE = "暂无公开额度查询接口（订阅制渠道请在 CLIProxyAPI 侧查看）";

function withQuotaTimeout(fetchImpl: typeof fetch): typeof fetch {
  return (input, init) => {
    const timeout = AbortSignal.timeout(QUOTA_REQUEST_TIMEOUT_MS);
    const signal = init?.signal ? AbortSignal.any([init.signal, timeout]) : timeout;
    return fetchImpl(input, { ...init, signal });
  };
}

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
  const base = provider.baseUrl ?? "";
  const host = hostOf(base);
  if (providerId === "deepseek" || host === "api.deepseek.com") return "deepseek";
  if (providerId === "zai-coding-cn" || (host === "open.bigmodel.cn" && base.includes("/coding/"))) return "zai";
  return undefined;
}

/** 收集本 provider 已知的秘密字面量，用于错误文案脱敏（这些值永不进报告）。 */
function collectSecrets(key: string | undefined): string[] {
  return key && key.length >= 4 ? [key] : [];
}

/** 抹除已知秘密字面量 + 通用 Bearer/sk- 与 JSON 引号键名形态，错误文案才能安全出境。 */
export function redactSecrets(text: string, secrets: string[]): string {
  let out = text;
  for (const secret of secrets) {
    if (secret && secret.length >= 4) out = out.split(secret).join("***");
  }
  out = out.replace(/Bearer\s+[A-Za-z0-9._~+/=-]+/gi, "Bearer ***");
  out = out.replace(/\bsk-[A-Za-z0-9_-]{6,}/g, "***");
  out = out.replace(
    /(\\"|")((?:api[_-]?key|access[_-]?token|refresh[_-]?token|client[_-]?secret))\1\s*:\s*\1(?:\\.|[^"\\])*\1/gi,
    "$1$2$1: $1***$1",
  );
  out = out.replace(/((?:api[_-]?key|access[_-]?token|refresh[_-]?token|client[_-]?secret)\s*[:=]\s*)[^\s,;"]+/gi, "$1***");
  return out;
}

function sanitizeError(error: unknown, secrets: string[]): string {
  const text = error instanceof Error ? error.message : String(error);
  return redactSecrets(text, secrets).slice(0, 300);
}

async function errorIfNotOk(response: Response, label: string): Promise<void> {
  if (response.ok) return;
  const text = await response.text().catch(() => "");
  throw new HttpStatusError(response.status, `${label} 失败 (${response.status}): ${text.slice(0, 200)}`);
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
  if (!kind) {
    return { ...base, status: "unsupported", message: UNSUPPORTED_MESSAGE };
  }
  base.kind = kind;

  const proxyFetch = provider.proxy ? createProxyFetch(provider.proxy) : undefined;
  const fetchImpl = withQuotaTimeout(options.fetchImpl ?? proxyFetch ?? fetch);
  const secrets: string[] = [];
  try {
    const credential = readCredentialFile(credentialsPath, providerId);
    const key = credential?.type === "api_key" && typeof credential.key === "string" ? credential.key.trim() : "";
    secrets.push(...collectSecrets(key));
    if (!key) {
      return { ...base, status: "unconfigured", message: UNCONFIGURED_API_KEY_MESSAGE };
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
  error: "查询失败",
};

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
    if (provider.plan) lines.push(`  套餐：${provider.plan}`);
    if (provider.available !== undefined) lines.push(`  余额可用：${provider.available ? "是" : "否"}`);
    for (const bucket of provider.buckets ?? []) {
      const parts: string[] = [];
      if (bucket.remainingPercent !== undefined) parts.push(`剩余 ${bucket.remainingPercent}%`);
      if (bucket.usedPercent !== undefined) parts.push(`已用 ${bucket.usedPercent}%`);
      if (bucket.remaining !== undefined && bucket.total !== undefined) parts.push(`剩余量 ${bucket.remaining}/${bucket.total}`);
      if (bucket.resetAt !== undefined) parts.push(`重置 ${formatLocalTime(bucket.resetAt)}`);
      lines.push(`  ${bucket.label}：${parts.join(" · ")}`);
    }
    for (const balance of provider.balances ?? []) {
      lines.push(`  余额 ${balance.currency}：总 ${balance.totalBalance}（充值 ${balance.toppedUpBalance} / 赠送 ${balance.grantedBalance}）`);
    }
  }
  return lines.join("\n");
}
