/**
 * 工具注册表：能力扩展的唯一入口。
 *
 * 加一项能力 = 在这里加一个 createXxxTool()，再补一份 prompt/tools/xxx.md。
 * 没有 shell、没有文件读取、没有 MCP —— 模型只能调这里列出的函数。
 */
import type { ToolRegistration } from "@earendil-works/pi-durable";
import type { PromptSet } from "../prompts.ts";
import { createLookTool } from "./look.ts";
import { createSearchTool } from "./search.ts";

export interface ToolDeps {
  mediaRoot: string;
  prompts: PromptSet;
  /** DeepSeek Search API 的 key；有才具备联网搜索能力。 */
  searchKey?: string;
}

export function createTools(deps: ToolDeps): ToolRegistration[] {
  return [createLookTool(deps), createSearchTool({ prompts: deps.prompts, key: deps.searchKey })];
}
