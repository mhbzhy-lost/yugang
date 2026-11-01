/**
 * say_voice 工具包 —— 语音出口。
 *
 * text 合成成音频（GPT-SoVITS，tts.ts 落盘到 voice/），只发语音不再发文字气泡。
 * 没有mentions 参数：语音没有文本气泡，@等于静默丢人。一轮一条附件闸照常。
 * 说明文字与参数 Schema 唯一来自 TOOL.md manifest。
 */
import { defineTool, type ToolRegistration } from "@earendil-works/pi-durable";
import { validateOutbound } from "../../egress/policy.ts";
import { ledgerOf, recordMedia } from "../../egress/ledger.ts";
import { synthesizeToMedia } from "../../tts.ts";
import { renderTemplate } from "../../prompts.ts";
import { manifestParameters, toolFullDescription } from "../manifest.ts";
import type { ToolManifest, ToolPackageDeps } from "../types.ts";
import { chargeSayRound, enqueueOutbound, normalizeTextInput, resolveSayContext, throwSayRejection, type OutboundPayload } from "../say-shared.ts";

/** args 静态类型：与 TOOL.md 的参数 Schema 一一对应；运行时 Schema 只有 manifest 这一份。 */
interface SayVoiceArgs {
  text: string;
  quote?: boolean;
}

/** 语音单条上限（字）：超长以 tool 错误拒绝，长的内容用文字说。 */
const VOICE_MAX_CHARS = 200;

/** 依赖不齐（缺出口限额）时返回 undefined，由注册方跳过。 */
export function createSayVoiceTool(manifest: ToolManifest, deps: ToolPackageDeps): ToolRegistration | undefined {
  const limits = deps.limits;
  if (!limits) return undefined;
  const now = deps.now ?? Date.now;

  return defineTool({
    name: manifest.name,
    description: toolFullDescription(manifest),
    callers: ["model"], // 脚本 / 嵌套调用不能绕过校验
    parameters: manifestParameters<SayVoiceArgs>(manifest),
    execute: async (args, api, context) => {
      const { round, trigger } = await resolveSayContext(api, deps, context);

      // 用不用语音由鱼自己判断（prompt 里给了场合），这里只确认这个会话有音色
      const tts = deps.ttsOf?.(String(api.conversationId));
      if (!tts?.url) throw new Error(deps.prompts.messages["voice_off"] ?? "voice_off");

      // 附件闸：一轮一条（图 / 表情 / 语音互斥）
      const ledger = ledgerOf(api.conversationId);
      if (ledger.mediaThisRun >= 1) throw new Error(deps.prompts.messages["say_media_used"] ?? "say_media_used");

      const spoken = normalizeTextInput(args.text);
      if (!spoken) throw new Error(deps.prompts.messages["empty"] ?? "empty");
      if (spoken.length > VOICE_MAX_CHARS) {
        throw new Error(renderTemplate(deps.prompts.messages["voice_too_long"] ?? "", { length: String(spoken.length) }));
      }

      const ts = now();
      let voice: string;
      try {
        // 空响应重试一次的逻辑在 tts.ts（第二次用 text_language=auto 兜底）
        const synth = await (deps.ttsSynthesize ?? synthesizeToMedia)(tts, spoken, limits.mediaRoot);
        voice = synth.ref;
      } catch (error) {
        console.error("[鱼缸] 语音合成失败", error instanceof Error ? error.message : error);
        throw new Error(deps.prompts.messages["voice_failed"] ?? "voice_failed");
      }

      const rejection = validateOutbound(
        { messages: [], voice },
        { limits, now: ts, recent: ledger.recent, secrets: ledger.secrets },
      );
      if (rejection) throwSayRejection(deps.prompts.messages, rejection);

      chargeSayRound(String(api.conversationId), round, deps.prompts.messages["say_once"] ?? "already said this round");

      const payload: OutboundPayload = {
        // 语音消息只发语音，不再重复发一条文字（说了什么全在音频里）
        items: [],
        voice,
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
