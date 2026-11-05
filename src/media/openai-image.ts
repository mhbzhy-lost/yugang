/**
 * OpenAI 官方 Images API（api.openai.com）生图客户端——只服务 GPT Image 2.6 的**动图**通道。
 *
 * 为什么单独一份：ChatGPT/Codex 订阅后端（`chatgpt.com/backend-api/codex/images/*`）对
 * `output_format: "gif"` 一律返回 `400 GIF output is not enabled for this request`，
 * 实测换任何 2.6 型号都一样（2026-11-05）。官方 GIF 支持只在 API 平台，按张计费，
 * 需要独立 API key；这条路径不碰订阅凭据。
 *
 *   POST {baseUrl}/v1/images/generations   （纯文生图）
 *   POST {baseUrl}/v1/images/edits         （带参考图，multipart）
 *
 * 与 gpt-image.ts 共用落盘约定（mediaRoot/gen + 按字节判后缀），响应解析只认 b64_json。
 */
import { mkdirSync, writeFileSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { join } from "node:path";
import { createProxyFetch } from "./proxy-fetch.ts";
import { extensionOf } from "./gpt-image.ts";

const DEFAULT_BASE_URL = "https://api.openai.com";

export interface OpenAIImageRequest {
  apiKey: string;
  prompt: string;
  /** 原样透传的字段（model / output_format / frame_count / frame_duration_ms / background / n / size …）。 */
  params?: Record<string, unknown>;
  /** 参考图 data URL（走 edits，multipart）。 */
  images?: string[];
  mediaRoot: string;
  baseUrl?: string;
  proxy?: string;
  timeoutMs?: number;
  fetchImpl?: typeof fetch;
}

/** 出图成功返回相对 mediaRoot 的引用列表（gen/xxx.gif 等）；失败抛错，错误里不带凭据。 */
export async function generateOpenAIImages(request: OpenAIImageRequest): Promise<string[]> {
  if (typeof request.apiKey !== "string" || request.apiKey.trim().length === 0) {
    throw new Error("gpt_image_no_api_key");
  }
  const doFetch = request.fetchImpl ?? (request.proxy ? createProxyFetch(request.proxy) : undefined) ?? fetch;
  const baseUrl = (request.baseUrl ?? DEFAULT_BASE_URL).replace(/\/+$/, "");
  const { prompt: _ignored, model, ...rest } = (request.params ?? {}) as Record<string, unknown> & {
    prompt?: unknown;
    model?: unknown;
  };
  const headers: Record<string, string> = {
    authorization: `Bearer ${request.apiKey.trim()}`,
    accept: "application/json",
  };

  let url: string;
  let body: BodyInit;
  if (request.images !== undefined && request.images.length > 0) {
    // edits：官方要求 multipart，图片按文件上传；data URL 拆成 Blob
    url = `${baseUrl}/v1/images/edits`;
    const form = new FormData();
    if (typeof model === "string" && model.trim().length > 0) form.set("model", model.trim());
    form.set("prompt", request.prompt);
    for (const [key, value] of Object.entries(rest)) {
      if (value === undefined) continue;
      form.set(key, typeof value === "string" ? value : JSON.stringify(value));
    }
    for (const [index, dataUrl] of request.images.entries()) {
      const match = /^data:([^;]+);base64,(.+)$/s.exec(dataUrl);
      if (!match) throw new Error("gpt_image_bad_ref");
      const mime = match[1] ?? "image/png";
      const bytes = Buffer.from(match[2] ?? "", "base64");
      form.append("image[]", new Blob([bytes], { type: mime }), `image-${index}.${mime.split("/")[1] ?? "png"}`);
    }
    body = form;
  } else {
    url = `${baseUrl}/v1/images/generations`;
    headers["content-type"] = "application/json";
    body = JSON.stringify({
      ...(typeof model === "string" && model.trim().length > 0 ? { model: model.trim() } : {}),
      prompt: request.prompt,
      ...rest,
    });
  }

  const response = await doFetch(url, {
    method: "POST",
    headers,
    body,
    signal: AbortSignal.timeout(request.timeoutMs ?? 240_000),
  });
  if (!response.ok) {
    const detail = await response.text().catch(() => "");
    if (response.status === 400 && detail.includes("GIF output is not enabled")) {
      throw new Error("gpt_image_gif_off");
    }
    throw new Error(`gpt_image_http_${response.status}`);
  }
  const parsed = (await response.json()) as { data?: { b64_json?: string }[] };
  const entries = (parsed.data ?? []).filter((item) => typeof item.b64_json === "string");
  if (entries.length === 0) throw new Error("gpt_image_empty");

  const outDir = join(request.mediaRoot, "gen");
  mkdirSync(outDir, { recursive: true });
  const files: string[] = [];
  for (const entry of entries) {
    const bytes = Buffer.from(entry.b64_json as string, "base64");
    if (bytes.length < 1024) throw new Error("gpt_image_too_small");
    const file = `${Date.now()}-${randomUUID().slice(0, 8)}.${extensionOf(bytes)}`;
    writeFileSync(join(outDir, file), bytes);
    files.push(file);
  }
  return files;
}
