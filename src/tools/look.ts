/**
 * look —— 看群里的一张图。
 *
 * 没有通用 read：只能看媒体目录里的图片，而且一轮最多两次。
 * 图是被 QQ 适配器落到 <mediaRoot>/inbound/ 的，进站文本里会带 inbound/xxx.png 这个引用。
 *
 * 图不进主会话：look 内部用独立请求让视觉模型把图描述成文字，只把描述返回给主会话，
 * 主会话 transcript 从头到尾都是纯文本（缓存前缀稳定，也不反复撞网关的视觉管线）。
 */
import { readFileSync } from "node:fs";
import { resolve, sep, extname } from "node:path";
import { Type, type Models } from "@earendil-works/pi-ai";
import { defineTool } from "@earendil-works/pi-durable";
import { renderTemplate, requireTool, type PromptSet } from "../prompts.ts";
import { ledgerOf, recordLook } from "../egress/ledger.ts";

export interface LookDeps {
  mediaRoot: string;
  prompts: PromptSet;
  /** 模型池：用独立请求把图描述成文字，图片从一开始就不进主会话。 */
  models?: Models;
  /** 视觉描述用的模型；缺省用主模型自身（可看图），可经 VISION_PROVIDER/VISION_MODEL_ID 换专职视觉模型。 */
  visionModel?: { provider: string; modelId: string };
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

      // 图不进主会话：独立请求让模型把图描述成文字，只返回描述。
      // 描述失败时退回原图块（当轮可见，下轮起不再重发——但正常路径不应到这里）。
      const described = await describeImage(deps, data, outMime);
      if (described) {
        return { output: [{ type: "text", text: described }] };
      }
      return { output: [{ type: "image", data, mimeType: outMime }] };
    },
  });
}

/** 用一次性请求把图描述成文字：图片只在这里过一次视觉管线。 */
async function describeImage(
  deps: LookDeps,
  base64: string,
  mimeType: string,
): Promise<string | null> {
  if (!deps.models || !deps.visionModel) return null;
  try {
    const stream = deps.models.streamSimple(deps.visionModel, {
      messages: [
        {
          role: "user",
          content: [
            { type: "image", data: base64, mimeType },
            { type: "text", text: deps.prompts.messages["look_describe"] ?? "描述这张图" },
          ],
        },
      ],
    });
    const message = await stream.result();
    const text = message.content
      .filter((b): b is { type: "text"; text: string } => b.type === "text")
      .map((b) => b.text)
      .join("")
      .trim();
    return text || null;
  } catch {
    return null;
  }
}

/** macOS sips 压缩：GIF 取首帧、超尺寸缩到 1280px，输出 JPEG；失败返回 null。 */
function shrink(file: string): Buffer | null {
  try {
    const { spawnSync } = require("node:child_process") as typeof import("node:child_process");
    const { tmpdir } = require("node:os") as typeof import("node:os");
    const out = `${tmpdir()}/look-shrink-${Date.now()}-${Math.random().toString(16).slice(2, 6)}.jpg`;
    const res = spawnSync("sips", ["-s", "format", "jpeg", "-s", "formatOptions", "70", "-Z", "1280", file, "--out", out], { timeout: 20_000 });
    if (res.status !== 0) return null;
    const buf = require("node:fs").readFileSync(out) as Buffer;
    require("node:fs").unlinkSync(out);
    return buf.length > 0 ? buf : null;
  } catch {
    return null;
  }
}
