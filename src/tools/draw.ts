/**
 * draw —— 本地 Stable Diffusion 出图（Windows 宿主机上的 SD WebUI Forge Neo）。
 *
 * 只开放 positive / negative 两项注入，模型、采样器、步数、尺寸全是预设。
 * 图落 <mediaRoot>/gen/，出口仍走 say.media。一轮最多画一次，失败不消耗次数。
 *
 * macOS 本地网络权限不认没有责任 App 的裸 node（孤儿进程无许可，
 * 连局域网 IP 必 EHOSTUNREACH），而 Apple 签名的 /usr/bin/ssh 豁免——
 * 所以真实地址经懒加载的环回隧道中转，鱼只连 127.0.0.1。
 */
import { spawn } from "node:child_process";
import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { connect } from "node:net";
import { Type } from "@earendil-works/pi-ai";
import { LiveDoc, defineTool } from "@earendil-works/pi-durable";
import { renderTemplate, requireTool, type PromptSet } from "../prompts.ts";

export interface DrawDeps {
  prompts: PromptSet;
  mediaRoot: string;
  /** SD WebUI 的 baseUrl，如 http://SD_LAN_HOST:7860 */
  baseUrl: string;
  timeoutMs?: number;
  fetchImpl?: typeof fetch;
}

const DRAWN = new Map<string, unknown>();
// 预设：质量词前置注入，模型的 prompt 附在后面；SDXL 动漫模型竖版；步数与 CFG 取 Forge 常用档。模型/采样器用 WebUI 端当前配置。
const PRESET_POSITIVE = "masterpiece, best quality, score_7, score_8, score_9, (anime:1.2), ";
const PRESET_NEGATIVE = "low quality, worst quality, score_1, score_2, score_3, early, old, shiny skin, ";
const PRESET = { width: 832, height: 1216, steps: 28, cfg_scale: 4.5 };
const PRIVATE_RE = /^(10\.|172\.(1[6-9]|2\d|3[01])\.|192\.168\.)/;

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
    ["-N", "-L", `127.0.0.1:${localPort}:${realHost}:${realPort}`, "-o", "BatchMode=yes", "-o", "ExitOnForwardFailure=yes", "-o", "ServerAliveInterval=30", `${process.env.USER ?? "macmini-user"}@127.0.0.1`],
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
      const positive = args.prompt.trim();
      if (!positive || positive.length > 1000) {
        throw new Error(deps.prompts.messages["draw_prompt"] ?? "draw_prompt");
      }
      if (!deps.baseUrl) {
        throw new Error(deps.prompts.messages["draw_off"] ?? "draw_off");
      }

      const live = await api.snapshot(LiveDoc, api.conversationId, context);
      const round = live?.run?.inputs?.[0];
      if (round !== undefined && DRAWN.get(api.conversationId) === round) {
        throw new Error(deps.prompts.messages["draw_used"] ?? "draw_used");
      }

      // 私网真实地址走环回隧道；公网地址直连
      const realUrl = new URL(deps.baseUrl);
      const realHost = realUrl.hostname;
      const realPort = Number(realUrl.port || 80);
      const localPort = Number(process.env.SD_TUNNEL_PORT ?? 7861);
      const useTunnel = PRIVATE_RE.test(realHost) && realHost !== "127.0.0.1";
      if (useTunnel) await ensureTunnel(realHost, realPort, localPort);
      const target = useTunnel ? `http://127.0.0.1:${localPort}/sdapi/v1/txt2img` : `${deps.baseUrl}/sdapi/v1/txt2img`;

      const body = JSON.stringify({
        prompt: PRESET_POSITIVE + positive,
        negative_prompt: PRESET_NEGATIVE + (args.negative ?? "").trim(),
        ...PRESET,
      });
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

      try {
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
        if (round !== undefined) DRAWN.set(api.conversationId, round);
        console.log(`[fish] draw ok: ${positive.slice(0, 40)}`);
        return {
          output: [{ type: "text", text: renderTemplate(deps.prompts.messages["draw_done"] ?? "gen/{{file}}", { file }) }],
        };
      } catch (error) {
        console.error(`[fish] draw error: ${error instanceof Error ? error.message : "unknown"}`);
        throw new Error((deps.prompts.messages["draw_failed"] ?? "draw_failed") + `: ${error instanceof Error ? error.message : "unknown"}`);
      }
    },
  });
}
