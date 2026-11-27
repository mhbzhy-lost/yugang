/**
 * 当轮 inline 图片生命周期管理：
 *  1. 重试去重：model_error 轮内重试在当前页已有已落盘输入时走 `type: "continue"`，
 *     避免把带 base64 图片的 user message 重复写进 transcript；仅在强制换页或 continue
 *     无法接续时回退 `type: "input"`。
 *  2. 当轮结算立刻剥离：整轮结束后通过 pi-durable 的 `ContextEdit`（`fish.image_strip`）
 *     仅替换本轮落盘的带图 user entry 为纯文本 messages，绝不触碰更早轮次以保全前置几十 k
 *     的 Prompt Cache；忙态入队后直接返回不阻塞等待，避免并发必答轮死锁。
 */
import type { Context } from "@earendil-works/chord/context";
import type { Message } from "@earendil-works/pi-ai";
import type { ContextEdit, Conversation, EntryId, SettledSubmissionRecord } from "@earendil-works/pi-durable";

export const IMAGE_STRIP_ENTRY_KIND = "fish.image_strip";

/**
 * 从一组 Message 中剥离所有 `type === "image"` 的内容块。
 * 始终新建 Message 对象（绝不原地修改 pi-durable 深冻结的 view.contributions）。
 */
export function stripImagesFromMessages(messages: readonly Message[]): { changed: boolean; messages: Message[] } {
  let changed = false;
  const next = messages.map((message) => {
    const content = (message as { content?: unknown }).content;
    if (!Array.isArray(content)) return message;
    const hasImage = content.some((block) => (block as { type?: unknown } | null)?.type === "image");
    if (!hasImage) return message;
    changed = true;
    const kept = content.filter((block) => (block as { type?: unknown } | null)?.type !== "image");
    const safeContent = kept.length > 0 ? kept : [{ type: "text" as const, text: "" }];
    return { ...message, content: safeContent } as Message;
  });
  return { changed, messages: next };
}

/**
 * 仅对本轮落盘且仍在活跃上下文中带有 image block 的 entry 写入一次 `fish.image_strip` edit。
 * - 基底取 `view.contributions[i]`，保证幂等（已剥离的不再重复写入）；
 * - 目标已因强制换页退出活跃页或无图时安静返回 0，绝不提交空 `edits: []`；
 * - 忙态下 write 进入 `pi.inbox` 排队（status === "queued"）时立刻返回，不 `wait()` 防死锁；
 * - `status === "unanswered"`（如 stale）返回 0。
 */
export async function stripRoundImages(
  conv: Conversation,
  entryIds: readonly EntryId[],
  context: Context,
): Promise<number> {
  const targets = new Set(entryIds);
  if (targets.size === 0) return 0;

  const view = await conv.context(context);
  const edits: ContextEdit[] = [];
  for (let i = 0; i < view.entries.length; i++) {
    const entry = view.entries[i];
    if (!targets.has(entry.id)) continue;
    const effective = view.contributions[i] ?? [];
    const stripped = stripImagesFromMessages(effective);
    if (!stripped.changed) continue;
    edits.push({ target: entry.id, action: "replace", messages: stripped.messages });
  }
  if (edits.length === 0) return 0;

  const sub = await conv.submit(
    {
      type: "write",
      entry: { kind: IMAGE_STRIP_ENTRY_KIND, edits },
    },
    context,
  );
  const rec = await sub.status(context);
  if (rec.status === "unanswered") return 0;
  return edits.length;
}

/** 轮内重试提交模式：当前活跃页已有本轮落盘输入时优先复用（continue），否则重新 input。 */
export function retrySubmissionMode(hasPlacedEntryOnCurrentPage: boolean): "continue" | "input" {
  return hasPlacedEntryOnCurrentPage ? "continue" : "input";
}

/** `continue` 结算返回 `nothing_to_answer` 时需回退到 `input` 重新提交。 */
export function shouldFallbackContinueToInput(result: SettledSubmissionRecord): boolean {
  return result.status === "unanswered" && (result as { reason?: string }).reason === "nothing_to_answer";
}
