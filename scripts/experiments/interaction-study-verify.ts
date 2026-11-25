#!/usr/bin/env node
/**
 * interaction-study-verify.ts —— anima-interaction-v1 离线统一 AUTO 验收模块（T3v）。
 *
 * 权威依据：docs/plans/2026-11-11-anima-interaction-study.md §9（F1–F10）与 §8.1；
 * 冻结契约 spec.json / preflight.json（run-root 权威副本）；contracts/runner.md 与
 * interaction-study-run.py 的真实 state/results/generation-info schema；尚未落盘产物的
 * 字段契约见 contracts/verify.md（本模块配套文档）。
 *
 * 入口：export async runVerifyCommand(ctx:{repoRoot,runRoot,argv})；T3a 把
 * `interaction-study.ts verify` 接到这里。根路径只认 ctx（或 src/paths.ts::REPO_ROOT
 * 的直启回退），不按 cwd 拼。
 *
 * 诚实规则（硬约束）：
 * - 不把未存在的未来产物当通过：缺文件/缺字段一律 failed 并列具体理由；不伪造
 *   reviews/user-feedback/closure/delivery。
 * - F8 是 MANUAL：无主人明确反馈 = pending-user；--auto 下不阻塞 exit 0；--all 下只有
 *   user-feedback.jsonl 契约形态的明确确认才 passed，绝不代填。
 * - F9 只等真实独立 T8 审计（reviews/delivery-audit.json）：本模块不生成审计，也绝不读
 *   acceptance.json 自证（acceptance.json 只写不读）。
 * - 区分「真实执行错误」（有 prompt_id/submitted-graph/4xx 拒单实证）与「整族从没跑通」
 *   （零记录/零提交痕迹 → 研究阻塞候选）；不允许用 error/skip 行填满冒充已测。
 * - 任何 fail → 非零 exit；内部异常 → exit 2，绝不以异常路径产生 pass。
 * - 不评分、不选优、不判图：图片只做解码/尺寸/hash/像素值域等机械核验。
 * - 凭据扫描只安全模式：绝不读 .env / config/auth.json / config/models.json /
 *   var/fish.db / fish.config.json；64hex 资产 hash 是合法证据形态，不当密钥误报。
 * - 已知 R 风险不静默放宽（主会话 2026-11-11 补充事实）：旧 support=全 body union、
 *   native ring 61（有效 60）resize 后不得自动宣称 crop-space 8%、scene_info 的
 *   controlnet_used=false 不等于运行期 LLLite 未 applied。R 的最终放行只认
 *   inputs/repair-v2/repair_index.json（T2c）+ YugangRepairMaskFalloff（T4c）的
 *   falloff_info + noise audit + T3c 修正后的最终 manifest；缺项如实 failed。
 * - W-S 的 metadata_node_ids=[] 是如实 core 管线形态，不强迫假 generation_info；
 *   权重/模型/采样器核对走 submitted-graph + history 原证。
 *
 * PNG 解码：仓库无 sharp（缺依赖不擅装），用 node:zlib 自含解码（chunk CRC + inflate +
 * unfilter；8-bit 非隔行；不支持形态如实报 decode error）——真解码，不是只看 PNG 头。
 */
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, readFileSync, readdirSync, renameSync, statSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, isAbsolute, join, relative, resolve } from "node:path";
import { inflateSync } from "node:zlib";

import { REPO_ROOT } from "../../src/paths.ts";
import {
  ASSET_KEYS, assetBinding, loadPreflight, loadSpec, sha256Bytes, stageSeed,
  type Preflight, type Spec,
} from "./interaction-study-lib/floor.ts";
import { b2JobId, expandMatrix, type MatrixRow } from "./interaction-study-lib/matrix.ts";
import {
  auditStructure, loadStructureIndex, structureAbsPath,
  type StructureAudit, type StructureIndex,
} from "./interaction-study-lib/structure.ts";

// ---------------------------------------------------------------------------
// 常量（全部来自计划 §13 / 真实证据文件里已记录的事实；运行时仍与证据交叉核对）
// ---------------------------------------------------------------------------

export const CRITERION_IDS = ["F1", "F2", "F3", "F4", "F5", "F6", "F7", "F8", "F9", "F10"] as const;
export type CriterionId = (typeof CRITERION_IDS)[number];
export type CriterionStatus = "passed" | "failed" | "pending-user";
export type VerifyMode = "auto" | "all" | "criterion";

export interface CriterionResult {
  id: CriterionId;
  type: "AUTO" | "MANUAL";
  status: CriterionStatus;
  reasons: string[];      // failed/pending 的具体理由（passed 时可含机械说明）
  evidence: string[];     // 证据路径（相对 run-root / repo-root 显示）
  details: Record<string, unknown>;
}

/** G0c 专项热开关提交（计划 §13 与 hot-switch-release.json 记录；F7 与活 git 交叉核对）。 */
const HOT_COMMIT = "5b1f4486bb09819e9641bcdce75cdad4c2b9dca9";
const HOT_PARENT = "9c55e8d7868e567afd44ba2af4e726c46ce44c19";
const EXCLUDED_COMMIT = "14d29a18eca4cd90dd55c33419e4a7741a1b3297";
const HOT_TEN_PATHS = [
  "AGENTS.md", "fish.config.example", "src/app/runtime.ts", "src/fish-config.ts",
  "src/fish/tool-surface.ts", "src/fish/types.ts", "src/tools/config/TOOL.md",
  "src/tools/draw/messages.json", "src/tools/draw/tool.ts", "src/tools/types.ts",
];

/** runner（interaction-study-run.py）冻结的状态机口径。 */
const CLOSED_STATES = new Set(["success", "execution_error", "reuse_resolved", "skipped_mechanical"]);
const OPEN_STATES = new Set(["submitting", "accepted", "running", "unknown", "observation_timeout", "unresolved"]);

/** spec.fixed_parameters.rs_routing 的 requested 值（F3/F5 用它核 effective，不许 fallback）。 */
const RS_REQUESTED = { layout_method: "regional", lora_application_mode: "precision" };

/** T3c 契约：R 组最终输出 = Stitch 贴回后的原生画布。 */
const R_OUTPUT_WIDTH = 1024;
const R_OUTPUT_HEIGHT = 768;

const MANIFEST_SCHEMA = "anima-interaction-manifest.v1";
const ACCEPTANCE_SCHEMA = "yugang.anima-interaction-v1.acceptance.v1";

// ---------------------------------------------------------------------------
// 小工具：hash / JSON / JSONL / 路径显示 / 有界理由收集
// ---------------------------------------------------------------------------

const sha256Buf = (b: Buffer | string): string => createHash("sha256").update(b).digest("hex");

function sha256File(path: string): string | null {
  try { return sha256Buf(readFileSync(path)); } catch { return null; }
}

interface JsonOk { ok: true; value: any; path: string }
interface JsonErr { ok: false; error: string; path: string }
function readJson(path: string): JsonOk | JsonErr {
  try {
    const raw = readFileSync(path);
    return { ok: true, value: JSON.parse(raw.toString("utf8")), path };
  } catch (e) {
    return { ok: false, error: (e as Error).message, path };
  }
}

function readJsonl(path: string): { rows: any[]; error: string | null } {
  try {
    const text = readFileSync(path, "utf8");
    const rows: any[] = [];
    const bad: string[] = [];
    text.split("\n").forEach((line, i) => {
      const t = line.trim();
      if (!t) return;
      try { rows.push(JSON.parse(t)); } catch { bad.push(`第 ${i + 1} 行不是合法 JSON`); }
    });
    return { rows, error: bad.length ? bad.slice(0, 5).join("；") : null };
  } catch (e) { return { rows: [], error: (e as Error).message }; }
}

const isHex64 = (s: unknown): s is string => typeof s === "string" && /^[0-9a-f]{64}$/.test(s);

/** 从叙事字符串提取全部 64hex（证据文件常用「hash (note)」形态）。 */
function extractHex64(text: string): string[] {
  return text.match(/^[0-9a-f]{64}$|[0-9a-f]{64}/g) ?? [];
}

/** 有界理由/证据收集器：fail 消息不无限增长，evidence 去重。 */
class Findings {
  reasons: string[] = [];
  evidence: string[] = [];
  details: Record<string, unknown> = {};
  truncated = false;
  private readonly reasonCap: number;
  constructor(reasonCap = 300) { this.reasonCap = reasonCap; }
  fail(msg: string): void {
    if (this.reasons.length < this.reasonCap) this.reasons.push(msg);
    else this.truncated = true;
  }
  ev(...paths: (string | null | undefined)[]): void {
    for (const p of paths) {
      if (!p) continue;
      if (!this.evidence.includes(p) && this.evidence.length < 80) this.evidence.push(p);
    }
  }
  get ok(): boolean { return this.reasons.length === 0; }
  note(key: string, value: unknown): void { this.details[key] = value; }
}

// ---------------------------------------------------------------------------
// PNG 真解码（node:zlib 自含实现；CRC 校验 + inflate + unfilter；8-bit 非隔行）
// ---------------------------------------------------------------------------

const PNG_MAGIC = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

const CRC_TABLE = (() => {
  const t = new Int32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c;
  }
  return t;
})();

function crc32(buf: Buffer): number {
  let c = 0xffffffff;
  for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]!) & 0xff]! ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

export interface PngImage {
  width: number; height: number; colorType: number; channels: number;
  /** row-major，每像素 channels 字节（palette 已展开为 RGB）。 */
  pixels: Buffer;
}
export type PngDecode = { ok: true; image: PngImage } | { ok: false; error: string };

const CHANNELS: Record<number, number> = { 0: 1, 2: 3, 3: 1, 4: 2, 6: 4 };

export function decodePng(buf: Buffer): PngDecode {
  if (buf.length < 8 || !buf.subarray(0, 8).equals(PNG_MAGIC)) return { ok: false, error: "不是 PNG（魔数不符）" };
  let off = 8;
  let ihdr: { width: number; height: number; bitDepth: number; colorType: number; interlace: number } | null = null;
  let plte: Buffer | null = null;
  const idat: Buffer[] = [];
  while (off + 12 <= buf.length) {
    const len = buf.readUInt32BE(off);
    const type = buf.subarray(off + 4, off + 8).toString("latin1");
    const data = buf.subarray(off + 8, off + 8 + len);
    const crc = buf.readUInt32BE(off + 8 + len);
    if (crc32(buf.subarray(off + 4, off + 8 + len)) !== crc) return { ok: false, error: `chunk ${type} CRC 不符（数据损坏）` };
    if (type === "IHDR") {
      ihdr = { width: data.readUInt32BE(0), height: data.readUInt32BE(4), bitDepth: data[8]!, colorType: data[9]!, interlace: data[12]! };
    } else if (type === "PLTE") plte = Buffer.from(data);
    else if (type === "IDAT") idat.push(Buffer.from(data));
    else if (type === "IEND") break;
    off += 12 + len;
  }
  if (!ihdr) return { ok: false, error: "缺 IHDR" };
  if (ihdr.bitDepth !== 8) return { ok: false, error: `不支持的位深 ${ihdr.bitDepth}（本核验只支持 8-bit；如实报，不猜）` };
  if (ihdr.interlace !== 0) return { ok: false, error: "不支持隔行（Adam7）PNG" };
  const ct = ihdr.colorType;
  if (CHANNELS[ct] === undefined) return { ok: false, error: `未知 colorType ${ct}` };
  if (ct === 3 && !plte) return { ok: false, error: "palette PNG 缺 PLTE" };
  if (!idat.length) return { ok: false, error: "缺 IDAT" };
  let raw: Buffer;
  try { raw = inflateSync(Buffer.concat(idat)); } catch (e) { return { ok: false, error: `IDAT inflate 失败：${(e as Error).message}` }; }

  const srcCh = CHANNELS[ct]!;
  const { width, height } = ihdr;
  const stride = width * srcCh;
  if (raw.length < height * (stride + 1)) return { ok: false, error: `解压数据长度不足（${raw.length} < ${height * (stride + 1)}）` };
  const recon = Buffer.alloc(height * stride);
  for (let y = 0; y < height; y++) {
    const f = raw[y * (stride + 1)]!;
    const line = raw.subarray(y * (stride + 1) + 1, (y + 1) * (stride + 1));
    const prev = y > 0 ? recon.subarray((y - 1) * stride, y * stride) : null;
    const cur = recon.subarray(y * stride, (y + 1) * stride);
    for (let x = 0; x < stride; x++) {
      const a = x >= srcCh ? cur[x - srcCh]! : 0;
      const b = prev ? prev[x]! : 0;
      const c = prev && x >= srcCh ? prev[x - srcCh]! : 0;
      let v = line[x]!;
      if (f === 1) v += a;
      else if (f === 2) v += b;
      else if (f === 3) v += (a + b) >> 1;
      else if (f === 4) {
        const p = a + b - c;
        const pa = Math.abs(p - a), pb = Math.abs(p - b), pc = Math.abs(p - c);
        v += pa <= pb && pa <= pc ? a : pb <= pc ? b : c;
      } else if (f !== 0) return { ok: false, error: `行 ${y} 未知 filter ${f}` };
      cur[x] = v & 0xff;
    }
  }
  if (ct === 3) {
    const out = Buffer.alloc(width * height * 3);
    for (let i = 0; i < width * height; i++) {
      const idx = recon[i]! * 3;
      out[i * 3] = plte[idx] ?? 0; out[i * 3 + 1] = plte[idx + 1] ?? 0; out[i * 3 + 2] = plte[idx + 2] ?? 0;
    }
    return { ok: true, image: { width, height, colorType: ct, channels: 3, pixels: out } };
  }
  return { ok: true, image: { width, height, colorType: ct, channels: srcCh, pixels: recon } };
}

/** 像素值 = 各通道最大（灰度 mask 即自身；RGB 黑白 mask 也适用）。 */
function px(img: PngImage, x: number, y: number): number {
  const o = (y * img.width + x) * img.channels;
  let m = 0;
  for (let k = 0; k < img.channels; k++) m = Math.max(m, img.pixels[o + k]!);
  return m;
}

interface Bbox { x0: number; y0: number; x1: number; y1: number; count: number }
/** 非零像素 bbox（含计数）；全零返回 null。 */
function nonzeroBbox(img: PngImage): Bbox | null {
  let x0 = img.width, y0 = img.height, x1 = -1, y1 = -1, count = 0;
  for (let y = 0; y < img.height; y++)
    for (let x = 0; x < img.width; x++)
      if (px(img, x, y) > 0) { count++; if (x < x0) x0 = x; if (x > x1) x1 = x; if (y < y0) y0 = y; if (y > y1) y1 = y; }
  return count === 0 ? null : { x0, y0, x1, y1, count };
}

/** 是否所有采样值都在集合内（owner 二值 = {0,255}）。 */
function allSamplesIn(img: PngImage, allowed: number[]): boolean {
  const set = new Set(allowed);
  for (let i = 0; i < img.pixels.length; i++) if (!set.has(img.pixels[i]!)) return false;
  return true;
}

/** bbox A 是否包含在 bbox B 外扩 pad 像素内（null bbox 视为空集，恒真）。 */
function bboxWithin(a: Bbox | null, b: Bbox | null, pad: number): boolean {
  if (!a) return true;
  if (!b) return false;
  return a.x0 >= b.x0 - pad && a.y0 >= b.y0 - pad && a.x1 <= b.x1 + pad && a.y1 <= b.y1 + pad;
}

// ---------------------------------------------------------------------------
// git（只读；AGENTS 规则：优先 git1，不可用回退 git）
// ---------------------------------------------------------------------------

function gitRun(repoRoot: string, args: string[]): { ok: boolean; stdout: string; status: number | null; error: string } {
  for (const bin of ["git1", "git"]) {
    const r = spawnSync(bin, args, { cwd: repoRoot, encoding: "utf8", timeout: 30_000 });
    if (r.error && (r.error as NodeJS.ErrnoException).code === "ENOENT") continue; // 该 bin 不存在，试下一个
    if (r.error) return { ok: false, stdout: "", status: null, error: r.error.message };
    return { ok: r.status === 0, stdout: (r.stdout ?? "").trim(), status: r.status, error: (r.stderr ?? "").trim() };
  }
  return { ok: false, stdout: "", status: null, error: "git1 与 git 都不可用" };
}

// ---------------------------------------------------------------------------
// 共享上下文：一次性载入全部真实证据（每个来源独立 try/catch，缺项如实记录）
// ---------------------------------------------------------------------------

interface GraphCacheEntry { bytes: Buffer | null; sha256: string | null; json: any | null; error: string | null }

interface VerifyShared {
  repoRoot: string;
  runRoot: string;
  spec: Spec | null; specError: string | null; specPath: string; specSha: string | null;
  preflight: Preflight | null; preflightError: string | null; preflightPath: string; preflightSha: string | null;
  manifest: any | null; manifestError: string | null; manifestPath: string; manifestSha: string | null;
  manifestJobs: Map<string, any>;
  expanded: MatrixRow[] | null; expandedError: string | null;
  results: Map<string, any[]>; resultsError: string | null;
  stageManifest: any | null; stageManifestError: string | null; stageDir: string;
  stageResults: Map<string, any[]>; stageResultsError: string | null;
  state: any | null; stateError: string | null;
  structure: StructureIndex | null; structureError: string | null; structureAudit: StructureAudit | null;
  sourceIndex: any | null; sourceIndexError: string | null;
  renderVerify: any | null;
  repairV2: any | null; repairV2Error: string | null;
  lease: any | null; leaseError: string | null;
  gateG0: any | null; rawStatus: any | null; rawQueue: any | null; g0Recheck: any | null;
  graphs: Map<string, GraphCacheEntry>;
}

function jsonlByJob(path: string): { map: Map<string, any[]>; error: string | null } {
  const map = new Map<string, any[]>();
  const { rows, error } = readJsonl(path);
  for (const r of rows) {
    const jid = typeof r?.job_id === "string" ? r.job_id : null;
    if (!jid) continue;
    const arr = map.get(jid) ?? [];
    arr.push(r);
    map.set(jid, arr);
  }
  return { map, error };
}

