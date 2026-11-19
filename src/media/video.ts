/** 下载后视频处理共用层：抽帧结果严格校验，视觉描述不输出原始媒体地址。 */
import { existsSync, lstatSync, readFileSync, realpathSync } from "node:fs";
import { homedir } from "node:os";
import { join, sep } from "node:path";
import { REPO_ROOT } from "../paths.ts";
import { spawnCapture } from "./spawn-capture.ts";
import { describeImage, type DescribeDeps } from "./describe.ts";

export type VideoSource = { kind: "local"; file: string } | { kind: "bilibili"; bvid: string; cid: string; timestamps: number[] };
export interface VideoFrames { durationSeconds: number; coveredSeconds: number; frames: { time: number; path: string; width: number }[]; failedFrames: number }

export function pickVideoTimestamps(danmaku: { time: number }[], seconds: number): number[] {
  if (seconds < 3) return [seconds / 2];
  const start = Math.min(seconds * 0.05, 30);
  const end = Math.min(seconds - 0.01, Math.max(seconds * 0.95, seconds - 20));
  const buckets = new Map<number, number>();
  for (const d of danmaku) if (d.time >= start && d.time <= end) {
    const key = Math.floor((d.time - start) / 5);
    buckets.set(key, (buckets.get(key) ?? 0) + 1);
  }
  const peaks = [...buckets].sort((a, b) => b[1] - a[1]).slice(0, 3).map(([key]) => Math.min(end, start + key * 5 + 2.5));
  const slots = 6 - peaks.length;
  const all = [...peaks, ...Array.from({ length: slots }, (_, i) => start + (end - start) * (i + 0.5) / slots)].sort((a, b) => a - b);
  return all.filter((t, i) => i === 0 || t - all[i - 1] >= 3).slice(0, 6);
}
export function videoTime(seconds: number): string {
  const s = Math.floor(seconds);
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`;
}
export async function extractVideoFrames(source: VideoSource, out: string, signal?: AbortSignal): Promise<VideoFrames> {
  const python = process.env["VIDEO_PYTHON"] ?? join(homedir(), "tts", ".venv-video", "bin", "python");
  if (!existsSync(python)) throw new Error("video_decoder_missing");
  const args = [join(REPO_ROOT, "scripts", "video-frames.py"), "--out", out];
  if (source.kind === "local") args.push("--input", source.file);
  else args.push("--bvid", source.bvid, "--cid", source.cid, "--timestamps", source.timestamps.join(","));
  const result = await spawnCapture(python, args, { timeoutMs: 90_000, signal, maxBytes: 1024 * 1024 });
  signal?.throwIfAborted();
  if (result.status !== 0) throw new Error("video_decode_failed");
  const data = JSON.parse(result.stdout.toString("utf8").trim().split("\n").pop() ?? "") as VideoFrames;
  if (!Number.isFinite(data.durationSeconds) || data.durationSeconds <= 0 || !Number.isFinite(data.coveredSeconds)
    || data.coveredSeconds <= 0 || data.coveredSeconds > 1800 || !Array.isArray(data.frames) || data.frames.length > 6) throw new Error("video_decode_failed");
  const root = realpathSync(out) + sep;
  for (const frame of data.frames) {
    const stat = lstatSync(frame.path);
    if (!Number.isFinite(frame.time) || frame.time < 0 || frame.time > data.coveredSeconds || !stat.isFile() || stat.isSymbolicLink()
      || stat.size > 2 * 1024 * 1024 || !realpathSync(frame.path).startsWith(root)) throw new Error("video_decode_failed");
  }
  return data;
}
export async function describeVideoFrames(deps: DescribeDeps, data: VideoFrames, signal?: AbortSignal): Promise<{ lines: string[]; failed: number }> {
  if (!deps.models || !deps.visionModel) throw new Error("video_vision_missing");
  const lines = await Promise.all(data.frames.map(async (frame) => {
    signal?.throwIfAborted();
    try {
      const described = await describeImage(deps, readFileSync(frame.path).toString("base64"), "image/jpeg", signal);
      return described.ok ? `[${videoTime(frame.time)}] ${described.text.replace(/\s+/g, " ").slice(0, 220)}` : null;
    } catch { signal?.throwIfAborted(); return null; }
  }));
  signal?.throwIfAborted();
  return { lines: lines.filter((line): line is string => line !== null), failed: data.failedFrames + lines.filter((line) => line === null).length };
}
