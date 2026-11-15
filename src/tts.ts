/**
 * 本地 TTS 客户端：调用常驻的 GPT-SoVITS api。
 *
 * 一个服务实例是全局单例：人格切换时在同一进程内热加载 GPT/SoVITS 模型，
 * 再切换参考音频并合成。切模、参考音频、合成和空响应重试共用同一把锁，
 * 防止并发请求在不同人格之间串音。
 */
import { writeFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { randomUUID } from "node:crypto";

export interface TtsConfig {
  /** 服务地址；为空表示没启用语音。 */
  url: string;
  /** GPT 模型绝对路径；热切模式必填。 */
  gptModel?: string;
  /** SoVITS 模型绝对路径；热切模式必填。 */
  sovitsModel?: string;
  /** 参考音频路径；热切模式必填，避免沿用上一人格的参考音频。 */
  referWav?: string;
  /** 参考音频原文本；热切模式必填。 */
  referText?: string;
  /** 参考音频语种，默认 zh。 */
  referLanguage?: string;
  /** 语速倍率（可选）：voices 配了就透传给服务端，缺省不带（原速）。 */
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
  if (!response.ok) throw new Error(`tts_http_${response.status}`);
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
    if (!response.ok) throw new Error(`tts_http_${response.status}`);
    return Buffer.from(await response.arrayBuffer());
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

/** 合成一段话，落盘到 <mediaRoot>/voice/，返回相对引用。 */
export async function synthesizeToMedia(config: TtsConfig, text: string, mediaRoot: string, signal?: AbortSignal): Promise<SynthResult> {
  if (!config.url) throw new Error("tts_not_configured");
  const state = serviceState(config.url.trim().replace(/\/+$/, ""));
  return withServiceLock(state, signal, () => synthesizeLocked(config, text, mediaRoot, state, signal));
}