function buildShared(repoRoot: string, runRoot: string): VerifyShared {
  const s: VerifyShared = {
    repoRoot, runRoot,
    spec: null, specError: null, specPath: join(runRoot, "spec.json"), specSha: null,
    preflight: null, preflightError: null, preflightPath: join(runRoot, "preflight.json"), preflightSha: null,
    manifest: null, manifestError: null, manifestPath: join(runRoot, "manifest.json"), manifestSha: null,
    manifestJobs: new Map(),
    expanded: null, expandedError: null,
    results: new Map(), resultsError: null,
    stageManifest: null, stageManifestError: null, stageDir: join(runRoot, "stages", "w-s-smoke"),
    stageResults: new Map(), stageResultsError: null,
    state: null, stateError: null,
    structure: null, structureError: null, structureAudit: null,
    sourceIndex: null, sourceIndexError: null,
    renderVerify: null,
    repairV2: null, repairV2Error: null,
    lease: null, leaseError: null,
    gateG0: null, rawStatus: null, rawQueue: null, g0Recheck: null,
    graphs: new Map(),
  };
  s.specSha = sha256File(s.specPath);
  try { const r = loadSpec(runRoot, repoRoot); s.spec = r.spec; s.specPath = r.path; s.specSha = sha256Bytes(r.raw); }
  catch (e) { s.specError = (e as Error).message; }
  s.preflightSha = sha256File(s.preflightPath);
  try { const r = loadPreflight(runRoot); s.preflight = r.preflight; s.preflightPath = r.path; s.preflightSha = sha256Bytes(r.raw); }
  catch (e) { s.preflightError = (e as Error).message; }
  const mj = readJson(s.manifestPath);
  if (mj.ok) {
    s.manifest = mj.value; s.manifestSha = sha256File(s.manifestPath);
    if (Array.isArray(mj.value?.jobs)) for (const j of mj.value.jobs) if (typeof j?.job_id === "string") s.manifestJobs.set(j.job_id, j);
    else s.manifestError = "manifest.json 缺 jobs 数组";
  } else s.manifestError = `manifest.json 不可读：${mj.error}`;
  if (s.spec) {
    try { s.expanded = expandMatrix(s.spec); } catch (e) { s.expandedError = (e as Error).message; }
  } else s.expandedError = `spec 未载入（${s.specError}），无法独立展开矩阵`;
  const res = jsonlByJob(join(runRoot, "results.jsonl"));
  s.results = res.map; s.resultsError = existsSync(join(runRoot, "results.jsonl")) ? res.error : "results.jsonl 不存在（尚无任何运行结果）";
  const sm = readJson(join(s.stageDir, "manifest.json"));
  if (sm.ok) s.stageManifest = sm.value; else s.stageManifestError = `stages/w-s-smoke/manifest.json 不可读：${sm.error}`;
  const sres = jsonlByJob(join(s.stageDir, "results.jsonl"));
  s.stageResults = sres.map;
  s.stageResultsError = existsSync(join(s.stageDir, "results.jsonl")) ? sres.error : null; // 阶段结果也可能只落顶层 results.jsonl
  const st = readJson(join(runRoot, "state.json"));
  if (st.ok) s.state = st.value; else s.stateError = existsSync(join(runRoot, "state.json")) ? `state.json 不可读：${st.error}` : "state.json 不存在";
  try {
    s.structure = loadStructureIndex(runRoot, repoRoot);
    if (s.spec) s.structureAudit = auditStructure(s.structure, s.spec);
  } catch (e) { s.structureError = (e as Error).message; }
  for (const p of [join(runRoot, "inputs", "structure", "source_index.json"),
    join(repoRoot, "experiments", "anima-interaction-v1", "structure", "frozen", "source_index.json")]) {
    const r = readJson(p);
    if (r.ok) { s.sourceIndex = r.value; break; } else s.sourceIndexError = `source_index 不可读（${p}）：${r.error}`;
  }
  const rv = readJson(join(runRoot, "checks", "structure-render-verify.json"));
  if (rv.ok) s.renderVerify = rv.value;
  const r2 = readJson(join(runRoot, "inputs", "repair-v2", "repair_index.json"));
  if (r2.ok) s.repairV2 = r2.value;
  else s.repairV2Error = existsSync(join(runRoot, "inputs", "repair-v2", "repair_index.json")) ? `repair_index.json 不可读：${r2.error}` : "inputs/repair-v2/repair_index.json 不存在（T2c 未落盘）";
  const ls = readJson(join(runRoot, "resource-lease.json"));
  if (ls.ok) s.lease = ls.value; else s.leaseError = `resource-lease.json 不可读：${ls.error}`;
  const g0 = readJson(join(runRoot, "checks", "resource-gate-g0.json")); if (g0.ok) s.gateG0 = g0.value;
  const rs = readJson(join(runRoot, "checks", "resource-gate-g0-raw-status.json")); if (rs.ok) s.rawStatus = rs.value;
  const rq = readJson(join(runRoot, "checks", "resource-gate-g0-raw-queue.json")); if (rq.ok) s.rawQueue = rq.value;
  const rc = readJson(join(runRoot, "checks", "environment-g0-recheck.json")); if (rc.ok) s.g0Recheck = rc.value;
  return s;
}

/** 计划任务行视图：manifest 行优先（真实交付面），缺 manifest 时回落 spec 机械展开行。 */
function plannedRows(s: VerifyShared, groupFilter?: (g: string) => boolean): { rows: any[]; fromManifest: boolean; baseDir: string } {
  if (s.manifestJobs.size > 0) {
    const rows = [...s.manifestJobs.values()].filter((j) => !groupFilter || groupFilter(String(j.group ?? "")));
    return { rows, fromManifest: true, baseDir: s.runRoot };
  }
  const rows = (s.expanded ?? []).filter((r) => !groupFilter || groupFilter(r.group));
  return { rows, fromManifest: false, baseDir: s.runRoot };
}

function graphOf(s: VerifyShared, job: any, baseDir: string): GraphCacheEntry {
  const gp = typeof job?.graph_path === "string" ? job.graph_path : null;
  if (!gp) return { bytes: null, sha256: null, json: null, error: "job 缺 graph_path" };
  const abs = isAbsolute(gp) ? gp : [join(baseDir, gp), join(s.runRoot, gp), join(s.repoRoot, gp)]
    .find((p) => existsSync(p)) ?? join(baseDir, gp);
  const cached = s.graphs.get(abs);
  if (cached) return cached;
  let entry: GraphCacheEntry;
  try {
    const bytes = readFileSync(abs);
    const sha = sha256Buf(bytes);
    let json: any = null; let error: string | null = null;
    try { json = JSON.parse(bytes.toString("utf8")); } catch (e) { error = `graph 不是合法 JSON：${(e as Error).message}`; }
    entry = { bytes, sha256: sha, json, error };
  } catch (e) { entry = { bytes: null, sha256: null, json: null, error: `graph 文件不存在/不可读 ${abs}：${(e as Error).message}` }; }
  s.graphs.set(abs, entry);
  return entry;
}

function graphClassTypes(g: any): Set<string> {
  const set = new Set<string>();
  if (g && typeof g === "object") for (const k of Object.keys(g)) {
    const ct = (g[k] as any)?.class_type;
    if (typeof ct === "string") set.add(ct);
  }
  return set;
}

function hasClass(g: any, name: string): boolean { return graphClassTypes(g).has(name); }

/** success 行的本地图片定位：row 路径直存 或 images/<job>/<basename> 约定（回收后 Windows 路径失效）。 */
function localImagePath(s: VerifyShared, jid: string, fileField: string): string | null {
  if (fileField && existsSync(fileField)) return fileField;
  const base = fileField.split(/[\\/]/).pop();
  if (!base) return null;
  const conv = join(s.runRoot, "images", jid, base);
  return existsSync(conv) ? conv : null;
}

function lastRow(s: VerifyShared, jid: string): any | null {
  const top = s.results.get(jid);
  const staged = s.stageResults.get(jid);
  const all = [...(top ?? []), ...(staged ?? [])];
  if (!all.length) return null;
  all.sort((a, b) => Date.parse(String(a?.recorded_at ?? 0)) - Date.parse(String(b?.recorded_at ?? 0)));
  return all[all.length - 1];
}

function stateJob(s: VerifyShared, jid: string): any | null {
  const jobs = s.state?.jobs;
  return jobs && typeof jobs === "object" ? (jobs[jid] ?? null) : null;
}

// ---------------------------------------------------------------------------
// 运行原证核验：history / submitted-graph / study_metadata 标记（F3/F4/F5 共用）
// ---------------------------------------------------------------------------

interface MarkerHits {
  pose: any[]; rsAudit: any[]; effective: any[]; falloff: any[]; noiseAudit: any[];
  regionGeometry: boolean; slots: boolean; clipEffectiveClaims: boolean;
}

/** 深扫 study_metadata（字符串逐项尝试 JSON.parse），收集契约标记；不猜别名。 */
function scanMarkers(value: unknown, out: MarkerHits, depth = 0): void {
  if (depth > 12 || value === null || value === undefined) return;
  if (typeof value === "string") {
    const t = value.trim();
    if ((t.startsWith("{") || t.startsWith("[")) && t.length < 5_000_000) {
      try { scanMarkers(JSON.parse(t), out, depth + 1); } catch { /* 非 JSON 字符串：忽略 */ }
    }
    return;
  }
  if (Array.isArray(value)) { for (const v of value) scanMarkers(v, out, depth + 1); return; }
  if (typeof value !== "object") return;
  for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
    if (k === "pose_adapter" || k === "anima_lllite") out.pose.push(v);
    else if (k === "RegionalLoras") { const a = (v as any)?.audit; if (a !== undefined) out.rsAudit.push(a); }
    else if (k === "execution") { const e = (v as any)?.effective; if (e !== undefined) out.effective.push(e); }
    else if (k === "falloff_info") out.falloff.push(v);
    else if (k === "noise_audit" || k === "noiseAudit") out.noiseAudit.push(v);
    else if (k === "region_geometry") out.regionGeometry = true;
    else if (k === "mask_slots" || k === "box_slots") out.slots = true;
    else if ((k === "clip_applied" || k === "clip_effective") && Boolean(v)) out.clipEffectiveClaims = true;
    scanMarkers(v, out, depth + 1);
  }
}

function loadStudyMarkers(s: VerifyShared, jid: string): { hits: MarkerHits | null; error: string | null } {
  const hits: MarkerHits = { pose: [], rsAudit: [], effective: [], falloff: [], noiseAudit: [], regionGeometry: false, slots: false, clipEffectiveClaims: false };
  const p = join(s.runRoot, "generation-info", `${jid}-study_metadata.json`);
  const r = readJson(p);
  if (!r.ok) return { hits: null, error: `study_metadata 不存在/不可读（${p}）：${r.error}` };
  let anyPresent = false;
  for (const [node, rec] of Object.entries(r.value as Record<string, any>)) {
    if (rec?.present === true) { anyPresent = true; scanMarkers(rec.study_metadata, hits); }
  }
  if (!anyPresent) return { hits: null, error: `study_metadata 全部节点 present=false（ui 键协议缺口，${p}）` };
  return { hits, error: null };
}

const poseApplied = (hits: MarkerHits): boolean => hits.pose.some((p: any) =>
  p === true || p?.applied === true || p?.status === "applied" ||
  (p && typeof p === "object" && p.applied !== false && p.status !== "masks_only" && p.mode !== "masks_only"));
const poseFaked = (hits: MarkerHits): boolean => hits.pose.some((p: any) =>
  typeof p === "object" && p !== null && (p.status === "masks_only" || p.mode === "masks_only" || p.applied === false));

/** history 原证：success+completed、outputs 图片定位、执行图与 submitted-graph/manifest 绑定。 */
function checkHistoryEvidence(s: VerifyShared, jid: string, job: any, row: any, baseDir: string, f: Findings): void {
  const hp = join(s.runRoot, "generation-info", `${jid}-history.json`);
  const hr = readJson(hp);
  f.ev(rel(s.runRoot, hp));
  if (!hr.ok) { f.fail(`${jid}: generation-info history 原文缺失/不可读（${hp}）——success 判定不成立（日志出现「提交」不等于完成）`); return; }
  const entry = hr.value?.[jid] ?? hr.value; // runner 保存 /history/<prompt_id> 原 JSON；兼容 {jid: entry} 形态
  const st = entry?.status;
  if (!(st?.status_str === "success" && st?.completed === true))
    f.fail(`${jid}: history status 非 success/completed（原文 ${JSON.stringify(st ?? null)}）`);
  // 执行图绑定：history.prompt[2] == submitted-graph == manifest graph_hash（权重/模型/采样的真实原证）
  const promptGraph = Array.isArray(entry?.prompt) ? entry.prompt[2] : null;
  const sgp = join(s.runRoot, "generation-info", `${jid}-submitted-graph.json`);
  const sgr = readJson(sgp);
  if (!sgr.ok) f.fail(`${jid}: submitted-graph 原文缺失（${sgp}）——无法绑定实际执行的图`);
  else {
    const sgSha = sha256File(sgp);
    const canon = sha256Buf(JSON.stringify(sgr.value));
    if (typeof job?.graph_hash === "string" && job.graph_hash !== sgr.value?.__expected_hash && sgSha !== job.graph_hash && canon !== job.graph_hash) {
      // submitted-graph 可能是 {graph} 包裹或裸图：两种形态都尝试与 graph_hash 对齐
      const inner = sgr.value?.graph ?? sgr.value?.prompt ?? null;
      const innerSha = inner ? sha256Buf(JSON.stringify(inner)) : null;
      if (innerSha !== job.graph_hash)
        f.fail(`${jid}: submitted-graph hash（${sgSha} / 规范化 ${canon} / 内层 ${innerSha ?? "无"}）与 manifest graph_hash ${job.graph_hash} 不符——执行图与冻结图脱钩`);
    }
    if (promptGraph && JSON.stringify(promptGraph) !== JSON.stringify(sgr.value?.graph ?? sgr.value?.prompt ?? sgr.value))
      f.fail(`${jid}: history.prompt 执行图与 submitted-graph 不一致（服务端实际执行了别的图）`);
  }
  const execGraph = promptGraph ?? (sgr.ok ? (sgr.value?.graph ?? sgr.value?.prompt ?? sgr.value) : null);
  if (execGraph) checkSamplerEvidence(s, jid, job, row, execGraph, f);
  else f.fail(`${jid}: 无执行图原文（history.prompt 与 submitted-graph 都缺），权重/seed/采样器无法对原证核验`);
  // 输出图片在 history outputs 中恰 1 张
  const imageNodes: string[] = job?.output_contract?.image_node_ids ?? [];
  for (const n of imageNodes) {
    const imgs = entry?.outputs?.[String(n)]?.images;
    if (!Array.isArray(imgs) || imgs.length !== 1)
      f.fail(`${jid}: history outputs[${n}].images 非恰好 1 张（${JSON.stringify(imgs ?? null)}）`);
  }
  void baseDir;
}

/** 从真实执行图核 KSampler/LoraLoader：seed=stage_seed、30/4.0/euler_ancestral/sgm_uniform、denoise、权重。 */
function checkSamplerEvidence(s: VerifyShared, jid: string, job: any, row: any, graph: any, f: Findings): void {
  const spec = s.spec;
  for (const [nid, node] of Object.entries(graph as Record<string, any>)) {
    const ct = node?.class_type;
    const inp = node?.inputs ?? {};
    if (ct === "KSampler") {
      if (spec) {
        const want = { steps: 30, cfg: 4.0, sampler_name: "euler_ancestral", scheduler: "sgm_uniform" };
        for (const [k, v] of Object.entries(want)) {
          if (inp[k] !== undefined && Number(inp[k]) !== v && String(inp[k]) !== String(v))
            f.fail(`${jid}: 执行图 KSampler(${nid}).${k}=${JSON.stringify(inp[k])} 与冻结值 ${v} 不符`);
        }
      }
      const seedWant = row?.stage_seed ?? job?.stage_seed;
      if (seedWant !== undefined && inp.seed !== undefined && Number(inp.seed) !== Number(seedWant))
        f.fail(`${jid}: 执行图 KSampler seed=${String(inp.seed)} ≠ stage_seed ${String(seedWant)}（阶段 seed 未固定）`);
      const dn = row?.weights?.denoise ?? job?.weights?.denoise;
      if (dn !== undefined && inp.denoise !== undefined && Math.abs(Number(inp.denoise) - Number(dn)) > 1e-9)
        f.fail(`${jid}: 执行图 KSampler denoise=${String(inp.denoise)} ≠ 行声明 ${String(dn)}`);
    } else if (ct === "LoraLoader") {
      const w = row?.weights ?? job?.weights ?? {};
      if (typeof w.lora === "number" && inp.strength_model !== undefined && Math.abs(Number(inp.strength_model) - w.lora) > 1e-9)
        f.fail(`${jid}: 执行图 LoraLoader(${nid}).strength_model=${String(inp.strength_model)} ≠ 声明权重 ${w.lora}`);
      if (typeof w.file === "number" && inp.strength_model !== undefined && Math.abs(Number(inp.strength_model) - w.file) > 1e-9)
        f.fail(`${jid}: 执行图 LoraLoader(${nid}).strength_model=${String(inp.strength_model)} ≠ 文件级权重 ${w.file}`);
    }
  }
  // clip TE=0 是空操作：任何执行期「clip 生效」声明都是谎称
  void s;
}

interface ClosureCounts { total: number; missing: number; byStatus: Record<string, number>; anySubmitProof: boolean }

/**
 * 逐 job 终态核验（F3/F4/F5 共用）。区分真实执行错误与整族从没跑通：
 * - execution_error 必须有提交实证（prompt_id / submitted-graph / rejected_http_4xx）；
 * - 全 scope 零记录 → 「整组从未执行」研究阻塞候选，不允许 error 行回填冒充。
 */
