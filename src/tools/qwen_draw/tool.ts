/** Qwen-Image-2.1 画图：自然语言 prompt（非 danbooru）、可选参考图重绘；出图经 outbox 机械直发。 */
import { randomUUID } from "node:crypto";
import { mkdirSync, readFileSync, realpathSync, statSync, writeFileSync } from "node:fs";
import { extname, join, relative, resolve, sep } from "node:path";
import { LiveDoc, defineTool, type ToolRegistration } from "@earendil-works/pi-durable";
import { renderTemplate } from "../../prompt/index.ts";
import { manifestParameters, toolFullDescription } from "../manifest.ts";
import type { ToolManifest, ToolPackageDeps } from "../types.ts";
import { enqueueOutbound, isQuoteForced, type OutboundPayload } from "../say-shared.ts";
import { ComfyExecutionFailed, ComfyBusy } from "../draw/comfy.ts";
import { runQwenDraw, RATIO_SIZES } from "./comfy.ts";

interface QwenDrawToolArgs {
  prompt: string;
  ratio?: string;
  resolution?: 1024 | 2048;
  fast?: boolean;
  ref?: string;
  seed?: number;
}

type RoundState = { round: unknown; pending: boolean; submitted: boolean; used: boolean };
const rounds = new Map<string, RoundState>();
const REF_EXTS = new Set([".png", ".jpg", ".jpeg", ".webp"]);

class QwenDrawDisabledError extends Error {}

