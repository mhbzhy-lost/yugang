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
 * 实现只用 macOS 自带 sips（本地开发机与生产 mini 都是 macOS，deploy 不装依赖）。
 */
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, statSync } from "node:fs";
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

/** 读像素尺寸；sips 读不出来按失败处理。 */
function dimensions(file: string): { w: number; h: number } | null {
  const res = spawnSync("sips", ["-g", "pixelWidth", "-g", "pixelHeight", file], { timeout: 10_000 });
  if (res.status !== 0) return null;
  const out = res.stdout.toString();
  const w = Number(/pixelWidth:\s*(\d+)/.exec(out)?.[1]);
  const h = Number(/pixelHeight:\s*(\d+)/.exec(out)?.[1]);
  if (!Number.isFinite(w) || !Number.isFinite(h) || w <= 0 || h <= 0) return null;
  return { w, h };
}

/** 跑一次 sips 产出 JPEG；输出落在随机临时目录，读完即删。失败返回 null。 */
function runSips(args: string[], source: string): Buffer | null {
  const dir = mkdtempSync(join(tmpdir(), "shrink-"));
  const out = join(dir, "o.jpg");
  try {
    const res = spawnSync("sips", [...args, source, "--out", out], { timeout: 20_000 });
    if (res.status !== 0) return null;
    const buf = readFileSync(out);
    return buf.length > 0 ? buf : null;
  } catch {
    return null;
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

export function shrinkForModel(input: { file: string }): ShrinkResult {
  let raw: Buffer;
  try {
    raw = readFileSync(input.file);
  } catch {
    return { ok: false, reason: "read" };
  }
  const size = dimensions(input.file);
  if (!size) return { ok: false, reason: "sips" };
  const long = Math.max(size.w, size.h);

  // JPEG 小图直通：不重编码（字节即证据，F3 的小图分支）
  if (sniff(raw) === "jpeg" && long <= MAX_LONG_SIDE && raw.length <= TARGET_BYTES) {
    return { ok: true, buffer: raw, mimeType: "image/jpeg" };
  }

  // 初次转码：超尺寸先归到 1280；不超尺寸只转格式。GIF 由 sips 取首帧（防御，上游已排除）
  const first = long > MAX_LONG_SIDE
    ? runSips(["-Z", String(MAX_LONG_SIDE), "-s", "format", "jpeg", "-s", "formatOptions", QUALITY], input.file)
    : runSips(["-s", "format", "jpeg", "-s", "formatOptions", QUALITY], input.file);
  if (!first) return { ok: false, reason: "sips" };
  if (first.length <= TARGET_BYTES) return { ok: true, buffer: first, mimeType: "image/jpeg" };

  // 阶梯下探：只降分辨率、质量恒 80；起点比当前档低一档，避免重复跑同一尺寸
  let last = first;
  for (let z = Math.floor(Math.min(long, MAX_LONG_SIDE) / LADDER_STEP) * LADDER_STEP - LADDER_STEP; z >= LADDER_FLOOR; z -= LADDER_STEP) {
    const next = runSips(["-Z", String(z), "-s", "format", "jpeg", "-s", "formatOptions", QUALITY], input.file);
    if (!next) continue;
    last = next;
    if (next.length <= TARGET_BYTES) return { ok: true, buffer: next, mimeType: "image/jpeg" };
  }
  return { ok: true, buffer: last, mimeType: "image/jpeg", floor: true };
}

/**
 * inline 附图的统一取图（静态图）：shrinkForModel（≤50KB）。GIF 不在此处理——
 * 网关对 image/gif 只解码首帧（2026-11-06 实测），动图一律走 gif-frames.ts 的
 * 抽帧多 block 路径。压缩注入点可测试替换。
 */
export type InlineImageResult =
  | { ok: true; buffer: Buffer; mimeType: string }
  | { ok: false; reason: string };

export function inlineImageOf(
  file: string,
  shrink: (input: { file: string }) => ShrinkResult = shrinkForModel,
): InlineImageResult {
  const shrunk = shrink({ file });
  return shrunk.ok ? { ok: true, buffer: shrunk.buffer, mimeType: shrunk.mimeType } : { ok: false, reason: shrunk.reason };
}