function checkJobsClosed(s: VerifyShared, label: string, jobs: any[], baseDir: string, f: Findings,
  opts: { requireMarkers?: boolean } = {}): ClosureCounts {
  const counts: ClosureCounts = { total: jobs.length, missing: 0, byStatus: {}, anySubmitProof: false };
  for (const job of jobs) {
    const jid = String(job.job_id);
    const row = lastRow(s, jid);
    const stj = stateJob(s, jid);
    const status: string | null = (row?.status ?? stj?.status ?? null);
    if (!status || status === "pending") {
      counts.missing++;
      if (counts.missing <= 12) f.fail(`${label}/${jid}: 无任何终态结果记录（results.jsonl/state.json 均缺）`);
      continue;
    }
    counts.byStatus[status] = (counts.byStatus[status] ?? 0) + 1;
    if (OPEN_STATES.has(status)) { f.fail(`${label}/${jid}: 状态 ${status} 非终态（submitting/accepted/unknown/observation_timeout/unresolved 不当终态）`); continue; }
    if (row && stj && stj.status !== row.status)
      f.fail(`${label}/${jid}: state.json 状态 ${String(stj.status)} 与 results 行 ${row.status} 不一致`);
    if (status === "success") {
      const graph = graphOf(s, job, baseDir);
      // 输出文件/hash/尺寸/真解码
      const files = row?.outputs?.files ?? {};
      const hashes = row?.outputs?.hashes ?? {};
      const dims = row?.outputs?.dimensions ?? {};
      const nodeIds = Object.keys(files);
      if (nodeIds.length === 0) f.fail(`${label}/${jid}: success 行缺 outputs.files（无回收产物记录）`);
      for (const n of nodeIds) {
        const local = localImagePath(s, jid, String(files[n]));
        if (!local) { f.fail(`${label}/${jid}: success 但图片未回收到本地（row 路径 ${String(files[n])} 与 images/${jid}/ 约定都找不到）`); continue; }
        f.ev(rel(s.runRoot, local));
        const bytes = readFileSync(local);
        const sha = sha256Buf(bytes);
        if (typeof hashes[n] === "string" && hashes[n] !== sha)
          f.fail(`${label}/${jid}: 回收图 ${local} 实 hash ${sha} ≠ 记录 ${String(hashes[n])}`);
        const dec = decodePng(bytes);
        if (!dec.ok) { f.fail(`${label}/${jid}: 回收图不可解码（${local}）：${dec.error}`); continue; }
        const d = dims[n];
        if (Array.isArray(d) && (d[0] !== dec.image.width || d[1] !== dec.image.height))
          f.fail(`${label}/${jid}: 记录尺寸 ${JSON.stringify(d)} ≠ 实测 ${dec.image.width}x${dec.image.height}`);
        const ew = job?.expected_width ?? (row?.expected_width as number | undefined);
        const eh = job?.expected_height ?? (row?.expected_height as number | undefined);
        if (ew !== undefined && eh !== undefined && (dec.image.width !== Number(ew) || dec.image.height !== Number(eh)))
          f.fail(`${label}/${jid}: 实测尺寸 ${dec.image.width}x${dec.image.height} ≠ 期望 ${ew}x${eh}`);
      }
      // history/submitted-graph/执行图 原证
      checkHistoryEvidence(s, jid, job, row, baseDir, f);
      // generation_info 标记：按真实执行图判定需求（W-S core 管线 metadata_node_ids=[] 如实不要求）
      const g = graph.json;
      const needsRs = g ? hasClass(g, "RSMultiCharacterSampler") : false;
      const needsPose = g ? (hasClass(g, "AnimaLLLiteApply") || hasClass(g, "ModelPatchLoader")) : false;
      const metaIds: string[] = job?.output_contract?.metadata_node_ids ?? [];
      if ((needsRs || needsPose || metaIds.length > 0) && opts.requireMarkers !== false) {
        if (graph.error) f.fail(`${label}/${jid}: ${graph.error}（无法判定 GI 标记需求）`);
        const { hits, error } = loadStudyMarkers(s, jid);
        if (error) f.fail(`${label}/${jid}: ${error}`);
        else if (hits) {
          if (needsPose) {
            if (poseFaked(hits)) f.fail(`${label}/${jid}: pose 标记为 masks_only/未 applied——不许冒充 B1/B2 姿态条件（scene_info 的 controlnet_used=false 不是运行证据，这里只认 generation_info/audit）`);
            else if (!poseApplied(hits)) f.fail(`${label}/${jid}: generation_info 无法机械识别 pose applied 标记（协议缺口，不得拿声明冒充）`);
            if (!hits.regionGeometry && needsRs) f.fail(`${label}/${jid}: generation_info 缺 region_geometry 标记`);
            if (!hits.slots && needsRs) f.fail(`${label}/${jid}: generation_info 缺 mask_slots/box_slots 标记`);
          }
          if (needsRs) {
            if (hits.rsAudit.length === 0) f.fail(`${label}/${jid}: generation_info 缺 RegionalLoras.audit（requested/effective 无法核对）`);
            if (hits.effective.length === 0) f.fail(`${label}/${jid}: generation_info 缺 execution.effective（不许悄悄 fallback）`);
            for (const eff of hits.effective) {
              if (eff?.layout_method !== undefined && eff.layout_method !== RS_REQUESTED.layout_method)
                f.fail(`${label}/${jid}: execution.effective.layout_method=${String(eff.layout_method)} ≠ requested ${RS_REQUESTED.layout_method}（fallback 冒充）`);
              if (eff?.lora_application_mode !== undefined && eff.lora_application_mode !== RS_REQUESTED.lora_application_mode)
                f.fail(`${label}/${jid}: execution.effective.lora_application_mode=${String(eff.lora_application_mode)} ≠ requested ${RS_REQUESTED.lora_application_mode}（fallback 冒充）`);
            }
          }
          if (hits.clipEffectiveClaims)
            f.fail(`${label}/${jid}: 两份 LoRA TE key=0（clip 强度为空操作），执行记录却声称 clip 生效——谎称`);
        }
      }
      // 透传字段一致（权重/方法如实进结果）
      if (row?.weights !== undefined && job?.weights !== undefined && JSON.stringify(row.weights) !== JSON.stringify(job.weights))
        f.fail(`${label}/${jid}: 结果行 weights ${JSON.stringify(row.weights)} ≠ manifest ${JSON.stringify(job.weights)}`);
    } else if (status === "execution_error") {
      const sgp = join(s.runRoot, "generation-info", `${jid}-submitted-graph.json`);
      const proof = Boolean(row?.prompt_id) || existsSync(sgp) || String(row?.error_class ?? "").startsWith("rejected_http_");
      if (!proof) f.fail(`${label}/${jid}: execution_error 缺真实执行实证（无 prompt_id、无 submitted-graph、非 4xx 拒单）——疑似回填 error 冒充已执行`);
      else counts.anySubmitProof = true;
      if (!row?.error_class) f.fail(`${label}/${jid}: execution_error 缺 error_class 分类`);
    } else if (status === "skipped_mechanical") {
      const reason = String(row?.skip_reason ?? stj?.skip_reason ?? "");
      if (!reason.trim()) f.fail(`${label}/${jid}: skipped_mechanical 缺具体机械原因`);
      const deps: string[] = job?.depends_on ?? [];
      let upstreamBad = false;
      for (const d of deps) {
        const dst = stateJob(s, d)?.status ?? lastRow(s, d)?.status;
        if (dst === "execution_error" || dst === "skipped_mechanical") upstreamBad = true;
      }
      const sc = s.structure?.cases?.[String(job?.case_id)];
      const structFact = Boolean(sc && ((sc.repair_flags?.core_empty || sc.repair_flags?.support_empty) ||
        sc.boxes?.owner_a?.empty === true || sc.boxes?.owner_b?.empty === true));
      if (!upstreamBad && !structFact)
        f.fail(`${label}/${jid}: skipped_mechanical 原因「${reason.slice(0, 80)}」找不到机械依据（上游均非 error/skip，结构索引也无 empty 域事实）`);
    } else if (status === "reuse_resolved") {
      const ref = String(row?.reuse_of ?? stj?.reuse_of ?? "");
      if (!ref) { f.fail(`${label}/${jid}: reuse_resolved 缺 reuse_of 绑定`); continue; }
      const upRow = lastRow(s, ref); const upSt = stateJob(s, ref);
      const upStatus = upSt?.status ?? upRow?.status;
      if (upStatus !== "success" && upStatus !== "reuse_resolved") {
        f.fail(`${label}/${jid}: reuse 绑定的上游 ${ref} 状态为 ${String(upStatus ?? "无记录")}（复用必须绑定真实成功输出）`);
        continue;
      }
      const upHashes = (upStatus === "success" ? upSt?.outputs?.hashes ?? upRow?.outputs?.hashes : upSt?.reused_outputs?.hashes ?? upRow?.reused_outputs?.hashes) ?? null;
      const mine = stj?.reused_outputs?.hashes ?? row?.reused_outputs?.hashes ?? null;
      if (!upHashes || !mine || JSON.stringify(upHashes) !== JSON.stringify(mine))
        f.fail(`${label}/${jid}: reuse 输出 hash ${JSON.stringify(mine)} 未与上游 ${ref} 的 ${JSON.stringify(upHashes)} 完全绑定`);
      else counts.anySubmitProof = counts.anySubmitProof; // reuse 不需要提交实证
    } else {
      f.fail(`${label}/${jid}: 未知状态 ${status}（不在 runner CLOSED_STATES 口径内）`);
    }
  }
  if (jobs.length > 0 && counts.missing === jobs.length) {
    f.fail(`${label}: 整组 ${jobs.length} 个计划任务零结果记录——「整族从没跑通」研究阻塞候选；不允许用 error/skip 行回填冒充已测（主线机制不能跑时 AUTO 不得全绿）`);
  } else if (jobs.length > 0 && counts.byStatus["execution_error"] !== undefined &&
    (counts.byStatus["execution_error"] ?? 0) === jobs.length - (counts.byStatus["skipped_mechanical"] ?? 0) - (counts.byStatus["reuse_resolved"] ?? 0) &&
    !counts.anySubmitProof) {
    f.fail(`${label}: 全组皆 execution_error 且零提交实证——与「从未执行」不可区分，判研究阻塞候选而非已测完`);
  }
  return counts;
}

// ---------------------------------------------------------------------------
// F1 —— 完整 manifest：40+4 case、808 新增上限、stage seed、parent/reuse、资产/节点绑定、graph 实 hash
// ---------------------------------------------------------------------------

