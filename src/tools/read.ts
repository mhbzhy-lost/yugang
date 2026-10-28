/**
 * read —— 唯一能接触到宿主文件系统的工具，所以要收口。
 *
 * pi-durable 自带的 read 能读任意绝对路径（/etc/passwd、~/.ssh/id_rsa 都行）。
 * 既然 bash 已经被拿掉，read 就成了那条「通往一切的边」，必须限制在
 * 本群工作目录与媒体目录之内。
 */
import { resolve, sep } from "node:path";
import { createReadTool } from "@earendil-works/pi-durable/tools";
import { renderTemplate, type PromptSet } from "../prompts.ts";

export interface ReadDeps {
  mediaRoot: string;
  workspaceRoot: string;
  prompts: PromptSet;
}

export function createGuardedReadTool(deps: ReadDeps) {
  const base = createReadTool();
  const roots = [resolve(deps.workspaceRoot), resolve(deps.mediaRoot)];

  return {
    ...base,
    description: deps.prompts.tools["read"]?.description ?? "",
    execute: async (args: { path: string; offset?: number; limit?: number }, api: any, context: any) => {
      const agent = await api.agent(context);
      const cwd = agent?.cwd ?? roots[0];
      const full = resolve(cwd, args.path);
      const allowed = roots.some((root) => full === root || full.startsWith(root + sep));

      if (!allowed) {
        const template = deps.prompts.messages["read_outside"] ?? "{{path}}";
        throw new Error(renderTemplate(template, { path: args.path }));
      }
      return base.execute(args as never, api, context);
    },
  };
}
