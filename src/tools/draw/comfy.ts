import { randomBytes, randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";

type Node = { class_type: string; inputs: Record<string, unknown> };
type Graph = Record<string, Node>;
type Link = [string, number];

// 三条管线各持一个静态 JSON 模板；本文件只做「参数注入 + 统一执行」。
// 结构契约：代码要 rewiring 的角色节点必须在场且 class 正确，缺任何一个启动即炸。
const TEMPLATE = JSON.parse(readFileSync(new URL("./workflow.json", import.meta.url)).toString("utf8")) as Graph;
const TEMPLATE_CONTRACT: Array<[string, string]> = [
  ["1", "UNETLoader"], ["4", "CLIPTextEncode"], ["5", "CLIPTextEncode"], ["6", "EmptySD3LatentImage"],
  ["7", "KSampler"], ["9", "PreviewImage"],
  ["71", "CLIPTextEncode"], ["72", "KSampler"],
  ["91", "ImageUpscaleWithModel"], ["92", "ImageScaleBy"],
];
for (const [id, cls] of TEMPLATE_CONTRACT) {
  if (TEMPLATE[id]?.class_type !== cls) throw new Error(`draw workflow contract mismatch: node ${id} != ${cls}`);
}
if (TEMPLATE["1"]?.inputs.unet_name !== "DeltaMix 3.8B V8.safetensors") throw new Error("draw workflow contract mismatch: unet");

const INTERACTION_TEMPLATE = JSON.parse(readFileSync(new URL("./workflow-interaction.json", import.meta.url)).toString("utf8")) as Graph;
const INTERACTION_TEMPLATE_CONTRACT: Array<[string, string]> = [
  ["1", "RSMultiCharacterPrompt"], ["4", "RSMultiCharacterPose3D"], ["11", "RSMultiCharacterSampler"],
  ["22", "ImageUpscaleWithModel"], ["23", "ImageScaleBy"],
  ["35", "YugangStudyCameraProject"], ["70", "VAEEncode"], ["72", "KSampler"], ["73", "VAEDecode"], ["38", "SaveImage"],
];
for (const [id, cls] of INTERACTION_TEMPLATE_CONTRACT) {
  if (INTERACTION_TEMPLATE[id]?.class_type !== cls) throw new Error(`draw interaction workflow contract mismatch: node ${id} != ${cls}`);
}

const SINGLE_TEMPLATE = JSON.parse(readFileSync(new URL("./workflow-interaction-single.json", import.meta.url)).toString("utf8")) as Graph;
const SINGLE_TEMPLATE_CONTRACT: Array<[string, string]> = [
  ["1", "UNETLoader"], ["5", "RSMultiCharacterPose3D"], ["6", "ModelPatchLoader"], ["36", "AnimaLLLiteApply"],
  ["11", "KSampler"], ["27", "KSampler"], ["22", "ImageUpscaleWithModel"], ["23", "ImageScaleBy"], ["38", "SaveImage"],
];
for (const [id, cls] of SINGLE_TEMPLATE_CONTRACT) {
  if (SINGLE_TEMPLATE[id]?.class_type !== cls) throw new Error(`draw single workflow contract mismatch: node ${id} != ${cls}`);
}

/** CLIPTextEncode 把半角括号当权重语法；注入的 danbooru tag 括号必须转义，用户 prompt 不动。幂等。 */
function escapeInjected(text: string): string {
  return text.replace(/(?<!\\)([()])/g, "\\$1");
}
/** 只把 danbooru 形状 `xxx_(yyy_zzz)` 改成 `xxx \(yyy zzz\)`；触发词下划线与刻意加权不动。 */
function normalizeTagForm(text: string): string {
  return text.replace(/([A-Za-z0-9]+)_\(([^()]*)\)/g, (_m, head: string, inner: string) => `${head} \\(${inner.replace(/_/g, " ")}\\)`);
}

/** 角色/风格 LoRA 重映射节点（28→52 层）。file/weight 机械校验，缺文件由 requireGraphLoras 提交前拒绝。 */
function loraLoader(model: Link, clip: Link, file: string, weight: number): Node {
  if (!/^[\w .@()-]+\.safetensors$/.test(file) || !Number.isFinite(weight) || weight < 0.4 || weight > 1.1) throw new Error("invalid draw lora");
  return { class_type: "AnimaLoRARemapTagLoader", inputs: { model, clip, text: `<lora:${file}:${weight}>`, default_weight: 1, weight_multiplier: 1, auto_remap: true, save_remapped: false, extend_to_new_layers: false, extend_strength: 0.5, manifest: "Auto (Recommended)" } };
}

/** 高清只在 pass 解码后净放大 1.5 倍（4x × lanczos 0.375）；扩散始终留在 2 倍域。 */
function applyHd(g: Graph, hd: boolean | undefined, outNode: string): void {
  if (hd !== true) return;
  const image = g[outNode].inputs.images;
  g["95"] = { class_type: "UpscaleModelLoader", inputs: { model_name: "4x-AnimeSharp.safetensors" } };
  g["96"] = { class_type: "ImageUpscaleWithModel", inputs: { upscale_model: ["95", 0], image } };
  g["97"] = { class_type: "ImageScaleBy", inputs: { image: ["96", 0], upscale_method: "lanczos", scale_by: 0.375 } };
  g[outNode].inputs.images = ["97", 0];
}

export interface ComfyDraw {
  hd?: boolean;
  fast?: boolean;
  prompt: string;
  bypass?: string;
  bypassP?: string;
  style?: { file: string; weight: number };
  width?: number;
  height?: number;
  cfg?: number;
  seed?: number;
  lora?: { file: string; weight: number; inject: string };
  ref?: { png: Buffer; strength: number };
}

export function comfyUrl(value: string): string {
  const url = new URL(value);
  if (url.protocol !== "http:" || url.hostname !== "127.0.0.1" || url.username || url.password || url.pathname !== "/" || url.search || url.hash) throw new Error("invalid ComfyUI endpoint");
  return url.origin;
}

/** 直出/fast（无 LLLite）：workflow.json 模板 + 注入。 */
export function makeGraph(args: ComfyDraw, inputName?: string): Graph {
  const graph = structuredClone(TEMPLATE);
  graph["7"].inputs.seed = args.seed ?? randomBytes(4).readUInt32BE();
  graph["72"].inputs.seed = randomBytes(4).readUInt32BE();
  graph["7"].inputs.cfg = args.cfg ?? 4.5;
  graph["6"].inputs.width = args.width ?? 912;
  graph["6"].inputs.height = args.height ?? 1216;
  const suffix = (args.bypass ? `, ${args.bypass}` : "") + (args.bypassP ? `, ${args.bypassP}` : "");
  const inject = args.lora ? `${escapeInjected(normalizeTagForm(args.lora.inject))}, ` : "";
  graph["4"].inputs.text = String(graph["4"].inputs.text) + inject + normalizeTagForm(args.prompt) + suffix;
  graph["71"].inputs.text = String(graph["71"].inputs.text) + inject + normalizeTagForm(args.prompt) + suffix;
  if (args.style) {
    graph["88"] = loraLoader(["1", 0], ["2", 0], args.style.file, args.style.weight);
    for (const id of ["7", "72"]) graph[id].inputs.model = ["88", 0];
    for (const id of ["4", "5", "71"]) graph[id].inputs.clip = ["88", 1];
  }
  if (args.lora) {
    const up: { model: Link; clip: Link } = args.style ? { model: ["88", 0], clip: ["88", 1] } : { model: ["1", 0], clip: ["2", 0] };
    graph["93"] = loraLoader(up.model, up.clip, args.lora.file, args.lora.weight);
    for (const id of ["7", "72"]) graph[id].inputs.model = ["93", 0];
    for (const id of ["4", "5", "71"]) graph[id].inputs.clip = ["93", 1];
  }
  if (args.ref) {
    if (!inputName || !/^yugang-ref-[a-f0-9-]{36}\.png$/.test(inputName)) throw new Error("invalid draw input name");
    graph["19"] = { class_type: "LoadImage", inputs: { image: inputName } };
    graph["20"] = { class_type: "VAEEncode", inputs: { pixels: ["19", 0], vae: ["3", 0] } };
    graph["7"].inputs.latent_image = ["20", 0];
    graph["7"].inputs.denoise = args.ref.strength;
    delete graph["6"];
  }
  if (args.fast === true) {
    graph["92"].inputs.scale_by = 0.3;
    graph["7"].inputs.steps = 28;
    graph["72"].inputs.steps = 8;
  }
  applyHd(graph, args.hd, "9");
  return graph;
}

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
  return (part.role?.inject ?? "").split(",").map((t) => t.trim()).filter((t) => t && !/^(?:1girl|solo)$/i.test(t)).join(", ");
}
function partDesc(part: MultiPart, pbypass?: string): string {
  return [part.role ? escapeInjected(normalizeTagForm(multiRoleTags(part))) : "", normalizeTagForm(part.text), pbypass].filter(Boolean).join(", ");
}

