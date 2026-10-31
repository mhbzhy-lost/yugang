/**
 * draw —— 本地 Stable Diffusion 出图（Windows 宿主机上的 SD WebUI Forge Neo）。
 *
 * 只开放 positive / negative 两项注入，模型、采样器、步数、尺寸全是预设；
 * 带 ref 时改走 img2img（初图只认媒体目录 inbound/ 或 gen/ 下的图片），出口与限次不变。
 * 图落 <mediaRoot>/gen/，出口仍走 say.media。一轮最多画一次，失败不消耗次数。
 *
 * macOS 本地网络权限不认没有责任 App 的裸 node（孤儿进程无许可，
 * 连局域网 IP 必 EHOSTUNREACH），而 Apple 签名的 /usr/bin/ssh 豁免——
 * 所以真实地址经懒加载的环回隧道中转，鱼只连 127.0.0.1。
 *
 * 说明文字与参数 Schema 唯一来自 TOOL.md manifest（factory 只消费它，不再有第二份运行时定义）。
 */
import { spawn, spawnSync } from "node:child_process";
import { mkdirSync, readFileSync, realpathSync, rmSync, statSync, writeFileSync, type Stats } from "node:fs";
import { extname, join, relative, resolve, sep } from "node:path";
import { tmpdir, userInfo } from "node:os";
import { connect } from "node:net";
import { LiveDoc, defineTool, type ToolRegistration } from "@earendil-works/pi-durable";
import { renderTemplate } from "../../prompts.ts";
import { manifestParameters, toolFullDescription } from "../manifest.ts";
import type { ToolManifest, ToolPackageDeps } from "../types.ts";

/** args 静态类型：与 TOOL.md 的参数 Schema 一一对应；运行时 Schema 只有 manifest 这一份。 */
interface DrawArgs {
  prompt: string;
  negative?: string;
  preset?: "default" | "hsr" | "secret";
  highres?: boolean;
  ref?: string;
  strength?: number;
}

const DRAWN = new Map<string, unknown>();
// 预设：质量词前置注入，模型的 prompt 附在后面；SDXL 动漫模型竖版；步数与 CFG 取 Forge 常用档。模型/采样器用 WebUI 端当前配置。
const PRESET_POSITIVE = `masterpiece, best quality, absurdres, score_7, score_8, score_9,
newest, detailed, very aesthetic, anime, cel shading, `;
const PRESET_NEGATIVE = `low quality, worst quality, score_1, score_2, score_3,
shiny skin, lips, early, old,

mature female, older female, elderly female, `;
const PRESET = { width: 832, height: 1216, steps: 28, cfg_scale: 4.5, sampler_name: "ER SDE", scheduler: "beta" };
/** 高分辨率模式（hires fix）：RealESRGAN anime_6B 放大 2 倍，二段步数 0=继承主步数，denoising 0.4，其余默认。
 *  hr_additional_modules 必须显式给 ["Use same choices"]（沿用当前模块）：Forge Neo 的 API 不传时为 None，
 *  会在采样后的换模块环节炸 TypeError（'NoneType' object is not iterable）。 */
const HIRES = { enable_hr: true, hr_upscaler: "RealESRGAN_x4plus_anime_6B", hr_scale: 2, hr_second_pass_steps: 0, denoising_strength: 0.4, hr_additional_modules: ["Use same choices"] };
/** 画风预设：追加在 positive 末尾的额外注入。 */
const PRESETS: Record<string, string> = {
  default: "",
  hsr: ", <lora:HSR Anima:0.7>",
  secret: ", completely nude",
};
const PRIVATE_RE = /^(10\.|172\.(1[6-9]|2\d|3[01])\.|192\.168\.)/;

/** img2img 初图目录白名单：相对 root 归一成 POSIX 斜杠后只认这两个前缀。 */
const REF_DIRS = ["inbound/", "gen/"];
/** img2img 初图扩展名白名单。 */
const REF_EXTS = new Set([".png", ".jpg", ".jpeg", ".webp", ".gif", ".bmp", ".heic", ".heif"]);
/** 初图原始文件大小上限。 */
const REF_MAX_BYTES = 20 * 1024 * 1024;
/** 重绘幅度：默认值与允许区间（越界/非有限数字按 tool 错误返回）。 */
const STRENGTH_DEFAULT = 0.45;
const STRENGTH_MIN = 0.1;
const STRENGTH_MAX = 0.9;
/** 初图目标像素预算与长边上限（与 PRESET 竖版同预算）；边长取 8 的倍数、最小 64。 */
const INIT_BUDGET = 832 * 1216;
const INIT_MAX_SIDE = 1216;
const INIT_MIN_SIDE = 64;
/** PNG 文件签名（8 字节），IHDR 宽高校验用。 */
const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

