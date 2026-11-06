/**
 * GIF 等距抽帧：把一张动图变成「模型能看懂动作」的 JPEG 帧序列。
 *
 * 背景（2026-11-06 真机实测）：glm 网关对 image/gif 只解码首帧——原文件直附
 * 模型永远只看到第一帧；社区成熟实践（Qwen-VL 的 fps 参数语义 / MiniCPM 的
 * image_id / OpenAI cookbook）是一致的：等距抽帧 → 依序多个 image block →
 * 文字声明「这是同一张动图按时间顺序抽取的 N 帧」。
 *
 * 单帧标准比静态图放低（主人裁定：GIF 分辨率普遍不高、没人用 GIF 装大段文字，
 * 清晰度需求低，省出的 token 换帧数）：长边 ≤GIF_FRAME_LONG_SIDE（640px），
 * 静态图是 1280px。帧数按时长自适应：clamp(⌈秒⌉, 2, maxFrames)，最少 2 帧
 * （首尾），Qwen-VL 官方认为少于 4 帧判断动态会变弱——我们场景是 1-3 秒的
 * 表情包，2-4 帧足够看清梗。
 *
 * 实现：ffprobe 读帧数/时长，ffmpeg select 等距抽帧 + scale 缩放，输出 JPEG。
 * 失败降级：抽帧失败回退首帧单张（与旧语义等价，宁少勿错）。
 */
import { spawnSync } from "node:child_process";
import { mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

/** GIF 帧的目标长边（px）：比静态图 1280 低一档，控制单帧 token。 */
export const GIF_FRAME_LONG_SIDE = 640;
/** JPEG 质量。 */
const GIF_FRAME_QUALITY = "80";

export interface GifFramePlan {
  /** 按时间顺序排列的 JPEG 帧（base64）；抽帧失败时是首帧单张的降级结果。 */
  frames: string[];
  /** 实际抽到的帧数（frames.length）。 */
  count: number;
  /** 原始总帧数（读不到时为 0）。 */
  total: number;
}

/** 单帧长边压到 GIF_FRAME_LONG_SIDE；小图不放大。 */
function frameScaleArgs(): string[] {
  return ["scale=w=" + GIF_FRAME_LONG_SIDE + ":h=" + GIF_FRAME_LONG_SIDE + ":force_original_aspect_ratio=decrease"];
}

/** ffprobe 读帧数与时长；读不到返回 null（不阻塞，调用方按首帧降级）。 */
function probeGif(file: string): { frames: number; seconds: number } | null {
  try {
    const res = spawnSync(
      "ffprobe",
      ["-v", "error", "-select_streams", "v:0", "-count_frames", "-show_entries", "stream=nb_read_frames,duration", "-of", "json", file],
      { timeout: 20_000 },
    );
    if (res.status !== 0 || !res.stdout) return null;
    // JSON 输出带键名（实测 csv 的列序不可靠：不同版本 duration 在前在后不一致）
    let parsed: { streams?: Array<{ nb_read_frames?: string; duration?: string }> };
    try {
      parsed = JSON.parse(res.stdout.toString()) as typeof parsed;
    } catch {
      return null;
    }
    const stream = parsed.streams?.[0];
    if (!stream) return null;
    const frames = Number(stream.nb_read_frames);
    const seconds = Number(stream.duration);
    if (!Number.isFinite(frames) || frames <= 0) return null;
    return { frames: Math.floor(frames), seconds: Number.isFinite(seconds) && seconds > 0 ? seconds : 0 };
  } catch {
    return null;
  }
}

/** 抽指定帧号列表：select 滤镜 + 缩放，输出 JPEG 到临时目录后读回。
 *  注意 select 表达式不加引号：spawnSync 的 argv 不经 shell，字面引号会被 ffmpeg
 *  当成表达式的一部分导致滤镜解析失败（2026-11-06 实测踩坑）。`\,` 转义保留——
 *  逗号在滤镜链里是分隔符。 */
function extractFrames(file: string, indices: readonly number[]): Buffer[] {
  const dir = mkdtempSync(join(tmpdir(), "gif-frames-"));
  try {
    const select = "select=" + indices.map((i) => "eq(n\\," + i + ")").join("+");
    const res = spawnSync(
      "ffmpeg",
      ["-y", "-loglevel", "error", "-i", file, "-vf", `${select},${frameScaleArgs().join(",")}`, "-fps_mode", "vfr", join(dir, "f%03d.jpg")],
      { timeout: 30_000 },
    );
    if (res.status !== 0) return [];
    return readdirSync(dir)
      .filter((name) => name.startsWith("f") && name.endsWith(".jpg"))
      .sort()
      .map((name) => {
        const buf = readFileSync(join(dir, name));
        return buf.length > 0 ? buf : null;
      })
      .filter((b): b is Buffer => b !== null);
  } catch {
    return [];
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

/**
 * 等距抽帧。帧号含首末两端（`Math.round(i * (total - 1) / (count - 1))`），
 * 保证「开头什么样、落点什么样」都在场——梗的落点常在最后。
 * maxFrames 建议值：普通轮 / 收图轮 4，导入轮 2（打标够用、控批量）。
 */
export function extractGifFrames(file: string, maxFrames: number): GifFramePlan {
  const cap = Math.max(2, Math.min(maxFrames, 8));
  const info = probeGif(file);
  if (!info) {
    // 探不到帧数（损坏 / 非法 GIF）：降级首帧
    const fallback = extractFrames(file, [0]);
    return fallback.length > 0 ? { frames: [fallback[0].toString("base64")], count: 1, total: 0 } : { frames: [], count: 0, total: 0 };
  }
  if (info.frames <= 1) {
    const single = extractFrames(file, [0]);
    if (single.length > 0) return { frames: [single[0].toString("base64")], count: 1, total: info.frames };
    return { frames: [], count: 0, total: info.frames };
  }
  // 帧数按时长自适应：1 秒 2 帧、2 秒 3 帧、3 秒起 4 帧，封顶 cap
  const byDuration = info.seconds > 0 ? Math.max(2, Math.ceil(info.seconds)) : 2;
  const want = Math.min(cap, byDuration, info.frames);
  const indices = Array.from({ length: want }, (_, i) =>
    want === 1 ? 0 : Math.min(info.frames - 1, Math.round((i * (info.frames - 1)) / (want - 1))),
  );
  // 去重（极短 GIF 可能让相邻采样点落在同一帧）
  const unique = [...new Set(indices)];
  if (unique.length === 1) unique.push(info.frames - 1);
  const frames = extractFrames(file, unique);
  if (frames.length === 0) {
    const fallback = extractFrames(file, [0]);
    return fallback.length > 0
      ? { frames: [fallback[0].toString("base64")], count: 1, total: info.frames }
      : { frames: [], count: 0, total: info.frames };
  }
  return { frames: frames.map((b) => b.toString("base64")), count: frames.length, total: info.frames };
}
