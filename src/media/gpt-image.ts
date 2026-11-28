/**
 * GPT Image 生图客户端：走标准 OpenAI Images API（兼容 CLIProxyAPI 与 OpenAI 官方接口）。
 *
 * 端点：
 *   POST ${baseUrl}/images/generations   （纯文生图，JSON 体）
 *   POST ${baseUrl}/images/edits         （带参考图，multipart/form-data FormData）
 * 鉴权：标准 `Authorization: Bearer <apiKey>`（不带任何 ChatGPT/Codex OAuth 私有头）。
 */
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { join } from "node:path";
import { createProxyFetch } from "./proxy-fetch.ts";
import { collectSecrets, redactSecrets } from "./draw-remote/redact.ts";
import { isValidHttpUrl } from "./draw-remote/types.ts";

export const REMOTE_JSON_MAX_BYTES = 48 * 1024 * 1024;
export const REMOTE_IMAGE_MAX_BYTES = 25 * 1024 * 1024;
export const REMOTE_REF_TOTAL_MAX_BYTES = 20 * 1024 * 1024;

export interface GptImageInput {
  mimeType: string;
  bytes: Buffer;
}

export interface GptImageRequest {
  /** 标准 OpenAI API 基址（如 http://cliproxyapi:8317/v1 或 https://api.openai.com/v1）。 */
  baseUrl: string;
  /** 静态 API key（经 Authorization: Bearer 透传）。 */
  apiKey: string;
  prompt: string;
  /** 原样透传给图片 API 的字段（model / n / size / quality / background / output_format / …）。 */
  params?: Record<string, unknown>;
  /** 参考图原始字节；给了就走 /images/edits multipart/form-data。 */
  images?: readonly GptImageInput[];
  mediaRoot: string;
  /** 超时，默认 600 秒。 */
  timeoutMs?: number;
  /** 工具超时/宿主取消的合并信号；与请求超时 AbortSignal.any 合并。后端已接受的请求不重 POST。 */
  signal?: AbortSignal;
  /** 分阶段耗时回调（prepare / post / parse）。 */
  onStage?: (event: { stage: "prepare" | "post" | "parse"; ms: number; status?: number; urls?: number }) => void;
  fetchImpl?: typeof fetch;
  /** provider 级代理；非法值会回落到直连。 */
  proxy?: string;
  /**
   * 同步提交钩子：前置校验完成之后、发起生成 POST 之前被调用一次（不等待返回值）。
   * 上层据此置 submitted；这里抛错 = 请求不发出。
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

/** HTTP 非 2xx：消息保留 `gpt_image_http_<status>` 前缀并附已脱敏的上游摘要，状态码挂到 status 供上层判 4xx/5xx。 */
function httpError(message: string, status: number): Error {
  return Object.assign(new Error(message), { status });
}

/** 出图成功返回相对 mediaRoot/gen 的裸文件名列表；失败抛错，错误里不带凭据。 */
export async function generateGptImages(request: GptImageRequest): Promise<string[]> {
  const prepareStart = Date.now();
  const timeout = AbortSignal.timeout(request.timeoutMs ?? 600_000);
  const combinedSignal = request.signal ? AbortSignal.any([timeout, request.signal]) : timeout;
  combinedSignal.throwIfAborted();

  if (!isValidHttpUrl(request.baseUrl)) throw new Error("gpt_image_bad_base_url");
  const apiKey = request.apiKey.trim();
  if (!apiKey) throw new Error("gpt_image_no_auth");
  const base = request.baseUrl.trim().replace(/\/+$/, "");

  // provider 级代理：只影响这一次生图，不碰 globalThis.fetch
  const doFetch = request.fetchImpl ?? (request.proxy ? createProxyFetch(request.proxy) : undefined) ?? fetch;

  const { prompt: _ignored, model, ...rest } = (request.params ?? {}) as Record<string, unknown> & {
    prompt?: unknown;
    model?: unknown;
  };
  const trimmedModel = typeof model === "string" && model.trim().length > 0 ? model.trim() : undefined;
  const hasImages = Boolean(request.images && request.images.length > 0);

  let endpoint: string;
  let headers: Record<string, string>;
  let body: string | FormData;

  if (hasImages) {
    endpoint = `${base}/images/edits`;
    const form = new FormData();
    if (trimmedModel) form.append("model", trimmedModel);
    form.append("prompt", request.prompt);
    for (const [key, value] of Object.entries(rest)) {
      if (value === undefined || value === null) continue;
      form.append(key, typeof value === "string" ? value : String(value));
    }
    const imgs = request.images!;
    const fieldName = imgs.length === 1 ? "image" : "image[]";
    imgs.forEach((img, index) => {
      const ext = extensionOf(img.bytes);
      form.append(fieldName, new Blob([new Uint8Array(img.bytes)], { type: img.mimeType }), `ref-${index}.${ext}`);
    });
    // FormData 绝不手工设置 content-type，让 fetch / proxy-fetch 自动带 multipart boundary
    headers = {
      authorization: `Bearer ${apiKey}`,
      accept: "application/json",
    };
    body = form;
  } else {
    endpoint = `${base}/images/generations`;
    const jsonBody: Record<string, unknown> = {
      ...(trimmedModel ? { model: trimmedModel } : {}),
      prompt: request.prompt,
      ...rest,
    };
    headers = {
      authorization: `Bearer ${apiKey}`,
      "content-type": "application/json",
      accept: "application/json",
    };
    body = JSON.stringify(jsonBody);
  }

  request.onStage?.({ stage: "prepare", ms: Date.now() - prepareStart });

  // 已取消或超时就不发请求、不触发提交钩子
  combinedSignal.throwIfAborted();
  request.onSubmitted?.();
  const postStart = Date.now();
  const response = await doFetch(endpoint, {
    method: "POST",
    headers,
    body,
    signal: combinedSignal,
  });
  request.onStage?.({ stage: "post", ms: Date.now() - postStart, status: response.status });

  if (!response.ok) {
    const rawDetail = await readErrorText(response);
    // 用 collectSecrets（≥6 字符才替换）防占位短 key 如 "local" 误伤 "localhost"
    const safeDetail = redactSecrets(rawDetail, collectSecrets({ key: apiKey })).trim();
    throw httpError(
      safeDetail ? `gpt_image_http_${response.status}: ${safeDetail}` : `gpt_image_http_${response.status}`,
      response.status,
    );
  }

  const parseStart = Date.now();
  const rawJson = await readResponseBytes(response, REMOTE_JSON_MAX_BYTES, "gpt_image_response_too_large");
  const parsed = JSON.parse(rawJson.toString("utf8")) as { data?: unknown } | null;
  const rawData = parsed && typeof parsed === "object" && Array.isArray(parsed.data) ? parsed.data : [];
  const entries = rawData.filter(
    (item): item is { b64_json: string } =>
      Boolean(item) && typeof item === "object" && typeof (item as { b64_json?: unknown }).b64_json === "string",
  );
  request.onStage?.({ stage: "parse", ms: Date.now() - parseStart, urls: entries.length });
  if (entries.length === 0) throw new Error("gpt_image_empty");

  // 取消后不落盘，且全部解码校验通过后再统一落盘；异常时回滚删已写文件
  combinedSignal.throwIfAborted();
  const decoded = entries.map((entry) => {
    const bytes = Buffer.from(entry.b64_json, "base64");
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
      writeFileSync(join(outDir, file), bytes, { flag: "wx" });
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
  if (bytes.subarray(0, 4).toString("ascii") === "GIF8") return "gif";
  return "png";
}
