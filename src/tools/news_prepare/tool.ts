/** news_prepare：人格备料的唯一写入口；不触碰出口与 outbox。 */
import { LiveDoc, defineTool, type ToolRegistration } from "@earendil-works/pi-durable";
import type { NewsDigest } from "../../external/news-broadcast.ts";
import { renderTemplate } from "../../prompt/index.ts";
import { manifestParameters, toolFullDescription } from "../manifest.ts";
import type { ToolManifest, ToolPackageDeps } from "../types.ts";

export function createNewsPrepareTool(
  manifest: ToolManifest,
  deps: ToolPackageDeps,
): ToolRegistration | undefined {
  const prepare = deps.newsPrepare;
  if (!prepare) return undefined;
  const messages = deps.prompts.messages;
  return defineTool({
    name: manifest.name,
    description: toolFullDescription(manifest),
    callers: ["model"],
    parameters: manifestParameters<NewsDigest>(manifest),
    execute: async (args, api, context) => {
      const live = await api.snapshot(LiveDoc, api.conversationId, context) as
        | { run?: { inputs?: unknown[] } }
        | undefined;
      const round = live?.run?.inputs?.[0];
      const trigger = round !== undefined ? deps.triggerOf?.(round) : undefined;
      if (trigger?.kind !== "news" || !trigger.newsRunId || !Number.isInteger(trigger.newsAttempt)) {
        throw new Error(messages["news_prepare_not_news"] ?? "news_prepare_not_news");
      }
      const result = await prepare({
        runId: trigger.newsRunId,
        attempt: trigger.newsAttempt!,
        conversationId: String(api.conversationId),
        digest: args,
      });
      if (result.status !== "prepared") {
        throw new Error(renderTemplate(messages["news_prepare_rejected"] ?? "news_prepare_rejected", {
          reason: result.reason ?? "rejected",
        }));
      }
      return { output: [{ type: "text", text: messages["news_prepare_ok"] ?? "news_prepare_ok" }] };
    },
  });
}
