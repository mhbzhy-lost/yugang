/**
 * say_media 工具包 —— 图片出口。
 *
 * media 是相对 mediaRoot 的图片路径；meme-inbox/ 禁直发（先 look + meme_add 进库），
 * 一轮一条附件闸（mediaThisRun）与每轮开口计数都在共享实现里。
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
  resolveSayContext,
  throwSayRejection,
  type OutboundPayload,
} from "../say-shared.ts";

/** args 静态类型：与 TOOL.md 的参数 Schema 一一对应；运行时 Schema 只有 manifest 这一份。 */
interface SayMediaArgs {
  media: string;
  quote?: boolean;
  mentions?: string[];
}

/** 依赖不齐（缺出口限额）时返回 undefined，由注册方跳过。 */
export function createSayMediaTool(manifest: ToolManifest, deps: ToolPackageDeps): ToolRegistration | undefined {
  const limits = deps.limits;
  if (!limits) return undefined;
  const now = deps.now ?? Date.now;

  return defineTool({
    name: manifest.name,
    description: toolFullDescription(manifest),
    callers: ["model"], // 脚本 / 嵌套调用不能绕过校验
    parameters: manifestParameters<SayMediaArgs>(manifest),
    execute: async (args, api, context) => {
      const { round, trigger } = await resolveSayContext(api, deps, context);

      const media = args.media;
      // 本地待收目录（meme-inbox/）不是出口的图源：它里面的图必须先 look + meme_add 进库，
      // 否则「主人把图放进目录」就成了一条绕过审核的直达出口
      if (inMemeInbox(limits.mediaRoot, media)) {
        throw new Error(deps.prompts.messages["say_media_inbox"] ?? "say_media_inbox");
      }
      // 附件闸：一轮一条（图 / 表情 / 语音互斥）
      const ledger = ledgerOf(api.conversationId);
      if (ledger.mediaThisRun >= 1) throw new Error(deps.prompts.messages["say_media_used"] ?? "say_media_used");

      const mentions = [...new Set((args.mentions ?? []).map((qq) => qq.trim()))];
      await assertMentions(deps, api, trigger, mentions);

      const ts = now();
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
        quote: args.quote === true,
        ...(trigger?.messageId !== undefined ? { quoteId: trigger.messageId } : {}),
        ...(trigger ? { quoteForce: trigger.mentionsBot } : {}),
        at: ts,
        key: `${api.conversationId}:${api.callId}`,
      };
      await enqueueOutbound(api, payload, context);

      recordMedia(String(api.conversationId), ts);
      return { output: [{ type: "text", text: deps.prompts.messages["say_sent"] ?? "ok" }] };
    },
  });
}
