/**
 * gemini-3.1-flash-image（Google AI Pro 订阅的 Antigravity 通道）文生图 / 改图客户端。
 *
 * 协议 2026-11-25 在线实测定版（spec §5）：
 *   POST {baseUrl}/v1internal:generateContent
 *   头：content-type: application/json、authorization: Bearer <access>、
 *       user-agent: <provider.userAgent || antigravityUserAgent()>
 *   体：{ project, model, userAgent: "antigravity", requestId,
 *         request: { contents: [{ role: "user", parts: [参考图 inlineData…, { text }] }],
 *                    generationConfig: { responseModalities: ["IMAGE", "TEXT"], imageConfig?: { aspectRatio } } } }
 *
 * projectId 优先取 auth.json 里凭据自带的 projectId，缺失时按同一 baseUrl / userAgent 走
 * discoverProject 兜底（结果只留内存，持久化是登录脚本的事）。
 *
 * OAuth：过期前 60 秒内在凭据文件锁内复查并刷新（并发只刷一次，projectId / tier / email 原样带回）；
 * 没过期但首调 401，则在锁内按 usedAccess 复查——别的请求已经换过 token 就直接复用，否则强刷一次，
 * 最多重试一次。
 *
 * onSubmitted 只在凭据 / projectId 就绪之后、首个生成 POST 之前同步调用一次（401 重试不重复）。
 * 前置刷新失败不触发它，报 failed / submitted=false。宿主取消（AbortSignal）原样抛 AbortError。
 */
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { join } from "node:path";
import { fileCredentialStore, type OAuthCredential } from "../../auth/credentials.ts";
import { refreshTokens as refreshGoogleTokens } from "../../auth/google.ts";
import { ANTIGRAVITY_BASE_URL, antigravityUserAgent, discoverProject } from "../../model/google-code-assist.ts";
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
} from "./types.ts";
import type { DrawRemoteAspectRatio, DrawRemoteChannelRequest, DrawRemoteReferenceImage, DrawRemoteStageEvent } from "./types.ts";

/** 过期前这么多毫秒之内就提前刷新。 */
const REFRESH_AHEAD_MS = 60_000;
/** 小于这个体积的 inlineData 当不成图（截断的包 / 占位图），拒落盘。 */
const MIN_IMAGE_BYTES = 1024;
const DEFAULT_TIMEOUT_MS = DRAW_REMOTE_TIMEOUT_MS;
const GEMINI = "gemini" as const;

export interface GeminiImageRequest {
  /** config/auth.json 路径；里面必须有 provider 对应的 OAuth 凭据。 */
  authPath: string;
  /** auth.json 里的凭据条目名（models.json 的 provider 同名，缺省 google-antigravity）。 */
  provider: string;
  /** 覆盖端点；缺省 ANTIGRAVITY_BASE_URL（daily 桶）。尾斜杠去掉。 */
  baseUrl?: string;
  /** 完整 User-Agent 覆盖；缺省当前 IDE 指纹。 */
  userAgent?: string;
  model: string;
  prompt: string;
  images?: readonly DrawRemoteReferenceImage[];
  aspectRatio?: DrawRemoteAspectRatio;
  mediaRoot: string;
  /** 同步提交钩子：首个生成 POST 之前调用一次；这里抛错 = 请求不发出。 */
  onSubmitted?: () => void;
  /** 单次生成请求超时，缺省 600 秒。 */
  timeoutMs?: number;
  signal?: AbortSignal;
  onStage?: (event: DrawRemoteStageEvent) => void;
  fetchImpl?: typeof fetch;
  /** provider 级代理；非法值回落直连。 */
  proxy?: string;
}

