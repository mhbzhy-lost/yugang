/**
 * meme 的跨模块共享 helper：表情包索引读取与一级情绪词库存统计。
 *
 * loadMemeIndex 本体在 src/media/meme-store.ts（生成数据的唯一读取口），这里按原 meme.ts
 * 的合同 re-export；countMoods 供 meme 工具与 harness 的 meme_tags section 使用。
 * meme/tool.ts 与 harness.ts 必须用同一份（都从这里导入），不得各写一份统计。
 */
import type { MemeEntry } from "../../media/meme-store.ts";

export { loadMemeIndex } from "../../media/meme-store.ts";

type Entry = MemeEntry;

/** 每个一级情绪词各有几张（给 prompt section 用，让鱼一眼看到库存）。 */
export function countMoods(entries: readonly Entry[], memeTags: readonly string[]): { mood: string; count: number }[] {
  return memeTags.map((mood) => ({
    mood,
    count: entries.filter((e) => e.tags.some((tag) => tag.toLowerCase() === mood.toLowerCase())).length,
  }));
}
