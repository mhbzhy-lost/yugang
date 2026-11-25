/**
 * build.ts —— build 编排：真实绑定 + 图写盘 + manifest（schema_version=anima-interaction-manifest.v1）。
 *
 * 硬门（缺一即拒绝，输出具体缺项清单，绝不产假图/假 hash）：
 *   1. spec.json 存在、stage-seed 冻结示例自检通过（loadSpec 内）；
 *   2. 角色源表 sha256 与 spec 冻结一致，且 4 角色 inject/lora 与活表逐字核对（characters.ts）；
 *   3. preflight.json 存在、8 资产键带实测 64hex sha256 + comfyRelativePath（assetBinding）；
 *   4. 正负地板已冻结（floor.ts；--floor 文件只接受逐字确认，不接受不同文本）；
 *   5. 全量 build 另需结构索引就绪（auditStructure 逐文件实字节 sha 核对）。
 *
 * 两种产物形态：
 *   - 完整 build：run-root/manifest.json + graphs/**（全部 new 行；门 5 必过）；
 *   - 分批 build（--group W-S --seed … --weight …）：run-root/stages/w-s-smoke/{manifest.json,graphs/**}，
 *     参数与预定全矩阵完全一致、job_id 保持一致；selected count 如实报告，不伪称完整 F1。
 *     W-S 是纯文本 core 管线（无姿态 patch、无结构消费），只依赖门 1–4。
 *
 * input_files 冻结合同（主会话 2026-11-11）：
 *   item = { target: <与 LoadImage image 字段完全相等的扁平安全名，无 subfolder>,
 *            source: { kind: 'structure'|'parent_job'|'run_root_file',
 *                      path: <文件型：绝对或相对 run-root>, job_id: <parent 时上游 ID>,
 *                      output_node_id: <parent 时上游 SaveImage 节点 id>,
 *                      sha256: <文件型真实 hash；parent 不预填 = null> } }
 *   reuse 行 input_files=[]（不上传；runner 直接引用源 job 产物）。
 *
 * P 复用：仅 exact graph hash（canonicalStringify 字节 sha256）相同才翻 reuse，否则保留上限 16。
 * revision 保护：目标 manifest.json 已存在且 spec/preflight/structure 三 hash 任一不同 → 拒绝覆盖，
 * 要求新 revision 目录；相同 → 允许重建（同一 revision 的幂等重跑）。
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, relative, resolve } from "node:path";
import {
  ASSET_KEYS, assetBinding, buildCommonPrompt, buildNegative, buildRegional, buildSoloPositive,
  loadPreflight, loadSpec, loraOf, resolvePromptFloor, sha256Bytes,
  type AssetBinding, type Preflight, type PromptFloorText, type Spec,
} from "./floor.ts";
import { assertCounts, expandMatrix, type MatrixRow } from "./matrix.ts";
import {
  auditStructure, loadStructureIndex, readVerified, StructureNotReadyError,
  type FileRef, type StructureCase, type StructureIndex,
} from "./structure.ts";
import {
  buildPassGraph, buildRepairGraph, buildRsGraph, buildSoloGraph, buildWgGraph,
  canonicalStringify, uploadName, type BuiltGraph,
} from "./graphs.ts";
import {
  auditRepairDeps, FALLOFF_NODE_CLASS, resolveRepairFile, RING_FRACTION,
  type RepairDepsState,
} from "./repair.ts";

export const MANIFEST_SCHEMA = "anima-interaction-manifest.v1";

export interface BuildContext {
  repoRoot: string;
  runRoot: string;
  spec: Spec;
  specBytes: Buffer;
  preflight: Preflight;
  preflightBytes: Buffer;
  assets: Record<string, AssetBinding>;
  floorText: PromptFloorText;
}

export interface StageSelection {
  group: "W-S";
  seed?: number;
  weight?: number;
}

export interface BuildOptions {
  repoRoot: string;
  runRoot: string;
  dryRun?: boolean;
  floorOverride?: string;
  stage?: StageSelection;
}

export interface BuildResult {
  ok: boolean;
  missing: string[];
  manifestPath?: string;
  counts?: Record<string, unknown>;
  selection?: Record<string, unknown>;
  graphsWritten?: number;
  dryRun?: boolean;
  rBlocked?: { rows: number; missing: string[] };
}

// ---------------------------------------------------------------------------
// 上下文载入（门 1–4）
// ---------------------------------------------------------------------------

export function loadContext(repoRoot: string, runRoot: string, floorOverride?: string): BuildContext {
  const { spec, raw: specBytes } = loadSpec(runRoot, repoRoot);
  const { preflight, raw: preflightBytes } = loadPreflight(runRoot);

  const assets: Record<string, AssetBinding> = {};
  for (const key of ASSET_KEYS) assets[key] = assetBinding(preflight, key);

  // 角色源表一致性：冻结 sha vs 活表 sha vs 活表 inject/lora（characters.ts = 唯一事实源实现）。
  const tablePath = join(repoRoot, "src", "tools", "tags", "ai-girls.json");
  const liveSha = sha256Bytes(readFileSync(tablePath));
  if (liveSha !== spec.provenance.character_source_sha256)
    throw new Error(`角色源表已改变：spec 冻结 ${spec.provenance.character_source_sha256}，当前 ${liveSha}（${tablePath}）。按 spec 规则停跑并建新 run，不继续。`);

  const floorText = resolvePromptFloor(floorOverride);
  return { repoRoot, runRoot, spec, specBytes, preflight, preflightBytes, assets, floorText };
}

/** 活表逐角色核对（延迟到需要时做：import 生产 characters.ts，纯读取无副作用）。 */
async function verifyCharactersAgainstLiveTable(ctx: BuildContext): Promise<string[]> {
  const missing: string[] = [];
  const mod = await import(join(ctx.repoRoot, "src", "tools", "characters.ts")) as
    { loraBook: (key: string) => { file: string; inject: string; weight: number } | undefined };
  for (const c of ctx.spec.characters) {
    const live = mod.loraBook(c.key);
    if (!live) { missing.push(`角色 ${c.key}: 活表 loraBook 无此 key`); continue; }
    if (live.inject !== c.inject) missing.push(`角色 ${c.key}: inject 与活表不一致（spec 快照过期）`);
    if (live.file !== c.lora_name) missing.push(`角色 ${c.key}: lora_name 与活表不一致（${live.file} vs ${c.lora_name}）`);
    if (live.weight !== c.weight_baseline) missing.push(`角色 ${c.key}: weight_baseline 与活表不一致（${live.weight} vs ${c.weight_baseline}）`);
    const bound = loraOf(ctx.spec, c.key); // preflight 已载入 → 实体核对（名称一致 + 64hex sha）
    if (bound.comfyRelativePath !== c.lora_name)
      missing.push(`角色 ${c.key}: preflight 实体名 ${bound.comfyRelativePath} != 源表 ${c.lora_name}`);
  }
  return missing;
}

