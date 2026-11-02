/**
 * say_meme 工具包 —— 表情包出口。
 *
 * meme 关键词经 pickMeme 从库里挑图（命中权重与 meme 工具一致），挂成 media 发出去；
 * 频次三道闸：一轮最多一条附件（任何来源）、跨轮冷却（默认 8 分钟）、库里得有贴题的。
 * 说明文字与参数 Schema 唯一来自 TOOL.md manifest。
 */
import { defineTool, type ToolRegistration } from "@earendil-works/pi-durable";
import { validateOutbound } from "../../egress/policy.ts";
import { ledgerOf, recordMedia } from "../../egress/ledger.ts";
import { manifestParameters, toolFullDescription } from "../manifest.ts";
import type { ToolManifest, ToolPackageDeps } from "../types.ts";
import {
  assertMentions,
  chargeSayRound,
  enqueueOutbound,
  inMemeInbox,
  pickMeme,
  resolveQuoteArg,
  resolveSayContext,
  throwSayRejection,
  type OutboundPayload,
} from "../say-shared.ts";

/** args 静态类型：与 TOOL.md 的参数 Schema 对应（quote 是 schema 已移除的旧布尔，运行时容忍）；
 *  运行时 Schema 只有 manifest 这一份。 */
interface SayMemeArgs {
  meme: string;
  quoteMsgId?: string;
  /** 旧参数：schema 不再暴露；模型仍输出 quote:true 时按「引用本轮锚点」容忍，不报错。 */
  quote?: boolean;
  mentions?: string[];
}

/** 依赖不齐（缺出口限额）时返回 undefined，由注册方跳过。 */
export function createSayMemeTool(manifest: ToolManifest, deps: ToolPackageDeps): ToolRegistration | undefined {
  const limits = deps.limits;
  if (!limits) return undefined;
  const now = deps.now ?? Date.now;

  return defineTool({
    name: manifest.name,
    description: toolFullDescription(manifest),
    callers: ["model"], // 脚本 / 嵌套调用不能绕过校验
    parameters: manifestParameters<SayMemeArgs>(manifest),
    execute: async (args, api, context) => {
      const { round, trigger } = await resolveSayContext(api, deps, context);

      // 附件闸：一轮最多一张图（任何来源）
      const ts = now();
      const ledger = ledgerOf(api.conversationId);
      if (ledger.mediaThisRun >= 1) throw new Error(deps.prompts.messages["say_media_used"] ?? "say_media_used");
      // 跨轮冷却：防止每句话都配图
      const cooldownMs = (typeof deps.memeCooldownMs === "function" ? deps.memeCooldownMs() : deps.memeCooldownMs) ?? 8 * 60_000;
      if (ledger.lastMemeAt !== undefined && ts - ledger.lastMemeAt < cooldownMs) {
        throw new Error(deps.prompts.messages["say_meme_cooldown"] ?? "say_meme_cooldown");
      }
      const picked = pickMeme(limits.mediaRoot, args.meme);
      if (!picked) throw new Error(deps.prompts.messages["say_meme_nomatch"] ?? "say_meme_nomatch");
      const media = `memes/${picked}`;
      // 挑出来的路径也过一遍 inbox 围栏：索引被污染（file 带 ../ 逃逸）时不给直达出口
      if (inMemeInbox(limits.mediaRoot, media)) {
        throw new Error(deps.prompts.messages["say_media_inbox"] ?? "say_media_inbox");
      }

      // 引用参数（决策 6）：quoteMsgId 属本轮 quoteIds 窗口才有效，无效在开口计数前拒绝
      // 不占额度；旧 quote:true 运行时容忍（引用本轮锚点），机械必答引用链（quoteForce）
      // 不受模型参数影响
      const quoteArg = resolveQuoteArg(deps, trigger, args.quoteMsgId, args.quote);

      const mentions = [...new Set((args.mentions ?? []).map((qq) => qq.trim()))];
      await assertMentions(deps, api, trigger, mentions);

      const rejection = validateOutbound(
        { messages: [], media },
        { limits, now: ts, recent: ledger.recent, secrets: ledger.secrets },
      );
      if (rejection) throwSayRejection(deps.prompts.messages, rejection);

      chargeSayRound(String(api.conversationId), round, deps.prompts.messages["say_once"] ?? "already said this round");

      const payload: OutboundPayload = {
        items: [],
        media,
        ...(mentions.length === 0 ? {} : { mentions }),
        quote: quoteArg.quote,
        ...(quoteArg.quoteId !== undefined ? { quoteId: quoteArg.quoteId } : {}),
        ...(trigger ? { quoteForce: trigger.mentionsBot } : {}),
        at: ts,
        key: `${api.conversationId}:${api.callId}`,
      };
      await enqueueOutbound(api, payload, context);

      recordMedia(String(api.conversationId), ts, true);
      return { output: [{ type: "text", text: deps.prompts.messages["say_sent"] ?? "ok" }] };
    },
  });
}