interface GeminiInlinePart {
  inlineData?: { mimeType?: unknown; data?: unknown };
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

function asOAuth(value: unknown): OAuthCredential | undefined {
  if (!value || typeof value !== "object") return undefined;
  const record = value as Partial<OAuthCredential>;
  if (record.type !== "oauth") return undefined;
  if (typeof record.access !== "string" || record.access === "") return undefined;
  if (typeof record.refresh !== "string" || record.refresh === "") return undefined;
  return record as OAuthCredential;
}

function textOf(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

export async function generateGeminiImage(request: GeminiImageRequest): Promise<string[]> {
  const prepareStart = Date.now();
  const baseUrl = (request.baseUrl?.trim() || ANTIGRAVITY_BASE_URL).replace(/\/+$/, "");
  const userAgent = request.userAgent?.trim() || antigravityUserAgent();
  const doFetch = request.fetchImpl ?? (request.proxy ? createProxyFetch(request.proxy) : undefined) ?? fetch;
  const timeoutMs = request.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const signal = request.signal;
  const store = fileCredentialStore(request.authPath);
  // 见过的每一版凭据都进脱敏名单：刷新前的旧 token 也可能被上游回显
  const seen: OAuthCredential[] = [];
  const secrets = () => collectSecrets(...seen);
  const clean = (value: string) => cleanUpstreamText(value, secrets());

  signal?.throwIfAborted();
  const merged = signal ? AbortSignal.any([AbortSignal.timeout(timeoutMs), signal]) : AbortSignal.timeout(timeoutMs);

  const fail = (message: string, submitted: boolean, cause?: unknown): DrawRemoteError =>
    new DrawRemoteError(GEMINI, "failed", message, submitted, cause === undefined ? undefined : { cause });
  const unconfigured = (message: string): DrawRemoteError => new DrawRemoteError(GEMINI, "unconfigured", message, false);
  // 错误文案会经工具回执原样到模型：只点名缺的是哪个来源，不带本机绝对路径与运维命令
  const noCredential = () => unconfigured(`draw_remote 未配置：auth.json 缺少「${request.provider}」的 OAuth 凭据`);

  let credential = asOAuth(await store.read(request.provider));
  if (!credential) throw noCredential();
  seen.push(credential);

  /** 锁内刷新：回调返回 undefined = 这条不动（别的请求 / 进程刚刷新过），store 会把当前值交回来。 */
  const refreshInLock = async (stale: (latest: OAuthCredential) => boolean, label: string): Promise<OAuthCredential> => {
    try {
      const next = await store.modify(
        request.provider,
        async (current) => {
          const latest = asOAuth(current);
          if (!latest || !stale(latest)) return undefined;
          return refreshGoogleTokens(latest, merged, doFetch);
        },
        { signal: merged },
      );
      const refreshed = asOAuth(next);
      if (!refreshed) throw noCredential();
      seen.push(refreshed);
      return refreshed;
    } catch (error) {
      if (error instanceof DrawRemoteError) throw error;
      if (signal?.aborted) throw error;
      throw fail(`gemini ${label}失败：${clean(errorMessage(error))}`, false, error);
    }
  };

  // 过期（或 expires 读不出）就先刷新：锁里再核一次 expires，并发只刷一次
  if (!(Number(credential.expires) - Date.now() >= REFRESH_AHEAD_MS)) {
    credential = await refreshInLock(
      (latest) => !(Number(latest.expires) - Date.now() >= REFRESH_AHEAD_MS),
      "过期前 OAuth 刷新",
    );
  }

  let projectId = typeof credential.projectId === "string" ? credential.projectId.trim() : "";
  if (!projectId) {
    let reason = "";
    try {
      const found = await discoverProject(credential.access, "antigravity", doFetch, merged, { baseUrl, userAgent });
      projectId = typeof found.projectId === "string" ? found.projectId.trim() : "";
    } catch (error) {
      if (signal?.aborted) throw error;
      reason = clean(errorMessage(error));
    }
    if (!projectId) {
      throw unconfigured(
        `draw_remote 未配置：auth.json 的「${request.provider}」凭据缺少 projectId（loadCodeAssist 兜底未查到${reason ? `：${reason}` : ""}）`,
      );
    }
  }
  /** POST 之后的异常统一在这里定级：宿主取消原样上抛，其余（超时 / 断网 / 坏包）一律结果不明。 */
  const afterPost = (error: unknown, what: string): unknown => {
    if (signal?.aborted) return error;
    // 走到这里的 AbortError / TimeoutError 只剩内部请求超时
    if (isTimeoutError(error) || isAbortError(error)) return fail(`gemini ${what}超时（${formatTimeoutLabel(timeoutMs)}），结果不明`, true, error);
    return fail(`gemini ${what}失败：${clean(errorMessage(error))}`, true, error);
  };
  const rethrowIfAborted = (): void => {
    if (merged.aborted) throw afterPost(merged.reason, "读取响应");
  };

  const post = async (access: string): Promise<Response> => {
    const parts: Record<string, unknown>[] = [
      ...(request.images ?? []).map((image) => ({
        inlineData: { mimeType: image.mimeType, data: image.bytes.toString("base64") },
      })),
      { text: request.prompt },
    ];
    return doFetch(`${baseUrl}/v1internal:generateContent`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${access}`,
        "user-agent": userAgent,
      },
      body: JSON.stringify({
        project: projectId,
        model: request.model,
        userAgent: "antigravity",
        requestId: randomUUID(),
        request: {
          contents: [{ role: "user", parts }],
          generationConfig: {
            responseModalities: ["IMAGE", "TEXT"],
            ...(request.aspectRatio ? { imageConfig: { aspectRatio: request.aspectRatio } } : {}),
          },
        },
      }),
      signal: merged,
    });
  };

  request.onStage?.({ stage: "prepare", ms: Date.now() - prepareStart });

  // 提交钩子：凭据与 projectId 都就绪、请求尚未发出；钩子抛错直接上抛（如总闸中途关闭）
  request.onSubmitted?.();
  let postStart = Date.now();
  let response: Response;
  try {
    response = await post(credential.access);
  } catch (error) {
    throw afterPost(error, "生图请求");
  }

  // 没过期却被拒：锁内按 usedAccess 复查，别人没换过才强刷；最多重试一次
  if (response.status === 401) {
    // 401 的正文不读，及时释放连接
    await response.body?.cancel().catch(() => undefined);
    const usedAccess = credential.access;
    credential = await refreshInLock((latest) => latest.access === usedAccess, "401 后 OAuth 强刷");
    postStart = Date.now();
    try {
      response = await post(credential.access);
    } catch (error) {
      throw afterPost(error, "生图重试");
    }
  }
  request.onStage?.({ stage: "post", ms: Date.now() - postStart, status: response.status });

  if (!response.ok) {
    const detail = await readErrorText(response);
    // 4xx 是上游的确定性回答（没出图）；5xx 不知道后端算没算
    throw fail(
      `gemini 生图请求失败（HTTP ${response.status}）${detail.trim() ? `：${clean(detail)}` : ""}`,
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
  const parts = Array.isArray(candidate?.content?.parts) ? candidate.content.parts : [];
  const images = parts
    .map((part) => part.inlineData)
    .filter((item): item is { mimeType?: unknown; data: string } => typeof item?.data === "string" && item.data.length > 0);
  request.onStage?.({ stage: "parse", ms: Date.now() - parseStart, urls: images.length });

  if (images.length === 0) {
    const blockReason = textOf(envelope.response?.promptFeedback?.blockReason) || textOf(envelope.promptFeedback?.blockReason);
    const finishReason = textOf(candidate?.finishReason);
    const apiError = textOf(envelope.response?.error?.message) || textOf(envelope.error?.message);
    const reply = parts.map((part) => textOf(part.text)).filter(Boolean).join(" ");
    // 有 finishReason / 文字回复 / 拦截原因 = 上游明确答复过（拒答也算答复）；什么都没有才是异常空包
    const explicit = Boolean(blockReason || finishReason || apiError || reply);
    const detail = [blockReason && `blockReason=${blockReason}`, finishReason && `finishReason=${finishReason}`, apiError, reply]
      .filter(Boolean)
      .join(" | ");
    throw fail(
      `gemini 没有返回图片（${explicit ? "上游明确答复，未出图" : "异常空响应，结果不明"}）${detail ? `：${clean(detail)}` : ""}`,
      !explicit,
    );
  }

  // 先全部解码核对体积，再统一落盘：不因为第二张坏包留下第一张的半成品
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
      // 取消后不再写：逐张复核
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

/** runDrawRemote 的 gemini 通道：把解析好的 provider 配置转成 generateGeminiImage 的入参。 */
export async function runGeminiChannel(request: DrawRemoteChannelRequest): Promise<string[]> {
  return generateGeminiImage({
    authPath: request.authPath,
    provider: request.providerId,
    baseUrl: request.baseUrl,
    userAgent: request.userAgent,
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