// ---------------------------------------------------------------------------
// 每行 → 图 + input_files（纯函数；不写盘）
// ---------------------------------------------------------------------------

interface InputFile {
  target: string;
  source: {
    kind: "structure" | "parent_job" | "run_root_file";
    path?: string;
    job_id?: string;
    output_node_id?: string;
    sha256?: string | null;
  };
}

interface GraphPlan {
  row: MatrixRow;
  built: BuiltGraph;
  bytes: Buffer;              // canonicalStringify 的 UTF-8 字节 = 写盘字节
  graphHash: string;
  inputFiles: InputFile[];
  structureProvenance: Record<string, { path: string; sha256: string } | null>;
  prompts: Record<string, string | null>;
  width: number;
  height: number;
  assetHashes: Record<string, string>;
}

function relToRunRoot(runRoot: string, abs: string): string {
  const rel = relative(runRoot, abs);
  return rel.startsWith("..") ? abs : rel;
}

function structureInput(ctx: BuildContext, row: MatrixRow, logical: string, f: { path: string; sha256: string }): InputFile {
  // 修复③：runner 合同 source.path = run-root 相对。索引里的 path 是 repo-root 相对——
  // 先从 REPO_ROOT 定位真实文件（audit 已核实字节 sha），再转 run-root 相对；不猜路径。
  const abs = f.path.startsWith("/") ? f.path : join(ctx.repoRoot, f.path);
  return { target: uploadName(row.job_id, logical),
    source: { kind: "structure", path: relToRunRoot(ctx.runRoot, abs), sha256: f.sha256 } };
}

