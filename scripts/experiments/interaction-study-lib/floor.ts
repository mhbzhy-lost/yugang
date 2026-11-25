/**
 * floor.ts —— 冻结地板：spec/preflight 载入、stage seed、角色/LoRA 解析、正负提示地板。
 *
 * 正/负地板是 spec `fixed_parameters.prompt_floor.negative_and_extra_positive` 的
 * T0/T3 延迟冻结项，由本文件显式冻结（owner=T3a，2026-11-11），build 时原样写入
 * manifest#/prompt_floor。约束逐条对应来源，**不照搬 V8 四轴扁平**：
 * - 计划 §4.1：「不使用额外画风 LoRA；不照搬 V8 专用四轴扁平前缀。正负提示地板在正式
 *   采样前冻结」「英文逗号分隔 tag 形态」「公共提示 2girls，区域注入剔除 1girl/solo，
 *   双人描述不能完全相同」。
 * - 计划 §3.1 固定场景：柔和日光、庭院地面、背景墙、远处树木 → 英文 tag 转写。
 * - 负向地板刻意**不含** V8 负向的 `lips / shiny skin / abs / oily skin / airbrushed /
 *   monochrome / sketch 系`（3.8B V8 防油/碎线锁；`lips` 会与 KISS 动作直接冲突），
 *   质量基线与动作失败项负向取自冻结 RS Sampler 缺省负向语义（nodes.py INPUT_TYPES
 *   default "low quality, bad anatomy, text, watermark"）加 §3.1「不算完成的替代动作」
 *   的机械转写（多生一只手/额外腿/额外手臂/共用躯干）。
 * - 每动作×每槽位姿态文本（ACTION_SLOT_TEXT）是 §3.1 world/check 列的英文 tag 转写，
 *   A/B 两槽互异（spec：双人描述不能完全相同）。
 *
 * 改动这里任何文本 = 新 revision（build 不覆盖旧 run）。
 */
import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";

// ---------------------------------------------------------------------------
// 冻结文本
// ---------------------------------------------------------------------------

/** 正向地板：质量基线 + §3.1 固定场景语义（英文 danbooru tag 形态）。 */
export const POSITIVE_FLOOR =
  "masterpiece, best quality, soft sunlight, courtyard, ground, background wall, distant trees, outdoors";

/** 负向地板：全体 job（B/H/W/R/P/solo）共用同一条，保证组间只有声明的单一变量。 */
export const NEGATIVE_FLOOR =
  "lowres, worst quality, low quality, bad anatomy, bad hands, missing fingers, extra digit, fewer digits, extra limbs, extra legs, extra arms, conjoined bodies, fused bodies, text, watermark, signature";

/** 地板来源记录（进 manifest#/prompt_floor.provenance）。 */
export const FLOOR_PROVENANCE = {
  positive: "T3a frozen 2026-11-11: masterpiece/best quality (RS Sampler default positive semantics) + plan §3.1 fixed scene (soft daylight, courtyard ground, background wall, distant trees). NOT the V8 four-axis flat prefix.",
  negative: "T3a frozen 2026-11-11: RS Sampler default negative semantics (low quality, bad anatomy, text, watermark) + plan §3.1 not_complete transcription (extra hand/limb/leg, fused or shared torso). Deliberately excludes V8 negatives lips/shiny skin/abs/oily/airbrushed/monochrome/sketch (V8 anti-oil chain; 'lips' would fight the KISS action).",
  extra_positive_action_slot: "T3a frozen 2026-11-11: per-action per-slot English tag transcription of plan §3.1 world/check columns; A and B texts differ per slot.",
  framing_tag: "spec.framings[].tag; appended to the common prompt exactly once.",
  counts: "spec.fixed_parameters.prompt_form: public 2girls (pair) / 1girl (single, inside solo inject); pair slot injects strip 1girl/solo.",
} as const;

