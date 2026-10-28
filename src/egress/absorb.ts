/**
 * 把 transcript 里的「秘密」喂给溯源校验。
 *
 * 秘密 = assistant 的 thinking block + 所有 tool 结果文本。
 * 这些内容永远不出境，但模型可能把它们抄进 say() 的 text 里，所以要留下来对照。
 */
import type { Conversation } from "@earendil-works/pi-durable";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { rememberSecrets } from "./ledger.ts";

const seen = new Map<string, number>();

export async function absorbSecrets(conversation: Conversation, clearAfter = false): Promise<void> {
  const view = await conversation.viewState(BACKGROUND_CONTEXT);
  const entries = view.value.entries;
  const from = seen.get(conversation.id) ?? 0;

  const texts: string[] = [];
  for (const entry of entries.slice(from)) {
    if (entry.kind === "pi.tool-result") texts.push(flatten(entry.model));
    if (entry.kind === "pi.assistant") {
      for (const message of (entry.model ?? []) as { content?: unknown }[]) {
        const content = message.content;
        if (!Array.isArray(content)) continue;
        for (const block of content) {
          if (block?.type === "thinking" && typeof block.thinking === "string") texts.push(block.thinking);
        }
      }
    }
  }

  if (texts.length > 0) rememberSecrets(conversation.id, texts);
  if (clearAfter) rememberSecrets(conversation.id, []);
  seen.set(conversation.id, entries.length);
  view.dispose();
}

function flatten(model: unknown): string {
  if (!model) return "";
  const rendered = JSON.stringify(model);
  return rendered.length > 4000 ? rendered.slice(0, 4000) : rendered;
}
