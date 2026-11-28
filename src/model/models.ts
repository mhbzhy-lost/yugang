/**
 * 把 model-config 里的 provider 条目变成一个 pi-ai Models。
 *
 * 仅接入 @earendil-works/pi-ai 原生四大标准协议（openai-completions / openai-responses /
 * anthropic-messages / google-generative-ai），静态 API key 经闭包注入，不写 process.env。
 */
import { createModels, createProvider, type Models } from "@earendil-works/pi-ai/models";
import { openAICompletionsApi } from "@earendil-works/pi-ai/api/openai-completions.lazy";
import { openAIResponsesApi } from "@earendil-works/pi-ai/api/openai-responses.lazy";
import { anthropicMessagesApi } from "@earendil-works/pi-ai/api/anthropic-messages.lazy";
import { googleGenerativeAIApi } from "@earendil-works/pi-ai/api/google-generative-ai.lazy";
import { createProxyFetch, registerScopedProxy } from "../media/proxy-fetch.ts";
import {
  DEFAULT_BASE_URLS,
  isSupportedProviderApi,
  SUPPORTED_PROVIDER_APIS,
  type FishModelConfig,
  type SupportedProviderApi,
} from "./config.ts";

export interface BuildFishModelsOptions {
  /** 是否将 provider.proxy 写入全局 scopedProxies 表（默认 true；探活路径传 false 以避免污染全局表）。 */
  registerGlobalProxy?: boolean;
}

/** 把一份 provider 配置挂到已有的 Models 上（主模型与视觉模型可能是不同 provider）。 */
export function addFishProvider(models: Models, config: FishModelConfig, options: BuildFishModelsOptions = {}): Models {
  models.setProvider(buildProvider(config, options));
  return models;
}

export function createFishModels(config: FishModelConfig, options: BuildFishModelsOptions = {}): Models {
  const models = createModels();
  models.setProvider(buildProvider(config, options));
  return models;
}

function adapterFor(api: SupportedProviderApi) {
  switch (api) {
    case "openai-completions": return openAICompletionsApi();
    case "openai-responses": return openAIResponsesApi();
    case "anthropic-messages": return anthropicMessagesApi();
    case "google-generative-ai": return googleGenerativeAIApi();
  }
}

function resolveBaseUrl(config: Pick<FishModelConfig, "api" | "baseUrl">): string {
  const trimmed = config.baseUrl?.trim();
  if (trimmed) return trimmed;
  return isSupportedProviderApi(config.api) ? DEFAULT_BASE_URLS[config.api] : "";
}

function buildProvider(config: FishModelConfig, options: BuildFishModelsOptions = {}) {
  // 先校验协议再校验 key：避免旧配置残留退役 api 且无 key 时报出模糊的缺 key 错误
  if (!isSupportedProviderApi(config.api)) {
    throw new Error(
      `不支持的 provider api：${String(config.api)}（支持 ${SUPPORTED_PROVIDER_APIS.join(" / ")}；旧 OAuth 通道请改走 CLIProxyAPI）`,
    );
  }
  if (!config.key) {
    throw new Error(`没有拿到 ${config.providerId} 的 key：${config.keySource}`);
  }

  const resolvedBaseUrl = resolveBaseUrl(config);
  const registerGlobalProxy = options.registerGlobalProxy ?? true;
  let localProxyFetch: typeof fetch | undefined;

  // provider 级代理：正常运行期写全局 scopedProxies；探活等隔离路径仅注入局部 fetch。
  if (config.proxy) {
    const proxyFetch = createProxyFetch(config.proxy);
    if (proxyFetch) {
      if (registerGlobalProxy) registerScopedProxy(providerProxyHosts(config), proxyFetch);
      else localProxyFetch = proxyFetch;
    } else {
      console.warn(`[fish] invalid proxy for provider ${config.providerId}`);
    }
  }

  const provider = createProvider({
    id: config.providerId,
    name: config.providerId,
    baseUrl: resolvedBaseUrl,
    auth: {
      apiKey: {
        name: `${config.providerId} key`,
        // 只在这里出现，不进 env、不进日志、不进 prompt
        resolve: async () => ({ auth: { apiKey: config.key }, source: config.keySource }),
      },
    },
    models: config.models.map((model) => ({
      ...model,
      api: config.api,
      provider: config.providerId,
      baseUrl: resolvedBaseUrl,
    })),
    api: adapterFor(config.api),
  });

  // @earendil-works/pi-ai 的 google-generative-ai 适配器明确拒绝非 globalThis.fetch 的自定义 options.fetch
  // （会直接抛 Custom fetch is not supported），因此这里绝不向其注入 localProxyFetch；
  // 正常运行期走 registerScopedProxy 包装后的 globalThis.fetch。
  if (!localProxyFetch || config.api === "google-generative-ai") return provider;

  const applyDefaults = <T extends { fetch?: typeof fetch } | undefined>(opts: T): T =>
    ({
      ...(opts ?? {}),
      ...(opts?.fetch === undefined ? { fetch: localProxyFetch } : {}),
    }) as T;

  return {
    ...provider,
    stream: (model, context, opts) => provider.stream(model, context, applyDefaults(opts)),
    streamSimple: (model, context, opts) => provider.streamSimple(model, context, applyDefaults(opts)),
  };
}

/** 一个 provider 需要过代理的主机：从有效 baseUrl（含各协议官方缺省串）解析 hostname。 */
export function providerProxyHosts(config: FishModelConfig): string[] {
  const effective = resolveBaseUrl(config);
  if (!effective) return [];
  try {
    return [new URL(effective).hostname.toLowerCase()];
  } catch {
    return [];
  }
}

/** 校验：provider 里真的有这个模型，否则给出可用清单（不含凭据）。 */
export function assertModelExists(models: Models, providerId: string, modelId: string): void {
  const found = models.getModel(providerId, modelId);
  if (found) return;
  const available = models
    .getModels(providerId)
    .map((m) => m.id)
    .join(", ");
  throw new Error(`没有模型 ${providerId}/${modelId}；可用：${available || "(空)"}`);
}
