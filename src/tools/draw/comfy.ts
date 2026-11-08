import { createHash, randomBytes, randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";

type Node = { class_type: string; inputs: Record<string, unknown> };
type Graph = Record<string, Node>;

const WORKFLOW_HASH = "1b59f0b20d2ddc7652ded03ae998eea84120978bcde6f272276e17d034637cda";
const GRAPH_BYTES = readFileSync(new URL("./workflow.json", import.meta.url));
if (createHash("sha256").update(GRAPH_BYTES).digest("hex") !== WORKFLOW_HASH) throw new Error("draw workflow hash mismatch");
const TEMPLATE = JSON.parse(GRAPH_BYTES.toString("utf8")) as Graph;
if (TEMPLATE["1"]?.inputs.unet_name !== "DeltaMix 3.8B V8.safetensors" || TEMPLATE["9"]?.class_type !== "PreviewImage") throw new Error("draw workflow contract mismatch");

export interface ComfyDraw {
  prompt: string;
  bypass?: string;
  preset?: "default" | "hsr" | "secret";
  highres?: boolean;
  width?: number;
  height?: number;
  cfg?: number;
  seed?: number;
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
  graph["6"].inputs.width = args.width ?? 768;
  graph["6"].inputs.height = args.height ?? 1024;
  graph["4"].inputs.text = String(graph["4"].inputs.text) + args.prompt + (args.preset === "secret" ? ", completely nude" : "") + (args.bypass ? `, ${args.bypass}` : "");
  if (args.preset === "hsr") {
    graph["88"] = { class_type: "AnimaLoRARemapTagLoader", inputs: { model: ["1", 0], clip: ["2", 0], text: "<lora:HSR Anima:0.7>", default_weight: 1, weight_multiplier: 1, auto_remap: true, save_remapped: false, extend_to_new_layers: false, extend_strength: 0.5, manifest: "Auto (Recommended)" } };
    for (const id of ["7", "11", "14", "42"]) graph[id].inputs.model = ["88", 0];
    for (const id of ["4", "5", "11", "42"]) graph[id].inputs.clip = ["88", 1];
  }
  if (args.ref) {
    if (!inputName || !/^yugang-ref-[a-f0-9-]{36}\.png$/.test(inputName)) throw new Error("invalid draw input name");
    graph["19"] = { class_type: "LoadImage", inputs: { image: inputName } };
    graph["20"] = { class_type: "VAEEncode", inputs: { pixels: ["19", 0], vae: ["3", 0] } };
    graph["7"].inputs.latent_image = ["20", 0];
    graph["7"].inputs.denoise = args.ref.strength;
    delete graph["6"];
  }
  graph["90"] = { class_type: "UpscaleModelLoader", inputs: { model_name: "RealESRGAN_x4plus_anime_6B.pth" } };
  graph["91"] = { class_type: "ImageUpscaleWithModel", inputs: { upscale_model: ["90", 0], image: ["42", 0] } };
  graph["92"] = { class_type: "ImageScaleBy", inputs: { image: ["91", 0], upscale_method: "lanczos", scale_by: 0.5 } };
  graph["44"].inputs.pixels = ["92", 0];
  graph["13"].inputs.scale_by = 1;
  return graph;
}

const MAX_IMAGE = 25 * 1024 * 1024;
const PNG = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);
const pause = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));
export class ComfyExecutionFailed extends Error {}
export class ComfyBusy extends Error {}
let busy = false;

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
export async function runComfy(url: string, args: ComfyDraw, onSubmitted: () => void): Promise<Buffer> {
  if (busy) throw new ComfyBusy("ComfyUI busy");
  busy = true;
  try { return await runComfyJob(url, args, onSubmitted); }
  finally { busy = false; }
}

async function runComfyJob(url: string, args: ComfyDraw, onSubmitted: () => void): Promise<Buffer> {
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
  onSubmitted();
  const response = await fetch(`${base}/prompt`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ prompt: graph, prompt_id: id, client_id: randomUUID() }), redirect: "error", signal: AbortSignal.timeout(15_000) });
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
}
