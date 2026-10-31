/**
 * tool_search 工具包 —— 按需找工具的中文检索。
 *
 * 为什么不用 pi-durable 自带的 createToolSearchTool：它按 [a-z0-9] 切词做 BM25，
 * 中文查询（「看图」「搜资料」「画图」）基本哑火。这里自定义实现：中文字/相邻二元词
 * 与 ASCII 词混合的确定性检索，字段权重 name > 顶部摘要 > Schema（参数名/参数说明/
 * 枚举值）> 正文指南；分数并列按 name 字典序，同一输入永远同一结果。
 *
 * 加载状态完全走 pi-durable 原生机制：候选只取 api.agent(context).deferred
 * （已经加载进当前请求的不重复返回），命中通过结果里的 control.addTools 交给宿主写
 * modelTools——下一次模型请求起才出现在工具列表里，本工具不自己保存任何状态，
 * 也不直接改 AgentDoc。
 *
 * 说明文字与参数 Schema 唯一来自 TOOL.md manifest；成功/空结果/空查询/非法 limit 的
 * 模型可见文案全部来自 prompt/messages.md。
 */
import { defineTool, type ToolRegistration } from "@earendil-works/pi-durable";
import { renderTemplate } from "../../prompts.ts";
import { manifestParameters, toolFullDescription } from "../manifest.ts";
import type { ToolManifest, ToolPackageDeps } from "../types.ts";

/** args 静态类型：与 TOOL.md 的参数 Schema 一一对应；运行时 Schema 只有 manifest 这一份。 */
interface ToolSearchArgs {
  query: string;
  limit?: number;
}

/** 不填 limit 时的默认上限；候选总共也就十几个，8 个足够一次看清。 */
export const TOOL_SEARCH_DEFAULT_LIMIT = 8;

/** 字段权重：工具名最重，顶部摘要次之，Schema（参数名/说明/枚举）再次，指南只作补充。 */
const WEIGHT_NAME = 10;
const WEIGHT_SUMMARY = 4;
const WEIGHT_SCHEMA = 2;
const WEIGHT_GUIDE = 1;

/** CJK 统一表意文字（含扩展 A 与兼容区），够覆盖词表与工具说明。 */
const CJK = /[\u3400-\u4dbf\u4e00-\u9fff\uf900-\ufaff]/;
/** ASCII 词字符：字母、数字、下划线（工具名的合法字符集）。 */
const WORD = /[A-Za-z0-9_]/;

/**
 * 确定性分词：ASCII 连续段整体成词（小写化），中文逐字成词并加相邻二元词；
 * 其它字符都是边界。同一文本永远切出同一组词，没有任何随机或时间因素。
 */
export function tokenize(text: string): string[] {
  const out: string[] = [];
  let word = "";
  let cjk: string[] = [];
  const flushWord = (): void => {
    if (word !== "") {
      out.push(word);
      word = "";
    }
  };
  const flushCjk = (): void => {
    for (let i = 0; i < cjk.length; i++) {
      out.push(cjk[i]!);
      if (i + 1 < cjk.length) out.push(cjk[i]! + cjk[i + 1]!);
    }
    cjk = [];
  };
  for (const ch of text) {
    if (CJK.test(ch)) {
      flushWord();
      cjk.push(ch);
    } else if (WORD.test(ch)) {
      flushCjk();
      word += ch.toLowerCase();
    } else {
      flushWord();
      flushCjk();
    }
  }
  flushWord();
  flushCjk();
  return out;
}

/**
 * 查询侧的虚词过滤（单字）：这些字在几乎每份说明里都出现，不携带意图；
 * 只影响查询分词，不影响字段索引。逐字写成短字面量，不构成 prompt 文案。
 */
const QUERY_STOPWORDS = new Set([
  "的", "了", "是", "在", "不", "有", "就", "都", "很", "个", "吗", "呢", "吧", "啊", "和", "与", "或", "也", "这", "那", "我", "你", "他", "它",
]);

/** 命中门槛：至少一个摘要级信号（或等价叠加）；纯虚词/指南级碎片不返回结果。 */
const MIN_SCORE = WEIGHT_SUMMARY;

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Schema 的可检索文本：属性名、属性说明、枚举值；递归进 items / anyOf / oneOf / allOf。 */
export function schemaSearchText(schema: unknown, parts: string[] = []): string[] {
  if (!isObject(schema)) return parts;
  if (typeof schema["description"] === "string") parts.push(schema["description"] as string);
  if (Array.isArray(schema["enum"])) {
    for (const value of schema["enum"]) if (typeof value === "string") parts.push(value);
  }
  const properties = schema["properties"];
  if (isObject(properties)) {
    for (const [name, property] of Object.entries(properties)) {
      parts.push(name);
      schemaSearchText(property, parts);
    }
  }
  if ("items" in schema) schemaSearchText(schema["items"], parts);
  for (const key of ["anyOf", "oneOf", "allOf"]) {
    const variants = schema[key];
    if (Array.isArray(variants)) for (const variant of variants) schemaSearchText(variant, parts);
  }
  return parts;
}