/** 每动作×每槽位的姿态/朝向/关系描述（A=左/主 actor，B=右/次 actor；CARRY 中 A 背 B）。 */
export const ACTION_SLOT_TEXT: Record<string, { a: string; b: string }> = {
  HAND: {
    a: "standing, facing viewer, extending right hand, fingers interlaced with the other girl's left hand, palm to palm, wrists connected",
    b: "standing, facing viewer, extending left hand, fingers interlaced with the other girl's right hand, remaining hands relaxed at sides",
  },
  HUG: {
    a: "front-facing embrace, both arms wrapped around the other girl's torso, shoulders overlapping in front, bodies pressed together",
    b: "embraced from the front, both arms wrapped around the other girl's back, head leaning toward her shoulder, slight forward lean",
  },
  KISS: {
    a: "kissing the other girl on the lips, lips touching, head tilted, readable profile view, eyes closed",
    b: "kissed on the lips by the other girl, lips touching, three-quarter view of face, chin clear of her nose, hands resting on her shoulders",
  },
  CARRY: {
    a: "carrying the other girl on the back, both hands supporting her thighs, standing upright, leaning slightly forward",
    b: "on the other girl's back, feet off the ground, legs wrapped around the carrier's sides, arms draped over her shoulders from behind",
  },
};

/** solo（W-S）站姿文本；人数词由 inject 自带 1girl/solo 提供。 */
export const SOLO_STANCE_TEXT = "standing, facing viewer, arms at sides, relaxed posture";

// ---------------------------------------------------------------------------
// 触发词整形（与 src/tools/draw/comfy.ts 私有实现语义一致；来源注明，不改生产文件）
// ---------------------------------------------------------------------------

export function escapeInjected(text: string): string {
  return text.replace(/(?<!\\)([()])/g, "\\$1");
}

export function normalizeTagForm(text: string): string {
  return text.replace(/([A-Za-z0-9]+)_\(([^()]*)\)/g, (_m, head: string, inner: string) => {
    return `${head} \\(${inner.replace(/_/g, " ")}\\)`;
  });
}

/** 注入串统一整形：先 normalizeTagForm 再幂等括号转义（生产同序）。 */
export function shapeInject(inject: string): string {
  return escapeInjected(normalizeTagForm(inject));
}

/** pair 区域注入剔除全局人数冲突用的 1girl/solo（spec prompt_form.regional_strip）。 */
export function stripCountTags(inject: string): string {
  return inject.split(",").map((t) => t.trim()).filter((t) => t.length > 0 && t !== "1girl" && t !== "solo").join(", ");
}

// ---------------------------------------------------------------------------
// spec / preflight 载入与类型
// ---------------------------------------------------------------------------

/* eslint-disable @typescript-eslint/no-explicit-any */
export interface Spec {
  spec_version: string;
  provenance: { character_source_sha256: string; external_baselines: Record<string, string>; [k: string]: any };
  canvas: { width: number; height: number; [k: string]: any };
  seeds: { values: number[]; stage_algorithm: { verified_example: { input: string; sha256: string; stage_seed: number }; [k: string]: any }; [k: string]: any };
  characters: Array<{ key: string; name: string; inject: string; lora_name: string; lora_asset_ref: string; weight_baseline: number; [k: string]: any }>;
  semantics: { pair: { instances: Record<string, { A: string; B: string; [k: string]: any }>; [k: string]: any }; [k: string]: any };
  actions: Array<{ id: string; [k: string]: any }>;
  framings: Array<{ id: string; tag: string; [k: string]: any }>;
  cases: Record<string, { set: string[]; count: number; [k: string]: any }>;
  fixed_parameters: Record<string, any>;
  methods: Record<string, string>;
  matrix: { groups: Array<Record<string, any>>; total_new_samples: number; budget_check: { expected: number }; reuse_rules: any[]; [k: string]: any };
  output_contract: { fields: string[]; generation_info_keep: string[]; [k: string]: any };
  [k: string]: any;
}