export function planGraph(ctx: BuildContext, struct: StructureIndex | null, row: MatrixRow,
  plans: Map<string, GraphPlan>, repair: RepairDepsState | null): GraphPlan {
  const spec = ctx.spec;
  const A = ctx.assets;
  const negative = buildNegative(ctx.floorText);
  const baseHashes = { unet: A["unet"]!.sha256, clip: A["clip"]!.sha256, vae: A["vae"]!.sha256 };
  const canvas = { width: spec.canvas.width, height: spec.canvas.height };

  const finish = (built: BuiltGraph, inputFiles: InputFile[], width: number, height: number,
    assetHashes: Record<string, string>, prompts: Record<string, string | null>,
    structureProvenance: GraphPlan["structureProvenance"]): GraphPlan => {
    const bytes = Buffer.from(canonicalStringify(built.graph), "utf8");
    return { row, built, bytes, graphHash: sha256Bytes(bytes), inputFiles, structureProvenance, prompts, width, height, assetHashes };
  };

  // ---- W-S：纯文本 core 管线，无结构/姿态消费 ----
  if (row.group === "W-S") {
    const key = row.case_id.slice("SOLO-".length);
    const positive = buildSoloPositive(spec, key);
    const lora = loraOf(spec, key);
    const built = buildSoloGraph({
      jobId: row.job_id, characterKey: key, positive, negative,
      seed: row.stage_seed, weight: row.weights["lora"]!,
      unetName: A["unet"]!.comfyRelativePath, clipName: A["clip"]!.comfyRelativePath,
      vaeName: A["vae"]!.comfyRelativePath, loraName: lora.comfyRelativePath,
      width: canvas.width, height: canvas.height,
    });
    const loraKey = lora.assetRef.split("/").pop()!;
    return finish(built, [], canvas.width, canvas.height,
      { ...baseHashes, [loraKey]: A[loraKey]!.sha256 },
      { positive_public: positive, negative, slot_a: null, slot_b: null }, {});
  }

  // 以下各组都需要结构索引（T2b 真实渲染文件先消费再绑定；不重造几何）
  if (struct === null)
    throw new Error(`job ${row.job_id}（${row.group}）需要已渲染结构；结构索引未就绪`);
  const sc: StructureCase | undefined = struct.cases[row.structure_case];
  if (!sc) throw new Error(`结构索引缺 case ${row.structure_case}（job ${row.job_id}）`);
  if (sc.status !== "rendered")
    throw new Error(`job ${row.job_id}: 结构 case ${sc.case_id} status=${String(sc.status)}（要求 rendered；不消费占位/未渲染条目）`);
  const needFile = (name: string): FileRef => {
    const f = sc.files[name];
    if (!f) throw new Error(`job ${row.job_id}: 结构 case ${sc.case_id} 缺文件引用 ${name}`);
    return f;
  };
  const sceneRef = needFile("scene.json");
  const sceneContent = readVerified(struct, sceneRef, `${sc.case_id}.scene.json`, ctx.repoRoot).toString("utf8");
  const prov = (name: string): { path: string; sha256: string } | null => {
    const f = sc.files[name];
    return f ? { path: f.path, sha256: f.sha256 } : null;
  };

  const [pairId, action] = row.case_id.split("-") as [string, string];
  const inst = spec.semantics.pair.instances[pairId] as { A: string; B: string };
  const loraA = loraOf(spec, inst.A);
  const loraB = loraOf(spec, inst.B);
  const loraHashes: Record<string, string> = {};
  for (const l of [loraA, loraB]) loraHashes[l.assetRef.split("/").pop()!] = A[l.assetRef.split("/").pop()!]!.sha256;

  // ---- B / H / pose_grid / W-RS：RS 联合初采样 ----
  if (row.group === "B" || row.group === "H" || row.group === "pose_grid" || row.group === "W-RS") {
    const method = (row.group === "pose_grid" || row.group === "W-RS" ? "B2" : row.method) as "B0" | "B1" | "B2";
    const commonPositive = buildCommonPrompt(spec, pairId, action, row.framing);
    const regionalA = buildRegional(spec, inst.A, "A", action);
    const regionalB = buildRegional(spec, inst.B, "B", action);
    const poseMain = spec.fixed_parameters.pose_lllite.main as { strength: number; start: number; end: number };
    const consumesOwners = method === "B2";
    const built = buildRsGraph({
      jobId: row.job_id, method, commonPositive, negative, regionalA, regionalB,
      loraA: loraA.comfyRelativePath, loraB: loraB.comfyRelativePath,
      weightA: row.weights["A"]!, weightB: row.weights["B"]!,
      boxA: sc.boxes.owner_a, boxB: sc.boxes.owner_b,
      pose: {
        strength: row.weights["pose_strength"] ?? poseMain.strength,
        start: row.weights["pose_start"] ?? poseMain.start,
        end: row.weights["pose_end"] ?? poseMain.end,
      },
      sceneJson: sceneContent,
      ownerAUpload: consumesOwners ? uploadName(row.job_id, "owner_a") : undefined,
      ownerBUpload: consumesOwners ? uploadName(row.job_id, "owner_b") : undefined,
      seed: row.stage_seed,
      unetName: A["unet"]!.comfyRelativePath, clipName: A["clip"]!.comfyRelativePath,
      vaeName: A["vae"]!.comfyRelativePath,
      width: canvas.width, height: canvas.height,
    });
    const inputs: InputFile[] = [];
    if (consumesOwners) {
      inputs.push(structureInput(ctx, row, "owner_a", needFile("owner_a.png")));
      inputs.push(structureInput(ctx, row, "owner_b", needFile("owner_b.png")));
    }
    const assetHashes = { ...baseHashes, ...loraHashes };
    if (method !== "B0") assetHashes["pose_lllite"] = A["pose_lllite"]!.sha256;
    return finish(built, inputs, canvas.width, canvas.height, assetHashes,
      { positive_public: commonPositive, negative, slot_a: regionalA, slot_b: regionalB },
      { scene_json: prov("scene.json"), pose_image: prov("pose_image.png"),
        owner_a: consumesOwners ? null : prov("owner_a.png"), owner_b: consumesOwners ? null : prov("owner_b.png"),
        owner_a_full: prov("owner_a_full.png"), owner_b_full: prov("owner_b_full.png"),
        tail_union: sc.tail_union ?? null });
  }

  // ---- W-G：全局共同加载 + 原生 LLLite 一次 ----
  if (row.group === "W-G") {
    const commonPositive = buildCommonPrompt(spec, pairId, action, row.framing);
    const regionalA = buildRegional(spec, inst.A, "A", action);
    const regionalB = buildRegional(spec, inst.B, "B", action);
    const poseMain = spec.fixed_parameters.pose_lllite.main as { strength: number; start: number; end: number };
    const built = buildWgGraph({
      jobId: row.job_id, commonPositive, negative, regionalA, regionalB,
      seed: row.stage_seed, weights: row.weights,
      unetName: A["unet"]!.comfyRelativePath, clipName: A["clip"]!.comfyRelativePath,
      vaeName: A["vae"]!.comfyRelativePath,
      loraA: loraA.comfyRelativePath, loraB: loraB.comfyRelativePath,
      poseName: A["pose_lllite"]!.comfyRelativePath,
      poseStrength: poseMain.strength, poseStart: poseMain.start, poseEnd: poseMain.end,
      sceneJson: sceneContent,
      width: canvas.width, height: canvas.height,
    });
    return finish(built, [], canvas.width, canvas.height,
      { ...baseHashes, ...loraHashes, pose_lllite: A["pose_lllite"]!.sha256 },
      { positive_public: commonPositive, negative, slot_a: regionalA, slot_b: regionalB },
      { scene_json: prov("scene.json"), pose_image: prov("pose_image.png") });
  }

  // ---- R_calib / R_repeat：接触组修复（父图 = B2 同 case/seed） ----
  if (row.group === "R_calib" || row.group === "R_repeat") {
    const method = row.method.split("@")[0] as "R1" | "R2" | "R3";
    const parentJob = row.depends_on[0]!;
    const parentPlan = plans.get(parentJob);
    if (!parentPlan) throw new Error(`job ${row.job_id}: 父 job ${parentJob} 未构图（展开顺序错误或父行缺失）`);
    const commonPositive = buildCommonPrompt(spec, pairId, action, row.framing);
    const regionalA = buildRegional(spec, inst.A, "A", action);
    const regionalB = buildRegional(spec, inst.B, "B", action);
    // ---- R 接口修正（计划 §8.1）：core/support/context 一律取 T2c repair-v2 局部接触组；
    //      旧全身域不放行。native gray 保留来源（glue 调用 1 仍消费、provenance 记录），
    //      但不接最终 noise_mask（由 Falloff 在 crop 空间生成 uniform/gray）。
    if (!repair || !repair.ready || !repair.index)
      throw new Error(`job ${row.job_id}: R 依赖未就绪（repair-v2 索引 / ${FALLOFF_NODE_CLASS} 节点源），拒构 R 行；缺项见 counts.r_blocked_missing`);
    const rEntry = repair.index.cases[row.structure_case];
    if (!rEntry) throw new Error(`job ${row.job_id}: repair_index 缺 case ${row.structure_case}`);
    const rFile = (logical: "core" | "support" | "context"): { keyName: string; ref: { path: string; sha256: string } } => {
      const resolved = resolveRepairFile(rEntry, logical);
      if (!resolved) throw new Error(`job ${row.job_id}: repair_index case ${row.structure_case} 缺 ${logical}`);
      return resolved;
    };
    const coreF = rFile("core");
    const supportF = rFile("support");
    const contextF = rFile("context");
    const grayRef = needFile("gray.png");      // native gray：保留来源
    const ownerARef = needFile("owner_a.png");
    const ownerBRef = needFile("owner_b.png");
    const built = buildRepairGraph({
      jobId: row.job_id, method, denoise: row.weights["denoise"]!,
      parentUploadName: uploadName(row.job_id, "parent"),
      coreUploadName: uploadName(row.job_id, "repair_core"),
      supportUploadName: uploadName(row.job_id, "repair_support"),
      contextUploadName: uploadName(row.job_id, "repair_context"),
      grayUploadName: uploadName(row.job_id, "repair_gray"),
      ownerAUploadName: uploadName(row.job_id, "owner_a"),
      ownerBUploadName: uploadName(row.job_id, "owner_b"),
      commonPositive, negative, regionalA, regionalB,
      loraA: loraA.comfyRelativePath, loraB: loraB.comfyRelativePath,
      weightA: row.weights["A"]!, weightB: row.weights["B"]!,
      seed: row.stage_seed,
      unetName: A["unet"]!.comfyRelativePath, clipName: A["clip"]!.comfyRelativePath,
      vaeName: A["vae"]!.comfyRelativePath,
      crop: { mask_blend_pixels: 32, downscale_algorithm: "bilinear", upscale_algorithm: "bicubic" },
      width: spec.canvas.repair_local_target, height: spec.canvas.repair_local_target,
      ringFraction: RING_FRACTION,
    });
    const inputs: InputFile[] = [
      { target: uploadName(row.job_id, "parent"),
        source: { kind: "parent_job", job_id: parentJob, output_node_id: parentPlan.built.imageNodes[0], sha256: null } },
      structureInput(ctx, row, "repair_core", coreF.ref),
      structureInput(ctx, row, "repair_support", supportF.ref),
      structureInput(ctx, row, "repair_context", contextF.ref),
      structureInput(ctx, row, "repair_gray", grayRef),
      structureInput(ctx, row, "owner_a", ownerARef),
      structureInput(ctx, row, "owner_b", ownerBRef),
    ];
    // 修复②：主输出 = Stitch 贴回后的父画布 1024×768；内部修复 crop 画布仍是 768²（图内
    // crop target / Falloff ring / YugangRSMaskedImg2Img width·height 全部 768）。
    return finish(built, inputs, canvas.width, canvas.height,
      { ...baseHashes, ...loraHashes },
      { positive_public: commonPositive, negative, slot_a: regionalA, slot_b: regionalB },
      { scene_json: prov("scene.json"), native_gray: prov("gray.png"),
        repair_flags: sc.repair_flags ?? null, repair_params: sc.repair_params ?? null,
        repair_crop_canvas: { width: spec.canvas.repair_local_target, height: spec.canvas.repair_local_target },
        repair_v2: { index_sha256: repair.index.index_sha256,
          core_key: coreF.keyName, support_key: supportF.keyName, context_key: contextF.keyName,
          ring_fraction: RING_FRACTION, falloff_node: FALLOFF_NODE_CLASS,
          falloff_source_files: repair.falloffSourceFiles } });
  }

  // ---- P：外观 pass（父图 = B2 同 case/seed） ----
  if (row.group === "P") {
    const parentJob = row.depends_on[0]!;
    const parentPlan = plans.get(parentJob);
    if (!parentPlan) throw new Error(`job ${row.job_id}: 父 job ${parentJob} 未构图`);
    const commonPositive = buildCommonPrompt(spec, pairId, action, row.framing);
    const regionalA = buildRegional(spec, inst.A, "A", action);
    const regionalB = buildRegional(spec, inst.B, "B", action);
    const built = buildPassGraph({
      jobId: row.job_id, variant: row.method as "P1" | "P2",
      parentUploadName: uploadName(row.job_id, "parent"),
      commonPositive, negative, regionalA, regionalB,
      loraA: loraA.comfyRelativePath, loraB: loraB.comfyRelativePath,
      weight: 0.8, denoise: spec.fixed_parameters.p_pass.denoise, seed: row.stage_seed,
      unetName: A["unet"]!.comfyRelativePath, clipName: A["clip"]!.comfyRelativePath,
      vaeName: A["vae"]!.comfyRelativePath,
      width: canvas.width, height: canvas.height,
    });
    const inputs: InputFile[] = [
      { target: uploadName(row.job_id, "parent"),
        source: { kind: "parent_job", job_id: parentJob, output_node_id: parentPlan.built.imageNodes[0], sha256: null } },
    ];
    return finish(built, inputs, canvas.width, canvas.height, { ...baseHashes, ...loraHashes },
      { positive_public: commonPositive, negative, slot_a: regionalA, slot_b: regionalB }, {});
  }

  throw new Error(`job ${row.job_id}: 未知组 ${row.group}`);
}