export interface InteractionPreset {
  scene_json: string;
  scene_json_2x: string;
  camera_extension: string;
  box: Array<{ x: number; y: number; width: number; height: number }>;
}
export interface InteractionDraw {
  prompt: string;
  width: number;
  height: number;
  seed?: number;
  passSeed?: number;
  preset: InteractionPreset;
  parts: MultiPart[];
  label: string;
  hd?: boolean;
  bypass?: string;
  pbypass?: string;
  framing?: "normal" | "wide";
  spacing?: "together" | "apart";
}

// 姿态线初采样＝质量地板(含anime)+真实感细节词（无四轴/赛璐璐）；负向去 lips；pass 基础词。
const INTERACTION_NEGATIVE = String(INTERACTION_TEMPLATE["11"].inputs.negative_prompt);
const INTERACTION_STYLE = "detailed, intricate, film grain, depth of field, ";

/** 双人姿态：RS 区域 + Pose3D + LLLite + Camera → 超分 → 老版普通 pass@2x。 */
export function makeInteractionGraph(args: InteractionDraw): Graph {
  validateParts(args.parts);
  if (!Number.isInteger(args.width) || !Number.isInteger(args.height) || args.width % 8 !== 0 || args.height % 8 !== 0) throw new Error("invalid interaction canvas");
  const g = structuredClone(INTERACTION_TEMPLATE);
  const floorPos = String(INTERACTION_TEMPLATE["11"].inputs.prompt);
  const neg = INTERACTION_NEGATIVE;
  const seed = args.seed ?? randomBytes(4).readUInt32BE(0);
  const passSeed = args.passSeed ?? randomBytes(4).readUInt32BE(0);
  const commonPrompt = /^2girls(?:\s|,)/i.test(args.prompt) ? args.prompt : `2girls, ${args.prompt}`;
  const fullPrompt = floorPos + normalizeTagForm(commonPrompt) + (args.bypass ? `, ${args.bypass}` : "");
  const initialPrompt = floorPos + INTERACTION_STYLE + normalizeTagForm(commonPrompt) + (args.bypass ? `, ${args.bypass}` : "");
  for (let i = 0; i < 2; i++) {
    const part = args.parts[i];
    g["1"].inputs[`character${i + 1}`] = partDesc(part, args.pbypass);
    g["2"].inputs[`character${i + 1}_lora`] = part.role?.file ?? "None";
    g["2"].inputs[`character${i + 1}_lora_strength`] = part.role?.weight ?? 1;
    g["2"].inputs[`character${i + 1}_lora_clip_strength`] = part.role?.weight ?? 1;
    const b = args.preset.box[i];
    g["3"].inputs[`character${i + 1}_x`] = b.x;
    g["3"].inputs[`character${i + 1}_y`] = b.y;
    g["3"].inputs[`character${i + 1}_width`] = b.width;
    g["3"].inputs[`character${i + 1}_height`] = b.height;
  }
  g["4"].inputs.scene_json = args.preset.scene_json;
  Object.assign(g["11"].inputs, { prompt: initialPrompt, negative_prompt: neg, seed, width: args.width, height: args.height });
  g["12"].inputs.filename_prefix = `interaction/${args.label}/initial`;
  g["13"].inputs.label = `${args.label} initial`;
  g["35"].inputs.scene_json = args.preset.scene_json;
  g["35"].inputs.camera_extension = args.preset.camera_extension;
  g["38"].inputs.filename_prefix = `interaction/${args.label}/final`;
  g["5"].inputs.building_pipe = ["3", 0];
  g["13"].inputs.scene_info = ["35", 6];
  g["60"] = { class_type: "YugangPoseLayout", inputs: { character_pipe: ["7", 0], pose_image: ["35", 0], owner_a: ["35", 1], owner_b: ["35", 2], base_prompt: initialPrompt, framing: args.framing ?? "normal", spacing: args.spacing ?? "together", canvas_aspect: args.width / args.height } };
  g["75"] = { class_type: "AnimaLLLiteApply", inputs: { strength: 0.8, start_percent: 0., end_percent: 0.7, model: ["8", 0], model_patch: ["34", 0], image: ["60", 2] } };
  Object.assign(g["11"].inputs, { model: ["75", 0], character_pipe: ["60", 0], prompt: ["60", 1] });
  // 老版 pass：普通 KSampler + 角色 LoRA 串联，不挂 RS/LLLite。
  const passDesc = args.parts.map((p) => partDesc(p, args.pbypass)).join(", ");
  let passModel: Link = ["8", 0];
  let passClip: Link = ["9", 0];
  let chainId = 93;
  for (const p of args.parts) {
    if (!p.role) continue;
    g[String(chainId)] = loraLoader(passModel, passClip, p.role.file, p.role.weight);
    passModel = [String(chainId), 0];
    passClip = [String(chainId), 1];
    chainId++;
  }
  g["71"].inputs = { text: `${fullPrompt}, ${passDesc}`, clip: passClip };
  g["74"].inputs = { text: neg, clip: passClip };
  Object.assign(g["72"].inputs, { model: passModel, seed: passSeed });
  applyHd(g, args.hd, "38");
  return g;
}