let tunnelChild: ReturnType<typeof spawn> | null = null;
const TUNNEL_PID = join(process.cwd(), "var", "sd-tunnel.pid");

/** 杀掉旧隧道（含跨鱼生命周期的，pidfile 记账，隧道数量恒为 1）。 */
function killStaleTunnel(): void {
  try {
    const pid = Number(readFileSync(TUNNEL_PID, "utf8").trim());
    if (Number.isFinite(pid) && pid > 0) {
      try { process.kill(pid, "SIGTERM"); } catch { /* 已死 */ }
      try { rmSync(TUNNEL_PID); } catch { /* 无妨 */ }
    }
  } catch { /* 无 pidfile */ }
  if (tunnelChild && tunnelChild.exitCode === null) tunnelChild.kill();
}

/** 懒加载环回隧道：端口活着直接复用；rebuild 强制清旧重建（半死隧道自愈用）。 */
async function ensureTunnel(realHost: string, realPort: number, localPort: number, rebuild = false): Promise<void> {
  const alive = (): Promise<boolean> =>
    new Promise((resolve) => {
      const probe = connect({ host: "127.0.0.1", port: localPort, timeout: 800 });
      probe.on("connect", () => { probe.destroy(); resolve(true); });
      probe.on("error", () => resolve(false));
      probe.on("timeout", () => { probe.destroy(); resolve(false); });
    });
  if (!rebuild && (await alive())) return;
  killStaleTunnel();
  await new Promise((r) => setTimeout(r, 300));
  tunnelChild = spawn(
    "/usr/bin/ssh",
    ["-N", "-L", `127.0.0.1:${localPort}:${realHost}:${realPort}`, "-o", "BatchMode=yes", "-o", "ExitOnForwardFailure=yes", "-o", "ServerAliveInterval=30", `${userInfo().username}@127.0.0.1`],
    { detached: true, stdio: "ignore" },
  );
  tunnelChild.unref();
  if (tunnelChild.pid) {
    try { mkdirSync(join(process.cwd(), "var"), { recursive: true }); writeFileSync(TUNNEL_PID, String(tunnelChild.pid)); } catch { /* 无妨 */ }
  }
  for (let i = 0; i < 16; i++) {
    await new Promise((r) => setTimeout(r, 500));
    if (await alive()) return;
  }
  throw new Error("tunnel not ready");
}