/** 注册用 description 是「顶部摘要 \n\n 正文指南」拼出来的；检索时把两段拆开，分别加权。 */
function summaryAndGuide(description: string): { summary: string; guide: string } {
  const split = description.indexOf("\n\n");
  return split < 0 ? { summary: description, guide: "" } : { summary: description.slice(0, split), guide: description.slice(split + 2) };
}

/** 一个查询词只吃一次最高字段权重：name 命中就不叠加摘要/指南的重复分。 */
export function scoreToolForTokens(queryTokens: readonly string[], tool: ToolRegistration): number {
  const name = String(tool.name ?? "");
  const { summary, guide } = summaryAndGuide(String(tool.description ?? ""));
  const fields: ReadonlyArray<readonly [ReadonlySet<string>, number]> = [
    [new Set([...tokenize(name), ...tokenize(name.replaceAll("_", " "))]), WEIGHT_NAME],
    [new Set(tokenize(summary)), WEIGHT_SUMMARY],
    [new Set(tokenize(schemaSearchText(tool.parameters).join(" "))), WEIGHT_SCHEMA],
    [new Set(tokenize(guide)), WEIGHT_GUIDE],
  ];
  let score = 0;
  for (const token of queryTokens) {
    let best = 0;
    for (const [tokens, weight] of fields) if (weight > best && tokens.has(token)) best = weight;
    score += best;
  }
  return score;
}

/**
 * 中文/英文混合检索：score 降序、name 字典序并列；确定性排序，不做任何随机。
 * 候选由调用方传入（execute 里只取当前会话的 deferred），这里只负责打分。
 */
export function searchToolNames(query: string, candidates: readonly ToolRegistration[], limit: number): string[] {
  const queryTokens = [...new Set(tokenize(query))].filter((token) => token.length > 1 || !QUERY_STOPWORDS.has(token));
  if (queryTokens.length === 0) return [];
  return candidates
    .map((tool) => ({ name: String(tool.name ?? ""), score: scoreToolForTokens(queryTokens, tool) }))
    .filter((entry) => entry.score >= MIN_SCORE)
    .sort((a, b) => (a.score !== b.score ? b.score - a.score : a.name < b.name ? -1 : a.name > b.name ? 1 : 0))
    .slice(0, limit)
    .map((entry) => entry.name);
}

/** tool_search 没有 config 依赖：只要 manifest 在就注册，保持 eager（loader 侧不打 deferred）。 */
export function createToolSearchTool(manifest: ToolManifest, deps: ToolPackageDeps): ToolRegistration {
  const messages = deps.prompts.messages;

  return defineTool({
    name: manifest.name,
    description: toolFullDescription(manifest),
    callers: ["model"],
    // 搜索只读不落库：中断重放安全
    replay: "safe",
    parameters: manifestParameters<ToolSearchArgs>(manifest),
    execute: async (args, api, context) => {
      const query = args.query.trim();
      if (query === "") throw new Error(messages["tool_search_empty"] ?? "tool_search_empty");
      const limit = args.limit ?? TOOL_SEARCH_DEFAULT_LIMIT;
      if (!Number.isInteger(limit) || limit <= 0) throw new Error(messages["tool_search_bad_limit"] ?? "tool_search_bad_limit");

      // 候选只取当前会话还没提供的 deferred 工具：已经加载的不会重复出现在结果里
      const candidates = (await api.agent(context)).deferred;
      const loaded = searchToolNames(query, candidates, limit);
      if (loaded.length === 0) {
        return { output: [{ type: "text", text: messages["tool_search_none"] ?? "tool_search_none" }] };
      }

      const header = renderTemplate(messages["tool_search_ok"] ?? "", { count: String(loaded.length) });
      const line = messages["tool_search_line"] ?? "{{name}}";
      const lines = loaded.map((name) => {
        const tool = candidates.find((candidate) => candidate.name === name);
        const summary = summaryAndGuide(String(tool?.description ?? "")).summary.trim();
        return renderTemplate(line, { name, summary });
      });
      const text = [header, ...lines].filter((part) => part.length > 0).join("\n");
      // 加载交给 pi-durable 原生状态机（写 modelTools.add）：下一次模型请求起才提供
      return { output: [{ type: "text", text }], details: { loaded }, control: { addTools: loaded } };
    },
  });
}
