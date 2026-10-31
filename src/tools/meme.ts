/**
 * meme —— 从本地表情包库里挑图。
 *
 * 库是生成数据（<mediaRoot>/memes/ + index.json），由鱼用 meme_add 在对话里收录。
 *
 * 检索分两层（2026-10 改版）：
 *   一级：mood 必须是受控情绪词表里的词（prompt/meme-tags.md），精确命中
 *   二级：tags 可选，自由词做进一步筛选（能力给到，但不强制鱼使用）
 * 为什么这么改：库里 478 个自由 tag 里一半是画面描述（粉毛、猫耳），
 * 拿群聊话题（社保补缴、显卡）去子串匹配必然 0 命中。
 */
import { Type } from "@earendil-works/pi-ai";
import { LiveDoc, defineTool } from "@earendil-works/pi-durable";
import { loadMemeIndex, type MemeEntry } from "../media/meme-store.ts";
import { renderTemplate, requireTool, type PromptSet } from "../prompts.ts";

export { loadMemeIndex };

export interface MemeDeps {
  prompts: PromptSet;
  mediaRoot: string;
}

type Entry = MemeEntry;

const USED = new Map<string, unknown>();

/** 每个一级情绪词各有几张（给 prompt section 用，让鱼一眼看到库存）。 */
export function countMoods(entries: readonly Entry[], memeTags: readonly string[]): { mood: string; count: number }[] {
  return memeTags.map((mood) => ({
    mood,
    count: entries.filter((e) => e.tags.some((tag) => tag.toLowerCase() === mood.toLowerCase())).length,
  }));
}

export function createMemeTool(deps: MemeDeps) {
  const prompt = requireTool(deps.prompts, "meme");
  const moods = deps.prompts.memeTags;

  return defineTool({
    name: "meme",
    description: prompt.description,
    callers: ["model"],
    parameters: Type.Object({
      // 一级情绪词：从词表生成字面量联合，模型只能选这些（机械校验，不靠自觉）
      mood: moods.length > 0 ? Type.Union(moods.map((m) => Type.Literal(m))) : Type.String(),
      tags: Type.Optional(
        Type.Array(Type.String(), {
          description: prompt.params["tags"] ?? "",
        }),
      ),
    }),
    execute: async (args, api, context) => {
      const entries = loadMemeIndex(deps.mediaRoot);
      if (entries.length === 0) {
        throw new Error(deps.prompts.messages["meme_empty"] ?? "表情包库是空的");
      }

      const live = await api.snapshot(LiveDoc, api.conversationId, context);
      const round = live?.run?.inputs?.[0];
      const markUsed = () => {
        if (round !== undefined) USED.set(api.conversationId, round);
      };

      const mood = String(args.mood ?? "").trim().toLowerCase();
      const extras = (args.tags ?? []).map((t) => t.trim().toLowerCase()).filter(Boolean);

      // 一级过滤：必须带这个情绪词
      let pool = entries.filter((e) => e.tags.some((t) => t.toLowerCase() === mood));
      // 兜底：还没补标的存量条目（或这一档真没图）→ 退回按字面找一遍，
      // 别让一个没跑完的迁移把整个表情包功能变哑
      let loose = false;
      if (pool.length === 0) {
        pool = entries.filter(
          (e) =>
            e.tags.some((t) => t.toLowerCase().includes(mood)) || e.caption.toLowerCase().includes(mood),
        );
        loose = true;
        console.log("[鱼缸] meme loose match:", mood);
      }
      // 二级过滤：可选，自由词命中越多排越前（能力给到，不强制）
      const scored = pool
        .map((e) => {
          let score = 0;
          for (const kw of extras) {
            if (e.tags.some((t) => {
              const tag = t.toLowerCase();
              return tag.includes(kw) || kw.includes(tag);
            })) {
              score += 1;
            } else if (e.caption.toLowerCase().includes(kw)) {
              score += 1;
            }
          }
          return { e, score };
        })
        .filter((x) => extras.length === 0 || x.score > 0)
        .sort((a, b) => b.score - a.score);

      if (scored.length === 0) {
        const inventory = countMoods(entries, deps.prompts.memeTags)
          .filter((x) => x.count > 0)
          .map((x) => `${x.mood}(${x.count})`)
          .join("、");
        const text = renderTemplate(deps.prompts.messages["meme_no_mood"] ?? "{{mood}}", {
          mood: String(args.mood ?? ""),
          inventory,
        });
        return { output: [{ type: "text", text }] };
      }

      if (round !== undefined && USED.get(api.conversationId) === round) {
        throw new Error(deps.prompts.messages["meme_used"] ?? "这一轮挑过了");
      }
      markUsed();

      // 同分打散：别每次都推同一张
      const top = scored[0]?.score ?? 0;
      const ties = scored.filter((x) => x.score === top);
      const head = ties[Math.floor(Math.random() * ties.length)];
      const picked = [head, ...scored.filter((x) => x !== head)].slice(0, 3).filter(Boolean);
      const text = picked
        .map((x) => `memes/${(x as { e: Entry }).e.file} — ${(x as { e: Entry }).e.caption}（${(x as { e: Entry }).e.tags.join(" ")}）`)
        .join("\n");
      return {
        output: [
          {
            type: "text",
            text: renderTemplate(deps.prompts.messages["meme_pick"] ?? "{{list}}", { list: text }),
          },
        ],
      };
    },
  });
}
