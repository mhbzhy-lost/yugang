import { crc32, deflateSync, inflateSync } from "node:zlib";

// 纯 TS 的 PNG 编解码（无第三方依赖）：解码只服务 ComfyUI PreviewImage 输出
// （8bit 非隔行，灰度/RGB/RGBA 全支持）；编码只生成 mask 专用 RGBA PNG。
// 语义约定：mask PNG 的「重绘区 alpha=0 透明、保护区 alpha=255」——LoadImage 的
// MASK 输出取 1-alpha，语义与直觉相反，这是 ComfyUI 的既定行为。

const SIG = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);

function chunk(tag: string, data: Buffer): Buffer {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length);
  const body = Buffer.concat([Buffer.from(tag, "ascii"), data]);
  const tail = Buffer.alloc(4);
  tail.writeUInt32BE(Number(crc32(body) >>> 0));
  return Buffer.concat([len, body, tail]);
}

/** 解码 8bit 非隔行 PNG 为 RGBA（bit depth 8，color type 0/2/4/6，五种 filter 全支持）。 */
export function decodePngRgba(buf: Buffer): { width: number; height: number; data: Uint8Array } {
  if (buf.length < 8 || !buf.subarray(0, 8).equals(SIG)) throw new Error("png: bad signature");
  let width = 0, height = 0, bitDepth = 0, colorType = -1, interlace = 0;
  const idat: Buffer[] = [];
  let pos = 8;
  while (pos + 12 <= buf.length) {
    const len = buf.readUInt32BE(pos);
    const tag = buf.toString("ascii", pos + 4, pos + 8);
    const data = buf.subarray(pos + 8, pos + 8 + len);
    pos += 12 + len;
    if (tag === "IHDR") {
      if (len !== 13) throw new Error("png: bad IHDR");
      width = data.readUInt32BE(0);
      height = data.readUInt32BE(4);
      bitDepth = data[8];
      colorType = data[9];
      interlace = data[12];
    } else if (tag === "IDAT") idat.push(data);
    else if (tag === "IEND") break;
  }
  if (!width || !height || !idat.length) throw new Error("png: missing chunks");
  if (width > 4096 || height > 4096) throw new Error("png: too large");
  if (bitDepth !== 8 || interlace !== 0) throw new Error(`png: unsupported format (${bitDepth}/${interlace})`);
  const channels = colorType === 0 ? 1 : colorType === 2 ? 3 : colorType === 4 ? 2 : colorType === 6 ? 4 : -1;
  if (channels < 0) throw new Error(`png: unsupported color type ${colorType}`);
  const stride = width * channels;
  let raw: Buffer;
  try {
    raw = inflateSync(Buffer.concat(idat));
  } catch {
    throw new Error("png: inflate failed");
  }
  if (raw.length < (stride + 1) * height) throw new Error("png: truncated data");
  const out = new Uint8Array(width * height * 4);
  let prev = new Uint8Array(stride);
  let off = 0;
  for (let y = 0; y < height; y++) {
    const filter = raw[off++];
    const line = raw.subarray(off, off + stride);
    off += stride;
    const cur = new Uint8Array(stride);
    for (let i = 0; i < stride; i++) {
      const a = i >= channels ? cur[i - channels] : 0;
      const b = prev[i];
      const c = i >= channels ? prev[i - channels] : 0;
      let v = line[i];
      if (filter === 1) v += a;
      else if (filter === 2) v += b;
      else if (filter === 3) v += (a + b) >> 1;
      else if (filter === 4) {
        const p = a + b - c;
        const pa = Math.abs(p - a), pb = Math.abs(p - b), pc = Math.abs(p - c);
        v += pa <= pb && pa <= pc ? a : pb <= pc ? b : c;
      } else if (filter !== 0) throw new Error(`png: bad filter ${filter}`);
      cur[i] = v;
    }
    for (let x = 0; x < width; x++) {
      const s = x * channels;
      const d = (y * width + x) * 4;
      if (channels === 1 || channels === 2) {
        out[d] = out[d + 1] = out[d + 2] = cur[s];
        out[d + 3] = channels === 2 ? cur[s + 1] : 255;
      } else {
        out[d] = cur[s];
        out[d + 1] = cur[s + 1];
        out[d + 2] = cur[s + 2];
        out[d + 3] = channels === 4 ? cur[s + 3] : 255;
      }
    }
    prev = cur;
  }
  return { width, height, data: out };
}

/** 生成 mask 专用 RGBA PNG：isRedraw 为真的像素是重绘区（alpha=0、RGB=0 便于预览），否则保护区（全 255）。 */
export function encodeMaskPng(width: number, height: number, isRedraw: (x: number, y: number) => boolean): Buffer {
  if (!Number.isInteger(width) || !Number.isInteger(height) || width <= 0 || height <= 0 || width > 4096 || height > 4096) throw new Error("png: invalid mask size");
  const stride = width * 4;
  const raw = Buffer.alloc((stride + 1) * height);
  for (let y = 0; y < height; y++) {
    const row = y * (stride + 1);
    raw[row] = 0; // filter None
    for (let x = 0; x < width; x++) {
      const d = row + 1 + x * 4;
      if (isRedraw(x, y)) continue; // 重绘区：0000（Buffer 默认 0）
      raw[d] = raw[d + 1] = raw[d + 2] = raw[d + 3] = 255;
    }
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8; ihdr[9] = 6; // 8bit RGBA
  return Buffer.concat([SIG, chunk("IHDR", ihdr), chunk("IDAT", deflateSync(raw, { level: 6 })), chunk("IEND", Buffer.alloc(0))]);
}

// 模块自证（实现自证，非新增测试）：encode → decode 回读一致，不一致启动即失败
{
  const w = 9, h = 5;
  const png = encodeMaskPng(w, h, (x, y) => x < (y % 2 === 0 ? 3 : 5));
  const back = decodePngRgba(png);
  if (back.width !== w || back.height !== h) throw new Error("png self-check: size mismatch");
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const expect = x < (y % 2 === 0 ? 3 : 5);
      const a = back.data[(y * w + x) * 4 + 3];
      if (a !== (expect ? 0 : 255)) throw new Error("png self-check: pixel mismatch");
    }
  }
}
