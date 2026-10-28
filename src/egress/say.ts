/**
 * say —— 唯一的出口。
 *
 * 出口是「一条消息序列」：模型一次可以连说几句，每句单独过检，
 * 宿主按顺序发出、中间加抖动延迟。被拒绝时以 tool 错误返回（文案来自 prompt/messages.md），
 * 模型在同一轮里改口重说。
 *
 * 模型的正文、思考、tool 调用文本，永远不进入 QQ。
 */
import { Type } from "@earendil-works/pi-ai";
import { defineEntry, defineTool, type ConversationId } from "@earendil-works/pi-durable";
import { validateOutbound, type EgressLimits } from "./policy.ts";
import { ledgerOf, recordSent } from "./ledger.ts";
import { renderTemplate, requireTool, type PromptSet } from "../prompts.ts";
import { OutboxDoc } from "../store.ts";

export interface OutboundPayload {
  /** 按顺序发出的几条文本。 */
  items: string[];
  media?: string;
  /** 是否引用触发这一轮的那条消息。 */
  quote: boolean;
  at: number;
  /** 幂等键：重放时用同一个，发送侧据此去重。 */
  key: string;
}

export const OutboundEntry = defineEntry<OutboundPayload>("fish.outbound");

export interface SayDeps {
  limits: EgressLimits;
  prompts: PromptSet;
  now?: () => number;
}

export function createSayTool(deps: SayDeps) {
  const now = deps.now ?? Date.now;
  const prompt = requireTool(deps.prompts, "say");

  return defineTool({
    name: "say",
    description: prompt.description,
    callers: ["model"], // 脚本 / 嵌套调用不能绕过校验
    parameters: Type.Object({
      messages: Type.Array(Type.String(), {
        description: prompt.params["messages"] ?? "",
        minItems: 1,
        maxItems: deps.limits.maxMessages,
      }),
      media: Type.Optional(Type.String({ description: prompt.params["media"] ?? "" })),
      quote: Type.Optional(Type.Boolean({ description: prompt.params["quote"] ?? "" })),
    }),
    execute: async (args, api, context) => {
      const ts = now();
      const ledger = ledgerOf(api.conversationId);

      const rejection = validateOutbound(
        { messages: args.messages, ...(args.media === undefined ? {} : { media: args.media }) },
        {
          limits: deps.limits,
          now: ts,
          recent: ledger.recent,
          sentThisRun: ledger.sentThisRun,
          secrets: ledger.secrets,
        },
      );

      if (rejection) {
        const template = deps.prompts.messages[rejection.code];
        if (!template) throw new Error(`prompt/messages.md 缺少文案：${rejection.code}`);
        const text = renderTemplate(template, rejection.vars ?? {});
        const which = rejection.index === undefined ? "" : `（第 ${rejection.index + 1} 条）`;
        throw new Error(`${which}${text}`);
      }

      const payload: OutboundPayload = {
        items: args.messages.map((m) => m.trim()),
        ...(args.media === undefined ? {} : { media: args.media }),
        quote: args.quote === true,
        at: ts,
        key: `${api.conversationId}:${api.callId}`,
      };

      // 落进 outbox（和 transcript entry 同一次提交）：宿主崩了也不会丢，重启后接着发
      await api.commit(async (tx) => {
        await tx.appendEntry(OutboundEntry, api.conversationId, { data: payload });
        const box = await tx.doc(OutboxDoc, api.conversationId);
        box.queue.push({ ...payload, status: "queued", attempts: 0 });
      }, context);

      recordSent(api.conversationId, payload.items, ts);

      return { output: [{ type: "text", text: deps.prompts.messages["say_sent"] ?? "ok" }] };
    },
  });
}
