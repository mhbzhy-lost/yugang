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
import { ComfyBusy, ComfyExecutionFailed, runComfy, runMulti, type ComfyDraw, type DrawStage, type MultiPart } from "./comfy.ts";

interface DrawArgs {
  prompt: string;
  preset?: "default" | "hsr" | "secret";
  ratio?: keyof typeof RATIO_SIZES;
  hand_repair?: boolean;
  ref?: string;
  character?: string;
  lora_weight?: number;
  characters?: string[];
  left?: string;
  right?: string;
}

const RATIO_SIZES = {
  "1:1": [1056, 1056], "3:4": [912, 1216], "4:3": [1216, 912],
  "2:3": [832, 1248], "3:2": [1248, 832], "9:16": [720, 1280], "16:9": [1280, 720],
} as const;
/** AI 娘角色白名单：key = schema 的 character 枚举；tags = 触发词 + 基础外观 + 头饰（基础三件套，服装不注入）。完整官方 tag 可查 tags 工具。 */
const CHARACTERS = {
  claude: { lora: "claude_girl_anima_lora_clean.safetensors", tags: "claude_girl, orange hair, very long hair, wavy hair, bangs, orange eyes, hair flower, hair bow, black bow" },
  deepseek: { lora: "aigrilsV1.0.safetensors", tags: "aigirls, aigirls（deepseek）, 1girl, solo, blue hair, gradient hair, very long hair, wavy hair, ahoge, blue eyes, fins, cetacean tail, maid headdress, blue ribbon" },
  qwen: { lora: "aigrilsV1.0.safetensors", tags: "aigirls, aigirls（qwen）, 1girl, solo, blue hair, purple hair, gradient hair, very long hair, single braid, purple eyes, mini hat, hat ornament, braid bow, blue tassel, gold earrings" },
  glm: { lora: "aigrilsV1.0.safetensors", tags: "aigirls, aigirls（glm）, 1girl, solo, black hair, very long hair, black eyes, fox ears, fox tail, sleep mask, Z hair ornament, hair bell, white lace headdress, tassel" },
  kimi: { lora: "aigrilsV1.0.safetensors", tags: "aigirls, aigirls（kimi）, 1girl, solo, white hair, light blue hair, gradient hair, very long hair, blue eyes, white frilled headdress, navy hair bow, silver crescent, rainbow triangle, musical note, K hair ornament" },
  gpt: { lora: "aigrilsV1.0.safetensors", tags: "aigirls, aigirls（gpt）, 1girl, solo, white hair, very long hair, ahoge, purple eyes, dragon horns, dragon wings, dragon tail, flower knot, tassel, earrings" },
  gemini: { lora: "aigrilsV1.0.safetensors", tags: "aigirls, aigirls（gemini）, 1girl, solo, blue hair, purple hair, gradient hair, very long hair, hair bun, double bun, ahoge, heterochromia, red eyes, yellow eyes, cat ears, cat tail, star hair ornament, star earrings" },
  grok: { lora: "aigrilsV1.0.safetensors", tags: "aigirls, aigirls（grok）, 1girl, solo, blonde hair, very long hair, twintails, ahoge, blue eyes, slit pupils, pointy ears, fangs, vampire, black crown, gold crescent, bat wings, black hair bow" },
} as const;
const LORA_WEIGHT_RANGE = [0.4, 1.1] as const;
type RoundState = { round: unknown; pending: boolean; submitted: boolean; used: boolean };
const rounds = new Map<string, RoundState>();
const REF_EXTS = new Set([".png", ".jpg", ".jpeg", ".webp", ".gif", ".bmp", ".heic", ".heif"]);
const PNG = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);

