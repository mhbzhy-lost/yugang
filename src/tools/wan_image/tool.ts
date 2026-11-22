/** 百炼 Token Plan Wan Image 生图，出图经 outbox 机械直发。 */
import { randomUUID } from "node:crypto";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { LiveDoc, defineTool, type ToolRegistration } from "@earendil-works/pi-durable";
import { renderTemplate } from "../../prompt/index.ts";
import { generateWanImage } from "../../media/wan-image.ts";
import { manifestParameters, toolFullDescription } from "../manifest.ts";
import type { ToolManifest, ToolPackageDeps } from "../types.ts";
import { enqueueOutbound, type OutboundPayload } from "../say-shared.ts";

interface WanImageArgs { prompt: string; size?: "1K" | "2K"; enable_sequential?: boolean; n?: number }
type RoundState = { round: unknown; pending: boolean; submitted: boolean; used: boolean };
const rounds = new Map<string, RoundState>();

export function createWanImageTool(manifest: ToolManifest, deps: ToolPackageDeps): ToolRegistration {
  const root = deps.mediaRoot;
  return defineTool({
    name: manifest.name,
    description: toolFullDescription(manifest),
    callers: ["model"],
    parameters: manifestParameters<WanImageArgs>(manifest),
    execute: async (args, api, context) => {
      if (!deps.wanImage) throw new Error(deps.prompts.messages["wan_image_unconfigured"] ?? "wan_image_unconfigured");
      const live = await api.snapshot(LiveDoc, api.conversationId, context);
      const round = live?.run?.inputs?.[0];
      const prompt = typeof args.prompt === "string" ? args.prompt.trim() : "";
      if (!prompt || prompt.length > 800) throw new Error(deps.prompts.messages["wan_image_prompt"] ?? "wan_image_prompt");
      if (round === undefined) throw new Error("draw_round_missing");
      const previous = rounds.get(api.conversationId);
      if (previous?.pending) throw new Error("draw_inflight");
      if (previous?.round === round && previous.used) throw new Error("draw_used");
      if (previous?.round === round && previous.submitted) throw new Error("draw_uncertain");
      const state: RoundState = { round, pending: true, submitted: false, used: false };
      rounds.set(api.conversationId, state);
      deps.onLongWork?.("wan_image", round);
      try {
        state.submitted = true;
        const sequential = args.enable_sequential === true;
        const count = args.n ?? 1;
        if (!Number.isInteger(count) || count < 1 || count > (sequential ? 12 : 4)) throw new Error("wan_image_n");
        const files = await generateWanImage({ ...deps.wanImage, prompt, size: args.size, n: count, enableSequential: sequential, mediaRoot: root, signal: context.abortSignal });
        context.abortSignal?.throwIfAborted();
        state.used = true;
        const trigger = deps.triggerOf?.(round);
        for (const file of files) {
          const payload: OutboundPayload = {
            items: [], media: `gen/${file}`, quote: false,
            ...(trigger?.messageId !== undefined ? { quoteId: trigger.messageId } : {}),
            ...(trigger ? { quoteForce: trigger.mentionsBot } : {}),
            at: Date.now(), key: `${api.conversationId}:wanimage:${String(round)}:${file}`,
          };
          await enqueueOutbound(api, payload, context);
        }
        try {
          return { output: [{ type: "text", text: renderTemplate(deps.prompts.messages["wan_image_done"] ?? "gen/{{file}}", { file: files.join("、") }) }] };
        } catch (error) {
          console.error("[fish] wan_image auto-send failed", error instanceof Error ? error.message : error);
          throw error;
        }
      } catch (error) {
        console.error("[fish] wan_image failed", error instanceof Error ? error.message : error);
        throw new Error(deps.prompts.messages["wan_image_failed"] ?? "wan_image_failed");
      } finally {
        state.pending = false;
      }
    },
  });
}
