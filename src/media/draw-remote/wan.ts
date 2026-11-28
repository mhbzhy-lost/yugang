/**
 * draw_remote 的 wan / qwen 通道：两条都包一层 generateWanImage（百炼 Token Plan 原生多模态生图接口），
 * 共用 models.json 的 qwen-token-plan-cn 一个 provider 与 auth.json 的同一把 API key——区别只在模型名、
 * 参考图张数上限（index.ts 的能力预检）与错误文案里的通道名。
 *
 * 与 gpt 通道同样的三件事：把 baseUrl 里的 `/compatible-mode/v1` 剥掉（那是 OpenAI 兼容层的前缀，
 * 原生接口挂在域名根下）；记准「已提交」的阶段；把底层错误翻译成 DrawRemoteError——
 * 生成 POST 的 4xx 是确定性拒绝（submitted=false）；生成 5xx、空结果、图片下载失败、POST 之后的
 * 异常都结果不明（submitted=true）。上游错误正文先脱敏再清洗。
 */
import { readCredentialFile } from "../../model/config.ts";
import { REMOTE_REF_TOTAL_MAX_BYTES } from "../gpt-image.ts";
import { generateWanImage } from "../wan-image.ts";
import { cleanUpstreamText, collectSecrets } from "./redact.ts";
import {
  DRAW_REMOTE_TIMEOUT_MS,
  DrawRemoteError,
  errorMessage,
  formatTimeoutLabel,
  httpStatusOf,
  isAbortError,
  isTimeoutError,
} from "./types.ts";
import type { DrawRemoteAspectRatio, DrawRemoteChannelRequest } from "./types.ts";

/** 走百炼原生生图接口的两条通道。 */
export type DashScopeImageProvider = "wan" | "qwen";

/**
 * 画面比例 → 像素尺寸（`宽*高`）。两条通道都按 1K 计费档出图，这五档是该档内各比例的高清尺寸；
 * 不传比例就不传 size，由模型按提示词自选。
 */
const SIZE_BY_ASPECT_RATIO: Readonly<Record<DrawRemoteAspectRatio, string>> = Object.freeze({
  "1:1": "1280*1280",
  "3:4": "1080*1440",
  "4:3": "1440*1080",
  "9:16": "1080*1920",
  "16:9": "1920*1080",
});

/**
 * 客户端自己的失败码 → 给模型看的说明。码名带 wan 字样，qwen 通道的回执里不能原样出现。
 * 不在表里的（网络异常、JSON 解析失败等）走脱敏后的原文。
 */
const CLIENT_FAILURES: Readonly<Record<string, string>> = {
  wan_image_empty: "上游没有返回图片",
  wan_image_too_small: "返回的图片过小",
  wan_image_not_image: "返回的内容不是图片",
};

const DEFAULT_TIMEOUT_MS = DRAW_REMOTE_TIMEOUT_MS;
const COMPAT_PREFIX = /\/compatible-mode\/v1$/i;

export async function runDashScopeImageChannel(provider: DashScopeImageProvider, request: DrawRemoteChannelRequest): Promise<string[]> {
  const totalRefBytes = (request.images ?? []).reduce((sum, image) => sum + image.bytes.length, 0);
  if (totalRefBytes > REMOTE_REF_TOTAL_MAX_BYTES) {
    throw new DrawRemoteError(provider, "bad_ref", `${provider} 参考图总大小超过 20MB 上限，请减少张数或压缩后再试`, false);
  }
  const baseUrl = (request.baseUrl ?? "").trim().replace(/\/+$/, "").replace(COMPAT_PREFIX, "");
  if (!/^https?:\/\/[^\s/]+/i.test(baseUrl)) {
    throw new DrawRemoteError(
      provider,
      "unconfigured",
      `draw_remote 未配置：models.json 的 provider「${request.providerId}」缺少 baseUrl（${provider} 通道要用它拼原生生图接口）`,
      false,
    );
  }

  let stored: ReturnType<typeof readCredentialFile>;
  try {
    stored = readCredentialFile(request.authPath, request.providerId);
  } catch {
    // JSON 解析错误会截一段原文，凭据文件内容不经错误文案出境
    stored = undefined;
  }
  // 错误文案会经工具回执原样到模型：只点名缺的是哪个来源，不带本机绝对路径与运维命令
  if (!stored || stored.type !== "api_key" || typeof stored.key !== "string" || stored.key === "") {
    throw new DrawRemoteError(provider, "unconfigured", `draw_remote 未配置：auth.json 缺少「${request.providerId}」的 API key`, false);
  }
  const secrets = collectSecrets({ key: stored.key });

  // 参考图转 data URI（MIME 由上层按真实字节核实过）；不传比例就不编造 size
  const images = (request.images ?? []).map((image) => `data:${image.mimeType};base64,${image.bytes.toString("base64")}`);
  const size = request.aspectRatio === undefined ? undefined : SIZE_BY_ASPECT_RATIO[request.aspectRatio];

  // 用对象装着：钩子在闭包里改它，裸变量会被控制流分析误判成恒为 prepare
  const progress: { phase: "prepare" | "submitting" | "posted" } = { phase: "prepare" };
  const timeoutMs = request.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  try {
    return await generateWanImage({
      apiKey: stored.key,
      baseUrl,
      model: request.model,
      prompt: request.prompt,
      mediaRoot: request.mediaRoot,
      ...(images.length > 0 ? { images } : {}),
      ...(size !== undefined ? { size } : {}),
      timeoutMs,
      signal: request.signal,
      onStage: request.onStage,
      // 组图（n / enable_sequential）与思考 / 改写定制不开放，客户端不再发送这些参数
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
    if (progress.phase === "submitting") throw error;
    if (request.signal?.aborted) throw error; // 宿主取消：AbortError 原样上抛
    const message = errorMessage(error);
    const status = httpStatusOf(error);
    if (status !== undefined) {
      const download = message.startsWith("wan_image_download_");
      const detail = cleanUpstreamText(message.replace(/^wan_image_(?:http|download)_\d+\s*:?\s*/, ""), secrets);
      // 下载失败时生成请求早已被受理：结果不明
      throw new DrawRemoteError(
        provider,
        "failed",
        `${provider} ${download ? "图片下载" : "生图"}请求失败（HTTP ${status}）${detail ? `：${detail}` : ""}`,
        download || status >= 500,
        { cause: error },
      );
    }
    // 走到这里的 AbortError / TimeoutError 只剩 generateWanImage 内部定时器（宿主取消已在上面原样上抛）
    if (isTimeoutError(error) || isAbortError(error)) {
      const stage = typeof (error as { stage?: unknown } | null)?.stage === "string"
        ? (error as { stage: string }).stage
        : undefined;
      throw new DrawRemoteError(
        provider,
        "failed",
        `${provider} 生图超时（${formatTimeoutLabel(timeoutMs)}${stage ? `，阶段：${stage}` : ""}），结果不明`,
        true,
        { cause: error },
      );
    }
    throw new DrawRemoteError(
      provider,
      "failed",
      // 空结果 / 过小的图 / 非图片正文都发生在 POST 之后
      `${provider} 生图失败：${CLIENT_FAILURES[message] ?? cleanUpstreamText(message, secrets)}`,
      progress.phase === "posted",
      { cause: error },
    );
  }
}

export function runWanChannel(request: DrawRemoteChannelRequest): Promise<string[]> {
  return runDashScopeImageChannel("wan", request);
}

export function runQwenChannel(request: DrawRemoteChannelRequest): Promise<string[]> {
  return runDashScopeImageChannel("qwen", request);
}
