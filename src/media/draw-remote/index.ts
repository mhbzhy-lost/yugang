/**
 * draw_remote 统一调度入口：能力预检 → 现读 models.json → 分发到单条通道。
 *
 * 每次调用都重新读 models.json，并把凭据定位到它同目录的 auth.json（credentialsPath 可覆盖），
 * 所以主人改配置、换凭据都是零重启热生效。
 *
 * 顺序有意如此——越便宜的检查越靠前，且全部在 onSubmitted 之前：
 *   1. prompt（去首尾空白后非空；四通道同一个上限 ≤ 4000 字）
 *   2. 通道能力（参考图：qwen 最多 3 张、其余最多 5 张）
 *   3. models.json 里有没有这条通道的 provider
 *   4. 通道内部：读 auth.json 凭据、前置 OAuth 刷新、projectId 兜底——缺了同样在提交前报 unconfigured
 * 以上任何一步失败都不会触发 onSubmitted，也不会发出任何 HTTP 请求；修正后同一个请求可直接重试。
 */
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { readCredentialFile, type ModelsFile, type ProviderConfig } from "../../model/config.ts";
import { runGeminiChannel } from "./gemini.ts";
import { runGptChannel } from "./gpt.ts";
import { DrawRemoteError } from "./types.ts";
import type {
  DrawRemoteChannelRequest,
  DrawRemotePreflightRequest,
  DrawRemoteProviderId,
  DrawRemoteRunRequest,
  DrawRemoteRunResult,
} from "./types.ts";
import { runQwenChannel, runWanChannel } from "./wan.ts";

/** 通道 → models.json 的 provider 条目名（auth.json 的凭据条目同名）。wan 与 qwen 同属百炼 Token Plan，共用一条。 */
export const DRAW_REMOTE_PROVIDER_IDS: Readonly<Record<DrawRemoteProviderId, string>> = Object.freeze({
  gpt: "openai-codex",
  wan: "qwen-token-plan-cn",
  qwen: "qwen-token-plan-cn",
  gemini: "google-antigravity",
});

const PROMPT_MAX = 4000;
const COMPAT_PREFIX = /\/compatible-mode\/v1$/i;

/**
 * 各通道一次最多收几张参考图。工具层 prepareReferences 按它先拦（回执能点名是第几张），
 * 这里是适配器自己的防御（不经工具层直接调用时同样成立）。
 */
export const MAX_REFERENCE_IMAGES_BY_PROVIDER: Readonly<Record<DrawRemoteProviderId, number>> = Object.freeze({
  gpt: 5,
  wan: 5,
  qwen: 3,
  gemini: 5,
});

/** 纯输入预检（prompt 非空/长度上限 + 通道参考图张数上限），返回去首尾空白后的 prompt。 */
export function validateDrawRemoteInput(provider: DrawRemoteProviderId, rawPrompt: string, imagesCount: number): string {
  const prompt = rawPrompt.trim();
  if (!prompt || prompt.length > PROMPT_MAX) {
    throw new DrawRemoteError(
      provider,
      "prompt",
      `draw_remote 的 prompt 去首尾空白后不能为空，且不得超过 ${PROMPT_MAX} 字（当前 ${prompt.length} 字）`,
      false,
    );
  }
  const maxImages = MAX_REFERENCE_IMAGES_BY_PROVIDER[provider];
  if (imagesCount > maxImages) {
    throw new DrawRemoteError(
      provider,
      "bad_ref",
      `${provider} 通道最多接受 ${maxImages} 张参考图（当前 ${imagesCount} 张），请删到 ${maxImages} 张以内`,
      false,
    );
  }
  return prompt;
}

/**
 * 同步预检（不发任何网络请求）：校验 prompt/参考图上限、models.json provider 与 baseUrl，
 * 以及 auth.json 凭据存在且类型形状合规。所有 JSON 读取异常均吞掉原文统一报 unconfigured。
 */
