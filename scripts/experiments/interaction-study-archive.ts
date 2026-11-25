#!/usr/bin/env node
/**
 * interaction-study-archive.ts —— anima-interaction-v1 的离线归档程序（T7a）。
 *
 * 职责（计划 §7 / §8.1 / §9；契约见 var/local-driver/anima-interaction-v1/contracts/archive.md）：
 *   collect  只消费**已经回收到本地 run-root** 的 runner 证据（state.json / results.jsonl /
 *            generation-info/ / images/），逐 job 核 hash、真实解码 PNG、核尺寸、核 graph、核
 *            structure 输入；产出 <run-root>/collect.json。不连网、不猜成功、不造结果；
 *            submitting/accepted/unknown/unresolved/observation_timeout/pending/无记录一律不当终态。
 *   deliver  仅在 collect 完整（全部 job 终态、全部 success/reuse 图已本地核验）时，把每种决策
 *            （spec.delivery_folders_7_2 的 47–60 目录）独占创建到主人指定 Downloads 根：
 *            README / manifest.csv / 运行记录.jsonl / 全部原 PNG / 参数与接线 / 控制图 / 原生裁剪。
 *            既有 01–46 等物料只核对报告、绝不改动；任何命名冲突 → 本轮 14 目录统一加 run 后缀；
 *            全部新文件 wx 独占写；失败不递归清理，只报告自建 revision 与续接点。
 *   report   只统计机械数量/参数/耗时/错误；delivery.json 存在且完整才报
 *            delivered_awaiting_user_review（F8=user pending）；绝不生成 user-feedback.jsonl。
 *
 * 绑定事实（2026-11-11 T3a/packager 通报；归档只按当前运行 manifest/state 的实际版本）：
 *   - root manifest.json = 896 行（808 new + 88 reuse：R0×72、W-RS 对角 0.8×16）；
 *     首 4 个 W-S 冒烟 job 另在 stages/w-s-smoke/（同 job_id）。其结果**未来由 T3/runner 吸收**
 *     进 root state，本归档不吸收、不重 POST、不以 smoke 产物冒称 root 采样图。
 *   - 当前 root graphs 是未执行 draft，R3 输出类型/最终主尺寸/source.path 正由 T3c 精确修复：
 *     R 主图 Stitch 后应为 1024×768（内部 crop 画布 768²），不得按 draft 的 768 误记。
 *     本归档以 manifest 行为绑定真值：尺寸不符 = dimension_mismatch 阻塞并列精确字段，
 *     绝不静默改判、不把 draft 或 CPU 参考 PNG 冒称采样图。
 *   - T2b 已落 44 case / 416 张结构 PNG；R 局部 mask 另存 inputs/repair-v2/repair_index.json，
 *     不覆盖原 416；实际 crop noise 由 YugangRepairMaskFalloff 节点在 generation-info 里 audit，
 *     原 native 灰度只作结构参考。deliver 的 控制图/ 因此按 **job input_files 的实际 source.path**
 *     复制（T3c 重指向后即 repair-v2 资产），并按实文件 sha 去重。
 *   - 当前采样数 0：collect 遇缺 state.json 拒绝、deliver 拒绝、report=not_run_no_records；
 *     未发生的失败不编造，真实错误/父子前后图原样保留。
 *
 * 硬边界：
 *   - 根路径唯一来源 src/paths.ts::REPO_ROOT（静态 import，不按 cwd 拼根）；
 *   - 不实现 F1–F10 总验收/独立审计（另属后续）；不做视觉评分/筛图/选优；
 *   - 不新增依赖：PNG 完整性用自带 zlib 真解码（逐 chunk CRC + inflate + unfilter），非仅魔数；
 *   - 机械裁剪只按冻结结构坐标（structure_index 的 pixel_bbox），不按图像好坏挑；
 *     默认不做 1.2× 展示副本，不做学习式超分；
 *   - 不 commit/push、不接 QQ/GPU/远端；本文件与 contracts/archive.md 之外零写入
 *     （运行时只写 run-root 自有产物 collect.json/delivery.json/report.*，以及交付 revision 目录）。
 *
 * 模块合同（T3a 后续整合进 interaction-study.ts 入口）：
 *   export async runArchiveCommand(command: 'collect'|'deliver'|'report',
 *                                  ctx: {repoRoot, runRoot, argv}): Promise<void>
 * 阻塞性失败抛 ArchiveError；collect 的「不完整」不抛错，写 collect.json（complete=false）
 * 并置 process.exitCode=1，供 verify 消费。
 */
import { createHash } from "node:crypto";
import {
  existsSync, lstatSync, mkdirSync, readFileSync, readdirSync, renameSync, statSync, writeFileSync,
} from "node:fs";
import { homedir } from "node:os";
import { basename, isAbsolute, join, resolve } from "node:path";
import { crc32, deflateSync, inflateSync } from "node:zlib";
import { REPO_ROOT } from "../../src/paths.ts";

// ---------------------------------------------------------------------------
// 常量与错误
// ---------------------------------------------------------------------------

export type ArchiveCommand = "collect" | "deliver" | "report";
export interface ArchiveCtx { repoRoot: string; runRoot: string; argv: string[] }

export class ArchiveError extends Error {}

const MANIFEST_SCHEMA = "anima-interaction-manifest.v1";
const COLLECT_SCHEMA = "anima-interaction-collect.v1";
const DELIVERY_SCHEMA = "anima-interaction-delivery.v1";
const REPORT_SCHEMA = "anima-interaction-report.v1";

/** runner.md §6：已闭合状态（归档只认这些为终态）。 */
const CLOSED_STATES = ["success", "execution_error", "reuse_resolved", "skipped_mechanical"];
/** runner.md §6：在途/未决——一律不当终态。 */
const OPEN_STATES = ["pending", "submitting", "accepted", "running", "unknown", "observation_timeout", "unresolved"];
const SOURCE_KINDS = ["structure", "parent_job", "run_root_file"];
const HEX64 = /^[0-9a-f]{64}$/;

const DEFAULT_DELIVERY_ROOT = join(homedir(), "Downloads", "yugang-ab");
const REVISION_MARKER = ".yugang-archive-revision.json";
const INDEX_BASENAME = "本轮索引.md";
const DELIVERY_BASENAME = "delivery.json";

/** manifest 每行必备键（存在性强制；语义空值按 sample_kind 条件放行——runner.md §7 同口径）。 */
const REQUIRED_JOB_FIELDS = [
  "job_id", "case_id", "pair", "action", "framing", "seed", "stage", "stage_seed", "method",
  "weights", "parent", "sample_kind", "depends_on", "reuse_of", "graph_path", "graph_hash",
  "expected_width", "expected_height", "input_files", "output_contract", "comparison_folders",
];

// ---------------------------------------------------------------------------
// 小工具
// ---------------------------------------------------------------------------

const sha256Bytes = (b: Buffer): string => createHash("sha256").update(b).digest("hex");
const sha256File = (p: string): string => sha256Bytes(readFileSync(p));
const nowIso = (): string => new Date().toISOString();

function atomicWriteFile(path: string, data: string | Buffer): void {
  const tmp = `${path}.tmp-${process.pid}-${Date.now()}`;
  writeFileSync(tmp, data);
  renameSync(tmp, path);
}

/** wx 独占写；已存在时逐字节核对，相同 = 幂等续跑，不同 = 拒绝（绝不覆盖）。 */
function writeExclusiveVerified(path: string, data: Buffer): "written" | "identical" {
  try {
    writeFileSync(path, data, { flag: "wx" });
    return "written";
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== "EEXIST") throw err;
    const existing = readFileSync(path);
    if (sha256Bytes(existing) === sha256Bytes(data)) return "identical";
    throw new ArchiveError(`目标已存在且内容不同，拒绝覆盖：${path}`);
  }
}

/** 复制并逐个核 hash：源字节 sha == 期望 sha（如给），落盘后重读再核一次。 */
function copyVerified(srcPath: string, destPath: string, expectSha?: string): { bytes: number; sha256: string } {
  const data = readFileSync(srcPath);
  const srcSha = sha256Bytes(data);
  if (expectSha !== undefined && srcSha !== expectSha)
    throw new ArchiveError(`源文件 hash 不符：${srcPath} 期望 ${expectSha} 实际 ${srcSha}`);
  writeExclusiveVerified(destPath, data);
  const destSha = sha256File(destPath);
  if (destSha !== srcSha) throw new ArchiveError(`复制后 hash 不一致：${destPath} (${srcSha} -> ${destSha})`);
  return { bytes: data.length, sha256: destSha };
}

/** 多候选解析：绝对 → 仓库根相对 → run-root 相对。都不存在返回 null。 */
function resolveMaybe(repoRoot: string, runRoot: string, p: string): string | null {
  const candidates = isAbsolute(p) ? [p] : [join(repoRoot, p), join(runRoot, p), p];
  for (const c of candidates) if (existsSync(c) && statSync(c).isFile()) return c;
  return null;
}

function csvCell(v: unknown): string {
  if (v === null || v === undefined) return "";
  const s = typeof v === "string" ? v : JSON.stringify(v);
  return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

function durationSeconds(a?: string | null, b?: string | null): number | null {
  if (!a || !b) return null;
  const ta = Date.parse(a), tb = Date.parse(b);
  if (Number.isNaN(ta) || Number.isNaN(tb)) return null;
  return Math.round((tb - ta) / 1000);
}

// ---------------------------------------------------------------------------
// PNG 真解码/编码/裁剪（无第三方依赖；zlib inflate/deflate + 逐 chunk CRC）
// ---------------------------------------------------------------------------

export interface DecodedPng {
  width: number; height: number; bitDepth: number; colorType: number;
  channels: number; data: Buffer; paletteExpanded: boolean;
}

const PNG_SIG = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);
const CHANNELS_BY_COLOR_TYPE: Record<number, number> = { 0: 1, 2: 3, 3: 1, 4: 2, 6: 4 };

