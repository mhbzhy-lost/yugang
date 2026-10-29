/**
 * draw —— 本地 Stable Diffusion 出图（Windows 宿主机上的 SD WebUI Forge Neo）。
 *
 * 只开放 positive / negative 两项注入，模型、采样器、步数、尺寸全是预设，
 * 不让模型自己调参。图落 <mediaRoot>/gen/，出口仍走 say.media。
 * 一轮最多画一次，失败不消耗次数。
 */
import { request } from "node:http";
import { spawn } from "node:child_process";
import { connect } from "node:net";
import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
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
// 预设：质量词前置注入，模型的 prompt 附在后面；SDXL 动漫模型竖版；步数与 CFG 取 Forge 常用档。模型/采样器用 WebUI 端当前配置。
const PRESET_POSITIVE = "masterpiece, best quality, score_7, score_8, score_9, (anime:1.2), ";
const PRESET_NEGATIVE = "low quality, worst quality, score_1, score_2, score_3, early, old, shiny skin, ";
const PRESET = { width: 832, height: 1216, steps: 28, cfg_scale: 4.5 };


/** 懒加载环回隧道：macOS 本地网络权限不认裸 node（孤儿进程无责任 App），
 *  Apple 签名的 /usr/bin/ssh 豁免——draw 时拉起 ssh -L 常驻，鱼只连 127.0.0.1。
 *  隧道进程孤儿化也豁免，崩了下一次 draw 会重建。 */
let tunnelChild: ReturnType<typeof spawn> | null = null;
const TUNNEL_PID = join(process.cwd(), "var", "sd-tunnel.pid");

/** 读 pidfile 杀掉跨鱼生命周期的旧隧道（钉死隧道数量恒为 1）。 */
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

function ensureTunnel(realHost: string, realPort: number, localPort: number, rebuild = false): Promise<void> {
  const tryPort = (): Promise<boolean> =>
    new Promise((resolve) => {
      const probe = connect({ host: "127.0.0.1", port: localPort, timeout: 800 });
      probe.on("connect", () => { probe.destroy(); resolve(true); });
      probe.on("error", () => resolve(false));
      probe.on("timeout", () => { probe.destroy(); resolve(false); });
    });
  return (async (): Promise<void> => {
    if (!rebuild && await tryPort()) return;
    // rebuild 或端口不通：先清旧（含半死隧道——ssh 活着但转发目标已死时端口仍会被接受，
    // 只有请求层失败才能发现，所以 draw 的失败路径会带 rebuild=true 重来一次）
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
      if (await tryPort()) return;
    }
    throw new Error("tunnel not ready");
  })();
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
      if (!deps.baseUrl) {
        throw new Error(deps.prompts.messages["draw_off"] ?? "draw_off");
      }
      // 真实地址走环回隧道（懒加载），WebUI 地址仅用来取 host/port
      const realUrl = new URL(deps.baseUrl);
      const realHost = realUrl.hostname;
      const realPort = Number(realUrl.port || 80);
      const localPort = Number(process.env.SD_TUNNEL_PORT ?? 7861);
      if (/^(10\.|172\.(1[6-9]|2\d|3[01])\.|192\.168\.)/.test(realHost) && realHost !== "127.0.0.1") {
        await ensureTunnel(realHost, realPort, localPort);
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
      // 裸 http 绕开 undici：活体进程里 fetch 对局域网稳定 EHOSTUNREACH，裸 socket 全通
      const post = async (): Promise<string> => {
        const useTunnel = /^(10\.|172\.(1[6-9]|2\d|3[01])\.|192\.168\.)/.test(realHost) && realHost !== "127.0.0.1";
        const u = useTunnel ? new URL(`http://127.0.0.1:${localPort}/sdapi/v1/txt2img`) : new URL(`${deps.baseUrl}/sdapi/v1/txt2img`);
        const body = JSON.stringify({
          prompt: PRESET_POSITIVE + positive,
          negative_prompt: PRESET_NEGATIVE + (args.negative ?? "").trim(),
          ...PRESET,
        });
        let last: unknown;
        for (let i = 0; i < 3; i++) {
          try {
            return await new Promise<string>((resolve, reject) => {
              const req = request(
                { host: u.hostname, port: Number(u.port || 80), path: u.pathname, method: "POST", timeout: 120_000, headers: { "content-type": "application/json" } },
                (res) => {
                  const chunks: Buffer[] = [];
                  res.on("data", (c: Buffer) => chunks.push(c));
                  res.on("end", () => {
                    if ((res.statusCode ?? 500) >= 400) reject(new Error(`HTTP ${res.statusCode}`));
                    else resolve(Buffer.concat(chunks).toString("utf8"));
                  });
                },
              );
              req.on("timeout", () => { req.destroy(); reject(new Error("timeout")); });
              req.on("error", reject);
              req.end(body);
            });
          } catch (e) { last = e; await new Promise((r) => setTimeout(r, 2000)); }
        }
        throw last;
      };
      try {
        let raw: string;
        try {
          raw = await post();
        } catch (first) {
          // 半死隧道自愈：请求失败但隧道端口还在听（Windows 重启后的典型态）——强制重建再来一次
          const halfDead = first instanceof Error && !/^HTTP /.test(first.message);
          if (!halfDead) throw first;
          await ensureTunnel(realHost, realPort, localPort, true);
          raw = await post();
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
          output: [{
            type: "text",
            text: renderTemplate(deps.prompts.messages["draw_done"] ?? "gen/{{file}}", { file }),
          }],
        };
      } catch (error) {
        console.error(`[fish] draw error: ${error instanceof Error ? error.message : "unknown"}`);
        throw new Error((deps.prompts.messages["draw_failed"] ?? "draw_failed") + `: ${error instanceof Error ? error.message : "unknown"}`);
      } finally {
        clearTimeout(timer);
      }
    },
  });
}