function verifyF1(s: VerifyShared): CriterionResult {
  const f = new Findings();
  const ev = (p: string) => f.ev(rel(s.runRoot, p));
  ev(s.manifestPath); ev(s.specPath); ev(s.preflightPath);
  if (!s.spec) return done("F1", f, { fatal: `spec 未载入：${s.specError}` });
  if (!s.manifest) return done("F1", f, { fatal: `manifest.json 缺失/不可读（${s.manifestError}）——T3a 完整 build 未落盘，40+4 case/808 上限无从核验` });
  if (s.manifest.schema_version !== MANIFEST_SCHEMA)
    f.fail(`manifest.schema_version=${String(s.manifest.schema_version)} ≠ ${MANIFEST_SCHEMA}`);
  // 源文件 sha 绑定（重算，不信 manifest 自述）
  const bind = (field: string, actual: string | null, what: string): void => {
    const declared = s.manifest?.[field];
    if (!isHex64(declared)) { f.fail(`manifest.${field} 不是 64hex（${JSON.stringify(declared ?? null)}）`); return; }
    if (actual === null) { f.fail(`${what} 不存在，无法重算 sha256 核对 manifest.${field}`); return; }
    if (declared !== actual) f.fail(`manifest.${field}=${declared} ≠ ${what} 实 hash ${actual}（源漂移或 manifest 过期）`);
  };
  bind("spec_sha256", s.specSha, "spec.json");
  bind("preflight_sha256", s.preflightSha, "preflight.json");
  const structIndexFile = join(s.runRoot, "inputs", "structure", "structure_index.json");
  if (isHex64(s.manifest.structure_index_sha256)) bind("structure_index_sha256", sha256File(structIndexFile), "inputs/structure/structure_index.json");
  else f.fail(`manifest.structure_index_sha256=${JSON.stringify(s.manifest.structure_index_sha256 ?? null)}——完整 manifest 必须绑定真实结构索引 hash`);
  // 角色源表 sha（开始后源表改变即停跑建新 run）
  const liveCharSha = sha256File(join(s.repoRoot, "src", "tools", "tags", "ai-girls.json"));
  if (String(s.spec.provenance?.character_source_sha256) !== liveCharSha)
    f.fail(`角色源表已漂移：spec 冻结 ${String(s.spec.provenance?.character_source_sha256)} ≠ 当前 src/tools/tags/ai-girls.json ${String(liveCharSha)}（须停跑建新 run）`);
  // 独立展开对照（不只检查 manifest 自己写了 count）
  const jobs: any[] = Array.isArray(s.manifest.jobs) ? s.manifest.jobs : [];
  if (!s.expanded) { f.fail(`无法独立展开 spec 矩阵：${s.expandedError}`); return done("F1", f, { jobs: jobs.length }); }
  const manById = new Map(jobs.map((j) => [String(j.job_id), j]));
  const expById = new Map(s.expanded.map((r) => [r.job_id, r]));
  const missing = s.expanded.filter((r) => !manById.has(r.job_id)).map((r) => r.job_id);
  const extra = jobs.filter((j) => !expById.has(String(j.job_id))).map((j) => String(j.job_id));
  if (missing.length) f.fail(`manifest 缺 ${missing.length} 个计划 job（示例：${missing.slice(0, 6).join(", ")}）`);
  if (extra.length) f.fail(`manifest 含 ${extra.length} 个计划外 job（示例：${extra.slice(0, 6).join(", ")}）`);
  // 逐行字段核对 + stage seed 复算 + P 条件复用放行判定
  let pFlips = 0;
  const groupNew: Record<string, number> = {};
  const groupReuse: Record<string, number> = {};
  for (const r of s.expanded) {
    const m = manById.get(r.job_id);
    if (!m) continue;
    const eq = (field: string, a: unknown, b: unknown): void => {
      if (JSON.stringify(a ?? null) !== JSON.stringify(b ?? null)) f.fail(`${r.job_id}: manifest.${field}=${JSON.stringify(a ?? null)} ≠ 计划 ${JSON.stringify(b ?? null)}`);
    };
    eq("group", m.group, r.group); eq("case_id", m.case_id, r.case_id); eq("pair", m.pair, r.pair);
    eq("action", m.action, r.action); eq("framing", m.framing, r.framing); eq("seed", m.seed, r.seed);
    eq("stage", m.stage, r.stage); eq("method", m.method, r.method); eq("weights", m.weights, r.weights);
    eq("reuse_of", m.reuse_of, r.reuse_of === null ? null : r.reuse_of); eq("depends_on", m.depends_on, r.depends_on);
    const recomputed = stageSeed(r.case_id, r.seed, r.stage);
    if (Number(m.stage_seed) !== recomputed)
      f.fail(`${r.job_id}: stage_seed=${String(m.stage_seed)} ≠ 冻结算法复算 ${recomputed}（${r.case_id}|${r.seed}|${r.stage}）`);
    if (r.sample_kind === "reuse") {
      if (m.reuse_of !== r.reuse_of) f.fail(`${r.job_id}: reuse_of=${String(m.reuse_of)} ≠ 计划 ${String(r.reuse_of)}`);
      if (!m.reuse_of || !manById.has(String(m.reuse_of))) f.fail(`${r.job_id}: reuse_of 指向不存在的 job ${String(m.reuse_of)}`);
    }
    if (m.sample_kind === "new" && r.sample_kind === "reuse") f.fail(`${r.job_id}: 计划复用行被写成 new（复用不 POST，会重复采样）`);
    if (m.sample_kind === "reuse" && r.sample_kind === "new") {
      // 仅 P-DC-identical 条件复用允许翻转，且必须实证 graph_hash 相等
      if (r.group === "P" && r.method === "P2") {
        const p1 = manById.get(`P__${r.case_id}__${r.seed}__P1`);
        if (p1 && isHex64(m.graph_hash) && m.graph_hash === p1.graph_hash && m.reuse_of === p1.job_id) pFlips++;
        else f.fail(`${r.job_id}: P2 翻 reuse 但实证不足（reuse_of=${String(m.reuse_of)}，graph_hash 与 P1 ${String(p1?.graph_hash)} 不等）`);
      } else f.fail(`${r.job_id}: sample_kind=reuse 不在条件复用规则内（组 ${r.group} 方法 ${r.method}）`);
    }
    if (m.sample_kind === "new") groupNew[r.group] = (groupNew[r.group] ?? 0) + 1;
    else if (m.sample_kind === "reuse") groupReuse[r.group] = (groupReuse[r.group] ?? 0) + 1;
    else f.fail(`${r.job_id}: sample_kind=${JSON.stringify(m.sample_kind)} 非 new|reuse`);
    // graph 实文件 hash（引用行与新增行都核）
    if (isHex64(m.graph_hash)) {
      const g = graphOf(s, m, s.runRoot);
      if (g.error) f.fail(`${r.job_id}: ${g.error}`);
      else if (g.sha256 !== m.graph_hash) f.fail(`${r.job_id}: graph 实文件 hash ${g.sha256} ≠ manifest graph_hash ${m.graph_hash}`);
    } else f.fail(`${r.job_id}: graph_hash 非 64hex（${JSON.stringify(m.graph_hash ?? null)}）`);
    // 资产 hash 与 preflight 实体绑定（不造 hash）
    if (s.preflight) {
      const ah = m.asset_hashes;
      if (!ah || typeof ah !== "object") f.fail(`${r.job_id}: 缺 asset_hashes 实体绑定`);
      else {
        for (const [k, v] of Object.entries(ah as Record<string, unknown>)) {
          if (!(ASSET_KEYS as readonly string[]).includes(k)) { f.fail(`${r.job_id}: asset_hashes 含未知键 ${k}`); continue; }
          try { const want = assetBinding(s.preflight, k).sha256;
            if (v !== want) f.fail(`${r.job_id}: asset_hashes.${k}=${String(v)} ≠ preflight 实体 ${want}`);
          } catch (e) { f.fail(`${r.job_id}: preflight 资产 ${k} 绑定失败：${(e as Error).message}`); }
        }
        for (const k of ["unet", "clip", "vae"]) if (ah[k] === undefined) f.fail(`${r.job_id}: asset_hashes 缺 ${k}`);
        const g = graphOf(s, m, s.runRoot);
        if (g.json && (hasClass(g.json, "AnimaLLLiteApply") || hasClass(g.json, "ModelPatchLoader")) && ah["pose_lllite"] === undefined)
          f.fail(`${r.job_id}: 执行图挂 LLLite 姿态但 asset_hashes 缺 pose_lllite 绑定`);
      }
    } else f.fail(`${r.job_id}: preflight 未载入（${s.preflightError}），资产绑定无法核验`);
    // 期望尺寸：全画布 1024×768；R 组按 T3c 契约 = Stitch 贴回后的原生画布
    const isR = r.group === "R_calib" || r.group === "R_repeat";
    const wantW = isR && r.method !== "R0" ? R_OUTPUT_WIDTH : s.spec.canvas.width;
    const wantH = isR && r.method !== "R0" ? R_OUTPUT_HEIGHT : s.spec.canvas.height;
    if (Number(m.expected_width) !== wantW || Number(m.expected_height) !== wantH)
      f.fail(`${r.job_id}: expected ${String(m.expected_width)}x${String(m.expected_height)} ≠ 契约 ${wantW}x${wantH}${isR && r.method !== "R0" ? "（R 最终输出=Stitch 贴回原生画布，T3c）" : ""}`);
    // input_files：可解析 + run-root 相对（T3c）+ structure sha 真实 + parent 不预填 + R 须消费 repair-v2
    for (const item of (Array.isArray(m.input_files) ? m.input_files : [])) {
      const src = item?.source ?? {};
      const p = String(src.path ?? "");
      if (src.kind === "parent_job") {
        if (src.sha256 !== null && src.sha256 !== undefined) f.fail(`${r.job_id}: parent_job 输入预填了 sha256（${String(src.sha256)}）——必须等上游产出后运行时核`);
        if (!src.job_id || !manById.has(String(src.job_id))) f.fail(`${r.job_id}: parent_job 输入指向未知 job ${String(src.job_id)}`);
        continue;
      }
      if (!p) { f.fail(`${r.job_id}: input_files 项缺 source.path`); continue; }
      const absFromRun = isAbsolute(p) ? p : join(s.runRoot, p);
      const absFromRepo = isAbsolute(p) ? p : join(s.repoRoot, p);
      if (!existsSync(absFromRun) && !existsSync(absFromRepo)) { f.fail(`${r.job_id}: input_files 源不存在（run-root/repo-root 都解析不到 ${p}）`); continue; }
      if (!isAbsolute(p) && !existsSync(absFromRun) && existsSync(absFromRepo))
        f.fail(`${r.job_id}: input_files source.path「${p}」只对 repo-root 可解析——按 T3c 契约应 run-root 相对`);
      if (isHex64(src.sha256)) {
        const actual = sha256File(existsSync(absFromRun) ? absFromRun : absFromRepo);
        if (actual !== src.sha256) f.fail(`${r.job_id}: input_files ${p} 实 hash ${actual} ≠ 声明 ${src.sha256}`);
      } else if (src.kind === "structure") f.fail(`${r.job_id}: structure 输入 ${p} 缺冻结 sha256`);
      if (isR && /inputs[\\/]structure[\\/][^\\/]+[\\/](support|repair_core|context|gray)\.png$/.test(p))
        f.fail(`${r.job_id}: R 行仍消费旧 inputs/structure 的 ${p.replace(/^.*[\\/]/, "")}（已知全 body union/环宽未证）——最终 R 条件只认 inputs/repair-v2（T2c/T3c）`);
    }
  }
  // 组计数（引用行与新增采样分开）与 808 上限
  const want: Record<string, { n: number; r: number }> = {
    "W-S": { n: 24, r: 0 }, "pose_grid": { n: 8, r: 0 }, "B": { n: 288, r: 0 }, "H": { n: 48, r: 0 },
    "R_calib": { n: 72, r: 8 }, "R_repeat": { n: 128, r: 64 }, "P": { n: 16 - pFlips, r: pFlips },
    "W-RS": { n: 128, r: 16 }, "W-G": { n: 96, r: 0 },
  };
  for (const [g, w] of Object.entries(want)) {
    const gn = groupNew[g] ?? 0, gr = groupReuse[g] ?? 0;
    if (g === "P") { if (gn + gr !== 16) f.fail(`P 组 new(${gn})+reuse(${gr}) ≠ 16`); }
    else { if (gn !== w.n) f.fail(`${g} 组新增采样行 ${gn} ≠ 计划 ${w.n}`); if (gr !== w.r) f.fail(`${g} 组引用行 ${gr} ≠ 计划 ${w.r}`); }
  }
  const totalNew = Object.values(groupNew).reduce((a, b) => a + b, 0);
  const totalReuse = Object.values(groupReuse).reduce((a, b) => a + b, 0);
  if (totalNew > 808) f.fail(`新增采样行合计 ${totalNew} 超过 808 上限`);
  if (totalNew !== 808 - pFlips) f.fail(`新增采样行合计 ${totalNew} ≠ 808 − P条件复用 ${pFlips}（各组 count 与 §6 上限不一致）`);
  // 40+4 唯一 case
  const pairCases = new Set(jobs.filter((j) => !String(j.case_id).startsWith("SOLO-")).map((j) => String(j.case_id)));
  const soloCases = new Set(jobs.filter((j) => String(j.case_id).startsWith("SOLO-")).map((j) => String(j.case_id)));
  const main40: string[] = s.spec.cases.main_40?.set ?? [];
  const solo4: string[] = s.spec.cases.single_4?.set ?? [];
  for (const c of main40) if (!pairCases.has(c)) f.fail(`manifest 无 case ${c} 的任何 job（40 主 case 不全）`);
  for (const c of pairCases) if (!main40.includes(c)) f.fail(`manifest 出现计划外 case ${c}`);
  for (const c of solo4) if (!soloCases.has(c)) f.fail(`manifest 无单人 case ${c} 的任何 job`);
  if (main40.length !== 40 || solo4.length !== 4) f.fail(`spec case 集合自身异常：main_40=${main40.length} single_4=${solo4.length}`);
  // execution 节点/源码绑定
  const ex = s.manifest.execution ?? {};
  if (s.preflight) {
    const coreCommit = String(s.preflight.coreVersionDrift?.productionCommit ?? "");
    if (coreCommit && ex.core_commit !== coreCommit) f.fail(`manifest.execution.core_commit=${String(ex.core_commit)} ≠ preflight 冻结 ${coreCommit}`);
    const rsCommit = String((s.preflight.nodes as any)?.rs?.frozenCommit ?? "");
    if (rsCommit && ex.rs_commit !== rsCommit) f.fail(`manifest.execution.rs_commit=${String(ex.rs_commit)} ≠ preflight.nodes.rs.frozenCommit ${rsCommit}`);
    const cropCommit = String((s.preflight.nodes as any)?.crop?.frozenCommit ?? (s.preflight.nodes as any)?.cropAndStitch?.frozenCommit ?? "");
    if (cropCommit && ex.crop_commit !== cropCommit) f.fail(`manifest.execution.crop_commit=${String(ex.crop_commit)} ≠ preflight 冻结 ${cropCommit}`);
  }
  for (const [field, isDir] of [["t4_patch", false], ["glue_node", true], ["study_support_node", true]] as const) {
    const p = String(ex[field] ?? "");
    if (!p) { f.fail(`manifest.execution.${field} 缺失`); continue; }
    const abs = join(s.repoRoot, p);
    if (!existsSync(abs)) f.fail(`manifest.execution.${field}=${p} 在仓库中不存在（${abs}）`);
    else if (!isDir) f.note(`${field}_sha256`, sha256File(abs));
  }
  // characters_snapshot：LoRA 实体 hash + clip TE=0 空操作如实记录
  const snap = Array.isArray(s.manifest.characters_snapshot) ? s.manifest.characters_snapshot : [];
  if (snap.length !== 4) f.fail(`characters_snapshot ${snap.length} 条 ≠ 4 角色`);
  for (const c of snap) {
    if (s.preflight && c?.lora_name) {
      const key = c.lora_name === "claude_girl_anima_lora_clean.safetensors" ? "lora_claude" : "lora_shared";
      try { const want = assetBinding(s.preflight, key).sha256;
        if (c.lora_sha256 !== want) f.fail(`characters_snapshot[${c.key}].lora_sha256=${String(c.lora_sha256)} ≠ preflight ${key} 实体 ${want}`);
      } catch (e) { f.fail(`characters_snapshot[${c.key}] preflight 绑定失败：${(e as Error).message}`); }
    }
    if (Number(c?.matched_key_counts?.clip) === 0 && c?.clip_strength_inert !== true)
      f.fail(`characters_snapshot[${c.key}]: clip 匹配 key=0 但缺 clip_strength_inert=true 标记（空操作必须如实记录，不谎称生效）`);
  }
  if (snap.some((c) => Number(c?.matched_key_counts?.clip) === 0) && !String(s.manifest.lora_clip_inert_note ?? "").trim())
    f.fail("manifest 缺 lora_clip_inert_note（两份 LoRA TE key=0 的空操作声明）");
  const pf = s.manifest.prompt_floor ?? {};
  if (!String(pf.positive ?? "").trim() || !String(pf.negative ?? "").trim()) f.fail("manifest.prompt_floor 正/负地板文本缺失（正式采样前必须冻结）");
  if (pf.not_v8_four_axis_flat !== true) f.fail("manifest.prompt_floor.not_v8_four_axis_flat ≠ true（不得照搬 V8 四轴扁平前缀）");
  f.note("counts", { jobs: jobs.length, new_samples: totalNew, reuse_reference_rows: totalReuse, p_conditional_flips: pFlips, budget_cap: 808 });
  return done("F1", f, { per_group_new: groupNew, per_group_reuse: groupReuse });
}

// ---------------------------------------------------------------------------
// 结果组装小工具
// ---------------------------------------------------------------------------

function rel(base: string, p: string): string {
  const r = relative(base, p);
  return r.startsWith("..") || isAbsolute(r) ? p : r;
}

function done(id: CriterionId, f: Findings, details: Record<string, unknown> = {}): CriterionResult {
  if (typeof details["fatal"] === "string") f.fail(String(details["fatal"]));
  const status: CriterionStatus = f.ok ? "passed" : "failed";
  const out: Record<string, unknown> = { ...details, ...f.details };
  if (f.truncated) out["reasons_truncated"] = true;
  return { id, type: id === "F8" ? "MANUAL" : "AUTO", status, reasons: f.reasons, evidence: f.evidence, details: out };
}

// ---------------------------------------------------------------------------
// F2 —— 8 世界/40 投影/4 单人结构资产：真实文件+像素值域+box+相机/几何一致（不判动作语义）
// ---------------------------------------------------------------------------

function verifyF2(s: VerifyShared): CriterionResult {
  const f = new Findings();
  f.ev(rel(s.runRoot, join(s.runRoot, "inputs", "structure", "structure_index.json")));
  if (!s.spec) return done("F2", f, { fatal: `spec 未载入：${s.specError}` });
  if (!s.structure) return done("F2", f, { fatal: `结构索引未载入（T2b 渲染未落盘或 schema 不符）：${s.structureError}` });
  const idx = s.structure;
  if (s.structureAudit) {
    for (const m of s.structureAudit.missing.slice(0, 200)) f.fail(m);
    if (s.structureAudit.missing.length > 200) f.fail(`……另有 ${s.structureAudit.missing.length - 200} 条结构审计缺项（全量见重跑）`);
    f.note("audit_warnings", s.structureAudit.warnings.slice(0, 40));
  } else f.fail("spec 缺失导致 auditStructure 未执行");
  // 44 case / 8 世界 / 每世界 5 景别
  const main40: string[] = s.spec.cases.main_40?.set ?? [];
  const solo4: string[] = s.spec.cases.single_4?.set ?? [];
  if (Number(idx.case_count) !== 44) f.fail(`结构索引 case_count=${String(idx.case_count)} ≠ 44（40 投影 + 4 单人）`);
  const worlds = new Map<string, string[]>();
  for (const id of main40) {
    const c = idx.cases[id];
    if (!c) continue; // audit 已报缺
    const w = String(c.world_id ?? "");
    if (!w) { f.fail(`${id}: 缺 world_id`); continue; }
    worlds.set(w, [...(worlds.get(w) ?? []), id]);
  }
  const wantWorlds = ["DC-HAND", "DC-HUG", "DC-KISS", "DC-CARRY", "QG-HAND", "QG-HUG", "QG-KISS", "QG-CARRY"];
  for (const w of wantWorlds) {
    const cases = worlds.get(w);
    if (!cases) { f.fail(`缺世界结构 ${w}（8 套 pair×action 不全）`); continue; }
    if (cases.length !== 5) f.fail(`世界 ${w} 有 ${cases.length} 个投影 case ≠ 5 景别（W/M/C/XU/XH）`);
  }
  for (const w of worlds.keys()) if (!wantWorlds.includes(w)) f.fail(`结构索引出现计划外 world_id ${w}`);
  const canvas: [number, number] = [s.spec.canvas.width, s.spec.canvas.height];
  // source_index（T2a 冻结几何/相机；proxy box 非权威，只用于相机一致性核对）
  if (!s.sourceIndex) f.fail(`source_index 缺失，无法核对源几何/相机一致性：${s.sourceIndexError ?? ""}`);
  const worldPeople = new Map<string, string>();
  const coverage: Record<string, number> = {};
  for (const id of [...main40, ...solo4]) {
    const c = idx.cases[id];
    if (!c || c.status !== "rendered") continue; // audit 已报
    const isSolo = id.startsWith("SOLO-");
    const fileBuf = (key: string): Buffer | null => {
      const refe = (c.files as Record<string, { path: string; sha256: string }> | undefined)?.[key];
      if (!refe) return null;
      try { return readFileSync(structureAbsPath(idx, refe)); } catch { return null; } // audit 已报缺
    };
    const dec = (key: string): PngImage | null => {
      const buf = fileBuf(key);
      if (!buf) return null;
      const d = decodePng(buf);
      if (!d.ok) { f.fail(`${id}/${key}: PNG 不可真解码：${d.error}`); return null; }
      if (d.image.width !== canvas[0] || d.image.height !== canvas[1])
        f.fail(`${id}/${key}: 实测 ${d.image.width}x${d.image.height} ≠ 画布 ${canvas[0]}x${canvas[1]}`);
      return d.image;
    };
    for (const k of ["owner_a.png", "owner_b.png", "owner_a_full.png", "owner_b_full.png"]) {
      const img = dec(k);
      if (img && !allSamplesIn(img, [0, 255])) f.fail(`${id}/${k}: owner mask 非二值（存在 0/255 以外的值）`);
    }
    const pose = dec("pose_image.png"); void pose;
    dec("preview.png");
    // gray/support/core 值域规则（v2 render-verify 同口径；R 域局部性归 F4/repair-v2）
    const gray = dec("gray.png"), support = dec("support.png"), core = dec("repair_core.png");
    dec("context.png");
    if (gray && support && core && gray.width === support.width && support.width === core.width) {
      let outsideViolations = 0, plateauViolations = 0, supportNz = 0;
      for (let y = 0; y < gray.height; y++) for (let x = 0; x < gray.width; x++) {
        const gv = px(gray, x, y), sv = px(support, x, y), cv = px(core, x, y);
        if (sv === 0 && gv !== 0) outsideViolations++;
        if (cv > 0 && gv !== 255) plateauViolations++;
        if (sv > 0) supportNz++;
      }
      if (outsideViolations > 0) f.fail(`${id}: gray 在 support 域外有 ${outsideViolations} 个非零像素（要求域外=0）`);
      if (plateauViolations > 0) f.fail(`${id}: repair_core 内 gray 有 ${plateauViolations} 个像素 ≠255（核心平台要求=1.0）`);
      coverage[id] = Number((100 * supportNz / (gray.width * gray.height)).toFixed(1));
    }
    // box：pixel_bbox → 归一化中心/尺寸复算（权威=渲染 owner visible mask +8px，非 FK-proxy）
    if (!isSolo && c.boxes) {
      for (const slot of ["owner_a", "owner_b"] as const) {
        const b = c.boxes[slot];
        if (!b) continue;
        if (b.empty === true) { f.note(`empty_box_${id}_${slot}`, true); continue; } // 机械事实，audit warnings 已录
        const bb = b.pixel_bbox;
        if (!Array.isArray(bb) || bb.length !== 4) { f.fail(`${id}.boxes.${slot}: 缺 pixel_bbox[4]（渲染后权威 box 必须带像素来源）`); continue; }
        const [x0, y0, x1, y1] = bb as number[];
        if (x0 < 0 || y0 < 0 || x1 > canvas[0] || y1 > canvas[1] || x0 >= x1 || y0 >= y1)
          f.fail(`${id}.boxes.${slot}: pixel_bbox ${JSON.stringify(bb)} 越界/退化（画布 ${canvas[0]}x${canvas[1]}）`);
        const want = { x: (x0 + x1) / 2 / canvas[0], y: (y0 + y1) / 2 / canvas[1], width: (x1 - x0) / canvas[0], height: (y1 - y0) / canvas[1] };
        for (const k of ["x", "y", "width", "height"] as const) {
          if (Math.abs(Number(b[k]) - want[k]) > 1e-4)
            f.fail(`${id}.boxes.${slot}.${k}=${String(b[k])} ≠ pixel_bbox 复算 ${want[k].toFixed(6)}（+8px 扩边/夹取/归一化链不一致）`);
        }
      }
    }
    // 鲸尾同 owner union 声明（DC）
    if (!isSolo && id.startsWith("DC-") && (!c.tail_union || String((c.tail_union as any).owner) !== "deepseek"))
      f.fail(`${id}: 缺 tail_union.owner=deepseek 声明（鲸尾同 owner union，不加第三角色槽）`);
    // 相机/几何与 source_index 一致；同世界 people 几何跨景别相同（不判动作语义）
    const sceneBuf = fileBuf("scene.json");
    if (sceneBuf) {
      let scene: any = null;
      try { scene = JSON.parse(sceneBuf.toString("utf8")); } catch (e) { f.fail(`${id}/scene.json 不可解析：${(e as Error).message}`); }
      if (scene) {
        if (Number(scene.width) !== canvas[0] || Number(scene.height) !== canvas[1])
          f.fail(`${id}/scene.json 画布 ${String(scene.width)}x${String(scene.height)} ≠ ${canvas[0]}x${canvas[1]}`);
        const srcCase = s.sourceIndex?.cases?.[id];
        if (s.sourceIndex && !srcCase) f.fail(`${id}: source_index 无该 case 条目，相机一致性无法核对`);
        else if (srcCase?.camera && scene.camera) {
          const close = (a: unknown, b: unknown): boolean => JSON.stringify(a) === JSON.stringify(b) ||
            (Array.isArray(a) && Array.isArray(b) && a.length === b.length && a.every((v, i) => Math.abs(Number(v) - Number(b[i])) < 1e-6));
          if (!close(scene.camera.position, srcCase.camera.position) || !close(scene.camera.target, srcCase.camera.target) ||
            Math.abs(Number(scene.camera.fov) - Number(srcCase.camera.fov)) > 1e-6)
            f.fail(`${id}: scene.json 相机与 source_index 冻结相机不一致（景别只允许改规定相机参数，且必须与源一致）`);
        }
        if (!isSolo) {
          const w = String(c.world_id);
          const people = JSON.stringify(scene.people ?? null);
          const prev = worldPeople.get(w);
          if (prev === undefined) worldPeople.set(w, people);
          else if (prev !== people) f.fail(`${id}: 世界 ${w} 的 people 几何与同世界其它景别不一致（同 pair/action 世界姿态必须跨景别固定）`);
        }
      }
    }
  }
  f.note("support_coverage_percent", coverage); // 已知事实：旧 support=全 body union（10.3–69.7%），R 局部域归 F4/repair-v2
  f.note("r_domain_note", "F2 不据旧 support/gray 放行 R 条件：局部 core/support/context 只认 inputs/repair-v2/repair_index.json（T2c）+ falloff_info（T4c），见 F4");
  f.note("scene_info_note", "scene_info 的 controlnet_used=false/pose_enforcement=false 只是几何节点原生声明；初采样 LLLite 是否 applied 由 F3 对真实 generation_info/audit 核验");
  // render-verify v2 佐证（自身像素核验为主，报告矛盾即失败）
  const rj = join(s.runRoot, "checks", "structure-render-verify.json");
  if (s.renderVerify) {
    f.ev(rel(s.runRoot, rj));
    if (Number(s.renderVerify.version) < 2) f.fail(`structure-render-verify.json version=${String(s.renderVerify.version)} < 2（旧版报告不作佐证）`);
    if (Number(s.renderVerify.failure_count) !== 0 || !Array.isArray(s.renderVerify.failures) || s.renderVerify.failures.length !== 0)
      f.fail(`structure-render-verify.json failure_count=${String(s.renderVerify.failure_count)} ≠ 0`);
    if (Number(s.renderVerify.case_count) !== 44 || s.renderVerify.all_44_present !== true)
      f.fail(`structure-render-verify.json case 覆盖异常（case_count=${String(s.renderVerify.case_count)} all_44_present=${String(s.renderVerify.all_44_present)}）`);
  } else f.note("render_verify_report", "checks/structure-render-verify.json 不存在（佐证缺位；本核验以自身像素/几何检查为准）");
  return done("F2", f, { cases_checked: main40.length + solo4.length, worlds: worlds.size });
}

