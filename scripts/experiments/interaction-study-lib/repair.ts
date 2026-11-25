/**
 * repair.ts —— R 组新接口依赖（计划 §8.1「R 接口修正」，2026-11-11）：
 * T2c 局部接触组 repair-v2 索引 + T4c YugangRepairMaskFalloff 节点源的存在性/真实性核验。
 *
 * 背景（主会话亲读确认）：T2b 证明旧 support 是全身 union 膨胀、非局部接触组，native gray
 * 经 crop 后的 8% 环未证实。R 不放行旧域：core/support/context 一律取自
 * `inputs/repair-v2/repair_index.json`（schema `yugang.anima-interaction-v1.structure.repair_index`，
 * 条目与 structure_index 的 case files 同形态：files.<name>.{path(repo-root 相对), sha256}）。
 *
 * 硬规则：
 * - R 行构图前，repair_index 与该 case 的 core/support/context 三件必须真实存在且实字节 sha
 *   相符，且 Falloff 节点源必须真实存在于 experiments/anima-interaction-v1/（custom_nodes 或
 *   patches）；缺任一项 → R 行**明确拒构**（具体缺项），绝不偷退旧全身域、绝不假节点。
 * - B/H/W/pose_grid/W-S 不被 R 缺项阻断（build.ts 按组隔离）。
 * - 逻辑文件名的键名匹配是容错的（core.png / repair_core.png / core 等拼法），命中后把
 *   **实际键名**记入 provenance；无命中 = 缺项，不猜。
 */
import { createHash } from "node:crypto";
import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { isAbsolute, join } from "node:path";
import type { Spec } from "./floor.ts";

export const REPAIR_INDEX_SCHEMA = "yugang.anima-interaction-v1.structure.repair_index";
/** §8.1 冻结：ring = round(min(H,W) * 0.08)（768 → 61px）。 */
export const RING_FRACTION = 0.08;
export const FALLOFF_NODE_CLASS = "YugangRepairMaskFalloff";

export interface RepairFileRef { path: string; sha256: string }

export interface RepairCase {
  case_id: string;
  status?: string;
  files: Record<string, RepairFileRef>;
  [k: string]: unknown;
}

export interface RepairIndex {
  schema: string;
  version?: number;
  index_file: string;   // 绝对路径
  index_sha256: string;
  repoRoot: string;
  cases: Record<string, RepairCase>;
}

export function repairIndexCandidates(runRoot: string, repoRoot: string): string[] {
  return [
    join(runRoot, "inputs", "repair-v2", "repair_index.json"),
    join(repoRoot, "experiments", "anima-interaction-v1", "structure", "repair-v2", "repair_index.json"),
  ];
}

export function loadRepairIndex(runRoot: string, repoRoot: string): RepairIndex {
  const candidates = repairIndexCandidates(runRoot, repoRoot);
  const file = candidates.find((c) => existsSync(c));
  if (file === undefined)
    throw new Error(`repair-v2 索引不存在（T2c 未落盘）。已尝试：${candidates.join("；")}`);
  const raw = readFileSync(file);
  const parsed = JSON.parse(raw.toString("utf8")) as Record<string, unknown>;
  if (parsed["schema"] !== REPAIR_INDEX_SCHEMA)
    throw new Error(`repair_index schema 不符：${file} 声明 ${String(parsed["schema"])}，要求 ${REPAIR_INDEX_SCHEMA}`);
  const cases = parsed["cases"];
  if (cases === null || typeof cases !== "object" || Array.isArray(cases))
    throw new Error(`repair_index.cases 必须是 case_id → 条目 的对象：${file}`);
  return {
    schema: REPAIR_INDEX_SCHEMA,
    version: typeof parsed["version"] === "number" ? parsed["version"] : undefined,
    index_file: file,
    index_sha256: createHash("sha256").update(raw).digest("hex"),
    repoRoot,
    cases: cases as Record<string, RepairCase>,
  };
}

export function repairAbsPath(index: RepairIndex, ref: RepairFileRef): string {
  return isAbsolute(ref.path) ? ref.path : join(index.repoRoot, ref.path);
}

/** 读文件并核对实字节 sha256（与 structure.readVerified 同语义）。 */
export function readRepairVerified(index: RepairIndex, ref: RepairFileRef, what: string): Buffer {
  const abs = repairAbsPath(index, ref);
  let buf: Buffer;
  try {
    buf = readFileSync(abs);
  } catch {
    throw new Error(`${what}: 文件不存在 ${abs}（索引声明 sha256=${ref.sha256}）`);
  }
  if (!/^[0-9a-f]{64}$/.test(ref.sha256 ?? ""))
    throw new Error(`${what}: 索引 sha256 字段不是 64hex（${String(ref.sha256)}）`);
  const actual = createHash("sha256").update(buf).digest("hex");
  if (actual !== ref.sha256)
    throw new Error(`${what}: sha256 不符 ${abs} 实际 ${actual}，索引声明 ${ref.sha256}`);
  return buf;
}

