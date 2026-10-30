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
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { Type } from "@earendil-works/pi-ai";
import { LiveDoc, defineEntry, defineTool, type ConversationId } from "@earendil-works/pi-durable";
import { validateOutbound, type EgressLimits } from "./policy.ts";
import { ledgerOf, recordMedia, recordSent } from "./ledger.ts";
import { synthesizeToMedia } from "../tts.ts";
import { renderTemplate, requireTool, type PromptSet } from "../prompts.ts";
import { OutboxDoc } from "../store.ts";

export interface OutboundPayload {
  /** 按顺序发出的几条文本。 */
  items: string[];
  media?: string;
  /** 语音文件（相对 mediaRoot），与 media 互斥。 */
  voice?: string;
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
  /** 表情包跨轮冷却（毫秒），缺省 8 分钟；给函数就是每次现取（热更新用）。 */
  memeCooldownMs?: number | (() => number);
  /** 语音合成配置（按会话现取：一个会话一个人格，音色跟着人格走）。 */
  ttsOf?: (conversationId: string) => import("../tts.ts").TtsConfig | undefined;
  /** 合成实现；测试可注入桩，线上用 synthesizeToMedia。 */
  ttsSynthesize?: (config: import("../tts.ts").TtsConfig, text: string, mediaRoot: string) => Promise<{ ref: string; bytes: Buffer }>;
  /** 收图轮之类的静默轮：这一轮不许说话。 */
  silentOf?: (roundId: unknown) => boolean;
}

