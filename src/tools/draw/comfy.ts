import { createHash, randomBytes, randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";

type Node = { class_type: string; inputs: Record<string, unknown> };
type Graph = Record<string, Node>;

const WORKFLOW_HASH = "d948b4e5d4ff3d42620d32d070af391aa1ad199c811d589bf60131df561c408b";
const GRAPH_BYTES = readFileSync(new URL("./workflow.json", import.meta.url));
if (createHash("sha256").update(GRAPH_BYTES).digest("hex") !== WORKFLOW_HASH) throw new Error("draw workflow hash mismatch");
const TEMPLATE = JSON.parse(GRAPH_BYTES.toString("utf8")) as Graph;
if (TEMPLATE["1"]?.inputs.unet_name !== "DeltaMix 3.8B V8.safetensors" || TEMPLATE["9"]?.class_type !== "PreviewImage") throw new Error("draw workflow contract mismatch");

// ── 多角色管线（独立模板，与单管线互不影响）──
const MULTI_WORKFLOW_HASH = "c76d978faf953adf6ed4abd341225a47f3ff2586c2ee43d970777aba36913fe2";
const MULTI_BYTES = readFileSync(new URL("./workflow-multi.json", import.meta.url));
if (createHash("sha256").update(MULTI_BYTES).digest("hex") !== MULTI_WORKFLOW_HASH) throw new Error("draw multi workflow hash mismatch");
const MULTI_TEMPLATE = JSON.parse(MULTI_BYTES.toString("utf8")) as Graph;
if (MULTI_TEMPLATE["89"]?.class_type !== "SetLatentNoiseMask" || MULTI_TEMPLATE["82"]?.class_type !== "KSampler" || MULTI_TEMPLATE["61"]?.class_type !== "ImageUpscaleWithModel") throw new Error("draw multi workflow contract mismatch");

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
}

/** 多角色段的 LoRA 注入位固定用 70-73（v3 窄幅拼贴拓扑，段节点 80-99）。 */

function multiLoraNode(file: string, weight: number): Node {
  return { class_type: "AnimaLoRARemapTagLoader", inputs: { model: ["1", 0], clip: ["2", 0], text: `<lora:${file}:${weight}>`, default_weight: 1, weight_multiplier: 1, auto_remap: true, save_remapped: false, extend_to_new_layers: false, extend_strength: 0.5, manifest: "Auto (Recommended)" } };
}

const MAX_IMAGE = 25 * 1024 * 1024;
const PNG = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);
const pause = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

