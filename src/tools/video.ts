/**
 * video —— 看一眼 B 站视频。
 *
 * 模型看不了视频流，所以这里做三件事，产出**纯文本**：
 *   1. 元数据：标题 / UP 主 / 时长 / 简介 / 热评
 *   2. 弹幕：按密度取高光时刻，顺带摘几条有梗的
 *   3. 关键帧：下最省的视频轨（360p），按「弹幕峰值 + 均匀」抽 6 帧，
 *      每帧交给视觉模型描述成文字（图不进主会话，理由同 look）
 *
 * 不做全量转写（费时且与「聊天里随口一句」不匹配）；没有台词，
 * 所以 prompt 里要求鱼别说成看完整个视频。
 *
 * 时长上限 30 分钟：超了只取前 30 分钟，并明确告诉鱼这是截断的。
 */
import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { Type, type Models } from "@earendil-works/pi-ai";
import { LiveDoc, defineTool } from "@earendil-works/pi-durable";
import { renderTemplate, requireTool, type PromptSet } from "../prompts.ts";
import { describeImage } from "../media/describe.ts";

export interface VideoDeps {
  prompts: PromptSet;
  /** 视觉描述用（缺省不抽帧，只给元数据与弹幕） */
  models?: Models;
  visionModel?: { provider: string; modelId: string };
  /** 抽帧脚本用的 python（装了 PyAV）；缺省 ~/tts/.venv-video/bin/python */
  pythonPath?: string;
  /** 抽帧脚本路径；缺省 <cwd>/scripts/video-frames.py */
  scriptPath?: string;
  fetchImpl?: typeof fetch;
  timeoutMs?: number;
  /** 只看前 N 分钟（超长视频截断），默认 30。 */
  maxMinutes?: number;
  /** 抽几帧，默认 6。 */
  frames?: number;
}

const USED = new Map<string, unknown>(); // conversationId → 本轮已用的轮标识
const HEADERS = { "user-agent": "Mozilla/5.0", referer: "https://www.bilibili.com/" };

/**
 * 清理上次崩溃/重启留下的抽帧临时目录。
 * 正常的临时目录在 finally 里就删了，但进程被 SIGKILL/部署重启打断时会残留。
 */
export function cleanupStaleVideoTemps(): void {
  try {
    for (const name of readdirSync(tmpdir())) {
      if (!name.startsWith("yg-video-")) continue;
      const path = join(tmpdir(), name);
      try {
        const age = Date.now() - statSync(path).mtimeMs;
        if (age > 60 * 60_000) rmSync(path, { recursive: true, force: true });
      } catch {
        // 单个目录删不掉不影响启动
      }
    }
  } catch {
    // 临时目录读不了就算了
  }
}

interface Frame {
  time: number;
  path: string;
}

