import { createHash, randomBytes, randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { decodePngRgba, encodeMaskPng } from "./png.ts";

type Node = { class_type: string; inputs: Record<string, unknown> };
type Graph = Record<string, Node>;

const WORKFLOW_HASH = "d948b4e5d4ff3d42620d32d070af391aa1ad199c811d589bf60131df561c408b";
const GRAPH_BYTES = readFileSync(new URL("./workflow.json", import.meta.url));
if (createHash("sha256").update(GRAPH_BYTES).digest("hex") !== WORKFLOW_HASH) throw new Error("draw workflow hash mismatch");
const TEMPLATE = JSON.parse(GRAPH_BYTES.toString("utf8")) as Graph;
if (TEMPLATE["1"]?.inputs.unet_name !== "DeltaMix 3.8B V8.safetensors" || TEMPLATE["9"]?.class_type !== "PreviewImage") throw new Error("draw workflow contract mismatch");

// ── 多角色管线（独立模板，与单管线互不影响）──
const MULTI_WORKFLOW_HASH = "063b26fd81727bf478293220949ac97807613cf948aefc82a88345cb7d494924";
const MULTI_BYTES = readFileSync(new URL("./workflow-multi.json", import.meta.url));
if (createHash("sha256").update(MULTI_BYTES).digest("hex") !== MULTI_WORKFLOW_HASH) throw new Error("draw multi workflow hash mismatch");
const MULTI_TEMPLATE = JSON.parse(MULTI_BYTES.toString("utf8")) as Graph;
if (MULTI_TEMPLATE["89"]?.class_type !== "SetLatentNoiseMask" || MULTI_TEMPLATE["82"]?.class_type !== "KSampler" || MULTI_TEMPLATE["61"]?.class_type !== "ImageUpscaleWithModel" || MULTI_TEMPLATE["86"]?.class_type !== "LoadImage" || MULTI_TEMPLATE["97"]?.class_type !== "LoadImage" || MULTI_TEMPLATE["78"]?.class_type !== "LoadImage") throw new Error("draw multi workflow contract mismatch");

export interface ComfyDraw {
  prompt: string;
  bypass?: string;
  preset?: "default" | "hsr" | "secret";
  width?: number;
  height?: number;
  cfg?: number;
  seed?: number;
  handRepair?: boolean;
  /** 角色 LoRA：file/tags 来自 tool 层的 CHARACTERS 白名单，这里只做形态校验与注入。 */
  lora?: { file: string; weight: number; tags: string };
  ref?: { png: Buffer; strength: number };
}

export function comfyUrl(value: string): string {
  const url = new URL(value);
  if (url.protocol !== "http:" || url.hostname !== "127.0.0.1" || url.username || url.password || url.pathname !== "/" || url.search || url.hash) throw new Error("invalid ComfyUI endpoint");
  return url.origin;
}

export function makeGraph(args: ComfyDraw, inputName?: string): Graph {
  const graph = structuredClone(TEMPLATE);
  const seed = args.seed ?? randomBytes(4).readUInt32BE();
  for (const id of ["7", "11", "14", "42"]) graph[id].inputs.seed = seed;
  graph["7"].inputs.cfg = args.cfg ?? 4.5;
  graph["6"].inputs.width = args.width ?? 912;
  graph["6"].inputs.height = args.height ?? 1216;
  graph["4"].inputs.text = String(graph["4"].inputs.text) + (args.lora ? `${args.lora.tags}, ` : "") + args.prompt + (args.preset === "secret" ? ", completely nude" : "") + (args.bypass ? `, ${args.bypass}` : "");
  if (args.preset === "hsr") {
    graph["88"] = { class_type: "AnimaLoRARemapTagLoader", inputs: { model: ["1", 0], clip: ["2", 0], text: "<lora:HSR Anima:0.7>", default_weight: 1, weight_multiplier: 1, auto_remap: true, save_remapped: false, extend_to_new_layers: false, extend_strength: 0.5, manifest: "Auto (Recommended)" } };
    for (const id of ["7", "11", "14", "42"]) graph[id].inputs.model = ["88", 0];
    for (const id of ["4", "5", "11", "42"]) graph[id].inputs.clip = ["88", 1];
  }
  if (args.lora) {
    // 角色 LoRA 走与 hsr 相同的注入模式：节点链在 88 之后（hsr 在场时），消费方统一改接 93。
    if (!/^[\w .@()-]+\.safetensors$/.test(args.lora.file) || !Number.isFinite(args.lora.weight) || args.lora.weight < 0.4 || args.lora.weight > 1.1) throw new Error("invalid draw lora");
    const upstream = args.preset === "hsr" ? { model: ["88", 0], clip: ["88", 1] } : { model: ["1", 0], clip: ["2", 0] };
    graph["93"] = { class_type: "AnimaLoRARemapTagLoader", inputs: { model: upstream.model, clip: upstream.clip, text: `<lora:${args.lora.file}:${args.lora.weight}>`, default_weight: 1, weight_multiplier: 1, auto_remap: true, save_remapped: false, extend_to_new_layers: false, extend_strength: 0.5, manifest: "Auto (Recommended)" } };
    for (const id of ["7", "11", "14", "42"]) graph[id].inputs.model = ["93", 0];
    for (const id of ["4", "5", "11", "42"]) graph[id].inputs.clip = ["93", 1];
  }
  if (args.ref) {
    if (!inputName || !/^yugang-ref-[a-f0-9-]{36}\.png$/.test(inputName)) throw new Error("invalid draw input name");
    graph["19"] = { class_type: "LoadImage", inputs: { image: inputName } };
    graph["20"] = { class_type: "VAEEncode", inputs: { pixels: ["19", 0], vae: ["3", 0] } };
    graph["7"].inputs.latent_image = ["20", 0];
    graph["7"].inputs.denoise = args.ref.strength;
    delete graph["6"];
  }
  graph["90"] = { class_type: "UpscaleModelLoader", inputs: { model_name: "4x-AnimeSharp.safetensors" } };
  graph["91"] = { class_type: "ImageUpscaleWithModel", inputs: { upscale_model: ["90", 0], image: [args.handRepair === false ? "43" : "42", 0] } };
  graph["92"] = { class_type: "ImageScaleBy", inputs: { image: ["91", 0], upscale_method: "lanczos", scale_by: 0.5 } };
  graph["44"].inputs.pixels = ["92", 0];
  graph["13"].inputs.scale_by = 1;
  return graph;
}

// ── 多角色管线：分区重绘 + 像素合成（拓扑见 /tmp/draw-multi-survey.md，实测 2026-11-08）──

export interface MultiPart {
  text: string;
  role?: { file: string; weight: number; tags: string };
}
export interface MultiDraw {
  prompt: string;
  width: number;
  height: number;
  seed?: number;
  parts: MultiPart[];
  /** 手修可选（脸修常开）：false 跳过手部段，语义与单管线 hand_repair 一致。 */
  handRepair?: boolean;
}

/** 多角色段的 LoRA 注入位固定用 70-73（v3 窄幅拼贴拓扑，段节点 80-99）。 */

function multiLoraNode(file: string, weight: number): Node {
  return { class_type: "AnimaLoRARemapTagLoader", inputs: { model: ["1", 0], clip: ["2", 0], text: `<lora:${file}:${weight}>`, default_weight: 1, weight_multiplier: 1, auto_remap: true, save_remapped: false, extend_to_new_layers: false, extend_strength: 0.5, manifest: "Auto (Recommended)" } };
}

const MAX_IMAGE = 25 * 1024 * 1024;
const PNG = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);
const pause = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

