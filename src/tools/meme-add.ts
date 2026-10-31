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
 *
 * 本地导入例外：ref 落在 meme-inbox/ 时，必须同时满足「主人触发」「当前轮 meme_import 清单里有这张」
 * 「这一轮真的 look 过这张」；动图的既有豁免只适用于 inbound/ 自动收图，
 * 不能用来绕开本地清单，也不能把其他目录的 gif 当成群图。
 */
import { extname, relative, resolve, sep } from "node:path";
import { Type } from "@earendil-works/pi-ai";
import { LiveDoc, defineTool } from "@earendil-works/pi-durable";
import { addMeme } from "../media/meme-store.ts";
import { DEFAULT_LIMITS } from "../egress/policy.ts";
import { memeImportHas, memeImportLooked } from "./meme-import.ts";
import { renderTemplate, requireTool, type PromptSet } from "../prompts.ts";

export interface MemeAddDeps {
  prompts: PromptSet;
  mediaRoot: string;
  master: string;
  triggerOf?: (roundId: unknown) => { messageId?: number | string; mentionsBot: boolean; userId?: number } | undefined;
  /** 单张上限：与出口的 maxMediaBytes 同一个数，缺省取出口默认值。 */
  maxBytes?: number;
}

export function createMemeAddTool(deps: MemeAddDeps) {
  const prompt = requireTool(deps.prompts, "meme_add");
  const root = resolve(deps.mediaRoot);
  const maxBytes = deps.maxBytes ?? DEFAULT_LIMITS.maxMediaBytes;

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
      const full = resolve(root, ref);
      // 越界先否掉，后面的目录判断只认真实的落点
      if (full !== root && !full.startsWith(root + sep)) {
        throw new Error(renderTemplate(deps.prompts.messages["meme_add_missing"] ?? "{{ref}}", { ref }));
      }
      const localRef = relative(root, full).split(sep).join("/");
      const inInbox = localRef.startsWith("meme-inbox/");
      const inInbound = localRef.startsWith("inbound/");
      const isGif = extname(full).toLowerCase() === ".gif";

      const live = await api.snapshot(LiveDoc, api.conversationId, context);
      const round = live?.run?.inputs?.[0];
      const roundId = round === undefined ? undefined : String(round);
      const trigger = round !== undefined ? deps.triggerOf?.(round) : undefined;
      const byMaster = deps.master !== "" && String(trigger?.userId ?? "") === deps.master;

      // 本地导入：主人 + 本轮 meme_import 清单 + 这一轮真的看过它，三条都要；动图豁免在这里不适用
      if (inInbox) {
        if (!byMaster) throw new Error(deps.prompts.messages["meme_add_master"] ?? "meme_add_master");
        if (roundId === undefined || !memeImportHas(roundId, localRef)) {
          throw new Error(
            renderTemplate(deps.prompts.messages["meme_add_import_outside"] ?? "{{ref}}", { ref: localRef }),
          );
        }
        if (!memeImportLooked(roundId, localRef)) {
          throw new Error(renderTemplate(deps.prompts.messages["meme_add_not_looked"] ?? "{{ref}}", { ref: localRef }));
        }
      } else {
        // 收录规则：动图（.gif）允许鱼自己判断入库——但只限群里来的 inbound/ 图；
        // 其他格式、以及其他目录的动图，都必须主人点头。
        if (!byMaster && !(isGif && inInbound)) {
          throw new Error(deps.prompts.messages["meme_add_master"] ?? "meme_add_master");
        }
      }

      const caption = args.caption.trim().slice(0, 60);
      if (!caption) throw new Error(deps.prompts.messages["meme_add_caption"] ?? "meme_add_caption");
      const tags = args.tags.map((t) => t.trim()).filter(Boolean).slice(0, 8);
      if (tags.length === 0) throw new Error(deps.prompts.messages["meme_add_caption"] ?? "meme_add_caption");
      // 一级情绪词：必须至少有一个，否则以后检索不到（自由词随便加，不强制用）
      const moods = deps.prompts.memeTags;
      if (moods.length > 0 && !tags.some((t) => moods.some((m) => m.toLowerCase() === t.toLowerCase()))) {
        throw new Error(
          renderTemplate(deps.prompts.messages["meme_add_mood"] ?? "{{moods}}", { moods: moods.join("、") }),
        );
      }

      const result = await addMeme({ mediaRoot: root, source: full, caption, tags, maxBytes });
      if (result.status === "rejected") {
        // 来源校验在库里再做了一次（lstat/realpath/大小/文件头）：拒绝理由逐个翻成文案
        const template =
          result.code === "link"
            ? deps.prompts.messages["meme_add_link"]
            : result.code === "big"
              ? deps.prompts.messages["meme_add_big"]
              : result.code === "magic"
                ? deps.prompts.messages["meme_add_magic"]
                : result.code === "type"
                  ? deps.prompts.messages["meme_add_type"]
                  : deps.prompts.messages["meme_add_missing"];
        throw new Error(renderTemplate(template ?? "{{ref}}", { ref: localRef }));
      }
      if (result.status === "duplicate") {
        return {
          output: [{ type: "text", text: renderTemplate(deps.prompts.messages["meme_add_dup"] ?? "", { file: result.entry.file }) }],
        };
      }

      console.log(`[鱼缸] meme_add ${result.entry.file} ${caption} [${tags.join(" ")}]`);
      return {
        output: [
          {
            type: "text",
            text: renderTemplate(deps.prompts.messages["meme_add_done"] ?? "memes/{{file}}", {
              file: result.entry.file,
              count: String(result.count),
            }),
          },
        ],
      };
    },
  });
}
