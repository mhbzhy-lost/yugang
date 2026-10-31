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
import { mkdirSync } from "node:fs";
import { isAbsolute, join, resolve, sep } from "node:path";
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
