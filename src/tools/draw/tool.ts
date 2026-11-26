/** 统一 danbooru 本地画图工具面：能力预检 + 词表解析 + 共享 ComfyUI 执行；出图经 outbox 机械直发。 */
import { randomUUID } from "node:crypto";
import { mkdirSync, readFileSync, realpathSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { extname, join, relative, resolve, sep } from "node:path";
import { LiveDoc, defineTool, type ToolRegistration } from "@earendil-works/pi-durable";
import { renderTemplate } from "../../prompt/index.ts";
import { manifestParameters, toolFullDescription } from "../manifest.ts";
import type { ToolManifest, ToolPackageDeps } from "../types.ts";
import { resolveCharacter, resolveStyle } from "../characters.ts";
import { normalizeInitViaWorker, usesSips } from "../../media/image-ops.ts";
import { spawnCapture } from "../../media/spawn-capture.ts";
import { enqueueOutbound, type OutboundPayload } from "../say-shared.ts";
import { ComfyBusy, ComfyExecutionFailed, execGraph, runExclusive, uploadRefImage, type DrawStage } from "./engine.ts";
import { DEFAULT_DRAW_BACKEND } from "./backends/ids.ts";
import { getDrawBackend, validateAllDrawBackends } from "./backends/registry.ts";
import type { DrawLoraRef, DrawMode, DrawMultiPart, DrawRatio, DrawRoleInput } from "./backends/types.ts";

interface DrawArgs {
  prompt: string;
  style?: string;
  ratio?: string;
  hd?: boolean;
  fast?: boolean;
  ref?: string;
  character?: string;
  characters?: Array<{ character?: string; description: string }>;
  framing?: "normal" | "wide";
  spacing?: "together" | "apart";
}

type RoundState = { round: unknown; pending: boolean; submitted: boolean; used: boolean };
const rounds = new Map<string, RoundState>();
const REF_EXTS = new Set([".png", ".jpg", ".jpeg", ".webp", ".gif", ".bmp", ".heic", ".heif"]);
const PNG = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);

const MODE_LABELS: Readonly<Record<DrawMode, string>> = {
  single: "单人从零画",
  fast: "快速",
  ref: "改图",
  multi: "双人同框",
};

/** 提交前二次复核发现画图已被热关闭：在 onSubmitted 回调里抛出，阻止真正 POST，且不置 submitted。 */
class DrawDisabledError extends Error {}

