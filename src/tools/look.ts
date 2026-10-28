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
      let outMime = mime;
      try {
        const bytes = readFileSync(full);
        // 大图压缩后再进上下文：进会话的内容一旦定下就不能变（动它会破坏前缀缓存），
        // 所以在读取时就压——GIF 取首帧、超尺寸缩到 1280px、一律 JPEG，单张控制在几十 KB。
        // 压缩件只用于观看，不回写原文件。
        if (bytes.length > 150_000) {
          const shrunk = shrink(full);
          if (shrunk) {
            data = shrunk.toString("base64");
            outMime = "image/jpeg";
          } else {
            data = bytes.toString("base64");
          }
        } else {
          data = bytes.toString("base64");
        }
      } catch {
        throw new Error(renderTemplate(deps.prompts.messages["look_missing"] ?? "{{ref}}", { ref }));
      }

      if (ledgerOf(api.conversationId).lookedThisRun >= limit) {
        throw new Error(deps.prompts.messages["look_used"] ?? "already looked");
      }
      recordLook(api.conversationId);

      return { output: [{ type: "image", data, mimeType: outMime }] };
    },
  });
}

/** macOS sips 压缩：GIF 取首帧、超尺寸缩到 1280px，输出 JPEG；失败返回 null。 */
function shrink(file: string): Buffer | null {
  try {
    const { spawnSync } = require("node:child_process") as typeof import("node:child_process");
    const { tmpdir } = require("node:os") as typeof import("node:os");
    const out = `${tmpdir()}/look-shrink-${Date.now()}-${Math.random().toString(16).slice(2, 6)}.jpg`;
    const res = spawnSync("sips", ["-s", "format", "jpeg", "-Z", "1280", file, "--out", out], { timeout: 20_000 });
    if (res.status !== 0) return null;
    const buf = require("node:fs").readFileSync(out) as Buffer;
    require("node:fs").unlinkSync(out);
    return buf.length > 0 ? buf : null;
  } catch {
    return null;
  }
}
