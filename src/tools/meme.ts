/**
 * meme —— 从本地表情包库里挑图。
 *
 * 库是生成数据（<mediaRoot>/memes/ + index.json，由 npm run memes import 维护）。
 * 这里只做检索：关键词命中标签或描述，返回最多三张的引用，
 * 真正发图仍走 say 的 media 参数（出口唯一）。一轮最多挑一次。
 */
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { Type } from "@earendil-works/pi-ai";
import { LiveDoc, defineTool } from "@earendil-works/pi-durable";
import { requireTool, type PromptSet } from "../prompts.ts";

export interface MemeDeps {
  prompts: PromptSet;
  mediaRoot: string;
}

interface Entry {
  file: string;
  caption: string;
  tags: string[];
}

const USED = new Map<string, unknown>();
let cache: { at: number; entries: Entry[] } | null = null;

export function createMemeTool(deps: MemeDeps) {
  const prompt = requireTool(deps.prompts, "meme");
  const indexUrl = join(deps.mediaRoot, "memes", "index.json");

  function load(): Entry[] {
    if (!existsSync(indexUrl)) return [];
    try {
      const parsed = JSON.parse(readFileSync(indexUrl, "utf8")) as Entry[];
      const at = Date.now();
      if (!cache || at - cache.at > 60_000) cache = { at, entries: parsed };
      return cache.entries;
    } catch {
      return cache?.entries ?? [];
    }
  }

  return defineTool({
    name: "meme",
    description: prompt.description,
    callers: ["model"],
    parameters: Type.Object({
      keyword: Type.String({ description: prompt.params["keyword"] ?? "" }),
    }),
    execute: async (args, api, context) => {
      const entries = load();
      if (entries.length === 0) {
        throw new Error(deps.prompts.messages["meme_empty"] ?? "表情包库是空的");
      }

      const live = await api.snapshot(LiveDoc, api.conversationId, context);
      const round = live?.run?.inputs?.[0];
      const markUsed = () => {
        if (round !== undefined) USED.set(api.conversationId, round);
      };

      const kw = args.keyword.trim().toLowerCase();
      const scored = entries
        .map((e) => {
          const tagHit = e.tags.some((t) => t.toLowerCase().includes(kw) || kw.includes(t.toLowerCase()));
          const capHit = e.caption.toLowerCase().includes(kw);
          return { e, score: tagHit ? 2 : capHit ? 1 : 0 };
        })
        .filter((x) => x.score > 0)
        .sort((a, b) => b.score - a.score)
        .slice(0, 3);

      if (scored.length === 0) {
        const vocab = [...new Set(entries.flatMap((e) => e.tags))].slice(0, 24).join("、");
        return { output: [{ type: "text", text: `没贴题的。库里现有主题：${vocab}` }] };
      }
      // 拿到真候选才算数：没贴题的尝试不消耗本轮机会，模型可以换词重试
      if (round !== undefined && USED.get(api.conversationId) === round) {
        throw new Error(deps.prompts.messages["meme_used"] ?? "这一轮挑过了");
      }
      markUsed();
      const text = scored
        .map((x) => `memes/${x.e.file} — ${x.e.caption}（${x.e.tags.join(" ")}）`)
        .join("\n");
      return { output: [{ type: "text", text: `${text}\n用 say 的 media 参数（memes/ 开头的引用）把最贴的那张发出去` }] };
    },
  });
}
