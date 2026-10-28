/**
 * Skills：鱼的全部手艺。
 *
 * 鱼只有两只手（bash + read）和一张嘴（say）。所有能力扩展都是磁盘上的一个目录：
 *
 *   skills/<name>/
 *     SKILL.md            YAML frontmatter（name + description）+ 正文
 *     scripts/*           可执行脚本，用 bash 调
 *     references/*        按需读的资料
 *
 * 这就是 Agent Skills 的渐进式披露：常驻上下文里只有 name + description + 路径（每个约 100 token），
 * 真要做事时模型自己 read SKILL.md，再 bash 跑脚本。
 */
import { readdirSync, readFileSync, existsSync, statSync } from "node:fs";
import { renderTemplate } from "./prompts.ts";
import { join } from "node:path";

export interface Skill {
  name: string;
  description: string;
  dir: string;
  skillFile: string;
}

const MAX_DESCRIPTION = 240;

export function discoverSkills(root: string): Skill[] {
  if (!existsSync(root)) return [];
  const skills: Skill[] = [];
  for (const entry of readdirSync(root)) {
    const dir = join(root, entry);
    const skillFile = join(dir, "SKILL.md");
    if (!existsSync(skillFile)) continue;
    const parsed = parseSkillFile(readFileSync(skillFile, "utf8"));
    if (!parsed.name || !parsed.description) continue;
    skills.push({ name: parsed.name, description: parsed.description, dir, skillFile });
  }
  return skills.sort((a, b) => a.name.localeCompare(b.name));
}

/** 极简 frontmatter 解析：只认 name / description，够用且不引依赖。 */
export function parseSkillFile(text: string): { name: string; description: string } {
  const match = /^---\r?\n([\s\S]*?)\r?\n---/.exec(text);
  if (!match) return { name: "", description: "" };

  const fields: Record<string, string> = {};
  let current: string | null = null;
  for (const line of match[1].split(/\r?\n/)) {
    const kv = /^([A-Za-z0-9_-]+):\s*(.*)$/.exec(line);
    if (kv) {
      current = kv[1];
      fields[current] = unquote(kv[2]);
      continue;
    }
    if (current && /^\s+\S/.test(line)) {
      fields[current] = `${fields[current]} ${line.trim()}`.trim();
    }
  }

  const description = (fields["description"] ?? "").replace(/\s+/g, " ").trim();
  return {
    name: fields["name"] ?? "",
    description: description.length > MAX_DESCRIPTION ? `${description.slice(0, MAX_DESCRIPTION)}…` : description,
  };
}

/**
 * 渲染成 system prompt 的一个 section。
 * 模板本身在 prompt/skills.md 里，这里只负责填 {{skills}} 那一块。
 */
export function renderSkillsPrompt(skills: readonly Skill[], template: string): string {
  const list =
    skills.length === 0
      ? "（现在还没有任何手艺）"
      : skills.map((s) => `- ${s.name}: ${s.description}\n  读这里：${s.skillFile}`).join("\n");
  return renderTemplate(template, { skills: list });
}

export function isDirectory(path: string): boolean {
  try {
    return statSync(path).isDirectory();
  } catch {
    return false;
  }
}

function unquote(value: string): string {
  const v = value.trim();
  if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) return v.slice(1, -1);
  return v;
}
