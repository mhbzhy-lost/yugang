/**
 * 模型配置（仓库里，可审查）+ 凭据（仓库外，不进记录）。
 *
 * 两件事分开：
 *   config/models.json      provider 地址、模型清单、兼容值 —— 跟着代码走，能 diff 能 review
 *   var/credentials.json    只有 key —— gitignore，由 `npm run creds` 写，权限 0600
 *
 * 这样仓库自洽：不依赖 ~/pi-config 存在，换机器也能跑（重新导一次凭据即可）。
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
  samplingParams?: Record<string, unknown>;
  thinkingLevelMap?: Record<string, unknown>;
}

export interface ProviderConfig {
  api?: string;
  baseUrl?: string;
  compat?: Record<string, unknown>;
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
  models: ProviderModelConfig[];
  /** 只在内存里用；不要打印、不要写文件、不要进 prompt。 */
  key: string;
  keySource: string;
  /** 配置文件本身的位置，方便排查。 */
  configSource: string;
}

export interface LoadOptions {
  /** 默认 ./config/models.json。 */
  modelsPath?: string;
  /** 默认 $YUGANG_HOME/credentials.json。 */
  credentialsPath?: string;
  providerId?: string;
  modelId?: string;
}

function varDir(): string {
  return process.env.YUGANG_HOME ?? join(homedir(), "鱼缸", "var");
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

  const credentialsPath = options.credentialsPath ?? join(varDir(), "credentials.json");
  const override = process.env.MODEL_API_KEY;
  const key = override ?? readKeyFile(credentialsPath, providerId);

  return {
    providerId,
    modelId,
    baseUrl: provider.baseUrl ?? "",
    models: withCompat(provider.models, provider.compat),
    key: key ?? "",
    keySource: override ? "MODEL_API_KEY" : credentialsPath,
    configSource,
  };
}

function readKeyFile(path: string, providerId: string): string | undefined {
  if (!existsSync(path)) return undefined;
  const parsed = JSON.parse(readFileSync(path, "utf8")) as Record<string, { key?: string } | string>;
  const entry = parsed[providerId];
  return typeof entry === "string" ? entry : entry?.key;
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
    key: config.key ? `已加载 / ${config.key.length} 字符` : "缺失",
    keySource: config.keySource,
    models: config.models.map((m) => m.id).join(", "),
    config: config.configSource,
  };
}
