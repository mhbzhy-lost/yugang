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
import { mkdirSync, writeFileSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { join } from "node:path";
import { fileCredentialStore, type OAuthCredential } from "../auth/credentials.ts";
import { refreshTokens } from "../auth/openai.ts";
import { createProxyFetch } from "./proxy-fetch.ts";

const GEN_ENDPOINT = "https://chatgpt.com/backend-api/codex/images/generations";
const EDIT_ENDPOINT = "https://chatgpt.com/backend-api/codex/images/edits";
/** Codex 客户端自称；后端按这个值决定放不放行。 */
const ORIGINATOR = "codex_cli_rs";

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

/** HTTP 非 2xx：消息保留旧格式（`gpt_image_http_<status>`），状态码另挂到 status 供上层判 4xx/5xx。 */
function httpError(message: string, status: number): Error {
  return Object.assign(new Error(message), { status });
}

/** 出图成功返回相对 mediaRoot 的引用列表（gen/xxx.png）；失败抛错，错误里不带凭据。 */
export async function generateGptImages(request: GptImageRequest): Promise<string[]> {
  const prepareStart = Date.now();
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
  if (Number(credential.expires) - Date.now() < 60_000) {
    const post = await store.modify(request.provider, async (current) => {
      if (!current || current.type !== "oauth") return undefined;
      const latest = current as OAuthCredential;
      if (Number(latest.expires) - Date.now() >= 60_000) return undefined; // 别人刚刷新过
      return await refreshTokens(latest, request.signal, doFetch);
    });
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

  const timeout = AbortSignal.timeout(request.timeoutMs ?? 600_000);
  // 已取消就不发请求、不触发提交钩子
  request.signal?.throwIfAborted();
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
    signal: request.signal ? AbortSignal.any([timeout, request.signal]) : timeout,
  });
  request.onStage?.({ stage: "post", ms: Date.now() - postStart, status: response.status });

  if (!response.ok) {
    // 400 + 这句 = 通道级开关没开（Codex 订阅后端 2026-11 实测：换任何 2.6 型号都一样），
    // 不是参数写错。单独抛一个码，让工具层回一句人话，别让模型反复重试。
    const detail = await response.text().catch(() => "");
    if (response.status === 400 && detail.includes("GIF output is not enabled")) {
      throw httpError("gpt_image_gif_off", response.status);
    }
    throw httpError(`gpt_image_http_${response.status}`, response.status);
  }
  const parseStart = Date.now();
  const parsed = (await response.json()) as { data?: { b64_json?: string }[] };
  const entries = (parsed.data ?? []).filter((item) => typeof item.b64_json === "string");
  request.onStage?.({ stage: "parse", ms: Date.now() - parseStart, urls: entries.length });
  if (entries.length === 0) throw new Error("gpt_image_empty");

  // 取消后不落盘：超时晚到的图不再写进 gen/（后端可能仍在算，状态不明，不重 POST）
  request.signal?.throwIfAborted();
  const outDir = join(request.mediaRoot, "gen");
  mkdirSync(outDir, { recursive: true });
  const files: string[] = [];
  for (const entry of entries) {
    request.signal?.throwIfAborted();
    const bytes = Buffer.from(entry.b64_json as string, "base64");
    if (bytes.length < 1024) throw new Error("gpt_image_too_small");
    const file = `${Date.now()}-${randomUUID().slice(0, 8)}.${extensionOf(bytes)}`;
    writeFileSync(join(outDir, file), bytes);
    files.push(file);
  }
  return files;
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
