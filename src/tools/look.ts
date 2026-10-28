/**
 * look —— 看群里的一张图。
 *
 * 没有通用 read：只能看媒体目录里的图片，而且一轮最多两次。
 * 图是被 QQ 适配器落到 <mediaRoot>/inbound/ 的，进站文本里会带 inbound/xxx.png 这个引用。
 */
import { readFileSync } from "node:fs";
import { resolve, sep, extname } from "node:path";
import { Type } from "@earendil-works/pi-ai";
import { defineTool } from "@earendil-works/pi-durable";
import { renderTemplate, requireTool, type PromptSet } from "../prompts.ts";
import { ledgerOf, recordLook } from "../egress/ledger.ts";

export interface LookDeps {
  mediaRoot: string;
  prompts: PromptSet;
  maxPerRun?: number;
}

const MIME: Record<string, string> = {
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".gif": "image/gif",
  ".webp": "image/webp",
};

export function createLookTool(deps: LookDeps) {
  const root = resolve(deps.mediaRoot);
  const limit = deps.maxPerRun ?? 2;
  const prompt = requireTool(deps.prompts, "look");

  return defineTool({
    name: "look",
    description: prompt.description,
    callers: ["model"],
    parameters: Type.Object({
      ref: Type.String({ description: prompt.params["ref"] ?? "" }),
    }),
    execute: async (args, api) => {
      const ref = args.ref.trim().replace(/^\[|\]$/g, "");
      const full = resolve(root, ref);
      const outside = full !== root && !full.startsWith(root + sep);
      if (outside) throw new Error(renderTemplate(deps.prompts.messages["look_outside"] ?? "{{ref}}", { ref }));

      const mime = MIME[extname(full).toLowerCase()];
      if (!mime) throw new Error(renderTemplate(deps.prompts.messages["look_type"] ?? "{{ref}}", { ref }));

      let data: string;
      try {
        data = readFileSync(full).toString("base64");
      } catch {
        throw new Error(renderTemplate(deps.prompts.messages["look_missing"] ?? "{{ref}}", { ref }));
      }

      if (ledgerOf(api.conversationId).lookedThisRun >= limit) {
        throw new Error(deps.prompts.messages["look_used"] ?? "already looked");
      }
      recordLook(api.conversationId);

      return { output: [{ type: "image", data, mimeType: mime }] };
    },
  });
}
