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
  const result = await spawnCapture(python, args, { timeoutMs: 75_000, signal, maxBytes: 1024 * 1024 });
  signal?.throwIfAborted();
  if (result.status !== 0) throw new Error("video_decode_failed");
  let data: VideoFrames;
  try {
    const parsed = JSON.parse(result.stdout.toString("utf8").trim().split("\n").pop() ?? "") as unknown;
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error("video_decode_failed");
    data = parsed as VideoFrames;
    if (!Number.isFinite(data.durationSeconds) || data.durationSeconds <= 0 || !Number.isFinite(data.coveredSeconds)
      || data.coveredSeconds <= 0 || data.coveredSeconds > 1800 || !Array.isArray(data.frames) || data.frames.length > 6) {
      throw new Error("video_decode_failed");
    }
    const root = realpathSync(out) + sep;
    for (const frame of data.frames) {
      if (!frame || typeof frame !== "object" || typeof frame.path !== "string") throw new Error("video_decode_failed");
      const stat = lstatSync(frame.path);
      if (!Number.isFinite(frame.time) || frame.time < 0 || frame.time > data.coveredSeconds || !stat.isFile() || stat.isSymbolicLink()
        || stat.size > 2 * 1024 * 1024 || !realpathSync(frame.path).startsWith(root)) throw new Error("video_decode_failed");
    }
  } catch {
    throw new Error("video_decode_failed");
  }
  return data;
}
export async function describeVideoFrames(deps: DescribeDeps, data: VideoFrames, signal?: AbortSignal): Promise<{ lines: string[]; failed: number }> {
  if (!deps.models || !deps.visionModel) throw new Error("video_vision_missing");
  const results: (string | null)[] = new Array(data.frames.length).fill(null);
  let next = 0;
  const concurrency = Math.min(2, data.frames.length);
  const worker = async () => {
    while (next < data.frames.length) {
      const idx = next++;
      signal?.throwIfAborted();
      const frame = data.frames[idx]!;
      try {
        const described = await describeImage(deps, readFileSync(frame.path).toString("base64"), "image/jpeg", signal);
        signal?.throwIfAborted();
        results[idx] = described.ok ? `[${videoTime(frame.time)}] ${described.text.replace(/\s+/g, " ").slice(0, 220)}` : null;
      } catch {
        signal?.throwIfAborted();
        results[idx] = null;
      }
    }
  };
  await Promise.all(Array.from({ length: concurrency }, () => worker()));
  signal?.throwIfAborted();
  return { lines: results.filter((line): line is string => line !== null), failed: data.failedFrames + results.filter((line) => line === null).length };
}
