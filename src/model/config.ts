/**
 * 模型配置与凭据都是本机文件（gitignore，不进 git），模板进仓库。
 *
 * 两件事分开：
 *   config/models.json           provider 地址、角色（main / vision / vision_fallback / image）、模型清单、兼容值；
 *                                模板是 config/models.example.json（进仓库），首次使用 cp 一份再改
 *   config/auth.json             只有 API key —— gitignore，由 `npm run creds` 写，权限 0600
 *
 * 模型选择只有一个入口：config/models.json 的 models 角色表。没有环境变量、没有启动参数，
 * 鱼自己（read / config）也能看到并修改；改完用 restart 工具生效。
 */
import { MODELS_CONFIG_PATH } from "../paths.ts";
import { existsSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";

export type SupportedProviderApi =
  | "openai-completions"
  | "openai-responses"
  | "anthropic-messages"
  | "google-generative-ai";

export const SUPPORTED_PROVIDER_APIS: readonly SupportedProviderApi[] = Object.freeze([
  "openai-completions",
  "openai-responses",
  "anthropic-messages",
  "google-generative-ai",
]);

export const DEFAULT_BASE_URLS: Readonly<Record<SupportedProviderApi, string>> = Object.freeze({
  "openai-completions": "https://api.openai.com/v1",
  "openai-responses": "https://api.openai.com/v1",
  "anthropic-messages": "https://api.anthropic.com",
  "google-generative-ai": "https://generativelanguage.googleapis.com/v1beta",
});

export function isSupportedProviderApi(value: unknown): value is SupportedProviderApi {
  return typeof value === "string" && (SUPPORTED_PROVIDER_APIS as readonly string[]).includes(value);
}

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
  /** 标准协议：openai-completions（默认）/ openai-responses / anthropic-messages / google-generative-ai。 */
  api?: string;
  baseUrl?: string;
  compat?: Record<string, unknown>;
  /** provider 级代理：配了它就这一个 provider 的全部请求走代理，其它 provider 仍直连。 */
  proxy?: string;
  models: ProviderModelConfig[];
}

export type ModelRole = "main" | "vision" | "image" | "wan_image" | "vision_fallback";

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
  /** provider 的标准 api 形状。 */
  api: SupportedProviderApi;
  models: ProviderModelConfig[];
  /** 只在内存里用；不要打印、不要写文件、不要进 prompt。 */
  key: string;
  keySource: string;
  /** 配置文件本身的位置，方便排查。 */
  configSource: string;
  /** 凭据文件（config/auth.json）位置：qwen-tts 与 searchKey 等附属模块同源读取。 */
  credentialsPath: string;
  /** provider 级代理；空 = 直连。只影响这个 provider 的域名。 */
  proxy?: string;
}

/** 与 fish-config 的 ThinkingLevel 结构一致（就地声明避开循环 import）。 */
export type ResolvedThinking = "off" | "minimal" | "low" | "medium" | "high" | "xhigh" | "max";

/** 从低到高的候选顺序：true 取第一个可用的。 */
const THINKING_ASC: readonly ResolvedThinking[] = ["minimal", "low", "medium", "high", "xhigh", "max"];

function modelEntry(config: FishModelConfig): ProviderModelConfig | undefined {
  return config.models.find((m) => m.id === config.modelId);
}

/**
 * 思考两态 → 具体档位。provider 差异全部交给模型自带的 thinkingLevelMap。
 *
 *   false → "off"（发什么字段由 SDK 按 thinkingFormat / 协议决定）
 *   true  → 该模型 thinkingLevelMap 里**最低的非 null 档**；没配映射时回落 low
 */
export function resolveThinking(thinking: boolean, config: FishModelConfig): ResolvedThinking {
  if (!thinking) return "off";
  const map = modelEntry(config)?.thinkingLevelMap;
  if (map) {
    for (const level of THINKING_ASC) {
      if (typeof map[level] === "string") return level;
    }
  }
  return "low";
}

/**
 * thinking=false 时该模型能不能真关思考；不能则返回告警文案。
 */
