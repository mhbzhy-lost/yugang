/**
 * structure.ts —— T2b 结构资产索引的消费合同（build 只消费真实渲染文件，绝不重造几何）。
 *
 * 权威索引（T2b render.py 落盘，真实 schema 实测对齐 2026-11-11）：
 *   <run-root>/inputs/structure/structure_index.json
 *   schema = "yugang.anima-interaction-v1.structure.structure_index", version = 1
 *   顶层：execution_state / rs_commit / rs_geometry_sha256 / mhr_asset / canvas / repair_params /
 *         box_expand_px(=8) / finger_limitation / tail_rule / case_count / cases(dict, key=case_id)
 *   case 条目：case_id / is_solo / framing / world_id / status("rendered") / canvas /
 *     files: { "scene.json"|"pose_image.png"|"owner_a.png"|"owner_a_full.png"|"owner_b.png"|
 *              "owner_b_full.png"|"repair_core.png"|"support.png"|"context.png"|"gray.png"|
 *              "preview.png"|"structure_index.json": {path,sha256} }   // path 相对仓库根
 *     boxes: { owner_a|owner_b: {x,y,width,height,pixel_bbox,empty} }  // 权威 box：rendered owner
 *                                                                      // visible mask + 8px（非 FK-proxy）
 *     expected_visible_contacts / expected_out_of_frame_parts          // §3.4 出图前声明
 *     repair_flags: {core_empty,support_empty,note}                    // 空编辑域=机械事实，不伪造
 *     tail_union: {owner,slot,...}                                     // 鲸尾同 owner union 声明
 *
 * 校验规则（auditStructure，全部机械）：
 * - main_40 + single_4 恰好各一条（多/少/重复/未知都报缺项）；status 必须 "rendered"；
 * - 每个声明文件真实存在且实字节 sha256 与索引一致（path 相对仓库根解析；不符 = 具体报错）；
 * - box x/y/width/height 有限、w/h ∈ (0,1]、四边夹在 [0,1]（RS slot_box 会拒绝越界）；
 *   empty=true 是机械事实（超近景空投影），如实上报（消费它的 B0/B1 行无法构图，需按 spec
 *   机械跳过规则裁定，不静默造 box）；
 * - scene 内容 UTF-8 字符数 ≤ 100000（frozen pose3d.py::read_scene 上限）；
 * - repair 文件（repair_core/support/context/gray）仅对非 XH case 要求（R 组消费面 = core_32 ∪ m_8）；
 * - expected_* 两字段必须存在（数组，可空）。
 *
 * 渲染仍在进行时（case_count < 44）审计如实列出缺失 case —— build 拒绝，不 partial 冒充完整。
 */
import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { isAbsolute, join, resolve } from "node:path";
import type { Spec } from "./floor.ts";

export const STRUCTURE_SCHEMA = "yugang.anima-interaction-v1.structure.structure_index";
export const SCENE_CHAR_CAP = 100_000; // frozen pose3d.py::read_scene 上限

export interface StructureFileRef {
  path: string;   // 相对仓库根（T2b 落盘形态）或绝对
  sha256: string;
}

export interface StructureBox {
  x: number;
  y: number;
  width: number;
  height: number;
  pixel_bbox?: number[];
  empty?: boolean;
}

export type StructureFileKey =
  | "scene.json" | "pose_image.png" | "owner_a.png" | "owner_a_full.png"
  | "owner_b.png" | "owner_b_full.png" | "repair_core.png" | "support.png"
  | "context.png" | "gray.png" | "preview.png" | "structure_index.json";

export interface StructureCase {
  case_id: string;
  is_solo: boolean;
  framing: string;
  world_id?: string;
  status: string;
  canvas?: [number, number];
  files: Partial<Record<StructureFileKey, StructureFileRef>>;
  boxes?: { owner_a?: StructureBox; owner_b?: StructureBox };
  expected_visible_contacts?: string[];
  expected_out_of_frame_parts?: string[];
  repair_flags?: { core_empty?: boolean; support_empty?: boolean; note?: string };
  tail_union?: Record<string, unknown>;
  repair_params?: Record<string, unknown>;
}

