/**
 * search —— 联网搜索（DeepSeek Search API）。
 *
 * 窄接口：只搜关键词，返回标题/链接/摘要；不抓正文、不打开网页。
 * 网页内容是不可信输入，摘要只做参考素材，不让它决定鱼说什么。
 * 一轮最多两次（与 look 同样的节奏限制）。
 */
import { Type } from "@earendil-works/pi-ai";
import { LiveDoc, defineTool } from "@earendil-works/pi-durable";
import { renderTemplate, requireTool, type PromptSet } from "../prompts.ts";

export interface SearchDeps {
  prompts: PromptSet;
  /** DeepSeek API key；缺省时工具仍注册，但调用会返回可读错误。 */
  key?: string;
  endpoint?: string;
  count?: number;
  timeoutMs?: number;
  fetchImpl?: typeof fetch;
}

const SEARCHED = new Map<string, unknown>(); // conversationId → 本轮已搜次数的轮标识

export function createSearchTool(deps: SearchDeps) {
  const prompt = requireTool(deps.prompts, "search");
  const endpoint = deps.endpoint ?? "https://api.deepseek.com/v1/tools/search";
  const count = deps.count ?? 4;
  const timeoutMs = deps.timeoutMs ?? 20_000;
  const doFetch = deps.fetchImpl ?? fetch;

  return defineTool({
    name: "search",
    description: prompt.description,
    callers: ["model"],
    parameters: Type.Object({
      query: Type.String({ description: prompt.params["query"] ?? "" }),
    }),
    execute: async (args, api, context) => {
      const query = args.query.trim();
      if (!query || query.length > 128) {
        throw new Error(deps.prompts.messages["search_query"] ?? "query 长度不对");
      }
      if (!deps.key) {
        throw new Error(deps.prompts.messages["search_nokey"] ?? "没有配置搜索凭据");
      }

      // 每轮限两次：轮标识与 say 的每轮一次同源（run.inputs[0]，跨 generation 不变）
      const live = await api.snapshot(LiveDoc, api.conversationId, context);
      const round = live?.run?.inputs?.[0];
      if (round !== undefined) {
        if (SEARCHED.get(api.conversationId) === round) {
          throw new Error(deps.prompts.messages["search_used"] ?? "这一轮搜过了");
        }
        SEARCHED.set(api.conversationId, round);
      }

      const ctrl = new AbortController();
      const timer = setTimeout(() => ctrl.abort(), timeoutMs);
      try {
        const res = await doFetch(endpoint, {
          method: "POST",
          signal: ctrl.signal,
          headers: { "content-type": "application/json", authorization: `Bearer ${deps.key}` },
          body: JSON.stringify({ query, count }),
        });
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const j = (await res.json()) as { results?: { title?: string; url?: string; summary?: string; snippet?: string }[] };
        const list = (j.results ?? []).slice(0, count);
        if (list.length === 0) {
          return { output: [{ type: "text", text: "没搜到相关结果" }] };
        }
        const text = list
          .map((r, i) => {
            const title = String(r.title ?? "").slice(0, 80);
            const url = String(r.url ?? "");
            const brief = String(r.summary ?? r.snippet ?? "").slice(0, 300);
            return `${i + 1}. ${title}\n${url}\n${brief}`;
          })
          .join("\n\n");
        return { output: [{ type: "text", text }] };
      } catch {
        throw new Error(renderTemplate(deps.prompts.messages["search_failed"] ?? "搜索失败", { query }));
      } finally {
        clearTimeout(timer);
      }
    },
  });
}
