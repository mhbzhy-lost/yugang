/**
 * draw_remote 的 gpt 通道：包一层 generateGptImages（Codex 订阅的图片后端）。
 *
 * 职责只有三件：把参考图拼成 data URL 交给 /edits；把「已提交」的阶段记准；把底层错误翻译成
 * DrawRemoteError——缺凭据是 unconfigured，HTTP 4xx 是确定性拒绝（submitted=false），
 * 5xx / 超时 / POST 之后的异常结果不明（submitted=true）。aspectRatio 不透传：Codex 图片后端
 * 没有这个字段，构图靠提示词。
 *
 * 错误文案会经工具回执原样到模型：只点名缺的是哪个来源（models.json 的 provider / auth.json 的凭据），
 * 不带本机绝对路径与运维命令；上游正文（含前置刷新失败的 token 端点回复）先按这条通道的凭据脱敏。
 */
import { fileCredentialStore } from "../../auth/credentials.ts";
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
} from "./types.ts";
import type { DrawRemoteChannelRequest } from "./types.ts";

const GPT = "gpt" as const;
const DEFAULT_TIMEOUT_MS = DRAW_REMOTE_TIMEOUT_MS;

export async function runGptChannel(request: DrawRemoteChannelRequest): Promise<string[]> {
  const totalRefBytes = (request.images ?? []).reduce((sum, image) => sum + image.bytes.length, 0);
  if (totalRefBytes > REMOTE_REF_TOTAL_MAX_BYTES) {
    throw new DrawRemoteError(GPT, "bad_ref", "gpt 参考图总大小超过 20MB 上限，请减少张数或压缩后再试", false);
  }
  const dataUrls = (request.images ?? []).map((image) => `data:${image.mimeType};base64,${image.bytes.toString("base64")}`);
  // 脱敏名单：这条通道在 auth.json 里的凭据（access / refresh / clientSecret）。前置刷新失败时 token 端点的
  // 正文可能回显它们；读不出就不收（随后的凭据校验会报 unconfigured）
  const secrets = await fileCredentialStore(request.authPath)
    .read(request.providerId)
    .then((stored) => collectSecrets(stored), () => []);
  // prepare：还没调提交钩子；submitting：钩子在跑；posted：钩子跑完，之后的第一件事就是生成 POST。
  // 用对象装着：钩子在闭包里改它，裸变量会被控制流分析误判成恒为 prepare
  const progress: { phase: "prepare" | "submitting" | "posted" } = { phase: "prepare" };
  const phase = () => progress.phase;
  try {
    return await generateGptImages({
      authPath: request.authPath,
      provider: request.providerId,
      prompt: request.prompt,
      // params 只传 model：不替后端编造 size / quality / background 等字段的缺省值
      params: { model: request.model },
      ...(dataUrls.length > 0 ? { images: dataUrls } : {}),
      mediaRoot: request.mediaRoot,
      timeoutMs: request.timeoutMs ?? DEFAULT_TIMEOUT_MS,
      signal: request.signal,
      onStage: request.onStage,
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
        `draw_remote 未配置：auth.json 缺少「${request.providerId}」的 OAuth 凭据`,
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
      throw new DrawRemoteError(GPT, "failed", `gpt 生图超时（${formatTimeoutLabel(request.timeoutMs ?? DEFAULT_TIMEOUT_MS)}），结果不明`, phase() === "posted", {
        cause: error,
      });
    }
    // 走到这里的其余错误只发生在两处：提交前（凭据读取 / 前置 OAuth 刷新）或 POST 之后（空结果 / 过小的图 / 坏 JSON）。
    // 文案按阶段说清是哪一种，submitted 跟着阶段走
    const posted = phase() === "posted";
    throw new DrawRemoteError(GPT, "failed", `gpt ${posted ? "生图失败" : "前置准备失败"}：${cleanUpstreamText(message, secrets)}`, posted, {
      cause: error,
    });
  }
}