// ---------------------------------------------------------------------------
// manifest 组装
// ---------------------------------------------------------------------------

function manifestRow(ctx: BuildContext, struct: StructureIndex | null, row: MatrixRow,
  plans: Map<string, GraphPlan>, buildBlockedReason: string | null): Record<string, unknown> {
  const plan = plans.get(row.job_id);
  let graphPath: string | null = null;
  let graphHash: string | null = null;
  if (plan) {
    graphPath = `graphs/${row.job_id}.json`;
    graphHash = plan.graphHash;
  } else if (row.sample_kind === "reuse" && row.reuse_of) {
    const src = plans.get(row.reuse_of);
    if (src) { graphPath = `graphs/${row.reuse_of}.json`; graphHash = src.graphHash; }
  }
  const sc = struct?.cases[row.structure_case];
  const isRepair = row.group === "R_calib" || row.group === "R_repeat";
  return {
    job_id: row.job_id, group: row.group, case_id: row.case_id, pair: row.pair, action: row.action,
    framing: row.framing, seed: row.seed, stage: row.stage, stage_seed: row.stage_seed, method: row.method,
    weights: row.weights,
    parent: row.depends_on.length > 0 ? { job_ids: row.depends_on } : null,
    sample_kind: row.sample_kind, depends_on: row.depends_on, reuse_of: row.reuse_of,
    ...(buildBlockedReason ? { build_blocked: { blocked: true, reason: buildBlockedReason } } : {}),
    graph_path: graphPath, graph_hash: graphHash,
    expected_width: plan?.width ?? (isRepair ? ctx.spec.canvas.repair_local_target : ctx.spec.canvas.width),
    expected_height: plan?.height ?? (isRepair ? ctx.spec.canvas.repair_local_target : ctx.spec.canvas.height),
    input_files: plan?.inputFiles ?? [],
    structure_provenance: plan?.structureProvenance ?? null,
    asset_hashes: plan?.assetHashes ?? null,
    prompts: plan?.prompts ?? null,
    expected_visibility: sc
      ? { expected_visible_contacts: sc.expected_visible_contacts ?? null,
          expected_out_of_frame_parts: sc.expected_out_of_frame_parts ?? null }
      : null,
    output_contract: {
      fields: ctx.spec.output_contract.fields,
      image_node_ids: plan?.built.imageNodes ?? [],
      metadata_node_ids: plan?.built.metadataNodes ?? [],
      generation_info_keep: ctx.spec.output_contract.generation_info_keep,
    },
    comparison_folders: row.comparison_folders,
    // runner 回填字段（build 期一律 null，不预填）：
    prompt_id: null, generation_info: null, execution_status: null,
  };
}

