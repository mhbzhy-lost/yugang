/**
 * say —— 唯一的出口。
 *
 * 这是整个项目的形状：模型能说的每一句话都要经过一次显式的 say() 调用，
 * 调用参数被硬校验；被拒绝时以 tool 错误返回，模型可以在同一轮里重说。
 * 模型的正文（assistant text）、思考、tool 调用文本，永远不进入 QQ。
 */
import { Type } from "@earendil-works/pi-ai";
import { defineEntry, defineTool, type ConversationId } from "@earendil-works/pi-durable";
import { validateOutbound, type EgressLimits } from "./policy.ts";
import { ledgerOf, recordSent } from "./ledger.ts";

export interface OutboundPayload {
  text: string;
  media?: string;
  at: number;
  /** 幂等键：重放时用同一个，发送侧据此去重。 */
  key: string;
}

export const OutboundEntry = defineEntry<OutboundPayload>("fish.outbound");

export interface SayDeps {
  limits: EgressLimits;
  /** 宿主侧真正把消息发出去。第一个参数是会话（= 一个群），据此路由到 QQ。 */
  emit: (conversationId: ConversationId, payload: OutboundPayload) => void | Promise<void>;
  now?: () => number;
}

export function createSayTool(deps: SayDeps) {
  const now = deps.now ?? Date.now;

  return defineTool({
    name: "say",
    description: [
      "往当前 QQ 群说一句话。除了这个工具之外，你产生的任何文字都不会发到群里。",
      "text 是群里那句话说出口的样子本身：口语、短、不超过 120 字、最多 2 个换行。",
      "不要写 markdown、标题、列表、代码块，不要解释你做了什么、不要复述思考过程。",
      "要发图时把图片绝对路径放进 media（必须在允许的媒体目录内）。",
      "不想说话就不要调用这个工具——沉默是合法的。",
    ].join(" "),
    // 只允许模型调用：脚本 / 嵌套调用不能绕过校验
    callers: ["model"],
    parameters: Type.Object({
      text: Type.String({ description: "要对群里说的话，直接说，不要包裹任何格式" }),
      media: Type.Optional(Type.String({ description: "可选：一起发出的图片绝对路径" })),
    }),
    execute: async (args, api, context) => {
      const ts = now();
      const ledger = ledgerOf(api.conversationId);

      const rejection = validateOutbound(args, {
        limits: deps.limits,
        now: ts,
        recent: ledger.recent,
        sentThisRun: ledger.sentThisRun,
        secrets: ledger.secrets,
      });

      // 硬拒绝：抛出去 → 模型收到 tool 错误结果，可在同一轮里改口重说
      if (rejection) throw new Error(`未发送：${rejection}`);

      const payload: OutboundPayload = {
        text: args.text.trim(),
        ...(args.media === undefined ? {} : { media: args.media }),
        at: ts,
        key: `${api.conversationId}:${api.callId}`,
      };

      // 先落盘再发送：崩在中间时，重启后能从 fish.outbound 条目里找回这句话
      await api.commit(
        (tx) => tx.appendEntry(OutboundEntry, api.conversationId, { data: payload }),
        context,
      );

      recordSent(api.conversationId, payload.text, ts);
      await deps.emit(api.conversationId, payload);

      return { output: [{ type: "text", text: "已发到群里" }] };
    },
  });
}