/** 多角色 mask 形状模式：region=三直边+曲分界线（人物完整归属+自侧背景过渡）；silhouette=仅人物形状膨胀 24px。 */
export type MaskShape = "region" | "silhouette";

function validateMulti(args: MultiDraw): void {
  const n = args.parts.length;
  if (n !== 2) throw new Error("invalid multi parts count"); // 工具层限双人；N>2 分区克隆预留
  if (args.width < 512 || args.width > 1536 || args.height < 512 || args.height > 1536 || args.width % 2 !== 0) throw new Error("invalid multi size");
  if (!args.prompt || args.prompt.length > 1000) throw new Error("invalid multi prompt");
  for (const p of args.parts) {
    if (!p.text || p.text.length > 800) throw new Error("invalid multi part text");
    if (p.role !== undefined && (!/^[\w .@()-]+\.safetensors$/.test(p.role.file) || !Number.isFinite(p.role.weight) || p.role.weight < 0.4 || p.role.weight > 1.1)) throw new Error("invalid multi role");
  }
}

/** 阶段一 graph：2girls 构图 30 步 + person YOLO + SAM 分实例分割（拓扑 2026-11 真机验证）。 */
export function makeMultiSceneGraph(args: MultiDraw): Graph {
  validateMulti(args);
  const seed = args.seed ?? randomBytes(4).readUInt32BE();
  const prefix = String(TEMPLATE["4"].inputs.text);
  return {
    "1": structuredClone(MULTI_TEMPLATE["1"]),
    "2": structuredClone(MULTI_TEMPLATE["2"]),
    "3": structuredClone(MULTI_TEMPLATE["3"]),
    "30": { class_type: "EmptySD3LatentImage", inputs: { width: args.width, height: args.height, batch_size: 1 } },
    "31": { class_type: "CLIPTextEncode", inputs: { text: prefix + `2girls, ${args.parts.map((p) => p.text).join(" and ")}, ${args.prompt}`, clip: ["2", 0] } },
    "32": { class_type: "CLIPTextEncode", inputs: { text: String(TEMPLATE["5"].inputs.text), clip: ["2", 0] } },
    "33": { class_type: "KSampler", inputs: { seed, steps: 30, cfg: 4.5, sampler_name: "dpmpp_2m", scheduler: "sgm_uniform", denoise: 1, model: ["1", 0], positive: ["31", 0], negative: ["32", 0], latent_image: ["30", 0] } },
    "34": { class_type: "VAEDecode", inputs: { samples: ["33", 0], vae: ["3", 0] } },
    // 构图预览：阶段二上传的底图从这取回
    "208": { class_type: "PreviewImage", inputs: { images: ["34", 0] } },
    // 分割链：YOLO 检测 → SEGS 裁切 → SAM 分实例
    "200": { class_type: "UltralyticsDetectorProvider", inputs: { model_name: "bbox/person_yolov8m.pt" } },
    "201": { class_type: "SAMLoader", inputs: { model_name: "sam_vit_b_01ec64.pth", device_mode: "AUTO" } },
    "202": { class_type: "BboxDetectorSEGS", inputs: { bbox_detector: ["200", 0], image: ["34", 0], threshold: 0.5, dilation: 10, crop_factor: 3, drop_size: 10, labels: "" } },
    "203": { class_type: "SAMDetectorSegmented", inputs: { sam_model: ["201", 0], segs: ["202", 0], image: ["34", 0], detection_hint: "center-1", dilation: 0, threshold: 0.93, bbox_expansion: 0, mask_hint_threshold: 0.7, mask_hint_use_negative: "False" } },
    "204": { class_type: "MaskToImage", inputs: { mask: ["203", 0] } },
    "205": { class_type: "PreviewImage", inputs: { images: ["204", 0] } }, // combined mask（调试用，不消费）
    "206": { class_type: "MaskToImage", inputs: { mask: ["203", 1] } },
    "207": { class_type: "PreviewImage", inputs: { images: ["206", 0] } }, // batch 每实例一张
  };
}