/** 单人姿态：workflow-interaction-single.json 模板 + 注入（KSampler + LLLite，无 RS）。 */
export function makeInteractionSingleGraph(args: {
  prompt: string; width: number; height: number; seed?: number; passSeed?: number;
  preset: InteractionPreset; part: MultiPart; label: string; hd?: boolean;
  bypass?: string; pbypass?: string;
}): Graph {
  if (args.part.text.length > 800) throw new Error("invalid single part text");
  if (args.part.role !== undefined && (!/^[\w .@()-]+\.safetensors$/.test(args.part.role.file) || !Number.isFinite(args.part.role.weight) || args.part.role.weight < 0.4 || args.part.role.weight > 1.1)) throw new Error("invalid single role");
  if (!Number.isInteger(args.width) || !Number.isInteger(args.height) || args.width % 8 !== 0 || args.height % 8 !== 0) throw new Error("invalid single canvas");
  const g = structuredClone(SINGLE_TEMPLATE);
  const floorPos = String(INTERACTION_TEMPLATE["11"].inputs.prompt);
  const neg = INTERACTION_NEGATIVE;
  const seed = args.seed ?? randomBytes(4).readUInt32BE(0);
  const passSeed = args.passSeed ?? randomBytes(4).readUInt32BE(0);
  const commonPrompt = /^1girl(?:\s|,)/i.test(args.prompt) ? args.prompt : `1girl, solo, ${args.prompt}`;
  const desc = [args.part.role ? escapeInjected(normalizeTagForm(multiRoleTags(args.part))) : "", normalizeTagForm(args.part.text)].filter(Boolean).join(", ");
  const suffix = (args.bypass ? `, ${args.bypass}` : "") + (args.pbypass ? `, ${args.pbypass}` : "");
  const positive = `${floorPos}${INTERACTION_STYLE}${normalizeTagForm(commonPrompt)}, ${desc}${suffix}`;
  const passPositive = `${floorPos}${normalizeTagForm(commonPrompt)}, ${desc}${suffix}`;
  const hasRole = args.part.role !== undefined;
  if (hasRole) g["4"] = loraLoader(["1", 0], ["2", 0], args.part.role!.file, args.part.role!.weight);
  else delete g["4"];
  const modelOut: Link = hasRole ? ["4", 0] : ["1", 0];
  const clipOut: Link = hasRole ? ["4", 1] : ["2", 0];
  g["36"].inputs.model = modelOut;
  g["27"].inputs.model = modelOut;
  for (const id of ["7", "8", "25", "26"]) g[id].inputs.clip = clipOut;
  g["5"].inputs.scene_json = args.preset.scene_json;
  g["7"].inputs.text = positive;
  g["8"].inputs.text = neg;
  g["10"].inputs.width = args.width;
  g["10"].inputs.height = args.height;
  g["11"].inputs.seed = seed;
  g["27"].inputs.seed = passSeed;
  g["25"].inputs.text = passPositive;
  g["26"].inputs.text = neg;
  g["12"].inputs.filename_prefix = `interaction/${args.label}/initial`;
  g["38"].inputs.filename_prefix = `interaction/${args.label}/final`;
  applyHd(g, args.hd, "38");
  return g;
}

