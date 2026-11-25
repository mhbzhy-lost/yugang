/**
 * graphs.ts —— 全部方法的 ComfyUI API-format 图构建（纯函数：opts → 图对象；不写盘）。
 *
 * 接线依据（全部来自真实冻结源码/接口，参数名逐一对照，不虚构）：
 * - RS builder 链（character_builder.py @721d57ab，本地冻结副本 checks/environment-code/rs/）：
 *   RSMultiCharacterPrompt(character_count, character1..10_enable/_kind, character{i} STRING)
 *   → RSMultiCharacterLoRA(character_count, character1..10_lora/_lora_strength/_lora_clip_strength,
 *     lora_application_mode) → RSMultiCharacterPosition(character{i}_geometry/x/y/width/height)
 *   → [RSMultiCharacterPose3D(scene_json, building_pipe, pose_control, pose_strength/start/end)
 *     → RSMultiCharacterMask(character_id, enabled, margin, threshold, building_pipe, mask)]
 *   → RSMultiCharacterFinalize。
 * - B1 必须在 Pose3D 后对两槽显式 Mask(enabled=false)：Pose3D apply() 会把渲染轮廓写进它拥有的
 *   槽（preflight pose3dNodeFace 机械事实），不清就变成非矩形区域，B1/B2 变量混淆。
 * - B2 = Mask(enabled=true, mask=owner 非矩形 union, margin=0, threshold=0.5)；body_parts 由
 *   Mask 节点确定性清空（update_slot(..., body_parts=(), body_part_strength=0.)，源码 L335）。
 * - RSMultiCharacterSampler（nodes.py @721d57ab）：routing 参数显式全冻结值、
 *   layout_method="regional"（缺省 auto，必须显式钉死）、autosave=false（落盘走 SaveImage）。
 *   generation_info = output 3；Pose3D scene_info = output 4、pose_image = output 5。
 * - 姿态只挂一次：RS 路径由 pose_pipe 在采样器内部调用（图里只有 Pose3D，不出现
 *   ModelPatchLoader/AnimaLLLiteApply）；W-G 原生路径显式 ModelPatchLoader+AnimaLLLiteApply
 *   (mask 不接=None) 且不接任何 RS pipe/采样器。同一 MODEL 两路重复挂会被机械拒绝（preflight 已核）。
 * - 不接 RSCameraControl（计划 §3.2）；不接 Interaction（spec rs_routing.interaction）。
 * - R 组按 T4 README §4.3 冻结形状 + rs-img2img.patch 的实测 INPUT_TYPES：
 *   YugangRSMaskedImg2Img(model, clip, vae, character_pipe, prompt, negative_prompt, width,
 *   height, seed, steps, cfg, sampler_name, scheduler, denoise | latent, noise_mask,
 *   prompt_syntax, region_feather…, layout_method)；YugangMaskCropTransform(stitcher,
 *   mask_owner_a, mask_owner_b, mask_gray) → (owner_a_crop, owner_b_crop, gray_crop,
 *   transform_json)。R3 的 crop 空间 pipe 用 RSMultiCharacterMask(region_mask=owner_*_crop)
 *   而非 Position box——T4 接口写明 pipe 可用「box/region_mask 归一化到 crop」，region_mask
 *   是 glue 节点直接输出，避免在图里伪造运行时才存在的 crop 坐标。
 * - P 组 core LoraLoader（lora_name/strength_model/strength_clip），不用
 *   AnimaLoRARemapTagLoader、无 28→52 remap、无超分。
 * - scene_json 内嵌**真实文件内容**（build.ts 先经 structure.readVerified 核 sha 再读），
 *   graph_hash 因此绑定 scene 字节；不用占位符/替换标记。
 *
 * graph_hash = sha256(canonicalStringify(graph) 的 UTF-8 字节) = 写盘实字节（build.ts 写盘
 * 用的正是同一 canonicalStringify 输出）。节点 id 每图从 "1" 顺序分配，形状一致 → 字节一致
 * （P-DC 复用的判定前提）。
 */
import { createHash } from "node:crypto";

export type GraphNode = { class_type: string; inputs: Record<string, unknown> };
export type Graph = Record<string, GraphNode>;

export interface BuiltGraph {
  graph: Graph;
  imageNodes: string[];    // SaveImage 节点 id（output_contract.image_node_ids）
  metadataNodes: string[]; // YugangStudyMetadata 节点 id（output_contract.metadata_node_ids）
}

