// 生成一张纯色 PNG 到 $YUGANG_MEDIA_ROOT，打印 [IMAGE:路径]。
// 纯标准库，不依赖任何 npm 包——这是 skill 脚本的基本要求。
import { deflateSync } from "node:zlib";
import { writeFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";

let crcTable;

const text = process.argv[2] ?? "无题";
const hex = (process.argv[3] ?? "#3b82f6").replace("#", "");
const outName = process.argv[4];
const [r, g, b] = [0, 2, 4].map((i) => parseInt(hex.slice(i, i + 2), 16) || 0);

const W = 512;
const H = 512;
const raw = Buffer.alloc((W * 3 + 1) * H);
for (let y = 0; y < H; y++) {
  const row = y * (W * 3 + 1);
  raw[row] = 0; // filter: none
  for (let x = 0; x < W; x++) {
    const i = row + 1 + x * 3;
    const shade = 0.75 + 0.25 * Math.sin((x + y) / 64);
    raw[i] = Math.min(255, Math.round(r * shade));
    raw[i + 1] = Math.min(255, Math.round(g * shade));
    raw[i + 2] = Math.min(255, Math.round(b * shade));
  }
}

const png = Buffer.concat([
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
  chunk("IHDR", Buffer.from([0, 0, 2, 0, 0, 2, 0, 8, 2, 0, 0, 0])), // 512x512, 8bit RGB
  chunk("IDAT", deflateSync(raw)),
  chunk("IEND", Buffer.alloc(0)),
]);

const root = process.env.YUGANG_MEDIA_ROOT ?? process.cwd();
mkdirSync(root, { recursive: true });
const file = join(root, outName ?? `draw-${Date.now()}.png`);
writeFileSync(file, png);
console.log(`[IMAGE:${file}]`);
console.log(`画的是：${text}`);

function chunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length);
  const body = Buffer.concat([Buffer.from(type, "ascii"), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body) >>> 0);
  return Buffer.concat([len, body, crc]);
}

function crc32(buf) {
  if (!crcTable) {
    crcTable = new Uint32Array(256);
    for (let n = 0; n < 256; n++) {
      let c = n;
      for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
      crcTable[n] = c >>> 0;
    }
  }
  let c = 0xffffffff;
  for (const byte of buf) c = crcTable[(c ^ byte) & 0xff] ^ (c >>> 8);
  return c ^ 0xffffffff;
}