export function makeMultiGraph(args: MultiDraw): Graph {
  const n = args.parts.length;
  if (n !== 2) throw new Error("invalid multi parts count"); // 工具层限双人；N>2 分区克隆预留
  if (args.width < 512 || args.width > 1536 || args.height < 512 || args.height > 1536 || args.width % 2 !== 0) throw new Error("invalid multi size");
  if (!args.prompt || args.prompt.length > 1000) throw new Error("invalid multi prompt");
  for (const p of args.parts) {
    if (!p.text || p.text.length > 800) throw new Error("invalid multi part text");
    if (p.role !== undefined && (!/^[\w .@()-]+\.safetensors$/.test(p.role.file) || !Number.isFinite(p.role.weight) || p.role.weight < 0.4 || p.role.weight > 1.1)) throw new Error("invalid multi role");
  }
  const g = structuredClone(MULTI_TEMPLATE);
  const seed = args.seed ?? randomBytes(4).readUInt32BE();
  const prefix = String(TEMPLATE["4"].inputs.text);
  // 场景段：2girls 双人构图——一次生成把两人站位/姿势/背景定死，后续分区只做特征强化
  g["30"].inputs.width = args.width;
  g["30"].inputs.height = args.height;
  g["31"].inputs.text = prefix + `2girls, ${args.parts.map((p) => p.text).join(" and ")}, ${args.prompt}`;
  g["32"].inputs.text = String(TEMPLATE["5"].inputs.text);
  for (const id of ["33", "82", "92", "64"]) g[id].inputs.seed = seed;
  // 分区 mask（与画布严格同尺寸——尺寸错配会让 mask 缩放错乱等效全图重绘，T1 实测教训）
  g["86"].inputs.width = args.width;
  g["86"].inputs.height = args.height;
  g["87"].inputs.width = args.width / 2;
  g["87"].inputs.height = args.height;
  g["88"].inputs.x = args.width / 2; // 左半重绘
  g["97"].inputs.x = 0;              // 右半重绘
  // 两个分区段：局部重绘各自半区，人数词用 1girl（局部对象明确；另一人已由构图轮定位、
  // mask 冻结保护，不构成语义冲突）、LoRA 条件注入
  const segs: Array<[string, string]> = [["81", "82"], ["91", "92"]];
  segs.forEach(([encId, ksId], i) => {
    const part = args.parts[i];
    g[encId].inputs.text = prefix + (part.role ? `${part.role.tags}, ` : "") + part.text + `, ${args.prompt}`;
    if (part.role) {
      const loraId = String(70 + i);
      g[loraId] = multiLoraNode(part.role.file, part.role.weight);
      g[ksId].inputs.model = [loraId, 0];
      g[encId].inputs.clip = [loraId, 1];
    }
  });
  // 收尾：人数学语义（2girls 融合 + 接缝过渡）
  g["67"] = { class_type: "CLIPTextEncode", inputs: { text: prefix + `2girls, ${args.prompt}`, clip: ["2", 0] } };
  g["64"].inputs.positive = ["67", 0];
  return g;
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

export async function runMulti(url: string, args: MultiDraw, onSubmitted: () => void, onStage?: (stage: DrawStage) => void): Promise<Buffer> {
  if (busy) throw new ComfyBusy("ComfyUI busy");
  busy = true;
  try { return await runMultiJob(url, args, onSubmitted, onStage); }
  finally { busy = false; }
}

async function runMultiJob(url: string, args: MultiDraw, onSubmitted: () => void, onStage?: (stage: DrawStage) => void): Promise<Buffer> {
  const base = comfyUrl(url);
  const queue = await (await request(`${base}/queue`)).json() as { queue_running?: unknown[]; queue_pending?: unknown[] };
  if (!Array.isArray(queue.queue_running) || !Array.isArray(queue.queue_pending)) throw new Error("invalid ComfyUI queue");
  if (queue.queue_running.length || queue.queue_pending.length) throw new ComfyBusy("ComfyUI busy");
  const graph = makeMultiGraph(args);
  const id = randomUUID();
  const clientId = randomUUID();
  let stageSocket: { close: () => void } | undefined;
  if (onStage) {
    try {
      const ws = new WebSocket(`${base.replace("http", "ws")}/ws?clientId=${clientId}`);
      ws.binaryType = "arraybuffer";
      const onMessage = makeMultiStageTracker(id, onStage);
      ws.addEventListener("message", (event) => onMessage((event as MessageEvent).data));
      ws.addEventListener("error", () => {});
      stageSocket = { close: () => { try { ws.close(); } catch { /* already closed */ } } };
    } catch { stageSocket = { close: () => {} }; }
  }
  try {
    onSubmitted();
    const response = await fetch(`${base}/prompt`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ prompt: graph, prompt_id: id, client_id: clientId }), redirect: "error", signal: AbortSignal.timeout(15_000) });
    if (response.status >= 400 && response.status < 500) throw new ComfyExecutionFailed(`ComfyUI rejected request (HTTP ${response.status})`);
    if (!response.ok) throw new Error(`ComfyUI HTTP ${response.status}`);
    const deadline = Date.now() + 560_000;
    while (Date.now() < deadline) {
      const history = await (await request(`${base}/history/${id}`)).json() as Record<string, { status?: { status_str?: string; completed?: boolean }; outputs?: Record<string, { images?: Array<{ filename?: string; subfolder?: string; type?: string }> }> }>;
      const job = history[id];
      if (job) {
        if (job.status?.status_str !== "success" || job.status.completed !== true) throw new ComfyExecutionFailed("ComfyUI execution failed");
        const images = job.outputs?.["66"]?.images;
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
