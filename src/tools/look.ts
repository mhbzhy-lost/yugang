/**
 * look —— 看群里的一张图。
 *
 * 没有通用 read：只能看媒体目录里的图片，而且一轮最多两次。
 * 图是被 QQ 适配器落到 <mediaRoot>/inbound/ 的，进站文本里会带 inbound/xxx.png 这个引用。
 *
 * 图不进主会话：look 内部用独立请求让视觉模型把图描述成文字，只把描述返回给主会话，
 * 主会话 transcript 从头到尾都是纯文本（缓存前缀稳定，也不反复撞网关的视觉管线）。
 */
import { spawnSync } from "node:child_process";
import { existsSync, readFileSync, rmSync, unlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve, sep, extname } from "node:path";
import { Type, type Models } from "@earendil-works/pi-ai";
import { defineTool } from "@earendil-works/pi-durable";
import { renderTemplate, requireTool, type PromptSet } from "../prompts.ts";
import { ledgerOf, recordLook } from "../egress/ledger.ts";
import { describeImage } from "../media/describe.ts";

export interface LookDeps {
  mediaRoot: string;
  prompts: PromptSet;
  /** 模型池：用独立请求把图描述成文字，图片从一开始就不进主会话。 */
  models?: Models;
  /** 视觉描述用的模型：config/models.json 的 models.vision；省略时与 main 相同。 */
  visionModel?: { provider: string; modelId: string };
  maxPerRun?: number;
}

/** 看图快捷开关：主人 /关看图 后置位（var/look-off.marker），重启保持；网关视觉管线不稳时止损用。 */
const LOOK_OFF_MARKER = join(process.cwd(), "var", "look-off.marker");
let lookDisabled = existsSync(LOOK_OFF_MARKER);
export function isLookDisabled(): boolean {
  return lookDisabled;
}
export function setLookDisabled(off: boolean): void {
  lookDisabled = off;
  try {
    if (off) writeFileSync(LOOK_OFF_MARKER, String(Date.now()));
    else rmSync(LOOK_OFF_MARKER, { force: true });
  } catch {
    /* 标记写不进去也不影响内存开关 */
  }
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
      if (lookDisabled) {
        return { output: [{ type: "text", text: deps.prompts.messages["look_cmd_off"] ?? "看图已关" }] };
      }
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
        throw new Error(renderTemplate(deps.prompts.messages["look_used"] ?? "{{limit}}", { limit: String(limit) }));
      }
      recordLook(api.conversationId);

      // 图不进主会话：独立请求让模型把图描述成文字，只返回描述。
      // 描述失败（网关视觉管线间歇不稳）也不退回原图块——那会让图永久留在 transcript，
      // 拖垮之后每一轮；宁可这次看不了，让模型告诉用户稍后再看。
      const described = await describeImage(deps, data, outMime);
      if (described) {
        return { output: [{ type: "text", text: described }] };
      }
      return { output: [{ type: "text", text: deps.prompts.messages["look_unstable"] ?? "看不了" }] };
    },
  });
}

/** 用一次性请求把图描述成文字：图片只在这里过一次视觉管线。 */

/** macOS sips 压缩：GIF 取首帧、超尺寸缩到 1280px，输出 JPEG；失败返回 null。 */
function shrink(file: string): Buffer | null {
  try {
    const out = `${tmpdir()}/look-shrink-${Date.now()}-${Math.random().toString(16).slice(2, 6)}.jpg`;
    const res = spawnSync("sips", ["-s", "format", "jpeg", "-s", "formatOptions", "70", "-Z", "1280", file, "--out", out], { timeout: 20_000 });
    if (res.status !== 0) return null;
    const buf = readFileSync(out);
    unlinkSync(out);
    return buf.length > 0 ? buf : null;
  } catch {
    return null;
  }
}
