/**
 * 门外的闸：决定这条消息要不要进 agent loop（next-only，2026-11 起 legacy 判定已下线）。
 *
 * 判定：私聊只认主人；群白名单（GROUPS）对谁都生效；任何人 @（含裸 @）必答，零模型
 * 调用；其余非 @ 群消息统一交给开窗状态机（src/engage-next.ts）——open 窗
 * enter:free_pass（非必答：不触发正文兜底，零出口合法），closed / 未跟踪
 * skip:next_pending 不进模型。回复合集不再参与判定：回复鱼的内容只是引用动作，
 * 决定回复的是 @；合集的展开与 id 缓存在 onebot 解析层（闸前），不受本闸影响。
 * 私聊、`/` 指令、GIF 收图轮在闸前各有自己的通道不受影响；recent 流水、chatlog、
 * 昵称映射、`#recentForward` 合集 id 缓存等旁路记账也都在闸外照常。
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
  /** 该群是否处于 open 窗（src/engage-next.ts 状态机的相位）；缺省 / 未跟踪 = closed。 */
  isOpen?: (chatKey: string) => boolean;
}

export interface GateInput {
  msg: IncomingMessage;
}

export type GateDecision =
  | { enter: true; reason: "private" | "mentioned" | "free_pass" }
  | { enter: false; reason: "stranger_private" | "group_not_allowed" | "next_pending" };

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

      // 任何人 @（含裸 @）必答，零模型调用
      if (msg.mentionsBot) return { enter: true, reason: "mentioned" };

      // 开窗两态（src/engage-next.ts 状态机的相位）：open——非 @ 也放行 free_pass
      // （非必答：不触发正文兜底，open 态走 ambient 轮语义，零出口合法）；
      // closed / 未跟踪——非 @ 统一 skip:next_pending 不进模型。`/` 指令与 GIF 收图轮
      // 走闸前自己的通道；recent 流水与合集 id 缓存（onebot 解析层，闸前照记）等旁路
      // 记账不受影响。回复合集不再必答：回复鱼的内容只是引用动作，决定回复的是 @。
      if (options.isOpen?.(msg.chatKey) === true) return { enter: true, reason: "free_pass" };
      return { enter: false, reason: "next_pending" };
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
 * 只 @ 了别人（或 @全体）时补指向澄清——告诉模型别人的对话不是在叫它，接不接话由它自己判断。
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
