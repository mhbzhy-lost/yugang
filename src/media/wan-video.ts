/** 百炼 Token Plan Wan3 视频客户端：只供 wan_gif 使用，固定 3 秒 480P，结果转小 GIF。 */
import { existsSync, lstatSync, mkdirSync, readFileSync, realpathSync, rmSync, statSync, writeFileSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { tmpdir } from "node:os";
import { extname, join, relative, resolve, sep } from "node:path";
import { readResponseBytes, REMOTE_JSON_MAX_BYTES } from "./gpt-image.ts";
import { readFileHead, sniffImageMagic } from "./image-ops.ts";
import { createProxyFetch } from "./proxy-fetch.ts";
import { spawnCapture } from "./spawn-capture.ts";

export interface WanGifRequest {
  apiKey: string;
  baseUrl: string;
  prompt: string;
  mediaRoot: string;
  ref?: { bytes: Buffer; ext: "png" | "jpg" | "jpeg" | "webp" };
  proxy?: string;
  signal?: AbortSignal;
}

const API_PATH = "/api/v1/services/aigc/video-generation/video-synthesis";
const TASK_PATH = "/api/v1/tasks/";
const WAN_VIDEO_TOTAL_TIMEOUT_MS = 1_150_000;
const WAN_VIDEO_MAX_BYTES = 50 * 1024 * 1024;

export function sleepCancellable(ms: number, signal?: AbortSignal): Promise<void> {
  if (signal?.aborted) {
    return Promise.reject(signal.reason ?? new DOMException("The operation was aborted", "AbortError"));
  }
  return new Promise<void>((resolve, reject) => {
    const onAbort = () => {
      clearTimeout(timer);
      reject(signal!.reason ?? new DOMException("The operation was aborted", "AbortError"));
    };
    const timer = setTimeout(() => {
      signal?.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    signal?.addEventListener("abort", onAbort, { once: true });
  });
}

export async function generateWanGif(request: WanGifRequest): Promise<string> {
  const base = request.baseUrl.replace(/\/+$/, "");
  const controller = new AbortController();
  const signal = request.signal ? AbortSignal.any([controller.signal, request.signal]) : controller.signal;
  const timeout = setTimeout(() => controller.abort(), WAN_VIDEO_TOTAL_TIMEOUT_MS);
  const doFetch = (request.proxy ? createProxyFetch(request.proxy) : undefined) ?? fetch;
  let tempVideo: string | undefined;
  let output: string | undefined;
  let completed = false;
  try {
    signal.throwIfAborted();
    const media = request.ref ? [{ type: "first_frame", url: `data:image/${request.ref.ext === "jpg" ? "jpeg" : request.ref.ext};base64,${request.ref.bytes.toString("base64")}` }] : undefined;
    const payload = {
      model: "wan3.0-video",
      input: { prompt: request.prompt, ...(media ? { media } : {}) },
      parameters: { resolution: "480P", ratio: request.ref ? "adaptive" : "1:1", duration: 3, fps: 15, prompt_extend: false },
    };
    const response = await doFetch(base + API_PATH, { method: "POST", headers: { authorization: `Bearer ${request.apiKey}`, "content-type": "application/json", "X-DashScope-Async": "enable" }, body: JSON.stringify(payload), signal });
    if (!response.ok) {
      await response.body?.cancel?.().catch(() => {});
      throw new Error(`wan_gif_http_${response.status}`);
    }
    const createdRaw = await readResponseBytes(response, REMOTE_JSON_MAX_BYTES, "wan_gif_response_too_large");
    const created = JSON.parse(createdRaw.toString("utf8")) as { output?: { task_id?: string } };
    const taskId = created.output?.task_id;
    if (!taskId) throw new Error("wan_gif_no_task");
    let videoUrl: string | undefined;
    for (let i = 0; i < 80; i++) {
      await sleepCancellable(15_000, signal);
      const statusResponse = await doFetch(base + TASK_PATH + taskId, { headers: { authorization: `Bearer ${request.apiKey}` }, signal });
      if (!statusResponse.ok) {
        await statusResponse.body?.cancel?.().catch(() => {});
        throw new Error(`wan_gif_status_${statusResponse.status}`);
      }
      const statusRaw = await readResponseBytes(statusResponse, REMOTE_JSON_MAX_BYTES, "wan_gif_response_too_large");
      const status = JSON.parse(statusRaw.toString("utf8")) as { output?: { task_status?: string; video_url?: string; message?: string } };
      const out = status.output ?? {};
      if (out.task_status === "SUCCEEDED") { videoUrl = out.video_url; break; }
      if (["FAILED", "CANCELED", "UNKNOWN"].includes(out.task_status ?? "")) throw new Error(`wan_gif_task_${out.task_status}`);
    }
    if (!videoUrl) throw new Error("wan_gif_timeout");
    const videoResponse = await doFetch(videoUrl, { signal });
    if (!videoResponse.ok) {
      await videoResponse.body?.cancel?.().catch(() => {});
      throw new Error(`wan_gif_download_${videoResponse.status}`);
    }
    const videoBytes = await readResponseBytes(videoResponse, WAN_VIDEO_MAX_BYTES, "wan_gif_video_too_large");
    signal.throwIfAborted();

    tempVideo = join(tmpdir(), `yugang-wan-${randomUUID()}.mp4`);
    writeFileSync(tempVideo, videoBytes, { flag: "wx" });

    const outDir = join(request.mediaRoot, "gen");
    mkdirSync(outDir, { recursive: true });
    const file = `${Date.now()}-${randomUUID()}.gif`;
    output = join(outDir, file);
    const converted = await spawnCapture("ffmpeg", ["-y", "-loglevel", "error", "-i", tempVideo, "-vf", "fps=5,scale=280:280:flags=lanczos", "-loop", "0", "-gifflags", "-transdiff", output], { timeoutMs: 120_000, signal });
    signal.throwIfAborted();
    if (converted.status !== 0 || !existsSync(output) || statSync(output).size === 0) throw new Error("wan_gif_convert");
    completed = true;
    return file;
  } finally {
    clearTimeout(timeout);
    if (tempVideo) rmSync(tempVideo, { force: true });
    if (!completed && output) rmSync(output, { force: true });
  }
}

export function readWanGifRef(mediaRoot: string, raw: string): WanGifRequest["ref"] {
  const root = resolve(mediaRoot);
  const ref = raw.trim().replace(/^\[|\]$/g, "");
  const full = resolve(root, ref);
  const rel = relative(root, full).split(sep).join("/");
  if (!full.startsWith(root + sep) || !(rel.startsWith("inbound/") || rel.startsWith("gen/"))) throw new Error("wan_gif_ref_bad");
  let lstat;
  try {
    lstat = lstatSync(full);
  } catch {
    throw new Error("wan_gif_ref_bad");
  }
  if (lstat.isSymbolicLink() || !lstat.isFile() || lstat.size > 20 * 1024 * 1024) throw new Error("wan_gif_ref_bad");
  const real = realpathSync(full);
  const realRoot = realpathSync(root);
  if (!real.startsWith(realRoot + sep)) throw new Error("wan_gif_ref_bad");
  const st = statSync(real);
  if (!st.isFile() || st.size > 20 * 1024 * 1024) throw new Error("wan_gif_ref_bad");
  const ext = extname(real).toLowerCase().slice(1);
  if (!(ext === "png" || ext === "jpg" || ext === "jpeg" || ext === "webp")) throw new Error("wan_gif_ref_bad");
  const magic = sniffImageMagic(readFileHead(real, 16));
  if (!magic || magic.convert || (magic.ext !== "png" && magic.ext !== "jpg" && magic.ext !== "webp")) {
    throw new Error("wan_gif_ref_bad");
  }
  const actualExt = magic.ext === "jpg" ? (ext === "jpeg" ? "jpeg" : "jpg") : magic.ext;
  return { bytes: readFileSync(real), ext: actualExt };
}
