/**
 * ammo_submit —— 逛轮弹药入库（外部计划 Task E4）。
 *
 * 仅 worker 轮可用：轮上下文（LiveDoc 的 run.inputs[0] → triggerOf）带 kind="worker"
 * 且携带 workerRun（runKey/maxPicks/ttlHours，宿主起作业轮时定格）才放行；其余轮一律
 * tool 错误。宿主核验链：BV 形（isValidBvid）→ summary 清洗（sanitizeExternalText ≤60）
 * → topic 枚举（AMMO_TOPICS，与 TOOL.md 的 Schema 一一对应）→ bili-client view 端点
 * 补全卡片（标题清洗后入库，URL/时长/播放等只在补全校验里用）→ applyAmmoSubmit 原子
 * 入库（判重 + 单轮上限在同一事务读改）。写入 fish.external_ammo（session doc，人格
 * 中立，决策 2），state=available，TTL 由 ttlAt 表达；状态机归 E5。
 *
 * 说明文字与参数 Schema 唯一来自 TOOL.md manifest；client/now 可注入供内联验证。
 */
import { LiveDoc, defineTool, type ToolRegistration } from "@earendil-works/pi-durable";
import { getBiliClient, isValidBvid, type BiliClient, type BiliVideoCard } from "../../external/bili-client.ts";
import { sanitizeExternalText } from "../../external/sanitize.ts";
import { AMMO_TOPICS, ExternalAmmoDoc, applyAmmoSubmit, isAmmoTopic } from "../../external/ammo-store.ts";
import { renderTemplate } from "../../prompts.ts";
import { manifestParameters, toolFullDescription } from "../manifest.ts";
import type { ToolManifest, ToolPackageDeps } from "../types.ts";

/** args 静态类型：与 TOOL.md 的参数 Schema 一一对应；运行时 Schema 只有 manifest 这一份。 */
interface AmmoSubmitArgs {
  bvid: string;
  summary: string;
  topic: string;
}

/** summary 与标题的清洗上限（字）：与 TOOL.md Schema 的 maxLength 一致。 */
const SUMMARY_MAX = 60;

/** 注入口（内联验证用）；缺省走全仓共享的 bili-client 单例。 */
export interface AmmoSubmitToolOptions {
  client?: BiliClient;
}

export function createAmmoSubmitTool(
  manifest: ToolManifest,
  deps: ToolPackageDeps,
  options: AmmoSubmitToolOptions = {},
): ToolRegistration {
  const messages = deps.prompts.messages;

  return defineTool({
    name: manifest.name,
    description: toolFullDescription(manifest),
    callers: ["model"],
    parameters: manifestParameters<AmmoSubmitArgs>(manifest),
    execute: async (args, api, context) => {
      // 1) 轮类型闸：只有 worker 轮（逛轮）携带 workerRun，其余一律拒绝（fail closed）
      const live = (await api.snapshot(LiveDoc, api.conversationId, context)) as
        | { run?: { inputs?: unknown[] } }
        | undefined;
      const round = live?.run?.inputs?.[0];
      const trigger = round !== undefined ? deps.triggerOf?.(round) : undefined;
      const workerRun = trigger?.kind === "worker" ? trigger.workerRun : undefined;
      if (workerRun === undefined) {
        throw new Error(messages["ammo_submit_not_worker"] ?? "ammo_submit_not_worker");
      }

      // 2) 参数机械校验（BV 形 / summary 清洗 / topic 枚举）
      const bvid = String(args.bvid ?? "").trim();
      if (!isValidBvid(bvid)) {
        throw new Error(messages["ammo_submit_bad_bvid"] ?? "ammo_submit_bad_bvid");
      }
      const summary = sanitizeExternalText(String(args.summary ?? ""), { maxLen: SUMMARY_MAX });
      if (summary.length === 0) {
        throw new Error(messages["ammo_submit_bad_summary"] ?? "ammo_submit_bad_summary");
      }
      const topic = String(args.topic ?? "").trim();
      if (!isAmmoTopic(topic)) {
        throw new Error(renderTemplate(messages["ammo_submit_bad_topic"] ?? "", { topics: AMMO_TOPICS.join("、") }));
      }

      // 3) 宿主补全：经 bili-client view 端点核验卡片（标题/UP/时长/播放），失败不入库
      let card: BiliVideoCard;
      try {
        card = await (options.client ?? getBiliClient()).view(bvid);
      } catch (error) {
        const reason = error instanceof Error ? error.message : String(error);
        throw new Error(renderTemplate(messages["ammo_submit_view_failed"] ?? "", { reason }));
      }
      const title = sanitizeExternalText(card.title, { maxLen: SUMMARY_MAX });
      if (title.length === 0) {
        throw new Error(renderTemplate(messages["ammo_submit_view_failed"] ?? "", { reason: "empty title" }));
      }

      // 4) 原子入库：判重（任何状态）与单轮上限在同一事务读改
      const nowMs = deps.now?.() ?? Date.now();
      const outcome = await api.commit(async (tx) => {
        const doc = await tx.doc(ExternalAmmoDoc);
        return applyAmmoSubmit(
          doc,
          { bvid, title, summary, topic, run: workerRun.runKey, maxPicks: workerRun.maxPicks, ttlHours: workerRun.ttlHours },
          nowMs,
        );
      }, context);
      if (outcome.status === "dup") {
        throw new Error(renderTemplate(messages["ammo_submit_dup"] ?? "", { bvid }));
      }
      if (outcome.status === "full") {
        throw new Error(renderTemplate(messages["ammo_submit_full"] ?? "", { max: String(outcome.maxPicks) }));
      }
      return { output: [{ type: "text", text: renderTemplate(messages["ammo_submit_ok"] ?? "", { bvid, title }) }] };
    },
  });
}
