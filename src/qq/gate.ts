/**
 * 门外的闸：决定这条消息要不要进 agent loop。
 *
 * 当前策略（2026-10 二次改版）——@ 必答 + 限流：
 *   私聊只认主人；群里任何人 @ → 必答；回复合集 → 必答；
 *   特别关注者 → 先过限流门：安静够久就直接进；没到间隔才掷随机（watchAmbientChance）。
 *   其余消息（含主人的非 @）→ 同一群两条被处理消息之间至少隔 ambientMinIntervalSeconds。
 *
 * 为什么从随机门换成限流：随机门对「沉寂很久突然有人说话」这种场景不友好——
 * 明明半天没人吱声，鱼也可能因为没抽中而一声不吭。限流模式下安静久了的第一条必定进，
 * 之后的才按时间拦，行为更像「有人在听，只是不插话」。
 *
 * 曾经有第二道「便宜模型打分」闸，2026-10 被主人砍掉：它用的是主模型，
 * 主模型一挂，主动接话就整晚全灭（gate_failed 静默丢弃），而且完全不可复盘。
 * 现在只留随机，是否开口的最终决定权交回门内的鱼自己（它也可以不调 say）。
 *
 * 旧的作息/配额/冷却/抽样不再参与判定，字段仅兼容保留。
 */
import type { IncomingMention, IncomingMessage } from "./onebot.ts";
import { renderTemplate } from "../prompts.ts";

/** renderForModel 的文案表 = PromptSet.messages；模型可见的字全部从这里来。 */
export type MessageTable = Record<string, string>;

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
  /** 非 @、非特别关注：同一群两条被处理消息之间的最短间隔（毫秒）。 */
  ambientMinIntervalMs?: number;
  /** 主人特别关注的人发言时的概率（比普通闲聊高得多，但不等于必答）。 */
  watchedChance?: number;
  /** 每轮现取（热更新用）；给了就盖过上面的静态值。 */
  chances?: () => { minIntervalMs: number; watched: number };
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
  | { enter: true; reason: "private" | "mentioned" | "replied_forward" | "watched_rate_pass" | "watched" | "rate_pass" }
  | { enter: false; reason: string };

export interface Gate {
  decide(input: GateInput): Promise<GateDecision>;
}

export function createGate(options: GateOptions): Gate {
  const random = options.random ?? Math.random;
  const now = options.now ?? Date.now;
  // 每个群最后一次「被处理」的时刻：入闸的 @ / 回复 / 限流放行都会刷新它
  const lastHandled = new Map<string, number>();
  const markHandled = (chatKey: string, at: number) => lastHandled.set(chatKey, at);
  return {
    async decide({ msg, watched }) {
      const at = now();
      // 私聊：只认主人
      if (msg.chatKey.startsWith("qq:private:")) {
        if (String(msg.userId) === options.master) {
          markHandled(msg.chatKey, at);
          return { enter: true, reason: "private" };
        }
        return { enter: false, reason: "stranger_private" };
      }

      // 群白名单对谁都生效
      if (options.groups.length > 0 && !options.groups.includes(String(msg.groupId))) {
        return { enter: false, reason: "group_not_allowed" };
      }

      // 任何人 @（含裸 @）必答，零模型调用
      if (msg.mentionsBot) {
        markHandled(msg.chatKey, at);
        return { enter: true, reason: "mentioned" };
      }

      // 回复某条合并转发 = 明确指令（回复本身就是指向），不需要 @
      if (msg.repliedForward) {
        markHandled(msg.chatKey, at);
        return { enter: true, reason: "replied_forward" };
      }

      // 无 @ 的合并转发合集：零成本丢弃（展开也不发生）。
      // 要让鱼看合集：回复合集并 @，或发合集时直接 @。
      if ((msg.forwardIds?.length ?? 0) > 0) return { enter: false, reason: "forward_ignored" };

      const live = options.chances?.();

      const minInterval = live?.minIntervalMs ?? options.ambientMinIntervalMs ?? 30_000;
      const last = lastHandled.get(msg.chatKey) ?? 0;
      const cooledDown = at - last >= minInterval;

      // 特别关注：先掷随机门，中了立刻回（不排队等冷却）；
      // 没中再看 60s 门——安静够久也回。两条命中任一即放行，
      // 尽量别出现「关注的人说话没反应，随后别人说话却回了」。
      if (watched === true) {
        const chance = live?.watched ?? options.watchedChance ?? 0.5;
        if (random() <= chance) {
          markHandled(msg.chatKey, at);
          return { enter: true, reason: "watched" };
        }
        if (!cooledDown) return { enter: false, reason: "watched_sampled_out" };
        markHandled(msg.chatKey, at);
        return { enter: true, reason: "watched_rate_pass" };
      }

      // 其余消息：纯限流。安静越久越容易进，刚处理过就闭嘴。
      if (!cooledDown) return { enter: false, reason: "rate_limited" };
      markHandled(msg.chatKey, at);
      return { enter: true, reason: "rate_pass" };
    },
  };
}

