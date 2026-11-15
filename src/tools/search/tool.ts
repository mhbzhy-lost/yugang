/**
 * search —— 联网搜索（DeepSeek Search API）。
 *
 * 窄接口：只搜关键词，返回标题/链接/摘要；不抓正文、不打开网页。
 * 网页内容是不可信输入：标题/摘要过 sanitizeExternalText 并抹掉内嵌 URL，链接过 sanitizeUrl
 * （非法即丢弃）——只有显式合法 URL 才交给出口侧的 seen-links 登记，摘要只做参考素材。
 * 一轮最多一次：fetch 前原子占位，空结果/失败释放（不计数），成功锁定；缺轮标识 fail closed。
 *
 * 说明文字与参数 Schema 唯一来自 TOOL.md manifest（factory 只消费它，不再有第二份运行时定义）。
 */
import { LiveDoc, defineTool, type ConversationId, type ToolRegistration } from "@earendil-works/pi-durable";
import { sanitizeExternalText, sanitizeUrl } from "../../external/sanitize.ts";
import { renderTemplate } from "../../prompt/index.ts";
import { manifestParameters, toolFullDescription } from "../manifest.ts";
import type { ToolManifest, ToolPackageDeps } from "../types.ts";

/** args 静态类型：与 TOOL.md 的参数 Schema 一一对应；运行时 Schema 只有 manifest 这一份。 */
interface SearchArgs {
  query: string;
}

const SEARCHED = new Map<ConversationId, SearchLease>(); // conversationId → 当前轮搜索占位（留在表里即成功锁）
const SEARCH_RESPONSE_MAX_BYTES = 1 * 1024 * 1024;
const SEARCH_RESULTS_MAX = 100;
const EMBEDDED_URL_RE = /(?:https?:\/\/|www\.)[^\s<>'"`]+/gi;

/** 一次搜索的占位；对象身份用于释放时核对「还是不是自己那次」，避免顶掉别轮的占位。 */
type SearchLease = { round: unknown };

class SearchResponseError extends Error {}

export function createSearchTool(manifest: ToolManifest, deps: ToolPackageDeps): ToolRegistration {
  const endpoint = "https://api.deepseek.com/v1/tools/search";
  const count = 4;
  const timeoutMs = 20_000;
  const doFetch = fetch;

  return defineTool({
    name: manifest.name,
    description: toolFullDescription(manifest),
    callers: ["model"],
    parameters: manifestParameters<SearchArgs>(manifest),
    execute: async (args, api, context) => {
      const query = args.query.trim();
      if (!query || query.length > 128) {
        throw new Error(deps.prompts.messages["search_query"] ?? "query 长度不对");
      }
      if (!deps.searchKey) {
        throw new Error(deps.prompts.messages["search_nokey"] ?? "没有配置搜索凭据");
      }

      // 每轮限一次：轮标识与出口工具的轮计数同源。缺轮标识时拒绝联网，避免无法绑定额度。
      const live = await api.snapshot(LiveDoc, api.conversationId, context);
      const round = live?.run?.inputs?.[0];
      if (round === undefined || round === null) {
        throw new Error(deps.prompts.messages["search_round_missing"] ?? "当前轮次不可用，无法搜索");
      }

      // Map.set 是同步操作：检查与占位之间没有 await，第一次 await fetch 前占位已就位，
      // 因而同一会话/轮的并发调用只有一个能发出请求。
      const previous = SEARCHED.get(api.conversationId);
      if (previous !== undefined && Object.is(previous.round, round)) {
        throw new Error(deps.prompts.messages["search_used"] ?? "这一轮搜过了");
      }
      const lease: SearchLease = { round };
      SEARCHED.set(api.conversationId, lease);
      const release = (): void => {
        if (SEARCHED.get(api.conversationId) === lease) SEARCHED.delete(api.conversationId);
      };

      const ctrl = new AbortController();
      const timer = setTimeout(() => ctrl.abort(), timeoutMs);
      try {
        const res = await doFetch(endpoint, {
          method: "POST",
          signal: ctrl.signal,
          headers: { "content-type": "application/json", authorization: `Bearer ${deps.searchKey}` },
          body: JSON.stringify({ query, count }),
        });
        if (!res.ok) throw new SearchResponseError(`HTTP ${res.status}`);
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
        const list = (Array.isArray(rawResults) ? rawResults : []).slice(0, count).flatMap((raw) => {
          if (raw === null || typeof raw !== "object" || Array.isArray(raw)) return [];
          const result = raw as Record<string, unknown>;
          const url = sanitizeUrl(typeof result.url === "string" ? result.url : "");
          if (url === undefined) return [];
          const title = cleanSearchText(result.title, 80);
          const summary = cleanSearchText(result.summary, 300);
          const snippet = cleanSearchText(result.snippet, 300);
          return [{ title, url, brief: summary || snippet }];
        });
        if (list.length === 0) {
          release();
          return { output: [{ type: "text", text: "没搜到相关结果" }] };
        }
        const text = list
          .map((r, i) => `${i + 1}. ${r.title}\n${r.url}\n${r.brief}`)
          .join("\n\n");
        // 成功：占位留在 SEARCHED 里就是本轮的锁，同轮再搜一律 search_used。
        return { output: [{ type: "text", text }] };
      } catch (error) {
        release();
        // search_used 在 fetch 前抛出；AbortError 与网络异常也必须原样透出，不能伪装成 search_failed。
        if (!(error instanceof SearchResponseError)) throw error;
        throw new Error(renderTemplate(deps.prompts.messages["search_failed"] ?? "搜索没成功，换个说法或直接说不知道", { query }));
      } finally {
        clearTimeout(timer);
      }
    },
  });
}

/** 清洗外部文本，并移除标题/摘要里的 URL，避免出口侧把它们误登记为显式链接。 */
function cleanSearchText(value: unknown, maxLen: number): string {
  const sanitized = sanitizeExternalText(typeof value === "string" ? value : "", { maxLen });
  return sanitizeExternalText(sanitized.replace(EMBEDDED_URL_RE, " "), { maxLen });
}

/** 读取响应体并封顶；兼容没有 ReadableStream body 的测试/运行时 Response。 */
async function readResponseBodyCapped(res: Response): Promise<string> {
  const declared = Number(res.headers.get("content-length") ?? "");
  if (Number.isFinite(declared) && declared > SEARCH_RESPONSE_MAX_BYTES) {
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
  // 读流过程中的 abort/网络异常原样上抛（不伪装成 search_failed）；只有超限才在这里收口。
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
