/**
 * 表情包库概况（只读）。
 *
 *   npm run memes status
 *
 * 入库不再走批处理：鱼在对话里判断「这张动图值不值得收」，用 meme_add 带着语境打标；
 * 主人指名要收的其它图片也走同一个工具。库是生成数据，在 <HOME>/media/memes/ 下，不进 git。
 */
import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";

const HOME = process.env.YUGANG_HOME ?? join(homedir(), "鱼缸", "var");
const MEDIA = resolve(process.env.MEDIA_ROOT ?? join(HOME, "media"));
const MEMES = join(MEDIA, "memes");
const INDEX = join(MEMES, "index.json");

interface Entry {
  file: string;
  md5: string;
  caption: string;
  tags: string[];
  at: number;
}

function loadIndex(): Entry[] {
  if (!existsSync(INDEX)) return [];
  try {
    return JSON.parse(readFileSync(INDEX, "utf8")) as Entry[];
  } catch {
    return [];
  }
}

const [command = "status"] = process.argv.slice(2);

if (command === "status") {
  const index = loadIndex();
  console.log(`库存 ${index.length} 张 · 索引 ${existsSync(INDEX) ? INDEX : "（还没有，等鱼收第一张）"}`);
  for (const entry of index.slice(-10)) {
    console.log(`  ${entry.file} ${entry.caption} [${entry.tags.join(" ")}]`);
  }
} else {
  console.error(`不认识的命令：${command}（只有 status；入库请让鱼用 meme_add）`);
  process.exit(1);
}