function manifestTop(ctx: BuildContext, struct: StructureIndex | null, counts: Record<string, unknown>,
  selection: Record<string, unknown> | null, dryRun: boolean): Record<string, unknown> {
  const pf = ctx.preflight;
  return {
    schema_version: MANIFEST_SCHEMA,
    generated_at: new Date().toISOString(),
    generated_by: "T3a build (scripts/experiments/interaction-study.ts)",
    spec_sha256: sha256Bytes(ctx.specBytes),
    preflight_sha256: sha256Bytes(ctx.preflightBytes),
    structure_index_sha256: struct?.index_sha256 ?? null,
    prompt_floor: {
      positive: ctx.floorText.positive,
      negative: ctx.floorText.negative,
      source: ctx.floorText.source,
      provenance: ctx.floorText.provenance,
      public_positive_pairs: ctx.spec.fixed_parameters.prompt_floor.positive_public_pairs,
      public_positive_single: ctx.spec.fixed_parameters.prompt_floor.positive_public_single,
      scene_semantics: ctx.spec.fixed_parameters.prompt_floor.scene_semantics,
      not_v8_four_axis_flat: true,
    },
    characters_snapshot: ctx.spec.characters.map((c) => {
      const l = loraOf(ctx.spec, c.key);
      return {
        key: c.key, lora_name: c.lora_name, lora_comfy_path: l.comfyRelativePath,
        lora_sha256: l.asset.sha256, inject: c.inject, weight_baseline: c.weight_baseline,
        matched_key_counts: l.asset.matchedKeyCounts,
        clip_strength_inert: (l.asset.matchedKeyCounts?.clip ?? 0) === 0,
      };
    }),
    lora_clip_inert_note: "两份 LoRA 均 0 个 text-encoder key（preflight criticalFinding_clipStrengthInert）：clip 强度按 spec 联动传值但为已记录的空操作，不谎称生效。",
    execution: {
      core_commit: String(pf.execution?.coreCommit ?? "2c75dc1b379a59e0880619d029607af5169a62ef"),
      core_commit_source: pf.execution?.coreCommit
        ? "preflight.execution.coreCommit (T0b)"
        : "主会话裁定冻结生产 v0.44.0/2c75dc1b（dispatch 2026-11-11）；preflight.execution.coreCommit 落盘后以其为准",
      core_plan_frozen_commit: ctx.spec.provenance.external_baselines.comfyui_commit,
      rs_commit: ctx.spec.provenance.external_baselines.rs_multicharacter_commit,
      crop_commit: "6005efc02f7745649118edd89cdd084c2b9bd3ae",
      kj_commit: "ab72eda7ffad6280422d71ab7d54d3fb87c0ba18",
      t4_patch: "experiments/anima-interaction-v1/patches/rs-img2img.patch",
      glue_node: "experiments/anima-interaction-v1/custom_nodes/yugang_interaction",
      study_support_node: "experiments/anima-interaction-v1/custom_nodes/yugang_study_support",
      canvas: { width: ctx.spec.canvas.width, height: ctx.spec.canvas.height },
      repair_canvas: { width: ctx.spec.canvas.repair_local_target, height: ctx.spec.canvas.repair_local_target },
      sampler: ctx.spec.fixed_parameters.initial_sampling,
      rs_routing: ctx.spec.fixed_parameters.rs_routing,
      mechanical_choices: {
        mask_blend_pixels: "32（T1 spec 未冻结、T4 README §4.3 移交 T3；取 InpaintCropImproved 节点缺省，R1/R2/R3 与全部 case 一致）",
        clip_loader_type: "stable_diffusion（同一 clip 实体的生产已验证用法；非 V8 模板参数复用）",
        r1_uniform_mask: "ThresholdMask(gray_crop, 0.5)（T4 README §4.3 冻结：R1 用 gray 的二值化 uniform 版）",
        scene_json_embedding: "scene 文件内容 build 期实读内嵌 graph（sha 先核对）；不走运行时替换",
      },
      dry_run: dryRun,
    },
    counts,
    ...(selection ? { selection } : {}),
  };
}

