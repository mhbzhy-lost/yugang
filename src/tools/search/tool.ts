/**
 * search —— 联网搜索（DeepSeek Search API）。
 *
 * 窄接口：只搜关键词，返回标题/链接/摘要；不抓正文、不打开网页。
 * HTTP 客户端、响应封顶校验与取消信号合成在共享模块 src/external/deepseek-search.ts
 * （bili_search 同源复用）；本文件只保留 search 自己的截断/选优与轮内额度：
 * 标题 cleanSearchText(rawTitle, 80)，brief 保持 summary || snippet 优先序（各 300 字）。
 * 一轮最多一次：请求前原子占位，空结果/失败释放（不计数），成功锁定；缺轮标识 fail closed。
 *
 * 说明文字与参数 Schema 唯一来自 TOOL.md manifest（factory 只消费它，不再有第二份运行时定义）。
 */
import { LiveDoc, defineTool, type ConversationId, type ToolRegistration } from "@earendil-works/pi-durable";
import { SearchResponseError, cleanSearchText, deepseekSearch } from "../../external/deepseek-search.ts";
import { renderTemplate } from "../../prompt/index.ts";
import { manifestParameters, toolFullDescription } from "../manifest.ts";
import type { ToolManifest, ToolPackageDeps } from "../types.ts";

/** args 静态类型：与 TOOL.md 的参数 Schema 一一对应；运行时 Schema 只有 manifest 这一份。 */
interface SearchArgs {
  query: string;
}

const SEARCHED = new Map<ConversationId, SearchLease>(); // conversationId → 当前轮搜索占位（留在表里即成功锁）

/** 一次搜索的占位；对象身份用于释放时核对「还是不是自己那次」，避免顶掉别轮的占位。 */
type SearchLease = { round: unknown };

/** 注入口：fetch 可替换供测试（缺省全局 fetch），行为与线上完全一致。 */
export interface SearchToolOptions {
  fetch?: typeof fetch;
}

export function createSearchTool(manifest: ToolManifest, deps: ToolPackageDeps, options: SearchToolOptions = {}): ToolRegistration {
  const count = 4;
  const timeoutMs = 20_000;

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

      // Map.set 是同步操作：检查与占位之间没有 await，第一次 await 请求前占位已就位，
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

      try {
        const results = await deepseekSearch({
          apiKey: deps.searchKey,
          query,
          count,
          timeoutMs,
          signal: context?.abortSignal,
          fetch: options.fetch,
        });
        const list = results.map((r) => ({
          title: cleanSearchText(r.rawTitle, 80),
          url: r.url,
          brief: cleanSearchText(r.rawSummary, 300) || cleanSearchText(r.rawSnippet, 300),
        }));
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
        // search_used 在请求前抛出；AbortError 与网络异常也必须原样透出，不能伪装成 search_failed。
        if (!(error instanceof SearchResponseError)) throw error;
        throw new Error(renderTemplate(deps.prompts.messages["search_failed"] ?? "搜索没成功，换个说法或直接说不知道", { query }));
      }
    },
  });
}