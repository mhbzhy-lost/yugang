/**
 * TTS 客户端：支持本地常驻 GPT-SoVITS 与云端 Qwen-Audio-TTS（Token Plan / 百炼）。
 *
 * - GPT-SoVITS（缺省 engine）：一个服务实例是全局单例，人格切换时在同一进程内热加载
 *   GPT/SoVITS 模型，再切换参考音频并合成。切模、参考音频、合成和空响应重试共用同一把锁，
 *   防止并发请求在不同人格之间串音。
 * - Qwen-Audio-TTS（engine: "qwen-tts"）：无状态 HTTP API，调用 SpeechSynthesizer 返回
 *   音频 URL（或内联 base64），下载后修复流式 WAV 头再落盘，不需要本地切模锁。
 */
import { writeFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { randomUUID } from "node:crypto";

export type TtsEngine = "gpt-sovits" | "qwen-tts";

export interface TtsConfig {
  /** 引擎类型：缺省为本地 gpt-sovits；云端 Qwen-Audio-TTS 填 qwen-tts。 */
  engine?: TtsEngine;
  /** 服务地址；为空表示没启用语音。 */
  url: string;
  /** GPT 模型绝对路径；gpt-sovits 热切模式必填。 */
  gptModel?: string;
  /** SoVITS 模型绝对路径；gpt-sovits 热切模式必填。 */
  sovitsModel?: string;
  /** 参考音频路径；gpt-sovits 热切模式必填，避免沿用上一人格的参考音频。 */
  referWav?: string;
  /** 参考音频原文本；gpt-sovits 热切模式必填。 */
  referText?: string;
  /** 参考音频语种，默认 zh（gpt-sovits 用）。 */
  referLanguage?: string;
  /** 云端 TTS 模型名（qwen-tts 必填，如 qwen-audio-3.0-tts-plus）。 */
  model?: string;
  /** 云端 TTS 音色 ID（qwen-tts 必填，如复刻音色 ID）。 */
  voice?: string;
  /** 凭据 provider 名（qwen-tts 可选，默认 qwen-token-plan-cn，对应 config/auth.json 键）。 */
  provider?: string;
  /** 运行时由宿主从 auth.json 注入的 Bearer API Key（仅内存态，不写进 fish.config.json）。 */
  apiKey?: string;
  /** 目标语种提示（qwen-tts 可选，默认 zh）。 */
  language?: string;
  /** 风格控制指令（qwen-tts 可选；留空 = 保持原声复刻韵律）。 */
  instruction?: string;
  /** 语速倍率（可选，0.5–2.0）：gpt-sovits 透传 speed，qwen-tts 透传 input.rate。 */
  speed?: number;
  /** 合成超时，默认 120 秒；模型切换另有较宽的控制请求上限。 */
  timeoutMs?: number;
}

export interface SynthResult {
  bytes: Buffer;
  /** 相对 mediaRoot 的落盘路径，如 voice/xxx.wav。 */
  ref: string;
}

type ServiceState = {
  tail: Promise<void>;
  loadedModel?: string;
};

const services = new Map<string, ServiceState>();
const MODEL_SWITCH_TIMEOUT_MS = 180_000;
const MAX_AUDIO_BYTES = 25 * 1024 * 1024;

async function readBoundedBytes(res: Response, limit: number, errMsg: string): Promise<Buffer> {
  const len = Number(res.headers.get("content-length") ?? 0);
  if (Number.isFinite(len) && len > limit) {
    await res.body?.cancel().catch(() => {});
    throw new Error(errMsg);
  }
  if (!res.body) {
    const buf = Buffer.from(await res.arrayBuffer());
    if (buf.length > limit) throw new Error(errMsg);
    return buf;
  }
  const chunks: Uint8Array[] = [];
  let total = 0;
  const reader = res.body.getReader();
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.length;
      if (total > limit) throw new Error(errMsg);
      chunks.push(value);
    }
  } finally {
    await reader.cancel().catch(() => {});
  }
  return Buffer.concat(chunks);
}

