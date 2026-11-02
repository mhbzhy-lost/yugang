/**
 * say_words 工具包 —— 文字出口。
 *
 * 一次调用 = 一条消息（text 单条字符串）。mentions 校验、出口校验、每轮开口计数与
 * 入队全部走 say-shared.ts 的共享实现，这里只做参数面的窄适配。
 * 说明文字与参数 Schema 唯一来自 TOOL.md manifest。
 */
import { defineTool, type ToolRegistration } from "@earendil-works/pi-durable";
import { validateOutbound } from "../../egress/policy.ts";
import { ledgerOf, recordSent } from "../../egress/ledger.ts";
import { manifestParameters, toolFullDescription } from "../manifest.ts";
import type { ToolManifest, ToolPackageDeps } from "../types.ts";
import { assertMentions, assertShareAllowed, chargeSayRound, enqueueOutbound, normalizeTextInput, resolveQuoteArg, resolveSayContext, throwSayRejection, type OutboundPayload } from "../say-shared.ts";

/** args 静态类型：与 TOOL.md 的参数 Schema 对应（quote 是 schema 已移除的旧布尔，运行时容忍）；
 *  运行时 Schema 只有 manifest 这一份。 */
interface SayWordsArgs {
  text: string;
  quoteMsgId?: string;
  /** 旧参数：schema 不再暴露；模型仍输出 quote:true 时按「引用本轮锚点」容忍，不报错。 */
  quote?: boolean;
  /** 素材分享声明（决策 24）：ambient/injection 轮末条自言时必须为 true 才放行。 */
  share?: boolean;
  mentions?: string[];
}

/** 依赖不齐（缺出口限额）时返回 undefined，由注册方跳过。 */
export function createSayWordsTool(manifest: ToolManifest, deps: ToolPackageDeps): ToolRegistration | undefined {
  const limits = deps.limits;
  if (!limits) return undefined;
  const now = deps.now ?? Date.now;

  return defineTool({
    name: manifest.name,
    description: toolFullDescription(manifest),
    callers: ["model"], // 脚本 / 嵌套调用不能绕过校验
    parameters: manifestParameters<SayWordsArgs>(manifest),
    execute: async (args, api, context) => {
      const { round, trigger } = await resolveSayContext(api, deps, context);

      // 末条自言禁言（决策 24）：群里最后一条是自己发的时，ambient/injection 轮只放行带
      // share 的素材分享；必须在开口计数前（被拒不占额度），answer 轮天然豁免
      assertShareAllowed(deps, api, trigger, args.share);

      const text = normalizeTextInput(args.text);
      if (!text) throw new Error(deps.prompts.messages["empty"] ?? "empty");

      // 引用参数（决策 6）：quoteMsgId 属本轮 quoteIds 窗口才有效，无效在开口计数前拒绝
      // 不占额度；旧 quote:true 运行时容忍（引用本轮锚点），机械必答引用链（quoteForce）
      // 不受模型参数影响
      const quoteArg = resolveQuoteArg(deps, trigger, args.quoteMsgId, args.quote);

      // 主动 @：去重后整段机械校验（say-shared 唯一实现），任何一环缺失都 fail closed
      const mentions = [...new Set((args.mentions ?? []).map((qq) => qq.trim()))];
      await assertMentions(deps, api, trigger, mentions);

      const ts = now();
      const ledger = ledgerOf(api.conversationId);
      const rejection = validateOutbound(
        { messages: [text] },
        { limits, now: ts, recent: ledger.recent, secrets: ledger.secrets },
      );
      if (rejection) throwSayRejection(deps.prompts.messages, rejection);

      // 每轮硬上限（四个 say_* 共享）：校验通过才计数，被拒的尝试不消耗额度
      chargeSayRound(String(api.conversationId), round, deps.prompts.messages["say_once"] ?? "already said this round");

      // 把本轮触发消息钉进 payload：出口层引用/强制引用都用它，不会被后续消息顶掉
      const payload: OutboundPayload = {
        items: [text],
        ...(mentions.length === 0 ? {} : { mentions }),
        quote: quoteArg.quote,
        ...(quoteArg.quoteId !== undefined ? { quoteId: quoteArg.quoteId } : {}),
        ...(trigger ? { quoteForce: trigger.mentionsBot } : {}),
        at: ts,
        key: `${api.conversationId}:${api.callId}`,
      };
      await enqueueOutbound(api, payload, context);

      recordSent(api.conversationId, payload.items, ts);
      return { output: [{ type: "text", text: deps.prompts.messages["say_sent"] ?? "ok" }] };
    },
  });
}