export function thinkingOffWarning(config: FishModelConfig): string | undefined {
  const md = modelEntry(config);
  if (!md?.reasoning) return undefined;
  const label = `${config.providerId}/${config.modelId}`;
  const off = md.thinkingLevelMap?.["off"];

  if (config.api !== "openai-completions") {
    return off === null ? `${label} 声明不支持关思考（thinkingLevelMap.off=null），thinking=false 对它无效` : undefined;
  }

  const compat = md.compat ?? {};
  const fmt = compat["thinkingFormat"];
  const offText = JSON.stringify(off) ?? "缺失";

  if (fmt === "zai" || fmt === "qwen" || fmt === "qwen-chat-template" || fmt === "together") return undefined;
  if (fmt === "deepseek" || fmt === "openrouter" || fmt === "string-thinking") {
    return off === null ? `${label} 声明不支持关思考（thinkingLevelMap.off=null），thinking=false 对它无效` : undefined;
  }
  if (fmt === "ant-ling") return `${label} 的 ant-ling 通道 off 时不发字段，thinking=false 关不掉`;
  if (fmt === "chat-template") return undefined;

  if (compat["supportsReasoningEffort"] !== true) {
    return `${label} 未声明 supportsReasoningEffort，off 无字段可发；能不能关取决于服务端默认`;
  }
  if (typeof off !== "string") {
    return `${label} 的 thinkingLevelMap.off 不是字符串（当前 ${offText}），SDK 将不发 reasoning_effort，` +
      `服务端按默认档跑——thinking=false 实际关不掉，请把 off 映射成该 API 接受的关闭值`;
  }
  return undefined;
}