export interface StructureIndex {
  schema: string;
  version: number;
  execution_state?: string;
  rs_commit?: string;
  box_expand_px?: number;
  finger_limitation?: string;
  tail_rule?: string;
  case_count?: number;
  /** 绝对路径基准（解析 files[].path 相对路径用）。 */
  repoRoot: string;
  index_file: string;       // 绝对路径
  index_sha256: string;
  cases: Record<string, StructureCase>;
}

export class StructureNotReadyError extends Error {
  readonly candidates: string[];
  constructor(candidates: string[]) {
    super(`结构索引不存在（T2b 渲染未落盘）。已尝试：${candidates.join("；")}`);
    this.candidates = candidates;
  }
}

export function structureIndexCandidates(runRoot: string, repoRoot: string): string[] {
  return [
    join(runRoot, "inputs", "structure", "structure_index.json"),   // T2b 权威根索引
    join(repoRoot, "experiments", "anima-interaction-v1", "structure", "structure_index.json"),
  ];
}

export function loadStructureIndex(runRoot: string, repoRoot: string): StructureIndex {
  const candidates = structureIndexCandidates(runRoot, repoRoot);
  const file = candidates.find((c) => existsSync(c));
  if (file === undefined) throw new StructureNotReadyError(candidates);
  const raw = readFileSync(file);
  const parsed = JSON.parse(raw.toString("utf8")) as Record<string, unknown>;
  if (parsed["schema"] !== STRUCTURE_SCHEMA)
    throw new Error(`结构索引 schema 不符：${file} 声明 ${String(parsed["schema"])}，要求 ${STRUCTURE_SCHEMA}`);
  if (parsed["version"] !== 1)
    throw new Error(`结构索引 version 不符：${file} = ${String(parsed["version"])}，要求 1`);
  if (typeof parsed["cases"] !== "object" || parsed["cases"] === null || Array.isArray(parsed["cases"]))
    throw new Error(`结构索引 cases 必须是 dict（key=case_id）：${file}`);
  return {
    schema: STRUCTURE_SCHEMA, version: 1,
    execution_state: parsed["execution_state"] as string | undefined,
    rs_commit: parsed["rs_commit"] as string | undefined,
    box_expand_px: parsed["box_expand_px"] as number | undefined,
    finger_limitation: parsed["finger_limitation"] as string | undefined,
    tail_rule: parsed["tail_rule"] as string | undefined,
    case_count: parsed["case_count"] as number | undefined,
    repoRoot,
    index_file: resolve(file),
    index_sha256: createHash("sha256").update(raw).digest("hex"),
    cases: parsed["cases"] as Record<string, StructureCase>,
  };
}

/** 索引文件引用 → 绝对路径（相对路径按仓库根解析，T2b 落盘形态）。 */
export function structureAbsPath(index: StructureIndex, ref: StructureFileRef): string {
  return isAbsolute(ref.path) ? ref.path : join(index.repoRoot, ref.path);
}

/** 读文件并核对实字节 sha256；不符抛错（消息含期望/实际）。 */
export function readVerified(index: StructureIndex, ref: StructureFileRef, what: string): Buffer {
  const abs = structureAbsPath(index, ref);
  let buf: Buffer;
  try {
    buf = readFileSync(abs);
  } catch {
    throw new Error(`${what}: 文件不存在 ${abs}（索引声明 sha256=${ref.sha256}）`);
  }
  const actual = createHash("sha256").update(buf).digest("hex");
  if (!/^[0-9a-f]{64}$/.test(ref.sha256 ?? ""))
    throw new Error(`${what}: 索引 sha256 字段不是 64hex（${String(ref.sha256)}）`);
  if (actual !== ref.sha256)
    throw new Error(`${what}: sha256 不符 ${abs} 实际 ${actual}，索引声明 ${ref.sha256}（文件已变化或渲染未完成）`);
  return buf;
}

