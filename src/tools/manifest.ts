/**
 * TOOL.md 严格解析器。
 *
 * 固定格式（解析器不接受近似写法）：
 *   ---\nname: <snake_case>\ndescription: <摘要>\n---        ← frontmatter，只认 name/description
 *   ---tool-schema\n{ ...严格 JSON... }\n---end-tool-schema   ← parameters 是唯一顶层键
 *   <非空正文>                                                ← 使用指南，注册时拼进 description
 *
 * 校验全部在解析期机械判定：未知/重复 frontmatter 字段、空字段、非法 JSON（注释、尾逗号、
 * 重复 key）、缺 parameters、保留的 x-yugang-* 扩展、远程 $ref、空指南一律报错。
 * 唯一受控的动态扩展是 x-yugang-enum-from: "memeTags"：解析期只验合同，loadToolManifests
 * 按调用方传入的词表替换成 enum，除此之外没有任何运行时改写模型所见 Schema 的通道。
 */
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { Type, type TSchema } from "@earendil-works/pi-ai";
import type { TUnsafe } from "typebox";
import { ENUM_FROM_KEY, type ManifestLoadContext, type ToolManifest, type ToolParametersSchema } from "./types.ts";

/** 工具名约束：现有下划线命名，如 gpt_image、meme_add、tool_search。 */
export const TOOL_NAME_PATTERN = /^[a-z][a-z0-9_]*$/;

const MAX_NAME_LENGTH = 64;

/** JSON 的双引号、单引号、反斜杠：用 charCode 比较，源码里不出现裸引号字符。 */
const DQ = 0x22;
const SQ = 0x27;
const BACKSLASH = 0x5c;
const SOLIDUS = 0x2f;
const LOWER_U = 0x75;

/** manifest 解析失败：path + 行号 + 短诊断；调用方不做任何兜底。 */
export class ManifestError extends Error {
  readonly path: string;
  readonly line: number | undefined;
  constructor(path: string, line: number | undefined, message: string) {
    super(path + (line === undefined ? "" : ":" + line) + "：" + message);
    this.name = "ManifestError";
    this.path = path;
    this.line = line;
  }
}