/** 真正解码：签名 + 逐 chunk CRC + IHDR + inflate IDAT + 逐行 unfilter；不是只看 PNG 头。 */
export function decodePng(buf: Buffer): DecodedPng {
  if (buf.length < 8 || !buf.subarray(0, 8).equals(PNG_SIG)) throw new ArchiveError("PNG 魔数不符");
  let off = 8;
  let ihdr: { width: number; height: number; bitDepth: number; colorType: number; interlace: number } | null = null;
  const idat: Buffer[] = [];
  let plte: Buffer | null = null;
  let sawIEND = false;
  while (off + 12 <= buf.length) {
    const len = buf.readUInt32BE(off);
    if (off + 12 + len > buf.length) throw new ArchiveError("PNG chunk 越界（文件截断）");
    const typeBuf = buf.subarray(off + 4, off + 8);
    const data = buf.subarray(off + 8, off + 8 + len);
    const crcWant = buf.readUInt32BE(off + 8 + len);
    const crcGot = crc32(Buffer.concat([typeBuf, data])) >>> 0;
    if (crcWant !== crcGot) throw new ArchiveError(`PNG chunk CRC 不符：${typeBuf.toString("latin1")}`);
    const type = typeBuf.toString("latin1");
    if (type === "IHDR") {
      ihdr = { width: data.readUInt32BE(0), height: data.readUInt32BE(4), bitDepth: data[8]!, colorType: data[9]!, interlace: data[12]! };
    } else if (type === "IDAT") {
      idat.push(Buffer.from(data));
    } else if (type === "PLTE") {
      plte = Buffer.from(data);
    } else if (type === "IEND") {
      sawIEND = true;
      break;
    }
    off += 12 + len;
  }
  if (!sawIEND) throw new ArchiveError("PNG 缺 IEND");
  if (!ihdr) throw new ArchiveError("PNG 缺 IHDR");
  if (ihdr.interlace !== 0) throw new ArchiveError("不支持 interlaced PNG（Adam7）——明确拒绝，不猜测");
  if (ihdr.bitDepth !== 8) throw new ArchiveError(`仅支持 8-bit PNG（实际 bitDepth=${ihdr.bitDepth}）——明确拒绝`);
  const rawChannels = CHANNELS_BY_COLOR_TYPE[ihdr.colorType];
  if (rawChannels === undefined) throw new ArchiveError(`不支持的 PNG colorType=${ihdr.colorType}`);
  if (ihdr.colorType === 3 && !plte) throw new ArchiveError("palette PNG 缺 PLTE");
  if (idat.length === 0) throw new ArchiveError("PNG 无 IDAT");
  const raw = inflateSync(Buffer.concat(idat));
  const rowBytes = ihdr.width * rawChannels;
  if (raw.length !== (rowBytes + 1) * ihdr.height)
    throw new ArchiveError(`PNG IDAT 解压长度 ${raw.length} 与 IHDR ${ihdr.width}x${ihdr.height}x${rawChannels} 不符`);
  // unfilter
  const out = Buffer.alloc(rowBytes * ihdr.height);
  const bpp = rawChannels;
  for (let y = 0; y < ihdr.height; y++) {
    const ft = raw[y * (rowBytes + 1)]!;
    const src = raw.subarray(y * (rowBytes + 1) + 1, (y + 1) * (rowBytes + 1));
    const dst = out.subarray(y * rowBytes, (y + 1) * rowBytes);
    const prev = y > 0 ? out.subarray((y - 1) * rowBytes, y * rowBytes) : null;
    for (let i = 0; i < rowBytes; i++) {
      const x = src[i]!;
      const a = i >= bpp ? dst[i - bpp]! : 0;
      const b = prev ? prev[i]! : 0;
      const c = prev && i >= bpp ? prev[i - bpp]! : 0;
      let v: number;
      switch (ft) {
        case 0: v = x; break;
        case 1: v = x + a; break;
        case 2: v = x + b; break;
        case 3: v = x + ((a + b) >> 1); break;
        case 4: {
          const p = a + b - c;
          const pa = Math.abs(p - a), pb = Math.abs(p - b), pc = Math.abs(p - c);
          v = x + (pa <= pb && pa <= pc ? a : pb <= pc ? b : c);
          break;
        }
        default: throw new ArchiveError(`PNG 未知 filter type ${ft}（行 ${y}）`);
      }
      dst[i] = v & 0xff;
    }
  }
  let channels = rawChannels;
  let data = out;
  let paletteExpanded = false;
  if (ihdr.colorType === 3) {
    // palette 展开为 RGB（tRNS 不支持：本研究产物不应出现，出现即明确拒绝）
    channels = 3;
    data = Buffer.alloc(ihdr.width * ihdr.height * 3);
    for (let i = 0; i < ihdr.width * ihdr.height; i++) {
      const idx = out[i]! * 3;
      if (idx + 2 >= plte!.length) throw new ArchiveError("palette 索引越界");
      data[i * 3] = plte![idx];
      data[i * 3 + 1] = plte![idx + 1];
      data[i * 3 + 2] = plte![idx + 2];
    }
    paletteExpanded = true;
  } else if (ihdr.colorType === 4) {
    throw new ArchiveError("gray+alpha PNG 不在本研究产物预期内——明确拒绝，不静默丢 alpha");
  }
  return { width: ihdr.width, height: ihdr.height, bitDepth: 8, colorType: ihdr.colorType, channels, data, paletteExpanded };
}

function pngChunk(type: string, data: Buffer): Buffer {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length, 0);
  const typeBuf = Buffer.from(type, "latin1");
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(Buffer.concat([typeBuf, data])) >>> 0, 0);
  return Buffer.concat([len, typeBuf, data, crc]);
}

