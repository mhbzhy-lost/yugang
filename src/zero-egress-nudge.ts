/**
 * 必答轮（@ / 私聊）零出口自动提醒补跑门（2026-11-25）。
 *
 * 模型普通正文不出境（硬约束）；但历史里堆积大量沉默轮纯文本时，模型偶尔会在
 * `@` 或私聊的必答轮（roundKind === "answer"）直接吐裸文本而忘了调 say_*。
 * 宿主绝不把裸文本直发出去，而是纯追加一条宿主提醒（prompt/messages.md 的
 * zero_egress_nudge）补跑最多 1 次，既守住正文不出境边界，也不击穿前缀缓存。
 *
 * 例外：已触发机械直发工具（draw / qwen_draw / draw_remote / wan_gif / restart）的轮
 * 由宿主直接经 outbox 交付成品或重启，不要求再调 say_*，不触发补跑。
 */
import type { RoundKind } from "./tools/types.ts";

/** 机械直发工具家族（对应 workingSent 里的 family 名称）。 */
export const DIRECT_EGRESS_TOOL_FAMILIES: ReadonlySet<string> = new Set([
  "draw",
  "qwen_draw",
  "draw_remote",
  "wan_gif",
  "restart",
]);

export interface ZeroEgressNudgeInput {
  roundKind: RoundKind;
  status: string;
  sayCount: number;
  workingTools?: ReadonlySet<string>;
  alreadyNudged: boolean;
}

/** 判定本轮结束后是否应向模型追加一次零出口补跑提醒。 */
export function shouldNudgeZeroEgress(input: ZeroEgressNudgeInput): boolean {
  if (input.alreadyNudged) return false;
  if (input.roundKind !== "answer") return false;
  if (input.status !== "done") return false;
  if (input.sayCount > 0) return false;
  if (input.workingTools) {
    for (const tool of input.workingTools) {
      if (DIRECT_EGRESS_TOOL_FAMILIES.has(tool)) return false;
    }
  }
  return true;
}