export function createSayTool(deps: SayDeps) {
  const now = deps.now ?? Date.now;
  const prompt = requireTool(deps.prompts, "say");

  // 轮计数：会话 → { 轮标识, 已开口次数 }（pi.live.run.taskId，一次 agent loop 一个）。
  // 上限 3 次只是闸门：不鼓励多说，一句能说完的事别拆三条（人格书仍这么引导）。
  // 轮标识由 pi-durable 自己维护，say 执行时现读，不需要外部重置信号；只在内存，重启丢一次不致命。
  const saidIn = new Map<ConversationId, { round: number; count: number }>();

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
      meme: Type.Optional(Type.String({ description: prompt.params["meme"] ?? "" })),
      voice: Type.Optional(Type.Boolean({ description: prompt.params["voice"] ?? "" })),
      quote: Type.Optional(Type.Boolean({ description: prompt.params["quote"] ?? "" })),
    }),
    execute: async (args, api, context) => {
      // 静默轮（自动收表情包）只允许调工具，不许冒话
      {
        const live = await api.snapshot(LiveDoc, api.conversationId, context);
        const round = live?.run?.inputs?.[0];
        if (round !== undefined && deps.silentOf?.(round)) {
          throw new Error(deps.prompts.messages["say_silent"] ?? "say_silent");
        }
      }

      const ts = now();
      const ledger = ledgerOf(api.conversationId);

      // 表情包一条龙：传了 meme 关键词就直接挑图挂到 media 上，省掉先调 meme 再发的一轮往返。
      // 频次三道上限：一轮最多一张图（任何来源）、跨轮冷却（默认 8 分钟）、库里得有贴题的。
      let media = args.media;
      let sentMeme = false;
      let voice: string | undefined;

      if (args.voice === true) {
        const tts = deps.ttsOf?.(String(api.conversationId));
        if (!tts?.url) throw new Error(deps.prompts.messages["voice_off"] ?? "voice_off");
        if (media !== undefined || args.meme) throw new Error(deps.prompts.messages["voice_with_media"] ?? "voice_with_media");
        const spoken = args.messages.map((m) => m.trim()).filter(Boolean).join("，");
        if (!spoken) throw new Error(deps.prompts.messages["empty"] ?? "empty");
        if (spoken.length > 100) throw new Error(renderTemplate(deps.prompts.messages["voice_too_long"] ?? "", { length: String(spoken.length) }));
        // 用不用语音由鱼自己判断（prompt 里给了场合），这里只确认这个会话有音色
        if (ledger.mediaThisRun >= 1) throw new Error(deps.prompts.messages["say_media_used"] ?? "say_media_used");
        try {
          const synth = await (deps.ttsSynthesize ?? synthesizeToMedia)(tts, spoken, deps.limits.mediaRoot);
          voice = synth.ref;
        } catch (error) {
          console.error("[鱼缸] 语音合成失败", error instanceof Error ? error.message : error);
          throw new Error(deps.prompts.messages["voice_failed"] ?? "voice_failed");
        }
      }
      if (args.meme !== undefined && args.meme.trim() !== "") {
        if (media !== undefined) throw new Error(deps.prompts.messages["say_one_media"] ?? "say_one_media");
        if (ledger.mediaThisRun >= 1) throw new Error(deps.prompts.messages["say_media_used"] ?? "say_media_used");
        const cooldownMs = (typeof deps.memeCooldownMs === "function" ? deps.memeCooldownMs() : deps.memeCooldownMs) ?? 8 * 60_000;
        if (ledger.lastMemeAt !== undefined && ts - ledger.lastMemeAt < cooldownMs) {
          throw new Error(deps.prompts.messages["say_meme_cooldown"] ?? "say_meme_cooldown");
        }
        const picked = pickMeme(deps, args.meme);
        if (!picked) throw new Error(deps.prompts.messages["say_meme_nomatch"] ?? "say_meme_nomatch");
        media = `memes/${picked}`;
        sentMeme = true;
      } else if (media !== undefined && ledger.mediaThisRun >= 1) {
        throw new Error(deps.prompts.messages["say_media_used"] ?? "say_media_used");
      }

      const rejection = validateOutbound(
        { messages: args.voice === true ? [] : args.messages, ...(media === undefined ? {} : { media }), ...(voice === undefined ? {} : { voice }) },
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
      if (round !== undefined && media === undefined && voice === undefined) {
        const said = saidIn.get(api.conversationId);
        if (said?.round === round && said.count >= 3) {
          throw new Error(deps.prompts.messages["say_once"] ?? "already said this round");
        }
        saidIn.set(api.conversationId, { round, count: said?.round === round ? said.count + 1 : 1 });
      }
      // 把本轮触发消息钉进 payload：出口层引用/强制引用都用它，不会被后续消息顶掉
      const trigger = round !== undefined ? deps.triggerOf?.(round) : undefined;

      const payload: OutboundPayload = {
        // 语音消息只发语音，不再重复发一条文字（说了什么全在音频里）
        items: voice !== undefined ? [] : args.messages.map((m) => m.trim()),
        ...(media === undefined ? {} : { media }),
        ...(voice === undefined ? {} : { voice }),
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
      if (media !== undefined) recordMedia(api.conversationId, ts, sentMeme);
      if (voice !== undefined) recordMedia(api.conversationId, ts);

      return { output: [{ type: "text", text: deps.prompts.messages["say_sent"] ?? "ok" }] };
    },
  });
}

/** 从库里挑一张最贴关键词的（命中权重与 meme 工具一致），并列时随机，避免每次同图。 */
function pickMeme(deps: SayDeps, keyword: string): string | undefined {
  const indexUrl = join(deps.limits.mediaRoot, "memes", "index.json");
  if (!existsSync(indexUrl)) return undefined;
  let entries: { file: string; caption: string; tags: string[] }[];
  try {
    entries = JSON.parse(readFileSync(indexUrl, "utf8")) as { file: string; caption: string; tags: string[] }[];
  } catch {
    return undefined;
  }
  const terms = keyword.trim().toLowerCase().split(/\s+/).filter(Boolean);
  const scored = entries
    .map((e) => {
      let score = 0;
      for (const kw of terms) {
        const tagHit = e.tags.some((tag) => {
          const t = tag.toLowerCase();
          return t.includes(kw) || kw.includes(t);
        });
        if (tagHit) score += 2;
        else if (e.caption.toLowerCase().includes(kw)) score += 1;
      }
      return { e, score };
    })
    .filter((x) => x.score > 0)
    .sort((a, b) => b.score - a.score);
  if (scored.length === 0) return undefined;
  const top = scored.filter((x) => x.score === scored[0]!.score);
  return top[Math.floor(Math.random() * top.length)]!.e.file;
}
