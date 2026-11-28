/**
 * Runtime 无副作用基础设施：容错/原子 JSON 读写、封顶去重表、会话级换页排班队列、媒体 TTL 清理。
 *
 * 独立于 runtime.ts，避免测试导入时触发进程级环境变量/数据库/OneBot 顶层初始化。
 */
import { randomBytes } from "node:crypto";
import { mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { lstat, readdir, unlink } from "node:fs/promises";
import { dirname, join } from "node:path";

/** 安全读取 JSON 文件：不存在静默回落，损坏或结构校验失败打告警并回落默认值。 */
export function readJsonSafe<T>(
  filePath: string,
  fallback: T,
  validate?: (value: unknown) => value is T,
): T {
  let raw: string;
  try {
    raw = readFileSync(filePath, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException | undefined)?.code === "ENOENT") return fallback;
    console.warn(`[鱼缸] 读取 JSON 失败 ${filePath}`, error instanceof Error ? error.message : error);
    return fallback;
  }
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (validate && !validate(parsed)) {
      console.warn(`[鱼缸] JSON 结构非法，回退默认态 ${filePath}`);
      return fallback;
    }
    return parsed as T;
  } catch (error) {
    console.warn(`[鱼缸] JSON 解析失败，回退默认态 ${filePath}`, error instanceof Error ? error.message : error);
    return fallback;
  }
}

/** 原子写入 JSON：同目录写临时文件后 rename 替换，finally 清理残留 .tmp。 */
export function writeJsonAtomic(filePath: string, data: unknown): void {
  mkdirSync(dirname(filePath), { recursive: true });
  const tmp = `${filePath}.${process.pid}.${randomBytes(4).toString("hex")}.tmp`;
  try {
    writeFileSync(tmp, JSON.stringify(data));
    renameSync(tmp, filePath);
  } finally {
    rmSync(tmp, { force: true });
  }
}

export interface SentStore {
  has(key: string): boolean;
  mark(key: string): boolean;
  readonly size: number;
}

/** 封顶幂等发送表：内存 Set 与磁盘数组同步上限（淘汰最旧键），损坏文件安全回退空态。 */
export function createSentStore(filePath: string, cap = 5000): SentStore {
  const limit = Math.max(1, Math.floor(cap));
  const initial = readJsonSafe<unknown[]>(filePath, [], (value): value is unknown[] => Array.isArray(value));
  const set = new Set<string>(initial.filter((item): item is string => typeof item === "string").slice(-limit));

  return {
    has(key) {
      return set.has(key);
    },
    mark(key) {
      if (set.has(key)) return false;
      set.add(key);
      while (set.size > limit) {
        const oldest = set.values().next().value;
        if (oldest === undefined) break;
        set.delete(oldest);
      }
      writeJsonAtomic(filePath, [...set]);
      return true;
    },
    get size() {
      return set.size;
    },
  };
}

interface CompactQueueEntry<T> {
  tail: Promise<void>;
  pending: number;
  lastCompacted?: T;
}

export interface CompactQueue<T extends { compacted: boolean }> {
  enqueue(id: string | number, force: boolean, fn: () => Promise<T>): Promise<T>;
  isCompacting(id: string | number): boolean;
}

/**
 * 按会话串行化换页任务：
 * - 同一会话队列非空期间 isCompacting(id) 恒为 true；
 * - force 排在非 force 后时，前者返回 below_threshold 等未换页态不得吞掉后者；
 * - 若同一排队周期内前置任务已成功换页（compacted=true），后续 force 可直接复用结果避免连压两次。
 */
export function createCompactQueue<T extends { compacted: boolean }>(): CompactQueue<T> {
  const queues = new Map<string, CompactQueueEntry<T>>();

  return {
    isCompacting(id) {
      const entry = queues.get(String(id));
      return entry !== undefined && entry.pending > 0;
    },
    enqueue(id, force, fn) {
      const key = String(id);
      let entry = queues.get(key);
      if (!entry) {
        entry = { tail: Promise.resolve(), pending: 0 };
        queues.set(key, entry);
      }
      entry.pending += 1;
      const current = entry;
      const prev = current.tail;

      const run = prev.then(async (): Promise<T> => {
        try {
          if (force && current.lastCompacted !== undefined) {
            return current.lastCompacted;
          }
          const result = await fn();
          if (result.compacted) {
            current.lastCompacted = result;
          }
          return result;
        } finally {
          current.pending -= 1;
          if (current.pending <= 0 && queues.get(key) === current) {
            queues.delete(key);
          }
        }
      });

      current.tail = run.then(
        () => {},
        () => {},
      );
      return run;
    },
  };
}

const EXPIRABLE_MEDIA_DIRS = ["inbound", "gen", "voice"] as const;

async function sweepExpiredDir(dirPath: string, cutoffMs: number): Promise<number> {
  let entries;
  try {
    entries = await readdir(dirPath, { withFileTypes: true });
  } catch (error) {
    if ((error as NodeJS.ErrnoException | undefined)?.code === "ENOENT") return 0;
    throw error;
  }
  let deleted = 0;
  for (const entry of entries) {
    const full = join(dirPath, String(entry.name));
    let st;
    try {
      st = await lstat(full);
    } catch {
      continue;
    }
    if (st.isSymbolicLink()) continue;
    if (st.isDirectory()) {
      deleted += await sweepExpiredDir(full, cutoffMs);
      continue;
    }
    if (!st.isFile()) continue;
    if (st.mtimeMs < cutoffMs) {
      try {
        await unlink(full);
        deleted += 1;
      } catch {
        /* 并发已删则跳过 */
      }
    }
  }
  return deleted;
}

/** 仅清理 inbound/、gen/、voice/ 下的过期普通文件，绝不触碰 memes/、meme-inbox/、inbound-video/ 与符号链接。 */
export async function cleanupExpiredMedia(mediaRoot: string, ttlMs: number, now = Date.now()): Promise<number> {
  if (!Number.isFinite(ttlMs) || ttlMs <= 0) return 0;
  const cutoffMs = now - ttlMs;
  let total = 0;
  for (const sub of EXPIRABLE_MEDIA_DIRS) {
    total += await sweepExpiredDir(join(mediaRoot, sub), cutoffMs);
  }
  return total;
}