export class ComfyExecutionFailed extends Error {}
export class ComfyBusy extends Error {}
let busy = false;

export type DrawStage = "sketch";

function makeStageTracker(promptId: string, onStage: (s: DrawStage) => void): (m: unknown) => void {
  let stage = 0;
  return (message) => {
    if (typeof message !== "string") return;
    try {
      const event = JSON.parse(message) as { type?: string; data?: { node?: string | null; prompt_id?: string } };
      if (event.type !== "executing" || event.data?.prompt_id !== promptId) return;
      const node = event.data?.node;
      if (typeof node !== "string") return;
      if (stage < 1 && (node === "43" || node === "91")) { stage = 1; onStage("sketch"); }
    } catch { /* 非 JSON 帧忽略 */ }
  };
}
function openStageSocket(base: string, clientId: string, promptId: string, onStage: (s: DrawStage) => void): { close: () => void } {
  try {
    const ws = new WebSocket(`${base.replace("http", "ws")}/ws?clientId=${clientId}`);
    ws.binaryType = "arraybuffer";
    const onMessage = makeStageTracker(promptId, onStage);
    ws.addEventListener("message", (e) => onMessage((e as MessageEvent).data));
    ws.addEventListener("error", () => {});
    return { close: () => { try { ws.close(); } catch { /* closed */ } } };
  } catch { return { close: () => {} }; }
}

