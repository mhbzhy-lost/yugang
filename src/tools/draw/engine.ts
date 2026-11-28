import { randomUUID } from "node:crypto";

export type Node = { class_type: string; inputs: Record<string, unknown> };
export type Graph = Record<string, Node>;
export type Link = [string, number];

export class ComfyExecutionFailed extends Error {}
export class ComfyBusy extends Error {}
let busy = false;

/** 统一单飞锁：draw 与 qwen_draw 共用，防止并发穿透 /queue 闸。 */
export async function runExclusive<T>(fn: () => Promise<T>): Promise<T> {
  if (busy) throw new ComfyBusy("ComfyUI busy");
  busy = true;
  try {
    return await fn();
  } finally {
    busy = false;
  }
}

export type DrawStage = "sketch";

const DEFAULT_STAGE_NODES: readonly string[] = ["43", "91"];

export const DEFAULT_MODEL_FILE_FIELDS: Readonly<Record<string, readonly string[]>> = {
  UNETLoader: ["unet_name"],
  CLIPLoader: ["clip_name"],
  DualCLIPLoader: ["clip_name1", "clip_name2"],
  VAELoader: ["vae_name"],
  CheckpointLoaderSimple: ["ckpt_name"],
  CheckpointLoader: ["ckpt_name"],
  ControlNetLoader: ["control_net_name"],
  CLIPVisionLoader: ["clip_name"],
  StyleModelLoader: ["style_model_name"],
  UpscaleModelLoader: ["model_name"],
  ModelPatchLoader: ["name"],
};

const MAX_IMAGE = 25 * 1024 * 1024;
const PNG = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);

/** 可取消的轮询间隔：取消时立刻 reject（清掉 timer 与监听），不再白等。 */
const pause = (ms: number, signal?: AbortSignal) => new Promise<void>((resolve, reject) => {
  if (signal?.aborted) { reject(signal.reason); return; }
  const onAbort = () => { clearTimeout(timer); reject(signal!.reason); };
  const timer = setTimeout(() => { signal?.removeEventListener("abort", onAbort); resolve(); }, ms);
  signal?.addEventListener("abort", onAbort, { once: true });
});

export function comfyUrl(value: string): string {
  const url = new URL(value);
  if (url.protocol !== "http:" || url.hostname !== "127.0.0.1" || url.username || url.password || url.pathname !== "/" || url.search || url.hash) {
    throw new Error("invalid ComfyUI endpoint");
  }
  return url.origin;
}

function makeStageTracker(promptId: string, stageNodes: ReadonlySet<string>, onStage: (s: DrawStage) => void): (m: unknown) => void {
  let stage = 0;
  return (message) => {
    if (typeof message !== "string") return;
    try {
      const event = JSON.parse(message) as { type?: string; data?: { node?: string | null; prompt_id?: string } };
      if (event.type !== "executing" || event.data?.prompt_id !== promptId) return;
      const node = event.data?.node;
      if (typeof node !== "string") return;
      if (stage < 1 && stageNodes.has(node)) { stage = 1; onStage("sketch"); }
    } catch { /* 非 JSON 帧忽略 */ }
  };
}

function openStageSocket(base: string, clientId: string, promptId: string, stageNodes: ReadonlySet<string>, onStage: (s: DrawStage) => void, signal?: AbortSignal): { close: () => void } {
  try {
    const ws = new WebSocket(`${base.replace("http", "ws")}/ws?clientId=${clientId}`);
    ws.binaryType = "arraybuffer";
    const onMessage = makeStageTracker(promptId, stageNodes, onStage);
    ws.addEventListener("message", (e) => onMessage((e as MessageEvent).data));
    ws.addEventListener("error", () => {});
    const shut = () => { try { ws.close(); } catch { /* closed */ } };
    // 取消时主动关 WS：进度监听不留在已取消的调用上
    if (signal) {
      if (signal.aborted) { shut(); return { close: () => {} }; }
      signal.addEventListener("abort", shut, { once: true });
      return { close: () => { signal.removeEventListener("abort", shut); shut(); } };
    }
    return { close: shut };
  } catch { return { close: () => {} }; }
}

async function request(url: string, init: RequestInit = {}, timeout = 10_000, signal?: AbortSignal): Promise<Response> {
  const deadline = AbortSignal.timeout(timeout);
  const res = await fetch(url, { ...init, redirect: "error", signal: signal ? AbortSignal.any([deadline, signal]) : deadline });
  if (!res.ok) throw new Error(`ComfyUI HTTP ${res.status}`);
  return res;
}

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

