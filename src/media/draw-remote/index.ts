/**
 * draw_remote 统一调度入口：能力预检 → 现读 models.json → 分发到单条通道。
 *
 * 每次调用都重新读 models.json，并把凭据定位到它同目录的 auth.json（credentialsPath 可覆盖），
 * 所以主人改配置、换凭据都是零重启热生效。
 *
 * 顺序有意如此——越便宜的检查越靠前，且全部在 onSubmitted 之前：
 *   1. prompt（去首尾空白后非空；wan ≤ 800 字，其余 ≤ 4000 字）
 *   2. 通道能力（wan 不收参考图；wan / gemini 不收透明背景）
 *   3. models.json 里有没有这条通道的 provider
 *   4. 通道内部：读 auth.json 凭据、前置 OAuth 刷新、projectId 兜底——缺了同样在提交前报 unconfigured
 * 以上任何一步失败都不会触发 onSubmitted，也不会发出任何 HTTP 请求；修正后同一个请求可直接重试。
 */
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import type { ModelsFile, ProviderConfig } from "../../model/config.ts";
import { runGeminiChannel } from "./gemini.ts";
import { runGptChannel } from "./gpt.ts";
import { DrawRemoteError } from "./types.ts";
import type {
  DrawRemoteChannelRequest,
  DrawRemoteProviderId,
  DrawRemoteRunRequest,
  DrawRemoteRunResult,
} from "./types.ts";
import { runWanChannel } from "./wan.ts";

/** 通道 → models.json 的 provider 条目名（auth.json 的凭据条目同名）。 */
export const DRAW_REMOTE_PROVIDER_IDS: Readonly<Record<DrawRemoteProviderId, string>> = Object.freeze({
  gpt: "openai-codex",
  wan: "qwen-token-plan-cn",
  gemini: "google-antigravity",
});

const PROMPT_MAX = 4000;
const WAN_PROMPT_MAX = 800;

export async function runDrawRemote(request: DrawRemoteRunRequest): Promise<DrawRemoteRunResult> {
  const { provider } = request;
  // 已经取消的调用直接退出：不读配置、不触发钩子
  request.signal?.throwIfAborted();

  const prompt = request.prompt.trim();
  if (!prompt || prompt.length > PROMPT_MAX) {
    throw new DrawRemoteError(
      provider,
      "prompt",
      `draw_remote 的 prompt 去首尾空白后不能为空，且不得超过 ${PROMPT_MAX} 字（当前 ${prompt.length} 字）`,
      false,
    );
  }
  if (provider === "wan" && prompt.length > WAN_PROMPT_MAX) {
    throw new DrawRemoteError(provider, "prompt", `wan 通道的 prompt 不得超过 ${WAN_PROMPT_MAX} 字（当前 ${prompt.length} 字），请精简`, false);
  }
  const images = request.images ?? [];
  if (provider === "wan" && images.length > 0) {
    throw new DrawRemoteError(provider, "no_ref", "wan 通道不支持参考图（images），请去掉参考图，或请主人把 drawRemote.provider 切到 gpt / gemini", false);
  }
  if (provider !== "gpt" && request.background === "transparent") {
    throw new DrawRemoteError(
      provider,
      "no_transparent",
      `${provider} 通道不支持透明背景（background=transparent），请改为 auto / opaque 或不传`,
      false,
    );
  }

  const providerId = DRAW_REMOTE_PROVIDER_IDS[provider];
  const config = readProviderConfig(request.modelsPath, providerId, provider);
  const channel: DrawRemoteChannelRequest = {
    model: request.model,
    prompt,
    ...(images.length > 0 ? { images } : {}),
    ...(request.aspectRatio !== undefined ? { aspectRatio: request.aspectRatio } : {}),
    ...(request.background !== undefined ? { background: request.background } : {}),
    mediaRoot: request.mediaRoot,
    authPath: request.credentialsPath ?? join(dirname(request.modelsPath), "auth.json"),
    providerId,
    ...(config.baseUrl !== undefined ? { baseUrl: config.baseUrl } : {}),
    ...(config.userAgent !== undefined ? { userAgent: config.userAgent } : {}),
    ...(config.proxy !== undefined ? { proxy: config.proxy } : {}),
    onSubmitted: request.onSubmitted,
    signal: request.signal,
    timeoutMs: request.timeoutMs,
    fetchImpl: request.fetchImpl,
  };
  const files = provider === "gpt" ? await runGptChannel(channel) : provider === "wan" ? await runWanChannel(channel) : await runGeminiChannel(channel);
  // 通道返回的是 gen/ 下的裸文件名，对外原样透出（媒体引用由上层拼 gen/，幂等键用裸文件名）
  return { provider, model: request.model, files };
}

function readProviderConfig(modelsPath: string, providerId: string, provider: DrawRemoteProviderId): ProviderConfig {
  let file: unknown;
  try {
    file = JSON.parse(readFileSync(modelsPath, "utf8"));
  } catch {
    // 解析错误不回显：JSON.parse 的报错会带一段原文，models.json 的内容不经错误文案出境
    throw new DrawRemoteError(provider, "unconfigured", "draw_remote 未配置：models.json 无法读取或格式非法", false);
  }
  const config =
    file && typeof file === "object" && !Array.isArray(file) ? (file as Partial<ModelsFile>).providers?.[providerId] : undefined;
  if (!config || typeof config !== "object") {
    // 错误文案会经工具回执原样到模型：只点名缺的是哪个来源（models.json 的 provider / auth.json 的凭据），
    // 不带本机绝对路径与运维命令
    throw new DrawRemoteError(provider, "unconfigured", `draw_remote 未配置：models.json 缺少 provider「${providerId}」（${provider} 通道要用）`, false);
  }
  return config;
}

export * from "./types.ts";
export * from "./gemini.ts";
export * from "./gpt.ts";
export * from "./wan.ts";