export function createDrawTool(manifest: ToolManifest, deps: ToolPackageDeps): ToolRegistration {
  validateAllDrawBackends();
  if (deps.drawBackends) validateAllDrawBackends(deps.drawBackends);

  const root = resolve(deps.mediaRoot);
  const realRoot = (() => { try { return realpathSync(root); } catch { return root; } })();
  // 画图总开关（fish.config.json 的 drawEnabled，热加载，资源闸）：缺省视为开；每次现读，
  // 入口与提交前各复核一次，关闭期间让出 GPU。
  const enabled = () => (deps.drawEnabled?.() ?? true) !== false;
  const prepareRef = async (raw: string, signal?: AbortSignal): Promise<{ png: Buffer; strength: number }> => {
    const ref = raw.trim().replace(/^\[|\]$/g, "");
    const full = resolve(root, ref);
    const rel = relative(root, full).split(sep).join("/");
    const err = (message: string | undefined) => new Error(renderTemplate(message ?? "{{ref}}", { ref }));
    if (!full.startsWith(root + sep) || !["inbound/", "gen/"].some((prefix) => rel.startsWith(prefix))) throw err(deps.prompts.messages["draw_ref_outside"]);
    let real: string;
    try { real = realpathSync(full); } catch { throw err(deps.prompts.messages["draw_ref_missing"]); }
    if (!real.startsWith(realRoot + sep)) throw err(deps.prompts.messages["draw_ref_outside"]);
    let st;
    try { st = statSync(real); } catch { throw err(deps.prompts.messages["draw_ref_missing"]); }
    if (!st.isFile()) throw err(deps.prompts.messages["draw_ref_missing"]);
    if (!REF_EXTS.has(extname(full).toLowerCase())) throw err(deps.prompts.messages["draw_ref_type"]);
    if (st.size > 20 * 1024 * 1024) throw err(deps.prompts.messages["draw_ref_big"]);
    const png = await normalizeInitImage(real, signal);
    if (!png) throw err(deps.prompts.messages["draw_ref_broken"]);
    return { png, strength: 0.45 };
  };

  return defineTool({
    name: manifest.name,
    description: toolFullDescription(manifest),
    callers: ["model"],
    parameters: manifestParameters<DrawArgs>(manifest),
    execute: async (args, api, context) => {
      // 1. 入口总闸与基础参数校验（原序保持零回归）
      if (!enabled()) throw new Error(deps.prompts.messages["draw_disabled"] ?? "draw_disabled");
      const live = await api.snapshot(LiveDoc, api.conversationId, context);
      const round = live?.run?.inputs?.[0];
      const positive = typeof args.prompt === "string" ? args.prompt.trim() : "";
      if (typeof args.prompt !== "string" || positive.length > 1000) throw new Error(deps.prompts.messages["draw_prompt"] ?? "draw_prompt");
      if (!deps.comfyUrl) throw new Error(deps.prompts.messages["draw_off"] ?? "draw_off");
      if (args.hd !== undefined && typeof args.hd !== "boolean") throw new Error(deps.prompts.messages["draw_hd"] ?? "draw_hd");
      if (args.fast !== undefined && typeof args.fast !== "boolean") throw new Error(deps.prompts.messages["draw_fast"] ?? "draw_fast");
      if (args.character !== undefined && typeof args.character !== "string") throw new Error(deps.prompts.messages["draw_character_type"] ?? "draw_character_type");
      if (args.style !== undefined && typeof args.style !== "string") throw new Error(deps.prompts.messages["draw_style_type"] ?? "draw_style_type");
      if (args.ref !== undefined && typeof args.ref !== "string") throw new Error(renderTemplate(deps.prompts.messages["draw_ref_type"] ?? "{{ref}}", { ref: String(args.ref) }));
      if (args.fast === true && (args.hd === true || args.characters !== undefined)) throw new Error(deps.prompts.messages["draw_fast_scope"] ?? "draw_fast_scope");
      if ((args.framing !== undefined && !["normal", "wide"].includes(args.framing)) || (args.spacing !== undefined && !["together", "apart"].includes(args.spacing))) throw new Error(deps.prompts.messages["draw_composition"] ?? "draw_composition");
      if (args.characters === undefined && (args.framing !== undefined || args.spacing !== undefined)) throw new Error(deps.prompts.messages["draw_composition_multi"] ?? "draw_composition_multi");
      if (args.characters !== undefined) {
        if (args.character !== undefined) throw new Error(deps.prompts.messages["draw_characters_conflict"] ?? "draw_characters_conflict");
        if (args.style !== undefined || args.ref !== undefined) throw new Error(deps.prompts.messages["draw_multi_unsupported"] ?? "draw_multi_unsupported");
        if (!Array.isArray(args.characters) || args.characters.length !== 2) throw new Error(deps.prompts.messages["draw_characters_count"] ?? "draw_characters_count");
        if (args.characters.some((part) => !part || typeof part !== "object" || typeof part.description !== "string" || !part.description.trim())) throw new Error(deps.prompts.messages["draw_multi_sides"] ?? "draw_multi_sides");
        for (const part of args.characters) {
          if (Object.hasOwn(part, "region")) throw new Error(deps.prompts.messages["draw_region_retired"] ?? "draw_region_retired");
          if (part.character !== undefined && typeof part.character !== "string") throw new Error(deps.prompts.messages["draw_character_type"] ?? "draw_character_type");
          if (part.description.length > 800) throw new Error(deps.prompts.messages["draw_multi_length"] ?? "draw_multi_length");
        }
      }

      // 2. 轮状态检查
      if (round === undefined) throw new Error(deps.prompts.messages["draw_round_missing"] ?? "draw_round_missing");
      const previous = rounds.get(api.conversationId);
      if (previous?.pending) throw new Error(deps.prompts.messages["draw_inflight"] ?? "draw_inflight");
      if (previous?.round === round && previous.used) throw new Error(deps.prompts.messages["draw_used"] ?? "draw_used");
      if (previous?.round === round && previous.submitted) throw new Error(deps.prompts.messages["draw_uncertain"] ?? "draw_uncertain");

      // 3. 热读后端
      const backendId = deps.drawBackend?.() ?? DEFAULT_DRAW_BACKEND;
      const backend = getDrawBackend(backendId, deps.drawBackends);
      if (!backend) throw new Error(deps.prompts.messages["draw_backend_unknown"] ?? "draw_backend_unknown");

      // 4. 推导 mode 与 fast
      const mode: DrawMode = args.characters !== undefined ? "multi" : args.ref !== undefined ? "ref" : args.fast === true ? "fast" : "single";
      const isFast = args.fast === true;

      // 5. 按 backend.capabilities 严格能力校验（不做隐式降级）
      if (!backend.capabilities.modes[mode]) {
        throw new Error(renderTemplate(deps.prompts.messages["draw_mode_unsupported"] ?? "{{mode}}", { mode: MODE_LABELS[mode] }));
      }
      if (isFast && !backend.capabilities.modes.fast) {
        throw new Error(renderTemplate(deps.prompts.messages["draw_mode_unsupported"] ?? "{{mode}}", { mode: MODE_LABELS.fast }));
      }
      if (args.hd === true && !backend.capabilities.hd) {
        throw new Error(deps.prompts.messages["draw_hd_unsupported"] ?? "draw_hd_unsupported");
      }
      if (args.style !== undefined && !backend.capabilities.styleModes.includes(mode)) {
        throw new Error(deps.prompts.messages["draw_style_mode_unsupported"] ?? "draw_style_mode_unsupported");
      }
      if ((args.framing !== undefined && !backend.capabilities.framing) || (args.spacing !== undefined && !backend.capabilities.spacing)) {
        throw new Error(deps.prompts.messages["draw_composition_unsupported"] ?? "draw_composition_unsupported");
      }

      // 6. 比例解析
      const ratio = args.ratio ?? "3:4";
      if (typeof ratio !== "string" || !Object.hasOwn(backend.ratioSizes, ratio)) {
        throw new Error(deps.prompts.messages["draw_ratio"] ?? "draw_ratio");
      }
      const [width, height] = backend.ratioSizes[ratio as DrawRatio];

      // 7. 词表解析（按 backendId + loraFamily）
      const target = { backendId: backend.id, loraFamily: backend.loraFamily };
      let role: DrawRoleInput | undefined;
      if (args.character !== undefined) {
        const resolved = resolveCharacter(args.character, target);
        if (!resolved) throw new Error(renderTemplate(deps.prompts.messages["draw_character"] ?? "{{key}}", { key: args.character }));
        role = resolved;
      }
      let parts: DrawMultiPart[] | undefined;
      if (args.characters !== undefined) {
        parts = args.characters.map((part) => {
          let partRole: DrawRoleInput | undefined;
          if (part.character !== undefined) {
            const resolved = resolveCharacter(part.character, target);
            if (!resolved) throw new Error(renderTemplate(deps.prompts.messages["draw_character"] ?? "{{key}}", { key: part.character }));
            partRole = resolved;
          }
          return { text: part.description.trim(), ...(partRole ? { role: partRole } : {}) };
        });
      }
      let style: DrawLoraRef | undefined;
      if (args.style !== undefined) {
        const resolved = resolveStyle(args.style, target);
        if (!resolved) throw new Error(renderTemplate(deps.prompts.messages["draw_style"] ?? "{{key}}", { key: args.style }));
        if (!resolved.lora) {
          throw new Error(renderTemplate(deps.prompts.messages["draw_style_backend_unsupported"] ?? "{{key}}", { key: args.style }));
        }
        style = resolved.lora;
      }

      // 8. 参考图预处理与单飞执行
      const ref = mode === "ref" && args.ref !== undefined ? await prepareRef(args.ref, context.abortSignal) : undefined;
      const state: RoundState = { round, pending: true, submitted: false, used: false };
      rounds.set(api.conversationId, state);
      const uploadRef = deps.drawUploadRef ?? uploadRefImage;
      const exec = deps.drawExec ?? execGraph;
      try {
        const stageCb = deps.onDrawStage && round !== undefined ? (stage: DrawStage) => deps.onDrawStage?.(round, stage) : undefined;
        const bp = deps.bypassOf?.(round);
        const png = await runExclusive(async () => {
          const refInputName = ref ? await uploadRef(deps.comfyUrl!, ref.png, "png", context.abortSignal) : undefined;
          const built = backend.buildGraph({
            mode,
            fast: isFast,
            prompt: positive,
            width,
            height,
            hd: args.hd === true,
            ...(role ? { role } : {}),
            ...(style ? { style } : {}),
            ...(parts ? { parts } : {}),
            ...(refInputName ? { refInputName, refStrength: ref!.strength } : {}),
            ...(args.framing !== undefined ? { framing: args.framing } : {}),
            ...(args.spacing !== undefined ? { spacing: args.spacing } : {}),
            ...(bp?.bypass !== undefined ? { bypass: bp.bypass } : {}),
            ...(bp?.pbypass !== undefined ? { pbypass: bp.pbypass } : {}),
          });
          // 提交前二次复核：execGraph 在真正 POST 前同步调 onSubmitted（其间无 await），
          // 关闭则抛 DrawDisabledError 阻止 POST，且 submitted 保持 false（可重试）；正常放行再同步发 onLongWork。
          const onSubmitted = () => {
            if (!enabled()) throw new DrawDisabledError();
            state.submitted = true;
            deps.onLongWork?.(built.workingVariant, round);
          };
          return await exec(deps.comfyUrl!, built.graph, {
            deadline: built.deadline,
            outputNode: built.outputNode,
            outputType: built.outputType,
            onSubmitted,
            ...(stageCb && built.stageNodes?.length ? { onStage: stageCb, stageNodes: built.stageNodes } : {}),
            ...(backend.extraModelFileFields ? { extraModelFileFields: backend.extraModelFileFields } : {}),
            signal: context.abortSignal,
          });
        });
        // 出图后、落盘/入队前的取消闸：超时晚到的图不再写 gen/ 也不再入 outbox；
        // submitted 保持 true（作业已被接受），本轮重试吃 draw_uncertain，不重 POST。
        context.abortSignal?.throwIfAborted();
        const dir = join(root, "gen");
        mkdirSync(dir, { recursive: true });
        const file = `${Date.now()}-${randomUUID()}.png`;
        writeFileSync(join(dir, file), png, { flag: "wx" });
        state.used = true;
        // 机械发图（主人裁定 2026-11-13）：出图即经 outbox 直发，不再让模型调 say_media。
        const trigger = deps.triggerOf?.(round);
        const ts = Date.now();
        try {
          const payload: OutboundPayload = {
            items: [],
            media: `gen/${file}`,
            quote: false,
            ...(trigger?.messageId !== undefined ? { quoteId: trigger.messageId } : {}),
            ...(trigger ? { quoteForce: trigger.mentionsBot } : {}),
            at: ts,
            key: `${api.conversationId}:drawimg:${String(round)}`,
          };
          await enqueueOutbound(api, payload, context);
          return { output: [{ type: "text", text: renderTemplate(deps.prompts.messages["draw_done"] ?? "gen/{{file}}", { file }) }] };
        } catch (sendError) {
          console.error("[fish] draw auto-send failed", sendError instanceof Error ? sendError.message : sendError);
          return { output: [{ type: "text", text: renderTemplate(deps.prompts.messages["draw_done_fallback"] ?? "gen/{{file}}", { file }) }] };
        }
      } catch (error) {
        if (error instanceof DrawDisabledError) {
          console.error("[fish] draw disabled before submit");
          throw new Error(deps.prompts.messages["draw_disabled"] ?? "draw_disabled");
        }
        if (error instanceof ComfyExecutionFailed) state.submitted = false;
        const detail = error instanceof Error ? error.message : "unknown";
        console.error(`[fish] draw failed: ${detail}`);
        throw new Error(error instanceof ComfyBusy ? (deps.prompts.messages["draw_busy"] ?? "draw_busy") : (deps.prompts.messages["draw_failed"] ?? "draw_failed"));
      } finally {
        state.pending = false;
      }
    },
  });
}

