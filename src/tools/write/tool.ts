/**
 * write —— 整文件写入 /tmp/yugang 草稿区（新建或覆盖，仅主人）。
 *
 * 只能写 /tmp/yugang——仓库里的文件（含 config/models.json）写不进去，改仓库由专门的管理
 * 工具负责。内容超上限直接拒绝。路径围栏、封禁、审计与主人身份闸集中在 ../fs-shared.ts，
 * 这里不恢复任何 shell / MCP / 通用文件写入能力。
 *
 * 说明文字与参数 Schema 唯一来自 TOOL.md manifest（factory 只消费它，不再有第二份运行时定义）。
 */
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { defineTool, type ToolRegistration } from "@earendil-works/pi-durable";
import { manifestParameters, toolFullDescription } from "../manifest.ts";
import type { ToolManifest, ToolPackageDeps } from "../types.ts";
import { assertTriggeredByMaster, audited, ensureSandRoot, resolveWritable, WRITE_CAP } from "../fs-shared.ts";

/** args 静态类型：与 TOOL.md 的参数 Schema 一一对应；运行时 Schema 只有 manifest 这一份。 */
interface WriteArgs {
  path: string;
  content: string;
}

/** 主人闸是硬前提：无主人配置时 factory 返回 undefined，由注册方跳过（不进工具面）。 */
export function createWriteTool(manifest: ToolManifest, deps: ToolPackageDeps): ToolRegistration | undefined {
  if (!deps.master) return undefined;
  const p = deps.prompts;
  ensureSandRoot();

  return defineTool({
    name: manifest.name,
    description: toolFullDescription(manifest),
    callers: ["model"],
    parameters: manifestParameters<WriteArgs>(manifest),
    execute: async (args, api, context) => {
      await assertTriggeredByMaster(deps, api as never, context, p.messages["fs_locked"] ?? "fs_locked");
      const target = resolveWritable(args.path);
      if (!target) throw new Error(p.messages["fs_write_outside"] ?? "fs_write_outside");
      if (args.content.length > WRITE_CAP) throw new Error(p.messages["fs_too_big"] ?? "fs_too_big");
      const existed = existsSync(target.full);
      mkdirSync(dirname(target.full), { recursive: true });
      writeFileSync(target.full, args.content);
      audited("write", target.label, `${existed ? "overwrite" : "create"} ${args.content.length}c`);
      return { output: [{ type: "text", text: "ok" }] };
    },
  });
}
