/**
 * Linux 侧图像后端：一个进程干完一整件事，结果以 JSON 写 stdout。
 *
 * 由 src/media/image-ops.ts 经 spawnSync 调用，**不直接被业务代码 import**。
 * 规格常量从 image-ops.ts 取，与 macOS 的 sips 后端共用同一套数字。
 *
 * 用法：node image-worker.ts <op> <jsonArgs>
 * 输出：{ ok:true, b64:"<base64>", floor?:true } 或 { ok:false, reason:"..." }
 */
import { closeSync, existsSync, openSync, readFileSync, readSync, unlinkSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { tmpdir } from "node:os";
import { join } from "node:path";
import sharp from "sharp";
import { IMAGE_SPEC as S } from "./image-ops.ts";

type Out = { ok: true; b64: string; floor?: true } | { ok: false; reason: string };

function fail(reason: string): Out {
  return { ok: false, reason };
}

function done(buf: Buffer, floor?: true): Out {
  if (buf.length === 0) return fail("empty");
  return floor ? { ok: true, b64: buf.toString("base64"), floor: true } : { ok: true, b64: buf.toString("base64") };
}

/** 魔数嗅探：扩展名不可信。与 shrink-image.ts 的 sniff 同口径。 */
function isJpeg(buf: Buffer): boolean {
  return buf.subarray(0, 3).toString("hex") === "ffd8ff";
}

/**
 * HEIC/HEIF 嗅探（魔数，不信扩展名）。
 *
 * 为何需要它：sharp 预编译包里的 libheif **只带 AV1 解码器、没有 libde265**，
 * 所以 `sharp.format.heif.input` 虽然报 true，实际只能解 AVIF；喲 HEIC 会报
 * `bad seek to <offset>`（2026-11-14 容器内实测）。ffmpeg 也不行——它只解网格
 * 的第一个瓦片（512×512）而不是拼好的整图。故用系统的 heif-convert
 * （apt: libheif-examples + libheif-plugin-libde265），它能正确拼网格。
 * AVIF 不在列表里：那个 sharp 自己能解。
 */
function isHeif(file: string): boolean {
  let fd: number | undefined;
  try {
    fd = openSync(file, "r");
    const head = Buffer.alloc(32);
    readSync(fd, head, 0, 32, 0);
    if (head.toString("ascii", 4, 8) !== "ftyp") return false;
    const brand = head.toString("ascii", 8, 12);
    return ["heic", "heix", "hevc", "hevx", "heim", "heis", "mif1", "msf1"].includes(brand);
  } catch {
    return false;
  } finally {
    if (fd !== undefined) {
      try { closeSync(fd); } catch {}
    }
  }
}

/**
 * HEIC/HEIF 先转成临时 PNG（无损）再交 sharp；其它格式原样返回。
 * 转 PNG 而不是 JPEG：避免归一化阶段就多一次有损编码。
 */
function prepareInput(file: string): { path: string; temp?: string } {
  if (!isHeif(file)) return { path: file };
  const temp = join(tmpdir(), `yugang-heif-${randomUUID()}.png`);
  const r = spawnSync("heif-convert", [file, temp], { timeout: 60_000, stdio: "ignore" });
  if (r.status !== 0 || !existsSync(temp)) {
    try { unlinkSync(temp); } catch {}
    throw new Error("heif-convert");
  }
  return { path: temp, temp };
}

/** 读像素尺寸。GIF/多页图取首页（与 sips 行为一致）。 */
async function size(file: string): Promise<{ w: number; h: number } | null> {
  const m = await sharp(file, { pages: 1 }).metadata();
  const w = m.width ?? 0;
  const h = m.height ?? 0;
  if (!Number.isFinite(w) || !Number.isFinite(h) || w <= 0 || h <= 0) return null;
  return { w, h };
}

/** 长边归到 max（fit:inside 保比例；允许放大，与 sips -Z 一致）。 */
function resizeLong(file: string, max: number) {
  return sharp(file, { pages: 1 }).resize({ width: max, height: max, fit: "inside" });
}

/** inline 附图压图：≤50KB，超了只降分辨率、质量恒 80，按 50px 阶梯下探到 400px。 */
async function opShrink(file: string): Promise<Out> {
  let raw: Buffer;
  try {
    raw = readFileSync(file);
  } catch {
    return fail("read");
  }
  const sz = await size(file);
  if (!sz) return fail("probe");
  const long = Math.max(sz.w, sz.h);

  // JPEG 小图直通：不重编码（字节即证据）
  if (isJpeg(raw) && long <= S.maxLongSide && raw.length <= S.targetBytes) return done(raw);

  const first = long > S.maxLongSide
    ? await resizeLong(file, S.maxLongSide).jpeg({ quality: S.quality }).toBuffer()
    : await sharp(file, { pages: 1 }).jpeg({ quality: S.quality }).toBuffer();
  if (first.length <= S.targetBytes) return done(first);

  let last = first;
  const start = Math.floor(Math.min(long, S.maxLongSide) / S.ladderStep) * S.ladderStep - S.ladderStep;
  for (let z = start; z >= S.ladderFloor; z -= S.ladderStep) {
    let next: Buffer;
    try {
      next = await resizeLong(file, z).jpeg({ quality: S.quality }).toBuffer();
    } catch {
      continue;
    }
    last = next;
    if (next.length <= S.targetBytes) return done(next);
  }
  return done(last, true);
}

/** look 转述前压图：长边 ≤1280、JPEG q70。 */
async function opLook(file: string): Promise<Out> {
  const buf = await resizeLong(file, S.maxLongSide).jpeg({ quality: S.lookQuality }).toBuffer();
  return done(buf);
}

/** draw 的 ref 初图：受限像素预算 + 每边 16 对齐（下限 64）+ PNG。 */
async function opInit(file: string): Promise<Out> {
  const sz = await size(file);
  if (!sz) return fail("probe");
  const scale = Math.min(1, S.initMaxSide / Math.max(sz.w, sz.h), Math.sqrt(S.initPixelBudget / (sz.w * sz.h)));
  const side = (n: number) => Math.max(64, Math.floor(n / 16) * 16);
  const w = side(sz.w * scale);
  const h = side(sz.h * scale);
  const buf = await sharp(file, { pages: 1 }).resize({ width: w, height: h, fit: "fill" }).png().toBuffer();
  // PNG 魔数校验（与 sips 路径同口径）
  if (buf.length < 24 || buf.subarray(0, 8).toString("hex") !== "89504e470d0a1a0a") return fail("png");
  return done(buf);
}

/** 入站 HEIC/HEIF/BMP/TIFF → JPEG，不缩放、默认质量。 */
async function opJpeg(file: string): Promise<Out> {
  const buf = await sharp(file, { pages: 1 }).jpeg().toBuffer();
  return done(buf);
}

async function main(): Promise<void> {
  const [op, argsJson] = process.argv.slice(2);
  if (!op || !argsJson) {
    process.stdout.write(JSON.stringify(fail("args")));
    return;
  }
  let args: { file?: string };
  try {
    args = JSON.parse(argsJson) as { file?: string };
  } catch {
    process.stdout.write(JSON.stringify(fail("args")));
    return;
  }
  if (!args.file) {
    process.stdout.write(JSON.stringify(fail("args")));
    return;
  }
  let out: Out;
  let temp: string | undefined;
  try {
    const prepared = prepareInput(args.file);
    temp = prepared.temp;
    switch (op) {
      case "shrink": out = await opShrink(prepared.path); break;
      case "look": out = await opLook(prepared.path); break;
      case "init": out = await opInit(prepared.path); break;
      case "jpeg": out = await opJpeg(prepared.path); break;
      default: out = fail("op");
    }
  } catch (err) {
    out = fail(err instanceof Error ? err.message.slice(0, 120) : "unknown");
  } finally {
    if (temp) {
      try { unlinkSync(temp); } catch {}
    }
  }
  process.stdout.write(JSON.stringify(out));
}

await main();