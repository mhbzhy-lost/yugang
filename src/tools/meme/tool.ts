/**
 * meme —— 从本地表情包库里挑图。
 *
 * 库是生成数据（<mediaRoot>/memes/ + index.json），由鱼用 meme_add 在对话里收录。
 *
 * 检索分两层（2026-10 改版）：
 *   一级：mood 必须是受控情绪词表里的词（prompt/meme-tags.md），精确命中
 *   二级：tags 可选，自由词做进一步筛选（能力给到，但不强制鱼使用）
 * 特殊分支：mood = "按标签"（TOOL.md 里与一级词并列的模型可见字面量，不属于
 *   prompt/meme-tags.md 词表）时跳过一级过滤，全库按 tags/caption 检索；
 *   tags 必须至少一个非空词，否则以 tool error（messages: meme_tag_required）拒绝。
 * 为什么这么改：库里 478 个自由 tag 里一半是画面描述（粉毛、猫耳），
 * 拿群聊话题（社保补缴、显卡）去子串匹配必然 0 命中。
 *
 * mood 的模型侧 Schema 唯一来自 TOOL.md manifest：anyOf 的词表分支（x-yugang-enum-from:
 * "memeTags"）在 manifest 加载时替换成当前一级词的 enum，「按标签」是静态 enum；
 * 这里不复制运行时词表。执行逻辑保留空库、字面兜底与每轮限一次的行为。索引读取与库存统计用 ./shared.ts。
 */
import { LiveDoc, defineTool, type ToolRegistration } from "@earendil-works/pi-durable";
import type { MemeEntry } from "../../media/meme-store.ts";
import { renderTemplate } from "../../prompts.ts";
import { manifestParameters, toolFullDescription } from "../manifest.ts";
import type { ToolManifest, ToolPackageDeps } from "../types.ts";
import { countMoods, loadMemeIndex } from "./shared.ts";

/** args 静态类型：与 TOOL.md 的参数 Schema 一一对应（mood 的 anyOf 两分支由 manifest 解析）。 */
interface MemeArgs {
  mood: string;
  tags?: string[];
}

const USED = new Map<string, unknown>();

export function createMemeTool(manifest: ToolManifest, deps: ToolPackageDeps): ToolRegistration {
  return defineTool({
    name: manifest.name,
    description: toolFullDescription(manifest),
    callers: ["model"],
    parameters: manifestParameters<MemeArgs>(manifest),
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
      // 特殊分支：目标不是情绪时按自由 tag 全库直搜（词表现编词已在 Schema 层拒掉）
      const byTag = mood === "按标签";
      if (byTag && extras.length === 0) {
        throw new Error(deps.prompts.messages["meme_tag_required"] ?? "按标签得带 tags");
      }

      let pool: MemeEntry[];
      let loose = false;
      if (byTag) {
        // 直接模式：不做一级情绪过滤，pool = 全部 entries
        pool = [...entries];
      } else {
        // 一级过滤：必须带这个情绪词
        pool = entries.filter((e) => e.tags.some((t) => t.toLowerCase() === mood));
        // 兜底：还没补标的存量条目（或这一档真没图）→ 退回按字面找一遍，
        // 别让一个没跑完的迁移把整个表情包功能变哑
        if (pool.length === 0) {
          pool = entries.filter(
            (e) =>
              e.tags.some((t) => t.toLowerCase().includes(mood)) || e.caption.toLowerCase().includes(mood),
          );
          loose = true;
          console.log("[鱼缸] meme loose match:", mood);
        }
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
        // 无命中：直接模式说 tags 没搜到，正常模式才说情绪档没图，别让两者混起来
        const text = byTag
          ? renderTemplate(deps.prompts.messages["meme_no_tag"] ?? "{{tags}}", {
              tags: (args.tags ?? []).map((t) => t.trim()).filter(Boolean).join("、"),
              inventory,
            })
          : renderTemplate(deps.prompts.messages["meme_no_mood"] ?? "{{mood}}", {
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
        .map((x) => `memes/${(x as { e: MemeEntry }).e.file} — ${(x as { e: MemeEntry }).e.caption}（${(x as { e: MemeEntry }).e.tags.join(" ")}）`)
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