function serviceState(url: string): ServiceState {
  let state = services.get(url);
  if (!state) {
    state = { tail: Promise.resolve() };
    services.set(url, state);
  }
  return state;
}

async function waitForPrevious(previous: Promise<void>, signal?: AbortSignal): Promise<void> {
  if (!signal) {
    await previous;
    return;
  }
  signal.throwIfAborted();
  let onAbort: (() => void) | undefined;
  const aborted = new Promise<never>((_, reject) => {
    onAbort = () => reject(signal.reason ?? new Error("tts_aborted"));
    signal.addEventListener("abort", onAbort, { once: true });
  });
  try {
    await Promise.race([previous, aborted]);
  } finally {
    if (onAbort) signal.removeEventListener("abort", onAbort);
  }
}

async function withServiceLock<T>(state: ServiceState, signal: AbortSignal | undefined, fn: () => Promise<T>): Promise<T> {
  let release!: () => void;
  const gate = new Promise<void>((resolve) => { release = resolve; });
  const previous = state.tail;
  state.tail = previous.then(() => gate, () => gate);
  try {
    await waitForPrevious(previous, signal);
    signal?.throwIfAborted();
    return await fn();
  } finally {
    // 即使等待锁时被取消，也必须放开自己的 gate，不能把后续请求永久挂死。
    release();
  }
}

function profileKey(config: TtsConfig): string {
  const url = config.url.trim().replace(/\/+$/, "");
  const gpt = config.gptModel?.trim();
  const sovits = config.sovitsModel?.trim();
  if (!url || !gpt || !sovits) throw new Error("tts_profile_incomplete");
  if (!config.referWav?.trim() || !config.referText?.trim()) throw new Error("tts_reference_incomplete");
  return `${url}\u0000${gpt}\u0000${sovits}`;
}

function endpoint(url: string, path: string): string {
  return `${url.trim().replace(/\/+$/, "")}${path}`;
}

async function postControl(
  url: string,
  path: string,
  body: Record<string, string>,
  signal: AbortSignal | undefined,
  timeoutMs: number,
): Promise<void> {
  signal?.throwIfAborted();
  const timeout = AbortSignal.timeout(timeoutMs);
  const response = await fetch(endpoint(url, path), {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
    signal: signal ? AbortSignal.any([timeout, signal]) : timeout,
  });
  if (!response.ok) {
    await response.body?.cancel().catch(() => {});
    throw new Error(`tts_http_${response.status}`);
  }
  let result: unknown;
  try {
    result = await response.json();
  } catch {
    throw new Error("tts_invalid_control_response");
  }
  if (!result || typeof result !== "object" || (result as { code?: unknown }).code !== 0) {
    const message = result && typeof result === "object" && typeof (result as { message?: unknown }).message === "string"
      ? String((result as { message: string }).message).slice(0, 120)
      : "unknown";
    throw new Error(`tts_control_failed:${message}`);
  }
}

async function ensureModel(config: TtsConfig, state: ServiceState, signal?: AbortSignal): Promise<void> {
  const key = profileKey(config);
  if (state.loadedModel === key) return;
  await postControl(
    config.url,
    "/set_model",
    { gpt_model_path: config.gptModel!.trim(), sovits_model_path: config.sovitsModel!.trim() },
    signal,
    MODEL_SWITCH_TIMEOUT_MS,
  );
  state.loadedModel = key;
}

async function setReference(config: TtsConfig, signal?: AbortSignal): Promise<void> {
  await postControl(
    config.url,
    "/change_refer",
    {
      refer_wav_path: config.referWav!.trim(),
      prompt_text: config.referText!.trim(),
      prompt_language: config.referLanguage?.trim() || "zh",
    },
    signal,
    config.timeoutMs ?? 120_000,
  );
}

