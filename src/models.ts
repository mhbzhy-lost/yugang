/**
 * 把 model-config 里的 provider 条目变成一个 pi-ai Models。
 *
 * 用 createProvider 自己拼：baseUrl 指向 pi 配置里那个网关，key 用闭包带进去，
 * 不写 process.env，也就不会被任何子进程或日志带出来。
 */
import { createModels, createProvider, type Models } from "@earendil-works/pi-ai/models";
import { openAICompletionsApi } from "@earendil-works/pi-ai/api/openai-completions.lazy";
import { openAICodexResponsesApi } from "@earendil-works/pi-ai/api/openai-codex-responses.lazy";
import { openaiCodexOAuth } from "./oauth-openai.ts";
import { fileCredentialStore } from "./credential-store.ts";
import { createProxyFetch, registerScopedProxy } from "./media/proxy-fetch.ts";
import type { FishModelConfig } from "./model-config.ts";

/** 把一份 provider 配置挂到已有的 Models 上（主模型与视觉模型可能是不同 provider）。 */
export function addFishProvider(models: Models, config: FishModelConfig): Models {
  models.setProvider(buildProvider(config));
  return models;
}

export function createFishModels(config: FishModelConfig): Models {
  const models = createModels({ credentials: fileCredentialStore(config.credentialsPath) });
  models.setProvider(buildProvider(config));
  return models;
}

function buildProvider(config: FishModelConfig) {
  const oauth = config.authMode === "oauth";
  if (!oauth && !config.key) {
    throw new Error(`没有拿到 ${config.providerId} 的 key：${config.keySource}`);
  }

  // provider 级代理：把它的域名（baseUrl + OAuth token 主机）挂到隧道上，
  // 进程内其它 provider 的域名不受影响；非法地址只告警不上代理。
  if (config.proxy) {
    const proxyFetch = createProxyFetch(config.proxy);
    if (proxyFetch) registerScopedProxy(providerProxyHosts(config), proxyFetch);
    else console.warn(`[fish] invalid proxy for provider ${config.providerId}`);
  }

  const api = config.api === "openai-codex-responses" ? openAICodexResponsesApi() : openAICompletionsApi();

  const provider = createProvider({
    id: config.providerId,
    name: config.providerId,
    ...(config.baseUrl ? { baseUrl: config.baseUrl } : {}),
    auth: oauth
      ? { oauth: openaiCodexOAuth }
      : {
          apiKey: {
            name: `${config.providerId} key`,
            // 只在这里出现，不进 env、不进日志、不进 prompt
            resolve: async () => ({ auth: { apiKey: config.key }, source: config.keySource }),
          },
        },
    models: config.models.map((model) => ({
      ...model,
      api: config.api === "openai-codex-responses" ? ("openai-codex-responses" as const) : ("openai-completions" as const),
      provider: config.providerId,
      ...(config.baseUrl ? { baseUrl: config.baseUrl } : {}),
    })),
    api,
  });

  return provider;
}

/** 一个 provider 需要过代理的主机：自己的 baseUrl + 内部 OAuth 刷新落点（目前只有 codex）。 */
function providerProxyHosts(config: FishModelConfig): string[] {
  const hosts = new Set<string>();
  try {
    if (config.baseUrl) hosts.add(new URL(config.baseUrl).hostname.toLowerCase());
  } catch {
    // baseUrl 写坏了不影响代理本身，交给后面的请求报错
  }
  if (config.authMode === "oauth") hosts.add("auth.openai.com");
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
