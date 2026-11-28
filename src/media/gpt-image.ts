/**
 * GPT Image 生图客户端：走 ChatGPT/Codex 订阅的图片后端。
 *
 * 端点与前缀都和 chat 请求不同，不是 api.openai.com/v1/images：
 *   POST https://chatgpt.com/backend-api/codex/images/generations   （纯文生图）
 *   POST https://chatgpt.com/backend-api/codex/images/edits         （带参考图）
 * 需要的三个额外头（少一个就 4xx）：chatgpt-account-id、originator、x-codex-image-turn-id。
 *
 * 本模块只做透传：参数（size / quality / background / n / output_format / …）原样放进请求体，
 * 不替调用方做取舍。实测后端的实际行为（2026-10）：
 *   - size：不生效，同一 prompt 换三档尺寸都回 1254×1254；画幅由 prompt 的构图描述决定
 *   - quality：不生效，low / high 的 image_tokens 都是 515
 *   - n：不生效，永远回 1 张
 *   - background=transparent：可用，回 RGBA（image_tokens 约 4 倍）
 *   - seed / aspect_ratio / mask / moderation：Codex 后端不支持
 *
 * 凭据复用 config/auth.json 里 `openai-codex` 那条 OAuth（和主模型同一个登录），
 * 快过期就地刷新并写回，不引入新的 key、不进 env、不进日志。
 */
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { join } from "node:path";
import { fileCredentialStore, type OAuthCredential } from "../auth/credentials.ts";
import { refreshTokens } from "../auth/openai.ts";
import { createProxyFetch } from "./proxy-fetch.ts";

const GEN_ENDPOINT = "https://chatgpt.com/backend-api/codex/images/generations";
const EDIT_ENDPOINT = "https://chatgpt.com/backend-api/codex/images/edits";
/** Codex 客户端自称；后端按这个值决定放不放行。 */
const ORIGINATOR = "codex_cli_rs";

export const REMOTE_JSON_MAX_BYTES = 48 * 1024 * 1024;
export const REMOTE_IMAGE_MAX_BYTES = 25 * 1024 * 1024;
export const REMOTE_REF_TOTAL_MAX_BYTES = 20 * 1024 * 1024;

export interface GptImageRequest {
  /** config/auth.json 路径；里面必须有 provider 对应的 OAuth 凭据。 */
  authPath: string;
  /** auth.json 里的凭据条目名（models.image.provider，默认 openai-codex）。 */
  provider: string;
  prompt: string;
  /** 原样透传给图片 API 的字段（model / n / size / quality / background / output_format / …）。 */
  params?: Record<string, unknown>;
  /** 参考图 data URL；给了就走 edits 端点（Codex 最多 5 张）。 */
  images?: string[];
  mediaRoot: string;
  /** 超时，默认 600 秒。 */
  timeoutMs?: number;
  /** 工具超时/宿主取消的合并信号；与请求超时 AbortSignal.any 合并。后端已接受的请求不重 POST。 */
  signal?: AbortSignal;
  /** 分阶段耗时回调（prepare / post / parse）。 */
  onStage?: (event: { stage: "prepare" | "post" | "parse"; ms: number; status?: number; urls?: number }) => void;
  fetchImpl?: typeof fetch;
  /** provider 级代理（只有 OpenAI 需要翻墙时才有意义）；非法值会回落到直连。 */
  proxy?: string;
  /**
   * 同步提交钩子：凭据读取与前置刷新完成之后、发起生成 POST 之前被调用一次（不等待返回值）。
   * 上层据此置 submitted / 发「稍等」；这里抛错 = 请求不发出。
   */
  onSubmitted?: () => void;
}

