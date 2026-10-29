/**
 * 模型配置（仓库里，可审查）+ 凭据（仓库外，不进记录）。
 *
 * 两件事分开：
 *   config/models.json      provider 地址、模型清单、兼容值 —— 跟着代码走，能 diff 能 review
 *   config/auth.json        只有 key —— gitignore，由 `npm run creds` 写，权限 0600
 *
 * 这样仓库自洽：不依赖 ~/pi-config 存在，换机器也能跑（重新导一次凭据即可）。
 */
import { existsSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";

export interface ProviderModelConfig {
  id: string;
  name?: string;
  reasoning?: boolean;
  input?: ("text" | "image")[];
  cost?: { input: number; output: number; cacheRead: number; cacheWrite: number };
  contextWindow?: number;
  maxTokens?: number;
  compat?: Record<string, unknown>;
  samplingParams?: Record<string, unknown>;
  thinkingLevelMap?: Record<string, unknown>;
}

export interface ProviderConfig {
  /** 默认 openai-completions；openai-codex-responses 走 ChatGPT/Codex 的 Responses 接口。 */
  api?: string;
  baseUrl?: string;
  compat?: Record<string, unknown>;
  /** key（默认，一把 API key）或 oauth（订阅登录，凭据是一整块 token）。 */
  auth?: "key" | "oauth";
  models: ProviderModelConfig[];
}

export interface ModelsFile {
  default?: { provider?: string; model?: string };
  providers: Record<string, ProviderConfig>;
}

export interface FishModelConfig {
  providerId: string;
  modelId: string;
  baseUrl: string;
  /** provider 的 api 形状；空 = openai-completions。 */
  api: string;
  authMode: "key" | "oauth";
  models: ProviderModelConfig[];
  /** 只在内存里用；不要打印、不要写文件、不要进 prompt。oauth 下为空。 */
  key: string;
  /** oauth 凭据（整块 token）；有没有值只在内存里判断，不打印内容。 */
  oauth?: { refresh: string; access: string; expires: number; [key: string]: unknown };
  keySource: string;
  /** 配置文件本身的位置，方便排查。 */
  configSource: string;
  /** 凭据文件位置：oauth 刷新后要写回这里。 */
  credentialsPath: string;
}

export interface LoadOptions {
  /** 默认 ./config/models.json。 */
  modelsPath?: string;
  /** 默认和 models.json 同目录的 auth.json。 */
  credentialsPath?: string;
  providerId?: string;
  modelId?: string;
}

function defaultAuthPath(configSource: string): string {
  return join(dirname(configSource), "auth.json");
}

export function loadModelConfig(options: LoadOptions = {}): FishModelConfig {
  const configSource = resolve(options.modelsPath ?? process.env.YUGANG_MODELS ?? join(process.cwd(), "config", "models.json"));
  if (!existsSync(configSource)) throw new Error(`找不到模型配置：${configSource}`);

  const file = JSON.parse(readFileSync(configSource, "utf8")) as ModelsFile;
  const providerId = options.providerId ?? process.env.MODEL_PROVIDER ?? file.default?.provider;
  const modelId = options.modelId ?? process.env.MODEL_ID ?? file.default?.model;
  if (!providerId || !modelId) throw new Error("models.json 里没写 default.provider / default.model");

  const provider = file.providers[providerId];
  if (!provider) throw new Error(`models.json 里没有 provider：${providerId}`);

  const credentialsPath = options.credentialsPath ?? defaultAuthPath(configSource);
  const override = process.env.MODEL_API_KEY;
  const authMode = provider.auth === "oauth" ? "oauth" : "key";
  const stored = readCredentialFile(credentialsPath, providerId);
  const oauth = authMode === "oauth" && stored && stored.type === "oauth" ? stored : undefined;
  const key = authMode === "key" ? (override ?? (stored && stored.type === "api_key" ? stored.key : undefined)) : undefined;

  return {
    providerId,
    modelId,
    baseUrl: provider.baseUrl ?? "",
    api: provider.api ?? "openai-completions",
    authMode,
    models: withCompat(provider.models, provider.compat),
    key: key ?? "",
    ...(oauth ? { oauth } : {}),
    keySource: override ? "MODEL_API_KEY" : credentialsPath,
    configSource,
    credentialsPath,
  };
}

type StoredCredential =
  | { type: "api_key"; key?: string }
  | { type: "oauth"; refresh: string; access: string; expires: number; [key: string]: unknown };

/** auth.json 的一个 provider 条目：字符串/`{key}` 当 api_key，`{type:"oauth"}` 当订阅凭据。 */
export function readCredentialFile(path: string, providerId: string): StoredCredential | undefined {
  if (!existsSync(path)) return undefined;
  const parsed = JSON.parse(readFileSync(path, "utf8")) as Record<string, unknown>;
  const entry = parsed[providerId];
  if (typeof entry === "string") return { type: "api_key", key: entry };
  if (!entry || typeof entry !== "object") return undefined;
  const rec = entry as Record<string, unknown>;
  if (rec["type"] === "oauth" && typeof rec["refresh"] === "string" && typeof rec["access"] === "string") {
    return rec as StoredCredential;
  }
  if (typeof rec["key"] === "string") return { type: "api_key", key: rec["key"] };
  return undefined;
}

/** provider 级 compat 兜底，模型自带的覆盖它。 */
function withCompat(models: ProviderModelConfig[], providerCompat: Record<string, unknown> = {}): ProviderModelConfig[] {
  const base = { maxTokensField: "max_tokens", ...providerCompat };
  return models.map((model) => ({ ...model, compat: { ...base, ...model.compat } }));
}

/** 打印用：不含任何 key 内容。 */
export function describeModel(config: FishModelConfig): Record<string, string | number> {
  return {
    provider: config.providerId,
    model: config.modelId,
    baseUrl: config.baseUrl || "(provider 默认)",
    key:
      config.authMode === "oauth"
        ? config.oauth
          ? `oauth 已登录 / 有效期至 ${new Date(config.oauth.expires).toISOString()}`
          : "oauth 未登录"
        : config.key
          ? `已加载 / ${config.key.length} 字符`
          : "缺失",
    api: config.api,
    auth: config.authMode,
    keySource: config.keySource,
    models: config.models.map((m) => m.id).join(", "),
    config: config.configSource,
  };
}
