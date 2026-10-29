/**
 * imggen —— 生图（ModelScope API-Inference，Qwen-Image）。
 *
 * 异步两步：POST 建任务拿 task_id → 轮询任务直到出图 URL → 下载落盘。
 * 图存到 <mediaRoot>/gen/，返回 gen/ 引用，真正发图仍走 say 的 media 参数（出口唯一）。
 * 一轮最多生一次，只有真的拿到图才消耗机会。
 */
import { mkdirSync, writeFile } from "node:fs";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { Type } from "@earendil-works/pi-ai";
import { LiveDoc, defineTool } from "@earendil-works/pi-durable";
import { renderTemplate, requireTool, type PromptSet } from "../prompts.ts";

export interface ImggenDeps {
  prompts: PromptSet;
  mediaRoot: string;
  /** ModelScope API-KEY；缺省时工具仍注册，但调用会返回可读错误。 */
  key?: string;
  model?: string;
  timeoutMs?: number;
  fetchImpl?: typeof fetch;
}

const GENERATED = new Map<string, unknown>(); // conversationId → 本轮已生图次数的轮标识
const API_BASE = "https://api-inference.modelscope.cn/v1";

export function createImggenTool(deps: ImggenDeps) {
  const prompt = requireTool(deps.prompts, "imggen");
  const model = deps.model ?? "Qwen/Qwen-Image";
  const timeoutMs = deps.timeoutMs ?? 120_000;
  const doFetch = deps.fetchImpl ?? fetch;
  const outDir = join(deps.mediaRoot, "gen");

  return defineTool({
    name: "imggen",
    description: prompt.description,
    callers: ["model"],
    parameters: Type.Object({
      prompt: Type.String({ description: prompt.params["prompt"] ?? "" }),
    }),
    execute: async (args, api, context) => {
      const text = args.prompt.trim();
      if (!text || text.length > 500) {
        throw new Error(deps.prompts.messages["imggen_prompt"] ?? "prompt 不对");
      }
      if (!deps.key) {
        throw new Error(deps.prompts.messages["imggen_nokey"] ?? "没有配置生图凭据");
      }

      // 每轮限一次，与 meme 同款节奏；失败不消耗机会
      const live = await api.snapshot(LiveDoc, api.conversationId, context);
      const round = live?.run?.inputs?.[0];
      if (round !== undefined && GENERATED.get(api.conversationId) === round) {
        throw new Error(deps.prompts.messages["imggen_used"] ?? "这一轮生过图了");
      }

      const headers = {
        "content-type": "application/json",
        authorization: `Bearer ${deps.key}`,
        "X-ModelScope-Async-Mode": "true",
        "Model-Id": model,
      };
      const ctrl = new AbortController();
      const timer = setTimeout(() => ctrl.abort(), timeoutMs);
      try {
        // 建任务
        const res = await doFetch(`${API_BASE}/images/generations`, {
          method: "POST",
          signal: ctrl.signal,
          headers,
          body: JSON.stringify({ model, prompt: text }),
        });
        if (!res.ok) throw new Error(`submit HTTP ${res.status}`);
        const { task_id: taskId } = (await res.json()) as { task_id?: string };
        if (!taskId) throw new Error("no task_id");

        // 轮询出图
        const deadline = Date.now() + timeoutMs;
        let urls: string[] = [];
        for (;;) {
          if (Date.now() > deadline) throw new Error("timeout");
          await new Promise((r) => setTimeout(r, 3000).unref?.());
          const poll = await doFetch(`${API_BASE}/tasks/${taskId}`, {
            signal: ctrl.signal,
            headers: { authorization: `Bearer ${deps.key}` },
          });
          if (!poll.ok) throw new Error(`poll HTTP ${poll.status}`);
          const j = (await poll.json()) as { task_status?: string; output_images?: string[] };
          if (j.task_status === "SUCCEED" || j.task_status === "TASK_STATUS_SUCCEED") {
            urls = j.output_images ?? [];
            break;
          }
          if (j.task_status === "FAILED" || j.task_status === "TASK_STATUS_FAILED") throw new Error("生成失败");
        }
        if (urls.length === 0) throw new Error("没拿到图");

        // 下载落盘
        mkdirSync(outDir, { recursive: true });
        const file = `${Date.now()}-${randomUUID().slice(0, 8)}.png`;
        const img = await doFetch(urls[0]!, { signal: ctrl.signal });
        if (!img.ok) throw new Error(`download HTTP ${img.status}`);
        await writeFile(join(outDir, file), new Uint8Array(await img.arrayBuffer()));

        if (round !== undefined) GENERATED.set(api.conversationId, round);
        return {
          output: [{
            type: "text",
            text: renderTemplate(deps.prompts.messages["imggen_done"] ?? "gen/{{file}}", { file }),
          }],
        };
      } catch (error) {
        throw new Error(renderTemplate(
          deps.prompts.messages["imggen_failed"] ?? "生图没成功",
          { detail: error instanceof Error ? error.message : "未知" },
        ));
      } finally {
        clearTimeout(timer);
      }
    },
  });
}
