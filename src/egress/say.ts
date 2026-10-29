/**
 * say —— 唯一的出口。
 *
 * 出口是「一条消息序列」：模型一次可以连说几句，每句单独过检，
 * 宿主按顺序发出、中间加抖动延迟。被拒绝时以 tool 错误返回（文案来自 prompt/messages.md）。
 *
 * 每轮硬上限：一轮 = 一次 submit 触发的 agent loop（pi-durable 用 pi.live.run.taskId 标识它），
 * 轮内第二次及之后的纯文字 say 直接以 tool 错误拒绝，不 emit、不静默。
 * 带 media 的发送（画完的图）是画图链路的必要出口：不受每轮限制也不占额度，
 * 否则模型先贫一句嘴就会把画好的图悶死在盘上。
 *
 * 模型的正文、思考、tool 调用文本，永远不进入 QQ。
 */
import { Type } from "@earendil-works/pi-ai";
import { LiveDoc, defineEntry, defineTool, type ConversationId } from "@earendil-works/pi-durable";
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
  /** 本轮触发消息的 id（由宿主在 submit 时绑定），引用不再串到别人的消息。 */
  quoteId?: number | string;
  /** 本轮触发是否@了鱼：被@必引用，出口层兑底。 */
  quoteForce?: boolean;
}

export const OutboundEntry = defineEntry<OutboundPayload>("fish.outbound");

export interface SayDeps {
  limits: EgressLimits;
  prompts: PromptSet;
  now?: () => number;
  /** submissionId → 本轮触发消息；宿主注入，能把引用目标绑在轮上。 */
  triggerOf?: (roundId: unknown) => { messageId?: number | string; mentionsBot: boolean; userId?: number } | undefined;
}

export function createSayTool(deps: SayDeps) {
  const now = deps.now ?? Date.now;
  const prompt = requireTool(deps.prompts, "say");

  // 轮计数：会话 → 最近说过话的那一轮（pi.live.run.taskId，一次 agent loop 一个）。
  // 轮标识由 pi-durable 自己维护，say 执行时现读，不需要外部重置信号；只在内存，重启丢一次不致命。
  const saidIn = new Map<ConversationId, number>();

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

      // 每轮硬上限：校验通过、真要开口前才计数——被拒绝的尝试不消耗机会，
      // 模型在同一轮里改口重说的设计得以保留。判定与记录同步，并发第二个也拦得住。
      // 带 media 的发送豁免：不检查也不消耗额度（画完的图必须能发出去），纯文字照旧一轮一条。
      // 轮标识用 run.inputs[0]（本轮要 settle 的输入任务）：整轮跨 generation 不变；
      // run.taskId 每代都会换，不能用。轮结束后 run 整个移除，下一轮自然换新标识。
      const live = await api.snapshot(LiveDoc, api.conversationId, context);
      const round = live?.run?.inputs?.[0];
      if (round !== undefined && args.media === undefined) {
        if (saidIn.get(api.conversationId) === round) {
          throw new Error(deps.prompts.messages["say_once"] ?? "already said this round");
        }
        saidIn.set(api.conversationId, round);
      }
      // 把本轮触发消息钉进 payload：出口层引用/强制引用都用它，不会被后续消息顶掉
      const trigger = round !== undefined ? deps.triggerOf?.(round) : undefined;

      const payload: OutboundPayload = {
        items: args.messages.map((m) => m.trim()),
        ...(args.media === undefined ? {} : { media: args.media }),
        quote: args.quote === true,
        ...(trigger?.messageId !== undefined ? { quoteId: trigger.messageId } : {}),
        ...(trigger ? { quoteForce: trigger.mentionsBot } : {}),
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
