import { randomBytes } from "node:crypto";
import { readFileSync } from "node:fs";
import type { Graph, Link, Node } from "../../engine.ts";
import { DEFAULT_DRAW_BACKEND } from "../ids.ts";
import type {
  DrawBackend,
  DrawBuildRequest,
  DrawBuiltGraph,
  DrawLoraRef,
  DrawMultiPart,
  DrawRatio,
  DrawRoleInput,
} from "../types.ts";

export interface Anima38bTemplates {
  readonly main: Graph;
  readonly interaction: Graph;
  readonly single: Graph;
}

const TEMPLATE = JSON.parse(readFileSync(new URL("./workflow.json", import.meta.url)).toString("utf8")) as Graph;
const INTERACTION_TEMPLATE = JSON.parse(readFileSync(new URL("./workflow-interaction.json", import.meta.url)).toString("utf8")) as Graph;
const SINGLE_TEMPLATE = JSON.parse(readFileSync(new URL("./workflow-interaction-single.json", import.meta.url)).toString("utf8")) as Graph;
const INTERACTION_PRESETS = JSON.parse(readFileSync(new URL("./interaction-presets.json", import.meta.url)).toString("utf8")) as Record<string, InteractionPreset>;

const TEMPLATE_CONTRACT: Array<[string, string]> = [
  ["1", "UNETLoader"], ["4", "CLIPTextEncode"], ["5", "CLIPTextEncode"], ["6", "EmptySD3LatentImage"],
  ["7", "KSampler"], ["9", "PreviewImage"],
  ["71", "CLIPTextEncode"], ["72", "KSampler"],
  ["91", "ImageUpscaleWithModel"], ["92", "ImageScaleBy"],
];

const INTERACTION_TEMPLATE_CONTRACT: Array<[string, string]> = [
  ["1", "RSMultiCharacterPrompt"], ["4", "RSMultiCharacterPose3D"], ["11", "RSMultiCharacterSampler"],
  ["22", "ImageUpscaleWithModel"], ["23", "ImageScaleBy"],
  ["35", "YugangStudyCameraProject"], ["70", "VAEEncode"], ["72", "KSampler"], ["73", "VAEDecode"], ["38", "SaveImage"],
];

const SINGLE_TEMPLATE_CONTRACT: Array<[string, string]> = [
  ["1", "UNETLoader"],
  ["11", "KSampler"], ["27", "KSampler"], ["22", "ImageUpscaleWithModel"], ["23", "ImageScaleBy"], ["38", "SaveImage"],
];

/** 纯函数结构契约校验：代码 rewiring 的角色节点必须在场且 class 正确，缺任何一个启动即拒。 */
export function validateAnima38bTemplates(
  templates: Anima38bTemplates = { main: TEMPLATE, interaction: INTERACTION_TEMPLATE, single: SINGLE_TEMPLATE },
): void {
  for (const [id, cls] of TEMPLATE_CONTRACT) {
    if (templates.main[id]?.class_type !== cls) throw new Error(`draw workflow contract mismatch: node ${id} != ${cls}`);
  }
  if (templates.main["1"]?.inputs.unet_name !== "DeltaMix 3.8B V8.safetensors") {
    throw new Error("draw workflow contract mismatch: unet");
  }
  for (const [id, cls] of INTERACTION_TEMPLATE_CONTRACT) {
    if (templates.interaction[id]?.class_type !== cls) throw new Error(`draw interaction workflow contract mismatch: node ${id} != ${cls}`);
  }
  for (const [id, cls] of SINGLE_TEMPLATE_CONTRACT) {
    if (templates.single[id]?.class_type !== cls) throw new Error(`draw single workflow contract mismatch: node ${id} != ${cls}`);
  }
}

validateAnima38bTemplates();

export const ANIMA38B_RATIO_SIZES: Readonly<Record<DrawRatio, readonly [number, number]>> = {
  "1:1": [1056, 1056],
  "3:4": [912, 1216],
  "4:3": [1216, 912],
  "2:3": [832, 1248],
  "3:2": [1248, 832],
  "9:16": [720, 1280],
  "16:9": [1280, 720],
};

