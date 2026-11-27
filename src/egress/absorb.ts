/**
 * 把 transcript 里的「秘密」喂给溯源校验。
 *
 * 秘密 = assistant 的 thinking block + 所有 tool 结果文本。
 * 这些内容永远不出境，但模型可能把它们抄进出口工具的 text 里，所以要留下来对照。
 */
import type { Conversation } from "@earendil-works/pi-durable";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { rememberSecrets } from "./ledger.ts";

const SECRET_TEXT_CAP = 4000;
const seen = new Map<string, { headId: unknown; count: number }>();

export function recordTurnSecret(conversationId: string | number, text: string): void {
  const clipped = text.length > SECRET_TEXT_CAP ? text.slice(0, SECRET_TEXT_CAP) : text;
  if (clipped.trim().length === 0) return;
  rememberSecrets(conversationId as string, [clipped]);
}

export async function absorbSecrets(conversation: Conversation, clearAfter = false): Promise<void> {
  const view = await conversation.context(BACKGROUND_CONTEXT);
  const entries = view.entries;
  const key = String(conversation.id);
  const headId = view.head?.id;
  const prev = seen.get(key);
  // 换页后 headId 改变（或 entries 长度回退），游标必须归零从头扫
  const from = prev && prev.headId === headId && prev.count <= entries.length ? prev.count : 0;

  const texts: string[] = [];
  for (const entry of entries.slice(from)) {
    if (entry.kind === "pi.tool-result") texts.push(flatten(entry.model));
    if (entry.kind === "pi.assistant") {
      for (const message of (entry.model ?? []) as { content?: unknown }[]) {
        const content = message.content;
        if (!Array.isArray(content)) continue;
        for (const block of content) {
          if (block?.type === "thinking" && typeof block.thinking === "string") {
            texts.push(block.thinking.length > SECRET_TEXT_CAP ? block.thinking.slice(0, SECRET_TEXT_CAP) : block.thinking);
          }
        }
      }
    }
  }

  if (texts.length > 0) rememberSecrets(conversation.id, texts);
  if (clearAfter) rememberSecrets(conversation.id, []);
  seen.set(key, { headId, count: entries.length });
}

function flatten(model: unknown): string {
  if (!model) return "";
  const rendered = JSON.stringify(model);
  return rendered.length > SECRET_TEXT_CAP ? rendered.slice(0, SECRET_TEXT_CAP) : rendered;
}
