// 姿态库打标：shaded 姿态图 → vision(dflash) → danbooru 姿态 tag
// 输入 /tmp/yugang-study/pose-renders/<NNNN>.png（渲染产物）
// 输出 /tmp/yugang-study/pose-tags-raw.json（逐姿态 tag + 置信度）
// 用法：npx tsx tag-poses.ts <start> <end>；并发 6，逐张可断点续跑（已有结果跳过）
import { readFileSync, writeFileSync, existsSync, readdirSync } from "node:fs";
import { loadFishModels } from "../../src/model/config.ts";

const _m = loadFishModels({ modelsPath: "/Users/mhbzhy/yugang/config/models.json", credentialsPath: "/Users/mhbzhy/yugang/config/auth.json" });
const v = _m.visionFallback ?? _m.vision;
const DIR = "/tmp/yugang-study/pose-renders";
const OUT = "/tmp/yugang-study/pose-tags-raw.json";

const files = readdirSync(DIR).filter((f) => /^\d{4}\.png$/.test(f)).sort();
const raw: Record<string, unknown> = existsSync(OUT) ? JSON.parse(readFileSync(OUT, "utf8")) : {};
const todo = files.filter((f) => raw[f.replace(".png", "")] === undefined);
const [s, e] = [Number(process.argv[2] ?? 0), Number(process.argv[3] ?? todo.length)];
const batch = todo.slice(s, e);
console.log(`待打标 ${todo.length}，本批 ${batch.length}`);

const SYSTEM = `你是姿态标注员。看 shaded 3D 人体姿态图，输出描述该姿态的英文 danbooru 风格 tag。
规则：
- 3-8 个 tag，逗号分隔，覆盖：基础体位（standing/sitting/lying/kneeling/squatting/crouching）、肢体动作（arms crossed/hands on hips/one arm raised/waving/holding hands...）、朝向（from behind/looking back/side view...）、腿部细节（crossed legs/knees up/legs apart...）
- 只写图里明确可见的，不猜测意图；不确定的肢体（被遮挡/模糊）不写
- 全部小写，danbooru 惯用形态（如 arms crossed 不写 arm-crossed）
输出格式（严格 JSON）：{"tags":["...","..."],"confident":true|false}
confident=false 当且仅当你自己都觉得姿态难以判断。`;

async function tagOne(file: string): Promise<void> {
  const idx = file.replace(".png", "");
  const b64 = readFileSync(`${DIR}/${file}`).toString("base64");
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      const r = await fetch(`${v.baseUrl.replace(/\/$/, "")}/chat/completions`, {
        method: "POST",
        headers: { "content-type": "application/json", authorization: `Bearer ${v.key}` },
        body: JSON.stringify({
          model: v.modelId,
          messages: [
            { role: "system", content: SYSTEM },
            { role: "user", content: [{ type: "image_url", image_url: { url: `data:image/png;base64,${b64}` } }] },
          ],
          max_tokens: 4000, temperature: 0.1, stream: false,
        }),
        signal: AbortSignal.timeout(60_000),
      });
      const p = (await r.json()) as { choices?: { message?: { content?: string } }[] };
      const c = p.choices?.[0]?.message?.content ?? "";
      const m = c.match(/\{[\s\S]*\}/);
      if (!m) throw new Error("no-json");
      const j = JSON.parse(m[0]) as { tags?: string[]; confident?: boolean };
      if (!Array.isArray(j.tags) || j.tags.length === 0) throw new Error("no-tags");
      raw[idx] = { tags: j.tags.map(String).map((t) => t.trim().toLowerCase()).filter(Boolean), confident: j.confident !== false };
      return;
    } catch {
      await new Promise((r) => setTimeout(r, 1500 * (attempt + 1)));
    }
  }
  raw[idx] = { tags: [], confident: false, failed: true };
}

let done = 0;
const main = (async () => {
const workers = Array.from({ length: 6 }, async (_, w) => {
  for (let i = w; i < batch.length; i += 6) {
    await tagOne(batch[i]);
    done++;
    if (done % 50 === 0) {
      writeFileSync(OUT, JSON.stringify(raw));
      console.log(`${done}/${batch.length}（已落盘）`, new Date().toISOString().slice(11, 19));
    }
  }
});
await Promise.all(workers);
writeFileSync(OUT, JSON.stringify(raw));
const vals = Object.values(raw) as { tags?: string[] }[];
console.log(`完成：${vals.length} 条，空 tag ${vals.filter((x) => !x.tags?.length).length} 条`);

})();
void main;
