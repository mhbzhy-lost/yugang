/**
 * say —— 唯一的出口。
 *
 * 模型能说的每一句话都要经过一次显式的 say() 调用，参数被硬校验；
 * 被拒绝时以 tool 错误返回（文案来自 prompt/errors.md），模型在同一轮里改口重说。
 * 模型的正文、思考、tool 调用文本，永远不进入 QQ。
 */
import { Type } from "@earendil-works/pi-ai";
import { defineEntry, defineTool, type ConversationId } from "@earendil-works/pi-durable";
import { validateOutbound, type EgressLimits } from "./policy.ts";
import { ledgerOf, recordSent } from "./ledger.ts";
import { renderTemplate, type PromptSet } from "../prompts.ts";

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
  prompts: PromptSet;
  emit: (conversationId: ConversationId, payload: OutboundPayload) => void | Promise<void>;
  now?: () => number;
}

export function createSayTool(deps: SayDeps) {
  const now = deps.now ?? Date.now;

  return defineTool({
    name: "say",
    description: deps.prompts.tools.say.description,
    callers: ["model"], // 脚本 / 嵌套调用不能绕过校验
    parameters: Type.Object({
      text: Type.String({ description: deps.prompts.tools.say.params["text"] ?? "" }),
      media: Type.Optional(Type.String({ description: deps.prompts.tools.say.params["media"] ?? "" })),
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

      if (rejection) {
        const template = deps.prompts.messages[rejection.code];
        if (!template) throw new Error(`prompt/messages.md 缺少文案：${rejection.code}`);
        throw new Error(renderTemplate(template, rejection.vars ?? {}));
      }

      const payload: OutboundPayload = {
        text: args.text.trim(),
        ...(args.media === undefined ? {} : { media: args.media }),
        at: ts,
        key: `${api.conversationId}:${api.callId}`,
      };

      // 先落盘再发送：崩在中间时，重启后能从 fish.outbound 条目里找回这句话
      await api.commit((tx) => tx.appendEntry(OutboundEntry, api.conversationId, { data: payload }), context);

      recordSent(api.conversationId, payload.text, ts);
      await deps.emit(api.conversationId, payload);

      return { output: [{ type: "text", text: deps.prompts.messages["say_sent"] }] };
    },
  });
}
