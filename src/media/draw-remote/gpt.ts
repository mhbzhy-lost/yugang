/**
 * draw_remote 的 gpt 通道：包一层 generateGptImages（标准 OpenAI Images API）。
 *
 * 职责：校验 baseUrl 与 auth.json 的 API key；将参考图原始字节透传给 /images/edits FormData；
 * 记准「已提交」阶段；把底层错误翻译成 DrawRemoteError——缺配置是 unconfigured，
 * HTTP 4xx 是确定性拒绝（submitted=false），5xx / 超时 / POST 之后的异常结果不明（submitted=true）。
 *
 * 错误文案会经工具回执原样到模型：只点名缺的是哪个来源（models.json 的 provider / auth.json 的凭据），
 * 不带本机绝对路径与运维命令；上游正文一律经 cleanUpstreamText 脱敏清洗。
 */
import { readCredentialFile } from "../../model/config.ts";
import { generateGptImages, REMOTE_REF_TOTAL_MAX_BYTES } from "../gpt-image.ts";
import { cleanUpstreamText, collectSecrets } from "./redact.ts";
import {
  DRAW_REMOTE_TIMEOUT_MS,
  DrawRemoteError,
  errorMessage,
  formatTimeoutLabel,
  httpStatusOf,
  isAbortError,
  isTimeoutError,
  isValidHttpUrl,
} from "./types.ts";
import type { DrawRemoteChannelRequest } from "./types.ts";

const GPT = "gpt" as const;
const DEFAULT_TIMEOUT_MS = DRAW_REMOTE_TIMEOUT_MS;

const CLIENT_FAILURES: Readonly<Record<string, string>> = {
  gpt_image_empty: "上游没有返回图片",
  gpt_image_too_small: "返回的图片过小",
  gpt_image_response_too_large: "上游响应超过体积上限",
};

export async function runGptChannel(request: DrawRemoteChannelRequest): Promise<string[]> {
  const totalRefBytes = (request.images ?? []).reduce((sum, image) => sum + image.bytes.length, 0);
  if (totalRefBytes > REMOTE_REF_TOTAL_MAX_BYTES) {
    throw new DrawRemoteError(GPT, "bad_ref", "gpt 参考图总大小超过 20MB 上限，请减少张数或压缩后再试", false);
  }
  const baseUrl = (request.baseUrl ?? "").trim();
  if (!isValidHttpUrl(baseUrl)) {
    throw new DrawRemoteError(
      GPT,
      "unconfigured",
      `draw_remote 未配置：models.json 的 provider「${request.providerId}」缺少合法 baseUrl（gpt 通道要用它拼标准图片接口）`,
      false,
    );
  }

  let stored: ReturnType<typeof readCredentialFile>;
  try {
    stored = readCredentialFile(request.authPath, request.providerId);
  } catch {
    stored = undefined;
  }
  const apiKey = stored?.type === "api_key" && typeof stored.key === "string" ? stored.key.trim() : "";
  if (!apiKey) {
    throw new DrawRemoteError(
      GPT,
      "unconfigured",
      `draw_remote 未配置：auth.json 缺少「${request.providerId}」的 API key`,
      false,
    );
  }
  const secrets = collectSecrets({ key: apiKey });

  const progress: { phase: "prepare" | "submitting" | "posted" } = { phase: "prepare" };
  const phase = () => progress.phase;
  try {
    return await generateGptImages({
      baseUrl,
      apiKey,
      prompt: request.prompt,
      // params 只传 model：不替后端编造 size / quality / background 等字段的缺省值
      params: { model: request.model },
      ...(request.images && request.images.length > 0 ? { images: request.images } : {}),
      mediaRoot: request.mediaRoot,
      timeoutMs: request.timeoutMs ?? DEFAULT_TIMEOUT_MS,
      signal: request.signal,
      onStage: request.onStage,
      fetchImpl: request.fetchImpl,
      proxy: request.proxy,
      onSubmitted: () => {
        progress.phase = "submitting";
        request.onSubmitted?.();
        progress.phase = "posted";
      },
    });
  } catch (error) {
    if (error instanceof DrawRemoteError) throw error;
    if (phase() === "submitting") throw error;
    if (request.signal?.aborted) throw error;
    const message = errorMessage(error);
    if (message === "gpt_image_no_auth" || message === "gpt_image_bad_base_url") {
      throw new DrawRemoteError(
        GPT,
        "unconfigured",
        message === "gpt_image_bad_base_url"
          ? `draw_remote 未配置：models.json 的 provider「${request.providerId}」缺少合法 baseUrl`
          : `draw_remote 未配置：auth.json 缺少「${request.providerId}」的 API key`,
        false,
        { cause: error },
      );
    }
    const status = httpStatusOf(error);
    if (status !== undefined) {
      const detail = cleanUpstreamText(message.replace(/^gpt_image_http_\d+\s*:?\s*/, ""), secrets);
      throw new DrawRemoteError(
        GPT,
        "failed",
        `gpt 生图请求失败（HTTP ${status}）${detail ? `：${detail}` : ""}`,
        status >= 500,
        { cause: error },
      );
    }
    if (isTimeoutError(error) || isAbortError(error)) {
      throw new DrawRemoteError(
        GPT,
        "failed",
        `gpt 生图超时（${formatTimeoutLabel(request.timeoutMs ?? DEFAULT_TIMEOUT_MS)}），结果不明`,
        phase() === "posted",
        { cause: error },
      );
    }
    const posted = phase() === "posted";
    throw new DrawRemoteError(
      GPT,
      "failed",
      `gpt ${posted ? "生图失败" : "前置准备失败"}：${CLIENT_FAILURES[message] ?? cleanUpstreamText(message, secrets)}`,
      posted,
      { cause: error },
    );
  }
}