export function createVideoTool(deps: VideoDeps) {
  const prompt = requireTool(deps.prompts, "video");
  const doFetch = deps.fetchImpl ?? fetch;
  const timeoutMs = deps.timeoutMs ?? 20_000;
  const maxMinutes = deps.maxMinutes ?? 30;
  const frameCount = deps.frames ?? 6;
  const pythonPath = deps.pythonPath ?? process.env["VIDEO_PYTHON"] ?? join(homedir(), "tts", ".venv-video", "bin", "python");
  const scriptPath = deps.scriptPath ?? join(process.cwd(), "scripts", "video-frames.py");

  async function getJson(url: string): Promise<any> {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), timeoutMs);
    try {
      const res = await doFetch(url, { headers: HEADERS, signal: ctrl.signal });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      return await res.json();
    } finally {
      clearTimeout(timer);
    }
  }

  /** 弹幕 XML → {time, text}[]；拿不到返回空数组（不影响主流程）。 */
  async function fetchDanmaku(cid: string): Promise<{ time: number; text: string }[]> {
    try {
      const ctrl = new AbortController();
      const timer = setTimeout(() => ctrl.abort(), timeoutMs);
      try {
        const res = await doFetch(`https://api.bilibili.com/x/v1/dm/list.so?oid=${cid}`, {
          headers: HEADERS,
          signal: ctrl.signal,
        });
        if (!res.ok) return [];
        const xml = await res.text();
        const out: { time: number; text: string }[] = [];
        for (const m of xml.matchAll(/<d p="([^"]+)"[^>]*>([^<]*)<\/d>/g)) {
          const time = Number(m[1].split(",")[0]);
          const text = m[2].trim();
          if (Number.isFinite(time) && text.length > 0) out.push({ time, text });
        }
        return out;
      } finally {
        clearTimeout(timer);
      }
    } catch {
      return [];
    }
  }

  /** 选时间点：弹幕密度峰值（前 3）+ 均匀（补满），跳过片头片尾各 5%。 */
  function pickTimestamps(danmaku: { time: number }[], seconds: number): number[] {
    const start = Math.min(seconds * 0.05, 30);
    const end = Math.max(seconds * 0.95, seconds - 20);
    const span = Math.max(end - start, 1);
    const buckets = new Map<number, number>();
    for (const d of danmaku) {
      if (d.time < start || d.time > end) continue;
      const bucket = Math.floor((d.time - start) / 5);
      buckets.set(bucket, (buckets.get(bucket) ?? 0) + 1);
    }
    const peaks = [...buckets.entries()]
      .sort((a, b) => b[1] - a[1])
      .slice(0, Math.max(1, Math.floor(frameCount / 2)))
      .map(([bucket]) => start + bucket * 5 + 2.5);

    const uniform: number[] = [];
    const slots = frameCount - peaks.length;
    for (let i = 0; i < slots; i++) {
      uniform.push(start + (span * (i + 0.5)) / slots);
    }
    const all = [...peaks, ...uniform].map((t) => Math.round(t * 10) / 10).sort((a, b) => a - b);
    // 去重：间隔 < 3 秒的合并
    const dedup: number[] = [];
    for (const t of all) {
      if (dedup.length === 0 || t - dedup[dedup.length - 1] >= 3) dedup.push(t);
    }
    return dedup.slice(0, frameCount);
  }

  function extractFrames(bvid: string, cid: string, timestamps: number[], outDir: string): Frame[] {
    if (!existsSync(pythonPath) || !existsSync(scriptPath)) return [];
    const result = spawnSync(
      pythonPath,
      [
        scriptPath,
        "--bvid",
        bvid,
        "--cid",
        cid,
        "--timestamps",
        timestamps.join(","),
        "--out",
        outDir,
      ],
      { encoding: "utf8", timeout: 90_000, maxBuffer: 8 * 1024 * 1024 },
    );
    if (result.status !== 0) {
      const why = (result.stderr ?? "").split("\n").filter(Boolean).slice(-2).join(" / ");
      console.warn("[鱼缸] 抽帧失败:", why || `exit ${result.status}`);
      return [];
    }
    const line = (result.stdout ?? "").trim().split("\n").filter(Boolean).pop() ?? "";
    try {
      const parsed = JSON.parse(line) as Frame[];
      return Array.isArray(parsed) ? parsed : [];
    } catch {
      return [];
    }
  }

  function fmtTime(seconds: number): string {
    const m = Math.floor(seconds / 60);
    const s = Math.round(seconds % 60);
    return `${m}:${String(s).padStart(2, "0")}`;
  }

  return defineTool({
    name: "video",
    description: prompt.description,
    callers: ["model"],
    parameters: Type.Object({
      url: Type.String({ description: prompt.params["url"] ?? "" }),
    }),
    execute: async (args, api, context) => {
      const raw = args.url.trim();
      if (!raw || raw.length > 512) {
        throw new Error(deps.prompts.messages["video_invalid"] ?? "链接不对");
      }

      // 每轮限一次：轮标识与 say/search 同源
      const live = await api.snapshot(LiveDoc, api.conversationId, context);
      const round = live?.run?.inputs?.[0];
      if (round !== undefined) {
        if (USED.get(api.conversationId) === round) {
          throw new Error(deps.prompts.messages["video_used"] ?? "这一轮看过了");
        }
        USED.set(api.conversationId, round);
      }

      const startedAt = Date.now();
      const tmp = mkdtempSync(join(tmpdir(), "yg-video-"));
      try {
        // 短链先展开
        let target = raw;
        if (/^https?:\/\/b23\.tv\//.test(raw)) {
          const res = await doFetch(raw, { headers: HEADERS, redirect: "follow" });
          target = res.url;
        }
        const bv = target.match(/BV[0-9A-Za-z]{10}/)?.[0];
        if (!bv) throw new Error("no bv");

        const view = await getJson(`https://api.bilibili.com/x/web-interface/view?bvid=${bv}`);
        if (view?.code !== 0 || !view?.data) throw new Error("view failed");
        const d = view.data;
        const duration = Number(d.duration ?? 0);
        const cid = String(d.cid ?? "");
        const capSeconds = Math.min(duration, maxMinutes * 60);
        const truncated = duration > capSeconds + 5;

        const head = [
          `《${String(d.title).slice(0, 60)}》`,
          `UP主 ${d.owner?.name ?? "?"} · ${Math.round(duration / 60)} 分钟 · 播放 ${(d.stat?.view ?? 0).toLocaleString()}`,
        ];
        if (truncated) {
          head.push(
            renderTemplate(deps.prompts.messages["video_truncated"] ?? "", { minutes: String(maxMinutes) }),
          );
        }
        const desc = String(d.desc ?? "").replace(/\s+/g, " ").slice(0, 200);
        if (desc) head.push(desc);

        // 弹幕
        const danmaku = await fetchDanmaku(cid);
        let danmakuText = "";
        if (danmaku.length > 0) {
          const hot = [...danmaku].sort((a, b) => b.time - a.time).slice(0, 4);
          const uniq = [...new Set(danmaku.map((x) => x.text))].slice(0, 8);
          const picked = uniq.length >= 4 ? uniq.slice(0, 6) : hot.map((x) => x.text);
          danmakuText =
            "\n" +
            (deps.prompts.messages["video_danmaku_header"] ?? "") +
            "\n" +
            picked.map((t) => `· ${t.replace(/\s+/g, " ").slice(0, 40)}`).join("\n");
        }

        // 关键帧 → 文字描述
        let framesText = "";
        if (deps.models && deps.visionModel && cid) {
          const timestamps = pickTimestamps(danmaku, capSeconds);
          const framesStartedAt = Date.now();
          const frames = extractFrames(bv, cid, timestamps, tmp);
          const grabMs = Date.now() - framesStartedAt;
          if (frames.length > 0) {
            const described = await Promise.all(
              frames.map(async (frame) => {
                try {
                  const bytes = readFileSync(frame.path);
                  const text = await describeImage(deps, bytes.toString("base64"), "image/jpeg");
                  if (!text) return null;
                  return { time: frame.time, line: `[${fmtTime(frame.time)}] ${text.replace(/\s+/g, " ").slice(0, 220)}` };
                } catch {
                  return null;
                }
              }),
            );
            const lines = described
              .filter((x): x is { time: number; line: string } => x !== null)
              .sort((a, b) => a.time - b.time)
              .map((x) => x.line);
            console.log(
              "[鱼缸] video",
              bv,
              "抽帧",
              grabMs,
              "ms · 描述",
              Date.now() - framesStartedAt - grabMs,
              "ms · 帧",
              frames.length,
            );
            if (lines.length > 0) {
              framesText =
                "\n" + (deps.prompts.messages["video_frames_header"] ?? "") + "\n" + lines.join("\n");
            }
          }
        }

        // 热评（拿不到就略过）
        let comments = "";
        try {
          const reply = await getJson(`https://api.bilibili.com/x/v2/reply/main?type=1&oid=${d.aid}&mode=3&next=0`);
          const top = (reply?.data?.replies ?? []).slice(0, 3) as { content?: { message?: string } }[];
          if (top.length > 0) {
            comments =
              "\n" +
              (deps.prompts.messages["video_comments_header"] ?? "") +
              "\n" +
              top.map((c, i) => `${i + 1}. ${String(c.content?.message ?? "").replace(/\s+/g, " ").slice(0, 100)}`).join("\n");
          }
        } catch {
          // 评论区拿不到不影响
        }

        const text = [head.join("\n"), danmakuText, framesText, comments].filter((s) => s.length > 0).join("\n");
        console.log("[鱼缸] video", bv, "总用时", Date.now() - startedAt, "ms");
        return { output: [{ type: "text", text }] };
      } catch {
        throw new Error(renderTemplate(deps.prompts.messages["video_failed"] ?? "视频没打开", { url: raw }));
      } finally {
        try {
          rmSync(tmp, { recursive: true, force: true });
        } catch {
          // 清理失败无所谓
        }
      }
    },
  });
}
