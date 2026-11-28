/**
 * Gemini 远程文生图 / 改图客户端：走标准 Gemini Generative Language API（兼容 CLIProxyAPI 与官方端点）。
 *
 * 协议：
 *   POST {baseUrl}/models/{encodeURIComponent(model)}:generateContent
 *   头：content-type: application/json、x-goog-api-key: <apiKey>
 *   体：{ contents: [{ role: "user", parts: [参考图 inlineData…, { text }] }],
 *         generationConfig: { responseModalities: ["IMAGE", "TEXT"], imageConfig?: { aspectRatio } } }
 *
 * onSubmitted 只在入参校验通过后、生成 POST 之前同步调用一次；宿主取消（AbortSignal）原样抛 AbortError。
 */
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { join } from "node:path";
import { readCredentialFile } from "../../model/config.ts";
import { extensionOf, readErrorText, readResponseBytes, REMOTE_JSON_MAX_BYTES } from "../gpt-image.ts";
import { createProxyFetch } from "../proxy-fetch.ts";
import { cleanUpstreamText, collectSecrets } from "./redact.ts";
import {
  DRAW_REMOTE_TIMEOUT_MS,
  DrawRemoteError,
  errorMessage,
  formatTimeoutLabel,
  isAbortError,
  isTimeoutError,
  isValidHttpUrl,
} from "./types.ts";
import type { DrawRemoteAspectRatio, DrawRemoteChannelRequest, DrawRemoteReferenceImage, DrawRemoteStageEvent } from "./types.ts";

/** 小于这个体积的 inlineData 当不成图（截断的包 / 占位图），拒落盘。 */
const MIN_IMAGE_BYTES = 1024;
const DEFAULT_TIMEOUT_MS = DRAW_REMOTE_TIMEOUT_MS;
const GEMINI = "gemini" as const;

export interface GeminiImageRequest {
  /** 标准 Gemini API 基址（含 /v1beta，如 http://cliproxyapi:8317/v1beta）。尾斜杠自动剥除。 */
  baseUrl: string;
  /** 静态 API key（经 x-goog-api-key 请求头透传）。 */
  apiKey: string;
  model: string;
  prompt: string;
  images?: readonly DrawRemoteReferenceImage[];
  aspectRatio?: DrawRemoteAspectRatio;
  mediaRoot: string;
  /** 同步提交钩子：生成 POST 之前调用一次；这里抛错 = 请求不发出。 */
  onSubmitted?: () => void;
  /** 单次生成请求超时，缺省 600 秒。 */
  timeoutMs?: number;
  signal?: AbortSignal;
  onStage?: (event: DrawRemoteStageEvent) => void;
  fetchImpl?: typeof fetch;
  /** provider 级代理；非法值回落直连。 */
  proxy?: string;
}

interface GeminiInlineData {
  mimeType?: unknown;
  mime_type?: unknown;
  data?: unknown;
}

interface GeminiInlinePart {
  inlineData?: GeminiInlineData;
  inline_data?: GeminiInlineData;
  text?: unknown;
}

interface GeminiEnvelope {
  response?: {
    candidates?: Array<{ content?: { parts?: GeminiInlinePart[] }; finishReason?: unknown }>;
    promptFeedback?: { blockReason?: unknown };
    error?: { message?: unknown };
  };
  candidates?: Array<{ content?: { parts?: GeminiInlinePart[] }; finishReason?: unknown }>;
  promptFeedback?: { blockReason?: unknown };
  error?: { message?: unknown };
}