function fail(path: string, line: number | undefined, message: string): never {
  throw new ManifestError(path, line, message);
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * 解析一份 TOOL.md 文本。动态词表扩展（x-yugang-enum-from）在这里只做合同校验，
 * 真正替换成 enum 由 loadToolManifests 按调用方传入的 context 完成。
 */
export function parseToolManifest(text: string, path: string): ToolManifest {
  const lines = text.split(/\r?\n/);
  if (lines[0]?.trim() !== "---") fail(path, 1, "缺少 frontmatter");

  let close = -1;
  for (let i = 1; i < lines.length; i++) {
    if (lines[i].trim() === "---") {
      close = i;
      break;
    }
  }
  if (close === -1) fail(path, undefined, "frontmatter 未闭合");

  const fields = new Map<string, { value: string; line: number }>();
  for (let i = 1; i < close; i++) {
    const line = lines[i];
    if (line.trim() === "") continue;
    const match = /^([A-Za-z][A-Za-z0-9_-]*):(.*)$/.exec(line);
    if (!match) fail(path, i + 1, "frontmatter 行不是 key: value");
    const key = match[1];
    const value = match[2].trim();
    if (fields.has(key)) fail(path, i + 1, `重复的 frontmatter 字段：${key}`);
    if (key !== "name" && key !== "description") fail(path, i + 1, `未知的 frontmatter 字段：${key}`);
    if (value === "") fail(path, i + 1, `frontmatter 字段为空：${key}`);
    const first = value.charCodeAt(0);
    if (first === DQ || first === SQ) fail(path, i + 1, "frontmatter 值不要加引号");
    fields.set(key, { value, line: i + 1 });
  }
  if (!fields.has("name")) fail(path, undefined, "frontmatter 缺少 name");
  if (!fields.has("description")) fail(path, undefined, "frontmatter 缺少 description");

  const nameField = fields.get("name")!;
  if (nameField.value.length > MAX_NAME_LENGTH) fail(path, nameField.line, "工具名过长");
  if (!TOOL_NAME_PATTERN.test(nameField.value)) fail(path, nameField.line, "工具名必须是 snake_case");

  let i = close + 1;
  while (i < lines.length && lines[i].trim() === "") i++;
  if (i >= lines.length) fail(path, undefined, "缺少 ---tool-schema 块");
  if (lines[i].trim() !== "---tool-schema") fail(path, i + 1, "frontmatter 后必须是 ---tool-schema");

  let end = -1;
  for (let j = i + 1; j < lines.length; j++) {
    if (lines[j].trim() === "---end-tool-schema") {
      end = j;
      break;
    }
  }
  if (end === -1) fail(path, undefined, "---end-tool-schema 未闭合");

  const schema = parseStrictJson(lines.slice(i + 1, end).join("\n"), path, i + 2);
  const parameters = validateSchema(schema, path, i + 2);

  for (let j = end + 1; j < lines.length; j++) {
    const trimmed = lines[j].trim();
    if (trimmed === "---tool-schema" || trimmed === "---end-tool-schema") fail(path, j + 1, "重复的 schema 块");
  }
  const guide = lines.slice(end + 1).join("\n").trim();
  if (guide === "") fail(path, undefined, "正文指南为空");

  return { name: nameField.value, description: fields.get("description")!.value, guide, parameters, path };
}

/**
 * 扫描 root 下的 <name>/TOOL.md：目录缺 manifest、manifest name 与目录名不一致、
 * 重复 manifest name 一律失败。返回以工具名为键的 manifest 表。
 */
export function loadToolManifests(root: string, context: ManifestLoadContext): Map<string, ToolManifest> {
  if (!existsSync(root)) fail(root, undefined, "工具目录不存在");
  const manifests = new Map<string, ToolManifest>();
  const entries = readdirSync(root, { withFileTypes: true }).sort((a, b) => (a.name < b.name ? -1 : 1));
  let sawPackage = false;
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    sawPackage = true;
    const file = join(root, entry.name, "TOOL.md");
    if (!existsSync(file)) fail(file, undefined, "目录缺少 TOOL.md");
    const manifest = parseToolManifest(readFileSync(file, "utf8"), file);
    if (manifest.name !== entry.name) {
      fail(file, undefined, `manifest name 与目录名不一致：${manifest.name} != ${entry.name}`);
    }
    applyDynamicEnums(manifest.parameters, context);
    if (manifests.has(manifest.name)) fail(file, undefined, `重复的工具 manifest：${manifest.name}`);
    manifests.set(manifest.name, manifest);
  }
  if (!sawPackage) fail(root, undefined, "工具目录里没有工具包");
  return manifests;
}

/** 注册用完整 description：顶部摘要、空行、正文指南。 */
export function toolFullDescription(manifest: ToolManifest): string {
  return [manifest.description, manifest.guide].join("\n\n");
}

/** 把 manifest 的对象 Schema 标注成 args 静态类型；运行时是同一个对象，不再有第二份参数定义。 */
export function manifestParameters<T>(manifest: ToolManifest): TUnsafe<T> {
  return Type.Unsafe<T>(manifest.parameters as unknown as TSchema);
}

/** 唯一受控的动态扩展：x-yugang-enum-from: "memeTags" → 当前词表的 enum；空词表退化为普通字符串。 */
function applyDynamicEnums(node: unknown, context: ManifestLoadContext): void {
  if (Array.isArray(node)) {
    for (const item of node) applyDynamicEnums(item, context);
    return;
  }
  if (!isPlainObject(node)) return;
  if (ENUM_FROM_KEY in node) {
    if (context.memeTags.length > 0) node["enum"] = [...context.memeTags];
    else node["type"] = "string";
    delete node[ENUM_FROM_KEY];
  }
  for (const value of Object.values(node)) applyDynamicEnums(value, context);
}