/** 阶段二 graph：上传底图 + 双 mask 回注（LoadImage MASK=1-alpha，mask 由宿主生成）。 */
export function makeMultiGraph(args: MultiDraw, inputs: { image: string; maskLeft: string; maskRight: string }): Graph {
  validateMulti(args);
  if (!/^yugang-ref-[a-f0-9-]{36}\.png$/.test(inputs.image) || !/^yugang-ref-[a-f0-9-]{36}\.png$/.test(inputs.maskLeft) || !/^yugang-ref-[a-f0-9-]{36}\.png$/.test(inputs.maskRight)) throw new Error("invalid multi input name");
  const g = structuredClone(MULTI_TEMPLATE);
  const seed = args.seed ?? randomBytes(4).readUInt32BE();
  const prefix = String(TEMPLATE["4"].inputs.text);
  // 阶段一独立提交，构图节点 30/33/34 不在阶段二执行链上——直接删除免得被预拉取
  delete g["30"];
  delete g["33"];
  delete g["34"];
  g["31"].inputs.text = prefix + "2girls, " + args.parts.map((p) => p.text).join(" and ") + ", " + args.prompt;
  for (const id of ["82", "92", "64", "101", "103"]) g[id].inputs.seed = seed;
  // 脸修常开；手修可选（false 时 Preview 直接接脸修输出、手修段不进执行链）
  if (args.handRepair === false) {
    g["66"].inputs.images = ["101", 0];
    delete g["102"];
    delete g["103"];
  }
  g["78"].inputs.image = inputs.image;
  g["86"].inputs.image = inputs.maskLeft;   // 左区 mask（A）
  g["97"].inputs.image = inputs.maskRight;  // 右区 mask（B）
  // 两个分区段：局部重绘各自半区，人数词用 1girl（局部对象明确；另一人已由构图轮定位、
  // mask 冻结保护，不构成语义冲突）、LoRA 条件注入
  const segs: Array<[string, string]> = [["81", "82"], ["91", "92"]];
  segs.forEach(([encId, ksId], i) => {
    const part = args.parts[i];
    g[encId].inputs.text = prefix + (part.role ? part.role.tags + ", " : "") + part.text + ", " + args.prompt;
    if (part.role) {
      const loraId = String(70 + i);
      g[loraId] = multiLoraNode(part.role.file, part.role.weight);
      g[ksId].inputs.model = [loraId, 0];
      g[encId].inputs.clip = [loraId, 1];
    }
  });
  // 收尾：人数学语义（2girls 融合 + 接缝过渡）
  g["67"] = { class_type: "CLIPTextEncode", inputs: { text: prefix + "2girls, " + args.prompt, clip: ["2", 0] } };
  g["64"].inputs.positive = ["67", 0];
  return g;
}