export interface Box { x: number; y: number; width: number; height: number }

/** 确定性序列化：对象键递归排序；数组保序。写盘与 hash 用同一函数。 */
export function canonicalStringify(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalStringify).join(",")}]`;
  const obj = value as Record<string, unknown>;
  return `{${Object.keys(obj).sort().map((k) => `${JSON.stringify(k)}:${canonicalStringify(obj[k])}`).join(",")}}`;
}

export function sha256Bytes(b: Buffer | string): string {
  return createHash("sha256").update(b).digest("hex");
}

/** 结构/父图文件 → 隔离实例 input 上传名（每 job 隔离，不共享文件名）。 */
export function uploadName(jobId: string, logical: string): string {
  return `yugang-study__${jobId}__${logical}.png`;
}

// ---------------------------------------------------------------------------

type Ref = [string, number];
const ref = (id: string, slot = 0): Ref => [id, slot];

function mk(g: Graph): (classType: string, inputs: Record<string, unknown>) => string {
  let n = 0;
  return (classType, inputs) => {
    n += 1;
    g[String(n)] = { class_type: classType, inputs };
    return String(n);
  };
}

const SAMPLER_FIXED = { steps: 30, cfg: 4.0, sampler_name: "euler_ancestral", scheduler: "sgm_uniform" } as const;

/** spec.fixed_parameters.rs_routing 的显式图内字段（requested 值；effective 由 generation_info 审计）。 */
function rsRoutingInputs(): Record<string, unknown> {
  return {
    region_feather: 0.04,
    initial_common_prior: 0.05,
    common_after_step3_boost: 0.1,
    initial_character_gain: 1.7,
    initial_spatial_separation: 0.9,
    boundary_hold_steps: 3,
    boundary_decrement: 0.2,
    layout_method: "regional",
  };
}

/**
 * The installed RS 1.1.3 node exposes ten required numbered slots even when
 * character_count is two.  Keep the unused slots explicit and disabled rather
 * than relying on UI defaults (which are enabled).
 */
function rsPromptInputs(regionalA: string, regionalB: string): Record<string, unknown> {
  const inputs: Record<string, unknown> = { character_count: 2 };
  for (let i = 1; i <= 10; i += 1) {
    inputs[`character${i}_enable`] = i <= 2;
    inputs[`character${i}_kind`] = "character";
  }
  inputs.character1 = regionalA;
  inputs.character2 = regionalB;
  return inputs;
}

function rsLoraInputs(loraA: string, loraB: string, weightA: number, weightB: number): Record<string, unknown> {
  const inputs: Record<string, unknown> = { character_count: 2 };
  for (let i = 1; i <= 10; i += 1) {
    inputs[`character${i}_lora`] = "None";
    inputs[`character${i}_lora_strength`] = 1.0;
    inputs[`character${i}_lora_clip_strength`] = 1.0;
  }
  inputs.character1_lora = loraA;
  inputs.character1_lora_strength = weightA;
  inputs.character1_lora_clip_strength = weightA;
  inputs.character2_lora = loraB;
  inputs.character2_lora_strength = weightB;
  inputs.character2_lora_clip_strength = weightB;
  inputs.lora_application_mode = "precision";
  return inputs;
}

function rsPositionInputs(boxA: Box, boxB: Box): Record<string, unknown> {
  const inputs: Record<string, unknown> = { character_count: 2 };
  for (let i = 1; i <= 10; i += 1) {
    inputs[`character${i}_geometry`] = "point";
    inputs[`character${i}_x`] = 0.5;
    inputs[`character${i}_y`] = 0.5;
    inputs[`character${i}_width`] = 0.4;
    inputs[`character${i}_height`] = 0.8;
  }
  inputs.character1_geometry = "box";
  inputs.character1_x = boxA.x;
  inputs.character1_y = boxA.y;
  inputs.character1_width = boxA.width;
  inputs.character1_height = boxA.height;
  inputs.character2_geometry = "box";
  inputs.character2_x = boxB.x;
  inputs.character2_y = boxB.y;
  inputs.character2_width = boxB.width;
  inputs.character2_height = boxB.height;
  return inputs;
}

function baseLoaders(add: (c: string, i: Record<string, unknown>) => string, unetName: string, clipName: string, vaeName: string):
  { model: string; clip: string; vae: string } {
  const model = add("UNETLoader", { unet_name: unetName, weight_dtype: "default" });
  // CLIPLoader 字段 = 生产已验证用法（同一 clip 实体、同一 type；preflight assets.clip 已机械核对
  // hidden 1024 与 unet cross_attn 输入维度一致）。不复用 V8 模板的模型名/采样参数。
  const clip = add("CLIPLoader", { clip_name: clipName, type: "stable_diffusion", device: "default" });
  const vae = add("VAELoader", { vae_name: vaeName });
  return { model, clip, vae };
}

function studyMetadata(add: (c: string, i: Record<string, unknown>) => string, jobId: string,
  parts: Array<{ key: "generation_info" | "scene_info" | "transform_json" | "falloff_info"; ref: Ref }>): string {
  const inputs: Record<string, unknown> = { label: jobId };
  for (const p of parts) inputs[p.key] = p.ref;
  return add("YugangStudyMetadata", inputs);
}

// ---------------------------------------------------------------------------
// RS 联合初采样（B0/B1/B2、H、pose_grid、W-RS）
// ---------------------------------------------------------------------------

export interface RsGraphOpts {
  jobId: string;
  method: "B0" | "B1" | "B2";
  commonPositive: string; negative: string;
  regionalA: string; regionalB: string;
  loraA: string; loraB: string;          // comfyRelativePath
  weightA: number; weightB: number;
  boxA: Box; boxB: Box;
  pose: { strength: number; start: number; end: number };
  sceneJson: string;                     // 真实文件内容（已过 sha 校验）
  ownerAUpload?: string; ownerBUpload?: string; // method=B2 必需
  seed: number;
  unetName: string; clipName: string; vaeName: string;
  width: number; height: number;
}

export function buildRsGraph(o: RsGraphOpts): BuiltGraph {
  const g: Graph = {};
  const add = mk(g);
  if (o.method === "B2" && (!o.ownerAUpload || !o.ownerBUpload))
    throw new Error(`job ${o.jobId}: B2 必须提供 owner 上传名（非矩形 union mask）`);

  const prompt = add("RSMultiCharacterPrompt", rsPromptInputs(o.regionalA, o.regionalB));
  // clip 强度按 spec w_weights「model/clip 默认联动」传同值；两份 LoRA 均 0 个 TE key，
  // clip 侧是已记录的空操作（manifest lora 证据），不谎称生效。
  const lora = add("RSMultiCharacterLoRA", {
    ...rsLoraInputs(o.loraA, o.loraB, o.weightA, o.weightB),
    building_pipe: ref(prompt),
  });
  const position = add("RSMultiCharacterPosition", {
    ...rsPositionInputs(o.boxA, o.boxB),
    building_pipe: ref(lora),
  });

  let pipe: Ref = ref(position);
  let sceneInfoRef: Ref | null = null;
  if (o.method !== "B0") {
    const pose3d = add("RSMultiCharacterPose3D", {
      scene_json: o.sceneJson,
      building_pipe: pipe,
      pose_control: "auto",
      pose_strength: o.pose.strength,
      pose_start: o.pose.start,
      pose_end: o.pose.end,
    });
    pipe = ref(pose3d);
    sceneInfoRef = ref(pose3d, 4);
    if (o.method === "B1") {
      // Pose3D 已把渲染轮廓写进两槽；B1 显式清除，保留 Position 的同一 box（计划 §2.1）。
      const m1 = add("RSMultiCharacterMask", { character_id: 1, enabled: false, margin: 0, threshold: 0.5, building_pipe: pipe });
      const m2 = add("RSMultiCharacterMask", { character_id: 2, enabled: false, margin: 0, threshold: 0.5, building_pipe: ref(m1) });
      pipe = ref(m2);
    } else {
      // B2：同投影来源的 owner 非矩形 union 覆盖（margin=0/threshold=0.5，spec box_derivation）。
      const imgA = add("LoadImage", { image: o.ownerAUpload });
      const maskA = add("ImageToMask", { image: ref(imgA), channel: "red" });
      const m1 = add("RSMultiCharacterMask", { character_id: 1, enabled: true, margin: 0, threshold: 0.5, building_pipe: pipe, mask: ref(maskA) });
      const imgB = add("LoadImage", { image: o.ownerBUpload });
      const maskB = add("ImageToMask", { image: ref(imgB), channel: "red" });
      const m2 = add("RSMultiCharacterMask", { character_id: 2, enabled: true, margin: 0, threshold: 0.5, building_pipe: ref(m1), mask: ref(maskB) });
      pipe = ref(m2);
    }
  }
  const finalize = add("RSMultiCharacterFinalize", { building_pipe: pipe });
  const base = baseLoaders(add, o.unetName, o.clipName, o.vaeName);
  const sampler = add("RSMultiCharacterSampler", {
    model: ref(base.model), clip: ref(base.clip), vae: ref(base.vae),
    character_pipe: ref(finalize),
    prompt: o.commonPositive, negative_prompt: o.negative,
    width: o.width, height: o.height,
    seed: o.seed,
    ...SAMPLER_FIXED,
    webp_quality: 90,
    autosave: false, save_format: "PNG",
    prompt_syntax: "ComfyUI",
    ...rsRoutingInputs(),
  });
  const save = add("SaveImage", { images: ref(sampler, 0), filename_prefix: `yugang-study/${o.jobId}` });
  const metaParts: Array<{ key: "generation_info" | "scene_info" | "transform_json"; ref: Ref }> =
    [{ key: "generation_info", ref: ref(sampler, 3) }];
  if (sceneInfoRef) metaParts.push({ key: "scene_info", ref: sceneInfoRef });
  const meta = studyMetadata(add, o.jobId, metaParts);
  return { graph: g, imageNodes: [save], metadataNodes: [meta] };
}

// ---------------------------------------------------------------------------
// W-S 单人（core 直采，无 RS、无姿态）
// ---------------------------------------------------------------------------

export interface SoloGraphOpts {
  jobId: string; characterKey: string;
  positive: string; negative: string;
  seed: number; weight: number;
  unetName: string; clipName: string; vaeName: string; loraName: string;
  width: number; height: number;
}

export function buildSoloGraph(o: SoloGraphOpts): BuiltGraph {
  const g: Graph = {};
  const add = mk(g);
  const base = baseLoaders(add, o.unetName, o.clipName, o.vaeName);
  const lora = add("LoraLoader", {
    model: ref(base.model), clip: ref(base.clip),
    lora_name: o.loraName, strength_model: o.weight, strength_clip: o.weight,
  });
  const pos = add("CLIPTextEncode", { text: o.positive, clip: ref(lora, 1) });
  const neg = add("CLIPTextEncode", { text: o.negative, clip: ref(lora, 1) });
  const latent = add("EmptySD3LatentImage", { width: o.width, height: o.height, batch_size: 1 });
  const sampler = add("KSampler", {
    model: ref(lora, 0), positive: ref(pos), negative: ref(neg), latent_image: ref(latent),
    seed: o.seed, ...SAMPLER_FIXED, denoise: 1.0,
  });
  const decode = add("VAEDecode", { samples: ref(sampler), vae: ref(base.vae) });
  const save = add("SaveImage", { images: ref(decode), filename_prefix: `yugang-study/${o.jobId}` });
  return { graph: g, imageNodes: [save], metadataNodes: [] };
}

// ---------------------------------------------------------------------------
// W-G 全局共同加载（core LoraLoader + 原生 LLLite 一次 + 普通 KSampler，无 RS 路由）
// ---------------------------------------------------------------------------

export interface WgGraphOpts {
  jobId: string;
  commonPositive: string; negative: string;
  regionalA: string; regionalB: string;
  seed: number;
  /** DC: {A,B} 两文件独立权重；QG: {file} 单文件整体权重（spec w_g.QG，不伪造异权等价组）。 */
  weights: Record<string, number>;
  unetName: string; clipName: string; vaeName: string;
  loraA: string; loraB: string;
  poseName: string; poseStrength: number; poseStart: number; poseEnd: number;
  sceneJson: string;
  width: number; height: number;
}

export function buildWgGraph(o: WgGraphOpts): BuiltGraph {
  const g: Graph = {};
  const add = mk(g);
  const base = baseLoaders(add, o.unetName, o.clipName, o.vaeName);

  // 全局链：QG 只有文件级权重（同文件不具两个可独立全局加权参数）；DC 两不同文件各一次。
  let steps: Array<{ lora: string; weight: number }>;
  if (o.weights["file"] !== undefined) {
    if (o.loraA !== o.loraB) throw new Error(`job ${o.jobId}: file 级权重仅适用于同文件 pair（QG）`);
    steps = [{ lora: o.loraA, weight: o.weights["file"]! }];
  } else {
    if (o.weights["A"] === undefined || o.weights["B"] === undefined)
      throw new Error(`job ${o.jobId}: W-G 缺 A/B 权重`);
    if (o.loraA === o.loraB)
      throw new Error(`job ${o.jobId}: 同文件 pair 不允许 A/B 独立全局权重（spec w_g.QG）；应走 file 级`);
    steps = [{ lora: o.loraA, weight: o.weights["A"]! }, { lora: o.loraB, weight: o.weights["B"]! }];
  }
  let modelRef: Ref = ref(base.model);
  let clipRef: Ref = ref(base.clip);
  for (const s of steps) {
    const n = add("LoraLoader", { model: modelRef, clip: clipRef, lora_name: s.lora, strength_model: s.weight, strength_clip: s.weight });
    modelRef = ref(n, 0); clipRef = ref(n, 1);
  }

  // 原生 2B LLLite 一次：与 B 组同一 scene_json 经 Pose3D 现场渲染 pose_image（不接 building_pipe、
  // 不接任何 RS 采样器）；AnimaLLLiteApply mask 不接=None（spec pose_lllite）。
  const pose3d = add("RSMultiCharacterPose3D", {
    scene_json: o.sceneJson,
    pose_control: "auto",
    pose_strength: o.poseStrength, pose_start: o.poseStart, pose_end: o.poseEnd,
  });
  const patch = add("ModelPatchLoader", { name: o.poseName });
  const patched = add("AnimaLLLiteApply", {
    model: modelRef, model_patch: ref(patch),
    image: ref(pose3d, 5),
    strength: o.poseStrength, start_percent: o.poseStart, end_percent: o.poseEnd,
  });
  const positive = `${o.commonPositive}, ${o.regionalA}, ${o.regionalB}`;
  const pos = add("CLIPTextEncode", { text: positive, clip: clipRef });
  const neg = add("CLIPTextEncode", { text: o.negative, clip: clipRef });
  const latent = add("EmptySD3LatentImage", { width: o.width, height: o.height, batch_size: 1 });
  const sampler = add("KSampler", {
    model: ref(patched), positive: ref(pos), negative: ref(neg), latent_image: ref(latent),
    seed: o.seed, ...SAMPLER_FIXED, denoise: 1.0,
  });
  const decode = add("VAEDecode", { samples: ref(sampler), vae: ref(base.vae) });
  const save = add("SaveImage", { images: ref(decode), filename_prefix: `yugang-study/${o.jobId}` });
  const meta = studyMetadata(add, o.jobId, [{ key: "scene_info", ref: ref(pose3d, 4) }]);
  return { graph: g, imageNodes: [save], metadataNodes: [meta] };
}

// ---------------------------------------------------------------------------
// P1/P2 外观 pass（core LoraLoader；denoise 0.25；原生分辨率；无 remap/超分）
// ---------------------------------------------------------------------------

export interface PassGraphOpts {
  jobId: string; variant: "P1" | "P2";
  parentUploadName: string;
  commonPositive: string; negative: string;
  regionalA: string; regionalB: string;
  loraA: string; loraB: string; weight: number;
  denoise: number; seed: number;
  unetName: string; clipName: string; vaeName: string;
  width: number; height: number;
}

export function buildPassGraph(o: PassGraphOpts): BuiltGraph {
  const g: Graph = {};
  const add = mk(g);
  // P1 = 唯一 (文件,权重) 各一次（槽序 A→B）；P2 = 逐角色链式（QG 同文件出现两次）。
  // DC 两者链相同 → canonical 字节相同 → graph_hash 相等 → spec reuse_rules P-DC-identical。
  const perSlot = [{ lora: o.loraA, weight: o.weight }, { lora: o.loraB, weight: o.weight }];
  const chain = o.variant === "P1"
    ? perSlot.filter((s, i) => perSlot.findIndex((p) => p.lora === s.lora && p.weight === s.weight) === i)
    : perSlot;
  const base = baseLoaders(add, o.unetName, o.clipName, o.vaeName);
  let modelRef: Ref = ref(base.model);
  let clipRef: Ref = ref(base.clip);
  for (const s of chain) {
    const n = add("LoraLoader", { model: modelRef, clip: clipRef, lora_name: s.lora, strength_model: s.weight, strength_clip: s.weight });
    modelRef = ref(n, 0); clipRef = ref(n, 1);
  }
  const positive = `${o.commonPositive}, ${o.regionalA}, ${o.regionalB}`;
  const pos = add("CLIPTextEncode", { text: positive, clip: clipRef });
  const neg = add("CLIPTextEncode", { text: o.negative, clip: clipRef });
  const parent = add("LoadImage", { image: o.parentUploadName });
  const encoded = add("VAEEncode", { pixels: ref(parent), vae: ref(base.vae) });
  const sampler = add("KSampler", {
    model: modelRef, positive: ref(pos), negative: ref(neg), latent_image: ref(encoded),
    seed: o.seed, ...SAMPLER_FIXED, denoise: o.denoise,
  });
  const decode = add("VAEDecode", { samples: ref(sampler), vae: ref(base.vae) });
  const save = add("SaveImage", { images: ref(decode), filename_prefix: `yugang-study/${o.jobId}` });
  return { graph: g, imageNodes: [save], metadataNodes: [] };
}

// ---------------------------------------------------------------------------
// R1/R2/R3 接触组修复（T4 README §4.3 冻结形状）
// ---------------------------------------------------------------------------

export interface RepairGraphOpts {
  jobId: string; method: "R1" | "R2" | "R3";
  denoise: number;
  parentUploadName: string;
  /** repair-v2 局部接触组三件（T2c repair_index；全画布 raster，crop 窗口/上下文/胶水源）。 */
  coreUploadName: string; supportUploadName: string; contextUploadName: string;
  /** 原 structure_index 的 native gray：保留来源、仍经 glue 调用 1 消费，但不接最终 noise_mask。 */
  grayUploadName: string;
  ownerAUploadName: string; ownerBUploadName: string;
  commonPositive: string; negative: string;
  regionalA: string; regionalB: string;
  loraA: string; loraB: string; weightA: number; weightB: number;
  seed: number;
  unetName: string; clipName: string; vaeName: string;
  crop: { mask_blend_pixels: number; downscale_algorithm: string; upscale_algorithm: string };
  width: number; height: number; // 修复 crop 画布 768×768（主输出 = 贴回后的父画布）
  /** §8.1 冻结：Chebyshev 外环 = round(min(H,W)*ring_fraction)（768 → 61px）。 */
  ringFraction?: number;
}

/** 冻结 crop 参数（spec crop_stitch + T4 §4.3；R1/R2/R3 全同，同一 STITCHER 同一贴回 alpha）。 */
function cropInputs(o: RepairGraphOpts): Record<string, unknown> {
  return {
    downscale_algorithm: o.crop.downscale_algorithm,
    upscale_algorithm: o.crop.upscale_algorithm,
    preresize: false,
    preresize_mode: "ensure minimum resolution",
    preresize_min_width: 1024, preresize_min_height: 1024,
    preresize_max_width: 4096, preresize_max_height: 4096,
    mask_fill_holes: false,
    mask_expand_pixels: 0,
    mask_invert: false,
    // mask_blend_pixels：T1 spec 未冻结（T4 README §4.3 移交 T3）；取节点缺省 32，全 run 一致，
    // 记录在 manifest.execution.mechanical_choices。
    mask_blend_pixels: o.crop.mask_blend_pixels,
    mask_hipass_filter: 0,
    extend_for_outpainting: false,
    extend_up_factor: 1.0, extend_down_factor: 1.0, extend_left_factor: 1.0, extend_right_factor: 1.0,
    context_from_mask_extend_factor: 1.2,
    output_resize_to_target_size: true,
    output_target_width: o.width,
    output_target_height: o.height,
    output_padding: "32", // 节点 combo 是字符串枚举
    device_mode: "cpu (compatible)",
  };
}

export function buildRepairGraph(o: RepairGraphOpts): BuiltGraph {
  const g: Graph = {};
  const add = mk(g);
  const ringFraction = o.ringFraction ?? 0.08;

  // ---- 公共前段：父图 + repair-v2 局部 support/context 定 crop 窗口 ----
  const parent = add("LoadImage", { image: o.parentUploadName });
  const supportImg = add("LoadImage", { image: o.supportUploadName });
  const supportMask = add("ImageToMask", { image: ref(supportImg), channel: "red" });
  const contextImg = add("LoadImage", { image: o.contextUploadName });
  const contextMask = add("ImageToMask", { image: ref(contextImg), channel: "red" });
  const coreImg = add("LoadImage", { image: o.coreUploadName });
  const coreMask = add("ImageToMask", { image: ref(coreImg), channel: "red" });
  const crop = add("InpaintCropImproved", {
    image: ref(parent),
    ...cropInputs(o),
    mask: ref(supportMask),
    optional_context_mask: ref(contextMask),
  });
  const ownerAImg = add("LoadImage", { image: o.ownerAUploadName });
  const ownerAMask = add("ImageToMask", { image: ref(ownerAImg), channel: "red" });
  const ownerBImg = add("LoadImage", { image: o.ownerBUploadName });
  const ownerBMask = add("ImageToMask", { image: ref(ownerBImg), channel: "red" });
  const grayImg = add("LoadImage", { image: o.grayUploadName });
  const grayMask = add("ImageToMask", { image: ref(grayImg), channel: "red" });
  // glue 调用 1（T4 原胶水不变）：真实 owner_a/b + native gray 同 STITCHER 变换。
  // gray_crop_native 保留来源、不接最终 noise_mask（§8.1：native gray 8% 未经证实，不冒充）。
  const glue = add("YugangMaskCropTransform", {
    stitcher: ref(crop, 0),
    mask_owner_a: ref(ownerAMask),
    mask_owner_b: ref(ownerBMask),
    mask_gray: ref(grayMask),
  });
  const ownerACrop = ref(glue, 0);
  const ownerBCrop = ref(glue, 1);
  const grayCropNative = ref(glue, 2);
  const transformJson = ref(glue, 3);
  // glue 调用 2（同一 STITCHER）：把 repair-v2 原画布 core/support 映射进 crop 空间。
  // core/support 是二值域 → 走 owner 通道（nearest + clamp，忠实二值）；mask_gray 通道
  // 复用 native gray（required 输入必须接；其输出在本调用中不消费）。
  const glue2 = add("YugangMaskCropTransform", {
    stitcher: ref(crop, 0),
    mask_owner_a: ref(coreMask),
    mask_owner_b: ref(supportMask),
    mask_gray: ref(grayMask),
  });
  const coreCrop = ref(glue2, 0);
  const supportCrop = ref(glue2, 1);
  // T4c：crop 空间 core/support → uniform_mask[0] / gray_mask[1]（core 平台 + Chebyshev 外环
  // round(min(H,W)*ring_fraction)，768→61px）/ falloff_info[2]。uniform = 最终 gray>0，
  // 保证 R1/R2/R3 可编辑支撑一致（§8.1 裁剪空间噪声图）。
  const falloff = add("YugangRepairMaskFalloff", {
    core: coreCrop,
    support: supportCrop,
    ring_fraction: ringFraction,
  });
  const uniformMask = ref(falloff, 0);
  const grayFinal = ref(falloff, 1);
  const falloffInfo = ref(falloff, 2);

  const base = baseLoaders(add, o.unetName, o.clipName, o.vaeName);
  const positive = `${o.commonPositive}, ${o.regionalA}, ${o.regionalB}`;
  const encoded = add("VAEEncode", { pixels: ref(crop, 1), vae: ref(base.vae) });

  let modelRef: Ref = ref(base.model);
  let clipRef: Ref = ref(base.clip);

  if (o.method === "R1" || o.method === "R2") {
    // 全局 LoRA：同文件只加载一次（唯一 (文件,权重) 聚合，槽序 A→B）；角色提示仍两份（merged positive）。
    const steps = [{ lora: o.loraA, weight: o.weightA }];
    if (o.loraB !== o.loraA || o.weightB !== o.weightA) steps.push({ lora: o.loraB, weight: o.weightB });
    for (const s of steps) {
      const n = add("LoraLoader", { model: modelRef, clip: clipRef, lora_name: s.lora, strength_model: s.weight, strength_clip: s.weight });
      modelRef = ref(n, 0); clipRef = ref(n, 1);
    }
  }
  if (o.method === "R2" || o.method === "R3") {
    // DifferentialDiffusion strength=1：灰度变化由 latent noise_mask 提供（spec differential_diffusion）。
    const dd = add("DifferentialDiffusion", { model: modelRef, strength: 1 });
    modelRef = ref(dd);
  }
  const pos = add("CLIPTextEncode", { text: positive, clip: clipRef });
  const neg = add("CLIPTextEncode", { text: o.negative, clip: clipRef });

  let sampleOut: Ref;
  let sampleOutIsImage = false; // R3 的 YugangRSMaskedImg2Img output0 已是 IMAGE（节点内 vae.decode）
  let genInfoRef: Ref | null = null;
  if (o.method === "R3") {
    // crop 画布 pipe：两角色槽不因文件相同而合并（spec repair_lora.R3）；region_mask 直接用
    // glue 调用 1 的 crop 空间真实 owner 输出；无 Position（mask 覆盖 point/box，builder 语义允许）。
    const rp = add("RSMultiCharacterPrompt", rsPromptInputs(o.regionalA, o.regionalB));
    const rl = add("RSMultiCharacterLoRA", {
      ...rsLoraInputs(o.loraA, o.loraB, o.weightA, o.weightB),
      building_pipe: ref(rp),
    });
    const m1 = add("RSMultiCharacterMask", { character_id: 1, enabled: true, margin: 0, threshold: 0.5, building_pipe: ref(rl), mask: ownerACrop });
    const m2 = add("RSMultiCharacterMask", { character_id: 2, enabled: true, margin: 0, threshold: 0.5, building_pipe: ref(m1), mask: ownerBCrop });
    const fin = add("RSMultiCharacterFinalize", { building_pipe: ref(m2) });
    // 修复起点走显式 VAEEncode+SetLatentNoiseMask（spec repair_encode），latent 进节点；
    // noise_mask 再显式接 Falloff 最终 gray（节点记 input_over_latent_dict；灰度必须配 DD——已接）。
    const masked = add("SetLatentNoiseMask", { samples: ref(encoded), mask: grayFinal });
    const sampler = add("YugangRSMaskedImg2Img", {
      model: modelRef, clip: ref(base.clip), vae: ref(base.vae),
      character_pipe: ref(fin),
      prompt: o.commonPositive, negative_prompt: o.negative,
      width: o.width, height: o.height,
      seed: o.seed, ...SAMPLER_FIXED, denoise: o.denoise,
      latent: ref(masked),
      noise_mask: grayFinal,
      prompt_syntax: "ComfyUI",
      ...rsRoutingInputs(),
    });
    sampleOut = ref(sampler, 0);
    sampleOutIsImage = true; // 修复①：output0 = IMAGE，直接 Stitch，不再过 VAEDecode
    genInfoRef = ref(sampler, 3);
  } else {
    // R1：uniform_mask（Falloff[0] = 最终 gray>0 的二值支撑），无 DD——修复④：不再用
    // ThresholdMask(native gray) 缩小可编辑域；R2：Falloff gray_mask 原样进 SetLatentNoiseMask。
    if (o.method === "R1" && g[modelRef[0]]?.class_type === "DifferentialDiffusion")
      throw new Error("R1 不允许接 DD");
    const noiseMask: Ref = o.method === "R1" ? uniformMask : grayFinal;
    const masked = add("SetLatentNoiseMask", { samples: ref(encoded), mask: noiseMask });
    const sampler = add("KSampler", {
      model: modelRef, positive: ref(pos), negative: ref(neg), latent_image: ref(masked),
      seed: o.seed, ...SAMPLER_FIXED, denoise: o.denoise,
    });
    sampleOut = ref(sampler, 0); // LATENT → 需要 VAEDecode
  }

  // R1/R2：latent → VAEDecode → IMAGE；R3：output0 已是 IMAGE。主输出 = 贴回后的父画布（1024×768）。
  const stitched = sampleOutIsImage ? sampleOut : ref(add("VAEDecode", { samples: sampleOut, vae: ref(base.vae) }));
  const stitch = add("InpaintStitchImproved", { stitcher: ref(crop, 0), inpainted_image: stitched });
  const save = add("SaveImage", { images: ref(stitch), filename_prefix: `yugang-study/${o.jobId}` });
  const metaParts: Array<{ key: "generation_info" | "scene_info" | "transform_json" | "falloff_info"; ref: Ref }> =
    [{ key: "transform_json", ref: transformJson }, { key: "falloff_info", ref: falloffInfo }];
  if (genInfoRef) metaParts.push({ key: "generation_info", ref: genInfoRef });
  const meta = studyMetadata(add, o.jobId, metaParts);
  // native gray_crop 仅保留来源审计（不接采样）；引用一次防未使用告警并方便审图定位。
  void grayCropNative;
  return { graph: g, imageNodes: [save], metadataNodes: [meta] };
}
