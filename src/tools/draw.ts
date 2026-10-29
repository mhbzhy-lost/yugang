/**
 * draw —— 本地 Stable Diffusion 出图（Windows 宿主机上的 SD WebUI Forge Neo）。
 *
 * 只开放 positive / negative 两项注入，模型、采样器、步数、尺寸全是预设，
 * 不让模型自己调参。图落 <mediaRoot>/gen/，出口仍走 say.media。
 * 一轮最多画一次，失败不消耗次数。
 */
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { Type } from "@earendil-works/pi-ai";
import { LiveDoc, defineTool } from "@earendil-works/pi-durable";
import { renderTemplate, requireTool, type PromptSet } from "../prompts.ts";

export interface DrawDeps {
  prompts: PromptSet;
  mediaRoot: string;
  /** SD WebUI 的 baseUrl，如 http://SD_LAN_HOST:7860 */
  baseUrl?: string;
  timeoutMs?: number;
  fetchImpl?: typeof fetch;
}

const DRAWN = new Map<string, unknown>();
// 预设：SDXL 动漫模型竖版出图；步数与 CFG 取 Forge 常用档。模型/采样器用 WebUI 端当前配置。
const PRESET = { width: 832, height: 1216, steps: 28, cfg_scale: 4.5 };

export function createDrawTool(deps: DrawDeps) {
  const prompt = requireTool(deps.prompts, "draw");
  const timeoutMs = deps.timeoutMs ?? 180_000;
  const doFetch = deps.fetchImpl ?? fetch;
  const outDir = join(deps.mediaRoot, "gen");

  return defineTool({
    name: "draw",
    description: prompt.description,
    callers: ["model"],
    parameters: Type.Object({
      prompt: Type.String({ description: prompt.params["prompt"] ?? "" }),
      negative: Type.Optional(Type.String({ description: prompt.params["negative"] ?? "" })),
    }),
    execute: async (args, api, context) => {
      if (!deps.baseUrl) {
        throw new Error(deps.prompts.messages["draw_off"] ?? "draw_off");
      }
      const positive = args.prompt.trim();
      if (!positive || positive.length > 1000) {
        throw new Error(deps.prompts.messages["draw_prompt"] ?? "draw_prompt");
      }

      const live = await api.snapshot(LiveDoc, api.conversationId, context);
      const round = live?.run?.inputs?.[0];
      if (round !== undefined && DRAWN.get(api.conversationId) === round) {
        throw new Error(deps.prompts.messages["draw_used"] ?? "draw_used");
      }

      const ctrl = new AbortController();
      const timer = setTimeout(() => ctrl.abort(), timeoutMs);
      try {
        const res = await doFetch(`${deps.baseUrl}/sdapi/v1/txt2img`, {
          method: "POST",
          signal: ctrl.signal,
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            prompt: positive,
            negative_prompt: (args.negative ?? "").trim(),
            ...PRESET,
          }),
        });
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const j = (await res.json()) as { images?: string[] };
        const b64 = j.images?.[0];
        if (!b64) throw new Error("no image");

        mkdirSync(outDir, { recursive: true });
        const file = `${Date.now()}-${Math.random().toString(16).slice(2, 8)}.png`;
        writeFileSync(join(outDir, file), Buffer.from(b64, "base64"));
        if (round !== undefined) DRAWN.set(api.conversationId, round);
        console.log(`[fish] draw ok: ${positive.slice(0, 40)}`);
        return {
          output: [{
            type: "text",
            text: renderTemplate(deps.prompts.messages["draw_done"] ?? "gen/{{file}}", { file }),
          }],
        };
      } catch (error) {
        throw new Error(
          (deps.prompts.messages["draw_failed"] ?? "draw_failed") +
            `: ${error instanceof Error ? error.message : "unknown"}`,
        );
      } finally {
        clearTimeout(timer);
      }
    },
  });
}
