/**
 * react 工具包 —— 只贴个表情，不说话。
 *
 * 群里冷场、别人在互相聊、或者只想表示"看到了"，这比发一句话轻得多。
 * 它不走 say 的出口校验，因为不产生任何文本；只限流。
 *
 * 说明文字与参数 Schema 唯一来自 TOOL.md manifest（factory 只消费它，不再有第二份运行时定义）。
 */
import { LiveDoc, defineTool, type ToolRegistration } from "@earendil-works/pi-durable";
import { renderTemplate } from "../../prompts.ts";
import { ledgerOf, recordReact } from "../../egress/ledger.ts";
import { manifestParameters, toolFullDescription } from "../manifest.ts";
import type { ToolManifest, ToolPackageDeps } from "../types.ts";

/** args 静态类型：与 TOOL.md 的参数 Schema 一一对应；运行时 Schema 只有 manifest 这一份。 */
interface ReactArgs {
  emoji: string;
}

/** 依赖不齐（缺贴表情实现）时返回 undefined，由注册方跳过。 */
export function createReactTool(manifest: ToolManifest, deps: ToolPackageDeps): ToolRegistration | undefined {
  const react = deps.react;
  if (!react) return undefined;
  const now = deps.now ?? Date.now;

  return defineTool({
    name: manifest.name,
    description: toolFullDescription(manifest),
    callers: ["model"],
    parameters: manifestParameters<ReactArgs>(manifest),
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
      await react(api.conversationId, emoji, trigger?.messageId);
      return { output: [{ type: "text", text: deps.prompts.messages["react_ok"] ?? "ok" }] };
    },
  });
}
