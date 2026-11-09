import { createHash, randomBytes, randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";

type Node = { class_type: string; inputs: Record<string, unknown> };
type Graph = Record<string, Node>;

const WORKFLOW_HASH = "d948b4e5d4ff3d42620d32d070af391aa1ad199c811d589bf60131df561c408b";
const GRAPH_BYTES = readFileSync(new URL("./workflow.json", import.meta.url));
if (createHash("sha256").update(GRAPH_BYTES).digest("hex") !== WORKFLOW_HASH) throw new Error("draw workflow hash mismatch");
const TEMPLATE = JSON.parse(GRAPH_BYTES.toString("utf8")) as Graph;
if (TEMPLATE["1"]?.inputs.unet_name !== "DeltaMix 3.8B V8.safetensors" || TEMPLATE["9"]?.class_type !== "PreviewImage") throw new Error("draw workflow contract mismatch");

// ── 双人管线（独立模板，与单人管线互不影响）──
const RS_WORKFLOW_HASH = "fcbd6e8011b7721753a487a49116075f10db72eb92b62d53208a0a697b13682a";
const RS_BYTES = readFileSync(new URL("./workflow-rs.json", import.meta.url));
if (createHash("sha256").update(RS_BYTES).digest("hex") !== RS_WORKFLOW_HASH) throw new Error("draw RS workflow hash mismatch");
const RS_TEMPLATE = JSON.parse(RS_BYTES.toString("utf8")) as Graph;
if (RS_TEMPLATE["4"]?.class_type !== "RSMultiCharacterPrompts" || RS_TEMPLATE["5"]?.class_type !== "RSMultiCharacterSampler" || RS_TEMPLATE["61"]?.class_type !== "ImageUpscaleWithModel" || RS_TEMPLATE["64"]?.class_type !== "KSampler" || RS_TEMPLATE["66"]?.class_type !== "PreviewImage" || RS_TEMPLATE["101"]?.class_type !== "FaceDetailer") throw new Error("draw RS workflow contract mismatch");

export interface ComfyDraw {
  prompt: string;
  bypass?: string;
  /** 人物级 bypass（pbypass: 段）：单角色无分区概念，追加在 bypass 之后（同一正向末尾）。 */
  bypassP?: string;
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
  graph["4"].inputs.text = String(graph["4"].inputs.text) + (args.lora ? `${args.lora.tags}, ` : "") + args.prompt + (args.preset === "secret" ? ", completely nude" : "") + (args.bypass ? `, ${args.bypass}` : "") + (args.bypassP ? `, ${args.bypassP}` : "");
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

// ── 双人管线：RS 点位分区一次成型，后接超分、二次采样和脸修 ──

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
  /** 场景级 bypass（bypass: 段）：附加到初始生成与收尾段末尾。 */
  bypass?: string;
  /** 人物级 bypass（pbypass: 段）：附加到两个人物的区域提示末尾。 */
  pbypass?: string;
}

const MAX_IMAGE = 25 * 1024 * 1024;
const PNG = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);
const pause = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

function validateMulti(args: MultiDraw): void {
  const n = args.parts.length;
  if (n !== 2) throw new Error("invalid multi parts count");
  if (args.width < 512 || args.width > 1536 || args.height < 512 || args.height > 1536 || args.width % 2 !== 0) throw new Error("invalid multi size");
  if (!args.prompt || args.prompt.length > 1000) throw new Error("invalid multi prompt");
  for (const p of args.parts) {
    if (!p.text || p.text.length > 800) throw new Error("invalid multi part text");
    if (p.role !== undefined && (!/^[\w .@()-]+\.safetensors$/.test(p.role.file) || !Number.isFinite(p.role.weight) || p.role.weight < 0.4 || p.role.weight > 1.1)) throw new Error("invalid multi role");
  }
}

function multiRoleTags(part: MultiPart): string {
  return (part.role?.tags ?? "").split(",").map((tag) => tag.trim()).filter((tag) => tag && !/^(?:1girl|solo)$/i.test(tag)).join(", ");
}

function multiSceneText(args: MultiDraw): string {
  const describe = (part: MultiPart) => [multiRoleTags(part), part.text].filter(Boolean).join(", ");
  return String(TEMPLATE["4"].inputs.text) + "2girls, on the left side: " + describe(args.parts[0]) + ", on the right side: " + describe(args.parts[1]) + ", " + args.prompt + (args.bypass ? ", " + args.bypass : "");
}

