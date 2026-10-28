/**
 * test —— 跑一遍全量测试集（npm test）。
 *
 * 主人身份闸与 fs 工具组同源。固定命令、不接受任何参数拼接——
 * 这是「能执行的那一条命令」而不是通用 shell。输出截尾返回。
 */
import { spawnSync } from "node:child_process";
import { resolve } from "node:path";
import { Type } from "@earendil-works/pi-ai";
import { LiveDoc, defineTool } from "@earendil-works/pi-durable";
import type { PromptSet } from "../prompts.ts";

export interface TestDeps {
  prompts: PromptSet;
  root?: string;
  master: string;
  triggerOf?: (roundId: unknown) => { messageId?: number | string; mentionsBot: boolean; userId?: number } | undefined;
  timeoutMs?: number;
}

const OUTPUT_CAP = 6_000;

export function createTestTool(deps: TestDeps) {
  const prompt = deps.prompts.tools["test"];
  const root = resolve(deps.root ?? process.cwd());

  return defineTool({
    name: "test",
    description: prompt.description,
    callers: ["model"],
    parameters: Type.Object({}),
    execute: async (_args, api, context) => {
      const live = await api.snapshot(LiveDoc, api.conversationId, context);
      const round = live?.run?.inputs?.[0];
      const trigger = round !== undefined ? deps.triggerOf?.(round) : undefined;
      if (!trigger || String(trigger.userId) !== deps.master) {
        throw new Error(deps.prompts.messages["fs_locked"] ?? "fs_locked");
      }

      console.log(`[fish] test: npm test (cwd=${root === process.cwd() ? "." : root})`);
      const res = spawnSync("npm", ["test"], {
        cwd: root,
        encoding: "utf8",
        timeout: deps.timeoutMs ?? 180_000,
        maxBuffer: 4 * 1024 * 1024,
      });
      const out = `${res.stdout ?? ""}${res.stderr ?? ""}`.trim();
      const text = out.length > OUTPUT_CAP ? `…（截头）\n${out.slice(-OUTPUT_CAP)}` : out || "(无输出)";
      const ok = res.status === 0;
      return { output: [{ type: "text", text: `${ok ? "全部通过" : "有失败"}\n${text}` }] };
    },
  });
}
