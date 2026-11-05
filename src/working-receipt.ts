/**
 * 重耗时工具的机械回执门（2026-11-05 主人反馈）。
 *
 * 「我去把这个视频翻出来看看，稍等」这类 working_* 文案是给**正在等的人**看的：
 * 有人 @ 你、私聊你、正经在问的时候，先回一句再干活是礼貌。
 * 但自由交流窗口、开窗积压注入、自己逛 B 站的主动轮里没人问，冒一句「稍等」看起来
 * 像和空气说话（现场：鱼在主动轮看完视频后，群里出现一条「正在把视频翻出来」）。
 *
 * 所以回执只在 answer 轮发；restart 例外（重启前必须告知，入口只有主人）。
 * 这里只做纯判定，宿主在 onLongWork 里消费；文案仍在 prompt/messages.md 的 working_*。
 */
import type { RoundKind } from "./tools/types.ts";

/** 这一轮的工具回执该不该发（缺省轮类型 = answer，legacy 轮语义不变）。 */
export function shouldSendWorkingReceipt(kind: RoundKind | undefined, tool: string): boolean {
  if (tool === "restart") return true;
  return (kind ?? "answer") === "answer";
}