// ── 宿主侧 mask 构造（v8：人物边界精确 mask）──

/** 解码实例 mask 预览 PNG 为二值图（R 通道>127 为白），并算面积与质心 x。 */
function instanceBinary(buf: Buffer, width: number, height: number): { bin: Uint8Array; area: number; centroidX: number } {
  const img = decodePngRgba(buf);
  if (img.width !== width || img.height !== height) throw new ComfyExecutionFailed("multi mask size mismatch");
  const bin = new Uint8Array(width * height);
  let area = 0;
  let sx = 0;
  for (let i = 0; i < width * height; i++) {
    if (img.data[i * 4] > 127) {
      bin[i] = 1;
      area++;
      sx += i % width;
    }
  }
  return { bin, area, centroidX: area > 0 ? sx / area : 0 };
}

/** 曲分界线：对每行取左实例最右白像素 xL 与右实例最左白像素 xR，分界点=(xL+xR)/2；
 *  单侧有人贴该侧边缘；两侧都无人沿用上一行；7 行中值滤波平滑。 */
function boundaryCurve(left: Uint8Array, right: Uint8Array, width: number, height: number): Float64Array {
  const raw = new Float64Array(height);
  let prev = width / 2;
  for (let y = 0; y < height; y++) {
    const row = y * width;
    let xl = -1;
    let xr = -1;
    for (let x = 0; x < width; x++) if (left[row + x]) xl = x;
    for (let x = width - 1; x >= 0; x--) if (right[row + x]) { xr = x; break; }
    const b = xl >= 0 && xr >= 0 ? (xl + xr) / 2 : xl >= 0 ? xl + 1 : xr >= 0 ? xr : prev;
    raw[y] = b;
    prev = b;
  }
  const out = new Float64Array(height);
  const win: number[] = [];
  for (let y = 0; y < height; y++) {
    win.length = 0;
    for (let k = Math.max(0, y - 3); k <= Math.min(height - 1, y + 3); k++) win.push(raw[k]);
    win.sort((a, b) => a - b);
    out[y] = win[win.length >> 1];
  }
  return out;
}