/** Schema 结构合同：顶层只认 parameters；parameters 是对象参数 Schema。 */
function validateSchema(schema: unknown, path: string, baseLine: number): ToolParametersSchema {
  if (!isPlainObject(schema)) fail(path, baseLine, "schema 顶层必须是 JSON 对象");
  const keys = Object.keys(schema);
  if (!keys.includes("parameters")) fail(path, baseLine, "schema 缺少 parameters");
  for (const key of keys) {
    if (key !== "parameters") fail(path, baseLine, `schema 未知的顶层字段：${key}`);
  }
  const parameters = schema["parameters"];
  if (!isPlainObject(parameters)) fail(path, baseLine, "parameters 必须是对象 Schema");
  if (parameters["type"] !== "object") fail(path, baseLine, "parameters.type 必须是 object");
  checkSchemaNode(parameters, path, baseLine);
  return parameters as ToolParametersSchema;
}

/** 逐节点检查：远程 $ref、保留的 x-yugang-* 扩展、required/properties/additionalProperties 形状。 */
function checkSchemaNode(node: unknown, path: string, baseLine: number): void {
  if (Array.isArray(node)) {
    for (const item of node) checkSchemaNode(item, path, baseLine);
    return;
  }
  if (!isPlainObject(node)) return;
  for (const [key, value] of Object.entries(node)) {
    if (key === "$ref") {
      if (typeof value === "string" && !value.startsWith("#")) fail(path, baseLine, "不允许远程 $ref");
    } else if (key === ENUM_FROM_KEY) {
      if (value !== "memeTags") fail(path, baseLine, "不支持的动态词表");
      if ("enum" in node) fail(path, baseLine, "enum 与 x-yugang-enum-from 不能同时出现");
    } else if (key.startsWith("x-yugang-")) {
      fail(path, baseLine, `保留的扩展字段：${key}`);
    } else if (key === "required") {
      if (!Array.isArray(value) || value.length === 0 || value.some((item) => typeof item !== "string" || item === "")) {
        fail(path, baseLine, "required 必须是非空字符串数组");
      }
      if (new Set(value as string[]).size !== value.length) fail(path, baseLine, "required 有重复项");
      const properties = node["properties"];
      if (!isPlainObject(properties)) fail(path, baseLine, "required 必须配合 properties");
      else {
        const missing = (value as string[]).find((item) => !(item in properties));
        if (missing !== undefined) fail(path, baseLine, `required 引用了未声明的属性：${missing}`);
      }
    } else if (key === "properties") {
      if (!isPlainObject(value)) {
        fail(path, baseLine, "properties 必须是对象");
      } else {
        for (const [prop, propSchema] of Object.entries(value)) {
          if (!isPlainObject(propSchema)) fail(path, baseLine, `属性 ${prop} 的 Schema 必须是对象`);
        }
      }
    } else if (key === "additionalProperties") {
      if (typeof value !== "boolean" && !isPlainObject(value)) fail(path, baseLine, "additionalProperties 必须是布尔或对象");
    }
  }
  for (const value of Object.values(node)) {
    if (isPlainObject(value) || Array.isArray(value)) checkSchemaNode(value, path, baseLine);
  }
}

