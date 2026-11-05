/**
 * 门外的闸：决定这条消息要不要进 agent loop（next-only，2026-11 起 legacy 判定已下线）。
 *
 * 判定：私聊只认主人；群白名单（GROUPS）对谁都生效；任何人 @（含裸 @）必答，零模型
 * 调用；合集判定一律回到 @ 上——自带合集或**引用合集**但没 @ 都零成本拒掉（不展开、
 * 不进模型；自带合集仍照记 id 缓存，引用合集的展开见 onebot 的 @ 前置条件）；其余
 * 非 @ 群消息统一交给
 * 开窗状态机（src/engage-next.ts）——open 窗 enter:free_pass（非必答：不触发正文兜底，
 * 零出口合法），closed / 未跟踪 skip:next_pending 不进模型。
 * 私聊、`/` 指令、GIF 收图轮在闸前各有自己的通道不受影响；recent 流水、chatlog、
 * 昵称映射、`#recentForward` 合集 id 缓存等旁路记账也都在闸外照常。
 */
import type { IncomingMessage } from "./onebot.ts";

/** 闸与渲染共用的文案表 = PromptSet.messages；模型可见的字全部从这里来。 */
export type MessageTable = Record<string, string>;

export interface GateOptions {
  /** 主人 QQ；私聊只认他。 */
  master: string;
  /** 只在白名单群里说话；空数组 = 所有群。 */
  groups: readonly string[];
  /** 该群是否处于 open 窗（src/engage-next.ts 状态机的相位）；缺省 / 未跟踪 = closed。 */
  isOpen?: (chatKey: string) => boolean;
  /** 自由活动群是否处于「非 @ 一律不接」的时段（宵禁）：true 时 free_pass 改判 skip:curfew。
   *  只影响自由群的非 @ 消息；@ 必答、私聊、指令、收图轮都不受它影响。 */
  freeCurfew?: (chatKey: string) => boolean;
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

      // 合集不给第二个例外：引用合集和自带合集一样，没 @ 就零成本丢弃（open 态也不进）。
      // 回复只是引用动作，决定展开的是 @（主人定案 2026-11-04：看合集得 @）。
      if (msg.repliedForward === true) return { enter: false, reason: "next_pending" };
      if ((msg.forwardIds?.length ?? 0) > 0) return { enter: false, reason: "next_pending" };

      // 开窗两态（src/qq/engage-next.ts 状态机的相位）：open——非 @ 也放行 free_pass
      // （非必答：不触发正文兜底，open 态走 ambient 轮语义，零出口合法）；
      // closed / 未跟踪——非 @ 统一 skip:next_pending 不进模型。`/` 指令与 GIF 收图轮
      // 走闸前自己的通道；recent 流水与合集 id 缓存（onebot 解析层，闸前照记）等旁路
      // 记账不受影响。普通回复不必答：回复鱼的内容只是引用动作，决定回复的是 @。
      if (options.isOpen?.(msg.chatKey) === true) {
        // 自由活动群的宵禁（2026-11-05 主人定案）：这段时间非 @ 消息不接——
        // 门后还有 0.1 的自主门，不挡的话夜里照样会自己起来聊。@ 已在上方必答。
        if (options.freeCurfew?.(msg.chatKey) === true) return { enter: false, reason: "curfew" };
        return { enter: true, reason: "free_pass" };
      }
      return { enter: false, reason: "next_pending" };
    },
  };
}