export function createDrawTool(manifest: ToolManifest, deps: ToolPackageDeps): ToolRegistration {
  const timeoutMs = 180_000;
  const doFetch = fetch;
  const outDir = join(deps.mediaRoot, "gen");
  const root = resolve(deps.mediaRoot);
  // 真实根：macOS 的 /var、/tmp 本身是符号链接（如 /var/folders 实为 /private/var/folders），realpath 比较必须用解过的根
  const realRoot = (() => { try { return realpathSync(root); } catch { return root; } })();

  /**
   * 带 ref 的全部前置校验 + 初图归一化。所有失败都以 tool 错误返回（发生在 POST 之前，
   * 不消耗本轮 draw 次数）；strength 只对改图生效，没带 ref 时静默忽略。
   */
  const prepareRef = (raw: string, requested?: number): { init: InitImage; strength: number } => {
    const ref = raw.trim().replace(/^\[|\]$/g, "");
    const full = resolve(root, ref);
    const rel = relative(root, full).split(sep).join("/");
    const refError = (template: string): Error => new Error(renderTemplate(template, { ref }));
    // 必须落在 root 内，且归一后带白名单目录前缀；realpath 复核真实路径防符号链接逃逸
    if (full !== root && !full.startsWith(root + sep)) throw refError(deps.prompts.messages["draw_ref_outside"] ?? "{{ref}}");
    if (!REF_DIRS.some((d) => rel.startsWith(d))) throw refError(deps.prompts.messages["draw_ref_outside"] ?? "{{ref}}");
    let real = "";
    try { real = realpathSync(full); } catch { /* 读不到按不存在处理 */ }
    if (!real) throw refError(deps.prompts.messages["draw_ref_missing"] ?? "{{ref}}");
    if (real !== realRoot && !real.startsWith(realRoot + sep)) throw refError(deps.prompts.messages["draw_ref_outside"] ?? "{{ref}}");
    let st: Stats | null = null;
    try { st = statSync(full); } catch { /* 读不到按不存在处理 */ }
    if (!st || !st.isFile()) throw refError(deps.prompts.messages["draw_ref_missing"] ?? "{{ref}}");
    if (!REF_EXTS.has(extname(full).toLowerCase())) throw refError(deps.prompts.messages["draw_ref_type"] ?? "{{ref}}");
    if (st.size > REF_MAX_BYTES) throw refError(deps.prompts.messages["draw_ref_big"] ?? "{{ref}}");
    let strength = STRENGTH_DEFAULT;
    if (requested !== undefined) {
      if (!Number.isFinite(requested) || requested < STRENGTH_MIN || requested > STRENGTH_MAX) {
        throw new Error(deps.prompts.messages["draw_strength"] ?? "draw_strength");
      }
      strength = requested;
    }
    const init = normalizeInitImage(full);
    if (!init) throw refError(deps.prompts.messages["draw_ref_broken"] ?? "{{ref}}");
    return { init, strength };
  };

  return defineTool({
    name: manifest.name,
    description: toolFullDescription(manifest),
    callers: ["model"],
    parameters: manifestParameters<DrawArgs>(manifest),
    execute: async (args, api, context) => {
      const positive = args.prompt.trim();
      if (!positive || positive.length > 1000) {
        throw new Error(deps.prompts.messages["draw_prompt"] ?? "draw_prompt");
      }
      if (!deps.sdUrl) throw new Error(deps.prompts.messages["draw_off"] ?? "draw_off");

      const live = await api.snapshot(LiveDoc, api.conversationId, context);
      const round = live?.run?.inputs?.[0];
      if (round !== undefined && DRAWN.get(api.conversationId) === round) {
        throw new Error(deps.prompts.messages["draw_used"] ?? "draw_used");
      }
      const stash = round !== undefined ? deps.bypassOf?.(round) : undefined;

      // 带 ref：校验与初图归一化都在 POST 之前完成，失败以 tool 错误返回，不消耗本轮次数；
      // strength 只对改图生效，没带 ref 时静默忽略
      const prepared = args.ref !== undefined ? prepareRef(args.ref, args.strength) : null;
      const init = prepared?.init ?? null;
      const strength = prepared?.strength ?? STRENGTH_DEFAULT;
      if (init && args.highres) console.log("[fish] draw: ref given, highres ignored (txt2img only)");

      // 本地 SD 出图；没配地址、隧道不通、HTTP 非 2xx、无图都算失败，交给外层兜底
      const drawLocal = async (): Promise<string> => {
        if (!deps.sdUrl) throw new Error("no local sd url");
        // 私网真实地址走环回隧道；公网地址直连
        const realUrl = new URL(deps.sdUrl);
        const realHost = realUrl.hostname;
        const realPort = Number(realUrl.port || 80);
        const localPort = Number(process.env.SD_TUNNEL_PORT ?? 7861);
        const useTunnel = PRIVATE_RE.test(realHost) && realHost !== "127.0.0.1";
        if (useTunnel) await ensureTunnel(realHost, realPort, localPort);
        // 按端点拼一次：无 ref → txt2img，带 ref → img2img
        const endpoint = init ? "img2img" : "txt2img";
        const target = useTunnel ? `http://127.0.0.1:${localPort}/sdapi/v1/${endpoint}` : `${deps.sdUrl}/sdapi/v1/${endpoint}`;

        const positivePrompt = PRESET_POSITIVE + positive + (PRESETS[args.preset ?? "default"] ?? "") + (stash ? `, ${stash}` : "");
        const negativePrompt = PRESET_NEGATIVE + (args.negative ?? "").trim();
        // 无 ref：与历史 txt2img 逐字段一致，highres 只在这一支生效；
        // 有 ref：img2img 请求模型里没有 enable_hr/hr_* 字段（发了也被忽略），所以不带 HIRES；
        // 先 ...PRESET 再覆盖宽高，别让预设的 832×1216 盖掉按初图算出的尺寸
        const body = JSON.stringify(
          init
            ? {
                init_images: [init.b64],
                prompt: positivePrompt,
                negative_prompt: negativePrompt,
                ...PRESET,
                width: init.width,
                height: init.height,
                denoising_strength: strength,
                resize_mode: 1,
                batch_size: 1,
                n_iter: 1,
                seed: -1,
                send_images: true,
              }
            : {
                prompt: positivePrompt,
                negative_prompt: negativePrompt,
                ...PRESET,
                ...(args.highres ? HIRES : {}),
              },
        );
        const post = async (): Promise<string> => {
          let last: unknown;
          for (let i = 0; i < 3; i++) {
            try {
              const res = await doFetch(target, {
                method: "POST",
                headers: { "content-type": "application/json" },
                body,
                signal: AbortSignal.timeout(timeoutMs),
              });
              if (!res.ok) throw new Error(`HTTP ${res.status}`);
              return await res.text();
            } catch (e) { last = e; await new Promise((r) => setTimeout(r, 2000)); }
          }
          throw last;
        };

        let raw: string;
        try {
          raw = await post();
        } catch (first) {
          // 半死隧道自愈：Windows 重启后 ssh 还在听但转发已死——重建隧道再来一轮
          if (useTunnel && first instanceof Error && !/^HTTP /.test(first.message)) {
            await ensureTunnel(realHost, realPort, localPort, true);
            raw = await post();
          } else {
            throw first;
          }
        }
        const j = JSON.parse(raw) as { images?: string[] };
        const b64 = j.images?.[0];
        if (!b64) throw new Error("no image");

        mkdirSync(outDir, { recursive: true });
        const file = `${Date.now()}-${Math.random().toString(16).slice(2, 8)}.png`;
        writeFileSync(join(outDir, file), Buffer.from(b64, "base64"));
        return file;
      };

      try {
        const file = await drawLocal();
        if (round !== undefined) DRAWN.set(api.conversationId, round);
        console.log(`[fish] draw ok: ${positive.slice(0, 40)}${stash ? " (+bypass)" : ""}`);
        return {
          output: [{ type: "text", text: renderTemplate(deps.prompts.messages["draw_done"] ?? "gen/{{file}}", { file }) }],
        };
      } catch (error) {
        const detail = error instanceof Error ? error.message : "unknown";
        console.error(`[fish] draw failed: ${detail}`);
        throw new Error((deps.prompts.messages["draw_failed"] ?? "draw_failed") + `: ${detail}`);
      }
    },
  });
}

