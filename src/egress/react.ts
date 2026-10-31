/**
 * react —— 只贴个表情，不说话。
 *
 * 群里冷场、别人在互相聊、或者只想表示"看到了"，这比发一句话轻得多。
 * 它不走 say 的出口校验，因为不产生任何文本；只限流。
 */
import { Type } from "@earendil-works/pi-ai";
import { LiveDoc, defineTool, type ConversationId } from "@earendil-works/pi-durable";
import { renderTemplate, requireTool, type PromptSet } from "../prompts.ts";
import { ledgerOf, recordReact } from "./ledger.ts";

export interface ReactDeps {
  prompts: PromptSet;
  /** 贴表情：第三个参数是本轮触发消息 id（轮级绑定）。 */
  react: (conversationId: ConversationId, emoji: string, messageId?: number | string) => void | Promise<void>;
  /** submissionId → 本轮触发消息；react 目标只认它，不取会话级 lastMessageId。 */
  triggerOf?: (roundId: unknown) => { messageId?: number | string; mentionsBot: boolean; userId?: number } | undefined;
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
    execute: async (args, api, context) => {
      const ledger = ledgerOf(api.conversationId);
      const emoji = args.emoji.trim();
      const ts = now();

      if (!/^\d{1,6}$/.test(emoji)) {
        throw new Error(deps.prompts.messages["react_bad"] ?? "bad emoji");
      }
      if (ledger.lastReact && ledger.lastReact.emoji === emoji && ts - ledger.lastReact.at < 60_000) {
        throw new Error(renderTemplate(deps.prompts.messages["react_cooling"] ?? "", {}));
      }

      // 要贴哪一条：本轮触发消息（轮级绑定）。会话级 lastMessageId 会被后到的消息顶掉，
      // 那一下就会贴到别人刚发的话上。
      const live = await api.snapshot(LiveDoc, api.conversationId, context);
      const round = live?.run?.inputs?.[0];
      const trigger = round === undefined ? undefined : deps.triggerOf?.(round);

      recordReact(api.conversationId, emoji, ts);
      await deps.react(api.conversationId, emoji, trigger?.messageId);
      return { output: [{ type: "text", text: deps.prompts.messages["react_ok"] ?? "ok" }] };
    },
  });
}