/** 提交前核对 LoRA 文件；重映射节点会把缺失降级成警告，宿主必须拒绝无 LoRA 出图。 */
async function requireGraphLoras(base: string, graph: Graph, signal?: AbortSignal): Promise<void> {
  const needed = new Set<string>();
  for (const node of Object.values(graph)) {
    if (node.class_type === "AnimaLoRARemapTagLoader") {
      for (const m of String(node.inputs.text).matchAll(/<lora:([^:>]+):[^>]+>/g)) needed.add(m[1]);
    } else if (node.class_type === "RSMultiCharacterLoRA" || node.class_type === "RSMultiCharacterPrompts") {
      for (const [k, v] of Object.entries(node.inputs)) {
        if (/^character\d+_lora$/.test(k) && typeof v === "string" && v !== "None") needed.add(v);
      }
    } else if (node.class_type === "LoraLoader" || node.class_type === "LoraLoaderModelOnly") {
      const v = node.inputs.lora_name;
      if (typeof v === "string" && v !== "None") needed.add(v);
    }
  }
  if (!needed.size) return;
  const info = await (await request(`${base}/object_info/LoraLoader`, {}, 10_000, signal)).json() as Record<string, { input?: { required?: { lora_name?: unknown } } }>;
  const names = inventoryList(info.LoraLoader?.input?.required?.lora_name);
  if (!names) throw new Error("invalid ComfyUI LoRA inventory");
  const missing = [...needed].filter((n) => !names.includes(n));
  if (missing.length) throw new Error(`ComfyUI LoRA files missing: ${missing.join(", ")}`);
}

/** 提交前逐字段核对模型文件清单（支持多字段节点与后端扩展表）。缺文件 ComfyUI 只回 400，提前以明确错误拒绝。 */
async function requireGraphModelFiles(
  base: string,
  graph: Graph,
  extraModelFileFields?: Readonly<Record<string, readonly string[]>>,
  signal?: AbortSignal,
): Promise<void> {
  const fieldMap = extraModelFileFields
    ? { ...DEFAULT_MODEL_FILE_FIELDS, ...extraModelFileFields }
    : DEFAULT_MODEL_FILE_FIELDS;
  const needed = new Map<string, Map<string, Set<string>>>();
  for (const node of Object.values(graph)) {
    const fields = fieldMap[node.class_type];
    if (!fields) continue;
    for (const field of fields) {
      const value = node.inputs[field];
      if (typeof value === "string" && value !== "None") {
        let byField = needed.get(node.class_type);
        if (!byField) {
          byField = new Map<string, Set<string>>();
          needed.set(node.class_type, byField);
        }
        let files = byField.get(field);
        if (!files) {
          files = new Set<string>();
          byField.set(field, files);
        }
        files.add(value);
      }
    }
  }
  if (!needed.size) return;
  const missing: string[] = [];
  for (const [classType, byField] of needed) {
    const info = await (await request(`${base}/object_info/${encodeURIComponent(classType)}`, {}, 10_000, signal)).json() as Record<string, { input?: { required?: Record<string, unknown> } }>;
    const nodeInfo = info && typeof info === "object" ? info[classType] : undefined;
    if (!nodeInfo) throw new Error(`ComfyUI node not registered: ${classType}`);
    for (const [field, files] of byField) {
      const names = inventoryList(nodeInfo.input?.required?.[field]);
      if (!names) throw new Error("invalid ComfyUI model inventory");
      for (const f of files) {
        if (!names.includes(f)) missing.push(`${classType} ${f}`);
      }
    }
  }
  if (missing.length) throw new Error(`ComfyUI model files missing: ${missing.join(", ")}`);
}

async function imageBytes(response: Response): Promise<Buffer> {
  const size = Number(response.headers.get("content-length") ?? 0);
  if (!response.headers.get("content-type")?.toLowerCase().startsWith("image/png") || size > MAX_IMAGE || !response.body) {
    throw new Error("invalid image response");
  }
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
  if (
    data.length < 24 ||
    !data.subarray(0, 8).equals(PNG) ||
    data.toString("ascii", 12, 16) !== "IHDR" ||
    !data.readUInt32BE(16) ||
    !data.readUInt32BE(20) ||
    data.readUInt32BE(16) > 4096 ||
    data.readUInt32BE(20) > 4096
  ) {
    throw new Error("invalid PNG output");
  }
  return data;
}

type ComfyHistoryJob = {
  status?: { status_str?: string; completed?: boolean };
  outputs?: Record<string, { images?: Array<{ filename?: string; subfolder?: string; type?: string }> }>;
};

