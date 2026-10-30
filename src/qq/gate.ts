/**
 * 门外的闸：决定这条消息要不要进 agent loop。
 *
 * 当前策略——@ 必答 + 随机粗筛：
 *   私聊只认主人；群里任何人 @ → 必答；其余消息（含主人的）按 AMBIENT_CHANCE
 *   随机放行，绝大多数到这就结束、零成本，不花任何模型调用。
 *
 * 曾经有第二道「便宜模型打分」闸，2026-10 被主人砍掉：它用的是主模型，
 * 主模型一挂，主动接话就整晚全灭（gate_failed 静默丢弃），而且完全不可复盘。
 * 现在只留随机，是否开口的最终决定权交回门内的鱼自己（它也可以不调 say）。
 *
 * 旧的作息/配额/冷却/抽样不再参与判定，字段仅兼容保留。
 */
import type { IncomingMessage } from "./onebot.ts";

export interface GateOptions {
  /** 主人 QQ；私聊只认他。 */
  master: string;
  /** 只在白名单群里说话；空数组 = 所有群。 */
  groups: readonly string[];
  /** 【仅兼容保留，当前策略下无效】旧安静时段。 */
  quietHours?: readonly [number, number];
  /** 【仅兼容保留，当前策略下无效】旧每日主动配额。 */
  dailyQuota: number;
  /** 【仅兼容保留，当前策略下无效】旧开口冷却。 */
  cooldownMs: number;
  /** 非 @ 消息进入 loop 的概率（随机粗筛，零成本挡掉大多数）。 */
  ambientChance: number;
  /** 按群覆盖的随机门概率（群号 → 值）；未列出的群用 ambientChance。值为 0 = 该群只应答 @，不回闲聊。 */
  ambientChanceByGroup?: Record<string, number>;
  /** 主人特别关注的人发言时的概率（比普通闲聊高得多，但不等于必答）。 */
  watchedChance?: number;
  /** 每轮现取的概率（热更新用）；给了就盖过上面三个静态值。 */
  chances?: () => { ambient: number; byGroup: Record<string, number>; watched: number };
  now?: () => number;
  random?: () => number;
}

export interface GateInput {
  msg: IncomingMessage;
  /** 这条消息的发送者是否在主人给的特别关注名单里。 */
  watched?: boolean;
  /** 【仅兼容保留】最近的群聊流水。 */
  recent?: readonly { nickname: string; text: string }[];
  lastSpokeAt?: number;
  spokenToday?: number;
}

export type GateDecision =
  | { enter: true; reason: "private" | "mentioned" | "sampled" }
  | { enter: false; reason: string };

export interface Gate {
  decide(input: GateInput): Promise<GateDecision>;
}

export function createGate(options: GateOptions): Gate {
  const random = options.random ?? Math.random;
  return {
    async decide({ msg, watched }) {
      // 私聊：只认主人
      if (msg.chatKey.startsWith("qq:private:")) {
        if (String(msg.userId) === options.master) return { enter: true, reason: "private" };
        return { enter: false, reason: "stranger_private" };
      }

      // 群白名单对谁都生效
      if (options.groups.length > 0 && !options.groups.includes(String(msg.groupId))) {
        return { enter: false, reason: "group_not_allowed" };
      }

      // 任何人 @（含裸 @）必答，零模型调用
      if (msg.mentionsBot) return { enter: true, reason: "mentioned" };

      // 无 @ 的合并转发合集：零成本丢弃（展开也不发生）。
      // 要让鱼看合集：回复合集并 @，或发合集时直接 @。
      if ((msg.forwardIds?.length ?? 0) > 0) return { enter: false, reason: "forward_ignored" };

      // 随机粗筛：绝大多数非 @ 消息到这就结束；可按群覆盖（0 = 该群不回闲聊）。
      // 特别关注的人单独用更高的概率（watchedChance，缺省 0.5），照顾到但不等于必答。
      const live = options.chances?.();
      const base = live
        ? (live.byGroup[String(msg.groupId)] ?? live.ambient)
        : (options.ambientChanceByGroup?.[String(msg.groupId)] ?? options.ambientChance);
      const chance = watched === true ? (live?.watched ?? options.watchedChance ?? 0.5) : base;
      if (random() > chance) return { enter: false, reason: "sampled_out" };
      return { enter: true, reason: "sampled" };
    },
  };
}

/** 进闸消息渲染成模型的 user 文本：带群/人/是否@/是否主人的标注。 */
export function renderForModel(msg: IncomingMessage, master: string): string {
  const where = msg.groupId ? `群${msg.groupId}` : `私聊`;
  const reply = msg.messageId ? ` 回复msg:${msg.messageId}` : "";
  const tags: string[] = [];
  if (msg.mentionsBot) tags.push("对你说话");
  if ((msg.atOthers?.length ?? 0) > 0 && !msg.mentionsBot) {
    const who = (msg.atOthers ?? [])
      .map((qq, index) => {
        const name = msg.atOtherNames?.[index];
        return name && name !== qq && qq !== "all" ? `${name}(${qq})` : name || qq;
      })
      .join("、");
    tags.push(`在@${who}（不是在叫你）`);
  }
  if (String(msg.userId) === master) tags.push("你主人");
  return `[${where} | ${msg.nickname}(${msg.userId})${reply}${tags.length > 0 ? ` ${tags.join(" ")}` : ""}] ${msg.text}`;
}