/** 双人唯一管线：RS 点位独立提示 → AnimeSharp → 低强度二次采样 → 脸修。 */
export function makeRsGraph(args: MultiDraw): Graph {
  validateMulti(args);
  const g = structuredClone(RS_TEMPLATE);
  for (let i = 0; i < 2; i++) {
    const part = args.parts[i];
    g["4"].inputs[`character${i + 1}`] = [multiRoleTags(part), part.text, args.pbypass].filter(Boolean).join(", ");
    g["4"].inputs[`character${i + 1}_lora`] = part.role?.file ?? "None";
    g["4"].inputs[`character${i + 1}_lora_strength`] = part.role?.weight ?? 1;
    g["4"].inputs[`character${i + 1}_lora_clip_strength`] = part.role?.weight ?? 1;
  }
  const seed = args.seed ?? randomBytes(4).readUInt32BE();
  const postSeed = randomBytes(4).readUInt32BE();
  const commonPrompt = /^2girls(?:\s|,)/i.test(args.prompt) ? args.prompt : `2girls, ${args.prompt}`;
  Object.assign(g["5"].inputs, { prompt: [commonPrompt, args.bypass].filter(Boolean).join(", "), negative_prompt: String(TEMPLATE["5"].inputs.text), width: args.width, height: args.height, seed });
  g["32"].inputs.text = String(TEMPLATE["5"].inputs.text);
  g["40"].inputs.text = multiSceneText(args);
  g["61"].inputs.image = ["5", 0];
  g["64"].inputs.seed = postSeed;
  g["101"].inputs.seed = postSeed;
  return g;
}

export class ComfyExecutionFailed extends Error {}
export class ComfyBusy extends Error {}
let busy = false;

/** draw 阶段进度（不过模型）：sketch/refine=单管线；multi-*=双人 RS 管线两段。 */
export type DrawStage = "sketch" | "refine" | "multi-first" | "multi-second";

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

/** 多角色阶段追踪：区域采样完成后进入超分，再进入脸修。 */
function makeMultiStageTracker(promptId: string, onStage: (stage: DrawStage) => void): (message: unknown) => void {
  let stage = 0;
  return (message) => {
    if (typeof message !== "string") return;
    try {
      const event = JSON.parse(message) as { type?: string; data?: { node?: string | null; prompt_id?: string } };
      if (event.type !== "executing" || event.data?.prompt_id !== promptId) return;
      const node = event.data?.node;
      if (typeof node !== "string") return;
      if (stage < 1 && node === "61") { stage = 1; onStage("multi-first"); }
      else if (stage < 2 && node === "101") { stage = 2; onStage("multi-second"); }
    } catch { /* ignore */ }
  };
}

function openMultiStageSocket(base: string, clientId: string, promptId: string, onStage: (stage: DrawStage) => void): { close: () => void } {
  try {
    const ws = new WebSocket(`${base.replace("http", "ws")}/ws?clientId=${clientId}`);
    ws.binaryType = "arraybuffer";
    const onMessage = makeMultiStageTracker(promptId, onStage);
    ws.addEventListener("message", (event) => onMessage((event as MessageEvent).data));
    ws.addEventListener("error", () => {});
    return { close: () => { try { ws.close(); } catch { /* already closed */ } } };
  } catch { return { close: () => {} }; }
}

export async function runMulti(url: string, args: MultiDraw, onSubmitted: () => void, onStage?: (stage: DrawStage) => void): Promise<Buffer> {
  if (busy) throw new ComfyBusy("ComfyUI busy");
  busy = true;
  try { return await runMultiJob(url, args, onSubmitted, onStage); }
  finally { busy = false; }
}

type ComfyHistoryJob = { status?: { status_str?: string; completed?: boolean }; outputs?: Record<string, { images?: Array<{ filename?: string; subfolder?: string; type?: string }> }> };

/** 提交一个 graph 并轮询到成功（失败/超时抛错）。 */
async function submitAndWait(base: string, graph: Graph, promptId: string, clientId: string, deadline: number): Promise<ComfyHistoryJob> {
  const response = await fetch(`${base}/prompt`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ prompt: graph, prompt_id: promptId, client_id: clientId }), redirect: "error", signal: AbortSignal.timeout(15_000) });
  if (response.status >= 400 && response.status < 500) throw new ComfyExecutionFailed(`ComfyUI rejected request (HTTP ${response.status})`);
  if (!response.ok) throw new Error(`ComfyUI HTTP ${response.status}`);
  const submitted = await response.json() as { prompt_id?: string };
  if (submitted.prompt_id !== promptId) throw new Error("unexpected ComfyUI prompt id");
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

async function runMultiJob(url: string, args: MultiDraw, onSubmitted: () => void, onStage?: (stage: DrawStage) => void): Promise<Buffer> {
  const base = comfyUrl(url);
  const queue = await (await request(`${base}/queue`)).json() as { queue_running?: unknown[]; queue_pending?: unknown[] };
  if (!Array.isArray(queue.queue_running) || !Array.isArray(queue.queue_pending)) throw new Error("invalid ComfyUI queue");
  if (queue.queue_running.length || queue.queue_pending.length) throw new ComfyBusy("ComfyUI busy");
  const id = randomUUID();
  const clientId = randomUUID();
  const graph = makeRsGraph(args);
  const socket = onStage ? openMultiStageSocket(base, clientId, id, onStage) : undefined;
  try {
    onSubmitted();
    const job = await submitAndWait(base, graph, id, clientId, Date.now() + 560_000);
    return await fetchOutputImage(base, job, "66");
  } finally { socket?.close(); }
}
