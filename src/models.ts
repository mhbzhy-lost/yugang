/**
 * 把 model-config 里的 provider 条目变成一个 pi-ai Models。
 *
 * 用 createProvider 自己拼：baseUrl 指向 pi 配置里那个网关，key 用闭包带进去，
 * 不写 process.env，也就不会被任何子进程或日志带出来。
 */
import { createModels, createProvider, type Models } from "@earendil-works/pi-ai/models";
import { openAICompletionsApi } from "@earendil-works/pi-ai/api/openai-completions.lazy";
import type { FishModelConfig } from "./model-config.ts";

export function createFishModels(config: FishModelConfig): Models {
  if (!config.key) {
    throw new Error(`没有拿到 ${config.providerId} 的 key：${config.keySource}`);
  }

  const provider = createProvider({
    id: config.providerId,
    name: config.providerId,
    ...(config.baseUrl ? { baseUrl: config.baseUrl } : {}),
    auth: {
      apiKey: {
        name: `${config.providerId} key`,
        // 只在这里出现，不进 env、不进日志、不进 prompt
        resolve: async () => ({ auth: { apiKey: config.key }, source: config.keySource }),
      },
    },
    models: config.models.map((model) => ({
      ...model,
      api: "openai-completions" as const,
      provider: config.providerId,
      ...(config.baseUrl ? { baseUrl: config.baseUrl } : {}),
    })),
    api: openAICompletionsApi(),
  });

  const models = createModels();
  models.setProvider(provider);
  return models;
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