function textOf(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

export async function generateGeminiImage(request: GeminiImageRequest): Promise<string[]> {
  const prepareStart = Date.now();
  const signal = request.signal;
  signal?.throwIfAborted();

  const timeoutMs = request.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const merged = signal ? AbortSignal.any([AbortSignal.timeout(timeoutMs), signal]) : AbortSignal.timeout(timeoutMs);

  const fail = (message: string, submitted: boolean, cause?: unknown): DrawRemoteError =>
    new DrawRemoteError(GEMINI, "failed", message, submitted, cause === undefined ? undefined : { cause });
  const unconfigured = (message: string): DrawRemoteError => new DrawRemoteError(GEMINI, "unconfigured", message, false);

  if (!isValidHttpUrl(request.baseUrl)) {
    throw unconfigured("draw_remote 未配置：models.json 缺少合法的 gemini baseUrl");
  }
  const apiKey = request.apiKey.trim();
  if (!apiKey) {
    throw unconfigured("draw_remote 未配置：auth.json 缺少有效的 gemini API key");
  }
  const baseUrl = request.baseUrl.trim().replace(/\/+$/, "");
  const normalizedModel = request.model.trim().replace(/^models\//i, "");
  const endpoint = `${baseUrl}/models/${encodeURIComponent(normalizedModel)}:generateContent`;

  const doFetch = request.fetchImpl ?? (request.proxy ? createProxyFetch(request.proxy) : undefined) ?? fetch;
  const secrets = collectSecrets({ key: apiKey });
  const clean = (value: string) => cleanUpstreamText(value, secrets);

  /** POST 之后的异常统一在这里定级：宿主取消原样上抛，其余（超时 / 断网 / 坏包）一律结果不明。 */
  const afterPost = (error: unknown, what: string): unknown => {
    if (signal?.aborted) return error;
    if (isTimeoutError(error) || isAbortError(error)) return fail(`gemini ${what}超时（${formatTimeoutLabel(timeoutMs)}），结果不明`, true, error);
    return fail(`gemini ${what}失败：${clean(errorMessage(error))}`, true, error);
  };
  const rethrowIfAborted = (): void => {
    if (merged.aborted) throw afterPost(merged.reason, "读取响应");
  };

  const parts: Record<string, unknown>[] = [
    ...(request.images ?? []).map((image) => ({
      inlineData: { mimeType: image.mimeType, data: image.bytes.toString("base64") },
    })),
    { text: request.prompt },
  ];
  const payload = JSON.stringify({
    contents: [{ role: "user", parts }],
    generationConfig: {
      responseModalities: ["IMAGE", "TEXT"],
      ...(request.aspectRatio ? { imageConfig: { aspectRatio: request.aspectRatio } } : {}),
    },
  });

  request.onStage?.({ stage: "prepare", ms: Date.now() - prepareStart });

  // 提交前再次确认未中止/未超时，再调用 onSubmitted
  merged.throwIfAborted();
  request.onSubmitted?.();

  const postStart = Date.now();
  let response: Response;
  try {
    response = await doFetch(endpoint, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-goog-api-key": apiKey,
      },
      body: payload,
      signal: merged,
    });
  } catch (error) {
    throw afterPost(error, "生图请求");
  }
  request.onStage?.({ stage: "post", ms: Date.now() - postStart, status: response.status });

  if (!response.ok) {
    const detail = await readErrorText(response);
    const cleaned = detail.trim() ? clean(detail) : "";
    throw fail(
      `gemini 生图请求失败（HTTP ${response.status}）${cleaned ? `：${cleaned}` : ""}`,
      response.status >= 500,
    );
  }

  const parseStart = Date.now();
  let json: unknown;
  try {
    const rawJson = await readResponseBytes(response, REMOTE_JSON_MAX_BYTES, "gemini_response_too_large");
    json = JSON.parse(rawJson.toString("utf8"));
  } catch (error) {
    throw afterPost(error, "读取响应");
  }
  rethrowIfAborted();

  const envelope = (json && typeof json === "object" ? json : {}) as GeminiEnvelope;
  const candidate = (envelope.response?.candidates ?? envelope.candidates)?.[0];
  const responseParts = Array.isArray(candidate?.content?.parts) ? candidate.content.parts : [];
  const images = responseParts
    .map((part) => (part && typeof part === "object" ? part.inlineData ?? part.inline_data : undefined))
    .filter((item): item is GeminiInlineData & { data: string } => typeof item?.data === "string" && item.data.length > 0);
  request.onStage?.({ stage: "parse", ms: Date.now() - parseStart, urls: images.length });

  if (images.length === 0) {
    const blockReason = textOf(envelope.response?.promptFeedback?.blockReason) || textOf(envelope.promptFeedback?.blockReason);
    const finishReason = textOf(candidate?.finishReason);
    const apiError = textOf(envelope.response?.error?.message) || textOf(envelope.error?.message);
    const reply = responseParts.map((part) => (part && typeof part === "object" ? textOf(part.text) : "")).filter(Boolean).join(" ");
    const explicit = Boolean(blockReason || finishReason || apiError || reply);
    const detail = [blockReason && `blockReason=${blockReason}`, finishReason && `finishReason=${finishReason}`, apiError, reply]
      .filter(Boolean)
      .join(" | ");
    throw fail(
      `gemini 没有返回图片（${explicit ? "上游明确答复，未出图" : "异常空响应，结果不明"}）${detail ? `：${clean(detail)}` : ""}`,
      !explicit,
    );
  }

  const decoded = images.map((image) => Buffer.from(image.data, "base64"));
  const small = decoded.findIndex((bytes) => bytes.length < MIN_IMAGE_BYTES);
  if (small >= 0) {
    throw fail(`gemini 返回的第 ${small + 1} 张图小于 ${MIN_IMAGE_BYTES} 字节，不是可用图片数据，未落盘`, true);
  }
  rethrowIfAborted();
  const dir = join(request.mediaRoot, "gen");
  mkdirSync(dir, { recursive: true });
  const files: string[] = [];
  try {
    for (const bytes of decoded) {
      rethrowIfAborted();
      const file = `${Date.now()}-${randomUUID()}.${extensionOf(bytes)}`;
      writeFileSync(join(dir, file), bytes, { flag: "wx" });
      files.push(file);
    }
    return files;
  } catch (err) {
    for (const file of files) rmSync(join(dir, file), { force: true });
    throw err;
  }
}

/** runDrawRemote 的 gemini 通道：校验 baseUrl 与 auth.json 的 API key，转交 generateGeminiImage。 */
export async function runGeminiChannel(request: DrawRemoteChannelRequest): Promise<string[]> {
  const baseUrl = (request.baseUrl ?? "").trim();
  if (!isValidHttpUrl(baseUrl)) {
    throw new DrawRemoteError(
      GEMINI,
      "unconfigured",
      `draw_remote 未配置：models.json 的 provider「${request.providerId}」缺少合法 baseUrl（gemini 通道要用它拼标准生图接口）`,
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
      GEMINI,
      "unconfigured",
      `draw_remote 未配置：auth.json 缺少「${request.providerId}」的 API key`,
      false,
    );
  }
  return generateGeminiImage({
    baseUrl,
    apiKey,
    model: request.model,
    prompt: request.prompt,
    images: request.images,
    aspectRatio: request.aspectRatio,
    mediaRoot: request.mediaRoot,
    onSubmitted: request.onSubmitted,
    timeoutMs: request.timeoutMs,
    signal: request.signal,
    onStage: request.onStage,
    fetchImpl: request.fetchImpl,
    proxy: request.proxy,
  });
}