// ---------------------------------------------------------------------------
// F3 —— Windows 冒烟（W-S staged）+ B0/B1/B2 + pose_grid：真实终态/原 history/图片/GI 标记
// ---------------------------------------------------------------------------

function verifyF3(s: VerifyShared): CriterionResult {
  const f = new Findings();
  f.ev(rel(s.runRoot, join(s.runRoot, "results.jsonl")), rel(s.runRoot, join(s.runRoot, "state.json")),
    rel(s.runRoot, join(s.runRoot, "generation-info")), rel(s.runRoot, join(s.stageDir, "manifest.json")));
  if (!s.spec) return done("F3", f, { fatal: `spec 未载入：${s.specError}` });
  if (!s.manifest && !s.expanded) return done("F3", f, { fatal: `manifest 与 spec 展开都不可用（${s.manifestError} / ${s.expandedError}），计划任务集无法确定` });
  if (s.resultsError && s.results.size === 0) f.fail(`results.jsonl：${s.resultsError}——尚无任何真实运行结果，B0/B1/B2/pose_grid/冒烟整组未执行（研究阻塞候选，不以 error 回填冒充）`);
  if (s.stateError) f.note("state", s.stateError);
  // B + pose_grid（root manifest / 展开行）
  const mainJobs = plannedRows(s, (g) => g === "B" || g === "pose_grid");
  f.note("planned_source", mainJobs.fromManifest ? "manifest.json" : `spec 机械展开（manifest 缺失：${s.manifestError}）`);
  const cMain = checkJobsClosed(s, "B/pose_grid", mainJobs.rows, s.runRoot, f);
  // pose_grid：强度/区间 applied 与声明一致（真实 GI 数值核对；缺字段=协议缺口）
  for (const job of mainJobs.rows.filter((j) => String(j.group) === "pose_grid")) {
    const jid = String(job.job_id);
    const row = lastRow(s, jid);
    if (row?.status !== "success") continue;
    const { hits } = loadStudyMarkers(s, jid);
    if (!hits) continue; // 缺标记已在 closure 报过
    const want = job.weights ?? {};
    for (const p of hits.pose) {
      if (p && typeof p === "object") {
        if (p.strength !== undefined && want.pose_strength !== undefined && Math.abs(Number(p.strength) - Number(want.pose_strength)) > 1e-9)
          f.fail(`${jid}: GI pose strength=${String(p.strength)} ≠ 声明 ${String(want.pose_strength)}`);
        if (p.end !== undefined && want.pose_end !== undefined && Math.abs(Number(p.end) - Number(want.pose_end)) > 1e-9)
          f.fail(`${jid}: GI pose end=${String(p.end)} ≠ 声明 ${String(want.pose_end)}`);
      }
    }
  }
  // W-S 冒烟（stages/w-s-smoke：真实子集，参数与全矩阵一致、job_id 一致）
  if (!s.stageManifest || !Array.isArray(s.stageManifest.jobs) || s.stageManifest.jobs.length === 0) {
    f.fail(`stages/w-s-smoke/manifest.json 缺失/无 jobs（${s.stageManifestError ?? "空"}）——Windows 冒烟计划集不存在`);
  } else {
    const smokeJobs = s.stageManifest.jobs as any[];
    if (smokeJobs.length !== 4) f.note("smoke_jobs", smokeJobs.length);
    const cSmoke = checkJobsClosed(s, "W-S冒烟", smokeJobs, s.stageDir, f);
    f.note("smoke_counts", cSmoke.byStatus);
    // 冒烟行的 metadata_node_ids=[] 是如实 core 管线：closure 已按图判定，不强迫 GI
  }
  f.note("counts", { main: cMain.byStatus, missing_main: cMain.missing, total_main: cMain.total });
  return done("F3", f);
}

// ---------------------------------------------------------------------------
// F4 —— R 校准/复验：repair-v2 局部域 + 冻结父图 + 同 crop + 禁 pose + DD 灰度 + falloff/noise 原证
// ---------------------------------------------------------------------------

const R_GROW_TOL_PX = 4; // 栅格化容差（记录在 verify.md；不是放宽派生规则）

function verifyF4(s: VerifyShared): CriterionResult {
  const f = new Findings();
  f.ev(rel(s.runRoot, join(s.runRoot, "inputs", "repair-v2", "repair_index.json")),
    rel(s.runRoot, join(s.runRoot, "results.jsonl")), rel(s.runRoot, join(s.runRoot, "crops")));
  if (!s.spec) return done("F4", f, { fatal: `spec 未载入：${s.specError}` });
  // 1) T2c repair-v2：按动作部件的局部 core/support/context（旧 body-union support 不放行）
  if (!s.repairV2) {
    f.fail(`inputs/repair-v2/repair_index.json 缺失/不可读（${s.repairV2Error}）——R 最终条件只认 repair-v2 局部域；旧 inputs/structure 的 support 已知是全 body union（10.3–69.7%），不得据其放行 R`);
  } else {
    const cases = (s.repairV2.cases ?? s.repairV2) as Record<string, any>;
    const rCases = new Set([...(s.spec.cases.m_8?.set ?? []), ...(s.spec.cases.core_32?.set ?? [])]);
    let checked = 0;
    for (const id of rCases) {
      const entry = cases?.[id];
      if (!entry) { f.fail(`repair-v2 缺 case ${id}（R 消费面 = core_32 ∪ m_8）`); continue; }
      const grow = Number(entry?.params?.support_grow_px ?? NaN);
      if (!Number.isFinite(grow)) { f.fail(`repair-v2 ${id}: 缺 params.support_grow_px（局部性无法核验，不猜默认值）`); continue; }
      const imgFor = (key: string): PngImage | null => {
        const refe = entry?.[key];
        if (!refe?.path) { f.fail(`repair-v2 ${id}: 缺 ${key} 文件引用`); return null; }
        const abs = isAbsolute(refe.path) ? refe.path : [join(s.runRoot, refe.path), join(s.repoRoot, refe.path)].find((p) => existsSync(p));
        if (!abs) { f.fail(`repair-v2 ${id}/${key}: 文件不存在（${refe.path}）`); return null; }
        const buf = readFileSync(abs);
        if (isHex64(refe.sha256) && sha256Buf(buf) !== refe.sha256) f.fail(`repair-v2 ${id}/${key}: 实 hash ≠ 索引声明`);
        else if (!isHex64(refe.sha256)) f.fail(`repair-v2 ${id}/${key}: 索引缺 64hex sha256`);
        const d = decodePng(buf);
        if (!d.ok) { f.fail(`repair-v2 ${id}/${key}: PNG 不可解码：${d.error}`); return null; }
        return d.image;
      };
      const core = imgFor("core"), support = imgFor("support"), context = imgFor("context");
      if (core && support) {
        const cb = nonzeroBbox(core), sb = nonzeroBbox(support);
        if (!cb) f.fail(`repair-v2 ${id}: core 全零（空接触域必须走机械跳过记录，不放空图）`);
        else if (!bboxWithin(sb, cb, grow + R_GROW_TOL_PX))
          f.fail(`repair-v2 ${id}: support bbox 超出 core+${grow}px(+${R_GROW_TOL_PX} 栅格容差) 派生范围——疑似仍非接触组局部域`);
        if (core && support && !allSamplesIn(support, [0, 255])) f.fail(`repair-v2 ${id}: support 非二值`);
      }
      if (core && context) {
        const cb = nonzeroBbox(core), xb = nonzeroBbox(context);
        const cgrow = Number(entry?.params?.context_grow_px ?? NaN);
        if (Number.isFinite(cgrow) && !bboxWithin(xb, cb, cgrow + R_GROW_TOL_PX))
          f.fail(`repair-v2 ${id}: context bbox 超出 core+${cgrow}px 派生范围`);
      }
      checked++;
    }
    f.note("repair_v2_cases_checked", checked);
  }
  // 2) 计划行与图核验（draft/最终 manifest 都按同一契约核；缺 manifest 用展开行）
  const rJobs = plannedRows(s, (g) => g === "R_calib" || g === "R_repeat");
  f.note("planned_source", rJobs.fromManifest ? "manifest.json" : "spec 机械展开");
  const counts = checkJobsClosed(s, "R", rJobs.rows, s.runRoot, f);
  // 3) 逐行图/父图机械核验（不依赖是否已执行）
  let transformMissing = 0;
  for (const job of rJobs.rows) {
    const jid = String(job.job_id);
    const method = String(job.method ?? "");
    const isR0 = method === "R0";
    // 父图冻结：B2 同 case/seed（不按最好看挑选 = 机械 id 绑定）
    const wantParent = b2JobId(String(job.case_id), Number(job.seed));
    const deps: string[] = job.depends_on ?? [];
    if (!isR0 && (!deps.includes(wantParent))) f.fail(`${jid}: depends_on ${JSON.stringify(deps)} 未绑定冻结父图 ${wantParent}（B2 同 case/seed）`);
    if (isR0 && job.reuse_of !== wantParent) f.fail(`${jid}: R0 reuse_of=${String(job.reuse_of)} ≠ ${wantParent}`);
    if (isR0) continue; // R0 不采样，无图
    const g = graphOf(s, job, s.runRoot);
    if (g.error) { f.fail(`${jid}: ${g.error}`); continue; }
    if (!g.json) continue;
    // 修复阶段禁 pose（全新 MODEL，不挂初采样姿态 patch）
    if (hasClass(g.json, "AnimaLLLiteApply") || hasClass(g.json, "ModelPatchLoader"))
      f.fail(`${jid}: R 图含姿态节点（修复阶段必须关闭 pose，不让 RS 按旧全景 scene 在裁剪画布重渲染）`);
    const hasDD = hasClass(g.json, "DifferentialDiffusion");
    const wantDD = /^R2|^R3/.test(method);
    if (wantDD && !hasDD) f.fail(`${jid}: ${method} 图缺 DifferentialDiffusion（灰度外环机制未接线）`);
    if (!wantDD && hasDD) f.fail(`${jid}: ${method} 图不应含 DifferentialDiffusion（单因素对照被污染）`);
    if (wantDD) {
      for (const [nid, node] of Object.entries(g.json as Record<string, any>)) {
        if (node?.class_type === "DifferentialDiffusion" && node?.inputs?.strength !== undefined && Number(node.inputs.strength) !== 1)
          f.fail(`${jid}: DifferentialDiffusion(${nid}).strength=${String(node.inputs.strength)} ≠ 冻结值 1`);
      }
      // gray 输入接线：LoadImage 引用 input_files 里 gray 的 target
      const grayTargets = new Set((job.input_files ?? []).filter((i: any) => /gray/.test(String(i?.source?.path ?? "")) || /gray/i.test(String(i?.target ?? ""))).map((i: any) => String(i.target)));
      const loaded = new Set(Object.values(g.json as Record<string, any>).filter((n: any) => n?.class_type === "LoadImage").map((n: any) => String(n?.inputs?.image)));
      if (grayTargets.size > 0 && ![...grayTargets].some((t) => loaded.has(t)))
        f.fail(`${jid}: ${method} 图未接 gray 输入（LoadImage 未引用 ${[...grayTargets].join("/")}）`);
    }
    // T3c 目标缺陷探针：R3 的 IMAGE 输入不得再经 VAEDecode
    if (/^R3/.test(method)) {
      for (const [nid, node] of Object.entries(g.json as Record<string, any>)) {
        if (node?.class_type !== "YugangRSMaskedImg2Img") continue;
        for (const [k, v] of Object.entries((node?.inputs ?? {}) as Record<string, unknown>)) {
          if (k === "image" && Array.isArray(v)) {
            const up = (g.json as Record<string, any>)[String(v[0])];
            if (up?.class_type === "VAEDecode") f.fail(`${jid}: R3 的 image 输入误接 VAEDecode(${String(v[0])}) 输出（T3c 修正对象；IMAGE 不得再解码回灌）`);
          }
        }
      }
    }
    // Stitch 输出契约：expected 1024×768（F1 已核 manifest 值；这里核图内有 Stitch 且 success 实测尺寸）
    if (!hasClass(g.json, "InpaintStitchImproved")) f.fail(`${jid}: R 图缺 InpaintStitchImproved（最终输出必须是贴回原生画布 1024×768）`);
    // 同 crop 变换证据（T4c）：每 (case,seed) 一份共享 transform 记录，R1/R2/R3 同窗口同倍率
    const tpaths = [join(s.runRoot, "crops", `${String(job.case_id)}__${job.seed}`, "transform.json"),
      join(s.runRoot, "crops", `${jid}-transform.json`),
      join(s.runRoot, "generation-info", `${jid}-transform.json`)];
    const tp = tpaths.find((p) => existsSync(p));
    if (!tp) transformMissing++;
    else {
      f.ev(rel(s.runRoot, tp));
      const tr = readJson(tp);
      if (!tr.ok) f.fail(`${jid}: transform 记录不可读：${tr.error}`);
      else {
        const v = tr.value;
        const ring = Number(v?.ring_px_crop ?? NaN);
        const ratio = Number(v?.ring_ratio_crop ?? v?.ring_ratio ?? NaN);
        const short = Number(v?.crop_short_side ?? 768);
        if (!Number.isFinite(ring) && !Number.isFinite(ratio))
          f.fail(`${jid}: transform 记录缺 ring_px_crop/ring_ratio——native 61px 环 resize 后不得自动宣称 crop-space 8%`);
        if (Number.isFinite(ratio) && Math.abs(ratio - 0.08) > 1e-6) f.fail(`${jid}: ring_ratio=${ratio} ≠ 0.08`);
        if (Number.isFinite(ring) && Math.abs(ring - Math.round(0.08 * short)) > 1) f.fail(`${jid}: ring_px_crop=${ring} ≠ round(0.08×${short})=${Math.round(0.08 * short)}`);
      }
    }
    // 已执行 success 行：falloff_info + noise audit 原证（T4c YugangRepairMaskFalloff）+ 父图 hash 上传绑定
    const row = lastRow(s, jid);
    if (row?.status === "success") {
      const { hits, error } = loadStudyMarkers(s, jid);
      if (error) f.fail(`${jid}: ${error}`);
      else if (hits) {
        if (wantDD && hits.falloff.length === 0) f.fail(`${jid}: 缺 falloff_info 原证（T4c YugangRepairMaskFalloff 未记录，crop-space 环宽不成立）`);
        if (wantDD && hits.noiseAudit.length === 0) f.fail(`${jid}: 缺 noise audit 原证（灰度→latent noise_mask 的实际值域无法核验）`);
      }
      const prow = lastRow(s, wantParent);
      if (prow?.status !== "success") f.fail(`${jid}: success 但冻结父图 ${wantParent} 状态为 ${String(prow?.status ?? "无记录")}（父图必须先真实产出）`);
    }
    // 机械跳过：父图仍交付（所有父图保留）
    if (row?.status === "skipped_mechanical") {
      const prow = lastRow(s, wantParent);
      const files = prow?.outputs?.files ?? {};
      const anyLocal = Object.values(files).some((fp) => localImagePath(s, wantParent, String(fp)) !== null);
      if (prow?.status !== "success" || !anyLocal) f.fail(`${jid}: 机械跳过但父图 ${wantParent} 未保留可交付产物（跳过必须保留父图）`);
    }
  }
  if (transformMissing > 0)
    f.fail(`${transformMissing} 个 R 采样行缺 crop transform 记录（crops/<case>__<seed>/transform.json 或 <job>-transform.json）——同 crop/同倍率无法核验（T4c 未落或执行未回收）`);
  f.note("counts", { total: counts.total, missing: counts.missing, byStatus: counts.byStatus });
  return done("F4", f);
}

