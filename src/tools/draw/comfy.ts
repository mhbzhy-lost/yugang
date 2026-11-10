import { createHash, randomBytes, randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";

type Node = { class_type: string; inputs: Record<string, unknown> };
type Graph = Record<string, Node>;

const WORKFLOW_HASH = "b2ea5b8e1f46903f0295a2ce355705c15ed263c21c1bf338dc7fd29c058a9e60";
const GRAPH_BYTES = readFileSync(new URL("./workflow.json", import.meta.url));
if (createHash("sha256").update(GRAPH_BYTES).digest("hex") !== WORKFLOW_HASH) throw new Error("draw workflow hash mismatch");
const TEMPLATE = JSON.parse(GRAPH_BYTES.toString("utf8")) as Graph;
if (TEMPLATE["1"]?.inputs.unet_name !== "DeltaMix 3.8B V8.safetensors" || TEMPLATE["9"]?.class_type !== "PreviewImage") throw new Error("draw workflow contract mismatch");


/**
 * ComfyUI 的 CLIPTextEncode 把半角括号当权重语法（`(xxx)` = 1.1）；
 * 词表里的 danbooru tag 本身带括号（`elysia (honkai impact)`），注入前必须转义成 `\( \)`，
 * 否则角色名会被拆成「带权重的短语」而不是字面 tag。只转义我们注入的部分，用户 prompt 不动。
 */
function escapeInjected(text: string): string {
  // 幂等：已经转义过的括号不再加反斜杠（normalizeTagForm 会先转义 danbooru tag 的括号）。
  return text.replace(/(?<!\\)([()])/g, "\\$1");
}

/**
 * 只把 danbooru 形状 `xxx_(yyy_zzz)` 改成 prompt 形状 `xxx \(yyy zzz\)`：
 * 下划线转空格 + 括号转义。触发词里的下划线（Ely_One / Edn_1 / score_7）保持原样，
 * 刻意加权的 `(tag:1.2)` 也不动。
 */
function normalizeTagForm(text: string): string {
  return text.replace(/([A-Za-z0-9]+)_\(([^()]*)\)/g, (_match, head: string, inner: string) => {
    return `${head} \\(${inner.replace(/_/g, " ")}\\)`;
  });
}

export interface ComfyDraw {
  /** 高清模式：净 3 倍出图；采样与脸修恒在 2 倍域内，第三倍在脸修后纯放大补齐。 */
  hd?: boolean;
  prompt: string;
  bypass?: string;
  /** 人物级 bypass（pbypass: 段）：单角色无分区概念，追加在 bypass 之后（同一正向末尾）。 */
  bypassP?: string;
  /** 风格 LoRA：全局作用于 model/clip，不改 prompt。 */
  style?: { file: string; weight: number };
  width?: number;
  height?: number;
  cfg?: number;
  seed?: number;
  handRepair?: boolean;
  /** 角色 LoRA：file/inject 来自角色词表，这里只做形态校验与机械拼接。 */
  lora?: { file: string; weight: number; inject: string };
  /** 双人直出：恰好两位，构图由模型决定；角色 LoRA 走 93/94 链。与 lora 互斥。 */
  parts?: MultiPart[];
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
  for (const id of ["7", "11", "42"]) graph[id].inputs.seed = seed;
  graph["7"].inputs.cfg = args.cfg ?? 4.5;
  graph["6"].inputs.width = args.width ?? 912;
  graph["6"].inputs.height = args.height ?? 1216;
  const prefix = String(graph["4"].inputs.text);
  const suffix = (args.bypass ? `, ${args.bypass}` : "") + (args.bypassP ? `, ${args.bypassP}` : "");
  if (args.parts !== undefined) {
    validateParts(args.parts);
    if (args.lora) throw new Error("invalid draw parts with lora");
    const segments = args.parts.flatMap((part) => [part.role ? escapeInjected(normalizeTagForm(multiRoleTags(part))) : "", normalizeTagForm(part.text)].filter((s) => s));
    graph["4"].inputs.text = `${prefix}2girls, ${segments.join(", ")}, ${normalizeTagForm(args.prompt)}${suffix}`;
  } else {
    graph["4"].inputs.text = prefix + (args.lora ? `${escapeInjected(normalizeTagForm(args.lora.inject))}, ` : "") + normalizeTagForm(args.prompt) + suffix;
  }
  if (args.style) {
    // 风格 LoRA：全局画风，挂在底模之后、角色 LoRA 之前（节点 88）。
    if (!/^[\w .@()-]+\.safetensors$/.test(args.style.file) || !Number.isFinite(args.style.weight) || args.style.weight < 0.4 || args.style.weight > 1.1) throw new Error("invalid draw style");
    graph["88"] = { class_type: "AnimaLoRARemapTagLoader", inputs: { model: ["1", 0], clip: ["2", 0], text: `<lora:${args.style.file}:${args.style.weight}>`, default_weight: 1, weight_multiplier: 1, auto_remap: true, save_remapped: false, extend_to_new_layers: false, extend_strength: 0.5, manifest: "Auto (Recommended)" } };
    for (const id of ["7", "11", "42"]) graph[id].inputs.model = ["88", 0];
    for (const id of ["4", "5", "11", "42"]) graph[id].inputs.clip = ["88", 1];
  }
  if (args.lora) {
    // 角色 LoRA 链在风格之后（有风格时接 88），消费方统一改接 93。
    if (!/^[\w .@()-]+\.safetensors$/.test(args.lora.file) || !Number.isFinite(args.lora.weight) || args.lora.weight < 0.4 || args.lora.weight > 1.1) throw new Error("invalid draw lora");
    const upstream = args.style ? { model: ["88", 0], clip: ["88", 1] } : { model: ["1", 0], clip: ["2", 0] };
    graph["93"] = { class_type: "AnimaLoRARemapTagLoader", inputs: { model: upstream.model, clip: upstream.clip, text: `<lora:${args.lora.file}:${args.lora.weight}>`, default_weight: 1, weight_multiplier: 1, auto_remap: true, save_remapped: false, extend_to_new_layers: false, extend_strength: 0.5, manifest: "Auto (Recommended)" } };
    for (const id of ["7", "11", "42"]) graph[id].inputs.model = ["93", 0];
    for (const id of ["4", "5", "11", "42"]) graph[id].inputs.clip = ["93", 1];
  }
  if (args.parts !== undefined) {
    // 双人直出：角色 LoRA 链 93→94（风格之后），消费方统一改接链尾。
    let up: { model: [string, number]; clip: [string, number] } = args.style ? { model: ["88", 0], clip: ["88", 1] } : { model: ["1", 0], clip: ["2", 0] };
    let last = "";
    args.parts.forEach((part, i) => {
      if (!part.role) return;
      const id = String(93 + i);
      graph[id] = { class_type: "AnimaLoRARemapTagLoader", inputs: { model: up.model, clip: up.clip, text: `<lora:${part.role.file}:${part.role.weight}>`, default_weight: 1, weight_multiplier: 1, auto_remap: true, save_remapped: false, extend_to_new_layers: false, extend_strength: 0.5, manifest: "Auto (Recommended)" } };
      up = { model: [id, 0], clip: [id, 1] };
      last = id;
    });
    if (last) {
      for (const id of ["7", "11", "42"]) graph[id].inputs.model = [last, 0];
      for (const id of ["4", "5", "11", "42"]) graph[id].inputs.clip = [last, 1];
    }
    // 脸修 positive 改场景-only：crop 后位置词失效，全文会把另一人的特征画到这张脸上。
    graph["41"] = { class_type: "CLIPTextEncode", inputs: { clip: up.clip, text: `${prefix}2girls, ${normalizeTagForm(args.prompt)}${suffix}` } };
    graph["11"].inputs.positive = ["41", 0];
  }
  if (args.ref) {
    if (!inputName || !/^yugang-ref-[a-f0-9-]{36}\.png$/.test(inputName)) throw new Error("invalid draw input name");
    graph["19"] = { class_type: "LoadImage", inputs: { image: inputName } };
    graph["20"] = { class_type: "VAEEncode", inputs: { pixels: ["19", 0], vae: ["3", 0] } };
    graph["7"].inputs.latent_image = ["20", 0];
    graph["7"].inputs.denoise = args.ref.strength;
    delete graph["6"];
  }
  // 超分链在模板里（90/91/92）：初采样解码 → AnimeSharp 4x → lanczos 0.5 = 净 2 倍；手修开启时超分输入改接 42。
  if (args.handRepair === true) graph["91"].inputs.image = ["42", 0];
  // 没有二次采样（2026-11-10 实测后删除）：全图低强度重采样在动漫域超分之后只销毁高频
  // （单人 2x ×0.78、双人 2x ×0.69、脸部 ×0.62–0.77），旁路对照里看不到任何修复收益；
  // 双人侧它的全局注意力还会抹平 RS 点位隔离。超分后直接进脸修。
  if (args.hd === true) {
    graph["95"] = { class_type: "UpscaleModelLoader", inputs: { model_name: "4x-AnimeSharp.safetensors" } };
    graph["96"] = { class_type: "ImageUpscaleWithModel", inputs: { upscale_model: ["95", 0], image: ["11", 0] } };
    graph["97"] = { class_type: "ImageScaleBy", inputs: { image: ["96", 0], upscale_method: "lanczos", scale_by: 0.375 } };
    graph["9"].inputs.images = ["97", 0];
  }
  return graph;
}

/** 双人直出的一位：此人的描述 + 可选角色 LoRA（身份锚）。 */
export interface MultiPart {
  text: string;
  role?: { file: string; weight: number; inject: string };
}

const MAX_IMAGE = 25 * 1024 * 1024;
const PNG = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);
const pause = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

