/**
 * provider 级代理：只给指定 provider 造一条 fetch，不动全局。
 *
 * 为什么不用 `--use-env-proxy` / NODE_USE_ENV_PROXY：那是进程级的，pi-ai 的模型请求
 * 同样走 globalThis.fetch，一开就把 zai / deepseek 也塞进代理，代理挂了两边一起哑。
 * 这里照 pi-config 的 openai-proxy 思路，只把需要走隧道的 provider 交给
 * https-proxy-agent 建的 CONNECT 隧道，其它 provider 照旧直连。
 *
 * 没有用 undici 的 ProxyAgent：鱼没有 undici 依赖，而 https-proxy-agent 已经是
 * pi-ai 的传递依赖（9.1.0），直接复用，部署时不用再补 npm install。
 */
import { request as httpsRequest } from "node:https";
import { HttpsProxyAgent } from "https-proxy-agent";

/** 代理 URL 只认 http / https（CONNECT 隧道），socks / PAC 不认；不合法返回 false，由调用方回落到直连。 */
export function validProxy(value: unknown): value is string {
  if (typeof value !== "string" || !value.trim()) return false;
  try {
    const url = new URL(value.trim());
    return (url.protocol === "http:" || url.protocol === "https:") && Boolean(url.hostname);
  } catch {
    return false;
  }
}

/** 304/204/205 不允许带 body，构造 Response 时要显式给 null。 */
function nullBodyStatus(status: number): boolean {
  return status === 204 || status === 205 || status === 304;
}

/** 默认建连与 body 空闲超时：每次收到 chunk 会自动续期，防止半开连接在代理上干挂 600s。 */
export const DEFAULT_PROXY_IDLE_TIMEOUT_MS = 120_000;

export interface ProxyFetchOptions {
  /** 建连及 body 逐 chunk 空闲超时（毫秒），缺省 120s。 */
  idleTimeoutMs?: number;
  /** 响应体最大字节数（可选）；超出时销毁流并报错。 */
  maxResponseBytes?: number;
}

const HOP_BY_HOP_AND_ENCODING = new Set([
  "connection",
  "keep-alive",
  "proxy-authenticate",
  "proxy-authorization",
  "te",
  "trailers",
  "transfer-encoding",
  "upgrade",
  "content-encoding",
]);

/** 按 proxyUrl 复用 keepAlive Agent（不压低默认 maxSockets，避免长 SSE 阻塞同代理普通请求）。 */
const agentPool = new Map<string, HttpsProxyAgent<string>>();

function getProxyAgent(proxyUrl: string): HttpsProxyAgent<string> {
  let agent = agentPool.get(proxyUrl);
  if (!agent) {
    agent = new HttpsProxyAgent(proxyUrl, { keepAlive: true });
    agentPool.set(proxyUrl, agent);
  }
  return agent;
}

function toAbortError(reason: unknown): Error {
  if (reason instanceof Error && reason.name === "AbortError") return reason;
  const err = new Error(reason instanceof Error ? reason.message : "The operation was aborted.");
  err.name = "AbortError";
  return err;
}

async function resolveBody(input: string | URL | Request, init: RequestInit): Promise<string | Buffer | undefined> {
  const raw = init.body !== undefined ? init.body : undefined;
  if (raw !== undefined) {
    if (raw === null) return undefined;
    if (typeof raw === "string") return raw;
    if (raw instanceof URLSearchParams) return raw.toString();
    if (ArrayBuffer.isView(raw)) return Buffer.from(raw.buffer, raw.byteOffset, raw.byteLength);
    if (raw instanceof ArrayBuffer) return Buffer.from(raw);
    return Buffer.from(await new Response(raw).arrayBuffer());
  }
  if (input instanceof Request && input.body !== null) {
    return Buffer.from(await input.arrayBuffer());
  }
  return undefined;
}

/**
 * 造一条走代理的流式 fetch（形状对齐 globalThis.fetch：收到响应头即 resolve Response，
 * body 阶段保留逐 chunk 空闲超时与可选 maxResponseBytes 保护）。
 * 目标只支持 https —— draw_remote 与模型通道端点都是 https，别的协议直接抛，不静默直连。
 */
