/**
 * tags —— 查 danbooru 词表（本地 CSV，来自 Windows 端 tagcomplete 的 danbooru.csv）。
 *
 * 动漫模型吃 tag 词表，先查准词再画。本地查询零成本，按热度排序，
 * 名称命中优先于别名命中。CSV 放 <HOME>/danbooru.csv，生成数据不进 git。
 *
 * 说明文字与参数 Schema 唯一来自 TOOL.md manifest（factory 只消费它，不再有第二份运行时定义）。
 */
import { existsSync, readFileSync } from "node:fs";
import { defineTool, type ToolRegistration } from "@earendil-works/pi-durable";
import { renderTemplate } from "../../prompts.ts";
import { manifestParameters, toolFullDescription } from "../manifest.ts";
import type { ToolManifest, ToolPackageDeps } from "../types.ts";

/** args 静态类型：与 TOOL.md 的参数 Schema 一一对应；运行时 Schema 只有 manifest 这一份。 */
interface TagsArgs {
  keyword: string;
}

interface Row {
  name: string;
  category: number;
  count: number;
  aliases: string;
}

const CATEGORY: Record<number, string> = { 0: "通用", 1: "画师", 3: "作品", 4: "角色", 5: "风格" };
let cache: Row[] | null = null;

function load(csvPath: string): Row[] {
  if (cache) return cache;
  if (!existsSync(csvPath)) return [];
  try {
    const rows: Row[] = [];
    for (const line of readFileSync(csvPath, "utf8").split("\n")) {
      if (!line.trim()) continue;
      const m = line.match(/^([^,]+),(\d+),(\d+),(.*)$/);
      if (!m) continue;
      rows.push({ name: m[1], category: Number(m[2]), count: Number(m[3]), aliases: m[4].replace(/^"|"$/g, "") });
    }
    cache = rows;
    return rows;
  } catch {
    return [];
  }
}

export function createTagsTool(manifest: ToolManifest, deps: ToolPackageDeps): ToolRegistration {
  return defineTool({
    name: manifest.name,
    description: toolFullDescription(manifest),
    callers: ["model"],
    parameters: manifestParameters<TagsArgs>(manifest),
    execute: async (args) => {
      const rows = deps.tagsCsv ? load(deps.tagsCsv) : [];
      if (rows.length === 0) {
        throw new Error(deps.prompts.messages["tags_empty"] ?? "tags_empty");
      }
      const kw = args.keyword.trim().toLowerCase().replace(/\s+/g, "_");
      if (!kw) throw new Error(deps.prompts.messages["tags_empty"] ?? "tags_empty");

      const nameHits: Row[] = [];
      const aliasHits: Row[] = [];
      for (const r of rows) {
        const n = r.name.toLowerCase();
        if (n === kw) { nameHits.unshift(r); continue; }
        if (n.includes(kw)) nameHits.push(r);
        else if (r.aliases.toLowerCase().includes(kw)) aliasHits.push(r);
        if (nameHits.length > 40) break;
      }
      const top = [...nameHits, ...aliasHits]
        .sort((a, b) => b.count - a.count)
        .slice(0, 10)
        .map((r) => `${r.name}（${CATEGORY[r.category] ?? "?"}，热度${r.count.toLocaleString()}）`);

      if (top.length === 0) {
        return { output: [{ type: "text", text: renderTemplate(deps.prompts.messages["tags_none"] ?? "tags_none", { keyword: args.keyword.trim() }) }] };
      }
      return { output: [{ type: "text", text: top.join("\n") }] };
    },
  });
}