/** 流式有界读取响应字节：超 content-length 或累计超 maxBytes 立即 cancel 流并抛错。 */
export async function readResponseBytes(response: Response, maxBytes: number, tooBigError: string): Promise<Buffer> {
  const len = Number(response.headers.get("content-length"));
  if (Number.isFinite(len) && len > maxBytes) {
    await response.body?.cancel?.().catch(() => {});
    throw new Error(tooBigError);
  }
  if (response.body && typeof response.body.getReader === "function") {
    const reader = response.body.getReader();
    const chunks: Buffer[] = [];
    let total = 0;
    let doneReading = false;
    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) {
          doneReading = true;
          break;
        }
        const chunk = Buffer.from(value.buffer, value.byteOffset, value.byteLength);
        total += chunk.length;
        if (total > maxBytes) {
          await reader.cancel().catch(() => {});
          doneReading = true;
          throw new Error(tooBigError);
        }
        chunks.push(chunk);
      }
      return Buffer.concat(chunks, total);
    } finally {
      if (!doneReading) await reader.cancel().catch(() => {});
    }
  }
  const buf = Buffer.from(await response.arrayBuffer());
  if (buf.length > maxBytes) throw new Error(tooBigError);
  return buf;
}

/** 有界读取错误响应摘要并释放流连接，避免 !ok 返回超大 HTML 撑爆内存。 */
export async function readErrorText(response: Response, maxBytes = 64 * 1024): Promise<string> {
  try {
    if (response.body && typeof response.body.getReader === "function") {
      const reader = response.body.getReader();
      const chunks: Buffer[] = [];
      let total = 0;
      let doneReading = false;
      try {
        while (total < maxBytes) {
          const { done, value } = await reader.read();
          if (done) {
            doneReading = true;
            break;
          }
          const take = Math.min(value.byteLength, maxBytes - total);
          chunks.push(Buffer.from(value.buffer, value.byteOffset, take));
          total += take;
          if (total >= maxBytes) break;
        }
        return Buffer.concat(chunks, total).toString("utf8");
      } finally {
        if (!doneReading) await reader.cancel().catch(() => {});
      }
    }
    await response.body?.cancel?.().catch(() => {});
    return await response.text().catch(() => "");
  } catch {
    return "";
  }
}

/** HTTP 非 2xx：消息保留旧格式（`gpt_image_http_<status>`），状态码另挂到 status 供上层判 4xx/5xx。 */
function httpError(message: string, status: number): Error {
  return Object.assign(new Error(message), { status });
}