/** 方形膨胀（行+列两趟 max 滤波）：给人物边缘留过渡带。 */
function dilateSquare(bin: Uint8Array, width: number, height: number, radius: number): Uint8Array {
  const tmp = new Uint8Array(width * height);
  for (let y = 0; y < height; y++) {
    const row = y * width;
    for (let x = 0; x < width; x++) {
      if (tmp[row + x]) continue;
      const lo = Math.max(0, x - radius);
      const hi = Math.min(width - 1, x + radius);
      let hit = 0;
      for (let k = lo; k <= hi; k++) if (bin[row + k]) { hit = 1; break; }
      if (hit) for (let k = lo; k <= hi; k++) tmp[row + k] = 1;
    }
  }
  const out = new Uint8Array(width * height);
  for (let x = 0; x < width; x++) {
    for (let y = 0; y < height; y++) {
      if (out[y * width + x]) continue;
      const lo = Math.max(0, y - radius);
      const hi = Math.min(height - 1, y + radius);
      let hit = 0;
      for (let k = lo; k <= hi; k++) if (tmp[k * width + x]) { hit = 1; break; }
      if (hit) for (let k = lo; k <= hi; k++) out[k * width + x] = 1;
    }
  }
  return out;
}

/** 由左右实例二值图构造两张重绘 mask PNG（顺序 [左A, 右B]，与 parts 对应）。 */
export function buildMultiMasks(left: Uint8Array, right: Uint8Array, width: number, height: number, shape: MaskShape): [Buffer, Buffer] {
  if (shape === "silhouette") {
    const dl = dilateSquare(left, width, height, 24);
    const dr = dilateSquare(right, width, height, 24);
    return [encodeMaskPng(width, height, (x, y) => dl[y * width + x] === 1), encodeMaskPng(width, height, (x, y) => dr[y * width + x] === 1)];
  }
  // region: guard 硬排除对方实例（膨胀后），防分界曲线异常侵入对方
  const curve = boundaryCurve(left, right, width, height);
  const guardL = dilateSquare(right, width, height, 24); // 右实例膨胀，从 maskA 里排除
  const guardR = dilateSquare(left, width, height, 24);  // 左实例膨胀，从 maskB 里排除
  return [
    encodeMaskPng(width, height, (x, y) => x < curve[y] && guardL[y * width + x] === 0),
    encodeMaskPng(width, height, (x, y) => x >= curve[y] && guardR[y * width + x] === 0),
  ];
}


export class ComfyExecutionFailed extends Error {}
export class ComfyBusy extends Error {}
let busy = false;

/** draw 阶段进度（不过模型）：sketch/refine=单管线；multi-*=多角色管线三段。 */
export type DrawStage = "sketch" | "refine" | "multi-scene" | "multi-first" | "multi-second";

/** 阶段状态机：实测事件序列（2026-11-08）——"7"初采样 → "43"/"42"手修（hand_repair=false 时直接"91"超分）
 *  → "91"/"92"/"44"/"13" → "14"二次采样 → "8"/"11"脸修 → "9"输出。
 *  进入初采样后首批节点（sketch）与二次采样后首批节点（refine）时各汇报一次；乱序/未知节点忽略。 */
function makeStageTracker(promptId: string, onStage: (stage: DrawStage) => void): (message: unknown) => void {
  let stage = 0;
  return (message) => {
    if (typeof message !== "string") return; // 二进制预览帧忽略
    try {
      const event = JSON.parse(message) as { type?: string; data?: { node?: string | null; prompt_id?: string } };
      if (event.type !== "executing" || event.data?.prompt_id !== promptId) return;
      const node = event.data?.node;
      if (typeof node !== "string") return;
      if (stage < 1 && (node === "43" || node === "42" || node === "91")) {
        stage = 1;
        onStage("sketch");
      } else if (stage < 2 && (node === "8" || node === "11")) {
        stage = 2;
        onStage("refine");
      }
    } catch { /* 非 JSON 帧忽略 */ }
  };
}

/** 连 comfy ws 订阅本任务事件；开不了/断了都静默降级（进度提示可选，不影响出图）。 */
function openStageSocket(base: string, clientId: string, promptId: string, onStage: (stage: DrawStage) => void): { close: () => void } {
  try {
    const ws = new WebSocket(`${base.replace("http", "ws")}/ws?clientId=${clientId}`);
    ws.binaryType = "arraybuffer";
    const onMessage = makeStageTracker(promptId, onStage);
    ws.addEventListener("message", (event) => onMessage((event as MessageEvent).data));
    ws.addEventListener("error", () => {});
    return { close: () => { try { ws.close(); } catch { /* already closed */ } } };
  } catch {
    return { close: () => {} };
  }
}

