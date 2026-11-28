/**
 * inline 附图专用压图（输出恒为 JPEG）。
 *
 * 规格来自 docs/plans/2026-11-01-inline-vision.md 及其真机实验：
 *   - 长边 >1280px 先缩到 1280px
 *   - JPEG 且长边 ≤1280px 且 ≤50KB：不重编码，原字节直返
 *   - 其余一律转码 JPEG（质量固定 80）；若 >50KB，只降分辨率、按 50px 步长
 *     逐档下探（1200/1150/…/400）直到 ≤50KB；到 400px 仍超则接受该档（floor 标记）
 *   - 50KB 是上限不是目标：达标后不再压（该通道按图计费与字节无关，压小只丢清晰度）
 *
 * 只服务主会话 inline 附图路径；look/describe 链路保持自己的压缩语义，不用本模块。
 *
 * 后端：macOS 走自带 sips（参数逐字保留，生产路径零行为变化）；
 * 其它平台（Linux 容器）走 image-ops 的 sharp worker——sips 在 Linux 不存在，
 * 若不接这条分支，压图会静默失败、模型一张图也看不到。规格常量两边共用。
 */
import { readFileHead, shrinkViaWorkerAsync, usesSips } from "./image-ops.ts";
import { spawnCapture } from "./spawn-capture.ts";
import { mkdtempSync, rmSync, statSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

const MAX_LONG_SIDE = 1280;
const TARGET_BYTES = 50 * 1024;
const QUALITY = "80";
const LADDER_FLOOR = 400;
const LADDER_STEP = 50;

export type ShrinkResult =
  | { ok: true; buffer: Buffer; mimeType: "image/jpeg"; floor?: true }
  | { ok: false; reason: string };

/** 魔数嗅探：判定真实格式（文件扩展名不可信）。 */
function sniff(buf: Buffer): "jpeg" | "png" | "gif" | "webp" | "bmp" | "other" {
  if (buf.subarray(0, 3).toString("hex") === "ffd8ff") return "jpeg";
  if (buf.subarray(0, 8).toString("hex") === "89504e470d0a1a0a") return "png";
  if (buf.subarray(0, 4).toString("ascii") === "GIF8") return "gif";
  if (buf.subarray(0, 4).toString("ascii") === "RIFF" && buf.subarray(8, 12).toString("ascii") === "WEBP") return "webp";
  if (buf.subarray(0, 2).toString("ascii") === "BM") return "bmp";
  return "other";
}

/**
 * inline 附图的统一取图（静态图）：shrinkForModelAsync（≤50KB）。GIF 不在此处理——
 * 网关对 image/gif 只解码首帧（2026-11-06 实测），动图一律走 gif-frames.ts 的
 * 抽帧多 block 路径。压缩注入点可测试替换。
 */
export type InlineImageResult =
  | { ok: true; buffer: Buffer; mimeType: string }
  | { ok: false; reason: string };

async function dimensionsAsync(file: string, signal?: AbortSignal): Promise<{ w: number; h: number } | null> {
  const res = await spawnCapture("sips", ["-g", "pixelWidth", "-g", "pixelHeight", file], { timeoutMs: 10_000, signal });
  if (res.status !== 0) return null;
  const out = res.stdout.toString();
  const w = Number(/pixelWidth:\s*(\d+)/.exec(out)?.[1]);
  const h = Number(/pixelHeight:\s*(\d+)/.exec(out)?.[1]);
  if (!Number.isFinite(w) || !Number.isFinite(h) || w <= 0 || h <= 0) return null;
  return { w, h };
}

async function runSipsAsync(args: string[], source: string, signal?: AbortSignal): Promise<Buffer | null> {
  if (signal?.aborted) return null;
  const dir = mkdtempSync(join(tmpdir(), "shrink-"));
  const out = join(dir, "o.jpg");
  try {
    const res = await spawnCapture("sips", [...args, source, "--out", out], { timeoutMs: 20_000, signal });
    if (res.status !== 0) return null;
    const buf = await readFile(out);
    return buf.length > 0 ? buf : null;
  } catch {
    return null;
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

/** shrinkForModel 异步版：事件循环无阻塞且支持取消信号。 */
export async function shrinkForModelAsync(input: { file: string; signal?: AbortSignal }): Promise<ShrinkResult> {
  if (input.signal?.aborted) return { ok: false, reason: "aborted" };
  if (!usesSips()) {
    const r = await shrinkViaWorkerAsync(input.file, input.signal);
    if (!r.ok) return { ok: false, reason: r.reason };
    const buffer = Buffer.from(r.b64, "base64");
    return r.floor ? { ok: true, buffer, mimeType: "image/jpeg", floor: true } : { ok: true, buffer, mimeType: "image/jpeg" };
  }
  let head: Buffer;
  let fileSize: number;
  try {
    fileSize = statSync(input.file).size;
    head = readFileHead(input.file, 16);
  } catch {
    return { ok: false, reason: "read" };
  }
  const size = await dimensionsAsync(input.file, input.signal);
  if (input.signal?.aborted) return { ok: false, reason: "aborted" };
  if (!size) return { ok: false, reason: "sips" };
  const long = Math.max(size.w, size.h);

  if (sniff(head) === "jpeg" && long <= MAX_LONG_SIDE && fileSize <= TARGET_BYTES) {
    try {
      return { ok: true, buffer: await readFile(input.file), mimeType: "image/jpeg" };
    } catch {
      return { ok: false, reason: "read" };
    }
  }

  const first = long > MAX_LONG_SIDE
    ? await runSipsAsync(["-Z", String(MAX_LONG_SIDE), "-s", "format", "jpeg", "-s", "formatOptions", QUALITY], input.file, input.signal)
    : await runSipsAsync(["-s", "format", "jpeg", "-s", "formatOptions", QUALITY], input.file, input.signal);
  if (input.signal?.aborted) return { ok: false, reason: "aborted" };
  if (!first) return { ok: false, reason: "sips" };
  if (first.length <= TARGET_BYTES) return { ok: true, buffer: first, mimeType: "image/jpeg" };

  let last = first;
  for (let z = Math.floor(Math.min(long, MAX_LONG_SIDE) / LADDER_STEP) * LADDER_STEP - LADDER_STEP; z >= LADDER_FLOOR; z -= LADDER_STEP) {
    if (input.signal?.aborted) return { ok: false, reason: "aborted" };
    const next = await runSipsAsync(["-Z", String(z), "-s", "format", "jpeg", "-s", "formatOptions", QUALITY], input.file, input.signal);
    if (!next) continue;
    last = next;
    if (next.length <= TARGET_BYTES) return { ok: true, buffer: next, mimeType: "image/jpeg" };
  }
  return { ok: true, buffer: last, mimeType: "image/jpeg", floor: true };
}

/** inline 附图异步取图（可注入同步或异步 shrink 桩）。 */
export async function inlineImageOfAsync(
  file: string,
  shrink: (input: { file: string; signal?: AbortSignal }) => ShrinkResult | Promise<ShrinkResult> = shrinkForModelAsync,
  signal?: AbortSignal,
): Promise<InlineImageResult> {
  if (signal?.aborted) return { ok: false, reason: "aborted" };
  const shrunk = await shrink({ file, signal });
  return shrunk.ok ? { ok: true, buffer: shrunk.buffer, mimeType: shrunk.mimeType } : { ok: false, reason: shrunk.reason };
}
