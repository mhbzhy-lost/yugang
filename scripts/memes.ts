/**
 * 表情包库管理：素材收编 + 视觉打标建索引。
 *
 *   npm run memes import    # 收编 media/inbound 与 memes/inbox 的图 → 视觉打标 → 建索引
 *   npm run memes status    # 库存概况
 *
 * 素材与索引都是生成数据，全在 <HOME>/media/memes/ 下，不进 git。
 * 打标走 glm-5.3-flash 视觉（凭据 config/auth.json 的 zai-coding-cn）。
 */
import { createHash } from "node:crypto";
import { copyFileSync, existsSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";

const HOME = process.env.YUGANG_HOME ?? join(homedir(), "鱼缸", "var");
const MEDIA = resolve(process.env.MEDIA_ROOT ?? join(HOME, "media"));
const MEMES = join(MEDIA, "memes");
const INDEX = join(MEMES, "index.json");
const INSTRUCTION = readFileSync(join(process.cwd(), "prompt", "memes.md"), "utf8");
const EXT = new Set([".jpg", ".jpeg", ".png", ".gif", ".webp"]);

interface Entry {
  file: string;
  md5: string;
  caption: string;
  tags: string[];
  at: number;
}

const [command = "status"] = process.argv.slice(2);

function loadIndex(): Entry[] {
  if (!existsSync(INDEX)) return [];
  try {
    return JSON.parse(readFileSync(INDEX, "utf8")) as Entry[];
  } catch {
    return [];
  }
}

function key(): string {
  const auth = JSON.parse(readFileSync("config/auth.json", "utf8")) as { "zai-coding-cn"?: { key?: string } };
  const k = auth["zai-coding-cn"]?.key;
  if (!k) {
    console.error("config/auth.json 里没有 zai-coding-cn 的 key，先 npm run creds import");
    process.exit(1);
  }
  return k;
}

async function caption(file: string, apiKey: string): Promise<{ caption: string; tags: string[] } | null> {
  const b64 = readFileSync(file).toString("base64");
  const res = await fetch("https://open.bigmodel.cn/api/coding/paas/v4/chat/completions", {
    method: "POST",
    headers: { "content-type": "application/json", authorization: `Bearer ${apiKey}` },
    body: JSON.stringify({
      model: "glm-5.3-flash",
      max_tokens: 120,
      thinking: { type: "disabled" },
      messages: [{
        role: "user",
        content: [
          { type: "image_url", image_url: { url: `data:image/jpeg;base64,${b64}` } },
          { type: "text", text: INSTRUCTION },
        ],
      }],
    }),
  });
  if (!res.ok) return null;
  const j = await res.json() as { choices?: { message?: { content?: string } }[] };
  const text = String(j.choices?.[0]?.message?.content ?? "").trim().split("\n")[0];
  const [desc, tagPart] = text.split("|");
  if (!desc?.trim()) return null;
  const tags = String(tagPart ?? "").split(/\s+/).filter(Boolean).slice(0, 6);
  return { caption: desc.trim(), tags: tags.length > 0 ? tags : ["表情"] };
}

function sources(): string[] {
  const out: string[] = [];
  for (const dir of [join(MEDIA, "inbound"), join(MEMES, "inbox")]) {
    if (!existsSync(dir)) continue;
    for (const name of readdirSync(dir)) {
      const p = join(dir, name);
      if (EXT.has(name.slice(name.lastIndexOf(".")).toLowerCase()) && statSync(p).isFile()) out.push(p);
    }
  }
  return out;
}

if (command === "import") {
  mkdirSync(MEMES, { recursive: true });
  const index = loadIndex();
  const seen = new Set(index.map((e) => e.md5));
  const apiKey = key();
  let added = 0;
  for (const src of sources()) {
    const bytes = readFileSync(src);
    const md5 = createHash("md5").update(bytes).digest("hex");
    if (seen.has(md5)) continue;
    const ext = src.slice(src.lastIndexOf(".")).toLowerCase();
    const file = `${md5.slice(0, 10)}${ext}`;
    copyFileSync(src, join(MEMES, file));
    const labeled = await caption(join(MEMES, file), apiKey);
    if (!labeled) {
      console.log(`  ✗ ${file} 打标失败，跳过`);
      continue;
    }
    index.push({ file, md5, ...labeled, at: Date.now() });
    seen.add(md5);
    added++;
    console.log(`  ✓ ${file} ${labeled.caption} [${labeled.tags.join(" ")}]`);
  }
  writeFileSync(INDEX, `${JSON.stringify(index, null, 1)}\n`);
  console.log(`✓ 新增 ${added} 张，库存共 ${index.length} 张 → ${INDEX}`);
} else if (command === "status") {
  const index = loadIndex();
  console.log(`库存 ${index.length} 张 · 索引 ${existsSync(INDEX) ? INDEX : "（未建立，跑 npm run memes import）"}`);
} else {
  console.error(`不认识的命令：${command}（import / status）`);
  process.exit(1);
}