async function request(url: string, init: RequestInit = {}, timeout = 10_000): Promise<Response> {
  const res = await fetch(url, { ...init, redirect: "error", signal: AbortSignal.timeout(timeout) });
  if (!res.ok) throw new Error(`ComfyUI HTTP ${res.status}`);
  return res;
}

/** 提交前核对 LoRA 文件；重映射节点会把缺失降级成警告，宿主必须拒绝无 LoRA 出图。 */
/** ComfyUI 模型清单两种形状：旧 [[文件…], 配置] 与新 ["COMBO", {options: [文件…]}]（0.44+ 部分节点）。 */
function inventoryList(raw: unknown): string[] | undefined {
  if (!Array.isArray(raw) || raw.length === 0) return undefined;
  const [first, second] = raw;
  if (Array.isArray(first) && first.every((n) => typeof n === "string")) return first;
  if (first === "COMBO" && second !== null && typeof second === "object"
    && Array.isArray((second as { options?: unknown }).options)
    && (second as { options: unknown[] }).options.every((n) => typeof n === "string")) {
    return (second as { options: string[] }).options;
  }
  return undefined;
}

async function requireGraphLoras(base: string, graph: Graph): Promise<void> {
  const needed = new Set<string>();
  for (const node of Object.values(graph)) {
    if (node.class_type === "AnimaLoRARemapTagLoader") {
      for (const m of String(node.inputs.text).matchAll(/<lora:([^:>]+):[^>]+>/g)) needed.add(m[1]);
    } else if (node.class_type === "RSMultiCharacterLoRA" || node.class_type === "RSMultiCharacterPrompts") {
      for (const [k, v] of Object.entries(node.inputs)) if (/^character\d+_lora$/.test(k) && typeof v === "string" && v !== "None") needed.add(v);
    }
  }
  if (!needed.size) return;
  const info = await (await request(`${base}/object_info/LoraLoader`)).json() as Record<string, { input?: { required?: { lora_name?: unknown } } }>;
  const names = inventoryList(info.LoraLoader?.input?.required?.lora_name);
  if (!names) throw new Error("invalid ComfyUI LoRA inventory");
  const missing = [...needed].filter((n) => !names.includes(n));
  if (missing.length) throw new Error(`ComfyUI LoRA files missing: ${missing.join(", ")}`);
}

