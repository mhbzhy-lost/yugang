/**
 * 门外的闸：决定这条消息要不要进 agent loop（next-only，2026-11 起 legacy 判定已下线）。
 *
 * 判定：私聊只认主人；群白名单（GROUPS）对谁都生效；任何人 @（含裸 @）必答，零模型
 * 调用；回复合集直接放行（合集专用例外，decisions 2026-11-04 §5.9——回复本身就是
 * 明确指令，不需要 @；普通回复仍只是引用动作，不必答）；自带合集但没 @ 零成本拒掉
 * （不展开、不进模型，合集 id 缓存照记在 onebot 解析层）；其余非 @ 群消息统一交给
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
}

export interface GateInput {
  msg: IncomingMessage;
}

export type GateDecision =
  | { enter: true; reason: "private" | "mentioned" | "forward_reply" | "free_pass" }
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

      // 回复合集直接放行（合集专用例外，不需要 @）；普通回复仍不改变闸语义。
      if (msg.repliedForward) return { enter: true, reason: "forward_reply" };

      // 自带合集但没有 @ 时零成本丢弃（open 态也不进），同时保留 onebot 层的最近合集缓存。
      if ((msg.forwardIds?.length ?? 0) > 0) return { enter: false, reason: "next_pending" };

      // 开窗两态（src/engage-next.ts 状态机的相位）：open——非 @ 也放行 free_pass
      // （非必答：不触发正文兜底，open 态走 ambient 轮语义，零出口合法）；
      // closed / 未跟踪——非 @ 统一 skip:next_pending 不进模型。`/` 指令与 GIF 收图轮
      // 走闸前自己的通道；recent 流水与合集 id 缓存（onebot 解析层，闸前照记）等旁路
      // 记账不受影响。普通回复不必答：回复鱼的内容只是引用动作，决定回复的是 @。
      if (options.isOpen?.(msg.chatKey) === true) return { enter: true, reason: "free_pass" };
      return { enter: false, reason: "next_pending" };
    },
  };
}