/** CLIPTextEncode 把半角括号当权重语法；注入的 danbooru tag 括号必须转义，用户 prompt 不动。幂等。 */
function escapeInjected(text: string): string {
  return text.replace(/(?<!\\)([()])/g, "\\$1");
}

/** 只把 danbooru 形状 `xxx_(yyy_zzz)` 改成 `xxx \(yyy zzz\)`；触发词下划线与刻意加权不动。 */
function normalizeTagForm(text: string): string {
  return text.replace(/([A-Za-z0-9]+)_\(([^()]*)\)/g, (_m, head: string, inner: string) => `${head} \\(${inner.replace(/_/g, " ")}\\)`);
}

function assertValidLora(file: string, weight: number, errorMessage: string): void {
  if (!/^[\w .@()-]+\.safetensors$/.test(file) || !Number.isFinite(weight) || weight < 0.4 || weight > 1.1) {
    throw new Error(errorMessage);
  }
}

/** 角色/风格 LoRA 重映射节点（28→52 层）。file/weight 机械校验，缺文件由 requireGraphLoras 提交前拒绝。 */
function loraLoader(model: Link, clip: Link, file: string, weight: number): Node {
  assertValidLora(file, weight, "invalid draw lora");
  return {
    class_type: "AnimaLoRARemapTagLoader",
    inputs: {
      model,
      clip,
      text: `<lora:${file}:${weight}>`,
      default_weight: 1,
      weight_multiplier: 1,
      auto_remap: true,
      save_remapped: false,
      extend_to_new_layers: false,
      extend_strength: 0.5,
      manifest: "Auto (Recommended)",
    },
  };
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

export interface MultiPart {
  text: string;
  role?: { file: string; weight: number; inject: string };
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

interface DirectBuildInput {
  hd?: boolean;
  fast?: boolean;
  prompt: string;
  bypass?: string;
  bypassP?: string;
  style?: DrawLoraRef;
  width?: number;
  height?: number;
  cfg?: number;
  seed?: number;
  role?: DrawRoleInput;
  ref?: { strength: number; inputName?: string };
}

/** 内部直出/fast/ref/ref+fast 构图器：支持仅 inject 降级角色（role.lora 为 undefined）。 */
function buildDirectGraph(args: DirectBuildInput): Graph {
  const graph = structuredClone(TEMPLATE);
  graph["7"].inputs.seed = args.seed ?? randomBytes(4).readUInt32BE();
  graph["72"].inputs.seed = randomBytes(4).readUInt32BE();
  graph["7"].inputs.cfg = args.cfg ?? 4.5;
  graph["6"].inputs.width = args.width ?? 912;
  graph["6"].inputs.height = args.height ?? 1216;
  const suffix = (args.bypass ? `, ${args.bypass}` : "") + (args.bypassP ? `, ${args.bypassP}` : "");
  const inject = args.role?.inject ? `${escapeInjected(normalizeTagForm(args.role.inject))}, ` : "";
  graph["4"].inputs.text = String(graph["4"].inputs.text) + inject + normalizeTagForm(args.prompt) + suffix;
  graph["71"].inputs.text = String(graph["71"].inputs.text) + inject + normalizeTagForm(args.prompt) + suffix;
  if (args.style) {
    graph["88"] = loraLoader(["1", 0], ["2", 0], args.style.file, args.style.weight);
    for (const id of ["7", "72"]) graph[id].inputs.model = ["88", 0];
    for (const id of ["4", "5", "71"]) graph[id].inputs.clip = ["88", 1];
  }
  if (args.role?.lora) {
    const up: { model: Link; clip: Link } = args.style ? { model: ["88", 0], clip: ["88", 1] } : { model: ["1", 0], clip: ["2", 0] };
    graph["93"] = loraLoader(up.model, up.clip, args.role.lora.file, args.role.lora.weight);
    for (const id of ["7", "72"]) graph[id].inputs.model = ["93", 0];
    for (const id of ["4", "5", "71"]) graph[id].inputs.clip = ["93", 1];
  }
  if (args.ref) {
    const inputName = args.ref.inputName;
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

/** 直出/fast（无 LLLite）：workflow.json 模板 + 注入（兼容旧签名）。 */
export function makeGraph(args: ComfyDraw, inputName?: string): Graph {
  return buildDirectGraph({
    hd: args.hd,
    fast: args.fast,
    prompt: args.prompt,
    bypass: args.bypass,
    bypassP: args.bypassP,
    style: args.style,
    width: args.width,
    height: args.height,
    cfg: args.cfg,
    seed: args.seed,
    role: args.lora ? { inject: args.lora.inject, lora: { file: args.lora.file, weight: args.lora.weight } } : undefined,
    ref: args.ref ? { strength: args.ref.strength, inputName } : undefined,
  });
}

function validateParts(parts: readonly DrawMultiPart[]): void {
  if (parts.length !== 2) throw new Error("invalid multi parts count");
  for (const p of parts) {
    if (!p.text || p.text.length > 800) throw new Error("invalid multi part text");
    if (p.role?.lora !== undefined) assertValidLora(p.role.lora.file, p.role.lora.weight, "invalid multi role");
  }
}

function multiRoleTags(part: DrawMultiPart): string {
  return (part.role?.inject ?? "").split(",").map((t) => t.trim()).filter((t) => t && !/^(?:1girl|solo)$/i.test(t)).join(", ");
}

function partDesc(part: DrawMultiPart, pbypass?: string): string {
  return [part.role ? escapeInjected(normalizeTagForm(multiRoleTags(part))) : "", normalizeTagForm(part.text), pbypass].filter(Boolean).join(", ");
}

// 姿态线初采样＝质量地板(含anime)+真实感细节词（无四轴/赛璐璐）；负向去 lips；
// pass 同挂风格词（2026-11-17 E24b A/B 定罪：裸地板词 pass 吃背景虚化+漂瞳色，风格词 pass 保留）。
const INTERACTION_NEGATIVE = String(INTERACTION_TEMPLATE["11"].inputs.negative_prompt);
const INTERACTION_STYLE = "detailed, intricate, film grain, depth of field, ";

interface MultiBuildInput {
  prompt: string;
  width: number;
  height: number;
  seed?: number;
  passSeed?: number;
  preset: InteractionPreset;
  parts: readonly DrawMultiPart[];
  label: string;
  hd?: boolean;
  bypass?: string;
  pbypass?: string;
  framing?: "normal" | "wide";
  spacing?: "together" | "apart";
}

function buildMultiGraph(args: MultiBuildInput): Graph {
  validateParts(args.parts);
  if (!Number.isInteger(args.width) || !Number.isInteger(args.height) || args.width % 8 !== 0 || args.height % 8 !== 0) {
    throw new Error("invalid interaction canvas");
  }
  const g = structuredClone(INTERACTION_TEMPLATE);
  const floorPos = String(INTERACTION_TEMPLATE["11"].inputs.prompt);
  const neg = INTERACTION_NEGATIVE;
  const seed = args.seed ?? randomBytes(4).readUInt32BE(0);
  const passSeed = args.passSeed ?? randomBytes(4).readUInt32BE(0);
  const commonPrompt = /^2girls(?:\s|,)/i.test(args.prompt) ? args.prompt : `2girls, ${args.prompt}`;
  const fullPrompt = floorPos + INTERACTION_STYLE + normalizeTagForm(commonPrompt) + (args.bypass ? `, ${args.bypass}` : "");
  const initialPrompt = floorPos + INTERACTION_STYLE + normalizeTagForm(commonPrompt) + (args.bypass ? `, ${args.bypass}` : "");
  for (let i = 0; i < 2; i++) {
    const part = args.parts[i];
    g["1"].inputs[`character${i + 1}`] = partDesc(part, args.pbypass);
    g["2"].inputs[`character${i + 1}_lora`] = part.role?.lora?.file ?? "None";
    g["2"].inputs[`character${i + 1}_lora_strength`] = part.role?.lora?.weight ?? 1;
    g["2"].inputs[`character${i + 1}_lora_clip_strength`] = part.role?.lora?.weight ?? 1;
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
  g["60"] = {
    class_type: "YugangPoseLayout",
    inputs: {
      character_pipe: ["7", 0],
      pose_image: ["35", 0],
      owner_a: ["35", 1],
      owner_b: ["35", 2],
      base_prompt: initialPrompt,
      framing: args.framing ?? "normal",
      spacing: args.spacing ?? "together",
      canvas_aspect: args.width / args.height,
    },
  };
  Object.assign(g["11"].inputs, { character_pipe: ["60", 0], prompt: ["60", 1] });
  const passDesc = args.parts.map((p) => partDesc(p, args.pbypass)).join(", ");
  let passModel: Link = ["8", 0];
  let passClip: Link = ["9", 0];
  let chainId = 93;
  for (const p of args.parts) {
    if (!p.role?.lora) continue;
    g[String(chainId)] = loraLoader(passModel, passClip, p.role.lora.file, p.role.lora.weight);
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

function toDrawMultiPart(part: MultiPart): DrawMultiPart {
  return {
    text: part.text,
    ...(part.role ? { role: { inject: part.role.inject, lora: { file: part.role.file, weight: part.role.weight } } } : {}),
  };
}

/** 双人姿态：RS 区域 + Pose3D + Camera → 超分 → pass@2x（兼容旧签名）。 */
export function makeInteractionGraph(args: InteractionDraw): Graph {
  return buildMultiGraph({
    ...args,
    parts: args.parts.map(toDrawMultiPart),
  });
}

interface SingleBuildInput {
  prompt: string;
  width: number;
  height: number;
  seed?: number;
  passSeed?: number;
  preset: InteractionPreset;
  part: DrawMultiPart;
  label: string;
  hd?: boolean;
  bypass?: string;
  pbypass?: string;
}

function buildSingleGraph(args: SingleBuildInput): Graph {
  if (args.part.text.length > 800) throw new Error("invalid single part text");
  if (args.part.role?.lora !== undefined) assertValidLora(args.part.role.lora.file, args.part.role.lora.weight, "invalid single role");
  if (!Number.isInteger(args.width) || !Number.isInteger(args.height) || args.width % 8 !== 0 || args.height % 8 !== 0) {
    throw new Error("invalid single canvas");
  }
  const g = structuredClone(SINGLE_TEMPLATE);
  const floorPos = String(INTERACTION_TEMPLATE["11"].inputs.prompt);
  const neg = INTERACTION_NEGATIVE;
  const seed = args.seed ?? randomBytes(4).readUInt32BE(0);
  const passSeed = args.passSeed ?? randomBytes(4).readUInt32BE(0);
  const commonPrompt = /^1girl(?:\s|,)/i.test(args.prompt) ? args.prompt : `1girl, solo, ${args.prompt}`;
  const desc = [args.part.role ? escapeInjected(normalizeTagForm(multiRoleTags(args.part))) : "", normalizeTagForm(args.part.text)].filter(Boolean).join(", ");
  const suffix = (args.bypass ? `, ${args.bypass}` : "") + (args.pbypass ? `, ${args.pbypass}` : "");
  const positive = `${floorPos}${INTERACTION_STYLE}${normalizeTagForm(commonPrompt)}${desc ? `, ${desc}` : ""}${suffix}`;
  const passPositive = `${floorPos}${INTERACTION_STYLE}${normalizeTagForm(commonPrompt)}, ${desc}${suffix}`;
  const hasLora = args.part.role?.lora !== undefined;
  if (hasLora) g["4"] = loraLoader(["1", 0], ["2", 0], args.part.role!.lora!.file, args.part.role!.lora!.weight);
  else delete g["4"];
  const modelOut: Link = hasLora ? ["4", 0] : ["1", 0];
  const clipOut: Link = hasLora ? ["4", 1] : ["2", 0];
  g["11"].inputs.model = modelOut;
  g["27"].inputs.model = modelOut;
  for (const id of ["7", "8", "25", "26"]) g[id].inputs.clip = clipOut;
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

/** 单人姿态：workflow-interaction-single.json 模板 + 注入（兼容旧签名）。 */
export function makeInteractionSingleGraph(args: {
  prompt: string; width: number; height: number; seed?: number; passSeed?: number;
  preset: InteractionPreset; part: MultiPart; label: string; hd?: boolean;
  bypass?: string; pbypass?: string;
}): Graph {
  return buildSingleGraph({
    ...args,
    part: toDrawMultiPart(args.part),
  });
}

function getRequiredPreset(name: string): InteractionPreset {
  const preset = INTERACTION_PRESETS[name];
  if (!preset) throw new Error(`draw preset contract mismatch: missing ${name}`);
  return preset;
}

export const anima38bBackend: DrawBackend = {
  id: DEFAULT_DRAW_BACKEND,
  loraFamily: "anima",
  ratioSizes: ANIMA38B_RATIO_SIZES,
  capabilities: {
    modes: { single: true, fast: true, ref: true, multi: true },
    hd: true,
    styleModes: ["fast", "ref"],
    framing: true,
    spacing: true,
  },
  validateStartup(): void {
    validateAnima38bTemplates();
    getRequiredPreset("single-haystack");
    getRequiredPreset("sit-haystack");
  },
  buildGraph(request: DrawBuildRequest): DrawBuiltGraph {
    if (request.mode === "single") {
      const preset = getRequiredPreset("single-haystack");
      const graph = buildSingleGraph({
        prompt: request.prompt,
        width: request.width,
        height: request.height,
        seed: request.seed,
        preset,
        part: { text: "", ...(request.role ? { role: request.role } : {}) },
        label: "single-haystack",
        hd: request.hd,
        bypass: request.bypass,
        pbypass: request.pbypass,
      });
      return {
        graph,
        outputNode: "38",
        outputType: "output",
        deadline: 1_500_000,
        workingVariant: "draw_interaction",
        stageNodes: undefined,
      };
    }
    if (request.mode === "multi") {
      const preset = getRequiredPreset("sit-haystack");
      const graph = buildMultiGraph({
        prompt: request.prompt,
        width: request.width,
        height: request.height,
        seed: request.seed,
        preset,
        parts: request.parts ?? [],
        label: "sit-haystack",
        hd: request.hd,
        bypass: request.bypass,
        pbypass: request.pbypass,
        framing: request.framing,
        spacing: request.spacing,
      });
      return {
        graph,
        outputNode: "38",
        outputType: "output",
        deadline: 1_500_000,
        workingVariant: "draw_interaction",
        stageNodes: undefined,
      };
    }
    if (request.mode === "fast") {
      const graph = buildDirectGraph({
        prompt: request.prompt,
        width: request.width,
        height: request.height,
        hd: request.hd,
        fast: true,
        seed: request.seed,
        role: request.role,
        style: request.style,
        bypass: request.bypass,
        bypassP: request.pbypass,
      });
      return {
        graph,
        outputNode: "9",
        outputType: "temp",
        deadline: 240_000,
        workingVariant: "draw_fast",
        stageNodes: ["43", "91"],
      };
    }
    if (request.mode === "ref") {
      const graph = buildDirectGraph({
        prompt: request.prompt,
        width: request.width,
        height: request.height,
        hd: request.hd,
        fast: request.fast,
        seed: request.seed,
        role: request.role,
        style: request.style,
        ref: { strength: request.refStrength ?? 0.45, inputName: request.refInputName },
        bypass: request.bypass,
        bypassP: request.pbypass,
      });
      return {
        graph,
        outputNode: "9",
        outputType: "temp",
        deadline: 240_000,
        workingVariant: request.fast ? "draw_fast" : "draw",
        stageNodes: ["43", "91"],
      };
    }
    throw new Error(`unsupported draw mode: ${String(request.mode)}`);
  },
};
