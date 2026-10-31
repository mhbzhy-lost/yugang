/**
 * restart —— 重启自己让代码、配置、人格书的改动生效（仅主人）。
 *
 * 主人身份闸与 fs 工具同源（机械判 triggerOf 的 userId），集中走 ../fs-shared.ts。
 * 机制：3 秒后由脱离进程组的子进程重新拉起 npm run up，当前进程随后退出。
 * 协议端（QQ）不受影响。重启前落 marker（重启意图）与 pending 遗言（启动后自动补发）。
 *
 * 说明文字与参数 Schema 唯一来自 TOOL.md manifest（factory 只消费它，不再有第二份运行时定义）。
 */
import { spawn } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { defineTool, type ToolRegistration } from "@earendil-works/pi-durable";
import { manifestParameters, toolFullDescription } from "../manifest.ts";
import type { ToolManifest, ToolPackageDeps } from "../types.ts";
import { assertTriggeredByMaster } from "../fs-shared.ts";

/** args 静态类型：与 TOOL.md 的参数 Schema 一一对应；运行时 Schema 只有 manifest 这一份。 */
interface RestartArgs {
  message: string;
}

/** 主人闸是硬前提：无主人配置时 factory 返回 undefined，由注册方跳过（不进工具面）。 */
export function createRestartTool(manifest: ToolManifest, deps: ToolPackageDeps): ToolRegistration | undefined {
  if (!deps.master) return undefined;
  const root = resolve(process.cwd());
  const doExit = (code: number): never => process.exit(code);

  return defineTool({
    name: manifest.name,
    description: toolFullDescription(manifest),
    callers: ["model"],
    parameters: manifestParameters<RestartArgs>(manifest),
    execute: async (args, api, context) => {
      // 身份闸：机械判定，看本轮触发消息的 userId 是不是主人（与 fs / model 同源）
      await assertTriggeredByMaster(deps, api as never, context, deps.prompts.messages["fs_locked"] ?? "fs_locked");
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
