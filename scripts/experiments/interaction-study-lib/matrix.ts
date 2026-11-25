/**
 * matrix.ts —— spec.matrix 9 组的**机械展开**（不手写 808 表；计数全部程序断言）。
 *
 * 行分两类：sample_kind="new"（新增采样）与 "reuse"（复用/父图引用，不 POST）。
 * 808 是新增采样上限：sum(new 行)==808（P-DC 条件复用在 build 期按实际 graph_hash
 * 相等判定后才把对应行翻成 reuse，见 build.ts；describe 阶段保持 conditional 计数）。
 */
import { createHash } from "node:crypto";
import type { Spec } from "./floor.ts";
import { stageSeed } from "./floor.ts";
import { buildCommonPrompt, buildNegative, buildRegional, characterEntry, loraOf } from "./floor.ts";

export type GroupId = "W-S" | "pose_grid" | "B" | "H" | "R_calib" | "R_repeat" | "P" | "W-RS" | "W-G";

export interface MatrixRow {
  job_id: string;
  group: GroupId;
  case_id: string;
  pair: string | null;
  action: string;
  framing: string;
  seed: number;
  stage: string;
  stage_seed: number;
  /** 方法/变体标识（B0/B1/B2/R1@0.30/…/WRS-A0.8-B0.6/WG-A0.6-B0.8/F0.8/PG-s0.5-e0.7/WS-w0.8）。 */
  method: string;
  /** A/B 槽位或全局权重、denoise 等变体维度（机械事实，供 manifest.weights）。 */
  weights: Record<string, number>;
  /** 结构键：projection case / solo case / parent case（R 组修复结构沿用父 case 的 M 投影）。 */
  structure_case: string;
  sample_kind: "new" | "reuse";
  /** 上游 job（父图 B2 或复用源）；空数组 = 无上游。 */
  depends_on: string[];
  reuse_of: string | null;
  comparison_folders: string[];
}

const wfmt = (w: number): string => (Number.isInteger(w * 10) ? w.toFixed(1) : String(w));

/** 父 B2 job 的 id（R/P/W-RS 复用与 depends_on 的解析目标）。 */
export function b2JobId(caseId: string, seed: number): string {
  return `B__${caseId}__${seed}__B2`;
}

