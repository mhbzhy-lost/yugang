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
import { loraBook, styleBook } from "../characters.ts";
import { ComfyBusy, ComfyExecutionFailed, runComfy, runMulti, type ComfyDraw, type DrawStage, type MultiPart } from "./comfy.ts";

interface DrawArgs {
  prompt: string;
  style?: string;
  ratio?: keyof typeof RATIO_SIZES;
  hand_repair?: boolean;
  hd?: boolean;
  ref?: string;
  character?: string;
  characters?: Array<{ character?: string; description: string; region?: { x: number; y: number; width: number; height: number } }>;
}

const RATIO_SIZES = {
  "1:1": [1056, 1056], "3:4": [912, 1216], "4:3": [1216, 912],
  "2:3": [832, 1248], "3:2": [1248, 832], "9:16": [720, 1280], "16:9": [1280, 720],
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
      // 自定义画图模式（2026-11-10）：用户明确要时 prompt 可为空串，内容全部由角色词表/机械前缀承担；
      // 只限长度，不退非空。
      if (typeof args.prompt !== "string" || positive.length > 1000) throw new Error(deps.prompts.messages["draw_prompt"] ?? "draw_prompt");
      if (!deps.comfyUrl) throw new Error(deps.prompts.messages["draw_off"] ?? "draw_off");
      if (args.hand_repair !== undefined && typeof args.hand_repair !== "boolean") throw new Error(deps.prompts.messages["draw_hand_repair"] ?? "draw_hand_repair");
      if (args.hd !== undefined && typeof args.hd !== "boolean") throw new Error(deps.prompts.messages["draw_hd"] ?? "draw_hd");
      const ratio = args.ratio ?? "3:4";
      if (typeof ratio !== "string" || !Object.hasOwn(RATIO_SIZES, ratio)) throw new Error(deps.prompts.messages["draw_ratio"] ?? "draw_ratio");
      const [width, height] = RATIO_SIZES[ratio];
      let lora: ComfyDraw["lora"];
      if (args.character !== undefined) {
        const book = loraBook(args.character);
        if (!book) throw new Error(renderTemplate(deps.prompts.messages["draw_character"] ?? "{{key}}", { key: args.character }));
        lora = { file: book.file, weight: book.weight, inject: book.inject };
      }
      let style: ComfyDraw["style"];
      if (args.style !== undefined) {
        const book = styleBook(args.style);
        if (!book) throw new Error(renderTemplate(deps.prompts.messages["draw_style"] ?? "{{key}}", { key: args.style }));
        style = book;
      }
      // 双人唯一入口：characters 两项 → 一律 RS 区域管线（2026-11-11 主人裁定：不做任何路由判断）。
      let multiParts: MultiPart[] | undefined;
      if (args.characters !== undefined) {
        if (args.character !== undefined) throw new Error(deps.prompts.messages["draw_characters_conflict"] ?? "draw_characters_conflict");
        if (args.style !== undefined || args.ref !== undefined) throw new Error(deps.prompts.messages["draw_multi_unsupported"] ?? "draw_multi_unsupported");
        if (!Array.isArray(args.characters) || args.characters.length !== 2) throw new Error(deps.prompts.messages["draw_characters_count"] ?? "draw_characters_count");
        if (args.characters.some((part) => !part || typeof part !== "object" || typeof part.description !== "string" || !part.description.trim())) throw new Error(deps.prompts.messages["draw_multi_sides"] ?? "draw_multi_sides");
        multiParts = args.characters.map((part, index) => {
          const book = part.character === undefined ? undefined : loraBook(part.character);
          if (part.character !== undefined && !book) throw new Error(renderTemplate(deps.prompts.messages["draw_character"] ?? "{{key}}", { key: part.character }));
          const region = typeof part.region === "object" && part.region !== null && ["x", "y", "width", "height"].every((k) => typeof (part.region as Record<string, unknown>)[k] === "number")
            ? { x: Number(part.region.x), y: Number(part.region.y), width: Number(part.region.width), height: Number(part.region.height) }
            : undefined;
          return { text: part.description.trim(), ...(book ? { role: { file: book.file, weight: book.weight, inject: book.inject } } : {}), ...(region ? { region } : {}) };
        });
      }
      if (round === undefined) throw new Error(deps.prompts.messages["draw_round_missing"] ?? "draw_round_missing");
      const previous = rounds.get(api.conversationId);
      if (previous?.pending) throw new Error(deps.prompts.messages["draw_inflight"] ?? "draw_inflight");
      if (previous?.round === round && previous.used) throw new Error(deps.prompts.messages["draw_used"] ?? "draw_used");
      if (previous?.round === round && previous.submitted) throw new Error(deps.prompts.messages["draw_uncertain"] ?? "draw_uncertain");
      const ref = args.ref !== undefined ? prepareRef(args.ref) : undefined;
      const state: RoundState = { round, pending: true, submitted: false, used: false };
      rounds.set(api.conversationId, state);
      try {
        const stageCb = deps.onDrawStage && round !== undefined ? (stage: DrawStage) => deps.onDrawStage?.(round, stage) : undefined;
        const bp = deps.bypassOf?.(round);
        const png = multiParts
          ? await runMulti(deps.comfyUrl, { prompt: positive, width, height, parts: multiParts, hd: args.hd === true, bypass: bp?.bypass, pbypass: bp?.pbypass }, () => { state.submitted = true; })
          : await runComfy(deps.comfyUrl, { prompt: positive, style, width, height, handRepair: args.hand_repair ?? false, hd: args.hd === true, ref, lora, bypass: bp?.bypass, bypassP: bp?.pbypass }, () => { state.submitted = true; }, stageCb);
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