/** 提交前核对模型文件清单（底模/CLIP/VAE/超分/姿态 patch）。缺文件 ComfyUI 只回 400，提前以明确错误拒绝。 */
const MODEL_FILE_FIELDS: Record<string, string> = {
  UNETLoader: "unet_name",
  CLIPLoader: "clip_name",
  VAELoader: "vae_name",
  UpscaleModelLoader: "model_name",
  ModelPatchLoader: "name",
};
async function requireGraphModelFiles(base: string, graph: Graph): Promise<void> {
  const needed = new Map<string, Set<string>>();
  for (const node of Object.values(graph)) {
    const field = MODEL_FILE_FIELDS[node.class_type];
    const value = field !== undefined ? node.inputs[field] : undefined;
    if (typeof value === "string" && value !== "None") {
      const set = needed.get(node.class_type) ?? new Set<string>();
      set.add(value);
      needed.set(node.class_type, set);
    }
  }
  if (!needed.size) return;
  const missing: string[] = [];
  for (const [classType, files] of needed) {
    const info = await (await request(`${base}/object_info/${classType}`)).json() as Record<string, { input?: { required?: Record<string, unknown> } }>;
    const names = inventoryList(info[classType]?.input?.required?.[MODEL_FILE_FIELDS[classType]]);
    if (!names) throw new Error("invalid ComfyUI model inventory");
    for (const f of files) if (!names.includes(f)) missing.push(`${classType} ${f}`);
  }
  if (missing.length) throw new Error(`ComfyUI model files missing: ${missing.join(", ")}`);
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

type ComfyHistoryJob = { status?: { status_str?: string; completed?: boolean }; outputs?: Record<string, { images?: Array<{ filename?: string; subfolder?: string; type?: string }> }> };

/** 4xx 拒绝时提取 node_errors 摘要：缺文件/未知节点在提交制式下只剩 "HTTP 400"，排障必须看到细节。 */
function summarizeRejection(body: string): string {
  try {
    const parsed = JSON.parse(body) as {
      node_errors?: Record<string, { class_type?: string; errors?: Array<{ input_name?: string; message?: string; details?: string }> }>;
      error?: { type?: string; message?: string };
    };
    const parts: string[] = [];
    for (const [id, node] of Object.entries(parsed.node_errors ?? {})) {
      for (const e of node.errors ?? []) parts.push(`node ${id} ${node.class_type ?? ""}${e.input_name ? `.${e.input_name}` : ""}: ${e.details ?? e.message ?? ""}`.trim());
    }
    const head = parsed.error?.type ?? "";
    const detail = [head, ...parts].filter(Boolean).join("; ");
    return detail ? detail.slice(0, 300) : body.slice(0, 200);
  } catch { return body.slice(0, 200); }
}

async function submitAndWait(base: string, graph: Graph, promptId: string, clientId: string, deadline: number): Promise<ComfyHistoryJob> {
  const response = await fetch(`${base}/prompt`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ prompt: graph, prompt_id: promptId, client_id: clientId }), redirect: "error", signal: AbortSignal.timeout(15_000) });
  if (response.status >= 400 && response.status < 500) throw new ComfyExecutionFailed(`ComfyUI rejected request (HTTP ${response.status}) ${summarizeRejection(await response.text().catch(() => ""))}`.trim());
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