export interface FishModelsSelection {
  /** 主对话模型；必填。 */
  main: FishModelConfig;
  /** 看图 / 看视频的模型；省略时与 main 完全相同。 */
  vision: FishModelConfig;
  /** 看图兜底模型：主视觉 failed/filtered 时再试一轮；省略 = 无兜底（不隐式兜底）。 */
  visionFallback?: FishModelConfig;
  /**
   * 远程生图角色（兼容保留，2026-11-25 起运行时不再消费）：画图模型与通道已收归 fish.config.json 的 drawRemote 热配置，
   * draw_remote 按 drawRemote.provider 直接读 providers 里的端点与代理。保留解析只为旧 models.json 不拒启、ping 仍可展示。
   */
  image?: { provider: string; modelId: string; proxy?: string };
  /** 百炼 Token Plan Wan 通道（models.wan_image）：wan_gif（视频转 GIF）消费；省略 = wan_gif 不可用。 */
  wanImage?: { provider: string; modelId: string; apiKey: string; baseUrl: string; proxy?: string };
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

const ROLES: readonly ModelRole[] = ["main", "vision", "image", "wan_image", "vision_fallback"];

function defaultModelsPath(): string {
  return MODELS_CONFIG_PATH;
}

function defaultAuthPath(configSource: string): string {
  return join(dirname(configSource), "auth.json");
}

function readModelsFile(path: string): { file: ModelsFile; configSource: string } {
  const configSource = resolve(path);
  if (!existsSync(configSource)) {
    throw new Error(`找不到模型配置：${configSource}（先 cp 一份 config/models.example.json）`);
  }
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
 * 严格：旧 default 键、未知角色、缺失 provider、退役 auth/api 都直接报错，不做静默默认。
 */
export function loadFishModels(options: LoadOptions = {}): FishModelsSelection {
  const { file, configSource } = readModelsFile(options.modelsPath ?? defaultModelsPath());
  if ("default" in file) {
    throw new Error("config/models.json 的 default 已废弃：改成 models.main（可选 models.vision / models.vision_fallback / models.image）");
  }
  const roles = file.models;
  if (!roles || typeof roles !== "object") throw new Error("config/models.json 缺少 models（至少要写 models.main）");
  for (const key of Object.keys(roles)) {
    if (!ROLES.includes(key as ModelRole)) throw new Error(`models 里不认识的角色：${key}`);
  }

  const mainRef = roleRef(roles, "main");
  const credentialsPath = options.credentialsPath ?? defaultAuthPath(configSource);
  const main = buildConfig(file.providers, configSource, credentialsPath, "main", mainRef);

  const visionRef = roles.vision ?? mainRef;
  const vision = visionRef.provider === mainRef.provider && visionRef.model === mainRef.model
    ? main
    : buildConfig(file.providers, configSource, credentialsPath, "vision", visionRef);

  let visionFallback: FishModelConfig | undefined;
  if (roles.vision_fallback) {
    const fallbackRef = roleRef(roles, "vision_fallback");
    visionFallback = fallbackRef.provider === mainRef.provider && fallbackRef.model === mainRef.model
      ? main
      : fallbackRef.provider === visionRef.provider && fallbackRef.model === visionRef.model
        ? vision
        : buildConfig(file.providers, configSource, credentialsPath, "vision_fallback", fallbackRef);
  }

  let wanImage: FishModelsSelection["wanImage"];
  if (roles.wan_image) {
    const wanRef = roleRef(roles, "wan_image");
    const wanProvider = file.providers[wanRef.provider];
    if (!wanProvider) throw new Error(`models.wan_image 的 provider 不在 providers 里：${wanRef.provider}`);
    const wanStored = readCredentialFile(credentialsPath, wanRef.provider);
    const wanKey = wanStored?.type === "api_key" ? wanStored.key : undefined;
    if (!wanKey) throw new Error(`models.wan_image 没有可用 API key：${credentialsPath}`);
    const baseUrl = (wanProvider.baseUrl ?? "").replace(/\/compatible-mode\/v1\/?$/, "");
    wanImage = { provider: wanRef.provider, modelId: wanRef.model, apiKey: wanKey, baseUrl, ...(wanProvider.proxy ? { proxy: wanProvider.proxy } : {}) };
  }

  let image: FishModelsSelection["image"];
  if (roles.image) {
    const imageRef = roleRef(roles, "image");
    const imageProvider = file.providers[imageRef.provider];
    if (!imageProvider) throw new Error(`models.image 的 provider 不在 providers 里：${imageRef.provider}`);
    image = { provider: imageRef.provider, modelId: imageRef.model, ...(imageProvider.proxy ? { proxy: imageProvider.proxy } : {}) };
  }

  return { main, vision, ...(visionFallback ? { visionFallback } : {}), ...(image ? { image } : {}), ...(wanImage ? { wanImage } : {}) };
}

/**
 * 按 provider 名读一份配置：给运维脚本与 models_probe 的真实连通性探测用。
 * 不要用它替代运行时的角色选择——正常对话只走 loadFishModels 的角色表。
 */
export function loadProviderConfig(providerId: string, options: ProviderLoadOptions = {}): FishModelConfig {
  const { file, configSource } = readModelsFile(options.modelsPath ?? defaultModelsPath());
  const provider = file.providers[providerId];
  if (!provider) throw new Error(`models.json 里没有 provider：${providerId}`);
  if (!Array.isArray(provider.models)) {
    throw new Error(`models.json 的 provider「${providerId}」缺少 models 数组`);
  }
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

  if ((provider as { auth?: unknown }).auth === "oauth") {
    throw new Error(`provider「${ref.provider}」的 auth: "oauth" 已退役，请改用 CLIProxyAPI + API key`);
  }
  const rawApi = provider.api ?? "openai-completions";
  if (!isSupportedProviderApi(rawApi)) {
    throw new Error(
      `provider「${ref.provider}」使用了不支持的 api「${rawApi}」（支持 ${SUPPORTED_PROVIDER_APIS.join(" / ")}；旧 OAuth 通道请改走 CLIProxyAPI）`,
    );
  }

  const stored = readCredentialFile(credentialsPath, ref.provider);
  const key = stored?.type === "api_key" ? stored.key : undefined;

  return {
    providerId: ref.provider,
    modelId,
    baseUrl: provider.baseUrl ?? "",
    api: rawApi,
    models: withCompat(provider.models, rawApi, provider.compat),
    key: key ?? "",
    keySource: credentialsPath,
    configSource,
    credentialsPath,
    ...(provider.proxy ? { proxy: provider.proxy } : {}),
  };
}

export type StoredCredential = { type: "api_key"; key: string };

/** auth.json 的一个 provider 条目：仅认非空字符串或 `{ key }`，残留 `{ type: "oauth" }` 忽略返回 undefined。 */
export function readCredentialFile(path: string, providerId: string): StoredCredential | undefined {
  if (!existsSync(path)) return undefined;
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(path, "utf8"));
  } catch {
    throw new Error(`凭据文件 JSON 损坏（${path}）`);
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return undefined;
  const entry = (parsed as Record<string, unknown>)[providerId];
  if (typeof entry === "string") {
    return entry.trim() ? { type: "api_key", key: entry } : undefined;
  }
  if (!entry || typeof entry !== "object" || Array.isArray(entry)) return undefined;
  const rec = entry as Record<string, unknown>;
  if (rec["type"] === "oauth") return undefined;
  if (typeof rec["key"] === "string" && rec["key"].trim()) {
    return { type: "api_key", key: rec["key"] };
  }
  return undefined;
}

/** provider 级 compat 兜底：仅 openai-completions 注入默认 maxTokensField，其余协议只合并显式声明项。 */
function withCompat(
  models: ProviderModelConfig[],
  api: SupportedProviderApi,
  providerCompat?: Record<string, unknown>,
): ProviderModelConfig[] {
  if (api === "openai-completions") {
    const base = { maxTokensField: "max_tokens", ...(providerCompat ?? {}) };
    return models.map((model) => ({ ...model, compat: { ...base, ...model.compat } }));
  }
  return models.map((model) => {
    if (!providerCompat && !model.compat) return { ...model };
    return { ...model, compat: { ...(providerCompat ?? {}), ...(model.compat ?? {}) } };
  });
}

/** 打印用：不含任何 key 内容。 */
export function describeModel(config: FishModelConfig): Record<string, string | number> {
  return {
    provider: config.providerId,
    model: config.modelId,
    baseUrl: config.baseUrl || DEFAULT_BASE_URLS[config.api],
    key: config.key ? `已加载 / ${config.key.length} 字符` : "缺失",
    api: config.api,
    keySource: config.keySource,
    models: config.models.map((m) => m.id).join(", "),
    config: config.configSource,
  };
}
