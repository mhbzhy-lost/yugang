/**
 * draw_remote 的 wan 通道：包一层 generateWanImage（百炼 Token Plan 原生生图）。
 *
 * 与 gpt 通道同样的三件事：把 baseUrl 里的 `/compatible-mode/v1` 剥掉（那是 OpenAI 兼容层的前缀，
 * 原生接口挂在域名根下）；记准「已提交」的阶段；把底层错误翻译成 DrawRemoteError——
 * 生成 POST 的 4xx 是确定性拒绝（submitted=false）；生成 5xx、空结果、图片下载失败、POST 之后的
 * 异常都结果不明（submitted=true）。上游错误正文先脱敏再清洗。
 */
import { readCredentialFile } from "../../model/config.ts";
import { generateWanImage } from "../wan-image.ts";
import { cleanUpstreamText, collectSecrets } from "./redact.ts";
import { DrawRemoteError, errorMessage, httpStatusOf, isAbortError, isTimeoutError } from "./types.ts";
import type { DrawRemoteChannelRequest } from "./types.ts";

const WAN = "wan" as const;
const DEFAULT_TIMEOUT_MS = 180_000;
const COMPAT_PREFIX = /\/compatible-mode\/v1$/i;

export async function runWanChannel(request: DrawRemoteChannelRequest): Promise<string[]> {
  const baseUrl = (request.baseUrl ?? "").trim().replace(/\/+$/, "").replace(COMPAT_PREFIX, "");
  if (!/^https?:\/\/[^\s/]+/i.test(baseUrl)) {
    throw new DrawRemoteError(
      WAN,
      "unconfigured",
      `draw_remote 未配置：models.json 的 provider「${request.providerId}」缺少 baseUrl（wan 通道要用它拼原生生图接口）`,
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
    throw new DrawRemoteError(WAN, "unconfigured", `draw_remote 未配置：auth.json 缺少「${request.providerId}」的 API key`, false);
  }
  const secrets = collectSecrets({ key: stored.key });

  // 用对象装着：钩子在闭包里改它，裸变量会被控制流分析误判成恒为 prepare
  const progress: { phase: "prepare" | "submitting" | "posted" } = { phase: "prepare" };
  try {
    return await generateWanImage({
      apiKey: stored.key,
      baseUrl,
      model: request.model,
      prompt: request.prompt,
      mediaRoot: request.mediaRoot,
      signal: request.signal,
      // size / n / enable_sequential 随 wan_image 工具退役，draw_remote 不传
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
        WAN,
        "failed",
        `wan ${download ? "图片下载" : "生图"}请求失败（HTTP ${status}）${detail ? `：${detail}` : ""}`,
        download || status >= 500,
        { cause: error },
      );
    }
    // 走到这里的 AbortError / TimeoutError 只剩 generateWanImage 内部的 180 秒定时器（宿主取消已在上面原样上抛）
    if (isTimeoutError(error) || isAbortError(error)) {
      throw new DrawRemoteError(WAN, "failed", `wan 生图超时（180 秒），结果不明`, true, { cause: error });
    }
    throw new DrawRemoteError(
      WAN,
      "failed",
      `wan 生图失败：${cleanUpstreamText(message, secrets)}`,
      progress.phase === "posted", // 空结果 / 过小的图都发生在 POST 之后
      { cause: error },
    );
  }
}