async function fetchImage(base: string, job: ComfyHistoryJob, node: string, type: "temp" | "output"): Promise<Buffer> {
  const images = job.outputs?.[node]?.images;
  if (!Array.isArray(images) || images.length !== 1) throw new Error("invalid ComfyUI output");
  const image = images[0];
  if (image.type !== type || !image.filename || !/^[A-Za-z0-9_.-]+\.png$/.test(image.filename)) throw new Error("invalid ComfyUI output path");
  if (type === "temp" && image.subfolder) throw new Error("invalid ComfyUI output path");
  const query = new URLSearchParams({ filename: image.filename, type, subfolder: type === "output" ? (image.subfolder ?? "") : "" });
  return imageBytes(await request(`${base}/view?${query}`, {}, type === "output" ? 60_000 : 30_000));
}

interface ExecOpts {
  deadline: number;
  outputNode: string;
  outputType: "temp" | "output";
  onSubmitted: () => void;
  onStage?: (s: DrawStage) => void;
}
/** 统一执行：queue 闸 + 模型清单核对（LoRA 与模型文件）+ 提交 + 轮询 + 取图。busy 由调用方持有。 */
async function execGraph(url: string, graph: Graph, opts: ExecOpts): Promise<Buffer> {
  const base = comfyUrl(url);
  const queue = await (await request(`${base}/queue`)).json() as { queue_running?: unknown[]; queue_pending?: unknown[] };
  if (!Array.isArray(queue.queue_running) || !Array.isArray(queue.queue_pending)) throw new Error("invalid ComfyUI queue");
  if (queue.queue_running.length || queue.queue_pending.length) throw new ComfyBusy("ComfyUI busy");
  await requireGraphLoras(base, graph);
  await requireGraphModelFiles(base, graph);
  const id = randomUUID();
  const clientId = randomUUID();
  const sock = opts.onStage ? openStageSocket(base, clientId, id, opts.onStage) : undefined;
  try {
    opts.onSubmitted();
    const job = await submitAndWait(base, graph, id, clientId, Date.now() + opts.deadline);
    return await fetchImage(base, job, opts.outputNode, opts.outputType);
  } finally { sock?.close(); }
}

export async function runComfy(url: string, args: ComfyDraw, onSubmitted: () => void, onStage?: (s: DrawStage) => void): Promise<Buffer> {
  if (busy) throw new ComfyBusy("ComfyUI busy");
  busy = true;
  try {
    let name: string | undefined;
    if (args.ref) {
      const base = comfyUrl(url);
      name = `yugang-ref-${randomUUID()}.png`;
      const form = new FormData();
      form.set("image", new Blob([new Uint8Array(args.ref.png)], { type: "image/png" }), name);
      form.set("type", "input");
      form.set("overwrite", "false");
      const upload = await (await request(`${base}/upload/image`, { method: "POST", body: form }, 30_000)).json() as { name?: string; subfolder?: string; type?: string };
      if (upload.name !== name || upload.subfolder || upload.type !== "input") throw new Error("unexpected ComfyUI upload path");
    }
    return await execGraph(url, makeGraph(args, name), { deadline: 240_000, outputNode: "9", outputType: "temp", onSubmitted, onStage });
  } finally { busy = false; }
}

export async function runInteraction(url: string, args: InteractionDraw, onSubmitted: () => void): Promise<Buffer> {
  if (busy) throw new ComfyBusy("ComfyUI busy");
  busy = true;
  try { return await execGraph(url, makeInteractionGraph(args), { deadline: 1_500_000, outputNode: "38", outputType: "output", onSubmitted }); }
  finally { busy = false; }
}

export async function runInteractionSingle(url: string, args: Parameters<typeof makeInteractionSingleGraph>[0], onSubmitted: () => void): Promise<Buffer> {
  if (busy) throw new ComfyBusy("ComfyUI busy");
  busy = true;
  try { return await execGraph(url, makeInteractionSingleGraph(args), { deadline: 1_500_000, outputNode: "38", outputType: "output", onSubmitted }); }
  finally { busy = false; }
}
