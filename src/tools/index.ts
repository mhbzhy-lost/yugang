/**
 * 工具注册表：能力扩展的唯一入口。
 *
 * 加一项能力 = 在这里加一个 createXxxTool()，再补一份 prompt/tools/xxx.md。
 * 没有 shell、没有脚本、没有 MCP —— 模型只能调这里列出的函数。
 */
import type { ToolRegistration } from "@earendil-works/pi-durable";
import type { PromptSet } from "../prompts.ts";
import { createDrawTool } from "./draw.ts";
import { createGuardedReadTool } from "./read.ts";

export interface ToolDeps {
  mediaRoot: string;
  workspaceRoot: string;
  prompts: PromptSet;
}

export function createTools(deps: ToolDeps): ToolRegistration[] {
  return [createGuardedReadTool(deps), createDrawTool(deps)];
}
