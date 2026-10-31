/**
 * 一次性补标：让 flash 模型给「没有一级情绪词」的存量表情包挑一个词。
 *
 * 为什么不用视觉模型：图是当初在聊天语境里收的，caption/tags 已经写了用途；
 * 再让视觉模型看一遍只会丢掉语境、产出「粉发少女微笑」这种对检索无用的描述。
 *
 * 硬约束：
 *   - 只能从 prompt/meme-tags.md 的词表里选，模型输出不在表内 → 该条不写
 *   - 只新增这一个情绪词，绝不改动 caption、绝不新增其他 tag
 *   - 写回前备份 index.json
 *
 * 用法（默认在 mini 上跑）：
 *   node --experimental-strip-types scripts/retag-memes.ts [--dry] [--limit N]
 * 补标用 config/models.json 的 models.vision（flash 级文本模型，别用 main 的订阅模型）。
 * 环境变量可覆盖：INDEX / AUTH / PROMPT / TAGS
 */
import { readFileSync, writeFileSync, copyFileSync, existsSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { loadFishModels } from "../src/model-config.ts";

interface Entry {
  file: string;
  caption: string;
  tags: string[];
}

const args = process.argv.slice(2);
const dry = args.includes("--dry");
const limitArg = args.indexOf("--limit");
const limit = limitArg >= 0 ? Number(args[limitArg + 1] ?? "0") : 0;

const root = join(import.meta.dirname, "..");
const indexPath = process.env["INDEX"] ?? join(homedir(), "鱼缸", "var", "media", "memes", "index.json");
const authPath = process.env["AUTH"] ?? join(root, "config", "auth.json");
const modelsPath = join(root, "config", "models.json");
const promptPath = process.env["PROMPT"] ?? join(root, "prompt", "meme-retag.md");
const tagsPath = process.env["TAGS"] ?? join(root, "prompt", "meme-tags.md");

if (!existsSync(indexPath)) throw new Error(`找不到索引：${indexPath}`);
if (!existsSync(authPath)) throw new Error(`找不到凭据：${authPath}`);

// 词表
const moods = readFileSync(tagsPath, "utf8")
  .split("\n")
  .map((l) => l.trim())
  .filter((l) => l.length > 0 && !l.startsWith("#"));

// 模型与凭据（key 只进请求头，不打印）：补标用 vision 角色
const vision = loadFishModels({ modelsPath, credentialsPath: authPath }).vision;
const modelId = vision.modelId;
const baseUrl = vision.baseUrl;
const key = vision.key;
if (!baseUrl || !key) throw new Error(`provider ${vision.providerId} 缺 baseUrl 或凭据`);

const entries = JSON.parse(readFileSync(indexPath, "utf8")) as Entry[];
const hasMood = (e: Entry) => e.tags.some((t) => moods.some((m) => m.toLowerCase() === t.toLowerCase()));
let todo = entries.filter((e) => !hasMood(e));
if (limit > 0) todo = todo.slice(0, limit);
console.log(`库内 ${entries.length} 张，缺一级情绪词 ${todo.length} 张`);
if (todo.length === 0) process.exit(0);

const template = readFileSync(promptPath, "utf8");

/** 一次送 15 条：整库 100+ 条塞一次会被 max_tokens 截断，模型只吐出半截 JSON。 */
const CHUNK = 15;
interface Pick {
  file: string;
  mood: string;
}
const picked: Pick[] = [];

async function classify(batch: Entry[]): Promise<Pick[] | null> {
  const list = batch
    .map((e) => `- file: ${e.file}\ncaption: ${e.caption}\ntags: ${e.tags.join("、")}`)
    .join("\n");
  const prompt = template.replace("{{moods}}", moods.join("、")).replace("{{entries}}", list);
  const response = await fetch(`${baseUrl.replace(/\/$/, "")}/chat/completions`, {
    method: "POST",
    headers: { "content-type": "application/json", authorization: `Bearer ${key}` },
    body: JSON.stringify({
      model: modelId,
      messages: [{ role: "user", content: prompt }],
      temperature: 0.2,
      max_tokens: 8192,
      stream: false,
    }),
    signal: AbortSignal.timeout(150_000),
  });
  if (!response.ok) throw new Error(`模型接口 ${response.status}`);
  const payload = (await response.json()) as { choices?: { message?: { content?: string } }[] };
  const content = payload.choices?.[0]?.message?.content ?? "";
  const body = content.slice(content.indexOf("["), content.lastIndexOf("]") + 1);
  if (!body) return null;
  try {
    const parsed = JSON.parse(body) as Pick[];
    return Array.isArray(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

for (let i = 0; i < todo.length; i += CHUNK) {
  const batch = todo.slice(i, i + CHUNK);
  const t0 = Date.now();
  console.log(`  第 ${i / CHUNK + 1} 批开始（${batch.length} 条）`);
  let result = await classify(batch);
  console.log(`  第 ${i / CHUNK + 1} 批返回：${result ? result.length : 0} 条，用时 ${Math.round((Date.now() - t0) / 1000)}s`);
  if (!result) {
    console.log(`  第 ${i / CHUNK + 1} 批返回不完整，重试一次`);
    result = await classify(batch);
  }
  if (!result) {
    console.log(`  第 ${i / CHUNK + 1} 批仍失败，跳过（这些条目留空）`);
    continue;
  }
  picked.push(...result);
  console.log(`  第 ${i / CHUNK + 1} 批：${batch.length} 条 → ${result.length} 条结果`);
}

const byFile = new Map(todo.map((e) => [e.file, e]));
const applied: { file: string; mood: string; caption: string }[] = [];
const rejected: { file: string; mood: string; why: string }[] = [];

for (const item of picked) {
  const entry = byFile.get(String(item.file ?? ""));
  const mood = String(item.mood ?? "").trim();
  if (!entry) {
    rejected.push({ file: String(item.file ?? "?"), mood, why: "库里没有这个文件" });
    continue;
  }
  if (!moods.includes(mood)) {
    rejected.push({ file: entry.file, mood, why: "不在词表内" });
    continue;
  }
  entry.tags = [mood, ...entry.tags.filter((t) => t.toLowerCase() !== mood.toLowerCase())];
  applied.push({ file: entry.file, mood, caption: entry.caption.slice(0, 34) });
}

const missing = todo.filter((e) => !applied.some((a) => a.file === e.file));
console.log(`模型给了 ${picked.length} 条，采纳 ${applied.length} 条，拒绝 ${rejected.length} 条，未覆盖 ${missing.length} 条`);
for (const item of applied) console.log(`  ${item.file}  ${item.mood}  | ${item.caption}`);
for (const item of rejected) console.log(`  ✗ ${item.file}  ${item.mood}  (${item.why})`);
for (const entry of missing) console.log(`  ? ${entry.file}  ${entry.caption.slice(0, 34)}`);

if (dry) {
  console.log("--dry：不写回");
} else if (applied.length > 0) {
  // 跑批期间鱼可能还在收新图：写回前重读一次，按文件名合并，
  // 绝不能整份覆盖——否则这几分钟里新入库的图会被抹掉。
  const backup = `${indexPath}.bak-${Date.now()}`;
  copyFileSync(indexPath, backup);
  const fresh = JSON.parse(readFileSync(indexPath, "utf8")) as Entry[];
  const moodOf = new Map(applied.map((a) => [a.file, a.mood]));
  let merged = 0;
  for (const entry of fresh) {
    const mood = moodOf.get(entry.file);
    if (!mood) continue;
    if (entry.tags.some((t) => t.toLowerCase() === mood.toLowerCase())) continue;
    entry.tags = [mood, ...entry.tags];
    merged++;
  }
  writeFileSync(indexPath, `${JSON.stringify(fresh, null, 1)}\n`);
  console.log(`已写回：合并 ${merged} 条（当前库里 ${fresh.length} 条），备份：${backup}`);
} else {
  console.log("没有可采纳的结果，未写回");
}