async function request(url: string, init: RequestInit = {}, timeout = 10_000): Promise<Response> {
  const res = await fetch(url, { ...init, redirect: "error", signal: AbortSignal.timeout(timeout) });
  if (!res.ok) throw new Error(`ComfyUI HTTP ${res.status}`);
  return res;
}

async function imageBytes(response: Response): Promise<Buffer> {
  const size = Number(response.headers.get("content-length") ?? 0);
  if (!response.headers.get("content-type")?.toLowerCase().startsWith("image/png") || size > MAX_IMAGE || !response.body) throw new Error("invalid image response");
  const parts: Uint8Array[] = [];
  let total = 0;
  const reader = response.body.getReader();
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.length;
      if (total > MAX_IMAGE) throw new Error("invalid image size");
      parts.push(value);
    }
  } finally { await reader.cancel().catch(() => {}); }
  const data = Buffer.concat(parts);
  if (data.length < 24 || !data.subarray(0, 8).equals(PNG) || data.toString("ascii", 12, 16) !== "IHDR" || !data.readUInt32BE(16) || !data.readUInt32BE(20) || data.readUInt32BE(16) > 4096 || data.readUInt32BE(20) > 4096) throw new Error("invalid PNG output");
  return data;
}

/** onSubmitted is called before the POST: a network failure cannot prove it was not accepted. */
export async function runComfy(url: string, args: ComfyDraw, onSubmitted: () => void, onStage?: (stage: DrawStage) => void): Promise<Buffer> {
  if (busy) throw new ComfyBusy("ComfyUI busy");
  busy = true;
  try { return await runComfyJob(url, args, onSubmitted, onStage); }
  finally { busy = false; }
}

async function runComfyJob(url: string, args: ComfyDraw, onSubmitted: () => void, onStage?: (stage: DrawStage) => void): Promise<Buffer> {
  const base = comfyUrl(url);
  const queue = await (await request(`${base}/queue`)).json() as { queue_running?: unknown[]; queue_pending?: unknown[] };
  if (!Array.isArray(queue.queue_running) || !Array.isArray(queue.queue_pending)) throw new Error("invalid ComfyUI queue");
  if (queue.queue_running.length || queue.queue_pending.length) throw new ComfyBusy("ComfyUI busy");
  let name: string | undefined;
  if (args.ref) {
    name = `yugang-ref-${randomUUID()}.png`;
    const form = new FormData();
    form.set("image", new Blob([new Uint8Array(args.ref.png)], { type: "image/png" }), name);
    form.set("type", "input");
    form.set("overwrite", "false");
    const upload = await (await request(`${base}/upload/image`, { method: "POST", body: form }, 30_000)).json() as { name?: string; subfolder?: string; type?: string };
    if (upload.name !== name || upload.subfolder || upload.type !== "input") throw new Error("unexpected ComfyUI upload path");
  }
  const graph = makeGraph(args, name);
  const id = randomUUID();
  const clientId = randomUUID();
  const stageSocket = onStage ? openStageSocket(base, clientId, id, onStage) : undefined;
  try {
  onSubmitted();
  const response = await fetch(`${base}/prompt`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ prompt: graph, prompt_id: id, client_id: clientId }), redirect: "error", signal: AbortSignal.timeout(15_000) });
  if (response.status >= 400 && response.status < 500) throw new ComfyExecutionFailed(`ComfyUI rejected request (HTTP ${response.status})`);
  if (!response.ok) throw new Error(`ComfyUI HTTP ${response.status}`);
  const submitted = await response.json() as { prompt_id?: string };
  if (submitted.prompt_id !== id) throw new Error("unexpected ComfyUI prompt id");
  const deadline = Date.now() + 240_000;
  while (Date.now() < deadline) {
    const history = await (await request(`${base}/history/${id}`)).json() as Record<string, { status?: { status_str?: string; completed?: boolean }; outputs?: Record<string, { images?: Array<{ filename?: string; subfolder?: string; type?: string }> }> }>;
    const job = history[id];
    if (job) {
      if (job.status?.status_str !== "success" || job.status.completed !== true) throw new ComfyExecutionFailed("ComfyUI execution failed");
      const images = job.outputs?.["9"]?.images;
      if (!Array.isArray(images) || images.length !== 1) throw new Error("invalid ComfyUI output");
      const image = images[0];
      if (image.type !== "temp" || !image.filename || !/^[A-Za-z0-9_.-]+\.png$/.test(image.filename) || image.subfolder) throw new Error("invalid ComfyUI output path");
      const query = new URLSearchParams({ filename: image.filename, type: "temp", subfolder: "" });
      return imageBytes(await request(`${base}/view?${query}`, {}, 30_000));
    }
    await pause(1500);
  }
  throw new Error("ComfyUI history timeout");
  } finally {
    stageSocket?.close();
  }
}