export function preflightDrawRemote(request: DrawRemotePreflightRequest): string {
  const { provider } = request;
  const prompt = validateDrawRemoteInput(provider, request.prompt, request.imagesCount);
  const providerId = DRAW_REMOTE_PROVIDER_IDS[provider];
  const config = readProviderConfig(request.modelsPath, providerId, provider);
  const authPath = request.credentialsPath ?? join(dirname(request.modelsPath), "auth.json");

  let stored: ReturnType<typeof readCredentialFile>;
  try {
    stored = readCredentialFile(authPath, providerId);
  } catch {
    // JSON 解析错误会截一段原文，凭据文件内容绝不经错误文案出境
    stored = undefined;
  }

  if (provider === "wan" || provider === "qwen") {
    const baseUrl = (config.baseUrl ?? "").trim().replace(/\/+$/, "").replace(COMPAT_PREFIX, "");
    if (!/^https?:\/\/[^\s/]+/i.test(baseUrl)) {
      throw new DrawRemoteError(
        provider,
        "unconfigured",
        `draw_remote 未配置：models.json 的 provider「${providerId}」缺少 baseUrl（${provider} 通道要用它拼原生生图接口）`,
        false,
      );
    }
    if (!stored || stored.type !== "api_key" || typeof stored.key !== "string" || stored.key === "") {
      throw new DrawRemoteError(provider, "unconfigured", `draw_remote 未配置：auth.json 缺少「${providerId}」的 API key`, false);
    }
    return prompt;
  }

  if (provider === "gpt") {
    const accountId = stored && stored.type === "oauth" ? stored["accountId"] : undefined;
    if (
      !stored
      || stored.type !== "oauth"
      || typeof stored.access !== "string"
      || stored.access === ""
      || typeof stored.refresh !== "string"
      || stored.refresh === ""
      || typeof accountId !== "string"
      || accountId === ""
    ) {
      throw new DrawRemoteError(provider, "unconfigured", `draw_remote 未配置：auth.json 缺少「${providerId}」的 OAuth 凭据`, false);
    }
    return prompt;
  }

  // gemini：projectId 允许在后台走 discoverProject 兜底，同步预检只核对 OAuth 凭据就绪
  if (
    !stored
    || stored.type !== "oauth"
    || typeof stored.access !== "string"
    || stored.access === ""
    || typeof stored.refresh !== "string"
    || stored.refresh === ""
  ) {
    throw new DrawRemoteError(provider, "unconfigured", `draw_remote 未配置：auth.json 缺少「${providerId}」的 OAuth 凭据`, false);
  }
  return prompt;
}

export async function runDrawRemote(request: DrawRemoteRunRequest): Promise<DrawRemoteRunResult> {
  const { provider } = request;
  // 已经取消的调用直接退出：不读配置、不触发钩子
  request.signal?.throwIfAborted();

  const images = request.images ?? [];
  const prompt = validateDrawRemoteInput(provider, request.prompt, images.length);

  const providerId = DRAW_REMOTE_PROVIDER_IDS[provider];
  const config = readProviderConfig(request.modelsPath, providerId, provider);
  const channel: DrawRemoteChannelRequest = {
    model: request.model,
    prompt,
    ...(images.length > 0 ? { images } : {}),
    ...(request.aspectRatio !== undefined ? { aspectRatio: request.aspectRatio } : {}),
    mediaRoot: request.mediaRoot,
    authPath: request.credentialsPath ?? join(dirname(request.modelsPath), "auth.json"),
    providerId,
    ...(config.baseUrl !== undefined ? { baseUrl: config.baseUrl } : {}),
    ...(config.userAgent !== undefined ? { userAgent: config.userAgent } : {}),
    ...(config.proxy !== undefined ? { proxy: config.proxy } : {}),
    onSubmitted: request.onSubmitted,
    signal: request.signal,
    timeoutMs: request.timeoutMs,
    onStage: request.onStage,
    fetchImpl: request.fetchImpl,
  };
  let files: string[];
  if (provider === "gpt") files = await runGptChannel(channel);
  else if (provider === "gemini") files = await runGeminiChannel(channel);
  else if (provider === "wan") files = await runWanChannel(channel);
  else files = await runQwenChannel(channel);
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