export function createProxyFetch(proxy: string, options: ProxyFetchOptions = {}): typeof fetch | undefined {
  if (!validProxy(proxy)) return undefined;
  const normalizedProxy = proxy.trim();
  const agent = getProxyAgent(normalizedProxy);
  const idleTimeoutMs =
    typeof options.idleTimeoutMs === "number" && Number.isFinite(options.idleTimeoutMs) && options.idleTimeoutMs > 0
      ? options.idleTimeoutMs
      : DEFAULT_PROXY_IDLE_TIMEOUT_MS;
  const maxResponseBytes =
    typeof options.maxResponseBytes === "number" && Number.isFinite(options.maxResponseBytes) && options.maxResponseBytes > 0
      ? options.maxResponseBytes
      : undefined;

  const proxied = async (input: string | URL | Request, init: RequestInit = {}): Promise<Response> => {
    const target = new URL(typeof input === "string" ? input : input instanceof URL ? input.href : input.url);
    if (target.protocol !== "https:") throw new Error("proxy fetch supports https targets only");

    const method = init.method ?? (input instanceof Request ? input.method : "GET");
    const headers = new Headers(input instanceof Request ? input.headers : undefined);
    if (init.headers) {
      new Headers(init.headers).forEach((value, key) => headers.set(key, value));
    }
    headers.set("accept-encoding", "identity");

    const signal =
      input instanceof Request && init.signal && input.signal !== init.signal
        ? AbortSignal.any([input.signal, init.signal])
        : (init.signal ?? (input instanceof Request ? input.signal : undefined));
    if (signal?.aborted) throw toAbortError(signal.reason);

    const body = await resolveBody(input, init);
    if (signal?.aborted) throw toAbortError(signal.reason);

    return await new Promise<Response>((resolve, reject) => {
      let headerSettled = false;
      let connectTimer: ReturnType<typeof setTimeout> | undefined;
      let onConnectAbort: (() => void) | undefined;

      const clearConnectGuards = () => {
        if (connectTimer !== undefined) {
          clearTimeout(connectTimer);
          connectTimer = undefined;
        }
        if (signal && onConnectAbort) {
          signal.removeEventListener("abort", onConnectAbort);
          onConnectAbort = undefined;
        }
      };

      const failBeforeHeaders = (error: unknown) => {
        if (headerSettled) return;
        headerSettled = true;
        clearConnectGuards();
        reject(error);
      };

      const request = httpsRequest(
        target,
        {
          method,
          headers: Object.fromEntries(headers.entries()),
          agent,
        },
        (response) => {
          if (headerSettled) {
            response.resume();
            return;
          }
          headerSettled = true;
          clearConnectGuards();

          const status = response.statusCode ?? 0;
          if (status === 0) {
            response.resume();
            reject(new Error("proxy fetch: no response status"));
            return;
          }

          const responseHeaders = new Headers();
          for (const [name, value] of Object.entries(response.headers)) {
            if (value === undefined) continue;
            if (HOP_BY_HOP_AND_ENCODING.has(name.toLowerCase())) continue;
            if (Array.isArray(value)) {
              for (const item of value) responseHeaders.append(name, item);
            } else {
              responseHeaders.set(name, value);
            }
          }

          if (nullBodyStatus(status)) {
            response.resume();
            resolve(
              new Response(null, {
                status,
                statusText: response.statusMessage ?? "",
                headers: responseHeaders,
              }),
            );
            return;
          }

          let streamClosed = false;
          let bodyEnded = false;
          let totalBytes = 0;
          let bodyIdleTimer: ReturnType<typeof setTimeout> | undefined;
          let onBodyAbort: (() => void) | undefined;

          const clearBodyGuards = () => {
            if (bodyIdleTimer !== undefined) {
              clearTimeout(bodyIdleTimer);
              bodyIdleTimer = undefined;
            }
            if (signal && onBodyAbort) {
              signal.removeEventListener("abort", onBodyAbort);
              onBodyAbort = undefined;
            }
          };

          const bodyStream = new ReadableStream<Uint8Array>({
            start(controller) {
              const failStream = (error: Error) => {
                if (streamClosed) return;
                streamClosed = true;
                clearBodyGuards();
                response.destroy();
                request.destroy();
                controller.error(error);
              };

              const resetBodyIdleTimer = () => {
                if (bodyIdleTimer !== undefined) clearTimeout(bodyIdleTimer);
                bodyIdleTimer = setTimeout(() => {
                  failStream(new Error(`proxy fetch timed out after ${idleTimeoutMs}ms`));
                }, idleTimeoutMs);
                bodyIdleTimer.unref?.();
              };

              resetBodyIdleTimer();

              if (signal) {
                onBodyAbort = () => failStream(toAbortError(signal.reason));
                if (signal.aborted) {
                  onBodyAbort();
                  return;
                }
                signal.addEventListener("abort", onBodyAbort, { once: true });
              }

              response.on("data", (chunk: Buffer | string) => {
                if (streamClosed) return;
                resetBodyIdleTimer();
                const buf = typeof chunk === "string" ? Buffer.from(chunk) : chunk;
                totalBytes += buf.byteLength;
                if (maxResponseBytes !== undefined && totalBytes > maxResponseBytes) {
                  failStream(new Error(`proxy fetch response exceeded ${maxResponseBytes} bytes`));
                  return;
                }
                controller.enqueue(new Uint8Array(buf));
                if ((controller.desiredSize ?? 0) <= 0) response.pause();
              });

              response.on("end", () => {
                if (streamClosed) return;
                bodyEnded = true;
                if (!response.complete) {
                  failStream(new Error("proxy fetch: upstream truncated response"));
                  return;
                }
                streamClosed = true;
                clearBodyGuards();
                controller.close();
              });

              response.on("error", (error) => {
                failStream(error instanceof Error ? error : new Error(String(error)));
              });

              response.on("close", () => {
                if (!bodyEnded && !streamClosed) {
                  failStream(new Error("proxy fetch: upstream connection closed prematurely"));
                }
              });
            },
            pull() {
              if (!streamClosed && !bodyEnded) response.resume();
            },
            cancel() {
              if (streamClosed) return;
              streamClosed = true;
              clearBodyGuards();
              response.destroy();
              request.destroy();
            },
          });

          resolve(
            new Response(bodyStream, {
              status,
              statusText: response.statusMessage ?? "",
              headers: responseHeaders,
            }),
          );
        },
      );

      connectTimer = setTimeout(() => {
        const err = new Error(`proxy fetch timed out after ${idleTimeoutMs}ms`);
        request.destroy(err);
        failBeforeHeaders(err);
      }, idleTimeoutMs);
      connectTimer.unref?.();

      if (signal) {
        onConnectAbort = () => {
          const err = toAbortError(signal.reason);
          request.destroy(err);
          failBeforeHeaders(err);
        };
        signal.addEventListener("abort", onConnectAbort, { once: true });
      }

      request.on("error", (error) => {
        failBeforeHeaders(error);
      });
      request.end(body);
    });
  };

  return proxied as typeof fetch;
}