async function synthesizeLocked(config: TtsConfig, text: string, mediaRoot: string, state: ServiceState, signal?: AbortSignal): Promise<SynthResult> {
  await ensureModel(config, state, signal);
  // 每次都设置参考音频：服务端是单例，不能依赖上一次请求留下的全局 refer 状态。
  await setReference(config, signal);

  const attempt = async (textLanguage: string): Promise<Buffer> => {
    signal?.throwIfAborted();
    const body: Record<string, unknown> = {
      refer_wav_path: config.referWav!.trim(),
      prompt_text: config.referText!.trim(),
      prompt_language: config.referLanguage?.trim() || "zh",
      text,
      text_language: textLanguage,
    };
    if (config.speed !== undefined) body["speed"] = config.speed;

    const timeout = AbortSignal.timeout(config.timeoutMs ?? 120_000);
    const response = await fetch(config.url, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
      signal: signal ? AbortSignal.any([timeout, signal]) : timeout,
    });
    if (!response.ok) {
      await response.body?.cancel().catch(() => {});
      throw new Error(`tts_http_${response.status}`);
    }
    return await readBoundedBytes(response, MAX_AUDIO_BYTES, "tts_audio_too_large");
  };

  try {
    let bytes = await attempt("zh");
    if (bytes.length < 1024) {
      signal?.throwIfAborted();
      console.error("[鱼缸] tts empty, retry:", bytes.length, "B /", text.length, "chars");
      bytes = await attempt("auto");
    }
    if (bytes.length < 1024) throw new Error("tts_empty");
    signal?.throwIfAborted();

    const dir = join(mediaRoot, "voice");
    mkdirSync(dir, { recursive: true });
    const file = `${Date.now()}-${randomUUID().slice(0, 8)}.wav`;
    writeFileSync(join(dir, file), bytes);
    return { bytes, ref: `voice/${file}` };
  } catch (error) {
    // 网络中断或服务端状态不明时，下次强制重新 set_model，拒绝拿未知残留状态继续发声。
    state.loadedModel = undefined;
    throw error;
  }
}

/**
 * 修复流式 WAV 头：Qwen-Audio-TTS 返回的 WAV 常把 RIFF/data 长度写成占位值 0x7FFFFFFF，
 * 导致播放器/转码器误判时长（约 44739 秒）。保留原 fmt 参数，按真实 PCM 字节数重写标准头。
 */
export function fixWavHeader(raw: Buffer): Buffer {
  if (raw.length < 44) return raw;
  if (raw.toString("ascii", 0, 4) !== "RIFF" || raw.toString("ascii", 8, 12) !== "WAVE") return raw;

  let fmtChunk: Buffer | undefined;
  let dataStart = -1;
  let offset = 12;
  while (offset + 8 <= raw.length) {
    const id = raw.toString("ascii", offset, offset + 4);
    const size = raw.readUInt32LE(offset + 4);
    if (id === "fmt " && offset + 8 + size <= raw.length) {
      fmtChunk = raw.subarray(offset + 8, offset + 8 + size);
      offset += 8 + size + (size & 1);
      continue;
    }
    if (id === "data") {
      dataStart = offset + 8;
      break;
    }
    // 遇到占位长度或异常 chunk 时停止扫描，交回原字节
    if (size === 0x7fffffff || size === 0xffffffff || offset + 8 + size > raw.length) break;
    offset += 8 + size + (size & 1);
  }
  if (!fmtChunk || dataStart < 0 || dataStart >= raw.length) return raw;

  const pcm = raw.subarray(dataStart);
  const fmtHeader = Buffer.alloc(8);
  fmtHeader.write("fmt ", 0, "ascii");
  fmtHeader.writeUInt32LE(fmtChunk.length, 4);

  const dataHeader = Buffer.alloc(8);
  dataHeader.write("data", 0, "ascii");
  dataHeader.writeUInt32LE(pcm.length, 4);

  const bodyLen = 4 + fmtHeader.length + fmtChunk.length + dataHeader.length + pcm.length;
  const riffHeader = Buffer.alloc(12);
  riffHeader.write("RIFF", 0, "ascii");
  riffHeader.writeUInt32LE(bodyLen, 4);
  riffHeader.write("WAVE", 8, "ascii");

  return Buffer.concat([riffHeader, fmtHeader, fmtChunk, dataHeader, pcm]);
}