/** 多角色阶段追踪（v6 真局部重绘）：场景完成="34"、角色1完成=进入段B"90"/"91"、收尾融合="60"/"61"。 */
function makeMultiStageTracker(promptId: string, onStage: (stage: DrawStage) => void): (message: unknown) => void {
  let stage = 0;
  return (message) => {
    if (typeof message !== "string") return;
    try {
      const event = JSON.parse(message) as { type?: string; data?: { node?: string | null; prompt_id?: string } };
      if (event.type !== "executing" || event.data?.prompt_id !== promptId) return;
      const node = event.data?.node;
      if (typeof node !== "string") return;
      if (stage < 1 && node === "34") { stage = 1; onStage("multi-scene"); }
      else if (stage < 2 && (node === "90" || node === "91")) { stage = 2; onStage("multi-first"); }
      else if (stage < 3 && (node === "60" || node === "61")) { stage = 3; onStage("multi-second"); }
    } catch { /* ignore */ }
  };
}

export async function runMulti(url: string, args: MultiDraw, onSubmitted: () => void, onStage?: (stage: DrawStage) => void, shape: MaskShape = "silhouette"): Promise<Buffer> {
  if (busy) throw new ComfyBusy("ComfyUI busy");
  busy = true;
  try { return await runMultiJob(url, args, onSubmitted, onStage, shape); }
  finally { busy = false; }
}

type ComfyHistoryJob = { status?: { status_str?: string; completed?: boolean }; outputs?: Record<string, { images?: Array<{ filename?: string; subfolder?: string; type?: string }> }> };

/** 提交一个 graph 并轮询到成功（失败/超时抛错）；阶段一/二共用。 */
async function submitAndWait(base: string, graph: Graph, promptId: string, clientId: string, deadline: number): Promise<ComfyHistoryJob> {
  const response = await fetch(`${base}/prompt`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ prompt: graph, prompt_id: promptId, client_id: clientId }), redirect: "error", signal: AbortSignal.timeout(15_000) });
  if (response.status >= 400 && response.status < 500) throw new ComfyExecutionFailed(`ComfyUI rejected request (HTTP ${response.status})`);
  if (!response.ok) throw new Error(`ComfyUI HTTP ${response.status}`);
  while (Date.now() < deadline) {
    const history = await (await request(`${base}/history/${promptId}`)).json() as Record<string, ComfyHistoryJob>;
    const job = history[promptId];
    if (job) {
      if (job.status?.status_str !== "success" || job.status.completed !== true) throw new ComfyExecutionFailed("ComfyUI execution failed");
      return job;
    }
    await pause(1500);
  }
  throw new Error("ComfyUI history timeout");
}

/** 从 history 输出里取一张图（nodeId 下恰好 1 张，temp 路径校验同单管线）。 */
async function fetchOutputImage(base: string, job: ComfyHistoryJob, nodeId: string): Promise<Buffer> {
  const images = job.outputs?.[nodeId]?.images;
  if (!Array.isArray(images) || images.length !== 1) throw new Error("invalid ComfyUI output");
  const image = images[0];
  if (image.type !== "temp" || !image.filename || !/^[A-Za-z0-9_.-]+\.png$/.test(image.filename) || image.subfolder) throw new Error("invalid ComfyUI output path");
  const query = new URLSearchParams({ filename: image.filename, type: "temp", subfolder: "" });
  return imageBytes(await request(`${base}/view?${query}`, {}, 30_000));
}

