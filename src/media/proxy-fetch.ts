/**
 * provider 级代理：只给指定 provider 造一条 fetch，不动全局。
 *
 * 为什么不用 `--use-env-proxy` / NODE_USE_ENV_PROXY：那是进程级的，pi-ai 的模型请求
 * 同样走 globalThis.fetch，一开就把 zai / deepseek 也塞进代理，代理挂了两边一起哑。
 * 这里照 pi-config 的 openai-proxy 思路，只把 openai-codex 的请求交给
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

/** 默认 socket 空闲超时：每次收到字节都会自动续期，防止半开连接在代理上干挂 600s。 */
export const DEFAULT_PROXY_IDLE_TIMEOUT_MS = 120_000;

export interface ProxyFetchOptions {
  /** 底层 socket 空闲超时（毫秒），缺省 120s。 */
  idleTimeoutMs?: number;
}

/**
 * 造一条走代理的 fetch（形状对齐 globalThis.fetch，只覆盖本仓实际用到的部分：
 * method / headers / string body / signal，返回全局 Response）。
 * 目标只支持 https —— draw_remote 与模型通道端点都是 https，别的协议直接抛，不静默直连。
 */
export function createProxyFetch(proxy: string, options: ProxyFetchOptions = {}): typeof fetch | undefined {
  if (!validProxy(proxy)) return undefined;
  const agent = new HttpsProxyAgent(proxy.trim());
  const idleTimeoutMs =
    typeof options.idleTimeoutMs === "number" && Number.isFinite(options.idleTimeoutMs) && options.idleTimeoutMs > 0
      ? options.idleTimeoutMs
      : DEFAULT_PROXY_IDLE_TIMEOUT_MS;

  const proxied = async (input: string | URL | Request, init: RequestInit = {}): Promise<Response> => {
    const target = new URL(typeof input === "string" ? input : input instanceof URL ? input.href : input.url);
    if (target.protocol !== "https:") throw new Error("proxy fetch supports https targets only");

    const headers = new Headers(init.headers);
    const body = typeof init.body === "string"
      ? init.body
      : // URLSearchParams 与全局 fetch 对齐：自动转成 urlencoded 字符串再发
        init.body instanceof URLSearchParams
        ? init.body.toString()
        : init.body === undefined || init.body === null
          ? undefined
          : Buffer.from(init.body as ArrayBuffer);

    const reply = await new Promise<{ status: number; statusText: string; body: Buffer; contentType: string; retryAfter: string }>((resolve, reject) => {
      const request = httpsRequest(
        target,
        {
          method: init.method ?? "GET",
          headers: Object.fromEntries(headers.entries()),
          agent,
          ...(init.signal ? { signal: init.signal } : {}),
        },
        (response) => {
          const chunks: Buffer[] = [];
          response.on("data", (chunk: Buffer | string) => chunks.push(typeof chunk === "string" ? Buffer.from(chunk) : chunk));
          response.on("end", () => {
            request.setTimeout(0);
            resolve({
              status: response.statusCode ?? 0,
              statusText: response.statusMessage ?? "",
              // 保留原始字节：先 toString("utf8") 会把 PNG/JPEG 里不成对的字节（如 0x89）换成 U+FFFD，
              // 图片下载回来就是坏图
              body: Buffer.concat(chunks),
              contentType: response.headers["content-type"] ?? "",
              retryAfter: typeof response.headers["retry-after"] === "string" ? response.headers["retry-after"] : "",
            });
          });
          response.on("error", reject);
        },
      );
      request.setTimeout(idleTimeoutMs, () => {
        request.destroy(new Error(`proxy fetch timed out after ${idleTimeoutMs}ms`));
      });
      request.on("error", reject);
      request.end(body);
    });
    if (reply.status === 0) throw new Error("proxy fetch: no response status");

    // 状态码与正文原样带回（正文保持原始字节，文本 / JSON / 二进制都逐字节无损；上游给了
    // content-type / retry-after 就一并带回）；这里不做重试、解压或重定向
    const responseHeaders = new Headers();
    if (reply.contentType) responseHeaders.set("content-type", reply.contentType);
    if (reply.retryAfter) responseHeaders.set("retry-after", reply.retryAfter);
    return new Response(nullBodyStatus(reply.status) ? null : new Uint8Array(reply.body), {
      status: reply.status,
      statusText: reply.statusText,
      headers: responseHeaders,
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
