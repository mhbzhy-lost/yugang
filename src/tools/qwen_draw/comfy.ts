/** Qwen-Image-2.1 管线：静态模板 + 参数注入；执行内核复用 draw/comfy.ts（queue 闸/清单核对/提交轮询取图）。 */
import { randomInt, randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { ComfyBusy, execGraph, uploadRefImage, type Graph } from "../draw/comfy.ts";

const QUALITY_UNET = "qwen_image_2.1_bf16.safetensors";
const TURBO_UNET = "qwen_image_2.1_turbo_int8_convrot.safetensors";
const QUALITY_STEPS = 25;
const TURBO_STEPS = 8;

type Node = { class_type: string; inputs: Record<string, unknown> };
type Link = [string, number];

/** 比例 × 分辨率档 → 生成尺寸（像素，32 的倍数，贴 2.1 官方支持列表）。
 *  1024 档 ≈1MP 标准域；2048 档为官方 2K 原值。ref 模式不走此表（latent 沿参考图比例）。 */
export const RATIO_SIZES: Record<string, [number, number, number, number]> = {
  "1:1": [1024, 1024, 2048, 2048],
  "4:3": [1184, 896, 2400, 1792],
  "3:4": [896, 1184, 1792, 2400],
  "3:2": [1248, 832, 2520, 1696],
  "2:3": [832, 1248, 1696, 2520],
  "16:9": [1376, 768, 2752, 1536],
  "9:16": [768, 1376, 1536, 2752],
};

const TEMPLATE = JSON.parse(readFileSync(new URL("./workflow.json", import.meta.url)).toString("utf8")) as Graph;
const TEMPLATE_CONTRACT: Array<[string, string]> = [
  ["1", "UNETLoader"], ["2", "CLIPLoader"], ["3", "VAELoader"],
  ["4", "TextEncodeQwenImage21"], ["10", "EmptyImage"], ["11", "VAEEncode"],
  ["5", "KSampler"], ["6", "VAEDecode"], ["9", "PreviewImage"],
];
for (const [id, cls] of TEMPLATE_CONTRACT) {
  if (TEMPLATE[id]?.class_type !== cls) throw new Error(`qwen_draw workflow contract mismatch: node ${id} != ${cls}`);
}
if (TEMPLATE["1"]?.inputs.unet_name !== QUALITY_UNET) throw new Error("qwen_draw workflow contract mismatch: unet");
if (TEMPLATE["5"]?.inputs.steps !== QUALITY_STEPS) throw new Error("qwen_draw workflow contract mismatch: steps");

export interface QwenDrawArgs {
  prompt: string;
  ratio: string;
  resolution: 1024 | 2048;
  fast: boolean;
  ref?: { name: string; bytes: Buffer; ext: "png" | "jpg" | "jpeg" | "webp" };
  seed?: number;
}

function makeQwenGraph(args: QwenDrawArgs): Graph {
  const g: Record<string, Node> = JSON.parse(JSON.stringify(TEMPLATE));
  g["1"].inputs.unet_name = args.fast ? TURBO_UNET : QUALITY_UNET;
  g["4"].inputs.prompt = args.prompt;
  g["4"].inputs.resolution = args.resolution;
  g["5"].inputs.seed = args.seed ?? randomInt(0, 2 ** 31);
  g["5"].inputs.steps = args.fast ? TURBO_STEPS : QUALITY_STEPS;
  if (args.ref) {
    // 参考图：vision tower 看图 + VAE encode 成 reference_latents（锚定构图的重绘语义）。
    // latent 尺寸由参考图按 resolution 等比决定，EmptyImage 尺寸链下线。
    g["8"] = { class_type: "LoadImage", inputs: { image: args.ref.name, upload: "image" } };
    g["4"].inputs.vae = ["3", 0] as unknown as Link;
    g["4"].inputs.image_1 = ["8", 0] as unknown as Link;
    g["5"].inputs.latent_image = ["4", 2] as unknown as Link;
    delete g["10"];
    delete g["11"];
  } else {
    // 纯文生图：EmptyImage(黑图)→VAEEncode 造 64ch 任意比例 latent（denoise=1 时初始
    // latent 只是尺寸载体，内容会被噪声完全替换——与 zeros EmptyLatent 同理）。
    const sizes = RATIO_SIZES[args.ratio] ?? RATIO_SIZES["1:1"]!;
    const [w, h] = args.resolution === 2048 ? [sizes[2], sizes[3]] : [sizes[0], sizes[1]];
    g["10"].inputs.width = w;
    g["10"].inputs.height = h;
  }
  return g;
}

let busy = false;

/** 出图经 PreviewImage 走 temp（不污染 output 目录），图由调用方落 gen/。deadline 覆盖冷加载 + 2048 域。 */
export async function runQwenDraw(url: string, args: QwenDrawArgs, onSubmitted: () => void, signal?: AbortSignal): Promise<Buffer> {
  if (busy) throw new ComfyBusy("ComfyUI busy");
  busy = true;
  try {
    const uploaded = args.ref ? await uploadRefImage(url, args.ref.bytes, args.ref.ext, signal) : undefined;
    const ref = args.ref && uploaded !== undefined ? { ...args.ref, name: uploaded } : undefined;
    return await execGraph(url, makeQwenGraph({ ...args, ref }), { deadline: 500_000, outputNode: "9", outputType: "temp", onSubmitted, signal });
  } finally { busy = false; }
}