export interface Preflight {
  assets: Record<string, Record<string, any>>;
  gateG0?: Record<string, any>;
  execution?: { coreCommit?: string };
  [k: string]: any;
}

export interface AssetBinding {
  key: string;
  comfyRelativePath: string;
  windowsAbsolutePath: string;
  sha256: string;
  bytes: number | null;
  matchedKeyCounts: { model: number; clip: number } | null;
}

export const ASSET_KEYS = ["unet", "clip", "vae", "lora_shared", "lora_claude", "pose_lllite", "mhr_mesh", "mhr_license"] as const;

export const sha256Bytes = (b: Buffer | string): string => createHash("sha256").update(b).digest("hex");

export function loadSpec(runRoot: string, repoRoot: string): { spec: Spec; raw: Buffer; path: string } {
  const candidates = [
    join(runRoot, "spec.json"),
    join(repoRoot, "experiments", "anima-interaction-v1", "spec.json"),
  ];
  for (const file of candidates) {
    if (!existsSync(file)) continue;
    const raw = readFileSync(file);
    const spec = JSON.parse(raw.toString("utf8")) as Spec;
    if (spec.spec_version !== "anima-interaction-v1") throw new Error(`spec_version 不符：${file} = ${String(spec.spec_version)}`);
    // 冻结算法自检：示例必须复算一致，否则整套 stage seed 全部可疑。
    const ex = spec.seeds?.stage_algorithm?.verified_example;
    if (ex) {
      const [c, s, st] = ex.input.split("|") as [string, string, string];
      const got = stageSeed(c, Number(s), st);
      if (got !== ex.stage_seed) throw new Error(`stage seed 算法自检失败：${ex.input} 期望 ${ex.stage_seed}，实得 ${got}`);
      const digest = createHash("sha256").update(`${c}|${s}|${st}`, "utf8").digest("hex");
      if (digest !== ex.sha256) throw new Error(`stage seed sha256 自检失败：${ex.input} 期望 ${ex.sha256}，实得 ${digest}`);
    } else throw new Error(`spec 缺 seeds.stage_algorithm.verified_example（${file}）`);
    return { spec, raw, path: resolve(file) };
  }
  throw new Error(`spec.json 不存在：尝试过 ${candidates.join(" , ")}`);
}

/** preflight 载入（run-root 权威副本）。资产键的实体校验在 build.ts::loadContext 做。 */
let boundPreflight: Preflight | null = null;
export function loadPreflight(runRoot: string): { preflight: Preflight; raw: Buffer; path: string } {
  const file = join(runRoot, "preflight.json");
  if (!existsSync(file)) throw new Error(`preflight.json 不存在：${file}（T0 产物；无它 build 必须拒绝，不填假 path/hash）`);
  const raw = readFileSync(file);
  const preflight = JSON.parse(raw.toString("utf8")) as Preflight;
  boundPreflight = preflight;
  return { preflight, raw, path: resolve(file) };
}

/** 资产键 → 绑定（loadPreflight 之后可用）。 */
export function assetBinding(preflight: Preflight, key: string): AssetBinding {
  const a = preflight.assets?.[key];
  if (!a) throw new Error(`preflight.json#/assets/${key} 缺失（T0 未填或键名不符）`);
  const sha = String(a["sha256"] ?? "");
  if (!/^[0-9a-f]{64}$/.test(sha)) throw new Error(`preflight.json#/assets/${key}.sha256 不是实测 64hex（拒绝假 hash）`);
  // mhr_mesh/mhr_license 是 RS 包内资产（packageRelativePath），不是 comfy models 目录名；
  // 六个模型键必须是 comfyRelativePath（图内加载节点直接消费该名字）。
  const rel = String(a["comfyRelativePath"] ?? a["packageRelativePath"] ?? "");
  if (!rel) throw new Error(`preflight.json#/assets/${key} 缺 comfyRelativePath/packageRelativePath`);
  if ((key === "mhr_mesh" || key === "mhr_license") !== (a["packageRelativePath"] !== undefined && a["comfyRelativePath"] === undefined)) {
    // 键语义与字段形态必须一致：模型键不得只有 packageRelativePath，mhr 键不得冒充 comfy 目录名
    if (key !== "mhr_mesh" && key !== "mhr_license" && a["comfyRelativePath"] === undefined)
      throw new Error(`preflight.json#/assets/${key}.comfyRelativePath 缺失（模型键必须是 comfy 目录相对名）`);
  }
  const mk = (a["criticalFinding_clipStrengthInert"] as any)?.matchedKeyCounts ?? (a["structure"] as any)?.matchedKeyCounts ?? null;
  return {
    key, comfyRelativePath: rel,
    windowsAbsolutePath: String(a["windowsAbsolutePath"] ?? ""), sha256: sha,
    bytes: typeof a["bytes"] === "number" ? (a["bytes"] as number) : null,
    matchedKeyCounts: mk ? { model: Number(mk.model), clip: Number(mk.clip) } : null,
  };
}