/** 8-bit 灰度/RGB/RGBA 编码（filter 0 逐行；deflate 单 IDAT）。仅用于机械裁剪产物。 */
export function encodePng(width: number, height: number, channels: 1 | 3 | 4, data: Buffer): Buffer {
  if (data.length !== width * height * channels)
    throw new ArchiveError(`encodePng 数据长度 ${data.length} != ${width}x${height}x${channels}`);
  const colorType = channels === 1 ? 0 : channels === 3 ? 2 : 6;
  const rowBytes = width * channels;
  const filtered = Buffer.alloc((rowBytes + 1) * height);
  for (let y = 0; y < height; y++) {
    filtered[y * (rowBytes + 1)] = 0;
    data.copy(filtered, y * (rowBytes + 1) + 1, y * rowBytes, (y + 1) * rowBytes);
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8; ihdr[9] = colorType; ihdr[10] = 0; ihdr[11] = 0; ihdr[12] = 0;
  return Buffer.concat([
    PNG_SIG,
    pngChunk("IHDR", ihdr),
    pngChunk("IDAT", deflateSync(filtered, { level: 6 })),
    pngChunk("IEND", Buffer.alloc(0)),
  ]);
}

export function cropDecoded(img: DecodedPng, rect: { x: number; y: number; width: number; height: number }):
    { width: number; height: number; channels: 1 | 3 | 4; data: Buffer } {
  const x0 = Math.max(0, Math.min(img.width - 1, Math.trunc(rect.x)));
  const y0 = Math.max(0, Math.min(img.height - 1, Math.trunc(rect.y)));
  const x1 = Math.max(x0 + 1, Math.min(img.width, Math.trunc(rect.x + rect.width)));
  const y1 = Math.max(y0 + 1, Math.min(img.height, Math.trunc(rect.y + rect.height)));
  const w = x1 - x0, h = y1 - y0;
  const ch = img.channels as 1 | 3 | 4;
  const out = Buffer.alloc(w * h * ch);
  for (let y = 0; y < h; y++) {
    const srcOff = ((y0 + y) * img.width + x0) * ch;
    img.data.copy(out, y * w * ch, srcOff, srcOff + w * ch);
  }
  return { width: w, height: h, channels: ch, data: out };
}

// ---------------------------------------------------------------------------
// manifest / state / results 载入与严格校验（冲突 = 精确字段清单，不私改契约）
// ---------------------------------------------------------------------------

type JobRow = Record<string, any>;

interface LoadedManifest { path: string; sha256: string; doc: Record<string, any>; jobs: JobRow[]; byId: Map<string, JobRow> }

function loadManifest(runRoot: string): LoadedManifest {
  const p = join(runRoot, "manifest.json");
  if (!existsSync(p))
    throw new ArchiveError(`缺 manifest.json：${p}（T3a build 未产出）——拒绝归档，不写假清单`);
  const raw = readFileSync(p);
  let doc: Record<string, any>;
  try { doc = JSON.parse(raw.toString("utf8")); } catch (e) { throw new ArchiveError(`manifest.json 不是合法 JSON：${(e as Error).message}`); }
  const problems: string[] = [];
  if (doc["schema_version"] !== MANIFEST_SCHEMA)
    problems.push(`顶层 schema_version=${String(doc["schema_version"])} != ${MANIFEST_SCHEMA}`);
  for (const k of ["spec_sha256", "preflight_sha256"])
    if (typeof doc[k] !== "string" || !HEX64.test(doc[k] as string)) problems.push(`顶层 ${k} 缺失或非 64hex`);
  if (!Array.isArray(doc["jobs"]) || doc["jobs"].length === 0) problems.push("顶层 jobs 缺失或为空");
  if (problems.length) throw new ArchiveError(`manifest 顶层冲突：\n  - ${problems.join("\n  - ")}`);

  const jobs = doc["jobs"] as JobRow[];
  const byId = new Map<string, JobRow>();
  const rowProblems: string[] = [];
  for (const job of jobs) {
    const jid = String(job["job_id"] ?? "<无 job_id>");
    for (const f of REQUIRED_JOB_FIELDS)
      if (!(f in job)) rowProblems.push(`job ${jid}: 缺字段 ${f}`);
    if (byId.has(jid)) rowProblems.push(`job_id 重复：${jid}`);
    byId.set(jid, job);
    const sk = job["sample_kind"];
    if (sk !== "new" && sk !== "reuse") rowProblems.push(`job ${jid}: sample_kind=${String(sk)} 不在 new|reuse`);
    if (sk === "new") {
      if (!job["graph_path"] || !job["graph_hash"]) rowProblems.push(`job ${jid}: new 行必须有 graph_path/graph_hash`);
      const oc = job["output_contract"];
      if (!oc || !Array.isArray(oc["image_node_ids"]) || oc["image_node_ids"].length === 0)
        rowProblems.push(`job ${jid}: new 行 output_contract.image_node_ids 为空`);
      if (!oc || !Array.isArray(oc["metadata_node_ids"])) rowProblems.push(`job ${jid}: output_contract 缺 metadata_node_ids`);
    }
    if (sk === "reuse") {
      if (typeof job["reuse_of"] !== "string" || !job["reuse_of"]) rowProblems.push(`job ${jid}: reuse 行 reuse_of 必须是非空字符串`);
      else if (!byId.has(String(job["reuse_of"])) && !jobs.some((j) => j["job_id"] === job["reuse_of"]))
        rowProblems.push(`job ${jid}: reuse_of=${String(job["reuse_of"])} 不在 manifest 中`);
    }
    const ifs = job["input_files"];
    if (!Array.isArray(ifs)) rowProblems.push(`job ${jid}: input_files 不是数组`);
    else ifs.forEach((item: any, i: number) => {
      if (!item || typeof item["target"] !== "string") { rowProblems.push(`job ${jid}: input_files[${i}] 缺 target`); return; }
      const src = item["source"];
      if (!src || !SOURCE_KINDS.includes(String(src["kind"]))) {
        rowProblems.push(`job ${jid}: input_files[${i}].source.kind=${String(src?.["kind"])} 不在 ${SOURCE_KINDS.join("|")}`);
        return;
      }
      if (src["kind"] === "parent_job") {
        if (typeof src["job_id"] !== "string") rowProblems.push(`job ${jid}: input_files[${i}] parent_job 缺 source.job_id`);
      } else {
        if (typeof src["path"] !== "string") rowProblems.push(`job ${jid}: input_files[${i}] ${src["kind"]} 缺 source.path`);
        if (typeof src["sha256"] !== "string" || !HEX64.test(String(src["sha256"])))
          rowProblems.push(`job ${jid}: input_files[${i}] ${src["kind"]} 缺冻结 source.sha256（64hex）`);
      }
    });
    if (!Array.isArray(job["comparison_folders"]) || job["comparison_folders"].length === 0)
      rowProblems.push(`job ${jid}: comparison_folders 为空——无法归档到任何决策目录`);
  }
  if (rowProblems.length) {
    const shown = rowProblems.slice(0, 60).join("\n  - ");
    throw new ArchiveError(`manifest 行级冲突（精确字段；共 ${rowProblems.length} 条，前 60）：\n  - ${shown}`);
  }
  return { path: p, sha256: sha256Bytes(raw), doc, jobs, byId };
}

function loadState(runRoot: string, manifestSha: string): Record<string, any> {
  const p = join(runRoot, "state.json");
  if (!existsSync(p))
    throw new ArchiveError(`缺 state.json：${p} —— runner 尚未执行或证据未回收。无记录不是终态，拒绝归档（不以 execution_error 伪装已交付）`);
  const st = JSON.parse(readFileSync(p, "utf8")) as Record<string, any>;
  if (st["manifest_sha256"] !== manifestSha)
    throw new ArchiveError(`state.json 属另一份 manifest（sha ${String(st["manifest_sha256"])} != ${manifestSha}）——拒绝混合归档`);
  if (!st["jobs"] || typeof st["jobs"] !== "object")
    throw new ArchiveError("state.json 缺 jobs 对象");
  return st;
}

interface LoadedResults { path: string; rawLinesByJob: Map<string, string[]>; rowsByJob: Map<string, Record<string, any>[]> }

function loadResults(runRoot: string): LoadedResults | null {
  const p = join(runRoot, "results.jsonl");
  if (!existsSync(p)) return null;
  const rawLinesByJob = new Map<string, string[]>();
  const rowsByJob = new Map<string, Record<string, any>[]>();
  const lines = readFileSync(p, "utf8").split("\n");
  for (const line of lines) {
    const t = line.trim();
    if (!t) continue;
    let row: Record<string, any>;
    try { row = JSON.parse(t); } catch { continue; } // 坏行不猜；report 里计数
    const jid = String(row["job_id"] ?? "");
    if (!rawLinesByJob.has(jid)) rawLinesByJob.set(jid, []);
    rawLinesByJob.get(jid)!.push(t);
    if (!rowsByJob.has(jid)) rowsByJob.set(jid, []);
    rowsByJob.get(jid)!.push(row);
  }
  return { path: p, rawLinesByJob, rowsByJob };
}

// ---------------------------------------------------------------------------
// collect：只核已回收到本地的 runner 证据
// ---------------------------------------------------------------------------

interface ImageFact { node: string; path: string; bytes: number; sha256: string; width: number; height: number }
interface JobInventory {
  status: string;
  closed: boolean;
  error_class?: string | null;
  skip_reason?: string | null;
  prompt_id?: string | null;
  submitted_at?: string | null;
  closed_at?: string | null;
  images: Record<string, ImageFact>;
  source_job?: string | null;
  graph_ok?: boolean | null;
  generation_info?: { history: string | null; study_metadata: string | null; submitted_graph: string | null };
  notes?: string[];
}
interface CollectInventory {
  schema: string;
  generated_at: string;
  run_id: string | null;
  manifest_path: string;
  manifest_sha256: string;
  results_jsonl_present: boolean;
  counts: Record<string, number>;
  complete: boolean;
  blocking_issues: { job_id: string; kind: string; detail: string }[];
  jobs: Record<string, JobInventory>;
}

/** 定位本地回收的图：<run-root>/images/<job>/<node>_*.png（runner 落盘命名约定）。 */
function locateLocalImage(runRoot: string, jobId: string, nodeId: string): { path: string; ambiguous: boolean } | null {
  const dir = join(runRoot, "images", jobId);
  if (!existsSync(dir)) return null;
  const prefix = `${nodeId}_`;
  const matches = readdirSync(dir).filter((f) => f.startsWith(prefix) && f.toLowerCase().endsWith(".png"));
  if (matches.length === 0) return null;
  if (matches.length > 1) return { path: join(dir, matches[0]!), ambiguous: true };
  return { path: join(dir, matches[0]!), ambiguous: false };
}

function runCollectInternal(ctx: ArchiveCtx, opts: { write: boolean }): CollectInventory {
  const { repoRoot, runRoot } = ctx;
  const manifest = loadManifest(runRoot);
  const state = loadState(runRoot, manifest.sha256);
  const results = loadResults(runRoot);

  const jobsOut: Record<string, JobInventory> = {};
  const blocking: { job_id: string; kind: string; detail: string }[] = [];
  const counts: Record<string, number> = { success: 0, reuse_resolved: 0, execution_error: 0, skipped_mechanical: 0, open: 0, no_record: 0 };
  const structMemo = new Map<string, { sha256: string; bytes: number } | null>();

  const block = (jid: string, kind: string, detail: string) => blocking.push({ job_id: jid, kind, detail });

  for (const job of manifest.jobs) {
    const jid = String(job["job_id"]);
    const st = (state["jobs"] as Record<string, any>)[jid];
    if (!st || typeof st["status"] !== "string") {
      counts.no_record++;
      block(jid, "no_record", "state.json 无该 job 记录；无记录不是终态，不能当 execution_error/skipped 归档");
      jobsOut[jid] = { status: "no_record", closed: false, images: {} };
      continue;
    }
    const status = String(st["status"]);
    if (!CLOSED_STATES.includes(status)) {
      counts.open++;
      block(jid, "open_state", `状态 ${status} 非终态${OPEN_STATES.includes(status) ? "（在途/未决）" : "（未知状态值）"}；不当终态归档`);
      jobsOut[jid] = { status, closed: false, images: {} };
      continue;
    }
    counts[status]++;
    const inv: JobInventory = {
      status, closed: true,
      error_class: st["error_class"] ?? null,
      skip_reason: st["skip_reason"] ?? null,
      prompt_id: st["prompt_id"] ?? null,
      submitted_at: st["submitted_at"] ?? null,
      closed_at: st["closed_at"] ?? null,
      images: {},
      source_job: null,
      graph_ok: null,
      generation_info: { history: null, study_metadata: null, submitted_graph: null },
      notes: [],
    };
    jobsOut[jid] = inv;

    // graph hash（new 与 reuse 行都有 graph_path/graph_hash；reuse 指向上游图）
    if (typeof job["graph_path"] === "string" && job["graph_path"]) {
      const gp = resolveMaybe(repoRoot, runRoot, String(job["graph_path"]));
      if (gp === null) {
        block(jid, "graph_missing", `graph_path 不存在：${String(job["graph_path"])}`);
      } else {
        const actual = sha256File(gp);
        if (actual !== String(job["graph_hash"])) block(jid, "graph_hash_mismatch", `graph hash 不符：manifest ${String(job["graph_hash"])} 实际 ${actual}`);
        else inv.graph_ok = true;
      }
    } else if (job["sample_kind"] === "new") {
      block(jid, "graph_missing", "new 行缺 graph_path");
    }

    // structure / run_root_file 输入核对（冻结 sha256 vs 实文件；memo 去重）
    for (const item of (job["input_files"] ?? []) as any[]) {
      const src = item?.["source"];
      if (!src || src["kind"] === "parent_job") continue; // parent 输入按上游 job 产物核（下方 images 校验覆盖）
      const rel = String(src["path"] ?? "");
      const memoKey = rel;
      if (!structMemo.has(memoKey)) {
        const fp = resolveMaybe(repoRoot, runRoot, rel);
        structMemo.set(memoKey, fp === null ? null : { sha256: sha256File(fp), bytes: statSync(fp).size });
      }
      const fact = structMemo.get(memoKey)!;
      if (fact === null) block(jid, "input_missing", `input_files 源不存在：${rel}`);
      else if (typeof src["sha256"] === "string" && fact.sha256 !== src["sha256"])
        block(jid, "input_hash_mismatch", `input_files 源 hash 不符：${rel} 冻结 ${String(src["sha256"])} 实际 ${fact.sha256}`);
    }

    // generation-info 原文（success 必须齐；其它状态记录存在性）
    const gi = join(runRoot, "generation-info");
    for (const [key, name] of [["history", `${jid}-history.json`], ["study_metadata", `${jid}-study_metadata.json`], ["submitted_graph", `${jid}-submitted-graph.json`]] as const) {
      const fp = join(gi, name);
      inv.generation_info![key] = existsSync(fp) ? fp : null;
    }
    if (status === "success" && inv.generation_info!.history === null)
      block(jid, "missing_generation_info", `success 但缺 generation-info/${jid}-history.json（原文证据不完整）`);

    if (status === "success") {
      const outputs = st["outputs"];
      const oc = job["output_contract"] ?? {};
      const nodes = (oc["image_node_ids"] ?? []) as (string | number)[];
      if (!outputs || typeof outputs !== "object") { block(jid, "outputs_missing", "success 但 state.outputs 缺失"); continue; }
      const hashes = (outputs["hashes"] ?? {}) as Record<string, string>;
      const dims = (outputs["dimensions"] ?? {}) as Record<string, number[]>;
      for (const node of nodes) {
        const nid = String(node);
        const loc = locateLocalImage(runRoot, jid, nid);
        if (loc === null) { block(jid, "missing_image", `success 但本地未回收到 images/${jid}/${nid}_*.png`); continue; }
        if (loc.ambiguous) { block(jid, "ambiguous_image", `images/${jid}/ 下 ${nid}_*.png 多于一个，无法唯一映射`); continue; }
        const bytes = readFileSync(loc.path);
        const sha = sha256Bytes(bytes);
        if (typeof hashes[nid] === "string" && hashes[nid] !== sha) {
          block(jid, "hash_mismatch", `node ${nid} 本地 sha ${sha} != runner 记录 ${hashes[nid]}`);
          continue;
        }
        let decoded: DecodedPng;
        try { decoded = decodePng(bytes); } catch (e) {
          block(jid, "decode_failed", `node ${nid} 真解码失败：${(e as Error).message}`);
          continue;
        }
        const recDims = dims[nid];
        if (Array.isArray(recDims) && (recDims[0] !== decoded.width || recDims[1] !== decoded.height)) {
          block(jid, "dimension_mismatch", `node ${nid} 解码尺寸 ${decoded.width}x${decoded.height} != runner 记录 ${recDims.join("x")}`);
          continue;
        }
        if (decoded.width !== Number(job["expected_width"]) || decoded.height !== Number(job["expected_height"])) {
          block(jid, "dimension_mismatch", `node ${nid} 解码尺寸 ${decoded.width}x${decoded.height} != manifest expected ${Number(job["expected_width"])}x${Number(job["expected_height"])}`);
          continue;
        }
        inv.images[nid] = { node: nid, path: loc.path.slice(runRoot.length + 1), bytes: bytes.length, sha256: sha, width: decoded.width, height: decoded.height };
      }
    } else if (status === "reuse_resolved") {
      // 复用行：绑定上游真实产物。已知 schema 冲突（archive.md §5）：reuse 行的
      // expected_width/height 是组缺省占位（如 R0=768），非权威；以 reused_outputs 为准。
      const ref = String(job["reuse_of"] ?? "");
      const up = (state["jobs"] as Record<string, any>)[ref];
      inv.source_job = ref;
      if (!up || !["success", "reuse_resolved"].includes(String(up["status"]))) {
        block(jid, "reuse_upstream_not_closed", `reuse_of=${ref} 上游状态 ${String(up?.["status"] ?? "无记录")}，非 success/reuse_resolved`);
        continue;
      }
      const reused = up["status"] === "success" ? up["outputs"] : up["reused_outputs"];
      if (!reused || typeof reused !== "object") { block(jid, "reuse_outputs_missing", `reuse_of=${ref} 上游无可绑定 outputs`); continue; }
      const hashes = (reused["hashes"] ?? {}) as Record<string, string>;
      const dims = (reused["dimensions"] ?? {}) as Record<string, number[]>;
      // 复用行的本地图 = 上游 job 目录里的文件（不重复回收；同字节）
      const upJobId = up["status"] === "success" ? ref : String(up["reuse_of"] ?? ref);
      for (const nid of Object.keys(hashes)) {
        const loc = locateLocalImage(runRoot, upJobId, nid);
        if (loc === null || loc.ambiguous) { block(jid, "missing_image", `reuse 上游 ${upJobId} node ${nid} 本地文件缺失或歧义`); continue; }
        const bytes = readFileSync(loc.path);
        const sha = sha256Bytes(bytes);
        if (sha !== hashes[nid]) { block(jid, "hash_mismatch", `reuse 上游 ${upJobId} node ${nid} sha ${sha} != 记录 ${hashes[nid]}`); continue; }
        let decoded: DecodedPng;
        try { decoded = decodePng(bytes); } catch (e) { block(jid, "decode_failed", `reuse 上游图真解码失败：${(e as Error).message}`); continue; }
        const recDims = dims[nid];
        if (Array.isArray(recDims) && (recDims[0] !== decoded.width || recDims[1] !== decoded.height)) {
          block(jid, "dimension_mismatch", `reuse 上游 node ${nid} 尺寸与记录不符`); continue;
        }
        if (decoded.width !== Number(job["expected_width"]) || decoded.height !== Number(job["expected_height"]))
          inv.notes!.push(`reuse 行 expected ${Number(job["expected_width"])}x${Number(job["expected_height"])} 与上游实际 ${decoded.width}x${decoded.height} 不一致——以 reused_outputs 为权威（archive.md §5 已知冲突）`);
        inv.images[nid] = { node: nid, path: loc.path.slice(runRoot.length + 1), bytes: bytes.length, sha256: sha, width: decoded.width, height: decoded.height };
      }
      if (Object.keys(inv.images).length === 0) block(jid, "missing_image", "reuse_resolved 但未绑定到任何上游图");
    }
    // execution_error / skipped_mechanical：无图是事实，不补图、不伪造；error_class/skip_reason 已记录。
  }

  const complete = blocking.length === 0;
  const inventory: CollectInventory = {
    schema: COLLECT_SCHEMA,
    generated_at: nowIso(),
    run_id: (state["run_id"] as string) ?? null,
    manifest_path: manifest.path,
    manifest_sha256: manifest.sha256,
    results_jsonl_present: results !== null,
    counts,
    complete,
    blocking_issues: blocking,
    jobs: jobsOut,
  };
  if (opts.write) {
    atomicWriteFile(join(runRoot, "collect.json"), JSON.stringify(inventory, null, 1) + "\n");
    console.error(`[archive] collect：${complete ? "完整" : `不完整（阻塞 ${blocking.length} 项）`}；counts=${JSON.stringify(counts)}；证据 ${join(runRoot, "collect.json")}`);
    if (!complete) {
      for (const b of blocking.slice(0, 20)) console.error(`  - [${b.kind}] ${b.job_id}: ${b.detail}`);
      if (blocking.length > 20) console.error(`  - …共 ${blocking.length} 项，全量见 collect.json`);
      process.exitCode = 1;
    }
  }
  return inventory;
}

// ---------------------------------------------------------------------------
// deliver：Downloads 决策目录独占交付
// ---------------------------------------------------------------------------

interface FileRegistryEntry { folder: string; rel: string; bytes: number; sha256: string; kind: string; job_id?: string }
interface FolderResult {
  name: string; dir: string; planned_rows: number; images: number; reused_images: number;
  error_rows: number; skipped_rows: number; control_files: number; crop_files: number;
  crop_skipped: Record<string, number>; param_files: number; record_lines: number;
}

function loadSpec(runRoot: string): { doc: Record<string, any>; sha256: string; folders: string[] } {
  const p = join(runRoot, "spec.json");
  if (!existsSync(p)) throw new ArchiveError(`缺 spec.json：${p}`);
  const raw = readFileSync(p);
  const doc = JSON.parse(raw.toString("utf8")) as Record<string, any>;
  const map = doc["delivery_folders_7_2"];
  if (!map || typeof map !== "object") throw new ArchiveError("spec.json 缺 delivery_folders_7_2（决策目录唯一事实源）");
  const folders = Object.keys(map).filter((k) => !k.startsWith("_")).sort();
  if (folders.length === 0) throw new ArchiveError("spec.delivery_folders_7_2 无目录项");
  return { doc, sha256: sha256Bytes(raw), folders };
}

/** 交付文件名（计划 §7.2 命名格式：pair/action/framing/seed/method；参数明细在 manifest.csv）。 */
function deliveredName(row: JobRow): string {
  const method = String(row["method"]).replace(/@/g, "_d").replace(/[^A-Za-z0-9._-]/g, "_");
  const base = row["pair"]
    ? `${String(row["pair"])}_${String(row["action"])}_${String(row["framing"])}`
    : String(row["case_id"]).replace(/-/g, "_");
  return `${base}_seed${String(row["seed"])}_${method}.png`;
}

function checkBaseline(runRoot: string, deliveryRoot: string): { checked: number; changed: string[]; missing: string[]; counts: Record<string, unknown> } {
  const p = join(runRoot, "checks", "pre-existing-downloads.json");
  if (!existsSync(p))
    throw new ArchiveError(`缺历史保护基线：${p} —— 没有基线不创建任何交付目录（无法证明不碰既有物料）`);
  const b = JSON.parse(readFileSync(p, "utf8")) as Record<string, any>;
  if (String(b["absolute_root"]) !== deliveryRoot)
    throw new ArchiveError(`基线根 ${String(b["absolute_root"])} != 交付根 ${deliveryRoot} —— 拒绝交付`);
  if (!existsSync(deliveryRoot) || !statSync(deliveryRoot).isDirectory())
    throw new ArchiveError(`交付根不存在或不是目录：${deliveryRoot}`);
  const changed: string[] = [];
  const missing: string[] = [];
  for (const f of (b["files"] ?? []) as { path: string; bytes: number; sha256: string }[]) {
    const fp = join(deliveryRoot, f.path);
    let s;
    try { s = lstatSync(fp); } catch { missing.push(f.path); continue; }
    if (s.isSymbolicLink() || !s.isFile()) { changed.push(`${f.path}（类型变化）`); continue; }
    if (s.size !== f.bytes) { changed.push(`${f.path}（字节 ${s.size} != ${f.bytes}）`); continue; }
    const h = sha256File(fp);
    if (h !== f.sha256) changed.push(`${f.path}（sha256 变化）`);
  }
  // 只报告，不恢复、不修复（主人可能自行改动过既有物料）。
  return { checked: (b["files"] ?? []).length, changed, missing, counts: (b["counts"] ?? {}) as Record<string, unknown> };
}

function ensureOwnDir(dir: string, revisionKey: string): "created" | "resumed" {
  if (!existsSync(dir)) {
    try { mkdirSync(dir); } catch (e) {
      if ((e as NodeJS.ErrnoException).code === "EEXIST") return ensureOwnDir(dir, revisionKey); // 竞态：转 marker 判定
      throw new ArchiveError(`独占创建目录失败：${dir}（${(e as Error).message}）`);
    }
    atomicWriteFile(join(dir, REVISION_MARKER), JSON.stringify({ schema: "yugang.archive.revision-marker.v1", revision: revisionKey, created_at: nowIso() }, null, 1) + "\n");
    return "created";
  }
  const markerPath = join(dir, REVISION_MARKER);
  if (existsSync(markerPath)) {
    try {
      const m = JSON.parse(readFileSync(markerPath, "utf8")) as Record<string, unknown>;
      if (m["revision"] === revisionKey) return "resumed";
    } catch { /* marker 损坏按用户目录处理 */ }
  }
  throw new ArchiveError(`目录已存在且非本轮自建（无 marker 或 revision 不符）：${dir} —— 不覆盖、不清理用户目录`);
}

function readCaseStructureIndex(runRoot: string, repoRoot: string, caseId: string): { index: Record<string, any>; dir: string } | null {
  const dir = join(runRoot, "inputs", "structure", caseId);
  const p = join(dir, "structure_index.json");
  if (!existsSync(p)) {
    const alt = resolveMaybe(repoRoot, runRoot, `experiments/anima-interaction-v1/structure/${caseId}/structure_index.json`);
    if (alt === null) return null;
    return { index: JSON.parse(readFileSync(alt, "utf8")), dir: basename(alt) === "structure_index.json" ? resolve(alt, "..") : dir };
  }
  return { index: JSON.parse(readFileSync(p, "utf8")), dir };
}

function runDeliverInternal(ctx: ArchiveCtx): void {
  const { repoRoot, runRoot } = ctx;
  const flag = (n: string): string | undefined => { const i = ctx.argv.indexOf(`--${n}`); return i >= 0 ? ctx.argv[i + 1] : undefined };
  const deliveryRoot = flag("delivery-root") ?? DEFAULT_DELIVERY_ROOT;
  const revisionFlag = flag("revision") ?? null;

  const manifest = loadManifest(runRoot);
  const state = loadState(runRoot, manifest.sha256);
  const results = loadResults(runRoot);
  if (results === null)
    throw new ArchiveError(`缺 results.jsonl：${join(runRoot, "results.jsonl")} —— 无法产 运行记录.jsonl，拒绝交付`);
  const spec = loadSpec(runRoot);

  // 门 1：collect 完整（含真解码/hash/尺寸/graph/输入核对）。不完整 → 拒绝，不写假清单。
  const inventory = runCollectInternal(ctx, { write: true });
  if (!inventory.complete)
    throw new ArchiveError(`collect 不完整（阻塞 ${inventory.blocking_issues.length} 项，前 20 见 stderr/collect.json）——拒绝交付；open/no_record 不是终态`);
  const c = inventory.counts;
  if (c.success + c.reuse_resolved + c.execution_error + c.skipped_mechanical === 0)
    throw new ArchiveError("runner 无任何终态记录（整组根本没跑）——拒绝交付，不以空目录/错误行伪装已交付");

  // 门 2：文件夹归属（job 并集 == 预定清单）。
  const rowsByFolder = new Map<string, JobRow[]>();
  for (const f of spec.folders) rowsByFolder.set(f, []);
  for (const job of manifest.jobs) {
    for (const f of job["comparison_folders"] as string[]) {
      if (!rowsByFolder.has(f))
        throw new ArchiveError(`job ${String(job["job_id"])}: comparison_folders 含未知目录 "${f}"（不在 spec.delivery_folders_7_2）`);
      rowsByFolder.get(f)!.push(job);
    }
  }
  const unionCount = new Set(manifest.jobs.map((j) => String(j["job_id"]))).size;
  if (unionCount !== manifest.jobs.length) throw new ArchiveError("manifest job_id 并集 != 行数（重复）");

  // 门 3：历史基线（既有 335 条目/298 文件只报告，不改、不恢复）。
  const baseline = checkBaseline(runRoot, deliveryRoot);

  // revision：47–60 或顶层索引/delivery.json 任何冲突 → 本轮全部目录统一加 run 后缀。
  let revision = revisionFlag;
  if (revision === null) {
    const conflicts = [...spec.folders, INDEX_BASENAME, DELIVERY_BASENAME].filter((n) => existsSync(join(deliveryRoot, n)));
    if (conflicts.length > 0) {
      revision = `run-${nowIso().replace(/[:.]/g, "-")}`;
      console.error(`[archive] 命名冲突 ${conflicts.length} 项（如 ${conflicts[0]}）→ 本轮 14 目录统一后缀 @${revision}`);
    }
  }
  const revisionKey = revision ?? "base";
  const nameOf = (n: string): string => (revision ? `${n}@${revision}` : n);

  const createdDirs: string[] = [];
  const folderResults: FolderResult[] = [];
  const registry: FileRegistryEntry[] = [];
  const decodeMemo = new Map<string, DecodedPng>();
  const startedAt = nowIso();

  const reg = (folder: string, rel: string, r: { bytes: number; sha256: string }, kind: string, job_id?: string) =>
    registry.push({ folder, rel, ...r, kind, ...(job_id ? { job_id } : {}) });

  try {
    for (const folder of spec.folders) {
      const dir = join(deliveryRoot, nameOf(folder));
      const dirState = ensureOwnDir(dir, revisionKey);
      if (dirState === "created") createdDirs.push(dir);
      const rows = (rowsByFolder.get(folder) ?? []).slice().sort((a, b) => String(a["job_id"]).localeCompare(String(b["job_id"])));
      const fr: FolderResult = {
        name: folder, dir, planned_rows: rows.length, images: 0, reused_images: 0,
        error_rows: 0, skipped_rows: 0, control_files: 0, crop_files: 0, crop_skipped: {}, param_files: 0, record_lines: 0,
      };
      folderResults.push(fr);
      const isReferenceFolder = folder.startsWith("47-");

      // ---- 原图（success 新采样 + reuse 复用；execution_error/skipped 无图也入 csv/记录）----
      const usedNames = new Map<string, string>();
      const imageEntries: { row: JobRow; name: string; fact: ImageFact }[] = [];
      const csvLines: string[] = [];
      for (const row of rows) {
        const jid = String(row["job_id"]);
        const inv = inventory.jobs[jid]!;
        const status = inv.status;
        if (status === "execution_error") fr.error_rows++;
        if (status === "skipped_mechanical") fr.skipped_rows++;
        const nodes = Object.keys(inv.images);
        if (nodes.length === 0) {
          csvLines.push([jid, row["group"], row["case_id"], row["pair"], row["action"], row["framing"], row["seed"],
            row["stage"], row["stage_seed"], row["method"], row["weights"], row["sample_kind"], row["reuse_of"],
            status, inv.error_class ?? "", inv.skip_reason ?? "", inv.prompt_id ?? "", "", "", "", "",
            inv.source_job ?? "", "", row["graph_hash"], durationSeconds(inv.submitted_at, inv.closed_at)]
            .map(csvCell).join(","));
          continue;
        }
        for (const nid of nodes) {
          const fact = inv.images[nid]!;
          let name = deliveredName(row);
          if (nodes.length > 1) name = name.replace(/\.png$/, `_node${nid}.png`);
          if (usedNames.has(name) && usedNames.get(name) !== fact.sha256)
            name = name.replace(/\.png$/, `__${jid.replace(/[^A-Za-z0-9._-]/g, "_")}.png`);
          usedNames.set(name, fact.sha256);
          const srcPath = join(runRoot, fact.path);
          const r = copyVerified(srcPath, join(dir, name), fact.sha256);
          reg(folder, name, r, "image", jid);
          fr.images++;
          if (row["sample_kind"] === "reuse") fr.reused_images++;
          imageEntries.push({ row, name, fact });
          csvLines.push([jid, row["group"], row["case_id"], row["pair"], row["action"], row["framing"], row["seed"],
            row["stage"], row["stage_seed"], row["method"], row["weights"], row["sample_kind"], row["reuse_of"],
            status, "", "", inv.prompt_id ?? "", fact.width, fact.height, r.bytes, name, fact.sha256,
            inv.source_job ?? "", fact.sha256, row["graph_hash"], durationSeconds(inv.submitted_at, inv.closed_at)]
            .map(csvCell).join(","));
        }
      }

      // ---- manifest.csv ----
      const csvHeader = ["job_id", "group", "case_id", "pair", "action", "framing", "seed", "stage", "stage_seed",
        "method", "weights", "sample_kind", "reuse_of", "status", "error_class", "skip_reason", "prompt_id",
        "width", "height", "file_bytes", "delivered_file", "file_sha256", "source_job", "source_sha256",
        "graph_hash", "duration_seconds"].join(",");
      const csvBuf = Buffer.from([csvHeader, ...csvLines].join("\n") + "\n", "utf8");
      { const p = join(dir, "manifest.csv"); writeExclusiveVerified(p, csvBuf); reg(folder, "manifest.csv", { bytes: csvBuf.length, sha256: sha256Bytes(csvBuf) }, "manifest_csv"); }

      // ---- 运行记录.jsonl（results.jsonl 原文行，逐字）----
      {
        const lines: string[] = [];
        for (const row of rows) for (const l of results.rawLinesByJob.get(String(row["job_id"])) ?? []) lines.push(l);
        const buf = Buffer.from(lines.length ? lines.join("\n") + "\n" : "", "utf8");
        writeExclusiveVerified(join(dir, "运行记录.jsonl"), buf);
        reg(folder, "运行记录.jsonl", { bytes: buf.length, sha256: sha256Bytes(buf) }, "run_records");
        fr.record_lines = lines.length;
      }

      // ---- 参数与接线/ ----
      {
        const pdir = join(dir, "参数与接线");
        mkdirSync(pdir, { recursive: true });
        for (const row of rows) {
          const jid = String(row["job_id"]);
          const rowBuf = Buffer.from(JSON.stringify(row, null, 1) + "\n", "utf8");
          writeExclusiveVerified(join(pdir, `${jid}.manifest-row.json`), rowBuf);
          reg(folder, `参数与接线/${jid}.manifest-row.json`, { bytes: rowBuf.length, sha256: sha256Bytes(rowBuf) }, "params", jid);
          fr.param_files++;
          for (const suffix of ["submitted-graph", "history", "study_metadata"]) {
            const src = join(runRoot, "generation-info", `${jid}-${suffix}.json`);
            if (!existsSync(src)) continue;
            const r = copyVerified(src, join(pdir, `${jid}.${suffix}.json`));
            reg(folder, `参数与接线/${jid}.${suffix}.json`, r, "generation_info", jid);
            fr.param_files++;
          }
        }
      }

      // ---- 控制图/（结构资产实文件 + 冻结 sha 核对；47 目录收全部 case）----
      {
        const cdir = join(dir, "控制图");
        mkdirSync(cdir, { recursive: true });
        const caseIds = isReferenceFolder
          ? readdirSync(join(runRoot, "inputs", "structure")).filter((d) => {
              const full = join(runRoot, "inputs", "structure", d);
              return statSync(full).isDirectory();
            })
          : [...new Set(rows.map((r) => String(r["case_id"])))];
        for (const caseId of caseIds.sort()) {
          const sc = readCaseStructureIndex(runRoot, repoRoot, caseId);
          if (sc === null) {
            if (!isReferenceFolder) throw new ArchiveError(`case ${caseId} 缺 structure_index.json —— 控制图不完整，拒绝交付`);
            continue;
          }
          const files = (sc.index["files"] ?? {}) as Record<string, { path: string; sha256: string }>;
          for (const [fname, ref] of Object.entries(files)) {
            const srcPath = resolveMaybe(repoRoot, runRoot, ref.path) ?? join(sc.dir, fname);
            if (!existsSync(srcPath)) throw new ArchiveError(`case ${caseId} 结构文件缺失：${ref.path}`);
            const destRel = `控制图/${caseId}__${fname}`;
            const r = copyVerified(srcPath, join(cdir, `${caseId}__${fname}`), ref.sha256);
            reg(folder, destRel, r, "control", caseId);
            fr.control_files++;
          }
          // structure_index.json 本体（无冻结 sha，按实字节记录）
          const idxPath = join(sc.dir, "structure_index.json");
          if (existsSync(idxPath)) {
            const r = copyVerified(idxPath, join(cdir, `${caseId}__structure_index.json`));
            reg(folder, `控制图/${caseId}__structure_index.json`, r, "control", caseId);
            fr.control_files++;
          }
        }

        // job 实际消费的 structure/run_root_file 输入（T3c 重指向后 R 组即 inputs/repair-v2/ 的
        // 局部 mask；native 灰度只作结构参考）。按实文件 sha 去重，绝不把 CPU 参考 PNG 冒称采样图。
        const seenControlSha = new Set(
          registry.filter((e) => e.folder === folder && e.kind === "control").map((e) => e.sha256),
        );
        const usedControlNames = new Map<string, string>();
        for (const row of rows) {
          const jid = String(row["job_id"]);
          for (const item of (row["input_files"] ?? []) as any[]) {
            const src = item?.["source"];
            if (!src || src["kind"] === "parent_job") continue; // 父图按上游 job 产物核，不当控制图
            const rel = String(src["path"] ?? "");
            const fp = resolveMaybe(repoRoot, runRoot, rel);
            if (fp === null) continue; // 缺失已由 collect 记 input_missing 阻塞（deliver 前置门拦截）
            const expect = typeof src["sha256"] === "string" && HEX64.test(src["sha256"]) ? src["sha256"] : undefined;
            const actual = sha256File(fp);
            if (seenControlSha.has(actual)) continue;
            seenControlSha.add(actual);
            let destName = `${String(row["case_id"])}__input__${basename(fp)}`;
            if (usedControlNames.has(destName) && usedControlNames.get(destName) !== actual)
              destName = `${String(row["case_id"])}__input__${jid.replace(/[^A-Za-z0-9._-]/g, "_")}__${basename(fp)}`;
            usedControlNames.set(destName, actual);
            const r = copyVerified(fp, join(cdir, destName), expect);
            reg(folder, `控制图/${destName}`, r, "control_input", jid);
            fr.control_files++;
          }
        }
        // repair-v2 索引本体（若存在）：实际 crop noise 的 audit 入口，随控制图交付
        for (const idxName of ["repair_index.json"]) {
          const rp = join(runRoot, "inputs", "repair-v2", idxName);
          if (!existsSync(rp)) continue;
          const sha = sha256File(rp);
          if (seenControlSha.has(sha)) continue;
          seenControlSha.add(sha);
          const r = copyVerified(rp, join(cdir, `repair-v2__${idxName}`));
          reg(folder, `控制图/repair-v2__${idxName}`, r, "control_input");
          fr.control_files++;
        }
      }

      // ---- 原生裁剪/（仅冻结结构坐标 pixel_bbox；不按图像好坏挑；R 组修复画布不适用即机械跳过）----
      {
        const xdir = join(dir, "原生裁剪");
        mkdirSync(xdir, { recursive: true });
        const bboxCache = new Map<string, { rect: { x: number; y: number; width: number; height: number } | null; canvas: number[] | null; reason?: string }>();
        for (const ent of imageEntries) {
          const caseId = String(ent.row["case_id"]);
          if (!bboxCache.has(caseId)) {
            const sc = readCaseStructureIndex(runRoot, repoRoot, caseId);
            if (sc === null) { bboxCache.set(caseId, { rect: null, canvas: null, reason: "no_structure_index" }); }
            else {
              const boxes = sc.index["boxes"] ?? {};
              const ba = boxes["owner_a"]?.["pixel_bbox"];
              const bb = boxes["owner_b"]?.["pixel_bbox"];
              const canvas = (sc.index["canvas"] ?? null) as number[] | null;
              if (!Array.isArray(ba) || !Array.isArray(bb)) {
                bboxCache.set(caseId, { rect: null, canvas, reason: "solo_or_missing_owner_boxes" });
              } else {
                const x0 = Math.min(ba[0], bb[0]), y0 = Math.min(ba[1], bb[1]);
                const x1 = Math.max(ba[2], bb[2]), y1 = Math.max(ba[3], bb[3]);
                bboxCache.set(caseId, { rect: { x: x0, y: y0, width: x1 - x0, height: y1 - y0 }, canvas });
              }
            }
          }
          const bc = bboxCache.get(caseId)!;
          const skip = (reason: string) => { fr.crop_skipped[reason] = (fr.crop_skipped[reason] ?? 0) + 1; };
          if (bc.rect === null) { skip(bc.reason ?? "no_rect"); continue; }
          if (bc.canvas === null || ent.fact.width !== bc.canvas[0] || ent.fact.height !== bc.canvas[1]) {
            // 冻结 pixel_bbox 在原生画布（1024×768）坐标系。R 组主图 Stitch 后同为 1024×768，
            // 故正常适用；只有实际输出画布与冻结画布不符（内部 crop 画布 768²、被缩放、或 T3c
            // 尺寸修复前的 draft 记录）才机械跳过——不猜缩放、不按图像好坏挑。
            skip("canvas_mismatch_repair_or_scaled"); continue;
          }
          if (bc.rect.width <= 0 || bc.rect.height <= 0) { skip("degenerate_rect"); continue; }
          if (decodeMemo.size > 8) decodeMemo.clear();
          let decoded = decodeMemo.get(ent.fact.sha256);
          if (!decoded) {
            decoded = decodePng(readFileSync(join(runRoot, ent.fact.path)));
            decodeMemo.set(ent.fact.sha256, decoded);
          }
          const cropped = cropDecoded(decoded, bc.rect);
          const png = encodePng(cropped.width, cropped.height, cropped.channels, cropped.data);
          const name = ent.name.replace(/\.png$/, "_crop-contact.png");
          writeExclusiveVerified(join(xdir, name), png);
          reg(folder, `原生裁剪/${name}`, { bytes: png.length, sha256: sha256Bytes(png) }, "crop", String(ent.row["job_id"]));
          fr.crop_files++;
        }
      }

      // ---- README.md（§7.3 固定内容；只列观察问题，不填答案/成功率/最佳方案）----
      {
        const readme = composeReadme(folder, spec.doc["delivery_folders_7_2"][folder], rows, inventory, fr, manifest, revisionKey);
        const buf = Buffer.from(readme, "utf8");
        writeExclusiveVerified(join(dir, "README.md"), buf);
        reg(folder, "README.md", { bytes: buf.length, sha256: sha256Bytes(buf) }, "readme");
      }
    }

    // ---- 顶层：本轮索引 + delivery.json（同样独占）----
    const deliveryDoc = {
      schema: DELIVERY_SCHEMA,
      generated_at: nowIso(),
      started_at: startedAt,
      revision: revisionKey,
      revision_suffix: revision,
      delivery_root: deliveryRoot,
      run_id: inventory.run_id,
      run_root: runRoot,
      manifest_path: manifest.path,
      manifest_sha256: manifest.sha256,
      spec_sha256: String(manifest.doc["spec_sha256"]),
      preflight_sha256: String(manifest.doc["preflight_sha256"]),
      status: "delivered_awaiting_user_review",
      f8_visual_acceptance: "user_pending",
      complete: true,
      counts: inventory.counts,
      job_union: { manifest_rows: manifest.jobs.length, unique_job_ids: unionCount, equal: unionCount === manifest.jobs.length },
      baseline_check: baseline,
      folders: folderResults.map((f) => ({ ...f })),
      files: registry,
      notes: [
        "同一原图跨决策目录为本机真实复制（非 symlink），source_job/source_sha256 列可追溯复用来源",
        "原生裁剪仅按冻结结构 pixel_bbox 机械输出；R 组修复画布不适用即记 crop_skipped，不猜缩放",
        "未生成 1.2× 展示副本；无学习式超分；技术失败无图也入 manifest.csv/运行记录.jsonl",
        "助手不评分/不筛图/不选优；F8 视觉验收为主人专属（user_pending）",
        "user-feedback.jsonl 仅在主人反馈后逐字登记，本程序绝不生成",
      ],
    };
    const deliveryBuf = Buffer.from(JSON.stringify(deliveryDoc, null, 1) + "\n", "utf8");
    const deliveryName = nameOf(DELIVERY_BASENAME);
    writeExclusiveVerified(join(deliveryRoot, deliveryName), deliveryBuf);
    // run-root 副本（archive 自有产物，原子覆盖）：独立 verify 可不进 Downloads 直接读。
    atomicWriteFile(join(runRoot, "delivery.json"), deliveryBuf);

    const indexLines: string[] = [
      `# anima-interaction-v1 本轮交付索引（revision: ${revisionKey}）`,
      "",
      `生成时间：${nowIso()}；run_id：${String(inventory.run_id)}；manifest sha256：${manifest.sha256}`,
      "",
      `状态：**delivered_awaiting_user_review** —— 样例已全部交付，等待主人看图。`,
      `视觉验收（F8）为主人专属，当前 user_pending；助手不评分、不选优、不代验收。`,
      "",
      `历史基线核对：既有文件 ${baseline.checked} 个，用户侧变化 ${baseline.changed.length}，缺失 ${baseline.missing.length}（只报告，未恢复、未改动）。`,
      "",
      "| 决策目录 | 计划行 | 图片 | 其中复用 | 技术失败 | 机械跳过 | 控制图 | 原生裁剪 |",
      "| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: |",
    ];
    for (const f of folderResults)
      indexLines.push(`| ${nameOf(f.name)} | ${f.planned_rows} | ${f.images} | ${f.reused_images} | ${f.error_rows} | ${f.skipped_rows} | ${f.control_files} | ${f.crop_files} |`);
    indexLines.push("", `明细（每文件路径/sha256/字节）：\`${deliveryName}\`（本目录）与 run-root \`delivery.json\`。`, "");
    const indexBuf = Buffer.from(indexLines.join("\n"), "utf8");
    writeExclusiveVerified(join(deliveryRoot, nameOf(INDEX_BASENAME)), indexBuf);

    console.error(`[archive] deliver 完成：revision=${revisionKey}，目录 ${folderResults.length} 个，文件 ${registry.length} 个，状态 delivered_awaiting_user_review（F8=user pending）`);
  } catch (err) {
    // 失败不递归清理（含自建目录）：只报告自建 revision 与续接点。
    const done = folderResults.filter((f) => f.name !== folderResults[folderResults.length - 1]?.name).map((f) => f.name);
    const failedFolder = folderResults[folderResults.length - 1]?.name ?? null;
    const detail = err instanceof Error ? err.message : String(err);
    throw new ArchiveError(
      `deliver 失败（不清理任何目录）：${detail}\n` +
      `  自建 revision：${revisionKey}（目录后缀 ${revision ?? "无"}）\n` +
      `  已创建目录：${createdDirs.length} 个\n` +
      `  已完成目录：${done.length ? done.join("、") : "无"}\n` +
      `  续接点：目录 ${failedFolder ?? "<未开始>"}；续跑加 --revision ${revisionKey}（wx+marker 幂等，已写且一致的文件自动跳过）`,
    );
  }
}

// ---------------------------------------------------------------------------
// README（§7.3 固定七节；机械事实 + 观察问题，不写答案/成功率/最佳方案）
// ---------------------------------------------------------------------------

function composeReadme(folder: string, decisionText: unknown, rows: JobRow[], inventory: CollectInventory, fr: FolderResult, manifest: LoadedManifest, revisionKey: string): string {
  const methods = [...new Set(rows.map((r) => String(r["method"])))].sort();
  const weightCombos = [...new Set(rows.map((r) => JSON.stringify(r["weights"] ?? {})))].sort();
  const groups = [...new Set(rows.map((r) => String(r["group"] ?? "")))].sort();
  const outOfFrame = [...new Set(rows.flatMap((r) => {
    const ev = r["expected_visibility"];
    return Array.isArray(ev?.["expected_out_of_frame_parts"]) ? (ev["expected_out_of_frame_parts"] as string[]) : [];
  }))].sort();
  const times = rows.map((r) => inventory.jobs[String(r["job_id"])])
    .flatMap((inv) => [inv?.submitted_at, inv?.closed_at].filter((t): t is string => typeof t === "string")).sort();
  const isGlobalVsRegional = groups.includes("W-G") || groups.includes("W-RS");
  const statusCounts: Record<string, number> = {};
  for (const r of rows) {
    const s = inventory.jobs[String(r["job_id"])]?.status ?? "unknown";
    statusCounts[s] = (statusCounts[s] ?? 0) + 1;
  }
  const L: string[] = [];
  L.push(`# ${folder}`);
  L.push("");
  L.push(`> 状态：**delivered_awaiting_user_review** —— 样例已全部交付，等待主人看图。`);
  L.push(`> 视觉验收（F8）为主人专属（user_pending）：助手不评分、不筛图、不选优、不代验收；本 README 只含机械事实与观察问题。`);
  L.push("");
  L.push(`## 1. 这组要决定什么`);
  L.push("");
  L.push(String(decisionText ?? "（spec.delivery_folders_7_2 未提供说明）"));
  L.push("");
  L.push(`决定权在主人：看完本目录全部图后给出采用/淘汰/调参/重跑结论即可，不必填表。`);
  L.push("");
  L.push(`## 2. 各侧是什么（变量与固定项）`);
  L.push("");
  L.push(`- 计划行：${rows.length}（组：${groups.join("、") || "无"}）`);
  L.push(`- 方法侧：${methods.join(" | ")}`);
  L.push(`- 权重/denoise/姿态参数组合（实际值）：${weightCombos.join(" | ")}`);
  L.push(`- 固定项（全 run 一致，明细见 参数与接线/*.manifest-row.json）：底模/CLIP/VAE/LoRA/姿态权重 hash（asset_hashes）、初采样 30 steps / cfg 4.0 / euler_ancestral / sgm_uniform、RS 路由冻结参数、画布 1024×768（R 组修复画布 768×768）、stage seed 冻结算法（case|seed|stage → SHA-256 前 4 字节）。`);
  L.push(`- 每行的实际参数以 manifest.csv 与 参数与接线/ 为准；prompt 原文在 manifest-row 的 prompts 字段。`);
  if (isGlobalVsRegional) {
    L.push(`- **非纯单变量声明**：全局加载（W-G，core LoraLoader + 普通 KSampler）与区域路由（W-RS，RS builder/sampler）同时改变 LoRA 施加结构与采样路由，不是只改一个旋钮的严格对照；QG 同文件不存在「两概念独立全局加权」的等价组（只有等权对角线可对照，见 59 目录）。组间差异不能直接归因于单一变量。`);
  }
  L.push(``);
  L.push(`## 3. 如何看图（同 case+seed 横向对照）`);
  L.push("");
  L.push(`- 文件命名：\`<PAIR>_<ACTION>_<FRAMING>_seed<seed>_<method>.png\`（SOLO 行为 \`SOLO_<角色>_seed…\`；R 组 method 含 \`_d<denoise>\`）。`);
  L.push(`- 对照方法：取相同 case_id + seed 的文件横向比较不同 method/权重；匹配表即 manifest.csv（每行含 job_id/case/seed/method/weights/status/交付文件名/sha256）。`);
  L.push(`- 角色 A=左/主，B=右/次（世界空间锚点不随镜头变化；CARRY 中 A 背 B）。`);
  L.push(`- 复用行（sample_kind=reuse，如 R0 父图、W-RS 的 0.8/0.8 对角）与源图同字节，source_job/source_sha256 列可追溯原图。`);
  L.push("");
  L.push(`## 4. 重点可看什么（只列观察问题，不填答案）`);
  L.push("");
  L.push(`- 角色身份是否成立：发色/发饰/服装与原设（deepseek 蓝渐变发+女仆头饰、claude 橙发+花/蝴蝶结、qwen 渐变发+辫子+小帽、grok 金双马尾+尖耳+冠饰）。`);
  L.push(`- owner 归属：deepseek 鲸尾与尾根连接是否同 owner（不是第三角色）；grok 头饰 bat wings 是头饰，不必然长成一对大背翼。`);
  L.push(`- 手/肩/头连接：可见的手腕-手掌-手指、手臂-肩-躯干、头-颈连接是否连通，有无多生/融合/穿插。`);
  L.push(`- 接触带：HAND 十指是否真交错（非握手/指尖相碰）、HUG 双臂是否互绕躯干有前后交叠、KISS 唇部是否接触、CARRY 承托手与大腿/腿绕两侧/双脚离地。`);
  L.push(`- 区域边界/接缝：B2 轮廓区域、R 组贴回边界是否可见接缝或串色。`);
  L.push(`- 以上是观察问题清单；本目录不含任何助手填写的观察答案。`);
  L.push("");
  L.push(`## 5. 证据边界`);
  L.push("");
  L.push(`- 按取景声明可能在画外的部件（expected_out_of_frame_parts 汇总）：${outOfFrame.length ? outOfFrame.join("、") : "本组各 case 声明为空（以各 case 控制图/structure_index 为准）"}。正常裁掉的尾巴/脚不算缺失。`);
  L.push(`- W 远景原生像素可能不足以判断手指/嘴唇细节；「看起来像牵手」不等于证明十指相扣。`);
  L.push(`- R 组局部修复可能补造新细节：父图与修后图不可混为证据；放大裁剪只帮助阅读原生已有证据。`);
  L.push(`- R 组的实际重绘强度图以 控制图/ 里按 job input_files 复制的资产为准（inputs/repair-v2，含 YugangRepairMaskFalloff 的 audit 记录在 参数与接线/）；原 native 灰度只作结构参考，两者不混用。`);
  L.push(`- 本交付默认不含 1.2× 展示副本，无学习式超分；原生裁剪仅按冻结结构坐标机械输出（\`原生裁剪/\`，R 组修复画布不适用即机械跳过，计数见 §6 与 delivery.json 的 crop_skipped）。`);
  L.push(`- XH 超近景不能凭两张脸证明画外承重/手指动作。`);
  L.push("");
  L.push(`## 6. 这组有多少项（机械计数，无成功率）`);
  L.push("");
  L.push(`- 计划行：${rows.length}；状态分布：${Object.entries(statusCounts).map(([k, v]) => `${k}=${v}`).join("、") || "无"}`);
  L.push(`- 交付图片文件：${fr.images}（其中复用 ${fr.reused_images}）；技术失败行（无图，有记录）：${fr.error_rows}；机械跳过行：${fr.skipped_rows}`);
  L.push(`- 控制图文件：${fr.control_files}；原生裁剪：${fr.crop_files}（机械跳过 ${JSON.stringify(fr.crop_skipped)}）；参数与接线文件：${fr.param_files}；运行记录行：${fr.record_lines}`);
  L.push(`- 技术失败/跳过原因逐行见 manifest.csv 的 error_class/skip_reason 列与 运行记录.jsonl 原文。`);
  L.push("");
  L.push(`## 7. 执行与追溯`);
  L.push("");
  L.push(`- run_id：${String(inventory.run_id)}；manifest sha256：${manifest.sha256}`);
  L.push(`- spec sha256：${String(manifest.doc["spec_sha256"])}；preflight sha256：${String(manifest.doc["preflight_sha256"])}`);
  const exec = manifest.doc["execution"] ?? {};
  L.push(`- 执行版本：core ${String(exec["core_commit"] ?? "?")}（计划冻结 ${String(exec["core_plan_frozen_commit"] ?? "?")}）、RS ${String(exec["rs_commit"] ?? "?")}、Crop ${String(exec["crop_commit"] ?? "?")}、T4 patch ${String(exec["t4_patch"] ?? "?")}、胶水节点 ${String(exec["glue_node"] ?? "?")}`);
  L.push(`- 本组时间范围（runner 记录）：${times.length ? `${times[0]} → ${times[times.length - 1]}` : "无时间记录"}；逐 job 耗时见 manifest.csv duration_seconds。`);
  L.push(`- 每 job 的 prompt_id/generation_info 原文在 参数与接线/（history/submitted-graph/study_metadata）；资产 hash 在 manifest-row 的 asset_hashes。`);
  L.push(`- 交付 revision：${revisionKey}。结论：**待主人看图**；本 README 不预填最佳方案。`);
  L.push("");
  return L.join("\n");
}

// ---------------------------------------------------------------------------
// report：只统计机械数量/参数/耗时/错误
// ---------------------------------------------------------------------------

function runReportInternal(ctx: ArchiveCtx): void {
  const { runRoot } = ctx;
  const manifestPath = join(runRoot, "manifest.json");
  const statePath = join(runRoot, "state.json");
  const hasManifest = existsSync(manifestPath);
  const hasState = existsSync(statePath);
  const results = loadResults(runRoot);
  const deliveryPath = join(runRoot, "delivery.json");
  const delivery = existsSync(deliveryPath) ? (JSON.parse(readFileSync(deliveryPath, "utf8")) as Record<string, any>) : null;
  const collectPath = join(runRoot, "collect.json");
  const collect = existsSync(collectPath) ? (JSON.parse(readFileSync(collectPath, "utf8")) as Record<string, any>) : null;

  const out: Record<string, any> = {
    schema: REPORT_SCHEMA,
    generated_at: nowIso(),
    run_root: runRoot,
    inputs_present: { manifest: hasManifest, state: hasState, results_jsonl: results !== null, collect: collect !== null, delivery: delivery !== null },
    f8_visual_acceptance: "user_pending",
  };

  if (!hasManifest) {
    out.status = "no_manifest";
    out.detail = "manifest.json 不存在（build 未产出）——无预定清单可统计，不猜测、不伪造";
  } else {
    const manifest = loadManifest(runRoot);
    const perGroup: Record<string, any> = {};
    for (const job of manifest.jobs) {
      const g = String(job["group"] ?? "?");
      perGroup[g] ??= { planned_rows: 0, new_rows: 0, reuse_rows: 0, methods: new Set<string>(), statuses: {} as Record<string, number>, error_classes: {} as Record<string, number> };
      perGroup[g].planned_rows++;
      if (job["sample_kind"] === "new") perGroup[g].new_rows++; else perGroup[g].reuse_rows++;
      perGroup[g].methods.add(String(job["method"]));
    }
    let stateJobs: Record<string, any> | null = null;
    if (hasState) {
      const st = JSON.parse(readFileSync(statePath, "utf8")) as Record<string, any>;
      if (st["manifest_sha256"] === manifest.sha256) stateJobs = st["jobs"];
      else out.state_manifest_mismatch = { state: String(st["manifest_sha256"]), manifest: manifest.sha256 };
    }
    const durations: number[] = [];
    const recorded: string[] = [];
    if (stateJobs) {
      for (const job of manifest.jobs) {
        const jid = String(job["job_id"]);
        const st = stateJobs[jid];
        const status = st?.["status"] ?? "no_record";
        const g = String(job["group"] ?? "?");
        perGroup[g].statuses[status] = (perGroup[g].statuses[status] ?? 0) + 1;
        if (st?.["error_class"]) {
          const key = String(st["error_class"]);
          perGroup[g].error_classes[key] = (perGroup[g].error_classes[key] ?? 0) + 1;
        }
        const d = durationSeconds(st?.["submitted_at"], st?.["closed_at"]);
        if (d !== null) durations.push(d);
      }
    }
    if (results) for (const rows of results.rowsByJob.values()) for (const r of rows) if (typeof r["recorded_at"] === "string") recorded.push(r["recorded_at"]);
    recorded.sort();
    for (const g of Object.values(perGroup)) g.methods = [...g.methods].sort();
    out.manifest_sha256 = manifest.sha256;
    out.per_group = perGroup;
    out.durations_seconds = durations.length
      ? { count: durations.length, min: Math.min(...durations), max: Math.max(...durations), avg: Math.round(durations.reduce((a, b) => a + b, 0) / durations.length) }
      : null;
    out.results_recorded_range = recorded.length ? { first: recorded[0], last: recorded[recorded.length - 1], lines: recorded.length } : null;
    if (collect) {
      out.collect = { complete: collect["complete"], counts: collect["counts"], blocking_issues: (collect["blocking_issues"] as unknown[])?.length ?? 0 };
    }
    if (delivery && delivery["complete"] === true && delivery["status"] === "delivered_awaiting_user_review") {
      out.status = "delivered_awaiting_user_review";
      out.delivery = {
        revision: delivery["revision"], delivery_root: delivery["delivery_root"],
        folders: (delivery["folders"] as any[])?.length ?? 0, files: (delivery["files"] as any[])?.length ?? 0,
        baseline_check: delivery["baseline_check"] ? { checked: delivery["baseline_check"]["checked"], changed: (delivery["baseline_check"]["changed"] as string[]).length, missing: (delivery["baseline_check"]["missing"] as string[]).length } : null,
      };
      out.note = "样例已全部交付，等待主人看图（F8=user pending）。本状态只表示机械交付完成，不表示任何视觉验收。";
    } else if (!hasState) {
      out.status = "not_run_no_records";
      out.detail = "state.json 不存在：runner 未执行或证据未回收。无记录不是终态，不以 execution_error 伪装。";
    } else {
      out.status = "not_delivered";
      out.detail = delivery ? "delivery.json 存在但 complete!=true（异常状态，人工核查）" : "delivery.json 不存在：尚未完整交付";
    }
  }

  atomicWriteFile(join(runRoot, "report.json"), JSON.stringify(out, null, 1) + "\n");
  // report.md：同一事实的 Markdown 投影
  const md: string[] = [`# anima-interaction-v1 机械报告`, "", `生成：${out["generated_at"]}；状态：**${out["status"]}**；F8 视觉验收：user_pending（主人专属）。`, ""];
  if (out["per_group"]) {
    md.push(`| 组 | 计划行 | new | reuse | 状态分布 | 错误分类 |`, `| --- | ---: | ---: | ---: | --- | --- |`);
    for (const [g, v] of Object.entries(out["per_group"] as Record<string, any>))
      md.push(`| ${g} | ${v.planned_rows} | ${v.new_rows} | ${v.reuse_rows} | ${Object.entries(v.statuses).map(([k, n]) => `${k}=${n}`).join("、") || "无记录"} | ${Object.entries(v.error_classes).map(([k, n]) => `${k}=${n}`).join("、") || "—"} |`);
    md.push("");
    if (out["durations_seconds"]) md.push(`耗时（submitted→closed，秒）：${JSON.stringify(out["durations_seconds"])}`);
    if (out["results_recorded_range"]) md.push(`results.jsonl 时间范围：${JSON.stringify(out["results_recorded_range"])}`);
  }
  if (out["detail"]) md.push("", String(out["detail"]));
  if (out["note"]) md.push("", String(out["note"]));
  md.push("", `本报告只含机械数量/参数/耗时/错误；不含图像质量结论、成功率或推荐配置。原始数据：report.json。`, "");
  atomicWriteFile(join(runRoot, "report.md"), md.join("\n"));
  console.error(`[archive] report：status=${out["status"]}；写入 ${join(runRoot, "report.json")} 与 report.md`);
  if (out["status"] !== "delivered_awaiting_user_review") process.exitCode = 1;
}

// ---------------------------------------------------------------------------
// 导出合同 + CLI
// ---------------------------------------------------------------------------

export async function runArchiveCommand(command: ArchiveCommand, ctx: ArchiveCtx): Promise<void> {
  if (!["collect", "deliver", "report"].includes(command))
    throw new ArchiveError(`未知命令 "${String(command)}"（可用：collect | deliver | report）`);
  const runRoot = resolve(ctx.runRoot);
  const repoRoot = resolve(ctx.repoRoot);
  if (!existsSync(runRoot)) throw new ArchiveError(`run-root 不存在：${runRoot}`);
  const full: ArchiveCtx = { repoRoot, runRoot, argv: ctx.argv ?? [] };
  switch (command) {
    case "collect": runCollectInternal(full, { write: true }); return;
    case "deliver": runDeliverInternal(full); return;
    case "report": runReportInternal(full); return;
  }
}

const USAGE = `用法：node scripts/experiments/interaction-study-archive.ts <collect|deliver|report> [选项]

命令：
  collect   核验已回收到本地 run-root 的 runner 证据（state/results/images/generation-info），
            真解码 PNG + 核 hash/尺寸/graph/结构输入，写 <run-root>/collect.json。不连网。
  deliver   仅在 collect 完整时，把 47–60 决策目录独占交付到 Downloads 根（wx 写、冲突加 run 后缀、
            既有物料只核对报告不改动），写顶层索引与 delivery.json（run-root 留副本）。
  report    机械统计（数量/参数/耗时/错误），写 <run-root>/report.{json,md}。
            只有完整交付后才报 delivered_awaiting_user_review（F8=user pending）。

选项：
  --run <path>            run-root（缺省 <REPO_ROOT>/var/local-driver/anima-interaction-v1）
  --delivery-root <path>  交付根（缺省 ${DEFAULT_DELIVERY_ROOT}，主人指定绝对路径）
  --revision <rev>        续跑既有自建 revision（wx+marker 幂等）
  --help                  本帮助

退出码：0=成功（collect 完整 / deliver 完成 / report=已交付）；1=不完整/未交付/阻塞（详情见输出与 collect.json）。
根路径唯一来源 src/paths.ts::REPO_ROOT；不按 cwd 拼根。`;

async function main(): Promise<void> {
  const argv = process.argv.slice(2);
  if (argv.includes("--help") || argv.length === 0) { console.log(USAGE); return; }
  const command = argv[0] as ArchiveCommand;
  const rest = argv.slice(1);
  const flag = (n: string): string | undefined => { const i = rest.indexOf(`--${n}`); return i >= 0 ? rest[i + 1] : undefined };
  const runRoot = resolve(flag("run") ?? join(REPO_ROOT, "var", "local-driver", "anima-interaction-v1"));
  await runArchiveCommand(command, { repoRoot: REPO_ROOT, runRoot, argv: rest });
}

const invokedDirectly = process.argv[1] !== undefined &&
  resolve(process.argv[1]) === resolve(new URL(import.meta.url).pathname);
if (invokedDirectly) {
  main().catch((err) => {
    console.error(`[archive] ${err instanceof Error ? err.message : String(err)}`);
    process.exitCode = 1;
  });
}
