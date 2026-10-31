/**
 * fs 工具组共享 helper：路径围栏、敏感目录封禁、二进制判定、审计日志与主人身份闸。
 *
 * read / grep / write 三个主人专属工具（各自 src/tools/<name>/tool.ts）共用这里；
 * 围栏与封禁只有这一份实现，三个工具不得各自漂移。这里不暴露任何模型可调的工具。
 *
 * 可读范围 = 仓库工作区 + /tmp/yugang（鱼的草稿区）；write 只能写 /tmp/yugang——仓库与本机配置的
 * 文件（含 config/models.json）由专门的管理工具改，不提供通用写入能力。
 * .env、config/auth.json、.git/、node_modules/、.trash/、.pi/ 一律硬封禁。全部操作打审计日志。
 */
import { lstatSync, mkdirSync, realpathSync } from "node:fs";
import { isAbsolute, join, relative, resolve, sep } from "node:path";
import { LiveDoc } from "@earendil-works/pi-durable";
import type { ToolPackageDeps } from "./types.ts";

export const READ_CAP = 32_000;
export const WRITE_CAP = 1_000_000;
export const BIN_EXT = new Set([".png", ".jpg", ".jpeg", ".gif", ".webp", ".heic", ".db", ".db-wal", ".db-shm", ".zip", ".node", ".asar"]);

/** 鱼的草稿区：write 唯一能写的地方，read / grep 额外可读。 */
export const SAND_ROOT = resolve("/tmp", "yugang");

/** 创建工具时确保草稿区存在（原 fs 工具组的启动行为；幂等）。 */
export function ensureSandRoot(): void {
  mkdirSync(SAND_ROOT, { recursive: true });
}

/** 仓库内相对路径；越界与敏感文件返回 null。 */
export function resolveInside(root: string, raw: string): string | null {
  const full = resolve(root, raw);
  if (full === root || !full.startsWith(root + sep)) return null;
  const rel = full.slice(root.length + 1);
  const first = rel.split(sep)[0];
  if (rel === ".env" || rel === join("config", "auth.json")) return null;
  if (first === ".git" || first === "node_modules" || first === ".trash" || first === ".pi") return null;
  return full;
}

/** `/tmp/yugang` 内的绝对路径；越界返回 null。 */
export function withinSand(raw: string): string | null {
  const full = resolve(raw);
  if (full === SAND_ROOT || full.startsWith(SAND_ROOT + sep)) return full;
  return null;
}

/** 符号链接围栏的结果：ok 时 real 是解算后的真实路径，调用方应尽量以它继续读写。 */
export type LinkFenceResult = { ok: true; real: string } | { ok: false; reason: "missing" | "link" | "outside" };

function realRootOf(root: string): string | null {
  try {
    return realpathSync(root);
  } catch {
    return null; // 根本身不可解算：fail-closed
  }
}

function insideRealRoot(realRoot: string, real: string): boolean {
  return real === realRoot || real.startsWith(realRoot + sep);
}

/**
 * 已存在目标的符号链接围栏（read / grep / tree 与媒体链共用，fail-closed）：
 * - 目标不存在 → missing；
 * - 最终分量本身是符号链接 → link（一律不跟随，哪怕指向允许根内）；
 * - realpath（中间目录链接一并解算）落在允许根之外 → outside。
 * 比较用 realpath(root)：macOS 的 /tmp、/var 本身就是符号链接，lexical 比较会误判。
 */
export function fenceReadablePath(root: string, full: string): LinkFenceResult {
  const realRoot = realRootOf(root);
  if (!realRoot) return { ok: false, reason: "outside" };
  let st;
  try {
    st = lstatSync(full);
  } catch {
    return { ok: false, reason: "missing" };
  }
  if (st.isSymbolicLink()) return { ok: false, reason: "link" };
  let real: string;
  try {
    real = realpathSync(full);
  } catch {
    return { ok: false, reason: "missing" };
  }
  if (!insideRealRoot(realRoot, real)) return { ok: false, reason: "outside" };
  return { ok: true, real };
}

