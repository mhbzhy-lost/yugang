/**
 * DeepSeek Search 共享客户端（2026-11-25 从 src/tools/search/tool.ts 抽出）。
 *
 * 只做一件事：POST 关键词到 DeepSeek Search API，封顶校验响应，返回**未清洗**的
 * 原始字段（rawTitle/rawSummary/rawSnippet）+ 已解析的 date/publishedAtMs/rerankScore，
 * 截断与选优规则留给各调用方（search 用 summary||snippet，bili_search 用 snippet 优先）。
 *
 * 机械边界（与旧 search/tool.ts 逐字等价）：
 *  - `rawResults.slice(0, count)` **先于** URL 过滤：前 count 条里的非法 URL 直接丢，
 *    不越界补后面的条目；
 *  - URL 过 sanitizeUrl（scheme 白名单，非法即丢弃）；
 *  - 响应非 2xx / 非 JSON / 非法结构 / 超结果上限 / 超 1MiB → SearchResponseError；
 *  - 网络错误、超时与外部 AbortSignal 取消**原样上抛**（AbortError 不包装），
 *    调用方只把 SearchResponseError 翻译成用户文案。
 *
 * 这里不放任何模型可见文案。
 */
import { sanitizeExternalText, sanitizeUrl } from "./sanitize.ts";

export const DEEPSEEK_SEARCH_ENDPOINT = "https://api.deepseek.com/v1/tools/search";
export const SEARCH_RESPONSE_MAX_BYTES = 1 * 1024 * 1024;
export const SEARCH_RESULTS_MAX = 100;

const EMBEDDED_URL_RE = /(?:https?:\/\/|www\.)[^\s<>'"`]+/gi;

/** 响应侧错误（HTTP/结构/封顶）；网络与取消不属于它，原样上抛。 */
export class SearchResponseError extends Error {}

/** 一条搜索结果：url 已过 sanitizeUrl；raw* 是原文，调用方自行清洗截断。 */
export interface DeepSeekSearchItem {
  url: string;
  rawTitle: string;
  rawSummary: string;
  rawSnippet: string;
  /** 响应原始 date 字符串（非法/缺失时保留原样或 undefined）。 */
  date?: string;
  /** date 可解析时的发布时间（ms）；解析失败为 undefined。 */
  publishedAtMs?: number;
  /** 响应 rerank_score（仅有限数才映射）。 */
  rerankScore?: number;
}

export interface DeepSeekSearchOptions {
  apiKey: string;
  query: string;
  count: number;
  /** 单次请求超时（缺省 20s），与外部 signal 合成。 */
  timeoutMs?: number;
  endpoint?: string;
  /** 外部取消信号（工具外层超时/宿主中止）；已 aborted 直接拒绝，不发请求。 */
  signal?: AbortSignal;
  fetch?: typeof fetch;
}

/** 清洗外部文本，并移除标题/摘要里的 URL，避免出口侧把它们误登记为显式链接。 */
export function cleanSearchText(value: unknown, maxLen: number): string {
  const sanitized = sanitizeExternalText(typeof value === "string" ? value : "", { maxLen });
  return sanitizeExternalText(sanitized.replace(EMBEDDED_URL_RE, " "), { maxLen });
}

export async function deepseekSearch(options: DeepSeekSearchOptions): Promise<DeepSeekSearchItem[]> {
  const doFetch = options.fetch ?? fetch;
  const endpoint = options.endpoint ?? DEEPSEEK_SEARCH_ENDPOINT;
  const timeoutMs = options.timeoutMs ?? 20_000;
  const external = options.signal;
  if (external?.aborted) throw external.reason;

  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  const onAbort = (): void => ctrl.abort(external?.reason);
  external?.addEventListener("abort", onAbort, { once: true });
  try {
    const res = await doFetch(endpoint, {
      method: "POST",
      signal: ctrl.signal,
      headers: { "content-type": "application/json", authorization: `Bearer ${options.apiKey}` },
      body: JSON.stringify({ query: options.query, count: options.count }),
    });
    if (!res.ok) {
      await Promise.resolve(res.body?.cancel()).catch(() => undefined);
      throw new SearchResponseError(`HTTP ${res.status}`);
    }
    const body = await readResponseBodyCapped(res);
    let j: unknown;
    try {
      j = JSON.parse(body);
    } catch {
      throw new SearchResponseError("响应不是 JSON");
    }
    if (j === null || typeof j !== "object" || Array.isArray(j)) {
      throw new SearchResponseError("响应格式不对");
    }
    const rawResults = (j as { results?: unknown }).results;
    if (rawResults !== undefined && !Array.isArray(rawResults)) {
      throw new SearchResponseError("响应结果格式不对");
    }
    if (Array.isArray(rawResults) && rawResults.length > SEARCH_RESULTS_MAX) {
      throw new SearchResponseError("响应结果过多");
    }
    // 顺序契约：先 slice(0, count) 再逐项校验 URL——非法条目丢弃但不越界补位。
    return (Array.isArray(rawResults) ? rawResults : []).slice(0, options.count).flatMap((raw) => {
      if (raw === null || typeof raw !== "object" || Array.isArray(raw)) return [];
      const result = raw as Record<string, unknown>;
      const url = sanitizeUrl(typeof result.url === "string" ? result.url : "");
      if (url === undefined) return [];
      const date = typeof result.date === "string" ? result.date : undefined;
      const parsed = date !== undefined ? Date.parse(date) : Number.NaN;
      const rerank = typeof result.rerank_score === "number" && Number.isFinite(result.rerank_score)
        ? result.rerank_score
        : undefined;
      return [{
        url,
        rawTitle: typeof result.title === "string" ? result.title : "",
        rawSummary: typeof result.summary === "string" ? result.summary : "",
        rawSnippet: typeof result.snippet === "string" ? result.snippet : "",
        ...(date !== undefined ? { date } : {}),
        ...(Number.isFinite(parsed) ? { publishedAtMs: parsed } : {}),
        ...(rerank !== undefined ? { rerankScore: rerank } : {}),
      }];
    });
  } finally {
    clearTimeout(timer);
    external?.removeEventListener("abort", onAbort);
  }
}

/** 读取响应体并封顶；兼容没有 ReadableStream body 的测试/运行时 Response。 */
async function readResponseBodyCapped(res: Response): Promise<string> {
  const declared = Number(res.headers.get("content-length") ?? "");
  if (Number.isFinite(declared) && declared > SEARCH_RESPONSE_MAX_BYTES) {
    await Promise.resolve(res.body?.cancel()).catch(() => undefined);
    throw new SearchResponseError(`响应超限(>${SEARCH_RESPONSE_MAX_BYTES}B)`);
  }
  const reader = res.body?.getReader();
  if (reader === undefined) {
    const text = await res.text();
    if (Buffer.byteLength(text, "utf8") > SEARCH_RESPONSE_MAX_BYTES) {
      throw new SearchResponseError(`响应超限(>${SEARCH_RESPONSE_MAX_BYTES}B)`);
    }
    return text;
  }
  const chunks: Uint8Array[] = [];
  let total = 0;
  // 读流过程中的 abort/网络异常原样上抛（不伪装成响应错误）；只有超限才在这里收口。
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    if (value === undefined) continue;
    total += value.byteLength;
    if (total > SEARCH_RESPONSE_MAX_BYTES) {
      await reader.cancel().catch(() => undefined);
      throw new SearchResponseError(`响应超限(>${SEARCH_RESPONSE_MAX_BYTES}B)`);
    }
    chunks.push(value);
  }
  const merged = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    merged.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return new TextDecoder("utf-8").decode(merged);
}