// ---------------------------------------------------------------------------
// F5 —— H/P/W 全组终态 + W-RS 16 复用绑定 B2 hash + QG 仅等权单文件 + clip 空操作如实
// ---------------------------------------------------------------------------

function verifyF5(s: VerifyShared): CriterionResult {
  const f = new Findings();
  f.ev(rel(s.runRoot, join(s.runRoot, "results.jsonl")), rel(s.runRoot, join(s.runRoot, "generation-info")));
  if (!s.spec) return done("F5", f, { fatal: `spec 未载入：${s.specError}` });
  if (!s.manifest && !s.expanded) return done("F5", f, { fatal: `manifest/展开均不可用（${s.manifestError}）` });
  const scope = plannedRows(s, (g) => ["H", "P", "W-S", "W-RS", "W-G"].includes(g));
  f.note("planned_source", scope.fromManifest ? "manifest.json" : "spec 机械展开");
  const counts = checkJobsClosed(s, "H/P/W", scope.rows, s.runRoot, f);
  // W-RS：恰好 16 个 (0.8,0.8) 复用行，绑定 B2 同 case/seed 图 hash（运行时绑定由 closure 核）
  const wrsReuse = scope.rows.filter((j) => String(j.group) === "W-RS" && j.sample_kind === "reuse");
  if (wrsReuse.length !== 16) f.fail(`W-RS 复用行 ${wrsReuse.length} ≠ 16（(0.8,0.8) 对角项应复用 B2，不重复采样）`);
  for (const j of wrsReuse) {
    const want = b2JobId(String(j.case_id), Number(j.seed));
    if (j.reuse_of !== want) f.fail(`${String(j.job_id)}: reuse_of=${String(j.reuse_of)} ≠ B2 原图 ${want}`);
    const w = j.weights ?? {};
    if (Math.abs(Number(w.A ?? 0) - 0.8) > 1e-9 || Math.abs(Number(w.B ?? 0) - 0.8) > 1e-9)
      f.fail(`${String(j.job_id)}: 复用行权重 ${JSON.stringify(w)} ≠ (0.8,0.8)`);
  }
  // W-G QG：只有文件级等权单参数，禁止虚构异权全局对照
  const wgQg = scope.rows.filter((j) => String(j.group) === "W-G" && String(j.case_id).startsWith("QG-"));
  if (wgQg.length !== 24) f.fail(`W-G QG 行 ${wgQg.length} ≠ 24（4 动作×2 seeds×3 文件级权重）`);
  for (const j of wgQg) {
    const w = j.weights ?? {};
    if (Object.keys(w).length !== 1 || w.file === undefined)
      f.fail(`${String(j.job_id)}: QG 全局对照权重 ${JSON.stringify(w)} 非文件级单参数（同文件不具两个可独立全局加权的角色参数）`);
  }
  // H：只允许 B0/B2；B2 不可用保留阻塞，不偷偷换 B1
  for (const j of scope.rows.filter((x) => String(x.group) === "H")) {
    if (!["B0", "B2"].includes(String(j.method))) f.fail(`${String(j.job_id)}: H 组出现方法 ${String(j.method)}（只允许 B0/B2，不许 B1 顶替）`);
  }
  // P：core LoraLoader（不用 remap loader）、denoise 0.25、父图 B2 m_8@首seed
  for (const j of scope.rows.filter((x) => String(x.group) === "P" && String(x.method) !== "R0")) {
    const jid = String(j.job_id);
    if (String(j.method) === "P2" && j.sample_kind === "reuse") continue; // 条件复用行无独立图（F1 已核 hash 相等）
    const g = graphOf(s, j, s.runRoot);
    if (g.error) { f.fail(`${jid}: ${g.error}`); continue; }
    if (!g.json) continue;
    if (hasClass(g.json, "AnimaLoRARemapTagLoader")) f.fail(`${jid}: P 图用了 AnimaLoRARemapTagLoader（2B P 组统一 core LoraLoader，不做 28→52 remap）`);
    if (!hasClass(g.json, "LoraLoader")) f.fail(`${jid}: P 图缺 core LoraLoader`);
    for (const [nid, node] of Object.entries(g.json as Record<string, any>)) {
      if (node?.class_type === "KSampler" && node?.inputs?.denoise !== undefined && Math.abs(Number(node.inputs.denoise) - 0.25) > 1e-9)
        f.fail(`${jid}: KSampler(${nid}).denoise=${String(node.inputs.denoise)} ≠ P pass 冻结值 0.25`);
    }
    const wantParent = b2JobId(String(j.case_id), Number(j.seed));
    if (!(j.depends_on ?? []).includes(wantParent)) f.fail(`${jid}: P 行未绑定父图 ${wantParent}`);
  }
  // clip TE=0 空操作：runtime 谎称已在 closure 核；这里核 manifest 记录面
  if (s.manifest) {
    const snap = Array.isArray(s.manifest.characters_snapshot) ? s.manifest.characters_snapshot : [];
    if (snap.length && snap.every((c: any) => Number(c?.matched_key_counts?.clip) === 0) && !String(s.manifest.lora_clip_inert_note ?? "").trim())
      f.fail("manifest 缺 clip 空操作记录（matched_key_counts.clip=0 必须如实记录，不谎称生效）");
  }
  f.note("counts", { total: counts.total, missing: counts.missing, byStatus: counts.byStatus });
  return done("F5", f);
}

// ---------------------------------------------------------------------------
// F6 —— Downloads 交付（消费 T7a archive 的真实 collect/delivery/report 结构，不另造 schema）
// ---------------------------------------------------------------------------

