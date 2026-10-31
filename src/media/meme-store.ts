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
import { copyFileSync, existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { extname, join, resolve } from "node:path";

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
  /** 源文件绝对路径；目录越界/类型判断由调用方先做完。 */
  source: string;
  caption: string;
  tags: readonly string[];
  now?: number;
}

export type AddMemeResult =
  | { status: "added"; entry: MemeEntry; count: number }
  | { status: "duplicate"; entry: MemeEntry };

/**
 * 收一张图：按 md5 去重 → 复制进 memes/ → 原子替换 index.json。
 * 整个过程在串行队列里完成，所以并发收图不会丢条目。
 */
export function addMeme(input: AddMemeInput): Promise<AddMemeResult> {
  return withMemeStore(input.mediaRoot, () => {
    const root = resolve(input.mediaRoot);
    const memesDir = join(root, "memes");
    const md5 = md5OfFile(input.source);
    const entries = loadMemeIndex(root);
    const existing = entries.find((e) => e.md5 === md5);
    if (existing) return { status: "duplicate" as const, entry: existing };

    const ext = extname(input.source).toLowerCase();
    const file = `${md5.slice(0, 10)}${ext}`;
    mkdirSync(memesDir, { recursive: true });
    copyFileSync(input.source, join(memesDir, file));
    const entry: MemeEntry = { file, md5, caption: input.caption, tags: [...input.tags], at: input.now ?? Date.now() };
    entries.push(entry);
    writeIndexAtomic(root, entries);
    return { status: "added" as const, entry, count: entries.length };
  });
}