/** pose 适配器 Comfy 相对名（T0 修正过 rs_reference/ 段；拒绝旧假设名）。 */
export function POSE_NAME(assets: Record<string, AssetBinding>): string {
  const p = assets["pose_lllite"];
  if (!p) throw new Error("资产绑定缺 pose_lllite");
  if (!p.comfyRelativePath.startsWith("rs_reference/"))
    throw new Error(`pose_lllite comfyRelativePath=${p.comfyRelativePath} 与 preflight 的 rs_reference/ 路径修正不符`);
  return p.comfyRelativePath;
}

// ---------------------------------------------------------------------------
// 角色 / LoRA 解析（唯一事实源 = spec.characters 快照，build 期与活表核对）
// ---------------------------------------------------------------------------

export interface CharacterEntry {
  key: string; name: string; inject: string; lora_name: string; lora_asset_ref: string;
  weight_baseline: number; lora: { file: string };
}

export function characterEntry(spec: Spec, key: string): CharacterEntry {
  const c = spec.characters.find((x) => x.key === key);
  if (!c) throw new Error(`spec.characters 缺角色 ${key}`);
  return { ...c, lora: { file: c.lora_name } };
}

export interface LoraBinding {
  assetRef: string;
  comfyRelativePath: string;
  weightBaseline: number;
  asset: { sha256: string | null; bytes: number | null; matchedKeyCounts: { model: number; clip: number } | null };
}

/**
 * 角色的 LoRA 绑定：spec 指针（lora_asset_ref）→ 已载入 preflight 的实体。
 * preflight 未载入时回落到 spec 声明文件名（describe-* 纯机械模式用；build 必先 loadPreflight，
 * 且 loadContext 会核对 comfyRelativePath === lora_name）。
 */
export function loraOf(spec: Spec, key: string): LoraBinding {
  const entry = characterEntry(spec, key);
  const assetKey = entry.lora_asset_ref.split("/").pop()!;
  if (boundPreflight) {
    const a = assetBinding(boundPreflight, assetKey);
    if (a.comfyRelativePath !== entry.lora_name)
      throw new Error(`角色 ${key}：preflight 实体名 ${a.comfyRelativePath} 与源表声明 ${entry.lora_name} 不一致`);
    return { assetRef: entry.lora_asset_ref, comfyRelativePath: a.comfyRelativePath, weightBaseline: entry.weight_baseline,
      asset: { sha256: a.sha256, bytes: a.bytes, matchedKeyCounts: a.matchedKeyCounts } };
  }
  return { assetRef: entry.lora_asset_ref, comfyRelativePath: entry.lora_name, weightBaseline: entry.weight_baseline,
    asset: { sha256: null, bytes: null, matchedKeyCounts: null } };
}

// ---------------------------------------------------------------------------
// stage seed（spec.seeds.stage_algorithm，冻结公式）
// ---------------------------------------------------------------------------

