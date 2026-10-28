/**
 * react —— 只贴个表情，不说话。
 *
 * 群里冷场、别人在互相聊、或者只想表示"看到了"，这比发一句话轻得多。
 * 它不走 say 的出口校验，因为不产生任何文本；只限流。
 */
import { Type } from "@earendil-works/pi-ai";
import { defineTool, type ConversationId } from "@earendil-works/pi-durable";
import { renderTemplate, requireTool, type PromptSet } from "../prompts.ts";
import { ledgerOf, recordReact } from "./ledger.ts";

export interface ReactDeps {
  prompts: PromptSet;
  react: (conversationId: ConversationId, emoji: string) => void | Promise<void>;
  now?: () => number;
}

export function createReactTool(deps: ReactDeps) {
  const now = deps.now ?? Date.now;
  const prompt = requireTool(deps.prompts, "react");

  return defineTool({
    name: "react",
    description: prompt.description,
    callers: ["model"],
    parameters: Type.Object({
      emoji: Type.String({ description: prompt.params["emoji"] ?? "" }),
    }),
    execute: async (args, api) => {
      const ledger = ledgerOf(api.conversationId);
      const emoji = args.emoji.trim();
      const ts = now();

      if (!/^\d{1,6}$/.test(emoji)) {
        throw new Error(deps.prompts.messages["react_bad"] ?? "bad emoji");
      }
      if (ledger.lastReact && ledger.lastReact.emoji === emoji && ts - ledger.lastReact.at < 60_000) {
        throw new Error(renderTemplate(deps.prompts.messages["react_cooling"] ?? "", {}));
      }

      recordReact(api.conversationId, emoji, ts);
      await deps.react(api.conversationId, emoji);
      return { output: [{ type: "text", text: deps.prompts.messages["react_ok"] ?? "ok" }] };
    },
  });
}
