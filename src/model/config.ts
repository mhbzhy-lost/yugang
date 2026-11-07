/**
 * 模型配置与凭据都是本机文件（gitignore，不进 git），模板进仓库。
 *
 * 两件事分开：
 *   config/models.json           provider 地址、角色（main / vision / vision_fallback / image）、模型清单、兼容值；
 *                                模板是 config/models.example.json（进仓库），首次使用 cp 一份再改
 *   config/auth.json             只有 key —— gitignore，由 `npm run creds` 写，权限 0600
 *
 * 模型选择只有一个入口：config/models.json 的 models 角色表。没有环境变量、没有启动参数，
 * 鱼自己（read / edit）也能看到并修改；改完用 restart 工具生效。
 */
import { MODELS_CONFIG_PATH } from "../paths.ts";
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
  /** 默认 openai-completions；openai-codex-responses 走 ChatGPT/Codex 的 Responses 接口；google-code-assist 走 Google 订阅的 Code Assist v1internal 通道。 */
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
  /**
   * provider 级代理：配了它就这一个 provider 的全部请求走代理（聊天 / 生图 / token 刷新），
   * 其它 provider 仍直连。codex 记得同时写 transport: "sse"（WS 不吃 fetch 注入）。
   */
  proxy?: string;
  /**
   * OAuth client（google-code-assist 专用）：gemini-cli 的公开 id/secret，但 GitHub push
   * protection 会拦含明文 client 的提交，所以只放本机 config/models.json，模板留空串占位。
   * 两个字段都非空才生效；登录时随凭据落盘，之后刷新从凭据自带字段读。
   */
  oauthClient?: { id?: string; secret?: string };
  models: ProviderModelConfig[];
}

export type ModelRole = "main" | "vision" | "image" | "vision_fallback";

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
  /** provider 级代理；空 = 直连。只影响这个 provider 的域名（含 oauth token 主机）。 */
  proxy?: string;
  /** OAuth client（google-code-assist 用）；来自本机配置，不要打印。 */
  oauthClient?: { id: string; secret: string };
}

export interface FishModelsSelection {
  /** 主对话模型；必填。 */
  main: FishModelConfig;
  /** 看图 / 看视频的模型；省略时与 main 完全相同。 */
  vision: FishModelConfig;
  /** 看图兜底模型：主视觉 failed/filtered 时再试一轮；省略 = 无兜底（不隐式兜底）。 */
  visionFallback?: FishModelConfig;
  /** gpt_image 通道：provider 决定用哪份 oauth，model 是默认模型名；省略 = 该工具不可用。 */
  image?: { provider: string; modelId: string; proxy?: string };
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

const ROLES: readonly ModelRole[] = ["main", "vision", "image", "vision_fallback"];

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
 * 严格：旧 default 键、未知角色、缺失 provider 都直接报错，不做静默默认。
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

  // vision 省略 = 直接用 main（同一个 provider、同一个模型）
  const visionRef = roles.vision ?? mainRef;
  const vision = visionRef.provider === mainRef.provider && visionRef.model === mainRef.model
    ? main
    : buildConfig(file.providers, configSource, credentialsPath, "vision", visionRef);

  // vision_fallback 省略 = 无兜底：look/video 主模型失败后不再换模型重试（不隐式兜底）。
  // 与 main/vision 完全相同时直接复用实例：同一个模型兜底没有意义，也避免重复挂 provider。
  let visionFallback: FishModelConfig | undefined;
  if (roles.vision_fallback) {
    const fallbackRef = roleRef(roles, "vision_fallback");
    visionFallback = fallbackRef.provider === mainRef.provider && fallbackRef.model === mainRef.model
      ? main
      : fallbackRef.provider === visionRef.provider && fallbackRef.model === visionRef.model
        ? vision
        : buildConfig(file.providers, configSource, credentialsPath, "vision_fallback", fallbackRef);
  }

  let image: FishModelsSelection["image"];
  if (roles.image) {
    const imageRef = roleRef(roles, "image");
    const imageProvider = file.providers[imageRef.provider];
    if (!imageProvider) throw new Error(`models.image 的 provider 不在 providers 里：${imageRef.provider}`);
    image = { provider: imageRef.provider, modelId: imageRef.model, ...(imageProvider.proxy ? { proxy: imageProvider.proxy } : {}) };
  }

  // 过代理 + codex：WS 不吃 fetch 注入，强制 SSE；provider 自己写了 transport 的照旧尊重
  const mainProvider = file.providers[mainRef.provider];
  const transport = mainProvider?.transport === "sse" || (Boolean(mainProvider?.proxy) && mainProvider?.api === "openai-codex-responses")
    ? ("sse" as const)
    : undefined;
  return { main, vision, ...(visionFallback ? { visionFallback } : {}), ...(image ? { image } : {}), ...(transport ? { transport } : {}) };
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

  // id/secret 都非空字符串才透传，缺一半按没配处理（不报错：非 google-code-assist 的
  // provider 用不到它，不该被启动校验拦住）
  const oc = provider.oauthClient;
  const oauthClient =
    oc && typeof oc.id === "string" && oc.id && typeof oc.secret === "string" && oc.secret
      ? { id: oc.id, secret: oc.secret }
      : undefined;

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
    ...(provider.proxy ? { proxy: provider.proxy } : {}),
    ...(oauthClient ? { oauthClient } : {}),
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