function boxProblems(label: string, box: StructureBox | undefined, out: string[], warnings: string[]): void {
  if (box === undefined) { out.push(`${label}: 缺失`); return; }
  if (box.empty === true) {
    // 机械事实（超近景空投影等）：不造 box；消费它的行无法构图，如实上报待裁定。
    warnings.push(`${label}: empty=true（机械事实；消费该 box 的 B0/B1/W-* 行无法构图，按 spec 机械跳过规则裁定，不静默造 box）`);
    return;
  }
  for (const field of ["x", "y", "width", "height"] as const) {
    const v = box[field];
    if (typeof v !== "number" || !Number.isFinite(v)) { out.push(`${label}.${field} 不是有限数`); return; }
  }
  if (!(box.width > 0 && box.width <= 1 && box.height > 0 && box.height <= 1))
    out.push(`${label}: width/height 必须在 (0,1]（RS slot_box 约束）`);
  const lo = { x: box.x - box.width / 2, y: box.y - box.height / 2 };
  const hi = { x: box.x + box.width / 2, y: box.y + box.height / 2 };
  if (lo.x < -1e-9 || lo.y < -1e-9 || hi.x > 1 + 1e-9 || hi.y > 1 + 1e-9)
    out.push(`${label}: box 越出画布 [0,1]（RS slot_box 会拒绝）`);
}

export interface StructureAudit {
  missing: string[];    // 阻塞项（缺文件/hash 不符/覆盖不全/box 非法）
  warnings: string[];   // 机械事实（empty box 等），不阻塞索引就绪，但消费行构图时会具体报错
}

/**
 * 全量审计。missing 空 = 结构就绪。渲染进行中（case_count<44）时如实列出全部缺失 case。
 */
export function auditStructure(index: StructureIndex, spec: Spec): StructureAudit {
  const missing: string[] = [];
  const warnings: string[] = [];
  const mainCases: string[] = spec.cases.main_40.set;
  const soloCases: string[] = spec.cases.single_4.set;
  const xh = new Set<string>(spec.cases.xh_8.set);

  for (const id of [...mainCases, ...soloCases]) {
    const entry = index.cases[id];
    if (entry === undefined) { missing.push(`结构索引缺 case 条目：${id}（渲染未落盘或未收录）`); continue; }
    if (entry.case_id !== id) missing.push(`${id}: 条目 case_id 不符（${String(entry.case_id)}）`);
    if (entry.status !== "rendered") missing.push(`${id}: status=${String(entry.status)}（要求 rendered；不拿未渲染条目冒充）`);
    const isSolo = Boolean(entry.is_solo);
    if (isSolo !== id.startsWith("SOLO-")) missing.push(`${id}: is_solo=${String(entry.is_solo)} 与 case_id 形态不符`);

    const needFile = (key: StructureFileKey, required: boolean): void => {
      const ref = entry.files?.[key];
      if (ref === undefined) {
        if (required) missing.push(`${id}: files 缺 ${key}`);
        return;
      }
      try {
        const buf = readVerified(index, ref, `${id}.${key}`);
        if (key === "scene.json" && buf.toString("utf8").length > SCENE_CHAR_CAP)
          missing.push(`${id}: scene 内容 ${buf.toString("utf8").length} 字符超过 read_scene 上限 ${SCENE_CHAR_CAP}`);
      } catch (error) {
        missing.push(`${id}: ${key} — ${(error as Error).message}`);
      }
    };

    needFile("scene.json", true);
    needFile("pose_image.png", true);
    needFile("owner_a.png", true);
    needFile("owner_b.png", true);
    if (!isSolo) {
      const needRepair = !xh.has(id); // R 组消费面 = core_32 ∪ m_8（XH 无 R 消费）
      needFile("repair_core.png", needRepair);
      needFile("support.png", needRepair);
      needFile("context.png", needRepair);
      needFile("gray.png", needRepair);
      boxProblems(`${id}.boxes.owner_a`, entry.boxes?.owner_a, missing, warnings);
      boxProblems(`${id}.boxes.owner_b`, entry.boxes?.owner_b, missing, warnings);
      if (!Array.isArray(entry.expected_visible_contacts)) missing.push(`${id}: 缺 expected_visible_contacts（可为空数组，字段必须在）`);
      if (!Array.isArray(entry.expected_out_of_frame_parts)) missing.push(`${id}: 缺 expected_out_of_frame_parts`);
    }
  }

  for (const id of Object.keys(index.cases)) {
    if (!mainCases.includes(id) && !soloCases.includes(id))
      missing.push(`结构索引含未知 case 条目：${id}（不在 main_40 ∪ single_4）`);
  }
  return { missing, warnings };
}