/** 全局包装只用装一次；hosts → 代理 fetch 的映射在包装内部实时读，后续增删都生效。 */
const SCOPED_INSTALLED = Symbol.for("yugang.scopedProxyFetch");
const scopedProxies = new Map<string, typeof fetch>();

function requestUrl(input: unknown): URL | undefined {
  try {
    if (typeof input === "string") return new URL(input);
    if (input instanceof URL) return input;
    if (input && typeof (input as { url?: unknown }).url === "string") return new URL((input as { url: string }).url);
  } catch {
    // 解析不了就当作不匹配，交给原 fetch
  }
  return undefined;
}

/**
 * provider 级代理的总开关：把指定主机的请求挂到代理上，其余主机原样放行。
 *
 * 这是“这个 provider 做什么都走代理”的兼底：pi-ai 的模型流、内部 OAuth 刷新（裸 fetch）、
 * 以及任何忘了显式传 fetchImpl 的新代码，只要目标是这个 provider 的域名就会走隧道；
 * deepseek / zai / SD / QQ 的域名不在表里，仍然直连。
 */
export function registerScopedProxy(hosts: readonly string[], proxyFetch: typeof fetch): void {
  for (const host of hosts) {
    const key = host.trim().toLowerCase();
    if (key) scopedProxies.set(key, proxyFetch);
  }
  if ((globalThis as Record<symbol, unknown>)[SCOPED_INSTALLED]) return;
  (globalThis as Record<symbol, unknown>)[SCOPED_INSTALLED] = true;
  const original = globalThis.fetch.bind(globalThis);
  globalThis.fetch = ((input: unknown, init?: RequestInit) => {
    const url = requestUrl(input);
    const proxied = url ? scopedProxies.get(url.hostname.toLowerCase()) : undefined;
    return proxied ? proxied(input as string, init) : original(input as string, init);
  }) as typeof fetch;
}