async function synthesizeQwenTts(config: TtsConfig, text: string, mediaRoot: string, signal?: AbortSignal): Promise<SynthResult> {
  const url = config.url.trim();
  const model = config.model?.trim();
  const voice = config.voice?.trim();
  if (!url || !model || !voice) throw new Error("tts_profile_incomplete");
  const apiKey = config.apiKey?.trim();
  if (!apiKey) throw new Error("tts_api_key_missing");

  const input: Record<string, unknown> = {
    text,
    voice,
    format: "wav",
    sample_rate: 24000,
    language_hints: [config.language?.trim() || "zh"],
  };
  if (config.speed !== undefined) input["rate"] = config.speed;
  if (config.instruction?.trim()) input["instruction"] = config.instruction.trim();

  const attempt = async (): Promise<Buffer> => {
    signal?.throwIfAborted();
    const timeoutMs = config.timeoutMs ?? 60_000;
    const timeout = AbortSignal.timeout(timeoutMs);
    const mergedSignal = signal ? AbortSignal.any([timeout, signal]) : timeout;

    const response = await fetch(url, {
      method: "POST",
      headers: {
        authorization: `Bearer ${apiKey}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({ model, input }),
      signal: mergedSignal,
    });
    if (!response.ok) {
      await response.body?.cancel().catch(() => {});
      throw new Error(`tts_http_${response.status}`);
    }

    let payload: unknown;
    try {
      payload = await response.json();
    } catch {
      throw new Error("tts_invalid_response");
    }
    const audio = (payload as { output?: { audio?: { data?: unknown; url?: unknown } } })?.output?.audio;
    let raw: Buffer;
    if (typeof audio?.data === "string" && audio.data.trim()) {
      raw = Buffer.from(audio.data.trim(), "base64");
      if (raw.length > MAX_AUDIO_BYTES) throw new Error("tts_audio_too_large");
    } else if (typeof audio?.url === "string" && audio.url.trim()) {
      const dl = await fetch(audio.url.trim(), { signal: mergedSignal });
      if (!dl.ok) {
        await dl.body?.cancel().catch(() => {});
        throw new Error(`tts_download_http_${dl.status}`);
      }
      raw = await readBoundedBytes(dl, MAX_AUDIO_BYTES, "tts_audio_too_large");
    } else {
      throw new Error("tts_invalid_response");
    }
    return fixWavHeader(raw);
  };

  let bytes = await attempt();
  if (bytes.length < 1024) {
    signal?.throwIfAborted();
    console.error("[鱼缸] qwen-tts empty, retry:", bytes.length, "B /", text.length, "chars");
    bytes = await attempt();
  }
  if (bytes.length < 1024) throw new Error("tts_empty");
  signal?.throwIfAborted();

  const dir = join(mediaRoot, "voice");
  mkdirSync(dir, { recursive: true });
  const file = `${Date.now()}-${randomUUID().slice(0, 8)}.wav`;
  writeFileSync(join(dir, file), bytes);
  return { bytes, ref: `voice/${file}` };
}

/** 合成一段话，落盘到 <mediaRoot>/voice/，返回相对引用。 */
export async function synthesizeToMedia(config: TtsConfig, text: string, mediaRoot: string, signal?: AbortSignal): Promise<SynthResult> {
  if (!config.url) throw new Error("tts_not_configured");
  if (config.engine === "qwen-tts") {
    return synthesizeQwenTts(config, text, mediaRoot, signal);
  }
  const state = serviceState(config.url.trim().replace(/\/+$/, ""));
  return withServiceLock(state, signal, () => synthesizeLocked(config, text, mediaRoot, state, signal));
}