function validateParts(parts: MultiPart[]): void {
  if (parts.length !== 2) throw new Error("invalid multi parts count");
  for (const p of parts) {
    if (!p.text || p.text.length > 800) throw new Error("invalid multi part text");
    if (p.role !== undefined && (!/^[\w .@()-]+\.safetensors$/.test(p.role.file) || !Number.isFinite(p.role.weight) || p.role.weight < 0.4 || p.role.weight > 1.1)) throw new Error("invalid multi role");
  }
}

function multiRoleTags(part: MultiPart): string {
  return (part.role?.inject ?? "").split(",").map((tag) => tag.trim()).filter((tag) => tag && !/^(?:1girl|solo)$/i.test(tag)).join(", ");
}

export class ComfyExecutionFailed extends Error {}
export class ComfyBusy extends Error {}
let busy = false;

/** draw 阶段进度（不过模型）：sketch=初采样，refine=脸修。 */
export type DrawStage = "sketch" | "refine";

/** 阶段状态机：实测事件序列（2026-11-10）——"7"初采样 → "42"手修（hand_repair=true 时；否则"43"直接"91"超分）
 *  → "91"/"92"超分 → "11"脸修 → "9"输出。
 *  进入初采样后首批节点（sketch）与脸修（refine）时各汇报一次；乱序/未知节点忽略。 */
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
      } else if (stage < 2 && node === "11") {
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

