/**
 * 把 model-config 里的 provider 条目变成一个 pi-ai Models。
 *
 * 用 createProvider 自己拼：baseUrl 指向 pi 配置里那个网关，key 用闭包带进去，
 * 不写 process.env，也就不会被任何子进程或日志带出来。
 */
import { createModels, createProvider, type Models } from "@earendil-works/pi-ai/models";
import { openAICompletionsApi } from "@earendil-works/pi-ai/api/openai-completions.lazy";
import { openAICodexResponsesApi } from "@earendil-works/pi-ai/api/openai-codex-responses.lazy";
import { googleCodeAssistApi } from "./google-code-assist.ts";
import { fileCredentialStore, type OAuthCredential } from "../auth/credentials.ts";
import { createProxyFetch, registerScopedProxy } from "../media/proxy-fetch.ts";
import { googleGeminiOAuth, refreshTokens as refreshGoogleTokens } from "../auth/google.ts";
import { openaiCodexOAuth, refreshTokens as refreshOpenAiTokens } from "../auth/openai.ts";
import type { FishModelConfig } from "./config.ts";

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
  const models = createModels({ credentials: fileCredentialStore(config.credentialsPath) });
  models.setProvider(buildProvider(config, options));
  return models;
}

function buildProvider(config: FishModelConfig, options: BuildFishModelsOptions = {}) {
  const oauth = config.authMode === "oauth";
  if (!oauth && !config.key) {
    throw new Error(`没有拿到 ${config.providerId} 的 key：${config.keySource}`);
  }

  const registerGlobalProxy = options.registerGlobalProxy ?? true;
  let localProxyFetch: typeof fetch | undefined;

  // provider 级代理：正常运行期写全局 scopedProxies；探活等隔离路径仅注入局部 fetch 与 oauth.refresh。
  if (config.proxy) {
    const proxyFetch = createProxyFetch(config.proxy);
    if (proxyFetch) {
      if (registerGlobalProxy) registerScopedProxy(providerProxyHosts(config), proxyFetch);
      else localProxyFetch = proxyFetch;
    } else {
      console.warn(`[fish] invalid proxy for provider ${config.providerId}`);
    }
  }

  const isCodeAssist = config.api === "google-code-assist";
  const isAntigravity = config.api === "antigravity-code-assist";
  const isGoogleOAuth = isCodeAssist || isAntigravity;
  const api = isAntigravity
    ? googleCodeAssistApi({ flavor: "antigravity", ...(config.userAgent ? { userAgent: config.userAgent } : {}) })
    : isCodeAssist
      ? googleCodeAssistApi()
      : config.api === "openai-codex-responses"
        ? openAICodexResponsesApi()
        : openAICompletionsApi();

  const baseOAuth = isGoogleOAuth ? googleGeminiOAuth : openaiCodexOAuth;
  const oauthAuth = localProxyFetch
    ? {
        ...baseOAuth,
        refresh(credential: OAuthCredential, signal: AbortSignal): Promise<OAuthCredential> {
          return isGoogleOAuth
            ? refreshGoogleTokens(credential, signal, localProxyFetch)
            : refreshOpenAiTokens(credential, signal, localProxyFetch);
        },
      }
    : baseOAuth;

  const provider = createProvider({
    id: config.providerId,
    name: config.providerId,
    ...(config.baseUrl ? { baseUrl: config.baseUrl } : {}),
    auth: oauth
      ? { oauth: oauthAuth }
      : {
          apiKey: {
            name: `${config.providerId} key`,
            // 只在这里出现，不进 env、不进日志、不进 prompt
            resolve: async () => ({ auth: { apiKey: config.key }, source: config.keySource }),
          },
        },
    models: config.models.map((model) => ({
      ...model,
      api: isAntigravity
        ? ("antigravity-code-assist" as const)
        : isCodeAssist
          ? ("google-code-assist" as const)
          : config.api === "openai-codex-responses"
            ? ("openai-codex-responses" as const)
            : ("openai-completions" as const),
      provider: config.providerId,
      ...(config.baseUrl ? { baseUrl: config.baseUrl } : {}),
    })),
    api,
  });

  if (!localProxyFetch && !config.transport) return provider;

  const applyDefaults = <T extends { fetch?: typeof fetch; transport?: string } | undefined>(opts: T): T =>
    ({
      ...(opts ?? {}),
      ...(localProxyFetch && opts?.fetch === undefined ? { fetch: localProxyFetch } : {}),
      ...(config.transport && opts?.transport === undefined ? { transport: config.transport } : {}),
    }) as T;

  return {
    ...provider,
    stream: (model, context, opts) => provider.stream(model, context, applyDefaults(opts)),
    streamSimple: (model, context, opts) => provider.streamSimple(model, context, applyDefaults(opts)),
  };
}

/** 一个 provider 需要过代理的主机：自己的 baseUrl + 内部 OAuth 刷新落点。 */
export function providerProxyHosts(config: FishModelConfig): string[] {
  const hosts = new Set<string>();
  try {
    if (config.baseUrl) hosts.add(new URL(config.baseUrl).hostname.toLowerCase());
  } catch {
    // baseUrl 写坏了不影响代理本身，交给后面的请求报错
  }
  if (config.authMode === "oauth") {
    if (config.api === "antigravity-code-assist") {
      // Antigravity：模型流走 daily-cloudcode-pa（含 prod/sandbox），
      // token 刷新走 oauth2.googleapis.com（裸全局 fetch，scoped proxy 接管）
      hosts.add("daily-cloudcode-pa.googleapis.com");
      hosts.add("daily-cloudcode-pa.sandbox.googleapis.com");
      hosts.add("cloudcode-pa.googleapis.com");
      hosts.add("oauth2.googleapis.com");
    } else if (config.api === "google-code-assist") {
      // Google 订阅：模型流走 cloudcode-pa，token 刷新走 oauth2.googleapis.com；
      // 刷新用裸全局 fetch，必须进 scoped proxy 才会被接管
      hosts.add("cloudcode-pa.googleapis.com");
      hosts.add("oauth2.googleapis.com");
    } else {
      hosts.add("chatgpt.com");
      hosts.add("auth.openai.com");
    }
  }
  return [...hosts];
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