/** 初图归一化结果：纯 base64（不带 data: 前缀）+ 发给服务端的最终尺寸。 */
interface InitImage {
  b64: string;
  width: number;
  height: number;
}

/** 边长向下取到 8 的倍数、最小 64（服务端也会对尺寸向下取整，工具端自己算准）。 */
function side8(n: number): number {
  return Math.max(INIT_MIN_SIDE, Math.floor(n / 8) * 8);
}

/**
 * 初图归一化：sips 两步——先读原始像素宽高（不依赖扩展名，HEIC/GIF 都认），
 * 再按预算缩放并转 PNG 写临时文件（GIF 取首帧、HEIC/BMP 归一，透明底/EXIF 交给服务端处理），
 * 最后从输出 PNG 的 IHDR 读真实宽高（sips 实际输出可能偏离请求值）。任何一步失败返回 null。
 */
function normalizeInitImage(full: string): InitImage | null {
  try {
    const probe = spawnSync("sips", ["-g", "pixelWidth", "-g", "pixelHeight", full], { timeout: 20_000 });
    const out = probe.status === 0 ? probe.stdout.toString() : "";
    const w = Number(/pixelWidth:\s*(\d+)/.exec(out)?.[1]);
    const h = Number(/pixelHeight:\s*(\d+)/.exec(out)?.[1]);
    if (!Number.isInteger(w) || !Number.isInteger(h) || w <= 0 || h <= 0) return null;
    // 不放大：长边封顶、总像素不超预算；边长向下取到 8 的倍数、最小 64
    const scale = Math.min(1, INIT_MAX_SIDE / Math.max(w, h), Math.sqrt(INIT_BUDGET / (w * h)));
    const tw = side8(w * scale);
    const th = side8(h * scale);
    const tmp = join(tmpdir(), `draw-init-${Date.now()}-${Math.random().toString(16).slice(2, 8)}.png`);
    let buf: Buffer;
    try {
      const conv = spawnSync("sips", ["-s", "format", "png", "-z", String(th), String(tw), full, "--out", tmp], { timeout: 30_000 });
      if (conv.status !== 0) return null;
      buf = readFileSync(tmp);
    } finally {
      try { rmSync(tmp, { force: true }); } catch { /* 读完即删，删不掉也无妨 */ }
    }
    if (buf.length < 24 || !buf.subarray(0, 8).equals(PNG_SIGNATURE)) return null;
    // 8 字节签名后跳过 IHDR 的长度与类型，offset 16/20 是大端 uint32 的宽/高
    return { b64: buf.toString("base64"), width: side8(buf.readUInt32BE(16)), height: side8(buf.readUInt32BE(20)) };
  } catch {
    return null;
  }
}