const LOGICAL_KEYS: Record<"core" | "support" | "context", string[]> = {
  core: ["core.png", "repair_core.png", "core"],
  support: ["support.png", "repair_support.png", "support"],
  context: ["context.png", "repair_context.png", "context"],
};

/**
 * 逻辑名 → 实际 files 键（先精确候选，再唯一后缀匹配；命中键名如实返回，不猜路径）。
 * 返回 null = 该 case 无此逻辑文件。
 */
export function resolveRepairFile(entry: RepairCase, logical: "core" | "support" | "context"):
  { keyName: string; ref: RepairFileRef } | null {
  const files = entry.files ?? {};
  for (const cand of LOGICAL_KEYS[logical])
    if (files[cand]) return { keyName: cand, ref: files[cand]! };
  const hits = Object.keys(files).filter((k) => k.toLowerCase().includes(logical) && /\.(png|webp)$/i.test(k));
  if (hits.length === 1) return { keyName: hits[0]!, ref: files[hits[0]!]! };
  if (hits.length > 1)
    throw new Error(`repair case ${entry.case_id}: 逻辑名 ${logical} 命中多个键 [${hits.join(", ")}]，拒绝猜测；请 T2c 规范键名`);
  return null;
}

/** Falloff 节点源存在性：experiments/anima-interaction-v1/{custom_nodes,patches} 内文本搜索类名。 */
export function findFalloffSource(repoRoot: string): string[] {
  const roots = [
    join(repoRoot, "experiments", "anima-interaction-v1", "custom_nodes"),
    join(repoRoot, "experiments", "anima-interaction-v1", "patches"),
  ];
  const hits: string[] = [];
  const walk = (dir: string): void => {
    let entries: string[];
    try { entries = readdirSync(dir); } catch { return; }
    for (const name of entries) {
      const p = join(dir, name);
      let st;
      try { st = statSync(p); } catch { continue; }
      if (st.isDirectory()) { walk(p); continue; }
      if (!/\.(py|patch|json|md)$/i.test(name)) continue;
      try {
        if (readFileSync(p, "utf8").includes(FALLOFF_NODE_CLASS)) hits.push(p);
      } catch { /* 二进制/不可读忽略 */ }
    }
  };
  for (const r of roots) walk(r);
  return hits;
}

export interface RepairDepsState {
  ready: boolean;
  missing: string[];
  index: RepairIndex | null;
  falloffSourceFiles: string[];
}

/**
 * R 依赖全量核验：索引 + 全部 R 消费面 case（core_32 ⊇ m_8；R_calib=m_8@seed11、
 * R_repeat=core_32@seed12/13）三件齐 + 实字节 sha + Falloff 节点源存在。
 * 返回缺项清单；ready=false 时 build.ts 拒构全部 R 行（B/H/W/WS 不受影响）。
 */
export function auditRepairDeps(runRoot: string, repoRoot: string, spec: Spec): RepairDepsState {
  const missing: string[] = [];
  let index: RepairIndex | null = null;
  try {
    index = loadRepairIndex(runRoot, repoRoot);
  } catch (error) {
    missing.push(String((error as Error).message));
  }
  const falloffSourceFiles = findFalloffSource(repoRoot);
  if (falloffSourceFiles.length === 0)
    missing.push(`${FALLOFF_NODE_CLASS} 节点源不存在（T4c 未落盘）：搜索了 experiments/anima-interaction-v1/{custom_nodes,patches}`);

  if (index) {
    const rCases = new Set<string>(spec.cases.core_32.set); // R 消费面 = core_32（m_8 ⊂ core_32）
    for (const id of [...rCases].sort()) {
      const entry = index.cases[id];
      if (!entry) { missing.push(`repair_index 缺 case 条目：${id}`); continue; }
      if (entry.status !== undefined && entry.status !== "rendered")
        missing.push(`repair_index case ${id}: status=${String(entry.status)}（要求 rendered）`);
      for (const logical of ["core", "support", "context"] as const) {
        let resolved;
        try {
          resolved = resolveRepairFile(entry, logical);
        } catch (error) {
          missing.push(`${id}: ${(error as Error).message}`);
          continue;
        }
        if (!resolved) { missing.push(`repair_index case ${id}: 缺逻辑文件 ${logical}`); continue; }
        try {
          readRepairVerified(index, resolved.ref, `repair_index ${id}.${logical}(${resolved.keyName})`);
        } catch (error) {
          missing.push(`${id}.${logical}: ${(error as Error).message}`);
        }
      }
    }
    for (const id of Object.keys(index.cases))
      if (!rCases.has(id)) missing.push(`repair_index 含未知 case 条目：${id}（不在 core_32）`);
  }
  return { ready: missing.length === 0, missing, index, falloffSourceFiles };
}
