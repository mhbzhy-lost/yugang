/**
 * tags —— 查 danbooru tag 词表 + 角色/风格 LoRA 词表。
 *
 * 三条路径：
 * 1. 不带 keyword（或 lora/词表/列表）：平铺总表，模型据此挑 LoRA；
 * 2. 命中角色/风格条目：返回 LoRA 文件名、建议权重、底模、来源、触发词/外观/服装分段，
 *    并叠加最多 3 条 danbooru 同名词条作参考；
 * 3. 未命中：走 danbooru CSV；CSV 也没有时给「相近的条目」候选，绝不死路。
 *
 * 说明文字与参数 Schema 唯一来自 TOOL.md / schema.json / messages.json（factory 只消费 manifest）。
 */
import { existsSync, readFileSync } from "node:fs";
import { defineTool, type ToolRegistration } from "@earendil-works/pi-durable";
import { renderTemplate } from "../../prompt/index.ts";
import {
  findCharacter,
  findSection,
  listCharacters,
  suggestCharacters,
  type CharacterEntry,
  type EntryGroup,
} from "../characters.ts";
import { manifestParameters, toolFullDescription } from "../manifest.ts";
import type { ToolManifest, ToolPackageDeps } from "../types.ts";

/** args 静态类型：与 TOOL.md 的参数 Schema 一一对应；运行时 Schema 只有 manifest 这一份。 */
interface TagsArgs {
  keyword?: string;
}

interface Row {
  name: string;
  category: number;
  count: number;
  aliases: string;
}

const CATEGORY: Record<number, string> = { 0: "通用", 1: "画师", 3: "作品", 4: "角色", 5: "风格" };
/** 总表触发词：模型想挑 LoRA 时不需要猜类别，直接查空或这些词。 */
const LIST_WORDS = new Set(["", "lora", "lora表", "词表", "列表", "list"]);
const GROUPS: readonly EntryGroup[] = ["aigirls", "honkai3rd", "style"];
const LIST_BUDGET = 700;
const DETAIL_BUDGET = 1200;
const RELATED_LIMIT = 3;
const SIBLING_LIMIT = 4;
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

/** danbooru 行：名称或别名包含关键词，按热度取前 N。 */
function related(rows: readonly Row[], keyword: string, limit: number): Row[] {
  const kw = keyword.toLowerCase().replace(/\s+/g, "_");
  if (!kw) return [];
  const hits: Row[] = [];
  for (const row of rows) {
    const name = row.name.toLowerCase();
    if (name === kw) hits.unshift(row);
    else if (name.includes(kw) || row.aliases.toLowerCase().includes(kw)) hits.push(row);
  }
  return hits.sort((a, b) => b.count - a.count).slice(0, limit);
}

/** 平铺总表：每条 `key · name · weight`，按宽度折行；超预算先降级去掉 weight，再截断。 */
function renderList(deps: ToolPackageDeps, entries: readonly CharacterEntry[]): string {
  const head = renderTemplate(deps.prompts.messages["tags_list_head"] ?? "{{n}}", { n: entries.length });
  const hint = deps.prompts.messages["tags_list_hint"] ?? "";
  const build = (withWeight: boolean) => {
    const lines: string[] = [];
    let line = "";
    for (const entry of entries) {
      const item = withWeight ? `${entry.key} · ${entry.name} · ${entry.weight.toFixed(1)}` : `${entry.key} · ${entry.name}`;
      if (line && line.length + item.length + 3 > 74) { lines.push(line); line = ""; }
      line = line ? `${line} | ${item}` : item;
    }
    if (line) lines.push(line);
    return [head, ...lines, hint].filter(Boolean).join("\n");
  };
  const full = build(true);
  if (full.length <= LIST_BUDGET) return full;
  const compact = build(false);
  if (compact.length <= LIST_BUDGET) return compact;
  return `${compact.slice(0, LIST_BUDGET - 1)}…`;
}

