/**
 * 百炼 Token Plan Wan Image 原生多模态生图客户端。
 *
 * 下载回来的字节按真实魔数认图片：落盘后缀跟魔数走（不写死 .png），不是图片的正文（网关 200 + HTML 错误页、
 * 通道不认的 bmp/tiff/heic）直接报 wan_image_not_image，不当成图写进 gen/。
 */
import { mkdirSync, writeFileSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { join } from "node:path";
import { extensionOf } from "./gpt-image.ts";
import { sniffImageMagic } from "./image-ops.ts";
import { createProxyFetch } from "./proxy-fetch.ts";

export interface WanImageRequest {
  apiKey: string;
  baseUrl: string;
  model: string;
  prompt: string;
  size?: "1K" | "2K";
  n?: number;
  enableSequential?: boolean;
  mediaRoot: string;
  signal?: AbortSignal;
  /** provider 级代理（只有需要翻墙时才有意义）；非法值回落直连。 */
  proxy?: string;
  /** 上层 / 测试注入的 fetch：生成请求与图片下载都走它。 */
  fetchImpl?: typeof fetch;
  /**
   * 同步提交钩子：发起生成 POST 之前被调用一次（不等待返回值）。
   * 上层据此置 submitted / 发「稍等」；这里抛错 = 请求不发出。
   */
  onSubmitted?: () => void;
}

/**
 * HTTP 非 2xx：消息保留旧格式（`wan_image_http_<status>` / `wan_image_download_<status>`，
 * 现有调用方按前缀识别），状态码另挂到 status 上，供上层区分确定性拒绝（4xx）与结果不明（5xx）。
 */
function httpError(message: string, status: number): Error {
  return Object.assign(new Error(message), { status });
}

export async function generateWanImage(request: WanImageRequest): Promise<string[]> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 180_000);
  const signal = request.signal ? AbortSignal.any([controller.signal, request.signal]) : controller.signal;
  const doFetch = request.fetchImpl ?? (request.proxy ? createProxyFetch(request.proxy) : undefined) ?? fetch;
  try {
    // 已取消就不发请求、不触发提交钩子
    signal.throwIfAborted();
    request.onSubmitted?.();
    const response = await doFetch(`${request.baseUrl.replace(/\/+$/, "")}/api/v1/services/aigc/multimodal-generation/generation`, {
      method: "POST",
      headers: { authorization: `Bearer ${request.apiKey}`, "content-type": "application/json", accept: "application/json" },
      body: JSON.stringify({
        model: request.model,
        input: { messages: [{ role: "user", content: [{ text: request.prompt }] }] },
        ...((request.size || request.n !== undefined || request.enableSequential !== undefined) ? {
          parameters: {
            ...(request.size ? { size: request.size } : {}),
            ...(request.n !== undefined ? { n: request.n } : {}),
            ...(request.enableSequential !== undefined ? { enable_sequential: request.enableSequential } : {}),
          },
        } : {}),
      }),
      signal,
    });
    if (!response.ok) {
      const detail = (await response.text().catch(() => "")).replace(/\s+/g, " ").slice(0, 300);
      throw httpError(`wan_image_http_${response.status}${detail ? `: ${detail}` : ""}`, response.status);
    }
    const parsed = await response.json() as { output?: { choices?: Array<{ message?: { content?: Array<{ image?: string }> } }> } };
    const urls = parsed.output?.choices?.flatMap((choice) => choice.message?.content ?? [])
      .map((item) => item.image).filter((image): image is string => typeof image === "string");
    if (urls.length === 0) throw new Error("wan_image_empty");
    const files: string[] = [];
    let dir: string | undefined;
    for (const url of urls) {
      const image = await doFetch(url, { signal });
      if (!image.ok) throw httpError(`wan_image_download_${image.status}`, image.status);
      const bytes = Buffer.from(await image.arrayBuffer());
      // 取消后不落盘：逐张复核，第一张之前的 gen/ 目录也不建
      signal.throwIfAborted();
      if (bytes.length < 1024) throw new Error("wan_image_too_small");
      // 按真实字节认图片（Spec §3.3.7）：只收 extensionOf 认得的 png/jpg/gif/webp；
      // 没有图片魔数（HTML 错误页等）或需要转码的格式（bmp/tiff/heic，convert 标记）都拒落盘
      const kind = sniffImageMagic(bytes.subarray(0, 16));
      if (!kind || kind.convert) throw new Error("wan_image_not_image");
      if (dir === undefined) {
        dir = join(request.mediaRoot, "gen");
        mkdirSync(dir, { recursive: true });
      }
      const file = `${Date.now()}-${randomUUID()}.${extensionOf(bytes)}`;
      writeFileSync(join(dir, file), bytes, { flag: "wx" });
      files.push(file);
    }
    return files;
  } finally {
    clearTimeout(timeout);
  }
}