/** 4xx 拒绝时提取 node_errors 摘要：缺文件/未知节点在提交制式下只剩 "HTTP 400"，排障必须看到细节。 */
function summarizeRejection(body: string): string {
  try {
    const parsed = JSON.parse(body) as {
      node_errors?: Record<string, { class_type?: string; errors?: Array<{ input_name?: string; message?: string; details?: string }> }>;
      error?: { type?: string; message?: string };
    };
    const parts: string[] = [];
    for (const [id, node] of Object.entries(parsed.node_errors ?? {})) {
      for (const e of node.errors ?? []) {
        parts.push(`node ${id} ${node.class_type ?? ""}${e.input_name ? `.${e.input_name}` : ""}: ${e.details ?? e.message ?? ""}`.trim());
      }
    }
    const head = parsed.error?.type ?? "";
    const detail = [head, ...parts].filter(Boolean).join("; ");
    return detail ? detail.slice(0, 300) : body.slice(0, 200);
  } catch { return body.slice(0, 200); }
}

function queueContainsPrompt(queue: { queue_running?: unknown[]; queue_pending?: unknown[] }, promptId: string): boolean {
  for (const list of [queue.queue_running, queue.queue_pending]) {
    if (!Array.isArray(list)) continue;
    for (const item of list) {
      if (item === promptId) return true;
      if (Array.isArray(item) && item[1] === promptId) return true;
      if (item && typeof item === "object" && (item as { prompt_id?: unknown }).prompt_id === promptId) return true;
    }
  }
  return false;
}

async function submitAndWait(
  base: string,
  graph: Graph,
  promptId: string,
  clientId: string,
  deadline: number,
  signal?: AbortSignal,
  pollIntervalMs = 1500,
): Promise<ComfyHistoryJob> {
  // POST 只发一次：已被接受的作业不重投；提交后取消只停本地等待，
  // 服务端作业照跑（submitted 保持 true，本轮 draw_uncertain 不可重试）。
  const submitTimeout = AbortSignal.timeout(15_000);
  const response = await fetch(`${base}/prompt`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ prompt: graph, prompt_id: promptId, client_id: clientId }),
    redirect: "error",
    signal: signal ? AbortSignal.any([submitTimeout, signal]) : submitTimeout,
  });
  if (response.status >= 400 && response.status < 500) {
    throw new ComfyExecutionFailed(`ComfyUI rejected request (HTTP ${response.status}) ${summarizeRejection(await response.text().catch(() => ""))}`.trim());
  }
  if (!response.ok) throw new Error(`ComfyUI HTTP ${response.status}`);
  const submitted = await response.json() as { prompt_id?: string };
  if (submitted.prompt_id !== promptId) throw new Error("unexpected ComfyUI prompt id");
  let emptyPolls = 0;
  let misses = 0;
  while (Date.now() < deadline) {
    signal?.throwIfAborted();
    const history = await (await request(`${base}/history/${promptId}`, {}, 10_000, signal)).json() as Record<string, ComfyHistoryJob>;
    const job = history[promptId];
    if (job) {
      if (job.status?.status_str !== "success" || job.status.completed !== true) throw new ComfyExecutionFailed("ComfyUI execution failed");
      return job;
    }
    emptyPolls++;
    if (emptyPolls % 3 === 0) {
      const queue = await (await request(`${base}/queue`, {}, 10_000, signal)).json() as { queue_running?: unknown[]; queue_pending?: unknown[] };
      if (!Array.isArray(queue.queue_running) || !Array.isArray(queue.queue_pending)) {
        throw new Error("invalid ComfyUI queue");
      }
      if (queueContainsPrompt(queue, promptId)) {
        misses = 0;
      } else {
        // 先查 /queue 后立刻复查一次 /history，防作业在两次请求间隙完成出队
        const recheck = await (await request(`${base}/history/${promptId}`, {}, 10_000, signal)).json() as Record<string, ComfyHistoryJob>;
        const recheckedJob = recheck[promptId];
        if (recheckedJob) {
          if (recheckedJob.status?.status_str !== "success" || recheckedJob.status.completed !== true) throw new ComfyExecutionFailed("ComfyUI execution failed");
          return recheckedJob;
        }
        misses++;
        if (misses >= 3) throw new ComfyExecutionFailed("ComfyUI job vanished from queue");
      }
    }
    await pause(pollIntervalMs, signal);
  }
  throw new Error("ComfyUI history timeout");
}

