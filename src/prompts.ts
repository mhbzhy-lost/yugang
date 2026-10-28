/**
 * 所有 prompt 都在 prompt/ 下的 markdown 里，代码里一个字都不内嵌。
 *
 * 这样做的代价是多一层加载和一堆「文件不存在就报错」的分支，
 * 换来的是：改一句话不需要读代码，审查时 diff 一眼能看出来。
 */
import { readFileSync, existsSync, readdirSync } from "node:fs";
import { join, relative } from "node:path";
import { createHash } from "node:crypto";

/** 工具说明 + 参数说明；正文部分是 description。 */
export interface ToolPrompt {
  description: string;
  params: Record<string, string>;
}

export interface PromptSet {
  root: string;
  persona: string;
  /** 上下文压缩用的备忘提示词，含 {{transcript}}。 */
  handoff: string;
  messages: Record<string, string>;
  /** key 是工具名，来自 prompt/tools/<name>.md 的文件名。 */
  tools: Record<string, ToolPrompt>;
}

export function loadPrompts(root: string): PromptSet {
  return {
    root,
    persona: read(join(root, "persona.md")),
    handoff: read(join(root, "handoff.md")),
    messages: parseMessageTable(read(join(root, "messages.md")), join(root, "messages.md")),
    tools: loadTools(join(root, "tools")),
  };
}

function loadTools(dir: string): Record<string, ToolPrompt> {
  if (!existsSync(dir)) throw new Error(`缺少 prompt 目录：${dir}`);
  const tools: Record<string, ToolPrompt> = {};
  for (const entry of readdirSync(dir)) {
    if (!entry.endsWith(".md")) continue;
    tools[entry.slice(0, -3)] = parseToolPrompt(read(join(dir, entry)));
  }
  if (Object.keys(tools).length === 0) throw new Error(`prompt/tools 里一个工具说明都没有：${dir}`);
  return tools;
}

function read(path: string): string {
  if (!existsSync(path)) throw new Error(`缺少 prompt 文件：${path}`);
  const text = readFileSync(path, "utf8").trim();
  if (text.length === 0) throw new Error(`prompt 文件是空的：${path}`);
  return text;
}

/**
 * 工具 prompt：可选 frontmatter 里的 `params:` 子块给参数写说明，正文是 description。
 */
export function parseToolPrompt(text: string): ToolPrompt {
  const match = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/.exec(text);
  if (!match) return { description: text.trim(), params: {} };

  const params: Record<string, string> = {};
  let inParams = false;
  for (const raw of match[1].split(/\r?\n/)) {
    if (/^params:\s*$/.test(raw)) {
      inParams = true;
      continue;
    }
    if (inParams) {
      const kv = /^\s+([A-Za-z0-9_-]+):\s*(.+)$/.exec(raw);
      if (kv) params[kv[1]] = kv[2].trim();
      else if (!/^\s+\S/.test(raw)) inParams = false;
    }
  }
  return { description: match[2].trim(), params };
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

/** 审查用：列出所有 prompt 文件、大小与 sha256。 */
export function auditPrompts(root: string): { file: string; bytes: number; sha256: string }[] {
  const files = ["persona.md", "handoff.md", "messages.md"];
  for (const entry of readdirSync(join(root, "tools")).sort()) {
    if (entry.endsWith(".md")) files.push(join("tools", entry));
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
