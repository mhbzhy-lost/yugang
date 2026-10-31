/**
 * 表情包库的读写入口：<mediaRoot>/memes/index.json 与 memes/ 下的图片文件。
 *
 * 为什么集中到这里：索引是「读全量 → 改一条 → 写回全量」，而现在有两个写入方
 * （主人在对话里用 meme_add 收本地图、群里 GIF 自动收图也会落到同一个 meme_add），
 * 读改写撞在一起就会互相覆盖丢条目。所以写入统一走本模块的串行队列，
 * 落盘用「临时文件 + rename」原子替换：要么是旧索引，要么是新索引，不存在半截文件。
 *
 * 这里不放 src/tools：它没有模型可调用的语义，只是文件与索引的实现细节。
 */
import { existsSync, lstatSync, mkdirSync, readFileSync, realpathSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { extname, join, resolve, sep } from "node:path";
import { DEFAULT_LIMITS } from "../egress/policy.ts";

export interface MemeEntry {
  file: string;
  /** 内容指纹（历史条目可能缺这一项，读取侧按可选处理）。 */
  md5?: string;
  caption: string;
  tags: string[];
  at: number;
}

/** 表情包认的图片格式（与出口、收图、look 的白名单一致）。 */
export const MEME_EXT: ReadonlySet<string> = new Set([".jpg", ".jpeg", ".png", ".gif", ".webp"]);

/** 图片文件头（与出口的媒体校验同一套）：只看扩展名会被改名的文本骗过去。 */
const IMAGE_MAGIC: readonly Buffer[] = [
  Buffer.from([0x89, 0x50, 0x4e, 0x47]),
  Buffer.from([0xff, 0xd8, 0xff]),
  Buffer.from("GIF8"),
];

function looksLikeImage(head: Buffer): boolean {
  if (IMAGE_MAGIC.some((sig) => head.subarray(0, sig.length).equals(sig))) return true;
  // WebP：RIFF....WEBP
  return head.subarray(0, 4).toString("ascii") === "RIFF" && head.subarray(8, 12).toString("ascii") === "WEBP";
}

/** 收图来源被拒的理由，由调用方翻成 prompt/messages.md 里的文案。 */
export type MemeSourceCode = "missing" | "type" | "outside" | "link" | "big" | "magic";

export type MemeSourceCheck = { ok: true; file: string } | { ok: false; code: MemeSourceCode };

/**
 * 收图来源的机械校验（fail closed）：媒体目录围栏 → 扩展名 → lstat 拒符号链接 →
 * realpath 再围一次（防目录链接逃逸）→ 大小 → 图片文件头。
 *
 * 为什么每一步都要：meme-inbox/ 是主人本地放图的固定目录，inbound/ 是群友的图；
 * 只要有一环凭扩展名放行，一条 `inbound/x.gif -> /etc/passwd` 就能被收进库。
 * 返回的 `file` 是 realpath，调用方应当用它继续读写（不再被链接换掉）。
 */
export function checkMemeSource(mediaRoot: string, ref: string, maxBytes: number): MemeSourceCheck {
  const root = resolve(mediaRoot);
  const full = resolve(root, ref);
  if (full !== root && !full.startsWith(root + sep)) return { ok: false, code: "outside" };
  if (!MEME_EXT.has(extname(full).toLowerCase())) return { ok: false, code: "type" };

  let real: string;
  try {
    const lstat = lstatSync(full);
    if (lstat.isSymbolicLink()) return { ok: false, code: "link" };
    if (!lstat.isFile()) return { ok: false, code: "type" };
    if (lstat.size > maxBytes) return { ok: false, code: "big" };
    real = realpathSync(full);
  } catch {
    return { ok: false, code: "missing" };
  }

  const realRoot = (() => {
    try {
      return realpathSync(root);
    } catch {
      return root;
    }
  })();
  if (real !== realRoot && !real.startsWith(realRoot + sep)) return { ok: false, code: "outside" };

  try {
    const stat = statSync(real);
    if (!stat.isFile()) return { ok: false, code: "type" };
    if (stat.size > maxBytes) return { ok: false, code: "big" };
    if (!looksLikeImage(readFileSync(real).subarray(0, 16))) return { ok: false, code: "magic" };
  } catch {
    return { ok: false, code: "missing" };
  }
  return { ok: true, file: real };
}

export function memeIndexPath(mediaRoot: string): string {
  return join(resolve(mediaRoot), "memes", "index.json");
}

/** 读索引（每次现读：索引就几 KB，带缓存会让刚收的图最多晚 60 秒才可搜）。 */
export function loadMemeIndex(mediaRoot: string): MemeEntry[] {
  const indexUrl = memeIndexPath(mediaRoot);
  if (!existsSync(indexUrl)) return [];
  try {
    return JSON.parse(readFileSync(indexUrl, "utf8")) as MemeEntry[];
  } catch {
    return [];
  }
}

export function md5OfFile(path: string): string {
  return createHash("md5").update(readFileSync(path)).digest("hex");
}

/** 库里有没有这份内容（GIF 自动收图在起模型轮之前先用它挡一次）。 */
export function hasMemeMd5(mediaRoot: string, md5: string): boolean {
  return loadMemeIndex(mediaRoot).some((e) => e.md5 === md5);
}

/**
 * 写入串行化：同一个索引文件的读改写排成一队，后来的写入一定能看到前一次的落盘结果。
 * 队列尾部吞掉失败（写失败只让调用方看到，不会把后面排队的人一起变成 rejected）。
 */
const queues = new Map<string, Promise<unknown>>();

export function withMemeStore<T>(mediaRoot: string, task: () => T | Promise<T>): Promise<T> {
  const key = memeIndexPath(mediaRoot);
  const previous = queues.get(key) ?? Promise.resolve();
  const run = previous.then(task);
  queues.set(key, run.then(
    () => undefined,
    () => undefined,
  ));
  return run;
}

function writeIndexAtomic(mediaRoot: string, entries: readonly MemeEntry[]): void {
  const indexUrl = memeIndexPath(mediaRoot);
  const tmp = `${indexUrl}.tmp`;
  try {
    writeFileSync(tmp, `${JSON.stringify(entries, null, 1)}\n`);
    renameSync(tmp, indexUrl);
  } finally {
    rmSync(tmp, { force: true });
  }
}

export interface AddMemeInput {
  mediaRoot: string;
  /** 源文件（绝对路径或相对 mediaRoot 的引用）；来源校验在这里再做一次，不信调用方。 */
  source: string;
  caption: string;
  tags: readonly string[];
  now?: number;
  /** 单张上限：与出口的 maxMediaBytes 同一个数，缺省取出口默认值。 */
  maxBytes?: number;
}

export type AddMemeResult =
  | { status: "added"; entry: MemeEntry; count: number }
  | { status: "duplicate"; entry: MemeEntry }
  | { status: "rejected"; code: MemeSourceCode };

/**
 * 收一张图：来源校验 → 按 md5 去重 → 读成内存 → 写进 memes/ → 原子替换 index.json。
 * 整个过程在串行队列里完成，所以并发收图不会丢条目。
 *
 * 校验放在队列里、内容以同一次读取的 bytes 为准：工具层扫过一遍之后再被换掉（TOCTOU）
 * 也没用——写进库的就是校验过的那份字节。
 */
export function addMeme(input: AddMemeInput): Promise<AddMemeResult> {
  return withMemeStore(input.mediaRoot, () => {
    const root = resolve(input.mediaRoot);
    const memesDir = join(root, "memes");
    const maxBytes = input.maxBytes ?? DEFAULT_LIMITS.maxMediaBytes;
    const check = checkMemeSource(root, input.source, maxBytes);
    if (!check.ok) return { status: "rejected" as const, code: check.code };

    const bytes = readFileSync(check.file);
    if (bytes.length > maxBytes) return { status: "rejected" as const, code: "big" };
    if (!looksLikeImage(bytes.subarray(0, 16))) return { status: "rejected" as const, code: "magic" };

    const md5 = createHash("md5").update(bytes).digest("hex");
    const entries = loadMemeIndex(root);
    const existing = entries.find((e) => e.md5 === md5);
    if (existing) return { status: "duplicate" as const, entry: existing };

    const ext = extname(check.file).toLowerCase();
    const file = `${md5.slice(0, 10)}${ext}`;
    mkdirSync(memesDir, { recursive: true });
    writeFileSync(join(memesDir, file), bytes);
    const entry: MemeEntry = { file, md5, caption: input.caption, tags: [...input.tags], at: input.now ?? Date.now() };
    entries.push(entry);
    writeIndexAtomic(root, entries);
    return { status: "added" as const, entry, count: entries.length };
  });
}