export function expandMatrix(spec: Spec): MatrixRow[] {
  const rows: MatrixRow[] = [];
  const groups = spec.matrix.groups as Record<string, unknown>[];
  const byId = new Map(groups.map((g) => [String(g["id"]), g]));
  const need = (id: GroupId): Record<string, unknown> => {
    const g = byId.get(id);
    if (!g) throw new Error(`spec.matrix.groups 缺少组 ${id}`);
    return g;
  };
  const folders = (g: Record<string, unknown>): string[] => [...(g["comparison_folders"] as string[])];
  const base = (group: GroupId, caseId: string, seed: number, stage: string, method: string,
    weights: Record<string, number>, structureCase: string, g: Record<string, unknown>): MatrixRow => ({
    job_id: "", group, case_id: caseId, pair: caseId.startsWith("SOLO-") ? null : caseId.split("-")[0]!,
    action: caseId.startsWith("SOLO-") ? "STAND" : caseId.split("-")[1]!,
    framing: caseId.startsWith("SOLO-") ? "M" : caseId.split("-")[2]!,
    seed, stage, stage_seed: stageSeed(caseId, seed, stage), method, weights,
    structure_case: structureCase, sample_kind: "new", depends_on: [], reuse_of: null,
    comparison_folders: folders(g),
  });

  // ---- W-S：4 单人 × 3 权重 × 2 seeds = 24 ----
  {
    const g = need("W-S");
    for (const caseId of spec.cases.single_4.set)
      for (const seed of g["seeds"] as number[])
        for (const w of (g["vary"] as { weights: number[] }).weights) {
          const row = base("W-S", caseId, seed, "single", `WS-w${wfmt(w)}`, { lora: w }, caseId, g);
          row.job_id = `WS__${caseId}__${seed}__w${wfmt(w)}`;
          rows.push(row);
        }
  }

  // ---- pose_grid：2 M case × 1 seed × strength{0.5,0.8} × interval{end0.7,end1.0} = 8 ----
  {
    const g = need("pose_grid");
    for (const caseId of spec.cases.pose_grid_cases.set)
      for (const seed of g["seeds"] as number[])
        for (const s of spec.fixed_parameters.pose_lllite.grid.strength)
          for (const iv of spec.fixed_parameters.pose_lllite.grid.interval) {
            const row = base("pose_grid", caseId, seed, "pose_grid", `PG-s${wfmt(s)}-e${wfmt(iv.end)}`,
              { pose_strength: s, pose_start: iv.start, pose_end: iv.end }, caseId, g);
            row.job_id = `PG__${caseId}__${seed}__s${wfmt(s)}__e${wfmt(iv.end)}`;
            rows.push(row);
          }
  }

  // ---- B：core_32 × 3 seeds × {B0,B1,B2} = 288 ----
  {
    const g = need("B");
    for (const caseId of spec.cases.core_32.set)
      for (const seed of g["seeds"] as number[])
        for (const m of (g["vary"] as { methods: string[] }).methods) {
          const row = base("B", caseId, seed, "initial", m,
            { A: (g["weights"] as { A: number }).A, B: (g["weights"] as { B: number }).B }, caseId, g);
          row.job_id = `B__${caseId}__${seed}__${m}`;
          rows.push(row);
        }
  }

  // ---- H：xh_8 × 3 seeds × {B0,B2} = 48 ----
  {
    const g = need("H");
    for (const caseId of spec.cases.xh_8.set)
      for (const seed of g["seeds"] as number[])
        for (const m of (g["vary"] as { methods: string[] }).methods) {
          const row = base("H", caseId, seed, "initial", m, { A: 0.8, B: 0.8 }, caseId, g);
          row.job_id = `H__${caseId}__${seed}__${m}`;
          rows.push(row);
        }
  }

  // ---- R_calib：m_8 × 1 seed × {R1,R2,R3} × denoise{0.30,0.45,0.60} = 72；R0 引用行 ×8 ----
  {
    const g = need("R_calib");
    const v = g["vary"] as { methods: string[]; denoise: number[] };
    for (const caseId of spec.cases.m_8.set)
      for (const seed of g["seeds"] as number[]) {
        const parent = b2JobId(caseId, seed);
        const r0 = base("R_calib", caseId, seed, "repair_grid", "R0", {}, caseId, g);
        r0.job_id = `R0__${caseId}__${seed}`;
        r0.sample_kind = "reuse"; r0.reuse_of = parent; r0.depends_on = [parent];
        rows.push(r0);
        for (const m of v.methods)
          for (const d of v.denoise) {
            const row = base("R_calib", caseId, seed, "repair_grid", `${m}@${d.toFixed(2)}`,
              { A: 0.8, B: 0.8, denoise: d }, caseId, g);
            row.job_id = `Rc__${caseId}__${seed}__${m}__d${d.toFixed(2)}`;
            row.depends_on = [parent];
            rows.push(row);
          }
      }
  }

  // ---- R_repeat：core_32 × 2 holdout seeds × {R1@0.45,R3@0.45} = 128；R0 引用行 ×64 ----
  {
    const g = need("R_repeat");
    for (const caseId of spec.cases.core_32.set)
      for (const seed of g["seeds"] as number[]) {
        const parent = b2JobId(caseId, seed);
        const r0 = base("R_repeat", caseId, seed, "repair_repeat", "R0", {}, caseId, g);
        r0.job_id = `R0__${caseId}__${seed}`;
        r0.sample_kind = "reuse"; r0.reuse_of = parent; r0.depends_on = [parent];
        rows.push(r0);
        for (const m of ["R1", "R3"]) {
          const row = base("R_repeat", caseId, seed, "repair_repeat", `${m}@0.45`,
            { A: 0.8, B: 0.8, denoise: 0.45 }, caseId, g);
          row.job_id = `Rr__${caseId}__${seed}__${m}__d0.45`;
          row.depends_on = [parent];
          rows.push(row);
        }
      }
  }

  // ---- P：m_8 × 1 seed × {P1,P2} = 16（DC P2 条件复用，build 期按 graph_hash 判定） ----
  {
    const g = need("P");
    for (const caseId of spec.cases.m_8.set)
      for (const seed of g["seeds"] as number[])
        for (const m of ["P1", "P2"]) {
          const row = base("P", caseId, seed, "pass", m, { denoise: spec.fixed_parameters.p_pass.denoise, A: 0.8, B: 0.8 }, caseId, g);
          row.job_id = `P__${caseId}__${seed}__${m}`;
          row.depends_on = [b2JobId(caseId, seed)];
          rows.push(row);
        }
  }

  // ---- W-RS：m_8 × 2 seeds × 3×3 = 144 refs；(0.8,0.8) 16 项 = reuse of B2；128 new ----
  {
    const g = need("W-RS");
    const grid = (g["vary"] as { grid_A: number[] }).grid_A;
    for (const caseId of spec.cases.m_8.set)
      for (const seed of g["seeds"] as number[])
        for (const wa of grid)
          for (const wb of grid) {
            const row = base("W-RS", caseId, seed, "initial", `WRS-A${wfmt(wa)}-B${wfmt(wb)}`,
              { A: wa, B: wb }, caseId, g);
            row.job_id = `WRS__${caseId}__${seed}__A${wfmt(wa)}__B${wfmt(wb)}`;
            if (wa === 0.8 && wb === 0.8) {
              const parent = b2JobId(caseId, seed);
              row.sample_kind = "reuse"; row.reuse_of = parent; row.depends_on = [parent];
            }
            rows.push(row);
          }
  }

  // ---- W-G：DC 4 动作×2 seeds×3×3=72；QG 文件级 4×2×3=24；合计 96。等权对角线(0.8,0.8)
  //      与 B2 同 seed（stage 均为 initial）但图结构不同（全局 LoRA+原生 LLLite vs RS 路由），
  //      不是复用：spec W-G 计数 96 全部为 new。QG 仅文件级权重，无异权等价组。 ----
  {
    const g = need("W-G");
    const grid = [0.6, 0.8, 1.0];
    for (const caseId of spec.cases.m_8.set)
      for (const seed of g["seeds"] as number[]) {
        const pair = caseId.split("-")[0]!;
        if (pair === "DC") {
          for (const wa of grid)
            for (const wb of grid) {
              const row = base("W-G", caseId, seed, "initial", `WG-A${wfmt(wa)}-B${wfmt(wb)}`,
                { A: wa, B: wb }, caseId, g);
              row.job_id = `WG__${caseId}__${seed}__A${wfmt(wa)}__B${wfmt(wb)}`;
              rows.push(row);
            }
        } else if (pair === "QG") {
          for (const w of grid) {
            const row = base("W-G", caseId, seed, "initial", `WG-F${wfmt(w)}`, { file: w }, caseId, g);
            row.job_id = `WG__${caseId}__${seed}__F${wfmt(w)}`;
            rows.push(row);
          }
        } else throw new Error(`W-G 出现未知 pair ${pair}`);
      }
  }

  // job_id 全局唯一
  const seen = new Set<string>();
  for (const r of rows) {
    if (seen.has(r.job_id)) throw new Error(`job_id 重复：${r.job_id}`);
    seen.add(r.job_id);
  }
  return rows;
}

