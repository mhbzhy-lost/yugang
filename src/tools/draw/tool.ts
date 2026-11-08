/** 固定 ComfyUI 工作流：结果仍交给 say_media，模型不能提交节点图。 */
import { spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdirSync, readFileSync, realpathSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { extname, join, relative, resolve, sep } from "node:path";
import { LiveDoc, defineTool, type ToolRegistration } from "@earendil-works/pi-durable";
import { renderTemplate } from "../../prompt/index.ts";
import { manifestParameters, toolFullDescription } from "../manifest.ts";
import type { ToolManifest, ToolPackageDeps } from "../types.ts";
import { ComfyBusy, ComfyExecutionFailed, runComfy } from "./comfy.ts";

interface DrawArgs {
  prompt: string;
  preset?: "default" | "hsr" | "secret";
  ratio?: keyof typeof RATIO_SIZES;
  ref?: string;
}

const RATIO_SIZES = {
  "1:1": [896, 896], "3:4": [768, 1024], "4:3": [1024, 768],
  "2:3": [768, 1152], "3:2": [1152, 768], "9:16": [576, 1024], "16:9": [1024, 576],
} as const;
type RoundState = { round: unknown; pending: boolean; submitted: boolean; used: boolean };
const rounds = new Map<string, RoundState>();
const REF_EXTS = new Set([".png", ".jpg", ".jpeg", ".webp", ".gif", ".bmp", ".heic", ".heif"]);
const PNG = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);

export function createDrawTool(manifest: ToolManifest, deps: ToolPackageDeps): ToolRegistration {
  const root = resolve(deps.mediaRoot);
  const realRoot = (() => { try { return realpathSync(root); } catch { return root; } })();
  const prepareRef = (raw: string): { png: Buffer; strength: number } => {
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
    const png = normalizeInitImage(real);
    if (!png) throw err(deps.prompts.messages["draw_ref_broken"]);
    return { png, strength: 0.45 };
  };

  return defineTool({
    name: manifest.name,
    description: toolFullDescription(manifest),
    callers: ["model"],
    parameters: manifestParameters<DrawArgs>(manifest),
    execute: async (args, api, context) => {
      const live = await api.snapshot(LiveDoc, api.conversationId, context);
      const round = live?.run?.inputs?.[0];
      deps.onLongWork?.("draw", round);
      const positive = args.prompt.trim();
      if (!positive || positive.length > 1000) throw new Error(deps.prompts.messages["draw_prompt"] ?? "draw_prompt");
      if (!deps.comfyUrl) throw new Error(deps.prompts.messages["draw_off"] ?? "draw_off");
      const ratio = args.ratio ?? "3:4";
      if (typeof ratio !== "string" || !Object.hasOwn(RATIO_SIZES, ratio)) throw new Error(deps.prompts.messages["draw_ratio"] ?? "draw_ratio");
      const [width, height] = RATIO_SIZES[ratio];
      if (round === undefined) throw new Error(deps.prompts.messages["draw_round_missing"] ?? "draw_round_missing");
      const previous = rounds.get(api.conversationId);
      if (previous?.pending) throw new Error(deps.prompts.messages["draw_inflight"] ?? "draw_inflight");
      if (previous?.round === round && previous.used) throw new Error(deps.prompts.messages["draw_used"] ?? "draw_used");
      if (previous?.round === round && previous.submitted) throw new Error(deps.prompts.messages["draw_uncertain"] ?? "draw_uncertain");
      const ref = args.ref !== undefined ? prepareRef(args.ref) : undefined;
      const state: RoundState = { round, pending: true, submitted: false, used: false };
      rounds.set(api.conversationId, state);
      try {
        const png = await runComfy(deps.comfyUrl, { prompt: positive, preset: args.preset, width, height, ref, bypass: deps.bypassOf?.(round) }, () => { state.submitted = true; });
        const dir = join(root, "gen");
        mkdirSync(dir, { recursive: true });
        const file = `${Date.now()}-${randomUUID()}.png`;
        writeFileSync(join(dir, file), png, { flag: "wx" });
        state.used = true;
        return { output: [{ type: "text", text: renderTemplate(deps.prompts.messages["draw_done"] ?? "gen/{{file}}", { file }) }] };
      } catch (error) {
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

/** 与旧通道相同：图片缩到受限像素预算，转换为 PNG。 */
function normalizeInitImage(full: string): Buffer | null {
  try {
    const probe = spawnSync("sips", ["-g", "pixelWidth", "-g", "pixelHeight", full], { timeout: 20_000 });
    const out = probe.status === 0 ? probe.stdout.toString() : "";
    const w = Number(/pixelWidth:\s*(\d+)/.exec(out)?.[1]);
    const h = Number(/pixelHeight:\s*(\d+)/.exec(out)?.[1]);
    if (!Number.isInteger(w) || !Number.isInteger(h) || w <= 0 || h <= 0) return null;
    const scale = Math.min(1, 1216 / Math.max(w, h), Math.sqrt((832 * 1216) / (w * h)));
    const side = (n: number) => Math.max(64, Math.floor(n / 16) * 16);
    const tmp = join(tmpdir(), `draw-init-${randomUUID()}.png`);
    let buf: Buffer;
    try {
      const conv = spawnSync("sips", ["-s", "format", "png", "-z", String(side(h * scale)), String(side(w * scale)), full, "--out", tmp], { timeout: 30_000 });
      if (conv.status !== 0) return null;
      buf = readFileSync(tmp);
    } finally { rmSync(tmp, { force: true }); }
    return buf.length >= 24 && buf.subarray(0, 8).equals(PNG) ? buf : null;
  } catch { return null; }
}
