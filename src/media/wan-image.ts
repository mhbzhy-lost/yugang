/**
 * 百炼 Token Plan 原生多模态生图客户端：draw_remote 的 wan（万相）与 qwen（Qwen Image）两条通道共用
 * （wan_gif 走 wan-video.ts，不经这里）。
 *
 * 下载回来的字节按真实魔数认图片：落盘后缀跟魔数走（不写死 .png），不是图片的正文（网关 200 + HTML 错误页、
 * 通道不认的 bmp/tiff/heic）直接报 wan_image_not_image，不当成图写进 gen/。
 */
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { join } from "node:path";
import {
  extensionOf,
  readErrorText,
  readResponseBytes,
  REMOTE_IMAGE_MAX_BYTES,
  REMOTE_JSON_MAX_BYTES,
} from "./gpt-image.ts";
import { sniffImageMagic } from "./image-ops.ts";
import { createProxyFetch } from "./proxy-fetch.ts";

export interface WanImageRequest {
  apiKey: string;
  baseUrl: string;
  model: string;
  prompt: string;
  /** 像素尺寸串 `宽*高`（如 `1280*1280`）；不传就不发 size，由模型按提示词自选尺寸。 */
  size?: string;
  /** 参考图（图生图 / 改图）：`data:{mime};base64,...` 或公网 URL，按给定顺序排在提示词之前。 */
  images?: readonly string[];
  mediaRoot: string;
  /** 单次生成与下载总超时，缺省 600 秒。 */
  timeoutMs?: number;
  signal?: AbortSignal;
  /** provider 级代理（只有需要翻墙时才有意义）；非法值回落直连。 */
  proxy?: string;
  /** 分阶段耗时回调（post / parse / download）。 */
  onStage?: (event: { stage: "post" | "parse" | "download"; ms: number; status?: number; urls?: number; bytes?: number }) => void;
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
  const timeout = setTimeout(() => controller.abort(), request.timeoutMs ?? 600_000);
  const signal = request.signal ? AbortSignal.any([controller.signal, request.signal]) : controller.signal;
  const doFetch = request.fetchImpl ?? (request.proxy ? createProxyFetch(request.proxy) : undefined) ?? fetch;
  let stage: "post" | "parse" | "download" = "post";
  try {
    // 已取消就不发请求、不触发提交钩子
    signal.throwIfAborted();
    request.onSubmitted?.();
    let stageStart = Date.now();
    const response = await doFetch(`${request.baseUrl.replace(/\/+$/, "")}/api/v1/services/aigc/multimodal-generation/generation`, {
      method: "POST",
      headers: { authorization: `Bearer ${request.apiKey}`, "content-type": "application/json", accept: "application/json" },
      body: JSON.stringify({
        model: request.model,
        input: {
          messages: [{ role: "user", content: [...(request.images ?? []).map((image) => ({ image })), { text: request.prompt }] }],
        },
        // 水印默认关；思考 / 提示词改写这类定制不开放，也不替后端编造组图（n / enable_sequential）参数
        parameters: { watermark: false, ...(request.size ? { size: request.size } : {}) },
      }),
      signal,
    });
    request.onStage?.({ stage: "post", ms: Date.now() - stageStart, status: response.status });
    if (!response.ok) {
      const detail = (await readErrorText(response)).replace(/\s+/g, " ").slice(0, 300);
      throw httpError(`wan_image_http_${response.status}${detail ? `: ${detail}` : ""}`, response.status);
    }
    stage = "parse";
    stageStart = Date.now();
    const rawJson = await readResponseBytes(response, REMOTE_JSON_MAX_BYTES, "wan_image_response_too_large");
    const parsed = JSON.parse(rawJson.toString("utf8")) as { output?: { choices?: Array<{ message?: { content?: Array<{ image?: string }> } }> } };
    // DashScope 偶有 200 但响应体缺 output / choices（或非数组）：按空结果处理，别漏出 TypeError
    const choices = Array.isArray(parsed.output?.choices) ? parsed.output.choices : [];
    const urls = choices.flatMap((choice) => choice.message?.content ?? []).map((item) => item.image).filter((image): image is string => typeof image === "string");
    request.onStage?.({ stage: "parse", ms: Date.now() - stageStart, urls: urls.length });
    if (urls.length === 0) throw new Error("wan_image_empty");
    const downloaded: Array<{ bytes: Buffer; ext: string }> = [];
    stage = "download";
    for (const url of urls) {
      stageStart = Date.now();
      const image = await doFetch(url, { signal });
      if (!image.ok) {
        await image.body?.cancel?.().catch(() => {});
        throw httpError(`wan_image_download_${image.status}`, image.status);
      }
      const bytes = await readResponseBytes(image, REMOTE_IMAGE_MAX_BYTES, "wan_image_too_large");
      request.onStage?.({ stage: "download", ms: Date.now() - stageStart, bytes: bytes.length });
      signal.throwIfAborted();
      if (bytes.length < 1024) throw new Error("wan_image_too_small");
      // 按真实字节认图片（Spec §3.3.7）：只收 extensionOf 认得的 png/jpg/gif/webp；
      // 没有图片魔数（HTML 错误页等）或需要转码的格式（bmp/tiff/heic，convert 标记）都拒落盘
      const kind = sniffImageMagic(bytes.subarray(0, 16));
      if (!kind || kind.convert) throw new Error("wan_image_not_image");
      downloaded.push({ bytes, ext: extensionOf(bytes) });
    }
    // 全部下载与校验通过后再统一落盘；异常时回滚删已写文件
    signal.throwIfAborted();
    const dir = join(request.mediaRoot, "gen");
    mkdirSync(dir, { recursive: true });
    const files: string[] = [];
    try {
      for (const item of downloaded) {
        signal.throwIfAborted();
        const file = `${Date.now()}-${randomUUID()}.${item.ext}`;
        writeFileSync(join(dir, file), item.bytes, { flag: "wx" });
        files.push(file);
      }
      return files;
    } catch (err) {
      for (const file of files) rmSync(join(dir, file), { force: true });
      throw err;
    }
  } catch (error) {
    if (error && typeof error === "object" && !("stage" in error)) {
      (error as { stage?: string }).stage = stage;
    }
    throw error;
  } finally {
    clearTimeout(timeout);
  }
}
