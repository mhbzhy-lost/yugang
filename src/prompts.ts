/**
 * 所有 prompt 都在 prompt/ 下的 markdown 里，代码里一个字都不内嵌。
 *
 * 这样做的代价是多一层加载和一堆「文件不存在就报错」的分支，
 * 换来的是：改一句话不需要读代码，审查时 diff 一眼能看出来。
 *
 * 工具说明与参数 Schema 不在这里：它们唯一来自 src/tools/<name>/TOOL.md，
 * 由 src/tools/loader.ts 的 manifest loader 读取（PromptSet 只保留共享文案与人格）。
 */
import { readFileSync, existsSync, readdirSync } from "node:fs";
import { join, relative } from "node:path";
import { createHash } from "node:crypto";

/** 人格书：frontmatter 属性 + 正文。frontmatter 只认单行 `key: value`（目前用 opener）。 */
export interface PersonaBook {
  /** 剥离 frontmatter 后的正文，供 persona section 注入；frontmatter 绝不进模型。 */
  body: string;
  /** frontmatter 的 opener：宿主切换到该人格后机械补发的开场白，不进模型。 */
  opener?: string;
}

export interface PromptSet {
  root: string;
  /** 人格无关的运行时协议（输入信任边界、出口、渐进加载）；常驻 section，tag false。 */
  runtime: string;
  persona: string;
  /** 上下文压缩用的备忘提示词，含 {{transcript}}。 */
  handoff: string;
  /** 群档案模板，建会话时渲染一次。 */
  groupProfile: string;
  /** 运维书：管理工具（模型切换 / 重启）的使用约束，常驻 section。 */
  ops: string;
  /** 手工维护的人物档，作为常驻 section。 */
  people: string;
  /** 表情包一级情绪词表（prompt/meme-tags.md 里一行一个词），打标与检索都只认这些。 */
  memeTags: string[];
  messages: Record<string, string>;
  /** 人格书：key 是人格名（prompt/personas/<名>.md 的文件名）。目录缺失/为空 → 空。 */
  personas: Record<string, PersonaBook>;
}

export function loadPrompts(root: string): PromptSet {
  return {
    root,
    runtime: read(join(root, "runtime.md")),
    persona: read(join(root, "persona.md")),
    handoff: read(join(root, "handoff.md")),
    groupProfile: read(join(root, "group-profile.md")),
    ops: read(join(root, "ops.md")),
    people: read(join(root, "people.md")),
    memeTags: loadWordList(join(root, "meme-tags.md")),
    messages: parseMessageTable(read(join(root, "messages.md")), join(root, "messages.md")),
    personas: loadPersonas(join(root, "personas")),
  };
}

/** 一行一个词的文件（# 开头是注释、空行忽略）；文件不存在 → 空数组。 */
function loadWordList(path: string): string[] {
  if (!existsSync(path)) return [];
  return read(path)
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line.length > 0 && !line.startsWith("#"));
}

/**
 * 人格书目录：文件名 = 人格名（中文名合法）。目录缺失或为空 = 只有默认人格，不报错。
 * 名字不能含 `#`（会话映射键的分隔符），也不能叫「默认」（默认人格没有后缀键）。
 */
function loadPersonas(dir: string): Record<string, PersonaBook> {
  if (!existsSync(dir)) return {};
  const personas: Record<string, PersonaBook> = {};
  for (const entry of readdirSync(dir).sort()) {
    if (!entry.endsWith(".md")) continue;
    const name = entry.slice(0, -3);
    if (name.includes("#")) throw new Error(`人格名不能含 #：${entry}`);
    if (name === "默认") throw new Error(`人格名不能叫 默认：${entry}`);
    const book = parsePersonaBook(read(join(dir, entry)));
    if (!book.body) throw new Error(`人格书剥掉 frontmatter 后没有正文：${entry}`);
    personas[name] = book;
  }
  return personas;
}

/** 人格书解析：frontmatter 只认单行 `key: value`，剥离后的正文单独放 body。 */
export function parsePersonaBook(text: string): PersonaBook {
  const match = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/.exec(text);
  if (!match) return { body: text.trim() };
  const meta: Record<string, string> = {};
  for (const raw of match[1].split(/\r?\n/)) {
    const kv = /^([A-Za-z0-9_-]+):\s*(.*)$/.exec(raw.trim());
    if (kv) meta[kv[1]] = kv[2].trim();
  }
  return { body: match[2].trim(), ...(meta.opener ? { opener: meta.opener } : {}) };
}

function read(path: string): string {
  if (!existsSync(path)) throw new Error(`缺少 prompt 文件：${path}`);
  const text = readFileSync(path, "utf8").trim();
  if (text.length === 0) throw new Error(`prompt 文件是空的：${path}`);
  return text;
}

/** `key: text` 一行一条，`#` 开头是注释。 */
export function parseMessageTable(text: string, path = "messages.md"): Record<string, string> {
  const table: Record<string, string> = {};
  for (const [index, raw] of text.split(/\r?\n/).entries()) {
    const line = raw.trim();
    if (!line || line.startsWith("#")) continue;
    const match = /^([a-z0-9_]+):\s*(.+)$/.exec(line);
    if (!match) throw new Error(`${path}:${index + 1} 不是 "key: text" 形式：${line}`);
    table[match[1]] = match[2].trim();
  }
  return table;
}

/** `{{name}}` 严格替换：缺变量直接报错，避免半渲染的 prompt 偷偷上线。 */
export function renderTemplate(template: string, vars: Record<string, string>): string {
  return template.replace(/\{\{\s*([a-z0-9_]+)\s*\}\}/gi, (_all, name: string) => {
    if (!(name in vars)) throw new Error(`prompt 模板缺少变量：${name}`);
    return vars[name];
  });
}

/** 审查用：列出所有 prompt 文件、大小与 sha256。工具说明在 src/tools/<name>/TOOL.md，不在 prompt/ 下。 */
export function auditPrompts(root: string): { file: string; bytes: number; sha256: string }[] {
  const files = ["runtime.md", "persona.md", "ops.md", "handoff.md", "group-profile.md", "people.md", "messages.md"];
  const personasDir = join(root, "personas");
  if (existsSync(personasDir)) {
    for (const entry of readdirSync(personasDir).sort()) {
      if (entry.endsWith(".md")) files.push(join("personas", entry));
    }
  }
  return files.map((file) => {
    const path = join(root, file);
    const content = read(path);
    return {
      file: relative(root, path),
      bytes: Buffer.byteLength(content),
      sha256: createHash("sha256").update(content).digest("hex").slice(0, 12),
    };
  });
}
