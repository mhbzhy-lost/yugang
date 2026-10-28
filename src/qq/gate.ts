/**
 * 门外的闸：决定这条消息要不要进 agent loop。
 *
 * 当前策略——只响应艾特：
 *   主人 → 必答；任何人 @（含陌生群友）→ 必答；其余群消息 → 一律沉默。
 * 判定顺序一行版：主人 → @ → drop。私聊只认主人，不受本策略影响。
 *
 * 旧版的作息/配额/冷却/抽样/打分（prompt/gate.md）已不参与判定，
 * 相关参数仅兼容保留；门内模型仍可以选择不调用 say，那才是沉默的终态。
 */
import type { Models } from "@earendil-works/pi-ai/models";
import type { PromptSet } from "../prompts.ts";
import type { IncomingMessage } from "./onebot.ts";

export interface GateOptions {
  prompts: PromptSet;
  models: Models;
  /** 已不参与判定，仅兼容保留（宿主启动时仍会传入）。 */
  model: { provider: string; modelId: string };
  /** 主人 QQ；私聊只认他，群里他不需要过闸。 */
  master: string;
  /** 只在白名单群里说话；空数组 = 所有群。白名单对谁都生效，主人和 @ 也不例外。 */
  groups: readonly string[];
  /** 【仅兼容保留，当前策略下无效】旧安静时段。 */
  quietHours?: readonly [number, number];
  /** 【仅兼容保留，当前策略下无效】旧每日主动配额。 */
  dailyQuota: number;
  /** 【仅兼容保留，当前策略下无效】旧开口冷却。 */
  cooldownMs: number;
  /** 【仅兼容保留，当前策略下无效】旧冷场抽样概率。 */
  ambientChance: number;
}

export interface GateInput {
  msg: IncomingMessage;
  /** 已不参与判定，仅兼容保留（宿主仍会传入）。 */
  recent: readonly { nickname: string; text: string }[];
  lastSpokeAt: number;
  spokenToday: number;
}

export type GateDecision =
  | { enter: true; reason: "private" | "mentioned" | "master" }
  | { enter: false; reason: string };

export interface Gate {
  decide(input: GateInput): Promise<GateDecision>;
}

export function createGate(options: GateOptions): Gate {
  return {
    async decide({ msg }) {
      // 私聊：只认主人
      if (msg.chatKey.startsWith("qq:private:")) {
        if (String(msg.userId) === options.master) return { enter: true, reason: "private" };
        return { enter: false, reason: "stranger_private" };
      }

      // 群白名单对谁都生效
      if (options.groups.length > 0 && !options.groups.includes(String(msg.groupId))) {
        return { enter: false, reason: "group_not_allowed" };
      }

      // 1. 主人最先：群里免检，带不带 @ 都必答
      if (String(msg.userId) === options.master) return { enter: true, reason: "master" };

      // 2. 任何人 @ 都硬通行：作息/配额/冷却/抽样/打分一律不拦
      if (msg.mentionsBot) return { enter: true, reason: "mentioned" };

      // 3. 其余一律沉默：不抽样、不打分、不花模型调用
      return { enter: false, reason: "not_mentioned" };
    },
  };
}

/** 群消息的结构化包装：身份与内容分开，避免群员把指令混进 system。 */
export function renderForModel(msg: IncomingMessage, master: string): string {
  const where = msg.groupId ? `群${msg.groupId}` : "私聊";
  const reply = msg.messageId ? ` 回复msg:${msg.messageId}` : "";
  const tags = [msg.mentionsBot ? "对你说话" : "", String(msg.userId) === master ? "你主人" : ""]
    .filter(Boolean)
    .join(" ");
  return `[${where} | ${msg.nickname}(${msg.userId})${reply}${tags ? ` ${tags}` : ""}] ${msg.text}`;
}
