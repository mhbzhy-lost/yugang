/**
 * tree —— 列出鱼缸的目录结构。
 *
 * 与 fs 工具组同规：主人身份闸（机械判 triggerOf userId）+ 目录围栏
 * （.git/node_modules/.trash/.pi 只显示名字不展开）。只读，输出限行。
 */
import { readdirSync, statSync } from "node:fs";
import { join, resolve, sep } from "node:path";
import { Type } from "@earendil-works/pi-ai";
import { LiveDoc, defineTool } from "@earendil-works/pi-durable";
import type { PromptSet } from "../prompts.ts";

export interface TreeDeps {
  prompts: PromptSet;
  root?: string;
  master: string;
  triggerOf?: (roundId: unknown) => { messageId?: number | string; mentionsBot: boolean; userId?: number } | undefined;
}

const SKIP_INTO = new Set([".git", "node_modules", ".trash", ".pi"]);
const MAX_LINES = 200;

export function createTreeTool(deps: TreeDeps) {
  const prompt = deps.prompts.tools["tree"];
  const root = resolve(deps.root ?? process.cwd());

  return defineTool({
    name: "tree",
    description: prompt.description,
    callers: ["model"],
    parameters: Type.Object({
      path: Type.Optional(Type.String({ description: prompt.params["path"] ?? "" })),
      depth: Type.Optional(Type.Number({ description: prompt.params["depth"] ?? "" })),
    }),
    execute: async (args, api, context) => {
      const live = await api.snapshot(LiveDoc, api.conversationId, context);
      const round = live?.run?.inputs?.[0];
      const trigger = round !== undefined ? deps.triggerOf?.(round) : undefined;
      if (!trigger || String(trigger.userId) !== deps.master) {
        throw new Error(deps.prompts.messages["fs_locked"] ?? "fs_locked");
      }

      const start = resolve(root, args.path ?? ".");
      if (start !== root && !start.startsWith(root + sep)) {
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
      console.log(`[fish] tree ${start.slice(root.length + 1) || "."} depth=${maxDepth} (${lines.length} lines)`);
      return { output: [{ type: "text", text: lines.join("\n") }] };
    },
  });
}
