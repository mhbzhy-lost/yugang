/**
 * read —— 读仓库或 /tmp/yugang 草稿区里的一个文件（仅主人）。
 *
 * 可读两个地方：仓库工作区，以及 /tmp/yugang（鱼的草稿区）。整文件受大小上限保护，
 * 大文件给 startLine / endLine 分段读。路径围栏、敏感目录封禁、二进制判定、审计与
 * 主人身份闸集中在 ../fs-shared.ts，这里不恢复任何 shell / MCP / 通用文件能力。
 *
 * 说明文字与参数 Schema 唯一来自 TOOL.md manifest（factory 只消费它，不再有第二份运行时定义）。
 */
import { readFileSync, statSync } from "node:fs";
import { extname, resolve } from "node:path";
import { defineTool, type ToolRegistration } from "@earendil-works/pi-durable";
import { manifestParameters, toolFullDescription } from "../manifest.ts";
import type { ToolManifest, ToolPackageDeps } from "../types.ts";
import { assertTriggeredByMaster, audited, BIN_EXT, ensureSandRoot, READ_CAP, resolveReadable } from "../fs-shared.ts";

/** args 静态类型：与 TOOL.md 的参数 Schema 一一对应；运行时 Schema 只有 manifest 这一份。 */
interface ReadArgs {
  path: string;
  startLine?: number;
  endLine?: number;
}

/** 主人闸是硬前提：无主人配置时 factory 返回 undefined，由注册方跳过（不进工具面）。 */
export function createReadTool(manifest: ToolManifest, deps: ToolPackageDeps): ToolRegistration | undefined {
  if (!deps.master) return undefined;
  const p = deps.prompts;
  ensureSandRoot();
  const root = resolve(process.cwd());

  return defineTool({
    name: manifest.name,
    description: toolFullDescription(manifest),
    callers: ["model"],
    parameters: manifestParameters<ReadArgs>(manifest),
    execute: async (args, api, context) => {
      await assertTriggeredByMaster(deps, api as never, context, p.messages["fs_locked"] ?? "fs_locked");
      const target = resolveReadable(root, args.path);
      if (!target) throw new Error(p.messages["fs_outside"] ?? "fs_outside");
      let st;
      try {
        st = statSync(target.full);
      } catch {
        throw new Error(p.messages["fs_missing"] ?? "fs_missing");
      }
      if (!st.isFile()) throw new Error(p.messages["fs_missing"] ?? "fs_missing");
      if (BIN_EXT.has(extname(target.full).toLowerCase())) throw new Error(p.messages["fs_binary"] ?? "fs_binary");

      const from = args.startLine !== undefined ? Math.max(1, Math.floor(args.startLine)) : undefined;
      const to = args.endLine !== undefined ? Math.max(1, Math.floor(args.endLine)) : undefined;

      // 不带行号：整文件，受大小上限保护；带行号：按行切片，大文件也能分段读
      if (from === undefined && to === undefined) {
        if (st.size > READ_CAP) throw new Error(p.messages["fs_too_big"] ?? "fs_too_big");
        audited("read", target.label, `${st.size}B`);
        return { output: [{ type: "text", text: readFileSync(target.full, "utf8") }] };
      }

      const lines = readFileSync(target.full, "utf8").split("\n");
      const start = (from ?? 1) - 1;
      const end = Math.min(lines.length, to ?? lines.length);
      if (start >= lines.length) throw new Error(p.messages["fs_missing"] ?? "fs_missing");
      const slice = lines.slice(start, Math.max(start + 1, end));
      const text = slice.map((line, i) => `${start + i + 1}\t${line}`).join("\n");
      audited("read", target.label, `${start + 1}-${start + slice.length}行`);
      return { output: [{ type: "text", text }] };
    },
  });
}
