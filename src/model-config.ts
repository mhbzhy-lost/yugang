/**
 * 模型与凭据。
 *
 * 配置直接从 ~/pi-config 抄：models.json 里的 provider 条目 + auth.json 里的 key。
 * 这样鱼和 pi 用同一份模型配置，不用把这个网关的地址抄进仓库。
 *
 * 凭据只在内存里，进不了 prompt、进不了 transcript、也不打印。
 * 想知道用的是哪个 key，看 keySource 和长度，看不到内容。
 */
import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";

export interface ProviderModelConfig {
  id: string;
  name?: string;
  reasoning?: boolean;
  input?: ("text" | "image")[];
  cost?: { input: number; output: number; cacheRead: number; cacheWrite: number };
  contextWindow?: number;
  maxTokens?: number;
  compat?: Record<string, unknown>;
}

/**
 * 网关兼容性默认值。qoder 网关不接受 max_completion_tokens，只认 max_tokens。
 * 每个模型自己的 compat 会覆盖这里。
 */
const DEFAULT_COMPAT: Record<string, unknown> = { maxTokensField: "max_tokens" };

export interface FishModelConfig {
  providerId: string;
  modelId: string;
  baseUrl: string;
  models: ProviderModelConfig[];
  /** 只在内存里用；不要打印、不要写文件、不要进 prompt。 */
  key: string;
  keySource: string;
}

export interface LoadOptions {
  /** pi 的配置目录，默认 ~/pi-config/pi。 */
  piConfigDir?: string;
  /** 覆盖用：{ provider, modelId, baseUrl, key }。 */
  override?: string;
  providerId?: string;
  modelId?: string;
}

export function loadModelConfig(options: LoadOptions = {}): FishModelConfig {
  const overridePath = options.override ?? process.env.YUGANG_CREDENTIALS;

  // 1. 显式覆盖文件优先（lib 里可以放自建网关）
  if (overridePath && existsSync(overridePath)) {
    const raw = JSON.parse(readFileSync(resolve(overridePath), "utf8")) as Partial<FishModelConfig>;
    if (!raw.key) throw new Error("credentials 文件缺少 key");
    return {
      providerId: raw.providerId ?? options.providerId ?? "fish",
      modelId: raw.modelId ?? options.modelId ?? "default",
      baseUrl: raw.baseUrl ?? "",
      models: withCompat(raw.models ?? [{ id: raw.modelId ?? "default" }]),
      key: raw.key,
      keySource: overridePath,
    };
  }

  const dir = resolve(options.piConfigDir ?? process.env.PI_CONFIG_DIR ?? join(homedir(), "pi-config", "pi"));
  const providerId = options.providerId ?? process.env.MODEL_PROVIDER ?? "qoder-pool";
  const modelId = options.modelId ?? process.env.MODEL_ID ?? "DeepSeek-Flash";

  const modelsFile = join(dir, "models.json");
  const authFile = join(dir, "auth.json");
  if (!existsSync(modelsFile)) throw new Error(`找不到 ${modelsFile}`);
  if (!existsSync(authFile)) throw new Error(`找不到 ${authFile}`);

  const models = JSON.parse(readFileSync(modelsFile, "utf8")) as {
    providers?: Record<string, { baseUrl?: string; models?: ProviderModelConfig[] }>;
  };
  const provider = models.providers?.[providerId];
  if (!provider) throw new Error(`models.json 里没有 provider：${providerId}`);

  const auth = JSON.parse(readFileSync(authFile, "utf8")) as Record<string, { key?: string }>;
  const key = process.env.MODEL_API_KEY ?? auth[providerId]?.key;

  return {
    providerId,
    modelId,
    baseUrl: provider.baseUrl ?? "",
    models: withCompat(provider.models ?? [{ id: modelId }]),
    key: key ?? "",
    keySource: process.env.MODEL_API_KEY ? "MODEL_API_KEY" : authFile,
  };
}

function withCompat(models: ProviderModelConfig[]): ProviderModelConfig[] {
  return models.map((model) => ({ ...model, compat: { ...DEFAULT_COMPAT, ...model.compat } }));
}

/** 打印用：不含任何 key 内容。 */
export function describeModel(config: FishModelConfig): Record<string, string | number> {
  return {
    provider: config.providerId,
    model: config.modelId,
    baseUrl: config.baseUrl || "(provider 默认)",
    key: config.key ? `已加载 / ${config.key.length} 字符` : "缺失",
    keySource: config.keySource,
    models: config.models.map((m) => m.id).join(", "),
  };
}