/**
 * 新建路径的符号链接围栏（write 草稿区）：目标可能尚不存在，不能直接 realpath。
 * - 路径上任何已存在的分量是符号链接 → link（不跟随）；
 * - 最近的已存在祖先的 realpath 落在允许根之外 → outside（新建件会落进链接指向的位置）；
 * - 最终分量已存在时同样被 walk 覆盖：是链接 → link，realpath 越界 → outside。
 */
export function fenceWritablePath(root: string, full: string): LinkFenceResult {
  const realRoot = realRootOf(root);
  if (!realRoot) return { ok: false, reason: "outside" };
  const rel = relative(root, full);
  if (rel === "") return { ok: false, reason: "outside" };
  let deepest = root; // 最近的已存在祖先；目标不存在时以它的 realpath 作落点校验
  let cur = root;
  for (const part of rel.split(sep)) {
    cur = join(cur, part);
    let st;
    try {
      st = lstatSync(cur);
    } catch {
      break; // 不存在：更深的分量必然也不存在，deepest 就是最近的已存在祖先
    }
    if (st.isSymbolicLink()) return { ok: false, reason: "link" };
    deepest = cur;
  }
  let real: string;
  try {
    real = realpathSync(deepest);
  } catch {
    return { ok: false, reason: "outside" };
  }
  if (!insideRealRoot(realRoot, real)) return { ok: false, reason: "outside" };
  return { ok: true, real };
}

export interface ResolvedPath {
  full: string;
  /** 审计与错误里显示的名字：仓库内是相对路径，草稿区是绝对路径。 */
  label: string;
}

/** read / grep：相对路径按仓库解析，绝对路径只认 /tmp/yugang。 */
export function resolveReadable(root: string, raw: string): ResolvedPath | null {
  if (isAbsolute(raw)) {
    const full = withinSand(raw);
    return full ? { full, label: full } : null;
  }
  const full = resolveInside(root, raw);
  return full ? { full, label: full.slice(root.length + 1) } : null;
}

/** write：相对路径按 /tmp/yugang 解析，绝对路径也只认 /tmp/yugang。 */
export function resolveWritable(raw: string): ResolvedPath | null {
  const full = isAbsolute(raw) ? withinSand(raw) : withinSand(resolve(SAND_ROOT, raw));
  return full ? { full, label: full } : null;
}

/** 审计日志：全部 fs 操作一行一条，不落盘、只进进程控制台。 */
export function audited(op: string, rel: string, extra = ""): void {
  console.log(`[鱼缸] fs ${op} ${rel}${extra ? ` ${extra}` : ""}`);
}

/** defineTool execute 里身份闸需要的最小 api 形状（LiveDoc 快照）。 */
export interface SnapshotApi {
  conversationId: string;
  snapshot: (doc: unknown, id: string, context: unknown) => Promise<unknown>;
}

/**
 * 主人身份闸：本轮触发消息的 userId 必须是主人，机械判定，群友注入文本造不出别人的触发身份。
 * lockedMessage 由调用方从 prompts.messages["fs_locked"] 取（key 缺省时退化成 key 名）。
 */
export async function assertTriggeredByMaster(
  gate: Pick<ToolPackageDeps, "master" | "triggerOf">,
  api: SnapshotApi,
  context: unknown,
  lockedMessage: string,
): Promise<void> {
  const live = (await api.snapshot(LiveDoc, api.conversationId, context)) as
    | { run?: { inputs?: unknown[] } }
    | undefined;
  const round = live?.run?.inputs?.[0];
  const trigger = round !== undefined ? gate.triggerOf?.(round) : undefined;
  if (!gate.master || !trigger || String(trigger.userId) !== gate.master) throw new Error(lockedMessage);
}
