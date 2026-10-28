/**
 * draw —— 一个手写的扩展工具，替代原来的 skills/draw。
 *
 * 这是本项目的扩展范式：能力 = 一个 defineTool + 一份 prompt/tools/<name>.md。
 * 不放脚本、不调 shell、不给模型任何执行能力，只给一个狭窄的函数。
 *
 * 现在的后端是本地生成的占位图；接真模型（ComfyUI / 通义万相 / SiliconFlow）时只改
 * renderImage 这一处，工具的契约和文案都不用动。
 */
import { deflateSync } from "node:zlib";
import { writeFileSync, mkdirSync } from "node:fs";
import { join, resolve } from "node:path";
import { Type } from "@earendil-works/pi-ai";
import { defineTool } from "@earendil-works/pi-durable";
import { renderTemplate, requireTool, type PromptSet } from "../prompts.ts";

export interface DrawDeps {
  mediaRoot: string;
  prompts: PromptSet;
}

export function createDrawTool(deps: DrawDeps) {
  const root = resolve(deps.mediaRoot);

  return defineTool({
    name: "draw",
    description: requireTool(deps.prompts, "draw").description,
    callers: ["model"],
    parameters: Type.Object({
      description: Type.String({ description: requireTool(deps.prompts, "draw").params["description"] ?? "" }),
      color: Type.Optional(Type.String({ description: requireTool(deps.prompts, "draw").params["color"] ?? "" })),
    }),
    execute: async (args) => {
      if (!args.description.trim()) throw new Error(deps.prompts.messages["draw_empty"] ?? "empty");
      if (args.description.length > 200) throw new Error(deps.prompts.messages["draw_too_long"] ?? "too long");

      mkdirSync(root, { recursive: true });
      const file = join(root, `draw-${Date.now()}.png`);
      writeFileSync(file, renderImage(args.color));

      const text = renderTemplate(deps.prompts.messages["draw_done"] ?? "{{path}}", { path: file });
      return { output: [{ type: "text", text }] };
    },
  });
}

/** 占位渲染：一张带渐变的纯色图。换真后端时替换这个函数即可。 */
function renderImage(hex = "#3b82f6"): Buffer {
  const [r, g, b] = [0, 2, 4].map((i) => parseInt(hex.replace("#", "").slice(i, i + 2), 16) || 0);
  const W = 512;
  const H = 512;
  const raw = Buffer.alloc((W * 3 + 1) * H);
  for (let y = 0; y < H; y++) {
    const row = y * (W * 3 + 1);
    for (let x = 0; x < W; x++) {
      const i = row + 1 + x * 3;
      const shade = 0.75 + 0.25 * Math.sin((x + y) / 64);
      raw[i] = Math.min(255, Math.round(r * shade));
      raw[i + 1] = Math.min(255, Math.round(g * shade));
      raw[i + 2] = Math.min(255, Math.round(b * shade));
    }
  }
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk("IHDR", Buffer.from([0, 0, 2, 0, 0, 2, 0, 8, 2, 0, 0, 0])),
    chunk("IDAT", deflateSync(raw)),
    chunk("IEND", Buffer.alloc(0)),
  ]);
}

function chunk(type: string, data: Buffer): Buffer {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length);
  const body = Buffer.concat([Buffer.from(type, "ascii"), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body) >>> 0);
  return Buffer.concat([len, body, crc]);
}

let crcTable: Uint32Array | undefined;
function crc32(buf: Buffer): number {
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