export function createQwenDrawTool(manifest: ToolManifest, deps: ToolPackageDeps): ToolRegistration {
  const root = resolve(deps.mediaRoot);
  const realRoot = (() => { try { return realpathSync(root); } catch { return root; } })();
  // GPU 资源闸复用 drawEnabled（2026-11-16 主人裁定）：qwen_draw 与 draw 共用同一台 WSL ComfyUI，
  // 让出 GPU 时两者一起关；缺省视为开，入口与提交前各复核一次（语义与 draw 一致）。
  const enabled = () => (deps.drawEnabled?.() ?? true) !== false;

  /** 参考图：只做路径安全校验 + 原样读字节（png/jpg/jpeg/webp 直传，ComfyUI LoadImage 原生支持，
   *  不做分辨率预算——2.1 的 TextEncodeQwenImage21 内部按 resolution 等比缩放）。 */
  const prepareRef = (raw: string): { bytes: Buffer; ext: "png" | "jpg" | "jpeg" | "webp" } => {
    const ref = raw.trim().replace(/^\[|\]$/g, "");
    const full = resolve(root, ref);
    const rel = relative(root, full).split(sep).join("/");
    const err = (message: string | undefined) => new Error(renderTemplate(message ?? "{{ref}}", { ref }));
    if (!full.startsWith(root + sep) || !["inbound/", "gen/"].some((prefix) => rel.startsWith(prefix))) throw err(deps.prompts.messages["qwen_ref_outside"]);
    let real: string;
    try { real = realpathSync(full); } catch { throw err(deps.prompts.messages["qwen_ref_missing"]); }
    if (!real.startsWith(realRoot + sep)) throw err(deps.prompts.messages["qwen_ref_outside"]);
    let st;
    try { st = statSync(real); } catch { throw err(deps.prompts.messages["qwen_ref_missing"]); }
    if (!st.isFile()) throw err(deps.prompts.messages["qwen_ref_missing"]);
    const ext = extname(full).toLowerCase().slice(1);
    if (!REF_EXTS.has(`.${ext}`)) throw err(deps.prompts.messages["qwen_ref_type"]);
    if (st.size > 20 * 1024 * 1024) throw err(deps.prompts.messages["qwen_ref_big"]);
    return { bytes: readFileSync(real), ext: ext as "png" | "jpg" | "jpeg" | "webp" };
  };

  return defineTool({
    name: manifest.name,
    description: toolFullDescription(manifest),
    callers: ["model"],
    parameters: manifestParameters<QwenDrawToolArgs>(manifest),
    execute: async (args, api, context) => {
      // 资源闸：关闭时尽早拒绝（与 draw 同一开关、同一语义——让出 GPU）。
      if (!enabled()) throw new Error(deps.prompts.messages["draw_disabled"] ?? "draw_disabled");
      const live = await api.snapshot(LiveDoc, api.conversationId, context);
      const round = live?.run?.inputs?.[0];
      const prompt = typeof args.prompt === "string" ? args.prompt.trim() : "";
      if (typeof args.prompt !== "string" || !prompt || prompt.length > 800) throw new Error(deps.prompts.messages["qwen_prompt"] ?? "qwen_prompt");
      if (!deps.comfyUrl) throw new Error(deps.prompts.messages["draw_off"] ?? "draw_off");
      if (args.resolution !== undefined && args.resolution !== 1024 && args.resolution !== 2048) throw new Error(deps.prompts.messages["qwen_resolution"] ?? "qwen_resolution");
      if (args.ratio !== undefined && !Object.hasOwn(RATIO_SIZES, args.ratio)) throw new Error(deps.prompts.messages["qwen_ratio"] ?? "qwen_ratio");
      if (args.fast !== undefined && typeof args.fast !== "boolean") throw new Error(deps.prompts.messages["qwen_fast"] ?? "qwen_fast");
      if (args.seed !== undefined && (!Number.isInteger(args.seed) || args.seed < 0 || args.seed > 4294967295)) throw new Error(deps.prompts.messages["qwen_seed"] ?? "qwen_seed");
      if (args.ref !== undefined && typeof args.ref !== "string") throw new Error(renderTemplate(deps.prompts.messages["qwen_ref_type"] ?? "{{ref}}", { ref: String(args.ref) }));
      if (round === undefined) throw new Error(deps.prompts.messages["draw_round_missing"] ?? "draw_round_missing");
      const previous = rounds.get(api.conversationId);
      if (previous?.pending) throw new Error(deps.prompts.messages["draw_inflight"] ?? "draw_inflight");
      if (previous?.round === round && previous.used) throw new Error(deps.prompts.messages["draw_used"] ?? "draw_used");
      if (previous?.round === round && previous.submitted) throw new Error(deps.prompts.messages["draw_uncertain"] ?? "draw_uncertain");
      const ref = args.ref !== undefined ? prepareRef(args.ref) : undefined;
      const state: RoundState = { round, pending: true, submitted: false, used: false };
      rounds.set(api.conversationId, state);
      // 提交前二次复核：execGraph 在真正 POST 前同步调 onSubmitted，关闭则抛、不置 submitted（可重试）。
      const onSubmitted = () => {
        if (!enabled()) throw new QwenDrawDisabledError();
        state.submitted = true;
        deps.onLongWork?.("qwen_draw", round);
      };
      try {
        const png = await runQwenDraw(deps.comfyUrl, {
          prompt,
          ratio: args.ratio ?? "1:1",
          resolution: args.resolution ?? 1024,
          fast: args.fast === true,
          ...(ref ? { ref: { name: "", bytes: ref.bytes, ext: ref.ext } } : {}),
          ...(args.seed !== undefined ? { seed: args.seed } : {}),
        }, onSubmitted, context.abortSignal);
        context.abortSignal?.throwIfAborted();
        const dir = join(root, "gen");
        mkdirSync(dir, { recursive: true });
        const file = `${Date.now()}-${randomUUID()}.png`;
        writeFileSync(join(dir, file), png, { flag: "wx" });
        state.used = true;
        // 机械直发（同 draw 2026-11-13 主人裁定）：出图即经 outbox 发出，不占开口额度；
        // 入队失败回退提示模型手动 say_media 补发，图不丢。
        const trigger = deps.triggerOf?.(round);
        const ts = Date.now();
        try {
          const payload: OutboundPayload = {
            items: [],
            media: `gen/${file}`,
            quote: false,
            ...(trigger?.messageId !== undefined ? { quoteId: trigger.messageId } : {}),
            ...(trigger ? { quoteForce: isQuoteForced(trigger) } : {}),
            at: ts,
            key: `${api.conversationId}:qwengen:${String(round)}`,
          };
          await enqueueOutbound(api, payload, context);
          return { output: [{ type: "text", text: renderTemplate(deps.prompts.messages["qwen_done"] ?? "gen/{{file}}", { file }) }] };
        } catch (sendError) {
          console.error("[fish] qwen_draw auto-send failed", sendError instanceof Error ? sendError.message : sendError);
          return { output: [{ type: "text", text: renderTemplate(deps.prompts.messages["qwen_done_fallback"] ?? "gen/{{file}}", { file }) }] };
        }
      } catch (error) {
        if (error instanceof QwenDrawDisabledError) {
          console.error("[fish] qwen_draw disabled before submit");
          throw new Error(deps.prompts.messages["draw_disabled"] ?? "draw_disabled");
        }
        if (error instanceof ComfyExecutionFailed) state.submitted = false;
        const detail = error instanceof Error ? error.message : "unknown";
        console.error(`[fish] qwen_draw failed: ${detail}`);
        throw new Error(error instanceof ComfyBusy ? (deps.prompts.messages["draw_busy"] ?? "draw_busy") : (deps.prompts.messages["qwen_failed"] ?? "qwen_failed"));
      } finally {
        state.pending = false;
      }
    },
  });
}
