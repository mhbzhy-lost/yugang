/**
 * 门外的闸：决定这条消息要不要进 agent loop（自由活动模式唯一，2026-11-06 开窗两态退役）。
 *
 * 判定：私聊只认主人；群白名单（GROUPS）对谁都生效；任何人 @（含裸 @）必答，零模型
 * 调用；合集判定一律回到 @ 上——自带合集或**引用合集**但没 @ 都零成本拒掉（不展开、
 * 不进模型；自带合集仍照记 id 缓存，引用合集的展开见 onebot 的 @ 前置条件）；其余
 * 非 @ 群消息统一 enter:free_pass（进自由拍收集器，非必答：不触发正文兜底，零出口合法）。
 * 私聊、`/` 指令在闸前各有自己的通道不受影响；recent 流水、chatlog、昵称映射、
 * `#recentForward` 合集 id 缓存等旁路记账也都在闸外照常。
 */
import type { IncomingMessage } from "./onebot.ts";

/** 闸与渲染共用的文案表 = PromptSet.messages；模型可见的字全部从这里来。 */
export type MessageTable = Record<string, string>;

export interface GateOptions {
  /** 主人 QQ；私聊只认他。 */
  master: string;
  /** 只在白名单群里说话；空数组 = 所有群。 */
  groups: readonly string[];
}

export interface GateInput {
  msg: IncomingMessage;
}

export type GateDecision =
  | { enter: true; reason: "private" | "mentioned" | "free_pass" }
  | { enter: false; reason: "stranger_private" | "group_not_allowed" | "next_pending" | "curfew" };

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

      // 合集不给第二个例外：引用合集和自带合集一样，没 @ 就零成本丢弃。
      // 回复只是引用动作，决定展开的是 @（主人定案 2026-11-04：看合集得 @）。
      if (msg.repliedForward === true) return { enter: false, reason: "next_pending" };
      if ((msg.forwardIds?.length ?? 0) > 0) return { enter: false, reason: "next_pending" };

      // 自由活动模式（2026-11-06 合并：所有 GROUPS 群）：非 @ 一律放行 free_pass
      // （非必答：走 ambient 轮语义，零出口合法），进收集器每 engage.freeSeconds 一拍合并。
      // 宵禁在 freeBeat 层拦（不提交拍），不在 gate 拦——夜里消息照常进收集器与 recent，
      // @ 必答照常，白天 @ 时夜里的话作为背景可见。
      return { enter: true, reason: "free_pass" };
    },
  };
}