/**
 * 这条消息 @ 了谁：结构化 mentions 是权威值；旧 fixture / 外部构造只有兼容字段时
 * 按 mentionsBot + atOthers 退回，行为与改版前一致。
 */
function mentionTargets(msg: IncomingMessage): IncomingMention[] {
  if (msg.mentions && msg.mentions.length > 0) return msg.mentions;
  const list: IncomingMention[] = [];
  if (msg.mentionsBot) list.push({ qq: "self", name: "", kind: "bot" });
  for (const [index, qq] of (msg.atOthers ?? []).entries()) {
    const name = msg.atOtherNames?.[index] ?? qq;
    list.push({ qq, name, kind: qq === "all" ? "all" : "other" });
  }
  return list;
}

/** 「名字(QQ)」；名字就是 QQ 号时不再重复写一遍。 */
function mentionLabel(mention: IncomingMention): string {
  if (!mention.name || mention.name === mention.qq) return mention.qq;
  return `${mention.name}(${mention.qq})`;
}

/**
 * 把这条消息的 @ 目标逐个列出成一句标注。
 * 只 @ 了别人（或 @全体）时明确写「不是在叫你」——否则模型会把别人的对话当成叫自己。
 */
function renderMentions(msg: IncomingMessage, messages: MessageTable): string {
  // 私聊没有「@谁」这回事：入站把 mentionsBot 恒置 true 只是内部标记（私聊就是叫你），
  // 渲染成「@了你」会让模型对着主人回一句“你@我干什么”。
  if (!msg.chatKey.startsWith("qq:group:")) return "";
  const targets = mentionTargets(msg);
  const parts: string[] = [];
  for (const target of targets) {
    if (target.kind === "bot") parts.push(messages["mention_bot"] ?? "");
    else if (target.kind === "all") parts.push(messages["mention_all"] ?? "");
    else parts.push(renderTemplate(messages["mention_other"] ?? "", { who: mentionLabel(target) }));
  }
  const listed = parts.filter((part) => part.length > 0).join(" ");
  if (!listed) return "";
  const callsBot = targets.some((target) => target.kind === "bot");
  const callsOther = targets.some((target) => target.kind === "other");
  // 只 @全体成员时它就是「叫所有人」，再用“不是叫你”去否定就自相矛盾了；
  // 只有真的只 @了具体别人（且没叫鱼）才需要澄清。
  if (callsBot || !callsOther) return listed;
  return `${listed}${messages["mention_not_you"] ?? ""}`;
}

/** 进闸消息渲染成模型的 user 文本：群/人/是否@/是否主人，文案全部来自 prompt/messages.md。 */
export function renderForModel(msg: IncomingMessage, master: string, messages: MessageTable): string {
  const where = msg.groupId ? `群${msg.groupId}` : `私聊`;
  const reply = msg.messageId ? ` 回复msg:${msg.messageId}` : "";
  const tags: string[] = [];
  const mentions = renderMentions(msg, messages);
  if (mentions) tags.push(mentions);
  if (String(msg.userId) === master) tags.push(messages["speaker_master"] ?? "");
  const visible = tags.filter((tag) => tag.length > 0);
  return `[${where} | ${msg.nickname}(${msg.userId})${reply}${visible.length > 0 ? ` ${visible.join(" ")}` : ""}] ${msg.text}`;
}
