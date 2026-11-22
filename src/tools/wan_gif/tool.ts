/** 固定低规格 Wan GIF：模型阶段 3 秒 480P，输出阶段 280×280、5fps。 */
import { randomUUID } from "node:crypto";
import { LiveDoc, defineTool, type ToolRegistration } from "@earendil-works/pi-durable";
import { renderTemplate } from "../../prompt/index.ts";
import { generateWanGif, readWanGifRef } from "../../media/wan-video.ts";
import { manifestParameters, toolFullDescription } from "../manifest.ts";
import type { ToolManifest, ToolPackageDeps } from "../types.ts";
import { enqueueOutbound, type OutboundPayload } from "../say-shared.ts";

interface WanGifArgs { prompt: string; ref?: string }
type RoundState = { round: unknown; pending: boolean; submitted: boolean; used: boolean };
const rounds = new Map<string, RoundState>();

export function createWanGifTool(manifest: ToolManifest, deps: ToolPackageDeps): ToolRegistration {
  const root = deps.mediaRoot;
  return defineTool({
    name: manifest.name,
    description: toolFullDescription(manifest),
    callers: ["model"],
    parameters: manifestParameters<WanGifArgs>(manifest),
    execute: async (args, api, context) => {
      if (!deps.wanImage) throw new Error("wan_gif_unconfigured");
      const live = await api.snapshot(LiveDoc, api.conversationId, context);
      const round = live?.run?.inputs?.[0];
      const prompt = typeof args.prompt === "string" ? args.prompt.trim() : "";
      if (!prompt || prompt.length > 800) throw new Error(deps.prompts.messages["wan_gif_prompt"] ?? "wan_gif_prompt");
      if (round === undefined) throw new Error("draw_round_missing");
      const previous = rounds.get(api.conversationId);
      if (previous?.pending) throw new Error("draw_inflight");
      if (previous?.round === round && previous.used) throw new Error("draw_used");
      if (previous?.round === round && previous.submitted) throw new Error("draw_uncertain");
      const state: RoundState = { round, pending: true, submitted: false, used: false };
      rounds.set(api.conversationId, state);
      deps.onLongWork?.("wan_gif", round);
      try {
        let ref;
        try {
          ref = args.ref === undefined ? undefined : readWanGifRef(root, args.ref);
        } catch {
          throw new Error(deps.prompts.messages["wan_gif_ref_bad"] ?? "wan_gif_ref_bad");
        }
        state.submitted = true;
        const file = await generateWanGif({ ...deps.wanImage, prompt, ...(ref ? { ref } : {}), mediaRoot: root, signal: context.abortSignal });
        context.abortSignal?.throwIfAborted();
        state.used = true;
        const trigger = deps.triggerOf?.(round);
        const payload: OutboundPayload = {
          items: [], media: `gen/${file}`, quote: false,
          ...(trigger?.messageId !== undefined ? { quoteId: trigger.messageId } : {}),
          ...(trigger ? { quoteForce: trigger.mentionsBot } : {}),
          at: Date.now(), key: `${api.conversationId}:wangif:${String(round)}:${randomUUID()}`,
        };
        await enqueueOutbound(api, payload, context);
        return { output: [{ type: "text", text: renderTemplate("gen/{{file}} —— GIF 已生成并自动发出", { file }) }] };
      } catch (error) {
        console.error("[fish] wan_gif failed", error instanceof Error ? error.message : error);
        throw new Error(deps.prompts.messages["wan_gif_failed"] ?? "wan_gif_failed");
      } finally {
        state.pending = false;
      }
    },
  });
}