// ---------------------------------------------------------------------------
// revision 保护 + 写盘
// ---------------------------------------------------------------------------

function guardRevision(manifestPath: string, top: Record<string, unknown>): void {
  if (!existsSync(manifestPath)) return;
  const old = JSON.parse(readFileSync(manifestPath, "utf8")) as Record<string, unknown>;
  for (const key of ["spec_sha256", "preflight_sha256", "structure_index_sha256"] as const) {
    if (old[key] !== top[key])
      throw new Error(`revision 保护：${manifestPath} 已存在且 ${key} 不同（旧 ${String(old[key])} vs 新 ${String(top[key])}）。参数/输入/模型 hash 改变不得覆盖旧 revision——请换新 revision 目录（run-root），不覆盖。`);
  }
}

// ---------------------------------------------------------------------------
// runBuild / runPreflightCheck
// ---------------------------------------------------------------------------

export async function runBuild(opts: BuildOptions): Promise<BuildResult> {
  const missing: string[] = [];
  let ctx: BuildContext;
  try {
    ctx = loadContext(opts.repoRoot, opts.runRoot, opts.floorOverride);
  } catch (error) {
    return { ok: false, missing: [String((error as Error).message)], dryRun: Boolean(opts.dryRun) };
  }
  missing.push(...await verifyCharactersAgainstLiveTable(ctx));
  if (missing.length > 0) return { ok: false, missing, dryRun: Boolean(opts.dryRun) };

  const rows = expandMatrix(ctx.spec);
  const counts = assertCounts(ctx.spec, rows);

  // pose_grid 行修正（数据合同，不改库代码）：spec B 组冻结 weights={A:0.8,B:0.8}，pose_grid
  // 图形状=B2 只变 strength/interval（spec main_fixed），故槽位权重 = 基线 0.8。展开行缺 A/B
  // 会让构图写入 undefined 字节（本次核验实测 8 图损坏）——build 前在内存行上补齐，矩阵计数不变。
  for (const r of rows) {
    if (r.group === "pose_grid") {
      r.weights = { A: 0.8, B: 0.8, ...r.weights };
    }
  }

  // 选择集：staged（W-S smoke）或全量
  let selected: MatrixRow[];
  let selection: Record<string, unknown> | null = null;
  let outDir = opts.runRoot;
  if (opts.stage) {
    if (opts.stage.group !== "W-S")
      return { ok: false, missing: [`staged build 目前只支持 --group W-S（收到 ${opts.stage.group}）；其余组走全量 build（需结构就绪）`] };
    selected = rows.filter((r) => r.group === "W-S" && r.sample_kind === "new"
      && (opts.stage!.seed === undefined || r.seed === opts.stage.seed)
      && (opts.stage!.weight === undefined || r.weights["lora"] === opts.stage.weight));
    outDir = join(opts.runRoot, "stages", "w-s-smoke");
    selection = {
      mode: "stage", stage_dir: relToRunRoot(opts.runRoot, outDir),
      group: opts.stage.group, seed: opts.stage.seed ?? null, weight: opts.stage.weight ?? null,
      selected: selected.length,
      note: "真实子集（参数与预定全矩阵一致、job_id 一致）；不是完整 manifest，不伪称 F1 通过。后续完整 manifest 吸收本批原图/prompt_id/图 hash 为已执行，不重复 POST、不扩 808。",
    };
  } else {
    selected = rows;
  }

  // 结构：全量 build 必须就绪；staged W-S 不消费结构（缺失如实记录，不阻塞）
  let struct: StructureIndex | null = null;
  if (!opts.stage) {
    try {
      struct = loadStructureIndex(opts.runRoot, opts.repoRoot);
      auditStructure(struct, ctx.spec, opts.repoRoot); // 未就绪即抛（消息含具体缺项明细）
    } catch (error) {
      struct = null;
      if (error instanceof StructureNotReadyError) missing.push(error.message);
      else missing.push(String((error as Error).message));
    }
    if (missing.length > 0) {
      writeBuildReport(opts.runRoot, { ok: false, missing, stage: "structure", selection });
      return { ok: false, missing, dryRun: Boolean(opts.dryRun) };
    }
  }

  // R 依赖（§8.1 R 接口修正）：repair-v2 索引 + Falloff 节点源。缺项只隔离 R 行，
  // B/H/W/pose_grid/W-S 不被阻断；绝不偷退旧全身域。
  let repair: RepairDepsState | null = null;
  const rBlocked: string[] = [];
  if (!opts.stage) {
    repair = auditRepairDeps(opts.runRoot, opts.repoRoot, ctx.spec);
  }

  // 构图（仅 new 行；row 顺序 = 展开顺序，父先于子）
  const plans = new Map<string, GraphPlan>();
  for (const row of selected) {
    if (row.sample_kind !== "new") continue;
    const isR = row.group === "R_calib" || row.group === "R_repeat";
    if (isR && (!repair || !repair.ready)) { rBlocked.push(row.job_id); continue; }
    try {
      plans.set(row.job_id, planGraph(ctx, struct, row, plans, repair));
    } catch (error) {
      missing.push(`job ${row.job_id} 构图失败：${String((error as Error).message)}`);
    }
  }
  if (missing.length > 0) {
    writeBuildReport(opts.runRoot, { ok: false, missing, stage: "graph-plan", selection });
    return { ok: false, missing, dryRun: Boolean(opts.dryRun) };
  }

  // P-DC 条件复用：仅 exact graph hash 相同才翻 reuse（否则保留上限 16，不做进一步优化）
  let pReused = 0;
  if (!opts.stage) {
    for (const row of rows.filter((r) => r.group === "P" && r.method === "P2")) {
      const p1 = plans.get(row.job_id.replace(/__P2$/, "__P1"));
      const p2 = plans.get(row.job_id);
      if (p1 && p2 && p1.graphHash === p2.graphHash) {
        row.sample_kind = "reuse";
        row.reuse_of = p1.row.job_id;
        row.depends_on = [...new Set([...row.depends_on, p1.row.job_id])];
        plans.delete(row.job_id); // 复用行不落自己的图
        pReused += 1;
      }
    }
  }

  const rBlockedReason = rBlocked.length > 0 && repair
    ? `R 依赖未就绪（repair-v2 索引 / ${FALLOFF_NODE_CLASS} 节点源）：${repair.missing.join("；")}`
    : null;
  const jobs = (opts.stage ? selected : rows).map((row) =>
    manifestRow(ctx, struct, row, plans, rBlocked.includes(row.job_id) ? rBlockedReason : null));
  const finalCounts = opts.stage
    ? { selected_new_rows: selected.length, graphs: plans.size,
        budget_note: `staged 子集是预定 ${counts.total_new} 新增采样行的一部分（job_id 一致），不新增预算` }
    : { ...counts, p_conditional_reuse_applied: pReused,
        new_after_p_reuse: rows.filter((r) => r.sample_kind === "new").length,
        reuse_rows: rows.filter((r) => r.sample_kind === "reuse").length,
        graphs_built: plans.size,
        r_blocked: { count: rBlocked.length, job_ids: rBlocked,
          missing: repair && !repair.ready ? repair.missing : [],
          note: rBlocked.length > 0
            ? "R 行明确拒构（无 graph，runner 不得 POST）；B/H/W/WS 不受影响。T2c/T4c 就绪后另派真实 build（新 revision）。"
            : null } };

  const top = manifestTop(ctx, struct, finalCounts, selection, Boolean(opts.dryRun));
  const manifest = { ...top, jobs };
  const manifestText = JSON.stringify(manifest, null, 2) + "\n";
  const manifestPath = join(outDir, "manifest.json");
  guardRevision(manifestPath, top);

  let written = 0;
  if (!opts.dryRun) {
    mkdirSync(join(outDir, "graphs"), { recursive: true });
    for (const [jobId, plan] of plans) {
      writeFileSync(join(outDir, "graphs", `${jobId}.json`), plan.bytes);
      written += 1;
      // 写盘后复核：graph_hash 必须等于盘上实字节 hash（绑定声明）
      const onDisk = sha256Bytes(readFileSync(join(outDir, "graphs", `${jobId}.json`)));
      if (onDisk !== plan.graphHash)
        throw new Error(`job ${jobId}: 写盘字节 hash ${onDisk} != 计算 hash ${plan.graphHash}（内部错误，停止）`);
    }
    writeFileSync(manifestPath, manifestText);
  } else {
    written = plans.size;
  }

  const report = {
    ok: true, missing: [], stage: opts.stage ? "stage-complete" : "complete", selection,
    counts: finalCounts, graphs_written: written, dry_run: Boolean(opts.dryRun),
    manifest_path: opts.dryRun ? null : relToRunRoot(opts.runRoot, manifestPath),
    manifest_sha256: sha256Bytes(manifestText),
  };
  writeBuildReport(opts.runRoot, report);
  return { ok: true, missing: [], manifestPath: opts.dryRun ? undefined : manifestPath,
    counts: finalCounts, selection: selection ?? undefined, graphsWritten: opts.dryRun ? undefined : written,
    dryRun: Boolean(opts.dryRun) };
}