/** 条目详情：头部元数据 + 分段（总预算），叠加 danbooru 参考、hint 与同系列。 */
function renderDetail(deps: ToolPackageDeps, rows: readonly Row[], entry: CharacterEntry, keyword: string): string {
  const messages = deps.prompts.messages;
  const isStyle = entry.group === "style";
  const kind = isStyle ? (messages["tags_kind_style"] ?? entry.group) : (messages["tags_kind_character"] ?? entry.group);
  const head = renderTemplate(messages["tags_character"] ?? "{{name}}", { kind, name: entry.name });
  const lines: string[] = [head];
  lines.push(renderTemplate(messages["tags_character_meta"] ?? "{{lora}}", { lora: entry.lora, weight: entry.weight.toFixed(1), base: entry.base }));
  if (entry.source) lines.push(renderTemplate(messages["tags_character_source"] ?? "{{source}}", { source: entry.source }));

  const targeted = findSection(entry, keyword);
  const sections = targeted ? [targeted] : entry.sections;
  const sectionTpl = messages["tags_character_section"] ?? "{{title}} {{tags}}";

  // 先算尾部（danbooru + hint + 同系列），给正文留出预算，保证整条回执不超 DETAIL_BUDGET。
  const trailer: string[] = [];
  for (const row of related(rows, keyword, RELATED_LIMIT)) {
    trailer.push(renderTemplate(messages["tags_character_danbooru"] ?? "{{tag}}", {
      tag: row.name,
      category: CATEGORY[row.category] ?? "?",
      count: row.count.toLocaleString(),
    }));
  }
  const hintKey = isStyle ? messages["tags_style_hint"] : messages["tags_character_hint"];
  trailer.push(renderTemplate(hintKey ?? "{{key}}", { key: entry.key }));
  const siblings = listCharacters(entry.group).filter((item) => item.key !== entry.key).slice(0, SIBLING_LIMIT);
  if (siblings.length > 0) {
    trailer.push(renderTemplate(messages["tags_siblings"] ?? "{{list}}", {
      list: siblings.map((item) => `${item.key} · ${item.name}`).join(" · "),
    }));
  }
  const trailerSize = trailer.reduce((sum, line) => sum + line.length + 1, 0);

  let budget = lines.join("\n").length + trailerSize;
  let shown = 0;
  let skipped = 0;
  for (const section of sections) {
    const line = renderTemplate(sectionTpl, { title: section.title, tags: section.tags.replace(/,\s*$/, "") });
    if (budget + line.length + 1 > DETAIL_BUDGET) { skipped += 1; continue; }
    lines.push(line);
    budget += line.length + 1;
    shown += 1;
  }
  if (shown === 0 && sections.length > 0) {
    // 预算连一段都放不下时，至少给出首段的前 300 字符，避免「有分段却没内容」。
    const first = sections[0];
    lines.push(renderTemplate(sectionTpl, { title: first.title, tags: first.tags.slice(0, 300) }));
  }
  if (skipped > 0) lines.push(renderTemplate(messages["tags_character_more"] ?? "{{n}}", { n: skipped }));

  lines.push(...trailer);
  return lines.join("\n");
}

export function createTagsTool(manifest: ToolManifest, deps: ToolPackageDeps): ToolRegistration {
  return defineTool({
    name: manifest.name,
    description: toolFullDescription(manifest),
    callers: ["model"],
    parameters: manifestParameters<TagsArgs>(manifest),
    execute: async (args) => {
      const messages = deps.prompts.messages;
      const rows = deps.tagsCsv ? load(deps.tagsCsv) : [];
      if (rows.length === 0) throw new Error(messages["tags_empty"] ?? "tags_empty");
      const keyword = (args.keyword ?? "").trim();
      const lowered = keyword.toLowerCase().replace(/\s+/g, "_");

      // 1) 总表：不带 keyword、或 lora/词表/列表，或直接给组名。
      if (LIST_WORDS.has(lowered)) {
        return { output: [{ type: "text", text: renderList(deps, listCharacters()) }] };
      }
      const group = GROUPS.find((item) => item === lowered);
      if (group) {
        const label = group === "aigirls"
          ? (messages["tags_group_aigirls"] ?? group)
          : group === "honkai3rd"
            ? (messages["tags_group_honkai3rd"] ?? group)
            : (messages["tags_group_style"] ?? group);
        return { output: [{ type: "text", text: `${label}\n${renderList(deps, listCharacters(group))}` }] };
      }

      // 2) 角色/风格条目。
      const entry = findCharacter(keyword);
      if (entry) {
        return { output: [{ type: "text", text: renderDetail(deps, rows, entry, keyword) }] };
      }

      // 3) danbooru 词表；仍无结果时给候选，不直接说「没有」。
      const top = related(rows, keyword, 10);
      if (top.length > 0) {
        return {
          output: [{ type: "text", text: top.map((r) => `${r.name}（${CATEGORY[r.category] ?? "?"}，热度${r.count.toLocaleString()}）`).join("\n") }],
        };
      }
      const candidates = suggestCharacters(keyword);
      if (candidates.length > 0) {
        return {
          output: [{
            type: "text",
            text: renderTemplate(messages["tags_suggest"] ?? "{{keyword}}", {
              keyword,
              list: candidates.map((item) => `${item.name}（${item.key}）`).join(" · "),
            }),
          }],
        };
      }
      return { output: [{ type: "text", text: renderTemplate(messages["tags_none"] ?? "tags_none", { keyword }) }] };
    },
  });
}