/** 出图成功返回相对 mediaRoot 的引用列表（gen/xxx.png）；失败抛错，错误里不带凭据。 */
export async function generateGptImages(request: GptImageRequest): Promise<string[]> {
  const prepareStart = Date.now();
  const timeout = AbortSignal.timeout(request.timeoutMs ?? 600_000);
  const combinedSignal = request.signal ? AbortSignal.any([timeout, request.signal]) : timeout;
  combinedSignal.throwIfAborted();

  // provider 级代理：只影响这一次生图（含 token 刷新），不碰 globalThis.fetch
  const doFetch = request.fetchImpl ?? (request.proxy ? createProxyFetch(request.proxy) : undefined) ?? fetch;
  const store = fileCredentialStore(request.authPath);
  const raw = await store.read(request.provider);
  if (!raw || raw.type !== "oauth") throw new Error("gpt_image_no_auth");
  let credential = raw as OAuthCredential;
  if (typeof credential.access !== "string" || typeof credential.accountId !== "string") {
    throw new Error("gpt_image_bad_auth");
  }

  // 提前一分钟刷新：生图一次十几秒，别让 token 在请求途中过期。
  // 刷新整段放在 modify 回调里（跨进程锁内）并在锁里复核过期时间：并发请求 / 进程只刷新一次，
  // 不会把已经轮换掉的 refresh token 再用一遍，也不会拿旧快照盖掉别人刚写的凭据。
  if (!(Number(credential.expires) - Date.now() >= 60_000)) {
    const post = await store.modify(
      request.provider,
      async (current) => {
        if (!current || current.type !== "oauth") return undefined;
        const latest = current as OAuthCredential;
        if (Number(latest.expires) - Date.now() >= 60_000) return undefined; // 别人刚刷新过
        return await refreshTokens(latest, combinedSignal, doFetch);
      },
      { signal: combinedSignal },
    );
    if (!post || post.type !== "oauth") throw new Error("gpt_image_no_auth");
    credential = post as OAuthCredential;
    if (typeof credential.access !== "string" || typeof credential.accountId !== "string") {
      throw new Error("gpt_image_bad_auth");
    }
  }
  request.onStage?.({ stage: "prepare", ms: Date.now() - prepareStart });

  // prompt 以 request.prompt 为准；params 里其余字段原样透传（model 由调用方按 models.image 填）
  const { prompt: _ignored, model, ...rest } = (request.params ?? {}) as Record<string, unknown> & {
    prompt?: unknown;
    model?: unknown;
  };
  const body: Record<string, unknown> = {
    ...(typeof model === "string" && model.trim().length > 0 ? { model: model.trim() } : {}),
    prompt: request.prompt,
    ...rest,
  };
  if (request.images && request.images.length > 0) {
    body["images"] = request.images.map((image_url) => ({ image_url }));
  }

  // 已取消或超时就不发请求、不触发提交钩子
  combinedSignal.throwIfAborted();
  request.onSubmitted?.();
  const postStart = Date.now();
  const response = await doFetch(request.images && request.images.length > 0 ? EDIT_ENDPOINT : GEN_ENDPOINT, {
    method: "POST",
    headers: {
      authorization: `Bearer ${credential.access}`,
      "chatgpt-account-id": credential.accountId,
      originator: ORIGINATOR,
      "x-codex-image-turn-id": randomUUID(),
      "content-type": "application/json",
      accept: "application/json",
    },
    body: JSON.stringify(body),
    signal: combinedSignal,
  });
  request.onStage?.({ stage: "post", ms: Date.now() - postStart, status: response.status });

  if (!response.ok) {
    // 400 + 这句 = 通道级开关没开（Codex 订阅后端 2026-11 实测：换任何 2.6 型号都一样），
    // 不是参数写错。单独抛一个码，让工具层回一句人话，别让模型反复重试。
    const detail = await readErrorText(response);
    if (response.status === 400 && detail.includes("GIF output is not enabled")) {
      throw httpError("gpt_image_gif_off", response.status);
    }
    throw httpError(`gpt_image_http_${response.status}`, response.status);
  }
  const parseStart = Date.now();
  const rawJson = await readResponseBytes(response, REMOTE_JSON_MAX_BYTES, "gpt_image_response_too_large");
  const parsed = JSON.parse(rawJson.toString("utf8")) as { data?: { b64_json?: string }[] };
  const entries = (parsed.data ?? []).filter((item) => typeof item.b64_json === "string");
  request.onStage?.({ stage: "parse", ms: Date.now() - parseStart, urls: entries.length });
  if (entries.length === 0) throw new Error("gpt_image_empty");

  // 取消后不落盘，且全部解码校验通过后再统一落盘；异常时回滚删已写文件
  combinedSignal.throwIfAborted();
  const decoded = entries.map((entry) => {
    const bytes = Buffer.from(entry.b64_json as string, "base64");
    if (bytes.length < 1024) throw new Error("gpt_image_too_small");
    return bytes;
  });

  const outDir = join(request.mediaRoot, "gen");
  mkdirSync(outDir, { recursive: true });
  const files: string[] = [];
  try {
    for (const bytes of decoded) {
      combinedSignal.throwIfAborted();
      const file = `${Date.now()}-${randomUUID().slice(0, 8)}.${extensionOf(bytes)}`;
      writeFileSync(join(outDir, file), bytes);
      files.push(file);
    }
    return files;
  } catch (err) {
    for (const file of files) rmSync(join(outDir, file), { force: true });
    throw err;
  }
}

/** 落盘后缀按真实字节判断，不看请求里的 output_format（后端可能不认）。 */
export function extensionOf(bytes: Buffer): "png" | "jpg" | "webp" | "gif" {
  if (bytes.subarray(0, 8).toString("hex") === "89504e470d0a1a0a") return "png";
  if (bytes.subarray(0, 3).toString("hex") === "ffd8ff") return "jpg";
  if (bytes.subarray(0, 4).toString("ascii") === "RIFF" && bytes.subarray(8, 12).toString("ascii") === "WEBP") return "webp";
  // 动图（GPT Image 2.6 的 output_format=gif）：按 GIF87a/GIF89a 魔数认，否则会存成 .png
  // 导致 say_media 用 image/png 发出去、QQ 侧显示成破图
  if (bytes.subarray(0, 4).toString("ascii") === "GIF8") return "gif";
  return "png";
}