export function createDrawTool(manifest: ToolManifest, deps: ToolPackageDeps): ToolRegistration {
  // 启动一致性校验：schema 的 character 枚举（含 characters.items.enum）与 CHARACTERS 键集必须严格一致，漂移直接起不来。
  const properties = (manifest.parameters as { properties?: Record<string, { enum?: unknown[]; items?: { enum?: unknown[] } }> } | undefined)?.properties;
  const enumValues = properties?.character?.enum;
  const itemValues = properties?.characters?.items?.enum;
  const keys = Object.keys(CHARACTERS);
  const same = (list: unknown) => Array.isArray(list) && list.length === keys.length && list.every((v) => Object.hasOwn(CHARACTERS, v as string));
  if (!same(enumValues) || !same(itemValues)) throw new Error("draw character enum mismatch");
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
      if (args.hand_repair !== undefined && typeof args.hand_repair !== "boolean") throw new Error(deps.prompts.messages["draw_hand_repair"] ?? "draw_hand_repair");
      const ratio = args.ratio ?? "3:4";
      if (typeof ratio !== "string" || !Object.hasOwn(RATIO_SIZES, ratio)) throw new Error(deps.prompts.messages["draw_ratio"] ?? "draw_ratio");
      const [width, height] = RATIO_SIZES[ratio];
      let lora: ComfyDraw["lora"];
      if (args.character !== undefined) {
        const book = CHARACTERS[args.character as keyof typeof CHARACTERS];
        if (!book) throw new Error(renderTemplate(deps.prompts.messages["draw_character"] ?? "{{list}}", { list: keys.join("、") }));
        const weight = args.lora_weight ?? 0.8;
        if (typeof weight !== "number" || !Number.isFinite(weight) || weight < LORA_WEIGHT_RANGE[0] || weight > LORA_WEIGHT_RANGE[1]) throw new Error(deps.prompts.messages["draw_lora_weight"] ?? "draw_lora_weight");
        lora = { file: book.lora, weight, tags: book.tags };
      }
      // ── 多角色分支：characters（AI 娘双人）或 left/right（自由双区）──
      const wantsMulti = args.characters !== undefined || args.left !== undefined || args.right !== undefined;
      let multiParts: MultiPart[] | undefined;
      if (wantsMulti) {
        if (args.character !== undefined) throw new Error(deps.prompts.messages["draw_characters_conflict"] ?? "draw_characters_conflict");
        if (args.preset !== undefined || args.ref !== undefined) throw new Error(deps.prompts.messages["draw_multi_unsupported"] ?? "draw_multi_unsupported");
        if (!args.left?.trim() || !args.right?.trim()) throw new Error(deps.prompts.messages["draw_multi_sides"] ?? "draw_multi_sides");
        let roles: (typeof CHARACTERS)[keyof typeof CHARACTERS] | undefined[] = [];
        if (args.characters !== undefined) {
          if (!Array.isArray(args.characters) || args.characters.length !== 2) throw new Error(deps.prompts.messages["draw_characters_count"] ?? "draw_characters_count");
          roles = args.characters.map((name) => {
            const book = CHARACTERS[name as keyof typeof CHARACTERS];
            if (!book) throw new Error(renderTemplate(deps.prompts.messages["draw_character"] ?? "{{list}}", { list: keys.join("、") }));
            return book;
          });
        }
        const weight = args.lora_weight ?? 0.8;
        if (typeof weight !== "number" || !Number.isFinite(weight) || weight < LORA_WEIGHT_RANGE[0] || weight > LORA_WEIGHT_RANGE[1]) throw new Error(deps.prompts.messages["draw_lora_weight"] ?? "draw_lora_weight");
        multiParts = [0, 1].map((i) => ({
          text: (i === 0 ? args.left : args.right)!.trim(),
          ...(roles[i] ? { role: { file: (roles[i] as { lora: string }).lora, weight, tags: (roles[i] as { tags: string }).tags } } : {}),
        }));
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
        const png = multiParts
          ? await runMulti(deps.comfyUrl, { prompt: positive, width, height, parts: multiParts, handRepair: args.hand_repair ?? false }, () => { state.submitted = true; }, stageCb)
          : await runComfy(deps.comfyUrl, { prompt: positive, preset: args.preset, width, height, handRepair: args.hand_repair ?? false, ref, lora, bypass: deps.bypassOf?.(round) }, () => { state.submitted = true; }, stageCb);
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