export function stageSeed(caseId: string, seed: number, stage: string): number {
  const digest = createHash("sha256").update(`${caseId}|${seed}|${stage}`, "utf8").digest();
  return digest.readUInt32BE(0);
}

// ---------------------------------------------------------------------------
// 提示词组合（floor + framing + 人数词 + 角色/动作槽位文本）
// ---------------------------------------------------------------------------

function framingTag(spec: Spec, framing: string): string {
  const f = spec.framings.find((x) => x.id === framing);
  if (!f) throw new Error(`spec.framings 缺景别 ${framing}`);
  return f.tag;
}

/** 公共正向 = 地板 + framing tag（仅一次）+ 人数词（pair=2girls；null=1girl）。 */
export function buildCommonPrompt(spec: Spec, pair: string | null, _action: string, framing: string): string {
  const tag = framingTag(spec, framing);
  return `${POSITIVE_FLOOR}, ${tag}, ${pair === null ? "1girl" : "2girls"}`;
}

/** 区域槽位文本 = 整形并剔除人数词的 inject + 动作槽位描述（身份在前、姿态在后）。 */
export function buildRegional(spec: Spec, characterKey: string, slot: "A" | "B", action: string): string {
  const entry = characterEntry(spec, characterKey);
  const texts = ACTION_SLOT_TEXT[action];
  if (!texts) throw new Error(`floor: 未知动作 ${action}（W-S 走 buildSoloPositive）`);
  return `${shapeInject(stripCountTags(entry.inject))}, ${texts[slot.toLowerCase() as "a" | "b"]}`;
}

/** solo（W-S）正向 = 地板 + M 景 tag + 整形 inject（保留 1girl/solo）+ 站姿。 */
export function buildSoloPositive(spec: Spec, characterKey: string): string {
  const entry = characterEntry(spec, characterKey);
  return `${POSITIVE_FLOOR}, ${framingTag(spec, "M")}, ${shapeInject(entry.inject)}, ${SOLO_STANCE_TEXT}`;
}

/** 无区域路由的图（R1/R2/P/W-G）的全局正向 = 公共 + 两槽文本合并。 */
export function mergedPositive(common: string, slotA: string, slotB: string): string {
  return `${common}, ${slotA}, ${slotB}`;
}

export function buildNegative(floor?: { negative?: string } | null): string {
  return floor?.negative ?? NEGATIVE_FLOOR;
}

export interface PromptFloorText { positive: string; negative: string; source: string; provenance: Record<string, string> }

/**
 * 地板解析：缺省 = 本文件冻结文本。--prompt-floor 覆盖文件只接受与冻结文本**逐字相同**
 * 的确认（T3a 未把覆盖文本接入图构建，接受不同文本会造成 manifest 与 graph 分裂——
 * 改地板 = 改本文件 + 新 revision）。
 */
export function resolvePromptFloor(overridePath?: string): PromptFloorText {
  const base: PromptFloorText = {
    positive: POSITIVE_FLOOR, negative: NEGATIVE_FLOOR,
    source: "frozen in scripts/experiments/interaction-study-lib/floor.ts (T3a, 2026-11-11); recorded verbatim in manifest#/prompt_floor",
    provenance: { ...FLOOR_PROVENANCE },
  };
  if (!overridePath) return base;
  const raw = JSON.parse(readFileSync(overridePath, "utf8")) as { positive?: string; negative?: string };
  if (raw.positive !== undefined && raw.positive !== POSITIVE_FLOOR)
    throw new Error(`--prompt-floor 覆盖文本与冻结正向地板不同。T3a 的图构建只消费 floor.ts 冻结文本；改地板请改 floor.ts 并建新 revision（不覆盖旧 run）。`);
  if (raw.negative !== undefined && raw.negative !== NEGATIVE_FLOOR)
    throw new Error(`--prompt-floor 覆盖文本与冻结负向地板不同。同上：改地板 = 改 floor.ts + 新 revision。`);
  return { ...base, source: `${base.source}; confirmed identical via ${overridePath}` };
}