/** 与旧通道相同：图片缩到受限像素预算，转换为 PNG。
 *  macOS 走 sips（参数逐字保留，改异步 spawn 以消费取消信号，不再阻塞 watchdog），
 *  其它平台走 sharp worker（同步契约，自带底层 timeout）；否则容器内 ref 改图不可用。 */
async function normalizeInitImage(full: string, signal?: AbortSignal): Promise<Buffer | null> {
  if (!usesSips()) return normalizeInitViaWorker(full);
  try {
    const probe = await spawnCapture("sips", ["-g", "pixelWidth", "-g", "pixelHeight", full], { timeoutMs: 20_000, signal });
    const out = probe.status === 0 ? probe.stdout.toString() : "";
    const w = Number(/pixelWidth:\s*(\d+)/.exec(out)?.[1]);
    const h = Number(/pixelHeight:\s*(\d+)/.exec(out)?.[1]);
    if (!Number.isInteger(w) || !Number.isInteger(h) || w <= 0 || h <= 0) return null;
    const scale = Math.min(1, 1216 / Math.max(w, h), Math.sqrt((832 * 1216) / (w * h)));
    const side = (n: number) => Math.max(64, Math.floor(n / 16) * 16);
    const tmp = join(tmpdir(), `draw-init-${randomUUID()}.png`);
    let buf: Buffer;
    try {
      const conv = await spawnCapture("sips", ["-s", "format", "png", "-z", String(side(h * scale)), String(side(w * scale)), full, "--out", tmp], { timeoutMs: 30_000, signal });
      if (conv.status !== 0) return null;
      buf = readFileSync(tmp);
    } finally { rmSync(tmp, { force: true }); }
    return buf.length >= 24 && buf.subarray(0, 8).equals(PNG) ? buf : null;
  } catch { return null; }
}
