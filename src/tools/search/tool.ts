/**
 * search —— 联网搜索（DeepSeek Search API）。
 *
 * 窄接口：只搜关键词，返回标题/链接/摘要；不抓正文、不打开网页。
 * 网页内容是不可信输入，摘要只做参考素材，不让它决定鱼说什么。
 * 一轮最多两次（与 look 同样的节奏限制）。
 *
 * 说明文字与参数 Schema 唯一来自 TOOL.md manifest（factory 只消费它，不再有第二份运行时定义）。
 */
import { LiveDoc, defineTool, type ToolRegistration } from "@earendil-works/pi-durable";
import { renderTemplate } from "../../prompts.ts";
import { manifestParameters, toolFullDescription } from "../manifest.ts";
import type { ToolManifest, ToolPackageDeps } from "../types.ts";

/** args 静态类型：与 TOOL.md 的参数 Schema 一一对应；运行时 Schema 只有 manifest 这一份。 */
interface SearchArgs {
  query: string;
}

const SEARCHED = new Map<string, unknown>(); // conversationId → 本轮已搜次数的轮标识

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

      // 每轮限一次：轮标识与 say 的每轮一次同源；只有真正返回结果才计数，
      // 空结果/失败不消耗机会，模型可以换词重试
      const live = await api.snapshot(LiveDoc, api.conversationId, context);
      const round = live?.run?.inputs?.[0];

      const ctrl = new AbortController();
      const timer = setTimeout(() => ctrl.abort(), timeoutMs);
      try {
        const res = await doFetch(endpoint, {
          method: "POST",
          signal: ctrl.signal,
          headers: { "content-type": "application/json", authorization: `Bearer ${deps.searchKey}` },
          body: JSON.stringify({ query, count }),
        });
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const j = (await res.json()) as { results?: { title?: string; url?: string; summary?: string; snippet?: string }[] };
        const list = (j.results ?? []).slice(0, count);
        if (list.length === 0) {
          return { output: [{ type: "text", text: "没搜到相关结果" }] };
        }
        if (round !== undefined) {
          if (SEARCHED.get(api.conversationId) === round) {
            throw new Error(deps.prompts.messages["search_used"] ?? "这一轮搜过了");
          }
          SEARCHED.set(api.conversationId, round);
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