/** 严格 JSON：拒绝注释、尾逗号、重复 key、裸控制字符；诊断带文件内绝对行号。 */
function parseStrictJson(text: string, path: string, baseLine: number): unknown {
  let i = 0;
  let line = baseLine;

  function failAt(message: string): never {
    fail(path, line, message);
  }
  const advance = (n = 1): void => {
    for (let k = 0; k < n && i < text.length; k++) {
      if (text[i] === "\n") line++;
      i++;
    }
  };
  const peek = (): string => text[i];

  function skipWs(): void {
    while (i < text.length) {
      const ch = peek();
      if (ch === " " || ch === "\t" || ch === "\n" || ch === "\r") advance();
      else if (ch === "/" && (text[i + 1] === "/" || text[i + 1] === "*")) failAt("JSON 里不允许注释");
      else break;
    }
  }

  function parseString(): string {
    advance(); // 开头引号
    const start = i;
    for (;;) {
      if (i >= text.length) failAt("字符串未闭合");
      const code = text.charCodeAt(i);
      if (code === DQ) {
        const raw = text.slice(start, i);
        advance();
        return JSON.parse(`"${raw}"`) as string;
      }
      if (code === BACKSLASH) {
        if (i + 1 >= text.length) failAt("字符串未闭合");
        const esc = text.charCodeAt(i + 1);
        if (esc === DQ || esc === BACKSLASH || esc === SOLIDUS || "bfnrt".includes(text[i + 1])) advance(2);
        else if (esc === LOWER_U) {
          if (!/^[0-9a-fA-F]{4}$/.test(text.slice(i + 2, i + 6))) failAt("非法 unicode 转义");
          advance(6);
        } else failAt("非法转义字符");
      } else if (code < 0x20) failAt("字符串里有控制字符");
      else advance();
    }
  }

  function parseObject(): Record<string, unknown> {
    advance();
    const obj: Record<string, unknown> = {};
    const seen = new Set<string>();
    skipWs();
    if (peek() === "}") {
      advance();
      return obj;
    }
    for (;;) {
      skipWs();
      if (text.charCodeAt(i) !== DQ) failAt("对象 key 必须是字符串");
      const key = parseString();
      if (key === "__proto__") failAt("对象 key 不能是 __proto__");
      skipWs();
      if (peek() !== ":") failAt("对象缺少 :");
      advance();
      skipWs();
      if (seen.has(key)) failAt(`重复 key：${key}`);
      seen.add(key);
      obj[key] = parseValue();
      skipWs();
      if (peek() === ",") {
        advance();
        skipWs();
        if (peek() === "}") failAt("JSON 不允许尾逗号");
        continue;
      }
      if (peek() === "}") {
        advance();
        return obj;
      }
      failAt("缺少 , 或 }");
    }
  }

  function parseArray(): unknown[] {
    advance();
    const arr: unknown[] = [];
    skipWs();
    if (peek() === "]") {
      advance();
      return arr;
    }
    for (;;) {
      arr.push(parseValue());
      skipWs();
      if (peek() === ",") {
        advance();
        skipWs();
        if (peek() === "]") failAt("JSON 不允许尾逗号");
        continue;
      }
      if (peek() === "]") {
        advance();
        return arr;
      }
      failAt("数组缺少 , 或 ]");
    }
  }

  function parseValue(): unknown {
    skipWs();
    const ch = peek();
    if (ch === undefined) failAt("JSON 是空的");
    if (ch === "{") return parseObject();
    if (ch === "[") return parseArray();
    if (ch === `"`) return parseString();
    if (ch === "t" && text.startsWith("true", i)) {
      advance(4);
      return true;
    }
    if (ch === "f" && text.startsWith("false", i)) {
      advance(5);
      return false;
    }
    if (ch === "n" && text.startsWith("null", i)) {
      advance(4);
      return null;
    }
    if (ch === "-" || (ch >= "0" && ch <= "9")) {
      const match = /^-?(?:0|[1-9][0-9]*)(?:\.[0-9]+)?(?:[eE][+-]?[0-9]+)?/.exec(text.slice(i));
      if (match === null) failAt("非法数字");
      advance(match[0].length);
      return Number(match[0]);
    }
    failAt("非法 JSON");
  }

  const value = parseValue();
  skipWs();
  if (i !== text.length) failAt("JSON 结束后有多余内容");
  return value;
}