async function fetchImage(base: string, job: ComfyHistoryJob, node: string, type: "temp" | "output", signal?: AbortSignal): Promise<Buffer> {
  const images = job.outputs?.[node]?.images;
  if (!Array.isArray(images) || images.length !== 1) throw new Error("invalid ComfyUI output");
  const image = images[0];
  if (image.type !== type || !image.filename || !/^[A-Za-z0-9_.-]+\.png$/.test(image.filename)) throw new Error("invalid ComfyUI output path");
  if (type === "temp" && image.subfolder) throw new Error("invalid ComfyUI output path");
  const query = new URLSearchParams({ filename: image.filename, type, subfolder: type === "output" ? (image.subfolder ?? "") : "" });
  return imageBytes(await request(`${base}/view?${query}`, {}, type === "output" ? 60_000 : 30_000, signal));
}

export interface ExecOpts {
  deadline: number;
  outputNode: string;
  outputType: "temp" | "output";
  onSubmitted: () => void;
  onStage?: (s: DrawStage) => void;
  /** 可选：触发 onStage("sketch") 的节点 ID；省略时兼容默认 ["43", "91"]，空数组不触发。 */
  stageNodes?: readonly string[];
  /** 可选：额外自定义加载节点的模型清单映射，与 DEFAULT_MODEL_FILE_FIELDS 合并。 */
  extraModelFileFields?: Readonly<Record<string, readonly string[]>>;
  /** 工具超时/宿主取消的合并信号；提交前取消 = 未提交（可重试），提交后取消 = 状态不明（不重 POST）。 */
  signal?: AbortSignal;
  /** 可选：history 轮询间隔（默认 1500ms；测试可调小）。 */
  pollIntervalMs?: number;
}

/** 统一执行：queue 闸 + 模型清单核对（LoRA 与模型文件）+ 提交 + 轮询 + 取图。busy 由调用方通过 runExclusive 持有。 */
export async function execGraph(url: string, graph: Graph, opts: ExecOpts): Promise<Buffer> {
  const base = comfyUrl(url);
  const queue = await (await request(`${base}/queue`, {}, 10_000, opts.signal)).json() as { queue_running?: unknown[]; queue_pending?: unknown[] };
  if (!Array.isArray(queue.queue_running) || !Array.isArray(queue.queue_pending)) throw new Error("invalid ComfyUI queue");
  if (queue.queue_running.length || queue.queue_pending.length) throw new ComfyBusy("ComfyUI busy");
  await requireGraphLoras(base, graph, opts.signal);
  await requireGraphModelFiles(base, graph, opts.extraModelFileFields, opts.signal);
  const id = randomUUID();
  const clientId = randomUUID();
  const stageNodes = opts.stageNodes ?? DEFAULT_STAGE_NODES;
  const sock = opts.onStage && stageNodes.length > 0
    ? openStageSocket(base, clientId, id, new Set(stageNodes), opts.onStage, opts.signal)
    : undefined;
  try {
    // 提交前最后一道取消闸：已取消就不 POST（onSubmitted 不执行，submitted 保持 false 可重试）
    opts.signal?.throwIfAborted();
    opts.onSubmitted();
    const job = await submitAndWait(base, graph, id, clientId, Date.now() + opts.deadline, opts.signal, opts.pollIntervalMs);
    return await fetchImage(base, job, opts.outputNode, opts.outputType, opts.signal);
  } finally { sock?.close(); }
}

/** 把参考图字节上传到 ComfyUI input（yugang-ref-<uuid> 专用名，供 LoadImage 消费；清理交给计划任务）。
 *  ext 只认 ComfyUI LoadImage 原生支持的 png/jpg/jpeg/webp，由调用方保证。 */
export async function uploadRefImage(url: string, data: Buffer, ext: "png" | "jpg" | "jpeg" | "webp", signal?: AbortSignal): Promise<string> {
  const base = comfyUrl(url);
  const mime = ext === "png" ? "image/png" : ext === "webp" ? "image/webp" : "image/jpeg";
  const name = `yugang-ref-${randomUUID()}.${ext}`;
  const form = new FormData();
  form.set("image", new Blob([new Uint8Array(data)], { type: mime }), name);
  form.set("type", "input");
  form.set("overwrite", "false");
  const upload = await (await request(`${base}/upload/image`, { method: "POST", body: form }, 30_000, signal)).json() as { name?: string; subfolder?: string; type?: string };
  if (upload.name !== name || upload.subfolder || upload.type !== "input") throw new Error("unexpected ComfyUI upload path");
  return name;
}
