/** 百炼 Token Plan Wan3 视频客户端：只供 wan_gif 使用，固定 3 秒 480P，结果转小 GIF。 */
import { mkdirSync, readFileSync, realpathSync, statSync, writeFileSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { extname, join, relative, resolve, sep } from "node:path";
import { spawnCapture } from "./spawn-capture.ts";

export interface WanGifRequest {
  apiKey: string;
  baseUrl: string;
  prompt: string;
  mediaRoot: string;
  ref?: { bytes: Buffer; ext: "png" | "jpg" | "jpeg" | "webp" };
  signal?: AbortSignal;
}

const API_PATH = "/api/v1/services/aigc/video-generation/video-synthesis";
const TASK_PATH = "/api/v1/tasks/";

export async function generateWanGif(request: WanGifRequest): Promise<string> {
  const base = request.baseUrl.replace(/\/+$/, "");
  const controller = new AbortController();
  const signal = request.signal ? AbortSignal.any([controller.signal, request.signal]) : controller.signal;
  const timeout = setTimeout(() => controller.abort(), 1_000_000);
  try {
    const media = request.ref ? [{ type: "first_frame", url: `data:image/${request.ref.ext === "jpg" ? "jpeg" : request.ref.ext};base64,${request.ref.bytes.toString("base64")}` }] : undefined;
    const payload = {
      model: "wan3.0-video",
      input: { prompt: request.prompt, ...(media ? { media } : {}) },
      parameters: { resolution: "480P", ratio: request.ref ? "adaptive" : "1:1", duration: 3, fps: 15, prompt_extend: false },
    };
    const response = await fetch(base + API_PATH, { method: "POST", headers: { authorization: `Bearer ${request.apiKey}`, "content-type": "application/json", "X-DashScope-Async": "enable" }, body: JSON.stringify(payload), signal });
    if (!response.ok) throw new Error(`wan_gif_http_${response.status}`);
    const created = await response.json() as { output?: { task_id?: string } };
    const taskId = created.output?.task_id;
    if (!taskId) throw new Error("wan_gif_no_task");
    let videoUrl: string | undefined;
    for (let i = 0; i < 80; i++) {
      await new Promise<void>((resolveDelay, reject) => {
        const timer = setTimeout(resolveDelay, 15_000);
        signal.addEventListener("abort", () => { clearTimeout(timer); reject(signal.reason); }, { once: true });
      });
      const statusResponse = await fetch(base + TASK_PATH + taskId, { headers: { authorization: `Bearer ${request.apiKey}` }, signal });
      if (!statusResponse.ok) throw new Error(`wan_gif_status_${statusResponse.status}`);
      const status = await statusResponse.json() as { output?: { task_status?: string; video_url?: string; message?: string } };
      const output = status.output ?? {};
      if (output.task_status === "SUCCEEDED") { videoUrl = output.video_url; break; }
      if (["FAILED", "CANCELED", "UNKNOWN"].includes(output.task_status ?? "")) throw new Error(`wan_gif_task_${output.task_status}`);
    }
    if (!videoUrl) throw new Error("wan_gif_timeout");
    const videoResponse = await fetch(videoUrl, { signal });
    if (!videoResponse.ok) throw new Error(`wan_gif_download_${videoResponse.status}`);
    const tempDir = join(request.mediaRoot, "gen");
    mkdirSync(tempDir, { recursive: true });
    const tempVideo = join(tempDir, `${randomUUID()}.mp4`);
    writeFileSync(tempVideo, Buffer.from(await videoResponse.arrayBuffer()), { flag: "wx" });
    const file = `${Date.now()}-${randomUUID()}.gif`;
    const output = join(tempDir, file);
    const converted = await spawnCapture("ffmpeg", ["-y", "-loglevel", "error", "-i", tempVideo, "-vf", "fps=5,scale=280:280:flags=lanczos", "-loop", "0", "-gifflags", "-transdiff", output], { timeoutMs: 120_000, signal });
    if (converted.status !== 0) throw new Error("wan_gif_convert");
    return file;
  } finally {
    clearTimeout(timeout);
  }
}

export function readWanGifRef(mediaRoot: string, raw: string): WanGifRequest["ref"] {
  const root = resolve(mediaRoot);
  const ref = raw.trim().replace(/^\[|\]$/g, "");
  const full = resolve(root, ref);
  const rel = relative(root, full).split(sep).join("/");
  if (!full.startsWith(root + sep) || !(rel.startsWith("inbound/") || rel.startsWith("gen/"))) throw new Error("wan_gif_ref_bad");
  const real = realpathSync(full);
  const realRoot = realpathSync(root);
  if (!real.startsWith(realRoot + sep)) throw new Error("wan_gif_ref_bad");
  const st = statSync(real);
  if (!st.isFile() || st.size > 20 * 1024 * 1024) throw new Error("wan_gif_ref_bad");
  const ext = extname(real).toLowerCase().slice(1);
  if (!(ext === "png" || ext === "jpg" || ext === "jpeg" || ext === "webp")) throw new Error("wan_gif_ref_bad");
  return { bytes: readFileSync(real), ext };
}
