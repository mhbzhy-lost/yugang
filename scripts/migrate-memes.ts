/**
 * 一次性迁移：给存量表情包补一级情绪词。
 *
 * 背景：一级情绪词表（prompt/meme-tags.md）是新的检索入口，老条目只有自由 tag，
 * 不做迁移的话它们在 meme 工具里等于不存在。
 *
 * 规则（机械、可复核，不需要看图）：
 *   1. 先看已有 tag 是否已有情绪词 → 直接沿用
 *   2. 否则按关键词规则从 tag / caption 里推断（见 RULES）
 *   3. 仍推不出来 → 不硬塞，留在 untagged 列表里，等鱼以后重新打标
 *
 * 用法：node scripts/migrate-memes.ts [--dry]
 * 索引路径默认 ~/鱼缸/var/media/memes/index.json，可用 MEME_INDEX 覆盖。
 */
import { readFileSync, writeFileSync, copyFileSync, existsSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

interface Entry {
  file: string;
  md5?: string;
  caption: string;
  tags: string[];
  at?: number;
}

/** 关键词 → 一级情绪词。顺序即优先级，先命中先算。 */
const RULES: [string, string[]][] = [
  ["无语", ["无语", "尴尬", "沉默", "服了", "问号", "懵", "汗"]],
  ["敷衍", ["敷衍", "假笑", "应付", "随便", "哦"]],
  ["嘲讽", ["嘲讽", "阴阳", "鄙视", "呵呵", "笑死", "挖苦", "差评"]],
  ["震惊", ["震惊", "惊", "卧槽", "离谱", "啊这", "吓"]],
  ["生气", ["生气", "怒", "骂", "破防", "火大", "气"]],
  ["开心", ["开心", "笑", "高兴", "乐", "可爱", "卖萌", "嗨", "赞"]],
  ["尴尬", ["社死", "害羞", "脸红", "不好意思"]],
  ["疑惑", ["疑惑", "不懂", "迷惑", "什么鬼", "迷惑行为"]],
  ["赞同", ["赞同", "点赞", "同意", "好耶", "支持"]],
  ["调侃", ["调侃", "玩笑", "打趣", "逗"]],
  ["委屈", ["委屈", "哭", "难过", "不服", "撒娇", "可怜"]],
  ["摆烂", ["摆烂", "躺平", "睡", "告辞", "下线", "润", "摸鱼"]],
];

function infer(entry: Entry, moods: string[]): { mood?: string; how: string } {
  const tags = entry.tags.map((t) => t.toLowerCase());
  const caption = entry.caption.toLowerCase();
  const existing = moods.find((m) => tags.includes(m.toLowerCase()));
  if (existing) return { mood: existing, how: "已有情绪词" };
  for (const [mood, words] of RULES) {
    if (!moods.includes(mood)) continue;
    if (tags.some((tag) => words.some((w) => tag.includes(w)))) return { mood, how: `tag命中「${mood}」` };
  }
  for (const [mood, words] of RULES) {
    if (!moods.includes(mood)) continue;
    if (words.some((w) => caption.includes(w))) return { mood, how: `caption命中「${mood}」` };
  }
  return { how: "未命中" };
}

const dry = process.argv.includes("--dry");
const promptTags = readFileSync(join(import.meta.dirname, "..", "prompt", "meme-tags.md"), "utf8");
const moods = promptTags
  .split("\n")
  .map((l) => l.trim())
  .filter((l) => l.length > 0 && !l.startsWith("#"));

const indexUrl = process.env["MEME_INDEX"] ?? join(homedir(), "鱼缸", "var", "media", "memes", "index.json");
if (!existsSync(indexUrl)) {
  console.error(`找不到索引：${indexUrl}`);
  process.exit(1);
}
const entries = JSON.parse(readFileSync(indexUrl, "utf8")) as Entry[];

const dist = new Map<string, number>();
const untagged: string[] = [];
let changed = 0;

for (const entry of entries) {
  const { mood } = infer(entry, moods);
  if (!mood) {
    untagged.push(entry.file);
    continue;
  }
  dist.set(mood, (dist.get(mood) ?? 0) + 1);
  const has = entry.tags.some((t) => t.toLowerCase() === mood.toLowerCase());
  if (!has) {
    entry.tags = [mood, ...entry.tags];
    changed++;
  }
}

console.log(`库内 ${entries.length} 张，本次补标 ${changed} 张`);
console.log("分布：", [...dist.entries()].sort((a, b) => b[1] - a[1]).map(([m, n]) => `${m}${n}`).join(" · "));
console.log(`推不出情绪的 ${untagged.length} 张（暂时检索不到，等以后重标）`);
if (untagged.length > 0) console.log("  " + untagged.slice(0, 10).join(" "));

if (dry) {
  console.log("--dry：不写回");
} else {
  const backup = `${indexUrl}.bak-${Date.now()}`;
  copyFileSync(indexUrl, backup);
  writeFileSync(indexUrl, `${JSON.stringify(entries, null, 1)}\n`);
  console.log(`已写回，备份：${backup}`);
}
