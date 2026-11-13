import { randomBytes, randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";

type Node = { class_type: string; inputs: Record<string, unknown> };
type Graph = Record<string, Node>;

const TEMPLATE = JSON.parse(readFileSync(new URL("./workflow.json", import.meta.url)).toString("utf8")) as Graph;
// 结构契约（2026-11-10 起不钉死 hash，主人裁定：改模板不再同步常量）：代码要 rewiring 的角色节点
// 必须在场且 class 正确，缺任何一个启动即炸，绝不带病出图。模板迭代 = 改本文件 + commit + deploy。
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

// ── RS 区域管线模板（2026-11-11 起双人唯一管线：characters 两项一律走 RS，无 layout 路由）──
const RS_TEMPLATE = JSON.parse(readFileSync(new URL("./workflow-rs.json", import.meta.url)).toString("utf8")) as Graph;
const RS_TEMPLATE_CONTRACT: Array<[string, string]> = [
  ["1", "UNETLoader"], ["4", "RSMultiCharacterPrompts"], ["5", "RSMultiCharacterSampler"],
  ["61", "ImageUpscaleWithModel"], ["62", "ImageScaleBy"], ["66", "PreviewImage"],
  ["71", "CLIPTextEncode"], ["72", "KSampler"], ["80", "RSCameraControl"],
];
for (const [id, cls] of RS_TEMPLATE_CONTRACT) {
  if (RS_TEMPLATE[id]?.class_type !== cls) throw new Error(`draw RS workflow contract mismatch: node ${id} != ${cls}`);
}


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
  /** 高清模式：净 3 倍出图；采样与质感 pass 恒在 2 倍域内，第三倍在 pass 后纯放大补齐。 */
  hd?: boolean;
  /** 快速模式：初采样 28 步 + 质感 pass 14 步 + 净超分 1.2x（4x × lanczos 0.3）；仅单人默认管线。 */
  fast?: boolean;
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
  /** 角色 LoRA：file/inject 来自角色词表，这里只做形态校验与机械拼接。 */
  lora?: { file: string; weight: number; inject: string };
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
  const passSeed = randomBytes(4).readUInt32BE();
  graph["7"].inputs.seed = seed;
  graph["72"].inputs.seed = passSeed;
  graph["7"].inputs.cfg = args.cfg ?? 4.5;
  graph["6"].inputs.width = args.width ?? 912;
  graph["6"].inputs.height = args.height ?? 1216;
  const prefix = String(graph["4"].inputs.text);
  const suffix = (args.bypass ? `, ${args.bypass}` : "") + (args.bypassP ? `, ${args.bypassP}` : "");
  graph["4"].inputs.text = prefix + (args.lora ? `${escapeInjected(normalizeTagForm(args.lora.inject))}, ` : "") + normalizeTagForm(args.prompt) + suffix;
  // 质感 pass（M2 定版 2026-11-10）：超分后同域重采样 denoise 0.25。初采样带四轴扁平（node 4），
  // pass 用裸地板 + 同内容（去轴向自然走，M2 验证）；负向共用 node 5；LoRA 挂链时 pass 采样器同接链尾（R3）。
  graph["71"].inputs.text = String(graph["71"].inputs.text) + (args.lora ? `${escapeInjected(normalizeTagForm(args.lora.inject))}, ` : "") + normalizeTagForm(args.prompt) + suffix;
  if (args.style) {
    // 风格 LoRA：全局画风，挂在底模之后、角色 LoRA 之前（节点 88）。
    if (!/^[\w .@()-]+\.safetensors$/.test(args.style.file) || !Number.isFinite(args.style.weight) || args.style.weight < 0.4 || args.style.weight > 1.1) throw new Error("invalid draw style");
    graph["88"] = { class_type: "AnimaLoRARemapTagLoader", inputs: { model: ["1", 0], clip: ["2", 0], text: `<lora:${args.style.file}:${args.style.weight}>`, default_weight: 1, weight_multiplier: 1, auto_remap: true, save_remapped: false, extend_to_new_layers: false, extend_strength: 0.5, manifest: "Auto (Recommended)" } };
    for (const id of ["7", "72"]) graph[id].inputs.model = ["88", 0];
    for (const id of ["4", "5", "71"]) graph[id].inputs.clip = ["88", 1];
  }
  if (args.lora) {
    // 角色 LoRA 链在风格之后（有风格时接 88），消费方统一改接 93。
    if (!/^[\w .@()-]+\.safetensors$/.test(args.lora.file) || !Number.isFinite(args.lora.weight) || args.lora.weight < 0.4 || args.lora.weight > 1.1) throw new Error("invalid draw lora");
    const upstream = args.style ? { model: ["88", 0], clip: ["88", 1] } : { model: ["1", 0], clip: ["2", 0] };
    graph["93"] = { class_type: "AnimaLoRARemapTagLoader", inputs: { model: upstream.model, clip: upstream.clip, text: `<lora:${args.lora.file}:${args.lora.weight}>`, default_weight: 1, weight_multiplier: 1, auto_remap: true, save_remapped: false, extend_to_new_layers: false, extend_strength: 0.5, manifest: "Auto (Recommended)" } };
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
  // 超分链在模板里（90/91/92）：初采样解码 → AnimeSharp 4x → lanczos 0.5 = 净 2 倍。
  if (args.fast === true) {
    graph["92"].inputs.scale_by = 0.3; // 快速模式：4x × 0.3 = 净 1.2x，pass 同域变小
    graph["7"].inputs.steps = 28; // 初采样 30 → 28 步（主人裁定 2026-11-13）
    // 质感 pass 30 → 14 步：denoise 0.25 不减步数（set_steps 取 int(steps/denoise) 调度的低噪尾部，
    // 仍跑满 steps），pass 才是耗时大头，砍步数才是真提速（执行日志 + 源码核实）。
    graph["72"].inputs.steps = 14;
  }
  // 质感 pass（尾部光照/质感化，M2 定版）：超分后的同域低强度重采样，denoise 0.25、裸地板词，
  // 负向共用 node 5；AGENTS 约束：禁止把它改回「修复」用途或提高强度越界（M3 实测 0.35 唇形失控）。
  if (args.hd === true) {
    graph["95"] = { class_type: "UpscaleModelLoader", inputs: { model_name: "4x-AnimeSharp.safetensors" } };
    graph["96"] = { class_type: "ImageUpscaleWithModel", inputs: { upscale_model: ["95", 0], image: ["73", 0] } };
    graph["97"] = { class_type: "ImageScaleBy", inputs: { image: ["96", 0], upscale_method: "lanczos", scale_by: 0.375 } };
    graph["9"].inputs.images = ["97", 0];
  }
  return graph;
}

/** RS 区域管线的一位：此人的描述与可选角色 LoRA。 */
export interface MultiPart {
  text: string;
  role?: { file: string; weight: number; inject: string };
}
export interface MultiDraw {
  prompt: string;
  /** 高清模式：净 3 倍出图；采样与质感 pass 恒在 2 倍域内，第三倍在 pass 后纯放大补齐。 */
  hd?: boolean;
  width: number;
  height: number;
  seed?: number;
  parts: MultiPart[];
  framing?: "normal" | "wide";
  spacing?: "together" | "apart";
  /** 场景级 bypass（bypass: 段）：附加到初采样公共提示与 pass 正向末尾。 */
  bypass?: string;
  /** 人物级 bypass（pbypass: 段）：附加到两个人物的区域提示末尾。 */
  pbypass?: string;
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

/** 双人唯一路径：固定相接或分离矩形，只有远景接 Camera。 */
export function makeRsGraph(args: MultiDraw): Graph {
  validateParts(args.parts);
  if (args.framing !== undefined && !["normal", "wide"].includes(args.framing)) throw new Error("invalid multi framing");
  if (args.spacing !== undefined && !["together", "apart"].includes(args.spacing)) throw new Error("invalid multi spacing");
  const g = structuredClone(RS_TEMPLATE);
  const floor = String(TEMPLATE["71"].inputs.text); // pass 裸地板（node 4 现含四轴，不可取）
  const neg = String(TEMPLATE["5"].inputs.text);
  const seed = args.seed ?? randomBytes(4).readUInt32BE();
  const passSeed = randomBytes(4).readUInt32BE();
  const suffix = args.bypass ? `, ${args.bypass}` : "";
  g["4"].inputs.layout_mode = "boxes";
  for (let i = 0; i < 2; i++) {
    const part = args.parts[i];
    const s = g["4"].inputs;
    s[`character${i + 1}`] = [part.role ? escapeInjected(normalizeTagForm(multiRoleTags(part))) : "", normalizeTagForm(part.text), args.pbypass].filter(Boolean).join(", ");
    s[`character${i + 1}_lora`] = part.role?.file ?? "None";
    s[`character${i + 1}_lora_strength`] = part.role?.weight ?? 1;
    s[`character${i + 1}_lora_clip_strength`] = part.role?.weight ?? 1;
    const apart = args.spacing === "apart";
    s[`character${i + 1}_x`] = apart ? [0.29, 0.71][i] : [0.345, 0.655][i];
    s[`character${i + 1}_y`] = 0.5;
    s[`character${i + 1}_width`] = apart ? 0.30 : 0.31;
    s[`character${i + 1}_height`] = 0.85;
  }
  const commonPrompt = /^2girls(?:\s|,)/i.test(args.prompt) ? args.prompt : `2girls, ${args.prompt}`;
  Object.assign(g["5"].inputs, { prompt: String(RS_TEMPLATE["5"].inputs.prompt) + commonPrompt + suffix, negative_prompt: neg, width: args.width, height: args.height, seed }); // 初采样带四轴扁平前缀（模板 node5.prompt），pass 才裸地板
  if (args.framing === "wide") {
    Object.assign(g["80"].inputs, { base_prompt: g["5"].inputs.prompt, canvas_aspect: args.width / args.height });
    g["5"].inputs.character_pipe = ["80", 0];
    g["5"].inputs.prompt = ["80", 1];
  } else {
    delete g["80"];
    g["5"].inputs.character_pipe = ["4", 0];
  }
  // 质感 pass：裸地板 + 双人合并词（R3 验证：denoise 0.25 低强度增益不融合），负向与初采样同。
  const passSegments = args.parts.flatMap((part) => [part.role ? escapeInjected(normalizeTagForm(multiRoleTags(part))) : "", normalizeTagForm(part.text)].filter((s) => s));
  g["71"].inputs.text = `${floor}${commonPrompt}, ${passSegments.join(", ")}${suffix}`;
  g["74"].inputs.text = neg;
  g["72"].inputs.seed = passSeed;
  // pass 的 LoRA 链（链式 93→94；无角色时 pass 直接吃基模）：
  let up: { model: [string, number]; clip: [string, number] } = { model: ["1", 0], clip: ["2", 0] };
  let last = "";
  args.parts.forEach((part, i) => {
    if (!part.role) return;
    const id = String(93 + i);
    g[id] = { class_type: "AnimaLoRARemapTagLoader", inputs: { model: up.model, clip: up.clip, text: `<lora:${part.role.file}:${part.role.weight}>`, default_weight: 1, weight_multiplier: 1, auto_remap: true, save_remapped: false, extend_to_new_layers: false, extend_strength: 0.5, manifest: "Auto (Recommended)" } };
    up = { model: [id, 0], clip: [id, 1] };
    last = id;
  });
  if (last) {
    g["72"].inputs.model = [last, 0];
    g["71"].inputs.clip = [last, 1];
    g["74"].inputs.clip = [last, 1];
  }
  g["62"].inputs.scale_by = 0.5;
  if (args.hd === true) {
    g["95"] = { class_type: "UpscaleModelLoader", inputs: { model_name: "4x-AnimeSharp.safetensors" } };
    g["96"] = { class_type: "ImageUpscaleWithModel", inputs: { upscale_model: ["95", 0], image: ["73", 0] } };
    g["97"] = { class_type: "ImageScaleBy", inputs: { image: ["96", 0], upscale_method: "lanczos", scale_by: 0.375 } };
    g["66"].inputs.images = ["97", 0];
  }
  return g;
}

// ── 交互管线模板（2026-11-12 定稿：初采样 B1+Pose3D → AnimeSharp 2x → 重装备 pass@2x，
//    顺序对照 B 臂胜出）。姿态来自离线 authoring 产出的冻结预设（scene_json + 人物框），
//    运行时零求解；地板词（主人 2026-11-12 圈定）嵌在模板 11/37 的默认 prompt 里。──
const INTERACTION_TEMPLATE = JSON.parse(readFileSync(new URL("./workflow-interaction.json", import.meta.url)).toString("utf8")) as Graph;
const INTERACTION_TEMPLATE_CONTRACT: Array<[string, string]> = [
  ["1", "RSMultiCharacterPrompt"], ["4", "RSMultiCharacterPose3D"], ["11", "RSMultiCharacterSampler"],
  ["22", "ImageUpscaleWithModel"], ["23", "ImageScaleBy"],
  ["33", "RSMultiCharacterFinalize"], ["35", "YugangStudyCameraProject"], ["36", "AnimaLLLiteApply"],
  ["37", "YugangRSSceneImg2Img"], ["38", "SaveImage"],
];
for (const [id, cls] of INTERACTION_TEMPLATE_CONTRACT) {
  if (INTERACTION_TEMPLATE[id]?.class_type !== cls) throw new Error(`draw interaction workflow contract mismatch: node ${id} != ${cls}`);
}

/** 姿态预设：离线 MHR authoring 冻结产物（scene_json 两档分辨率 + 归一化人物框）。 */
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
}

// 交互管线负向（2026-11-12 主人圈定并删去 monochrome/lips）
const INTERACTION_NEGATIVE = "low quality, worst quality, score_1, score_2, score_3, early, old, shiny skin";
export function makeInteractionGraph(args: InteractionDraw): Graph {
  validateParts(args.parts);
  if (!Number.isInteger(args.width) || !Number.isInteger(args.height) || args.width % 8 !== 0 || args.height % 8 !== 0) throw new Error("invalid interaction canvas");
  const g = structuredClone(INTERACTION_TEMPLATE);
  const floorPos = String(INTERACTION_TEMPLATE["11"].inputs.prompt);
  const neg = INTERACTION_NEGATIVE;
  const seed = args.seed ?? randomBytes(4).readUInt32BE(0);
  const passSeed = args.passSeed ?? randomBytes(4).readUInt32BE(0);
  const commonPrompt = /^2girls(?:\s|,)/i.test(args.prompt) ? args.prompt : `2girls, ${args.prompt}`;
  const fullPrompt = floorPos + normalizeTagForm(commonPrompt);
  for (const group of ["1", "30"] as const) {
    for (let i = 0; i < 2; i++) {
      const part = args.parts[i];
      g[group].inputs[`character${i + 1}`] = [part.role ? escapeInjected(normalizeTagForm(multiRoleTags(part))) : "", normalizeTagForm(part.text)].filter(Boolean).join(", ");
      g[String(Number(group) + 1)].inputs[`character${i + 1}_lora`] = part.role?.file ?? "None";
      g[String(Number(group) + 1)].inputs[`character${i + 1}_lora_strength`] = part.role?.weight ?? 1;
      g[String(Number(group) + 1)].inputs[`character${i + 1}_lora_clip_strength`] = part.role?.weight ?? 1;
      const b = args.preset.box[i];
      g[String(Number(group) + 2)].inputs[`character${i + 1}_x`] = b.x;
      g[String(Number(group) + 2)].inputs[`character${i + 1}_y`] = b.y;
      g[String(Number(group) + 2)].inputs[`character${i + 1}_width`] = b.width;
      g[String(Number(group) + 2)].inputs[`character${i + 1}_height`] = b.height;
    }
  }
  g["4"].inputs.scene_json = args.preset.scene_json;
  Object.assign(g["11"].inputs, { prompt: fullPrompt, negative_prompt: neg, seed, width: args.width, height: args.height });
  g["12"].inputs.filename_prefix = `interaction/${args.label}/initial`;
  g["13"].inputs.label = `${args.label} initial`;
  g["35"].inputs.scene_json = args.preset.scene_json;
  g["35"].inputs.camera_extension = args.preset.camera_extension;
  Object.assign(g["37"].inputs, { prompt: fullPrompt, negative_prompt: neg, seed: passSeed, width: args.width * 2, height: args.height * 2 });
  g["38"].inputs.filename_prefix = `interaction/${args.label}/final`;
  g["39"].inputs.label = `${args.label} final`;
  return g;
}

/** 单人轻形态：KSampler + 链式 LoRA + LLLite 姿态，无 RS（单人无隔离需求，
 *  不承担 N×N 注意力偏置矩阵开销）。其余（姿态预设/超分/pass@2x/地板词）与双人一致。 */
export function makeInteractionSingleGraph(args: {
  prompt: string; width: number; height: number; seed?: number; passSeed?: number;
  preset: InteractionPreset; part: MultiPart; label: string;
}): Graph {
  if (!args.part.text || args.part.text.length > 800) throw new Error("invalid single part text");
  if (args.part.role !== undefined && (!/^[\w .@()-]+\.safetensors$/.test(args.part.role.file) || !Number.isFinite(args.part.role.weight) || args.part.role.weight < 0.4 || args.part.role.weight > 1.1)) throw new Error("invalid single role");
  if (!Number.isInteger(args.width) || !Number.isInteger(args.height) || args.width % 8 !== 0 || args.height % 8 !== 0) throw new Error("invalid single canvas");
  const g: Graph = {};
  const floorPos = String(INTERACTION_TEMPLATE["11"].inputs.prompt);
  const neg = INTERACTION_NEGATIVE;
  const seed = args.seed ?? randomBytes(4).readUInt32BE(0);
  const passSeed = args.passSeed ?? randomBytes(4).readUInt32BE(0);
  const commonPrompt = /^1girl(?:\s|,)/i.test(args.prompt) ? args.prompt : `1girl, solo, ${args.prompt}`;
  const fullPrompt = floorPos + normalizeTagForm(commonPrompt);
  const part = args.part;
  const desc = [part.role ? escapeInjected(normalizeTagForm(multiRoleTags(part))) : "", normalizeTagForm(part.text)].filter(Boolean).join(", ");
  const positive = `${fullPrompt}, ${desc}`;
  const loraFile = part.role?.file ?? "None";
  const loraW = part.role?.weight ?? 1;

  g["1"] = { class_type: "UNETLoader", inputs: { unet_name: "DeltaMix 3.8B V8.safetensors", weight_dtype: "default" } };
  g["2"] = { class_type: "CLIPLoader", inputs: { clip_name: "qwen_3_06b_base.safetensors", type: "stable_diffusion", device: "default" } };
  g["3"] = { class_type: "VAELoader", inputs: { vae_name: "qwen_image_vae.safetensors" } };
  if (part.role) {
    g["4"] = { class_type: "LoraLoader", inputs: { model: ["1", 0], clip: ["2", 0], lora_name: loraFile, strength_model: loraW, strength_clip: loraW } };
  }
  const modelOut = part.role ? ["4", 0] : ["1", 0];
  const clipOut = part.role ? ["4", 1] : ["2", 0];
  g["5"] = { class_type: "RSMultiCharacterPose3D", inputs: { pose_control: "auto", pose_strength: 0.8, pose_start: 0.0, pose_end: 0.7, scene_json: args.preset.scene_json } };
  g["6"] = { class_type: "ModelPatchLoader", inputs: { name: "rs_reference/anima_pose/anima_v8_3dpose.safetensors" } };
  g["36"] = { class_type: "AnimaLLLiteApply", inputs: { strength: 0.8, start_percent: 0.0, end_percent: 0.7, model: modelOut, model_patch: ["6", 0], image: ["5", 5] } };
  g["7"] = { class_type: "CLIPTextEncode", inputs: { text: positive, clip: clipOut } };
  g["8"] = { class_type: "CLIPTextEncode", inputs: { text: neg, clip: clipOut } };
  g["10"] = { class_type: "EmptySD3LatentImage", inputs: { width: args.width, height: args.height, batch_size: 1 } };
  g["11"] = { class_type: "KSampler", inputs: {
    model: ["36", 0],
    positive: ["7", 0], negative: ["8", 0], latent_image: ["10", 0],
    seed, steps: 30, cfg: 4.0, sampler_name: "euler_ancestral", scheduler: "sgm_uniform", denoise: 1.0 } };
  g["14"] = { class_type: "VAEDecode", inputs: { samples: ["11", 0], vae: ["3", 0] } };
  g["12"] = { class_type: "SaveImage", inputs: { images: ["14", 0], filename_prefix: `interaction/${args.label}/initial` } };

  g["21"] = { class_type: "UpscaleModelLoader", inputs: { model_name: "4x-AnimeSharp.safetensors" } };
  g["22"] = { class_type: "ImageUpscaleWithModel", inputs: { upscale_model: ["21", 0], image: ["14", 0] } };
  g["23"] = { class_type: "ImageScaleBy", inputs: { image: ["22", 0], upscale_method: "lanczos", scale_by: 0.5 } };

  g["24"] = { class_type: "VAEEncode", inputs: { pixels: ["23", 0], vae: ["3", 0] } };
  g["25"] = { class_type: "CLIPTextEncode", inputs: { text: positive, clip: clipOut } };
  g["26"] = { class_type: "CLIPTextEncode", inputs: { text: neg, clip: clipOut } };
  g["27"] = { class_type: "KSampler", inputs: {
    model: modelOut,
    positive: ["25", 0], negative: ["26", 0], latent_image: ["24", 0],
    seed: passSeed, steps: 30, cfg: 4.0, sampler_name: "euler_ancestral", scheduler: "sgm_uniform", denoise: 0.25 } };
  g["28"] = { class_type: "VAEDecode", inputs: { samples: ["27", 0], vae: ["3", 0] } };
  g["38"] = { class_type: "SaveImage", inputs: { images: ["28", 0], filename_prefix: `interaction/${args.label}/final` } };
  return g;
}

export class ComfyExecutionFailed extends Error {}
export class ComfyBusy extends Error {}
let busy = false;

/** draw 阶段进度（不过模型）：sketch=初采样（后接超分，无扩散阶段）。 */
export type DrawStage = "sketch";

/** 阶段状态机："7"初采样 → "43"解码 → "91"/"92"超分 → "9"输出
 *  （脸修 2026-11-10、手修 2026-11-13 退役，主人裁定）。
 *  进入初采样后首批节点（sketch）时汇报一次；乱序/未知节点忽略。 */
function makeStageTracker(promptId: string, onStage: (stage: DrawStage) => void): (message: unknown) => void {
  let stage = 0;
  return (message) => {
    if (typeof message !== "string") return; // 二进制预览帧忽略
    try {
      const event = JSON.parse(message) as { type?: string; data?: { node?: string | null; prompt_id?: string } };
      if (event.type !== "executing" || event.data?.prompt_id !== promptId) return;
      const node = event.data?.node;
      if (typeof node !== "string") return;
      if (stage < 1 && (node === "43" || node === "91" || node === "5" || node === "61")) {
        stage = 1;
        onStage("sketch");
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

/** RS 区域管线（双人唯一路径）：提交 RS 图并轮询到成功，输出取 node 66。 */
export async function runMulti(url: string, args: MultiDraw, onSubmitted: () => void): Promise<Buffer> {
  if (busy) throw new ComfyBusy("ComfyUI busy");
  busy = true;
  try {
    const base = comfyUrl(url);
    const queue = await (await request(`${base}/queue`)).json() as { queue_running?: unknown[]; queue_pending?: unknown[] };
    if (!Array.isArray(queue.queue_running) || !Array.isArray(queue.queue_pending)) throw new Error("invalid ComfyUI queue");
    if (queue.queue_running.length || queue.queue_pending.length) throw new ComfyBusy("ComfyUI busy");
    const id = randomUUID();
    const clientId = randomUUID();
    const graph = makeRsGraph(args);
    onSubmitted();
    const job = await submitAndWait(base, graph, id, clientId, Date.now() + 400_000);
    return await fetchOutputImage(base, job, "66");
  } finally { busy = false; }
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

/** 交互双人管线提交：makeInteractionGraph → submitAndWait → 取 final(node 38)。
 * 输出为 SaveImage 的 output 类型（可带子目录），与单管线 temp 语义不同，单独取图。 */
async function fetchInteractionOutput(base: string, job: ComfyHistoryJob): Promise<Buffer> {
  const images = job.outputs?.["38"]?.images;
  if (!Array.isArray(images) || images.length !== 1) throw new Error("invalid interaction output");
  const image = images[0];
  if (image.type !== "output" || !image.filename || !/^[A-Za-z0-9_.-]+\.png$/.test(image.filename)) throw new Error("invalid interaction output path");
  const query = new URLSearchParams({ filename: image.filename, type: "output", subfolder: image.subfolder ?? "" });
  return imageBytes(await request(`${base}/view?${query}`, {}, 60_000));
}

export async function runInteraction(url: string, args: InteractionDraw, onSubmitted: () => void): Promise<Buffer> {
  if (busy) throw new ComfyBusy("ComfyUI busy");
  busy = true;
  try {
    const base = comfyUrl(url);
    const queue = await (await request(`${base}/queue`)).json() as { queue_running?: unknown[]; queue_pending?: unknown[] };
    if (!Array.isArray(queue.queue_running) || !Array.isArray(queue.queue_pending)) throw new Error("invalid ComfyUI queue");
    if (queue.queue_running.length || queue.queue_pending.length) throw new ComfyBusy("ComfyUI busy");
    const id = randomUUID();
    const clientId = randomUUID();
    const graph = makeInteractionGraph(args);
    onSubmitted();
    const job = await submitAndWait(base, graph, id, clientId, Date.now() + 600_000);
    return await fetchInteractionOutput(base, job);
  } finally { busy = false; }
}

export async function runInteractionSingle(url: string, args: {
  prompt: string; width: number; height: number; seed?: number; passSeed?: number;
  preset: InteractionPreset; part: MultiPart; label: string;
}, onSubmitted: () => void): Promise<Buffer> {
  if (busy) throw new ComfyBusy("ComfyUI busy");
  busy = true;
  try {
    const base = comfyUrl(url);
    const queue = await (await request(`${base}/queue`)).json() as { queue_running?: unknown[]; queue_pending?: unknown[] };
    if (!Array.isArray(queue.queue_running) || !Array.isArray(queue.queue_pending)) throw new Error("invalid ComfyUI queue");
    if (queue.queue_running.length || queue.queue_pending.length) throw new ComfyBusy("ComfyUI busy");
    const id = randomUUID();
    const clientId = randomUUID();
    const graph = makeInteractionSingleGraph(args);
    onSubmitted();
    const job = await submitAndWait(base, graph, id, clientId, Date.now() + 600_000);
    return await fetchInteractionOutput(base, job);
  } finally { busy = false; }
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
