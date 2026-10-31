/**
 * 工具注册表：能力扩展的唯一入口。
 *
 * 一个工具包 = src/tools/<name>/ 下的 TOOL.md + tool.ts，说明与参数 Schema 唯一来自
 * TOOL.md manifest，Node 实现不再有第二份运行时参数定义。发现、一一对应校验、
 * factory 注册与 eager/deferred 标记统一在 ./loader.ts；这里只是稳定的导入面。
 * 加一项能力 = src/tools/<name>/ 放 TOOL.md + tool.ts，并在 loader 的 factory 名单里加一行；
 * 没有 shell、没有通用文件读取、没有 MCP —— 模型只能调注册表里列出的函数。
 */
import type { ToolRegistration } from "@earendil-works/pi-durable";
import { loadToolSurface, type ToolSurface } from "./loader.ts";
import type { ToolPackageDeps } from "./types.ts";

export { loadToolSurface, type ToolSurface } from "./loader.ts";

/** 便捷入口：只拿注册对象（等价于 loadToolSurface(deps).tools）。 */
export async function createTools(deps: ToolPackageDeps): Promise<readonly ToolRegistration[]> {
  return (await loadToolSurface(deps)).tools;
}
