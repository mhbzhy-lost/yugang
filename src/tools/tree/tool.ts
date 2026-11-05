/**
 * tree —— 列出仓库或 /tmp/yugang 草稿区的目录结构（仅主人）。
 *
 * 与 fs 工具组同规：主人身份闸（机械判 triggerOf userId）+ 双根围栏（相对路径按仓库解析，
 * 绝对路径只认 /tmp/yugang；read / grep 同款）
 * （.git/node_modules/.trash/.pi 只显示名字不展开）。只读，输出限行；
 * 身份闸集中走 ../fs-shared.ts，这里不引入任何写入或 shell 能力。
 *
 * 说明文字与参数 Schema 唯一来自 TOOL.md manifest（factory 只消费它，不再有第二份运行时定义）。
 */
import { readdirSync } from "node:fs";
import { join, resolve, sep } from "node:path";
import { defineTool, type ToolRegistration } from "@earendil-works/pi-durable";
import { manifestParameters, toolFullDescription } from "../manifest.ts";
import type { ToolManifest, ToolPackageDeps } from "../types.ts";
import { assertTriggeredByMaster, fenceReadablePath, resolveReadable, SAND_ROOT } from "../fs-shared.ts";
import { REPO_ROOT } from "../../paths.ts";

/** args 静态类型：与 TOOL.md 的参数 Schema 一一对应；运行时 Schema 只有 manifest 这一份。 */
interface TreeArgs {
  path?: string;
  depth?: number;
}

const SKIP_INTO = new Set([".git", "node_modules", ".trash", ".pi"]);
const MAX_LINES = 200;

/** 主人闸是硬前提：无主人配置时 factory 返回 undefined，由注册方跳过（不进工具面）。 */
export function createTreeTool(manifest: ToolManifest, deps: ToolPackageDeps): ToolRegistration | undefined {
  if (!deps.master) return undefined;
  const root = REPO_ROOT;

  return defineTool({
    name: manifest.name,
    description: toolFullDescription(manifest),
    callers: ["model"],
    parameters: manifestParameters<TreeArgs>(manifest),
    execute: async (args, api, context) => {
      // 身份闸：机械判定，看本轮触发消息的 userId 是不是主人（与 fs 系列同源）
      await assertTriggeredByMaster(deps, api as never, context, deps.prompts.messages["fs_locked"] ?? "fs_locked");

      const resolved = resolveReadable(root, args.path ?? ".");
      if (!resolved) {
        throw new Error(deps.prompts.messages["fs_outside"] ?? "fs_outside");
      }
      const { full: start, label } = resolved;
      // 起点过符号链接围栏：目录链接逃逸不许整个 tree 落到仓库外；不存在的起点维持旧行为（空清单）
      const fenceRoot = start === SAND_ROOT || start.startsWith(SAND_ROOT + sep) ? SAND_ROOT : root;
      const fence = fenceReadablePath(fenceRoot, start);
      if (!fence.ok && fence.reason !== "missing") {
        if (fence.reason === "link") throw new Error(deps.prompts.messages["fs_link"] ?? "fs_link");
        throw new Error(deps.prompts.messages["fs_outside"] ?? "fs_outside");
      }
      const maxDepth = Math.min(Math.max(args.depth ?? 2, 1), 4);

      const lines: string[] = [];
      const walk = (dir: string, prefix: string, depth: number): void => {
        if (lines.length >= MAX_LINES) return;
        let entries;
        try {
          entries = readdirSync(dir, { withFileTypes: true });
        } catch {
          return;
        }
        entries.sort((a, b) => Number(b.isDirectory()) - Number(a.isDirectory()) || a.name.localeCompare(b.name));
        for (const e of entries) {
          if (lines.length >= MAX_LINES) {
            lines.push(`${prefix}…（超过 ${MAX_LINES} 行截断）`);
            return;
          }
          const child = join(dir, e.name);
          if (e.isDirectory()) {
            const pruned = SKIP_INTO.has(e.name);
            lines.push(`${prefix}${e.name}/${pruned ? " （不展开）" : ""}`);
            if (!pruned && depth > 1) walk(child, `${prefix}  `, depth - 1);
          } else {
            lines.push(`${prefix}${e.name}`);
          }
        }
      };

      lines.push(".");
      walk(start, "  ", maxDepth);
      console.log(`[fish] tree ${label} depth=${maxDepth} (${lines.length} lines)`);
      return { output: [{ type: "text", text: lines.join("\n") }] };
    },
  });
}