/** 机械计数断言：spec 各组 count 与展开一致，new 行加和 == 808。 */
export function assertCounts(spec: Spec, rows: MatrixRow[]): Record<string, unknown> {
  const perGroup: Record<string, { spec_count: number; new: number; reuse: number; refs?: number }> = {};
  for (const g of spec.matrix.groups as Record<string, unknown>[]) {
    const id = String(g["id"]) as GroupId;
    const mine = rows.filter((r) => r.group === id);
    const news = mine.filter((r) => r.sample_kind === "new").length;
    const reuse = mine.filter((r) => r.sample_kind === "reuse").length;
    const specCount = Number(g["count"]);
    if (id === "W-RS") {
      const refs = Number(g["refs"]);
      if (mine.length !== refs) throw new Error(`W-RS 行数 ${mine.length} != spec refs ${refs}`);
      if (reuse !== Number(g["reuse_count"])) throw new Error(`W-RS 复用行 ${reuse} != spec ${g["reuse_count"]}`);
      if (news !== specCount) throw new Error(`W-RS new ${news} != spec count ${specCount}`);
      perGroup[id] = { spec_count: specCount, new: news, reuse, refs };
    } else if (id === "R_calib" || id === "R_repeat") {
      // spec count 只计新增采样；R0 引用行额外存在（reuse_rules R0，sample:false）
      const r0 = mine.filter((r) => r.method === "R0").length;
      if (news !== specCount) throw new Error(`${id} new ${news} != spec count ${specCount}`);
      if (r0 !== reuse) throw new Error(`${id} R0 行 ${r0} != reuse 行 ${reuse}`);
      perGroup[id] = { spec_count: specCount, new: news, reuse };
    } else {
      if (news !== specCount) throw new Error(`${id} new ${news} != spec count ${specCount}`);
      if (id !== "P" && reuse !== 0) throw new Error(`${id} 不应有 reuse 行（got ${reuse}）`);
      perGroup[id] = { spec_count: specCount, new: news, reuse };
    }
  }
  const totalNew = rows.filter((r) => r.sample_kind === "new").length;
  const expected = Number(spec.matrix.total_new_samples);
  const budgetCheck = Number(spec.matrix.budget_check.expected);
  if (expected !== budgetCheck) throw new Error(`spec 预算自不一致：${expected} vs ${budgetCheck}`);
  if (totalNew > expected) throw new Error(`新增采样行 ${totalNew} 超过上限 ${expected}`);
  const sum = (spec.matrix.groups as Record<string, unknown>[]).reduce((a, g) => a + Number(g["count"]), 0);
  if (sum !== budgetCheck) throw new Error(`spec 各组 count 加和 ${sum} != ${budgetCheck}`);
  return {
    total_rows: rows.length, total_new: totalNew,
    total_reuse: rows.filter((r) => r.sample_kind === "reuse").length,
    budget_max_new_samples: expected, budget_respected: totalNew <= expected,
    per_group: perGroup,
  };
}

/** describe 用：每 case 的提示词组合（机械可复核；不写盘）。 */
export function describePrompts(spec: Spec): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const c of spec.cases.main_40.set) {
    const [pair, action, framing] = c.split("-") as [string, string, string];
    const inst = spec.semantics.pair.instances[pair] as { A: string; B: string };
    out[c] = {
      action,
      common: buildCommonPrompt(spec, pair, action, framing),
      negative: buildNegative(),
      slot1: { character: inst.A, regional: buildRegional(spec, inst.A, "A", action) },
      slot2: { character: inst.B, regional: buildRegional(spec, inst.B, "B", action) },
    };
  }
  for (const c of spec.cases.single_4.set) {
    const key = c.slice("SOLO-".length);
    out[c] = { common: buildCommonPrompt(spec, null, "STAND", "M"), negative: buildNegative(),
      solo_inject: characterEntry(spec, key).inject, lora: loraOf(spec, key).comfyRelativePath };
  }
  return out;
}

export const sha256 = (s: string): string => createHash("sha256").update(s).digest("hex");
