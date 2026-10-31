/**
 * 模型配置（仓库里，可审查）+ 凭据（仓库外，不进记录）。
 *
 * 两件事分开：
 *   config/models.json      provider 地址、角色（main / vision / image）、模型清单、兼容值
 *   config/auth.json        只有 key —— gitignore，由 `npm run creds` 写，权限 0600
 *
 * 模型选择只有一个入口：config/models.json 的 models 角色表。没有环境变量、没有启动参数，
 * 鱼自己（read / edit）也能看到并修改；改完用 restart 工具生效。
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
  /**
   * 流式传输方式，只有 main 角色的 provider 这一项生效（进程级设置）：
   * Node 的 WS 不吃 --use-env-proxy，过代理时必须写 "sse"。
   */
  transport?: "sse";
  models: ProviderModelConfig[];
}

export type ModelRole = "main" | "vision" | "image";

export interface RoleRef {
  provider: string;
  model: string;
}

export interface ModelsFile {
  models?: Partial<Record<ModelRole, RoleRef>>;
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

export interface FishModelsSelection {
  /** 主对话模型；必填。 */
  main: FishModelConfig;
  /** 看图 / 看视频的模型；省略时与 main 完全相同。 */
  vision: FishModelConfig;
  /** gpt_image 通道：provider 决定用哪份 oauth，model 是默认模型名；省略 = 该工具不可用。 */
  image?: { provider: string; modelId: string };
  /** 进程级流式传输；取自 main provider 的 transport。 */
  transport?: "sse";
}

export interface LoadOptions {
  /** 默认 ./config/models.json。 */
  modelsPath?: string;
  /** 默认和 models.json 同目录的 auth.json。 */
  credentialsPath?: string;
}

export interface ProviderLoadOptions extends LoadOptions {
  /** 缺省取该 provider 的第一个模型（运维脚本只关心 provider 与凭据）。 */
  modelId?: string;
}

const ROLES: readonly ModelRole[] = ["main", "vision", "image"];

function defaultModelsPath(): string {
  return join(process.cwd(), "config", "models.json");
}

function defaultAuthPath(configSource: string): string {
  return join(dirname(configSource), "auth.json");
}

function readModelsFile(path: string): { file: ModelsFile; configSource: string } {
  const configSource = resolve(path);
  if (!existsSync(configSource)) throw new Error(`找不到模型配置：${configSource}`);
  const file = JSON.parse(readFileSync(configSource, "utf8")) as ModelsFile;
  if (!file || typeof file !== "object") throw new Error("models.json 不是对象");
  if (!file.providers || typeof file.providers !== "object") throw new Error("models.json 缺少 providers");
  return { file, configSource };
}

function roleRef(roles: Partial<Record<ModelRole, RoleRef>>, role: ModelRole): RoleRef {
  const ref = roles[role];
  if (!ref || !ref.provider || !ref.model) throw new Error(`models.${role} 必须同时写 provider 和 model`);
  return ref;
}

/**
 * 读角色表（运行时唯一入口）。
 * 严格：旧 default 键、未知角色、缺失 provider 都直接报错，不做静默默认。
 */
export function loadFishModels(options: LoadOptions = {}): FishModelsSelection {
  const { file, configSource } = readModelsFile(options.modelsPath ?? defaultModelsPath());
  if ("default" in file) {
    throw new Error("config/models.json 的 default 已废弃：改成 models.main / models.vision / models.image");
  }
  const roles = file.models;
  if (!roles || typeof roles !== "object") throw new Error("config/models.json 缺少 models（至少要写 models.main）");
  for (const key of Object.keys(roles)) {
    if (!ROLES.includes(key as ModelRole)) throw new Error(`models 里不认识的角色：${key}`);
  }

  const mainRef = roleRef(roles, "main");
  const credentialsPath = options.credentialsPath ?? defaultAuthPath(configSource);
  const main = buildConfig(file.providers, configSource, credentialsPath, "main", mainRef);

  // vision 省略 = 直接用 main（同一个 provider、同一个模型）
  const visionRef = roles.vision ?? mainRef;
  const vision = visionRef.provider === mainRef.provider && visionRef.model === mainRef.model
    ? main
    : buildConfig(file.providers, configSource, credentialsPath, "vision", visionRef);

  let image: FishModelsSelection["image"];
  if (roles.image) {
    const imageRef = roleRef(roles, "image");
    if (!file.providers[imageRef.provider]) throw new Error(`models.image 的 provider 不在 providers 里：${imageRef.provider}`);
    image = { provider: imageRef.provider, modelId: imageRef.model };
  }

  const transport = file.providers[mainRef.provider]?.transport === "sse" ? ("sse" as const) : undefined;
  return { main, vision, ...(image ? { image } : {}), ...(transport ? { transport } : {}) };
}

/**
 * 按 provider 名读一份配置：只给运维脚本用（creds / login / 测试）。
 * 运行时不要用它选模型——模型选择只走 loadFishModels 的角色表。
 */
export function loadProviderConfig(providerId: string, options: ProviderLoadOptions = {}): FishModelConfig {
  const { file, configSource } = readModelsFile(options.modelsPath ?? defaultModelsPath());
  const provider = file.providers[providerId];
  if (!provider) throw new Error(`models.json 里没有 provider：${providerId}`);
  const modelId = options.modelId ?? provider.models[0]?.id ?? "";
  const credentialsPath = options.credentialsPath ?? defaultAuthPath(configSource);
  return buildConfig(file.providers, configSource, credentialsPath, undefined, { provider: providerId, model: modelId });
}

function buildConfig(
  providers: Record<string, ProviderConfig>,
  configSource: string,
  credentialsPath: string,
  role: ModelRole | undefined,
  ref: RoleRef,
): FishModelConfig {
  const provider = providers[ref.provider];
  if (!provider) {
    const where = role ? `models.${role} 的 provider` : "provider";
    throw new Error(`${where} 不在 providers 里：${ref.provider}`);
  }
  const modelId = ref.model;
  if (!modelId) throw new Error(`${role ? `models.${role}` : ref.provider} 缺少 model`);

  const authMode = provider.auth === "oauth" ? "oauth" : "key";
  const stored = readCredentialFile(credentialsPath, ref.provider);
  const oauth = authMode === "oauth" && stored && stored.type === "oauth" ? stored : undefined;
  const key = authMode === "key" && stored && stored.type === "api_key" ? stored.key : undefined;

  return {
    providerId: ref.provider,
    modelId,
    baseUrl: provider.baseUrl ?? "",
    api: provider.api ?? "openai-completions",
    authMode,
    models: withCompat(provider.models, provider.compat),
    key: key ?? "",
    ...(oauth ? { oauth } : {}),
    keySource: credentialsPath,
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
