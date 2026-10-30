/**
 * gpt_image —— GPT Image 2 生图/改图，纯透传。
 *
 * 与 draw 分开：draw 只管本地 SD（快、免费、带画风预设）；这个工具只把模型的参数
 * 原样交给 ChatGPT/Codex 的图片后端，不做任何取舍或兜底，也不自动切换通道。
 *
 * 图的出口仍然是 say 的 media（一次一张），所以 n>1 时按列表返回、由 say 逐张发。
 */
import { readFileSync } from "node:fs";
import { extname, resolve, sep } from "node:path";
import { Type } from "@earendil-works/pi-ai";
import { defineTool } from "@earendil-works/pi-durable";
import { renderTemplate, requireTool, type PromptSet } from "../prompts.ts";
import { generateGptImages } from "../media/gpt-image.ts";

export interface GptImageToolDeps {
  prompts: PromptSet;
  mediaRoot: string;
  /** config/auth.json；缺省时工具直接报「没登录」，不做任何降级。 */
  authPath?: string;
  timeoutMs?: number;
  fetchImpl?: typeof fetch;
}

const MAX_REFERENCE_IMAGES = 5;
const MAX_REFERENCE_BYTES = 10 * 1024 * 1024;
const MIME: Record<string, string> = {
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".webp": "image/webp",
  ".gif": "image/gif",
};

export function createGptImageTool(deps: GptImageToolDeps) {
  const prompt = requireTool(deps.prompts, "gpt_image");
  const root = resolve(deps.mediaRoot);

  return defineTool({
    name: "gpt_image",
    description: prompt.description,
    callers: ["model"],
    parameters: Type.Object({
      prompt: Type.String({ description: prompt.params["prompt"] ?? "" }),
      model: Type.Optional(Type.String({ description: prompt.params["model"] ?? "" })),
      n: Type.Optional(Type.Integer({ minimum: 1, maximum: 10, description: prompt.params["n"] ?? "" })),
      size: Type.Optional(Type.String({ description: prompt.params["size"] ?? "" })),
      quality: Type.Optional(
        Type.Union(
          [Type.Literal("auto"), Type.Literal("low"), Type.Literal("medium"), Type.Literal("high"), Type.Literal("xhigh"), Type.Literal("max")],
          { description: prompt.params["quality"] ?? "" },
        ),
      ),
      background: Type.Optional(
        Type.Union([Type.Literal("auto"), Type.Literal("transparent"), Type.Literal("opaque")], {
          description: prompt.params["background"] ?? "",
        }),
      ),
      output_format: Type.Optional(
        Type.Union([Type.Literal("png"), Type.Literal("jpeg"), Type.Literal("webp")], { description: prompt.params["output_format"] ?? "" }),
      ),
      output_compression: Type.Optional(Type.Integer({ minimum: 0, maximum: 100, description: prompt.params["output_compression"] ?? "" })),
      moderation: Type.Optional(Type.Union([Type.Literal("auto"), Type.Literal("low")], { description: prompt.params["moderation"] ?? "" })),
      images: Type.Optional(
        Type.Array(Type.String(), {
          maxItems: MAX_REFERENCE_IMAGES,
          description: prompt.params["images"] ?? "",
        }),
      ),
    }),
    execute: async (args) => {
      const positive = args.prompt.trim();
      if (!positive || positive.length > 4000) {
        throw new Error(deps.prompts.messages["gpt_image_prompt"] ?? "gpt_image_prompt");
      }
      if (!deps.authPath) throw new Error(deps.prompts.messages["gpt_image_off"] ?? "gpt_image_off");

      // 参考图：只允许 mediaRoot 内的图片，读成 data URL 交给 edits 端点
      const references: string[] = [];
      for (const raw of args.images ?? []) {
        const ref = raw.trim().replace(/^\[|\]$/g, "");
        const full = resolve(root, ref);
        if (full !== root && !full.startsWith(root + sep)) {
          throw new Error(renderTemplate(deps.prompts.messages["gpt_image_bad_ref"] ?? "{{ref}}", { ref }));
        }
        const mime = MIME[extname(full).toLowerCase()];
        if (!mime) throw new Error(renderTemplate(deps.prompts.messages["gpt_image_bad_ref"] ?? "{{ref}}", { ref }));
        const bytes = readFileSync(full);
        if (bytes.length === 0 || bytes.length > MAX_REFERENCE_BYTES) {
          throw new Error(renderTemplate(deps.prompts.messages["gpt_image_bad_ref"] ?? "{{ref}}", { ref }));
        }
        references.push(`data:${mime};base64,${bytes.toString("base64")}`);
      }

      // 只有显式给了的字段才进请求体：没给就让后端用默认值，不替模型补
      const params: Record<string, unknown> = { prompt: positive };
      for (const key of ["model", "n", "size", "quality", "background", "output_format", "output_compression", "moderation"] as const) {
        const value = args[key];
        if (value !== undefined) params[key] = value;
      }

      const started = Date.now();
      const files = await generateGptImages({
        authPath: deps.authPath,
        prompt: positive,
        params,
        ...(references.length > 0 ? { images: references } : {}),
        mediaRoot: deps.mediaRoot,
        ...(deps.timeoutMs === undefined ? {} : { timeoutMs: deps.timeoutMs }),
        ...(deps.fetchImpl === undefined ? {} : { fetchImpl: deps.fetchImpl }),
      });
      console.log(`[fish] gpt_image ok: ${files.length} 张 / ${Date.now() - started}ms / ${positive.slice(0, 40)}`);

      return {
        output: [
          {
            type: "text",
            text: renderTemplate(deps.prompts.messages["gpt_image_done"] ?? "{{files}}", { files: files.join("、") }),
          },
        ],
      };
    },
  });
}
