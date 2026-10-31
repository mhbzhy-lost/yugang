/**
 * tool_catalog section 的渲染器：当前已启用工具的「name + TOOL.md 顶部摘要」清单。
 *
 * 只输出这两样——不注入 JSON Schema、正文指南、路径、权限实现细节或任何工具结果；
 * 「目录只用于发现、未加载的工具要先搜先加载」的行为说明在 prompt/runtime.md，
 * 这里不内嵌提示词。顺序固定按工具名排序（loader 已排好），输入只来自启动期
 * manifest（trusted），不读用户消息。header/行格式来自 prompt/messages.md。
 */
import { renderTemplate } from "../prompts.ts";
import type { ToolManifest } from "./types.ts";

/**
 * 渲染工具目录。manifests 必须是「当前已启用」工具的 manifest 子集（loader 产出的
 * surface.manifests）：主人工具未启用时不在这里出现，普通工具依赖闸关掉的也一样。
 */
export function renderToolCatalog(manifests: readonly ToolManifest[], messages: Record<string, string>): string {
  const header = messages["tool_catalog_header"] ?? "";
  const line = messages["tool_catalog_line"] ?? "{{name}}";
  const rows = manifests.map((manifest) => renderTemplate(line, { name: manifest.name, summary: manifest.description }));
  return [header, ...rows].filter((part) => part.length > 0).join("\n");
}