/** 上传一张 PNG 到 ComfyUI input 区（yugang-ref 前缀交给清理任务收尾）。 */
async function uploadInput(base: string, png: Buffer): Promise<string> {
  const name = `yugang-ref-${randomUUID()}.png`;
  const form = new FormData();
  form.set("image", new Blob([new Uint8Array(png)], { type: "image/png" }), name);
  form.set("type", "input");
  form.set("overwrite", "false");
  const upload = await (await request(`${base}/upload/image`, { method: "POST", body: form }, 30_000)).json() as { name?: string; subfolder?: string; type?: string };
  if (upload.name !== name || upload.subfolder || upload.type !== "input") throw new Error("unexpected ComfyUI upload path");
  return name;
}

async function runMultiJob(url: string, args: MultiDraw, onSubmitted: () => void, onStage?: (stage: DrawStage) => void, shape: MaskShape = "region"): Promise<Buffer> {
  const base = comfyUrl(url);
  // busy 与队列校验只做一次：两阶段是一个占用，阶段间不释放
  const queue = await (await request(`${base}/queue`)).json() as { queue_running?: unknown[]; queue_pending?: unknown[] };
  if (!Array.isArray(queue.queue_running) || !Array.isArray(queue.queue_pending)) throw new Error("invalid ComfyUI queue");
  if (queue.queue_running.length || queue.queue_pending.length) throw new ComfyBusy("ComfyUI busy");
  const clientId = randomUUID();
  const deadline = Date.now() + 560_000;
  // ── 阶段一：构图 + 分实例分割，取回构图底图与逐实例 mask ──
  const sceneId = randomUUID();
  onSubmitted();
  const sceneJob = await submitAndWait(base, makeMultiSceneGraph(args), sceneId, clientId, deadline - 240_000);
  const composition = await fetchOutputImage(base, sceneJob, "208");
  const batchImages = sceneJob.outputs?.["207"]?.images;
  if (!Array.isArray(batchImages) || batchImages.length < 1) throw new ComfyExecutionFailed("multi segmentation failed");
  const instanceMasks = await Promise.all(batchImages.map(async (image) => {
    if (image.type !== "temp" || !image.filename || !/^[A-Za-z0-9_.-]+\.png$/.test(image.filename) || image.subfolder) throw new Error("invalid ComfyUI output path");
    const query = new URLSearchParams({ filename: image.filename, type: "temp", subfolder: "" });
    return imageBytes(await request(`${base}/view?${query}`, {}, 30_000));
  }));
  // ── 宿主 mask 构造：白区面积最大的两张实例 mask，按质心 x 分左右（<2 张=构图失败，走 v7 失败路径）──
  const binaries = instanceMasks.map((buf) => instanceBinary(buf, args.width, args.height));
  binaries.sort((a, b) => b.area - a.area);
  if (binaries.length < 2 || binaries[1].area <= 0) throw new ComfyExecutionFailed("multi segmentation failed");
  const [first, second] = binaries;
  const leftBin = first.centroidX <= second.centroidX ? first.bin : second.bin;
  const rightBin = first.centroidX <= second.centroidX ? second.bin : first.bin;
  const masks = buildMultiMasks(leftBin, rightBin, args.width, args.height, shape);
  // ── 阶段二：上传底图 + 双 mask，分区精修 + 收尾超分 ──
  const [imageName, maskLeft, maskRight] = await Promise.all([uploadInput(base, composition), uploadInput(base, masks[0]), uploadInput(base, masks[1])]);
  onStage?.("multi-scene");
  const refineId = randomUUID();
  const graph = makeMultiGraph(args, { image: imageName, maskLeft, maskRight });
  let stageSocket: { close: () => void } | undefined;
  if (onStage) {
    try {
      const ws = new WebSocket(`${base.replace("http", "ws")}/ws?clientId=${clientId}`);
      ws.binaryType = "arraybuffer";
      const onMessage = makeMultiStageTracker(refineId, onStage);
      ws.addEventListener("message", (event) => onMessage((event as MessageEvent).data));
      ws.addEventListener("error", () => {});
      stageSocket = { close: () => { try { ws.close(); } catch { /* already closed */ } } };
    } catch { stageSocket = { close: () => {} }; }
  }
  try {
    const refineJob = await submitAndWait(base, graph, refineId, clientId, deadline);
    return await fetchOutputImage(base, refineJob, "66");
  } finally {
    stageSocket?.close();
  }
}
