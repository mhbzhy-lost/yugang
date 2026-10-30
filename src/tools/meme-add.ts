/**
 * meme_add —— 把一张图收进表情包库，标签由鱼自己在对话里打。
 *
 * 为什么不是离线批量打标：批量导入时视觉模型只看得到图，看不到谁发的、
 * 配了什么话、群里怎么接——信息最少的时候打标，检索又是关键词字面匹配，
 * 召回自然经常不搭。鱼在对话里判断「这张图想表达什么」时信息最全，
 * 让它当场写 caption + tags，库的质量才对得上它的理解。
 *
 * 隐私：只允许**主人**触发，且只收本轮消息里出现过的图（inbound/…）。
 * 群友随手发的截图不会被自动收进库。
 */
import { copyFileSync, existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { extname, join, resolve, sep } from "node:path";
import { Type } from "@earendil-works/pi-ai";
import { LiveDoc, defineTool } from "@earendil-works/pi-durable";
import { renderTemplate, requireTool, type PromptSet } from "../prompts.ts";

export interface MemeAddDeps {
  prompts: PromptSet;
  mediaRoot: string;
  master: string;
  triggerOf?: (roundId: unknown) => { messageId?: number | string; mentionsBot: boolean; userId?: number } | undefined;
}

const EXT = new Set([".jpg", ".jpeg", ".png", ".gif", ".webp"]);

interface Entry {
  file: string;
  md5: string;
  caption: string;
  tags: string[];
  at: number;
}

export function createMemeAddTool(deps: MemeAddDeps) {
  const prompt = requireTool(deps.prompts, "meme_add");
  const root = resolve(deps.mediaRoot);
  const memesDir = join(root, "memes");
  const indexUrl = join(memesDir, "index.json");

  const loadIndex = (): Entry[] => {
    if (!existsSync(indexUrl)) return [];
    try {
      return JSON.parse(readFileSync(indexUrl, "utf8")) as Entry[];
    } catch {
      return [];
    }
  };

  return defineTool({
    name: "meme_add",
    description: prompt.description,
    callers: ["model"],
    parameters: Type.Object({
      ref: Type.String({ description: prompt.params["ref"] ?? "" }),
      caption: Type.String({ description: prompt.params["caption"] ?? "" }),
      tags: Type.Array(Type.String(), { description: prompt.params["tags"] ?? "" }),
    }),
    execute: async (args, api, context) => {
      const ref = args.ref.trim().replace(/^\[|\]$/g, "");

      // 收录规则：动图（.gif）允许鱼自己判断入库；其他格式必须主人点头。
      // 截图/照片多为 png/jpg/heic，统一留在主人指定这一侧。
      const isGif = ref.toLowerCase().endsWith(".gif");
      const live = await api.snapshot(LiveDoc, api.conversationId, context);
      const round = live?.run?.inputs?.[0];
      const trigger = round !== undefined ? deps.triggerOf?.(round) : undefined;
      const byMaster = deps.master !== "" && String(trigger?.userId ?? "") === deps.master;
      if (!isGif && !byMaster) {
        throw new Error(deps.prompts.messages["meme_add_master"] ?? "meme_add_master");
      }
      const full = resolve(root, ref);
      if (!full.startsWith(root + sep) || !existsSync(full)) {
        throw new Error(renderTemplate(deps.prompts.messages["meme_add_missing"] ?? "{{ref}}", { ref }));
      }
      const ext = extname(full).toLowerCase();
      if (!EXT.has(ext) || !statSync(full).isFile()) {
        throw new Error(renderTemplate(deps.prompts.messages["meme_add_type"] ?? "{{ref}}", { ref }));
      }

      const caption = args.caption.trim().slice(0, 60);
      if (!caption) throw new Error(deps.prompts.messages["meme_add_caption"] ?? "meme_add_caption");
      const tags = args.tags.map((t) => t.trim()).filter(Boolean).slice(0, 8);
      if (tags.length === 0) throw new Error(deps.prompts.messages["meme_add_caption"] ?? "meme_add_caption");

      const bytes = readFileSync(full);
      const md5 = createHash("md5").update(bytes).digest("hex");
      const index = loadIndex();
      const existing = index.find((e) => e.md5 === md5);
      if (existing) {
        return {
          output: [{ type: "text", text: renderTemplate(deps.prompts.messages["meme_add_dup"] ?? "", { file: existing.file }) }],
        };
      }

      mkdirSync(memesDir, { recursive: true });
      const file = `${md5.slice(0, 10)}${ext}`;
      copyFileSync(full, join(memesDir, file));
      index.push({ file, md5, caption, tags, at: Date.now() });
      writeFileSync(indexUrl, `${JSON.stringify(index, null, 1)}\n`);

      console.log(`[鱼缸] meme_add ${file} ${caption} [${tags.join(" ")}]`);
      return {
        output: [
          {
            type: "text",
            text: renderTemplate(deps.prompts.messages["meme_add_done"] ?? "memes/{{file}}", {
              file,
              count: String(index.length),
            }),
          },
        ],
      };
    },
  });
}
