/**
 * video —— 看一眼 B 站视频。
 *
 * 模型看不了视频流，但「封面图 + 元数据 + 热评」足够像看过一样聊。
 * 窄接口：只吃 B 站链接或 BV 号，只出一条封面图和文本摘要；
 * 不解析弹幕、不下载视频本体。一轮最多一次。
 */
import { Type } from "@earendil-works/pi-ai";
import { LiveDoc, defineTool } from "@earendil-works/pi-durable";
import { renderTemplate, requireTool, type PromptSet } from "../prompts.ts";

export interface VideoDeps {
  prompts: PromptSet;
  fetchImpl?: typeof fetch;
  timeoutMs?: number;
}

const USED = new Map<string, unknown>(); // conversationId → 本轮已用的轮标识
const HEADERS = { "user-agent": "Mozilla/5.0", referer: "https://www.bilibili.com/" };

export function createVideoTool(deps: VideoDeps) {
  const prompt = requireTool(deps.prompts, "video");
  const doFetch = deps.fetchImpl ?? fetch;
  const timeoutMs = deps.timeoutMs ?? 20_000;

  async function getJson(url: string): Promise<any> {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), timeoutMs);
    try {
      const res = await doFetch(url, { headers: HEADERS, signal: ctrl.signal });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      return await res.json();
    } finally {
      clearTimeout(timer);
    }
  }

  return defineTool({
    name: "video",
    description: prompt.description,
    callers: ["model"],
    parameters: Type.Object({
      url: Type.String({ description: prompt.params["url"] ?? "" }),
    }),
    execute: async (args, api, context) => {
      const raw = args.url.trim();
      if (!raw || raw.length > 512) {
        throw new Error(deps.prompts.messages["video_invalid"] ?? "链接不对");
      }

      // 每轮限一次：轮标识与 say/search 同源
      const live = await api.snapshot(LiveDoc, api.conversationId, context);
      const round = live?.run?.inputs?.[0];
      if (round !== undefined) {
        if (USED.get(api.conversationId) === round) {
          throw new Error(deps.prompts.messages["video_used"] ?? "这一轮看过了");
        }
        USED.set(api.conversationId, round);
      }

      try {
        // 短链先展开
        let target = raw;
        if (/^https?:\/\/b23\.tv\//.test(raw)) {
          const res = await doFetch(raw, { headers: HEADERS, redirect: "follow" });
          target = res.url;
        }
        const bv = target.match(/BV[0-9A-Za-z]{10}/)?.[0];
        if (!bv) throw new Error("no bv");

        const view = await getJson(`https://api.bilibili.com/x/web-interface/view?bvid=${bv}`);
        if (view?.code !== 0 || !view?.data) throw new Error("view failed");
        const d = view.data;
        const meta = [
          `《${String(d.title).slice(0, 60)}》`,
          `UP主 ${d.owner?.name ?? "?"} · ${Math.round((d.duration ?? 0) / 60)} 分钟 · 播放 ${(d.stat?.view ?? 0).toLocaleString()}`,
          String(d.desc ?? "").replace(/\s+/g, " ").slice(0, 200),
        ].join("\n");

        // 热评：拿不到就静默略过（匿名访问偶发被风控）
        let comments = "";
        try {
          const reply = await getJson(`https://api.bilibili.com/x/v2/reply/main?type=1&oid=${d.aid}&mode=3&next=0`);
          const top = (reply?.data?.replies ?? []).slice(0, 3) as { content?: { message?: string } }[];
          if (top.length > 0) {
            comments = "\n热评：\n" + top.map((c, i) => `${i + 1}. ${String(c.content?.message ?? "").replace(/\s+/g, " ").slice(0, 100)}`).join("\n");
          }
        } catch {
          // 评论区拿不到不影响看视频本身
        }

        // 封面：真「看一眼」
        const picUrl = String(d.pic ?? "").replace(/^http:/, "https:");
        if (!picUrl) {
          return { output: [{ type: "text", text: meta + comments }] };
        }
        const picRes = await doFetch(picUrl, { headers: HEADERS });
        if (!picRes.ok) {
          return { output: [{ type: "text", text: meta + comments + "\n（封面没取到）" }] };
        }
        const mime = picRes.headers.get("content-type")?.split(";")[0] ?? "image/jpeg";
        const data = Buffer.from(await picRes.arrayBuffer()).toString("base64");
        return {
          output: [
            { type: "text", text: meta + comments },
            { type: "image", data, mimeType: mime },
          ],
        };
      } catch {
        throw new Error(renderTemplate(deps.prompts.messages["video_failed"] ?? "视频没打开", { url: raw }));
      }
    },
  });
}
