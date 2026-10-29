/**
 * restart —— 重启鱼自己。
 *
 * 主人身份闸与 fs 工具同源（机械判 triggerOf 的 userId）。
 * 机制：3 秒后由脱离进程组的子进程重新拉起 npm run up，当前进程随后退出。
 * 协议端（QQ）不受影响。
 */
import { spawn } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { Type } from "@earendil-works/pi-ai";
import { LiveDoc, defineTool } from "@earendil-works/pi-durable";
import type { PromptSet } from "../prompts.ts";

export interface RestartDeps {
  prompts: PromptSet;
  root?: string;
  master: string;
  triggerOf?: (roundId: unknown) => { messageId?: number | string; mentionsBot: boolean; userId?: number } | undefined;
  exit?: (code: number) => never;
}

export function createRestartTool(deps: RestartDeps) {
  const prompt = deps.prompts.tools["restart"];
  const root = resolve(deps.root ?? process.cwd());
  const doExit = deps.exit ?? ((code: number) => process.exit(code));

  return defineTool({
    name: "restart",
    description: prompt.description,
    callers: ["model"],
    parameters: Type.Object({
      message: Type.String({
        description: prompt.params["message"] ?? "",
      }),
    }),
    execute: async (args, api, context) => {
      const live = await api.snapshot(LiveDoc, api.conversationId, context);
      const round = live?.run?.inputs?.[0];
      const trigger = round !== undefined ? deps.triggerOf?.(round) : undefined;
      if (!trigger || String(trigger.userId) !== deps.master) {
        throw new Error(deps.prompts.messages["fs_locked"] ?? "fs_locked");
      }
      console.log("[fish] restart scheduled by master, respawning in 3s");
      // 有意重启标记：启动时据此把卡在 sending 的消息翻回 queued 补发（真崩溃仍不重发）
      try {
        mkdirSync(join(root, "var"), { recursive: true });
        writeFileSync(join(root, "var", "restart.marker"), String(Date.now()));
        const text = (args.message ?? "").trim();
        if (!text) throw new Error("message 必填：总得有句遗言");
        writeFileSync(
          join(root, "var", "restart.pending.json"),
          JSON.stringify({ conversationId: String(api.conversationId), text }),
        );
      } catch {}
      const child = spawn("/bin/sh", ["-c", "sleep 3 && npm run up >> var/fish-console.log 2>&1"], {
        cwd: root,
        detached: true,
        stdio: "ignore",
      });
      child.unref();
      // 给 say 一点时间把「这就重启」说出去再死
      setTimeout(() => doExit(0), 1500).unref?.();
      return { output: [{ type: "text", text: "ok: restarting" }] };
    },
  });
}
