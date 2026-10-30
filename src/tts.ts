/**
 * 本地 TTS 客户端：调 macmini 上常驻的 GPT-SoVITS api（默认 127.0.0.1:9880）。
 *
 * 分两层：
 *   synthesize()  合成一段语音，返回 wav 字节
 *   上层（say 工具）负责落盘到 mediaRoot 下的 voice/ 目录，再走 outbox 出口
 *
 * 服务不在时快速失败（连接错误立刻抛），由调用方决定退回文字；不重试，
 * 因为 TTS 是可选增强，卡住一条回复比没有语音更糟。
 */
import { writeFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { randomUUID } from "node:crypto";

export interface TtsConfig {
  /** 服务地址，如 http://127.0.0.1:9880；为空表示没启用语音。 */
  url: string;
  /** 参考音频路径（服务端本地路径）；留空用服务启动参数里的默认参考。 */
  referWav?: string;
  /** 参考音频原文本；与 referWav 配套。 */
  referText?: string;
  /** 参考音频语种，默认 zh。 */
  referLanguage?: string;
  /** 合成超时，默认 25 秒（工具层上限 30 秒，留出重试余量）。 */
  timeoutMs?: number;
}

export interface SynthResult {
  bytes: Buffer;
  /** 相对 mediaRoot 的落盘路径，如 voice/xxx.wav。 */
  ref: string;
}

/** 合成一段话，落盘到 <mediaRoot>/voice/，返回相对引用。 */
export async function synthesizeToMedia(config: TtsConfig, text: string, mediaRoot: string): Promise<SynthResult> {
  if (!config.url) throw new Error("tts_not_configured");
  // 服务端偶发返回 200 + 0 字节（日志里能看到 LookupError，混合中英文时更常见）。
  // 同一句话重发一次通常就好了，所以这里对空结果重试一次，再用 auto 语种兜一次。
  const attempt = async (textLanguage: string): Promise<Buffer> => {
    const body: Record<string, unknown> = { text, text_language: textLanguage };
    if (config.referWav) body["refer_wav_path"] = config.referWav;
    if (config.referText) body["prompt_text"] = config.referText;
    if (config.referWav) body["prompt_language"] = config.referLanguage ?? "zh";

    const response = await fetch(config.url, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(config.timeoutMs ?? 25_000),
    });
    if (!response.ok) throw new Error(`tts_http_${response.status}`);
    return Buffer.from(await response.arrayBuffer());
  };

  let bytes = await attempt("zh");
  if (bytes.length < 1024) {
    console.error("[鱼缸] tts empty, retry:", bytes.length, "B /", text.length, "chars");
    bytes = await attempt("auto");
  }
  if (bytes.length < 1024) throw new Error("tts_empty");

  const dir = join(mediaRoot, "voice");
  mkdirSync(dir, { recursive: true });
  const file = `${Date.now()}-${randomUUID().slice(0, 8)}.wav`;
  writeFileSync(join(dir, file), bytes);
  return { bytes, ref: `voice/${file}` };
}