const FORBIDDEN_PREFILL = [
  /"confirmed_action_success"\s*:\s*(true|false|0|1|2)/i,
  /"in_frame_success"\s*:\s*(true|false|0|1|2)/i,
  /评分\s*[:：]\s*[0-2]\b/,
  /建议采用配置\s*[:：]\s*[^"\s]/,
];

function verifyF6(s: VerifyShared): CriterionResult {
  const f = new Findings();
  const deliveryRoot = s.spec?.paths?.delivery_root && String(s.spec.paths.delivery_root).startsWith("/")
    ? String(s.spec.paths.delivery_root)
    : join(homedir(), "Downloads", "yugang-ab"); // 主人指定绝对路径（spec.paths.delivery_root），不从 repo root 派生
  f.ev(join(s.runRoot, "delivery.json"), join(s.runRoot, "collect.json"), deliveryRoot);
  if (s.spec?.paths?.delivery_root && String(s.spec.paths.delivery_root).startsWith("/")) f.note("delivery_root_source", "spec.paths.delivery_root");
  // collect.json（archive 的机械消费面：complete + blocking_issues）
  const cj = readJson(join(s.runRoot, "collect.json"));
  if (!cj.ok) f.fail(`collect.json 缺失/不可读（${cj.error}）——T7a collect 未真实执行；「写了 delivery」不等于自证完整，collect 是前置门`);
  else {
    if (cj.value?.complete !== true) f.fail(`collect.json complete=${String(cj.value?.complete)} ≠ true`);
    const bi = cj.value?.blocking_issues;
    if (Array.isArray(bi) && bi.length > 0) f.fail(`collect.json 有 ${bi.length} 条 blocking_issues（示例：${JSON.stringify(bi.slice(0, 3))}）`);
  }
  // delivery.json（run-root 权威副本；字段=archive.md 冻结面）
  const dj = readJson(join(s.runRoot, "delivery.json"));
  if (!dj.ok) return done("F6", f, { fatal: `delivery.json 缺失/不可读（${dj.error}）——尚未真实交付，Downloads 写入未发生；不伪造交付状态` });
  const d = dj.value;
  if (d?.complete !== true || d?.status !== "delivered_awaiting_user_review")
    f.fail(`delivery.json complete=${String(d?.complete)} status=${String(d?.status)} ≠ (true, delivered_awaiting_user_review)`);
  for (const [field, want] of [["manifest_sha256", s.manifestSha], ["spec_sha256", s.specSha], ["preflight_sha256", s.preflightSha]] as const) {
    const v = d?.[field];
    if (!isHex64(v)) f.fail(`delivery.json.${field} 非 64hex（${JSON.stringify(v ?? null)}）`);
    else if (want === null) f.fail(`delivery.json.${field} 无法与当前文件核对（源文件缺失）`);
    else if (v !== want) f.fail(`delivery.json.${field}=${v} ≠ 当前实文件 hash ${want}（交付绑定的不是当前版本）`);
  }
  if (d?.baseline_check !== undefined && d.baseline_check !== null) {
    const bc = d.baseline_check;
    if (typeof bc === "object" && (bc.ok === false || (Array.isArray(bc.changed) && bc.changed.length > 0)))
      f.fail(`delivery.json.baseline_check 报告既有物料变化：${JSON.stringify(bc).slice(0, 300)}`);
  } else f.fail("delivery.json 缺 baseline_check（既有 01–46 物料保护核对记录）");
  const revision = String(d?.revision ?? "");
  if (!revision) f.fail("delivery.json 缺 revision（主人反馈必须能绑定交付 revision）");
  // files[]：逐文件 hash/字节 + PNG 真解码（不做任何视觉评分）
  const files: any[] = Array.isArray(d?.files) ? d.files : [];
  if (files.length === 0) f.fail("delivery.json.files 为空（无逐文件交付记录）");
  const jobIds = new Set<string>();
  let decoded = 0;
  for (const item of files) {
    const folder = String(item?.folder ?? ""), rp = String(item?.rel ?? "");
    if (!folder || !rp) { f.fail(`delivery.files 项缺 folder/rel：${JSON.stringify(item).slice(0, 120)}`); continue; }
    const abs = join(deliveryRoot, folder, rp);
    if (!existsSync(abs)) { f.fail(`交付文件不存在：${abs}`); continue; }
    const bytes = readFileSync(abs);
    if (typeof item?.bytes === "number" && bytes.length !== item.bytes) f.fail(`${folder}/${rp}: 实字节 ${bytes.length} ≠ 记录 ${item.bytes}`);
    if (isHex64(item?.sha256)) {
      const sha = sha256Buf(bytes);
      if (sha !== item.sha256) f.fail(`${folder}/${rp}: 实 hash ${sha} ≠ 记录 ${item.sha256}`);
      // 原图 hash 与 run-root 相同：source 指向 images/<job>/ 时核对
      if (typeof item?.job_id === "string") jobIds.add(item.job_id);
    } else f.fail(`${folder}/${rp}: 记录 sha256 非 64hex`);
    if (rp.toLowerCase().endsWith(".png")) {
      const dec = decodePng(bytes);
      if (!dec.ok) f.fail(`${folder}/${rp}: PNG 不可真解码：${dec.error}`);
      else decoded++;
    }
    const txt = rp.toLowerCase().endsWith(".md") || rp.toLowerCase().endsWith(".json");
    if (txt && bytes.length < 2_000_000) {
      const text = bytes.toString("utf8");
      for (const p of FORBIDDEN_PREFILL) if (p.test(text)) f.fail(`${folder}/${rp}: 含助手预填视觉结论形态 ${p.source}（视觉验收永久归主人）`);
    }
  }
  f.note("png_decoded", decoded);
  // job 并集 == 预定集合（技术失败无图也必须有记录，不静默缺项）
  const planned = s.manifestJobs.size > 0 ? [...s.manifestJobs.keys()] : (s.expanded ?? []).map((r) => r.job_id);
  const rj = readJson(join(s.runRoot, "report.json"));
  const failureRecorded = new Set<string>();
  if (rj.ok) {
    const walk = (x: unknown): void => {
      if (x && typeof x === "object") for (const [k, v] of Object.entries(x as Record<string, unknown>)) {
        if (/error|failed|skipped/i.test(k) && typeof v === "string") failureRecorded.add(v);
        walk(v);
      }
    };
    walk(rj.value);
  } else f.note("report_json", `report.json 缺失（${rj.error}）——技术失败记录面不完整`);
  const uncovered = planned.filter((jid) => !jobIds.has(jid) && !failureRecorded.has(jid));
  if (uncovered.length > 0)
    f.fail(`job 并集缺 ${uncovered.length} 项（既无交付文件也无技术失败记录；示例：${uncovered.slice(0, 6).join(", ")}）`);
  for (const jid of jobIds) if (planned.length && !planned.includes(jid)) f.fail(`delivery 含计划外 job_id ${jid}`);
  // folders[]：14 个决策目录（47–60，可能带 @run- revision 后缀）+ 每目录最小布局
  const wantFolders = Object.keys((s.spec?.delivery_folders_7_2 ?? {}) as Record<string, unknown>).filter((k) => !k.startsWith("_"));
  const deliveredFolders: string[] = Array.isArray(d?.folders) ? d.folders.map((x: any) => String(typeof x === "string" ? x : x?.folder ?? "")) : [];
  if (deliveredFolders.length !== wantFolders.length)
    f.fail(`delivery.folders ${deliveredFolders.length} 个 ≠ 计划决策目录 ${wantFolders.length} 个`);
  for (const want of wantFolders) {
    const hit = deliveredFolders.find((x) => x === want || x.startsWith(`${want}@run-`));
    if (!hit) { f.fail(`缺决策目录 ${want}（或带 revision 后缀的对应目录）`); continue; }
    const dir = join(deliveryRoot, hit);
    for (const must of ["README.md", "manifest.csv", "运行记录.jsonl", "参数与接线", "控制图", "原生裁剪"]) {
      if (!existsSync(join(dir, must))) f.fail(`${hit}: 缺 ${must}（§7.2 每决策目录最小布局）`);
    }
    const readme = join(dir, "README.md");
    if (existsSync(readme)) {
      const text = readFileSync(readme, "utf8");
      for (const p of FORBIDDEN_PREFILL) if (p.test(text)) f.fail(`${hit}/README.md: 含预填视觉结论形态 ${p.source}`);
    }
  }
  // Downloads 顶层：本轮索引 + delivery.json 副本（与 run-root 权威副本同 hash）
  if (!existsSync(join(deliveryRoot, "本轮索引.md"))) f.fail("Downloads 顶层缺 本轮索引.md");
  const dCopy = join(deliveryRoot, "delivery.json");
  if (!existsSync(dCopy)) f.fail("Downloads 顶层缺 delivery.json 副本");
  else {
    const a = sha256File(dCopy), b = sha256File(join(s.runRoot, "delivery.json"));
    if (a !== b) f.fail(`Downloads delivery.json（${a}）与 run-root 权威副本（${b}）不一致`);
  }
  // 既有物料保护：pre-existing-downloads.json 基线（298 文件/335 条目）不被修改/覆盖
  const bl = readJson(join(s.runRoot, "checks", "pre-existing-downloads.json"));
  if (!bl.ok) f.fail(`checks/pre-existing-downloads.json 不可读（${bl.error}）——保护基线丢失`);
  else {
    const b2 = bl.value;
    const fl: any[] = Array.isArray(b2.files) ? b2.files : [];
    if (fl.length !== Number(b2?.counts?.files) || fl.length !== 298)
      f.fail(`保护基线自身被改动嫌疑：files ${fl.length} 条 ≠ counts.files ${String(b2?.counts?.files)}（应 298；本核验只读该文件，绝不重写）`);
    const entries = Number(b2?.counts?.entries);
    if (entries !== fl.length + Number(b2?.counts?.symlinks ?? 0) + Number(b2?.counts?.directories ?? 0) || entries !== 335)
      f.fail(`保护基线条目数 ${entries} ≠ 335（files+symlinks+directories 不自洽，基线疑似被覆盖）`);
    let changed = 0, vanished = 0;
    for (const item of fl) {
      const abs = join(String(b2.absolute_root ?? deliveryRoot), String(item.path));
      if (!existsSync(abs)) { vanished++; if (vanished <= 5) f.fail(`既有物料消失：${item.path}`); continue; }
      const st = statSync(abs);
      if (st.size !== Number(item.bytes)) { changed++; if (changed <= 5) f.fail(`既有物料被改动：${item.path}（字节 ${st.size} ≠ ${item.bytes}）`); continue; }
      const sha = sha256File(abs);
      if (sha !== item.sha256) { changed++; if (changed <= 5) f.fail(`既有物料被改动：${item.path}（hash 不符）`); }
    }
    f.note("pre_existing", { files: fl.length, changed, vanished });
    // 编号冲突：基线目录若已含 47–60 名，交付必须走 revision 后缀
    const baseDirs: string[] = Array.isArray(b2.directories) ? b2.directories.map((x: any) => String(typeof x === "string" ? x : x?.path ?? "")) : [];
    for (const want of wantFolders) {
      if (baseDirs.some((x) => x === want || x.startsWith(`${want}/`)) && deliveredFolders.includes(want))
        f.fail(`目录编号冲突：${want} 在基线中已存在且交付未加 @run- revision 后缀（不得覆盖既有物料）`);
    }
  }
  return done("F6", f);
}

// ---------------------------------------------------------------------------
// F7 —— 当前版本既有 npm test + 保护源码范围 + 热开关提交事实 + 证据 hash + 凭据安全扫描
// ---------------------------------------------------------------------------

/** 凭据扫描只安全模式：绝不读 .env/auth/models/db/fish.config；64hex 资产 hash 不当密钥。 */
const SECRET_PATTERNS: Array<{ re: RegExp; label: string }> = [
  { re: /sk-[A-Za-z0-9_-]{16,}/, label: "sk- 形态密钥" },
  { re: /-----BEGIN [A-Z ]*PRIVATE KEY-----/, label: "私钥块" },
  { re: /Bearer\s+[A-Za-z0-9._~+/=-]{20,}/, label: "Bearer token" },
  { re: /"api[_-]?key"\s*:\s*"[^"]{8,}"/i, label: "api_key 字段" },
  { re: /\b(password|passwd|secret|access_token|refresh_token)\s*[:=]\s*["']?[A-Za-z0-9._~+/=-]{12,}/i, label: "口令/token 赋值" },
  { re: /(https?|ftp):\/\/[^/\s:@]+:[^/\s:@]+@/, label: "URL 内嵌凭据" },
];
const FORBIDDEN_READ = new Set([".env", "auth.json", "models.json", "fish.db", "fish.config.json"]);

function listTextFiles(dir: string, out: string[], cap = 4000): void {
  let entries: string[];
  try { entries = readdirSync(dir); } catch { return; }
  for (const name of entries) {
    if (out.length >= cap) return;
    if (FORBIDDEN_READ.has(name)) continue; // 防御性：即使出现在 run-root 也不读
    const p = join(dir, name);
    let stt; try { stt = statSync(p); } catch { continue; }
    if (stt.isDirectory()) listTextFiles(p, out, cap);
    else if (/\.(json|jsonl|log|txt|csv|md)$/i.test(name) && stt.size <= 32 * 1024 * 1024) out.push(p);
  }
}

function verifyF7(s: VerifyShared): CriterionResult {
  const f = new Findings();
  const checks = join(s.runRoot, "checks");
  const npmLog = join(checks, "npm-test.log");
  const scopePath = join(checks, "change-scope.json");
  const hotDir = join(checks, "draw-hot-switch");
  f.ev(rel(s.runRoot, npmLog), rel(s.runRoot, scopePath), rel(s.runRoot, hotDir), rel(s.runRoot, join(s.runRoot, "checks", "pre-existing-source.json")));
  // 1) 当前版本既有 npm test：日志存在 + 全绿 + 与 change-scope 绑定当前 HEAD
  const logExists = existsSync(npmLog);
  if (!logExists) f.fail("checks/npm-test.log 缺失——当前交付版本的既有 npm test 结果无实证（不得拿历史/候选日志冒充当前版本）");
  const scope = readJson(scopePath);
  if (!scope.ok) f.fail(`checks/change-scope.json 缺失/不可读（${scope.error}）——变更范围与测试绑定无实证（字段契约见 contracts/verify.md）`);
  if (logExists) {
    const text = readFileSync(npmLog, "utf8");
    const pass = text.match(/#\s*pass\s+(\d+)/); const fail = text.match(/#\s*fail\s+(\d+)/);
    if (!pass || Number(pass[1]) === 0) f.fail("npm-test.log 无「# pass N>0」汇总（非既有测试全量输出）");
    if (!fail || Number(fail[1]) !== 0) f.fail(`npm-test.log fail=${fail ? fail[1] : "无汇总"} ≠ 0`);
    if (scope.ok) {
      const wantSha = String(scope.value?.npm_test?.log_sha256 ?? "");
      if (isHex64(wantSha) && wantSha !== sha256File(npmLog)) f.fail("change-scope.npm_test.log_sha256 ≠ npm-test.log 当前实 hash（日志与记录脱钩）");
      const head = gitRun(s.repoRoot, ["rev-parse", "HEAD"]);
      if (String(scope.value?.git?.head ?? "") !== head.stdout) f.fail(`change-scope.git.head=${String(scope.value?.git?.head)} ≠ 当前 HEAD ${head.stdout || head.error}（npm test 未绑定当前版本，须重跑重录）`);
    }
  }
  // 2) 保护源码对照：pre-existing-source 基线 290 文件，allowlist 只有 hash 钉死的 hot-10 + AGENTS 授权 delta
  const bj = readJson(join(checks, "pre-existing-source.json"));
  const cand = readJson(join(hotDir, "candidate-preparation.json"));
  const rel4 = readJson(join(hotDir, "hot-switch-release.json"));
  const local = readJson(join(hotDir, "local-validation.json"));
  if (!bj.ok) f.fail(`pre-existing-source.json 缺失/不可读（${bj.error}）`);
  else {
    const baseFiles = (bj.value?.files ?? {}) as Record<string, { type?: string; bytes?: number; sha256?: string }>;
    const hot10 = new Map<string, string>();
    if (cand.ok && Array.isArray(cand.value?.candidate?.files))
      for (const e of cand.value.candidate.files) if (typeof e?.path === "string" && isHex64(e?.sha256)) hot10.set(e.path, e.sha256);
    if (hot10.size !== 10) f.fail(`candidate-preparation.json 未提供 10 文件精确 hash（实得 ${hot10.size}）——allowlist 无法 hash 钉死`);
    const agentsAllowed = new Set<string>();
    if (rel4.ok) for (const h of extractHex64(String(rel4.value?.mainWorktreeProtection?.agentsMd ?? ""))) agentsAllowed.add(h);
    if (local.ok) {
      const arr = (local.value?.root?.fileHashes?.files ?? []) as any[];
      for (const e of arr) if (String(e?.path) === "AGENTS.md" && isHex64(e?.sha256)) agentsAllowed.add(e.sha256);
    }
    if (agentsAllowed.size === 0) f.fail("无法从 release/local-validation 证据提取 AGENTS.md 授权 delta hash");
    let drifted = 0, hotOk = 0;
    for (const [p, meta] of Object.entries(baseFiles)) {
      const abs = join(s.repoRoot, p);
      const cur = sha256File(abs);
      if (cur === null) { f.fail(`受保护文件缺失：${p}`); drifted++; continue; }
      if (cur === meta.sha256) continue;
      if (p === "AGENTS.md") {
        if (agentsAllowed.has(cur)) { hotOk++; continue; } // 热 hunk + 用户另授权的 git1 文档 delta（release 证据有 hash）
        f.fail(`AGENTS.md 现 hash ${cur} 不在授权集合（${[...agentsAllowed].join(" / ")}）——超出 hot+git1 delta 的改动`);
        drifted++; continue;
      }
      const want = hot10.get(p);
      if (want !== undefined && cur === want) { hotOk++; continue; }
      if (want !== undefined) { f.fail(`热开关文件 ${p} 现 hash ${cur} ≠ 授权部署 hash ${want}（列入 allowlist 后又被改）`); drifted++; }
      else { f.fail(`受保护文件被改动：${p}（基线 ${meta.sha256} → 现 ${cur}，不在 hot-10/AGENTS delta allowlist）`); drifted++; }
    }
    f.note("protected_files", { total: Object.keys(baseFiles).length, hot_matched: hotOk, drifted });
  }
  // 3) 热开关提交事实（live git 独立核对，不只信证据 JSON）
  const exists = gitRun(s.repoRoot, ["cat-file", "-e", `${HOT_COMMIT}^{commit}`]);
  if (!exists.ok) f.fail(`热开关提交 ${HOT_COMMIT} 在本地仓库不存在（${exists.error}）`);
  else {
    const par = gitRun(s.repoRoot, ["rev-parse", `${HOT_COMMIT}^`]);
    if (par.stdout !== HOT_PARENT) f.fail(`热提交父=${par.stdout || par.error} ≠ 生产基线 ${HOT_PARENT}`);
    const dt = gitRun(s.repoRoot, ["diff-tree", "--no-commit-id", "--name-only", "-r", HOT_COMMIT]);
    const files = dt.stdout.split("\n").filter(Boolean).sort();
    if (JSON.stringify(files) !== JSON.stringify([...HOT_TEN_PATHS].sort()))
      f.fail(`热提交文件集 ${JSON.stringify(files)} ≠ 精确 hot-10（不得夹带实验/计划文件）`);
    const anc = gitRun(s.repoRoot, ["merge-base", "--is-ancestor", EXCLUDED_COMMIT, HOT_COMMIT]);
    if (anc.status === 0) f.fail(`热提交包含 ${EXCLUDED_COMMIT.slice(0, 7)}（14d29a1 未获本次专项授权，不得夹带）`);
    if (rel4.ok) {
      const c = rel4.value?.commit ?? {};
      if (String(c?.sha ?? "") !== HOT_COMMIT) f.fail(`release 证据 commit.sha=${String(c?.sha)} ≠ ${HOT_COMMIT}`);
      if (c?.contains14d29a1 !== false) f.fail(`release 证据 contains14d29a1=${String(c?.contains14d29a1)} ≠ false`);
    } else f.fail(`hot-switch-release.json 缺失/不可读（${rel4.error}）`);
  }
  // 4) 报告 hash 对应实文件
  const g0 = s.gateG0;
  if (g0) {
    const helperSha = extractHex64(String(g0?.helper?.sha256 ?? ""))[0];
    const curHelper = sha256File(join(s.repoRoot, "scripts", "experiments", "interaction-resource.ts"));
    if (helperSha && curHelper && helperSha !== curHelper)
      f.fail(`resource-gate-g0 记录的 helper sha ${helperSha} ≠ 当前 interaction-resource.ts 实 hash ${curHelper}（报告 hash 与实文件脱钩）`);
    const leaseSha = extractHex64(String(g0?.lease?.sha256BothEnds ?? ""))[0];
    const curLease = sha256File(join(s.runRoot, "resource-lease.json"));
    if (leaseSha && curLease && leaseSha !== curLease) f.fail(`G0 证据 lease hash ≠ 当前 resource-lease.json 实 hash（lease 在 G0 后被改写且无恢复记录，或证据过期）`);
  } else f.fail("checks/resource-gate-g0.json 缺失——G0 报告 hash 无法对实文件核验");
  const patchPath = join(hotDir, "hot-only.patch");
  if (cand.ok && existsSync(patchPath)) {
    const wantPatch = String(cand.value?.patch?.sha256 ?? "");
    const curPatch = sha256File(patchPath);
    if (isHex64(wantPatch) && curPatch !== wantPatch) f.fail(`hot-only.patch 实 hash ${curPatch} ≠ candidate-preparation 记录 ${wantPatch}`);
  }
  // 5) 运行证据凭据安全扫描（不读真实 .env/auth/models/db；64hex 资产 hash 是合法形态不报）
  const textFiles: string[] = [];
  listTextFiles(s.runRoot, textFiles);
  let hits = 0;
  for (const p of textFiles) {
    let text; try { text = readFileSync(p, "utf8"); } catch { continue; }
    for (const pat of SECRET_PATTERNS) {
      const m = text.match(pat.re);
      if (m) { hits++; if (hits <= 10) f.fail(`运行证据疑似凭据泄露：${rel(s.runRoot, p)} 命中「${pat.label}」（${m[0].slice(0, 6)}…已掩码）`); }
    }
  }
  if (hits > 10) f.fail(`……另有 ${hits - 10} 处疑似凭据命中`);
  f.note("credential_scan", { files_scanned: textFiles.length, hits, mode: "safe：未读 .env/config/auth.json/config/models.json/var/fish.db/fish.config.json；64hex 资产 hash 不判密钥" });
  f.note("isolated_lab_allowed", "experiments/、scripts/experiments/interaction-*、var/ 属本轮授权实验范围，不受基线保护约束；生产模型/工作流模板/draw 节点在基线 290 文件内已核");
  return done("F7", f);
}

// ---------------------------------------------------------------------------
// F8 —— MANUAL：全部图像验收只由主人判定；助手不代填、不代判
// ---------------------------------------------------------------------------

function verifyF8(s: VerifyShared): CriterionResult {
  const fbPath = join(s.runRoot, "user-feedback.jsonl");
  const evidence = [rel(s.runRoot, fbPath), rel(s.runRoot, join(s.runRoot, "delivery.json"))];
  const details: Record<string, unknown> = { rule: "F8 只接受主人自然语言反馈的契约登记；无反馈=pending-user；助手/subagent 不代判、不代填、不自动评分" };
  const dj = readJson(join(s.runRoot, "delivery.json"));
  const revision = dj.ok ? String(dj.value?.revision ?? dj.value?.delivery_revision ?? "") : "";
  if (!dj.ok) return { id: "F8", type: "MANUAL", status: "pending-user", reasons: [`delivery.json 尚不存在（${dj.error}）——没有已交付 revision 可绑定，主人无可看物料；等待交付后主人反馈`], evidence, details };
  const { rows, error } = readJsonl(fbPath);
  if (error && !existsSync(fbPath)) return { id: "F8", type: "MANUAL", status: "pending-user", reasons: ["user-feedback.jsonl 不存在——主人尚未反馈；未反馈内容保持未验收，不代填"], evidence, details };
  const f8 = rows.filter((r) => String(r?.scope ?? "") === "F8");
  if (f8.length === 0) return { id: "F8", type: "MANUAL", status: "pending-user", reasons: [rows.length > 0 ? `user-feedback.jsonl 有 ${rows.length} 条反馈但无 scope=F8 的明确结论——不从自由文本推断，不代填` : "user-feedback.jsonl 为空——等待主人看图结论"], evidence, details };
  const last = f8[f8.length - 1]!;
  const verdict = String(last?.verdict ?? "");
  if (String(last?.delivery_revision ?? "") !== revision)
    return { id: "F8", type: "MANUAL", status: "pending-user", reasons: [`最近 F8 反馈绑定 revision=${String(last?.delivery_revision)} ≠ 当前交付 revision=${revision}——反馈未绑定当前交付，不冒用`], evidence, details: { ...details, last_feedback_at: last?.at } };
  if (verdict === "confirmed")
    return { id: "F8", type: "MANUAL", status: "passed", reasons: [`主人已明确确认（verbatim 登记于 user-feedback.jsonl，at=${String(last?.at)}）`], evidence, details: { ...details, verdict, quote: String(last?.text ?? "").slice(0, 500) } };
  if (verdict === "rejected" || verdict === "partial")
    return { id: "F8", type: "MANUAL", status: "failed", reasons: [`主人反馈 verdict=${verdict}（逐字：${String(last?.text ?? "").slice(0, 300)}）——按主人结论如实记录，需要重跑/调整项由主人指定`], evidence, details: { ...details, verdict } };
  return { id: "F8", type: "MANUAL", status: "pending-user", reasons: [`F8 反馈 verdict=${JSON.stringify(verdict)} 不在契约枚举 confirmed|rejected|partial——未知不代填`], evidence, details };
}

// ---------------------------------------------------------------------------
// F9 —— 独立 T8 审计：等真实 reviews/delivery-audit.json；不自我审计、不读 acceptance 自证
// ---------------------------------------------------------------------------

function verifyF9(s: VerifyShared): CriterionResult {
  const f = new Findings();
  const auditPath = join(s.runRoot, "reviews", "delivery-audit.json");
  f.ev(rel(s.runRoot, auditPath));
  const aj = readJson(auditPath);
  if (!aj.ok) return done("F9", f, { fatal: `reviews/delivery-audit.json 缺失/不可读（${aj.error}）——F9 必须等待真实独立 T8 审计；本模块不生成审计、不以 acceptance passed 自证` });
  const a = aj.value;
  if (String(a?.auditor?.kind ?? "") !== "independent-T8" && !/independent|T8/i.test(String(a?.auditor?.id ?? "")))
    f.fail(`审计者标识 ${JSON.stringify(a?.auditor ?? null)} 非独立 T8（审计必须独立于交付与本 verify 模块）`);
  if (/interaction-study-verify|T3v/i.test(JSON.stringify(a?.auditor ?? {})))
    f.fail("审计者为本 verify 模块自身——F9 不允许自审");
  const consumed: string[] = Array.isArray(a?.consumed_sources) ? a.consumed_sources.map(String) : [];
  if (consumed.some((p) => p.endsWith("acceptance.json")))
    f.fail("审计 consumed_sources 含 acceptance.json——审计不得读取 verify 生成的 acceptance 来自证");
  const crit = a?.criteria ?? {};
  for (const id of ["F1", "F2", "F3", "F4", "F5", "F6", "F7", "F10"]) {
    const c = crit[id];
    if (!c || typeof c.verdict !== "string") { f.fail(`审计缺 ${id} 的明确 verdict`); continue; }
    if (!["passed", "failed"].includes(c.verdict)) f.fail(`审计 ${id}.verdict=${String(c.verdict)} 非 passed|failed`);
    for (const e of (Array.isArray(c.evidence) ? c.evidence : [])) {
      const p = String(e?.path ?? "");
      if (!p) continue;
      const abs = isAbsolute(p) ? p : [join(s.runRoot, p), join(s.repoRoot, p)].find((x) => existsSync(x)) ?? join(s.runRoot, p);
      const cur = sha256File(abs);
      if (cur === null) f.fail(`审计 ${id} 证据文件不存在：${p}`);
      else if (isHex64(e?.sha256) && e.sha256 !== cur) f.fail(`审计 ${id} 证据 ${p} 记录 hash ≠ 当前实 hash ${cur}（审计对的不是当前版本）`);
      else if (!isHex64(e?.sha256)) f.fail(`审计 ${id} 证据 ${p} 缺 64hex sha256`);
      f.ev(rel(s.runRoot, abs));
    }
  }
  const f8v = crit["F8"]?.verdict;
  if (f8v === undefined) f.fail("审计缺 F8 条目（必须明确 F8 仍归主人）");
  else if (String(f8v) === "passed" && !crit["F8"]?.user_feedback_ref) f.fail("审计把 F8 记为 passed 却无 user_feedback_ref——审计不得输出视觉通过");
  else if (!["user_only", "pending_user", "passed"].includes(String(f8v))) f.fail(`审计 F8.verdict=${String(f8v)} 非法（应 user_only/pending_user，或主人确认后的 passed+ref）`);
  return done("F9", f, { audit_at: a?.audited_at ?? null, revision: a?.delivery_revision ?? null });
}

// ---------------------------------------------------------------------------
// F10 —— 资源闸全时间线：G0 off → 队列排空 → 采样期热闸 → 作业闭合 → G1 原键恢复
// ---------------------------------------------------------------------------

function verifyF10(s: VerifyShared): CriterionResult {
  const f = new Findings();
  f.ev(rel(s.runRoot, join(s.runRoot, "resource-lease.json")), rel(s.runRoot, join(s.runRoot, "checks", "resource-gate-g0.json")),
    rel(s.runRoot, join(s.runRoot, "checks", "resource-gate-g0-raw-status.json")), rel(s.runRoot, join(s.runRoot, "checks", "resource-gate-g0-raw-queue.json")),
    rel(s.runRoot, join(s.runRoot, "jobs-closed.json")));
  const lease = s.lease;
  if (!lease) return done("F10", f, { fatal: `resource-lease.json 缺失/不可读（${s.leaseError}）` });
  const T = (v: unknown): number => Date.parse(String(v ?? ""));
  const offAt = T(lease?.off?.at);
  // 1) G0 off 事实 + raw status（原记录有 raw 键值与 gateIntact，而非单看 exit 0）
  if (!lease?.off || Number.isNaN(offAt)) f.fail("lease.off 缺失——G0 热关闭无记录");
  if (typeof lease?.originalKey !== "string") f.fail("lease.originalKey 缺失（原键状态未保存，恢复无据）");
  const rs = s.rawStatus;
  if (!rs) f.fail("checks/resource-gate-g0-raw-status.json 缺失——热闸 raw 证据（loaderDrawEnabled/rawDrawEnabledKey/gateIntact）无从核对");
  else {
    if (rs?.gate?.gateIntact !== true) f.fail(`G0 raw status gate.gateIntact=${String(rs?.gate?.gateIntact)} ≠ true`);
    const checks9 = rs?.gate?.checks ?? {};
    for (const k of ["leaseDisabled", "fieldEffectHot", "loaderValueFalse", "rawKeyFalse", "fishUnique", "pidNoDrift", "commitNoDrift", "expectedCommitOk", "configNoDrift"])
      if (checks9[k] !== true) f.fail(`G0 raw status gate.checks.${k}=${String(checks9[k])} ≠ true`);
    if (rs?.loaderDrawEnabled !== false || rs?.rawDrawEnabledKey !== "false") f.fail(`G0 raw 键值异常：loader=${String(rs?.loaderDrawEnabled)} raw=${String(rs?.rawDrawEnabledKey)}（要求 false/"false"，off 文案不代替 raw 证据）`);
    if (Number(rs?.currentFish?.pid) !== Number(lease?.off?.pid)) f.fail(`G0 raw pid ${String(rs?.currentFish?.pid)} ≠ lease.off.pid ${String(lease?.off?.pid)}（漂移）`);
    if (String(rs?.deployCommit) !== String(lease?.deployCommit)) f.fail(`G0 raw deployCommit ≠ lease（版本漂移）`);
    if (String(rs?.configSha256) !== String(lease?.off?.configSha256After)) f.fail("G0 raw configSha256 ≠ lease.off.configSha256After（配置漂移）");
  }
  if (String(lease?.preflight?.configSha256 ?? "") !== String(lease?.off?.configSha256Before ?? "")) f.fail("lease.preflight.configSha256 ≠ off.configSha256Before（off 前配置已漂移）");
  // 2) 队列排空（raw queue，含 running/pending 计数与时间）
  const rq = s.rawQueue;
  if (!rq) f.fail("checks/resource-gate-g0-raw-queue.json 缺失——旧队列排空无 raw 证据");
  else {
    if (Number(rq.httpStatus) !== 200 || Number(rq.runningCount) !== 0 || Number(rq.pendingCount) !== 0)
      f.fail(`G0 后队列非空闲（http=${String(rq.httpStatus)} running=${String(rq.runningCount)} pending=${String(rq.pendingCount)}）`);
    if (T(rq.at) < offAt) f.fail("队列核对时间早于 off——不是「关闭后等旧队列结束」的证据");
  }
  // 3) 采样期热闸：首提交在 off+排空之后；期间 status 复核 gateIntact=true；无提前恢复
  const submitTimes: number[] = [];
  for (const rows of [s.results, s.stageResults]) for (const arr of rows.values()) for (const r of arr) {
    if (r?.prompt_id || r?.client_id) { const t = T(r?.recorded_at); if (!Number.isNaN(t)) submitTimes.push(t); }
  }
  const restoreAt = lease?.restore?.at !== undefined && lease?.restore !== null ? T(lease.restore.at) : null;
  if (submitTimes.length > 0) {
    const first = Math.min(...submitTimes), lastSubmit = Math.max(...submitTimes);
    if (first < T(rq?.at ?? NaN)) f.fail(`首次实验提交（${new Date(first).toISOString()}）早于队列排空核对（${String(rq?.at)}）——「第一项提交前已禁用并等旧队列结束」不成立`);
    if (restoreAt !== null && lastSubmit > restoreAt) f.fail("存在晚于 G1 恢复的提交——采样期热闸未保持");
    if (s.g0Recheck) {
      const rcT = T(s.g0Recheck?.lease?.off?.at ?? s.g0Recheck?.verifiedAt ?? NaN);
      void rcT;
      if (s.g0Recheck?.gate?.gateIntact !== true && restoreAt === null) f.fail("采样期 status 复核 gate.gateIntact ≠ true（热闸失守）");
    } else f.note("mid_run_status", "无采样期中段 status 复核证据（checks/environment-g0-recheck.json 缺）");
  } else f.note("submissions", "results 中 0 条提交记录（当前 0 采样）——提交窗口核验暂无对象，但闭合与恢复证据仍必须齐备");
  // 4) 作业闭合（jobs-closed + state 重算，不信单文件自述）
  const jc = readJson(join(s.runRoot, "jobs-closed.json"));
  if (!jc.ok) f.fail(`jobs-closed.json 缺失/不可读（${jc.error}）——「所有已接任务闭合」无实证（runner worker-closure 未产出）`);
  else {
    const v = jc.value;
    if (v?.queueIdle !== true || v?.experimentJobsClosed !== true) f.fail(`jobs-closed 非全真（queueIdle=${String(v?.queueIdle)} experimentJobsClosed=${String(v?.experimentJobsClosed)}）`);
    if (!Array.isArray(v?.openJobIds) || v.openJobIds.length !== 0) f.fail(`jobs-closed.openJobIds=${JSON.stringify(v?.openJobIds ?? null)} ≠ []`);
    if (restoreAt !== null && T(v?.attestedAt) > restoreAt) f.fail("jobs-closed.attestedAt 晚于 G1 恢复——恢复发生在闭合证明之前");
    if (offAt && T(v?.attestedAt) < offAt) f.fail("jobs-closed.attestedAt 早于 off——不是本轮闸内的闭合证明");
    if (s.state && isHex64(v?.manifestSha256) && String(s.state.manifest_sha256 ?? "") !== String(v.manifestSha256))
      f.fail(`jobs-closed.manifestSha256 ≠ state.json manifest_sha256（闭合证明绑定的不是本 run manifest）`);
  }
  if (s.state?.jobs && typeof s.state.jobs === "object") {
    const open = Object.entries(s.state.jobs as Record<string, any>).filter(([, j]) => OPEN_STATES.has(String(j?.status))).map(([k]) => k);
    if (open.length > 0) f.fail(`state.json 仍有 ${open.length} 个在途/未决任务（${open.slice(0, 8).join(", ")}）——unknown/submitting/accepted 不得视为闭合`);
  }
  // 5) G1 恢复：原键 absent → 恢复后键再次 absent；恢复只允许在闭合之后；未知不得 restore
  if (restoreAt === null || lease?.restore === undefined || lease?.restore === null) {
    f.fail("lease.restore=null——G1 尚未执行（热闸仍持有；这是未完成项：F10 要求 off→排空→闭合→恢复完整时间线，不能只证明开始时空队列）");
    if (lease?.closed !== false) f.fail(`lease.closed=${String(lease?.closed)} 与 restore=null 矛盾`);
  } else {
    if (lease?.closed !== true) f.fail("lease.closed ≠ true（恢复后未闭合账目）");
    if (!jc.ok) f.fail("存在 restore 但无 jobs-closed.json——未知/在途状态下恢复了鱼权限（禁止）");
    if (String(lease.originalKey) === "absent") {
      const g1 = readJson(join(s.runRoot, "checks", "resource-gate-g1-raw-status.json"));
      if (!g1.ok) f.fail(`checks/resource-gate-g1-raw-status.json 缺失（${g1.error}）——恢复后原键 absence 无 raw 证据`);
      else {
        if (String(g1.value?.rawDrawEnabledKey) !== "absent") f.fail(`G1 raw 键值=${String(g1.value?.rawDrawEnabledKey)} ≠ absent（原键 absent 必须删键恢复，不得留 false 扩大/缩小权限）`);
        if (g1.value?.gate?.gateIntact !== false) f.note("g1_gate", "G1 恢复后 gateIntact=false 是预期（lease=restored 后闸不再成立），不判漂移");
        if (String(g1.value?.deployCommit ?? "") !== String(lease?.deployCommit ?? "")) f.fail("G1 raw deployCommit ≠ lease.deployCommit（版本漂移）");
        if (Number(g1.value?.currentFish?.pid ?? 0) !== Number(lease?.off?.pid ?? 0)) f.note("g1_pid", `G1 raw pid=${String(g1.value?.currentFish?.pid)}（lease.off.pid=${String(lease?.off?.pid)}；恢复不要求重启，pid 变化须有独立解释）`);
      }
    }
  }
  return done("F10", f, { state: String(lease?.state ?? ""), closed: Boolean(lease?.closed), originalKey: String(lease?.originalKey ?? "") });
}

// ---------------------------------------------------------------------------
// 命令入口
// ---------------------------------------------------------------------------

const USAGE = `interaction-study-verify —— anima-interaction-v1 离线统一 AUTO 验收（F1–F10）

用法（由 interaction-study.ts verify 转发，或直接执行本文件）：
  --auto               全部 F1–F10；AUTO(F1–F7,F9,F10) 全 passed → exit 0（F8 pending-user 不阻塞）
  --all                全部 F1–F10；仅主人反馈明确确认 F8 后全 passed → exit 0（F8 未确认=预期等待，非零）
  --criterion F<n>     单项执行（F1..F10）；passed → exit 0
  --help               本帮助
输出：逐项 passed/failed/pending-user + 理由 + 证据路径；写 <run-root>/acceptance.json（只写不读）。
任何 fail → exit 1；内部异常 → exit 2（绝不以异常路径产生 pass）。根路径只认 ctx/REPO_ROOT，不按 cwd 拼。`;

const CRITERION_FUNCS: Record<CriterionId, (s: VerifyShared) => CriterionResult> = {
  F1: verifyF1, F2: verifyF2, F3: verifyF3, F4: verifyF4, F5: verifyF5,
  F6: verifyF6, F7: verifyF7, F8: verifyF8, F9: verifyF9, F10: verifyF10,
};

export async function runVerifyCommand(ctx: { repoRoot: string; runRoot: string; argv: string[] }): Promise<void> {
  const argv = ctx.argv ?? [];
  if (argv.includes("--help") || argv.includes("-h")) { console.log(USAGE); return; }
  const auto = argv.includes("--auto");
  const all = argv.includes("--all");
  const cIdx = argv.findIndex((a) => a === "--criterion" || a.startsWith("--criterion="));
  let criterion: CriterionId | null = null;
  if (cIdx >= 0) {
    const raw = argv[cIdx]!.startsWith("--criterion=") ? argv[cIdx]!.slice("--criterion=".length) : argv[cIdx + 1];
    const up = String(raw ?? "").toUpperCase();
    if (!(CRITERION_IDS as readonly string[]).includes(up)) { console.error(`[verify] 未知 criterion：${String(raw)}（允许 F1..F10）\n\n${USAGE}`); process.exitCode = 2; return; }
    criterion = up as CriterionId;
  }
  const modeCount = [auto, all, criterion !== null].filter(Boolean).length;
  if (modeCount !== 1) { console.error(`[verify] 必须且只能指定一个模式：--auto / --all / --criterion F<n>（实得 ${modeCount} 个）\n\n${USAGE}`); process.exitCode = 2; return; }
  const mode: VerifyMode = criterion !== null ? "criterion" : all ? "all" : "auto";
  const repoRoot = resolve(ctx.repoRoot);
  const runRoot = resolve(ctx.runRoot);
  console.log(`[verify] mode=${mode} repo=${repoRoot} run=${runRoot}`);

  let shared: VerifyShared;
  try { shared = buildShared(repoRoot, runRoot); }
  catch (e) { console.error(`[verify] 证据上下文构建失败（内部异常，不产生 pass）：${(e as Error).message}`); process.exitCode = 2; return; }

  const selected: CriterionId[] = criterion ? [criterion] : [...CRITERION_IDS];
  const results = new Map<CriterionId, CriterionResult>();
  for (const id of selected) {
    let r: CriterionResult;
    try { r = CRITERION_FUNCS[id](shared); }
    catch (e) {
      r = { id, type: id === "F8" ? "MANUAL" : "AUTO", status: "failed",
        reasons: [`核验内部异常（不产生 pass）：${(e as Error).message}`], evidence: [], details: { exception: true } };
    }
    results.set(id, r);
    const head = `[${id}] ${r.type} ${r.status}`;
    console.log(head);
    for (const reason of r.reasons.slice(0, 8)) console.log(`    - ${reason}`);
    if (r.reasons.length > 8) console.log(`    - ……另有 ${r.reasons.length - 8} 条理由（全量见 acceptance.json）`);
    for (const ev of r.evidence.slice(0, 6)) console.log(`    · 证据 ${ev}`);
  }

  const list = [...results.values()];
  const summary = {
    passed: list.filter((r) => r.status === "passed").length,
    failed: list.filter((r) => r.status === "failed").length,
    pending_user: list.filter((r) => r.status === "pending-user").length,
  };
  const autoIds = selected.filter((id) => id !== "F8");
  const autoAllPassed = autoIds.every((id) => results.get(id)!.status === "passed");
  let exitCode: number;
  let rule: string;
  if (mode === "auto") { exitCode = autoAllPassed ? 0 : 1; rule = "AUTO(F1–F7,F9,F10) 全 passed → 0；F8 pending-user 不阻塞"; }
  else if (mode === "all") { exitCode = list.every((r) => r.status === "passed") ? 0 : 1; rule = "F1–F10 全 passed（F8 须主人契约确认）→ 0；F8 未确认非零=预期等待"; }
  else { exitCode = results.get(criterion!)!.status === "passed" ? 0 : 1; rule = `${criterion} passed → 0`; }

  const acceptance = {
    schema: ACCEPTANCE_SCHEMA, version: 1,
    generated_at: new Date().toISOString(),
    generated_by: "scripts/experiments/interaction-study-verify.ts (T3v)",
    repo_root: repoRoot, run_root: runRoot, mode,
    requested_criteria: selected,
    criteria: Object.fromEntries(list.map((r) => [r.id, r])),
    summary, gating: { exit_code: exitCode, rule },
    notes: [
      "本文件由 verify 写出；F9 独立审计不得消费 acceptance.json 自证，本模块也从不读取它。",
      "AUTO 不判图；F8 视觉验收只接受主人契约反馈，未反馈保持 pending-user。",
    ],
  };
  const outPath = join(runRoot, "acceptance.json");
  try {
    const tmp = `${outPath}.tmp-${process.pid}`;
    writeFileSync(tmp, `${JSON.stringify(acceptance, null, 2)}\n`, "utf8");
    renameSync(tmp, outPath);
    console.log(`[verify] acceptance 已写 ${outPath}`);
  } catch (e) {
    console.error(`[verify] acceptance.json 写入失败：${(e as Error).message}`);
    process.exitCode = 2;
    return;
  }
  console.log(`[verify] 汇总 passed=${summary.passed} failed=${summary.failed} pending-user=${summary.pending_user} → exit ${exitCode}（${rule}）`);
  process.exitCode = exitCode;
}

// 直启支持（T3a 未接线时也可用；根仍取 src/paths.ts::REPO_ROOT，不按 cwd 拼）
if (process.argv[1] !== undefined && resolve(process.argv[1]) === import.meta.filename) {
  const argv = process.argv.slice(2);
  const rIdx = argv.indexOf("--run");
  const runRoot = resolve(rIdx >= 0 ? argv[rIdx + 1]! : join(REPO_ROOT, "var", "local-driver", "anima-interaction-v1"));
  runVerifyCommand({ repoRoot: REPO_ROOT, runRoot, argv }).catch((e) => {
    console.error(`[verify] 未捕获异常（不产生 pass）：${(e as Error).stack ?? e}`);
    process.exitCode = 2;
  });
}
