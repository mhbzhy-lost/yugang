/**
 * draw_remote 的 gpt 通道：包一层 generateGptImages（Codex 订阅的图片后端）。
 *
 * 职责只有三件：把参考图拼成 data URL 交给 /edits；把「已提交」的阶段记准；把底层错误翻译成
 * DrawRemoteError——缺凭据是 unconfigured，HTTP 4xx 是确定性拒绝（submitted=false），
 * 5xx / 超时 / POST 之后的异常结果不明（submitted=true）。aspectRatio 不透传：Codex 图片后端
 * 没有这个字段，构图靠提示词。
 */
import { generateGptImages } from "../gpt-image.ts";
import { cleanUpstreamText } from "./redact.ts";
import { DrawRemoteError, errorMessage, httpStatusOf, isAbortError, isTimeoutError } from "./types.ts";
import type { DrawRemoteChannelRequest } from "./types.ts";

const GPT = "gpt" as const;
const DEFAULT_TIMEOUT_MS = 180_000;

export async function runGptChannel(request: DrawRemoteChannelRequest): Promise<string[]> {
  const dataUrls = (request.images ?? []).map((image) => `data:${image.mimeType};base64,${image.bytes.toString("base64")}`);
  // prepare：还没调提交钩子；submitting：钩子在跑；posted：钩子跑完，之后的第一件事就是生成 POST。
  // 用对象装着：钩子在闭包里改它，裸变量会被控制流分析误判成恒为 prepare
  const progress: { phase: "prepare" | "submitting" | "posted" } = { phase: "prepare" };
  const phase = () => progress.phase;
  try {
    return await generateGptImages({
      authPath: request.authPath,
      provider: request.providerId,
      prompt: request.prompt,
      params: {
        model: request.model,
        // background 原生透传（transparent 可用）；没传就不替后端编造缺省值
        ...(request.background !== undefined ? { background: request.background } : {}),
      },
      ...(dataUrls.length > 0 ? { images: dataUrls } : {}),
      mediaRoot: request.mediaRoot,
      timeoutMs: request.timeoutMs ?? DEFAULT_TIMEOUT_MS,
      signal: request.signal,
      fetchImpl: request.fetchImpl,
      proxy: request.proxy,
      onSubmitted: () => {
        progress.phase = "submitting";
        // 钩子自己抛的错（如总闸中途关闭）原样上抛，不降级成 failed
        request.onSubmitted?.();
        progress.phase = "posted";
      },
    });
  } catch (error) {
    if (error instanceof DrawRemoteError) throw error;
    if (phase() === "submitting") throw error;
    if (request.signal?.aborted) throw error; // 宿主取消：AbortError 原样上抛
    const message = errorMessage(error);
    if (message === "gpt_image_no_auth" || message === "gpt_image_bad_auth") {
      throw new DrawRemoteError(
        GPT,
        "unconfigured",
        `draw_remote 未配置：auth.json（${request.authPath}）里没有「${request.providerId}」可用的 OAuth 凭据（需 access 与 accountId），请先 npm run login -- openai-codex`,
        false,
        { cause: error },
      );
    }
    const status = httpStatusOf(error);
    if (status !== undefined) {
      // 400（含通道级开关未开）/ 403 / 413 / 422 / 429 都是后端的确定性回答，没出图
      throw new DrawRemoteError(GPT, "failed", `gpt 生图请求失败（HTTP ${status}）`, status >= 500, { cause: error });
    }
    // 走到这里的 AbortError / TimeoutError 只剩内部请求超时（宿主取消已在上面原样上抛）
    if (isTimeoutError(error) || isAbortError(error)) {
      throw new DrawRemoteError(GPT, "failed", `gpt 生图超时（${request.timeoutMs ?? DEFAULT_TIMEOUT_MS}ms），结果不明`, true, {
        cause: error,
      });
    }
    // 空结果 / 过小的图 / 坏 JSON 都发生在 POST 之后
    throw new DrawRemoteError(GPT, "failed", `gpt 生图失败：${cleanUpstreamText(message, [])}`, phase() === "posted", { cause: error });
  }
}