export function writeBuildReport(runRoot: string, report: Record<string, unknown>): void {
  const dir = join(runRoot, "checks");
  mkdirSync(dir, { recursive: true });
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  writeFileSync(join(dir, `build-${stamp}.json`),
    JSON.stringify({ schema: "yugang.anima-interaction-v1.build-report/1", ...report }, null, 2) + "\n");
}

/** preflight 子命令：门 1–4 + 资产绑定 + 结构状态（只读核对，不写 graphs/manifest）。 */
export async function runPreflightCheck(repoRoot: string, runRoot: string): Promise<{ ok: boolean; missing: string[]; summary: Record<string, unknown> }> {
  try {
    const ctx = loadContext(repoRoot, runRoot);
    const charMissing = await verifyCharactersAgainstLiveTable(ctx);
    let structState: { ready: boolean; missing: string[]; index_sha256: string | null; index_file: string | null };
    try {
      const index = loadStructureIndex(runRoot, repoRoot);
      try {
        auditStructure(index, ctx.spec, repoRoot);
        structState = { ready: true, missing: [], index_sha256: index.index_sha256, index_file: index.index_file };
      } catch (error) {
        structState = { ready: false, missing: [String((error as Error).message)], index_sha256: index.index_sha256, index_file: index.index_file };
      }
    } catch (error) {
      structState = { ready: false, missing: [String((error as Error).message)], index_sha256: null, index_file: null };
    }
    const rows = expandMatrix(ctx.spec);
    const counts = assertCounts(ctx.spec, rows);
    const repairState = auditRepairDeps(runRoot, repoRoot, ctx.spec);
    const missing = [...charMissing];
    return {
      ok: missing.length === 0,
      missing,
      summary: {
        spec_sha256: sha256Bytes(ctx.specBytes),
        preflight_sha256: sha256Bytes(ctx.preflightBytes),
        gate_g0_intact: ctx.preflight.gateG0?.["gateIntact"] === true,
        assets_bound: Object.fromEntries(ASSET_KEYS.map((k) => [k, {
          entity: ctx.assets[k]!.comfyRelativePath, bytes: ctx.assets[k]!.bytes, sha256: ctx.assets[k]!.sha256,
          matched_key_counts: ctx.assets[k]!.matchedKeyCounts,
        }])),
        character_table_consistent: charMissing.length === 0,
        prompt_floor: { positive: ctx.floorText.positive, negative: ctx.floorText.negative, source: ctx.floorText.source },
        matrix_counts: counts,
        structure: structState,
        repair_v2: {
          ready: repairState.ready,
          missing: repairState.missing,
          index_sha256: repairState.index?.index_sha256 ?? null,
          index_file: repairState.index?.index_file ?? null,
          falloff_node: FALLOFF_NODE_CLASS,
          falloff_source_files: repairState.falloffSourceFiles,
          note: "未就绪时 build 拒构全部 R 行（counts.r_blocked）；B/H/W/pose_grid/W-S 不受阻断（§8.1 R 接口修正）",
        },
      },
    };
  } catch (error) {
    return { ok: false, missing: [String((error as Error).message)], summary: {} };
  }
}
