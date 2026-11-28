/**
 * 对指定 provider/model 发一次最小真实请求，供命令行 ping 与主人私聊的 config models_probe 共用。
 * 只读模型配置与凭据，不写角色表；错误文本先抹除内存中持有的凭据，再允许进入工具结果或日志。
 */
import { loadProviderConfig, type FishModelConfig } from "./config.ts";
import { assertModelExists, createFishModels } from "./models.ts";
import { redactSecrets } from "./quota.ts";

export interface ModelProbeResult {
  provider: string;
  model: string;
  elapsedMs: number;
  stopReason: string;
  text: string;
  usage: { input: number; output: number; cost: number };
}

export interface ModelProbeOptions {
  modelsPath?: string;
  credentialsPath?: string;
  timeoutMs?: number;
  signal?: AbortSignal;
}

function safeError(error: unknown, config: FishModelConfig): string {
  const text = error instanceof Error ? error.message : String(error);
  const secrets = config.key ? [config.key] : [];
  return redactSecrets(text, secrets).slice(0, 500);
}

export async function probeModelConfig(config: FishModelConfig, options: ModelProbeOptions = {}): Promise<ModelProbeResult> {
  const models = createFishModels(config, { registerGlobalProxy: false });
  assertModelExists(models, config.providerId, config.modelId);
  const model = models.getModel(config.providerId, config.modelId)!;
  const timeoutSignal = AbortSignal.timeout(options.timeoutMs ?? 25_000);
  const signal = options.signal ? AbortSignal.any([options.signal, timeoutSignal]) : timeoutSignal;
  const started = Date.now();
  try {
    const message = await models.streamSimple(model, {
      messages: [{ role: "user", content: "只回复两个字：在的" }],
    }, { signal }).result();
    const text = message.content
      .filter((block): block is { type: "text"; text: string } => block.type === "text")
      .map((block) => block.text)
      .join("")
      .trim();
    if (message.stopReason === "error" || message.stopReason === "aborted") {
      throw new Error(message.errorMessage ?? message.rawStopReason ?? message.stopReason);
    }
    if (!text) throw new Error("模型没有返回文本");
    return {
      provider: config.providerId,
      model: config.modelId,
      elapsedMs: Date.now() - started,
      stopReason: message.stopReason,
      text: text.slice(0, 60),
      usage: { input: message.usage.input, output: message.usage.output, cost: message.usage.cost.total },
    };
  } catch (error) {
    throw new Error(safeError(error, config));
  }
}

export async function probeFishModel(provider: string, model: string, options: ModelProbeOptions = {}): Promise<ModelProbeResult> {
  const config = loadProviderConfig(provider, {
    modelId: model,
    ...(options.modelsPath ? { modelsPath: options.modelsPath } : {}),
    ...(options.credentialsPath ? { credentialsPath: options.credentialsPath } : {}),
  });
  return probeModelConfig(config, options);
}
