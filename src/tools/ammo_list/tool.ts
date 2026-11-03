/**
 * ammo_list —— 弹药库只读查询（外部计划 E5 的补充入口）。
 *
 * 背景：外部库存行只随开窗 injection / nudge 轮注入，门没开的窗模型完全看不到库存，
 * 会被问「库存有什么」时只能瞎猜（2026-11-03 线上实例）。这个工具给模型一个主动查库
 * 的口子：available 条目先入先出 + 当前分享门状态，让「没看到注入」不再等于「库存空」。
 *
 * 边界：只读（api.snapshot），不 claim 不写库；分享动作仍只在 say_words 的 ammoId 链，
 * 门/宵禁/每窗一条的机械校验一概不在这里放宽——本工具只是把门的状态如实报给模型。
 * 标题等文本字段入库时已过 sanitizeExternalText，出工具前再截一次边。
 */
import { defineTool, type ToolRegistration } from "@earendil-works/pi-durable";
import { ExternalAmmoDoc } from "../../external/ammo-store.ts";
import { renderTemplate } from "../../prompts.ts";
import { manifestParameters, toolFullDescription } from "../manifest.ts";
import { ammoCurfewAt, ammoShareGateOf } from "../say-shared.ts";
import type { ToolManifest, ToolPackageDeps } from "../types.ts";

/** args 静态类型：与 TOOL.md 的参数 Schema 一一对应；运行时 Schema 只有 manifest 这一份。 */
interface AmmoListArgs {
  topic?: string;
}

/** 单条标题截断（字）：回执要紧凑。 */
const TITLE_CHARS = 60;

/** 最多列出的条数：库内有界（单轮入库上限 × TTL 窗口），截个顶防意外。 */
const LIST_CAP = 20;

/**
 * ammo_list 工具：模型侧只见 TOOL.md；执行侧是只读快照 + 门状态汇报。
 * loader 对非 eager 工具统一加 deferred，factory 本体不写。
 */
export function createAmmoListTool(manifest: ToolManifest, deps: ToolPackageDeps): ToolRegistration {
  const messages = deps.prompts.messages;
  const now = deps.now ?? Date.now;

  return defineTool({
    name: manifest.name,
    description: toolFullDescription(manifest),
    callers: ["model"],
    parameters: manifestParameters<AmmoListArgs>(manifest),
    execute: async (args, api, context) => {
      const nowMs = now();
      const doc = await api.snapshot(ExternalAmmoDoc, context);
      const topic = typeof args.topic === "string" && args.topic.length > 0 ? args.topic : undefined;
      const available = (doc?.items ?? [])
        .filter((item) => item.state === "available" && item.ttlAt > nowMs)
        .filter((item) => topic === undefined || item.topic === topic)
        .sort((a, b) => a.pickedAt - b.pickedAt)
        .slice(0, LIST_CAP);

      // 门状态如实汇报（不放宽任何校验）：宵禁优先，其次本会话 chatKey 的开窗门
      const chatKey = deps.chatKeyOf?.(api.conversationId);
      const gate = chatKey === undefined ? undefined : ammoShareGateOf(chatKey);
      const gateLine = ammoCurfewAt(nowMs)
        ? messages["ammo_list_curfew"] ?? ""
        : gate?.open
          ? messages["ammo_list_gate_open"] ?? ""
          : messages["ammo_list_gate_closed"] ?? "";

      if (available.length === 0) {
        return { output: [{ type: "text", text: [messages["ammo_list_empty"] ?? "", gateLine].filter((line) => line.length > 0).join("\n") }] };
      }
      const text = [
        messages["ammo_list_header"] ?? "",
        ...available.map((item) =>
          renderTemplate(messages["ammo_list_line"] ?? "", {
            id: item.id,
            title: item.title.slice(0, TITLE_CHARS),
            topic: item.topic,
            hours: String(Math.max(0, Math.ceil((item.ttlAt - nowMs) / 3_600_000))),
          })
        ),
        gateLine,
      ]
        .filter((line) => line.length > 0)
        .join("\n");
      return { output: [{ type: "text", text }] };
    },
  });
}
