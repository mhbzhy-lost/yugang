/**
 * ammo_submit —— 逛轮弹药入库（外部计划 Task E4）。
 *
 * 两种允许入口，其余一律 tool 错误（fail closed）：
 *   1. worker 轮：轮上下文（LiveDoc 的 run.inputs[0] → triggerOf）带 kind="worker" 且携带
 *      workerRun（runKey/maxPicks/ttlHours，宿主起作业轮时定格）；
 *   2. 主人私聊手动逛轮：主人私聊的普通 answer 轮携带 manualAmmoRun（同形，每轮现读配置），
 *      放行前二次机械核对 deps.master + deps.chatKeyOf(api.conversationId) 确为
 *      qq:private:<master> 且轮类型 answer——仅凭 trigger 里的字段不够，当前会话本身
 *      必须就是主人私聊；无法判定（deps 缺失）同样拒绝。
 * 群聊、陌生私聊、无上下文的轮一律拒绝。
 * 宿主核验链：BV 形（isValidBvid）→ summary 清洗（sanitizeExternalText ≤60）
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
import { renderTemplate } from "../../prompt/index.ts";
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
      // 1) 轮类型闸：worker 轮（逛轮）携带 workerRun；主人私聊手动逛轮携带 manualAmmoRun；
      //    其余一律拒绝（fail closed）。手动入口还要过第二道机械身份闸（下方）。
      const live = (await api.snapshot(LiveDoc, api.conversationId, context)) as
        | { run?: { inputs?: unknown[] } }
        | undefined;
      const round = live?.run?.inputs?.[0];
      const trigger = round !== undefined ? deps.triggerOf?.(round) : undefined;
      const workerRun = trigger?.kind === "worker" ? trigger.workerRun : undefined;
      const manualRun = trigger?.kind === "answer" ? trigger.manualAmmoRun : undefined;
      let run: { runKey: string; maxPicks: number; ttlHours: number } | undefined = workerRun;
      if (run === undefined && manualRun !== undefined) {
        // 2) 手动入口的二次机械身份闸：当前会话本身必须就是主人私聊（chatKeyOf 与 deps.master
        //    同源核对）。仅凭 trigger 携带的字段不够——群聊/陌生私聊轮即使被异常钉上
        //    manualAmmoRun 也在这里拦死；deps.master / chatKeyOf 缺失时无法机械判定，同样拒绝。
        const chatKey = deps.chatKeyOf?.(String(api.conversationId));
        if (!deps.master || chatKey !== `qq:private:${deps.master}`) {
          throw new Error(messages["ammo_submit_not_worker"] ?? "ammo_submit_not_worker");
        }
        run = manualRun;
      }
      if (run === undefined) {
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
          { bvid, title, summary, topic, run: run.runKey, maxPicks: run.maxPicks, ttlHours: run.ttlHours },
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
