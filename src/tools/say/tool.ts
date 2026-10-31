/**
 * say 工具包 —— 唯一的出口。
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
 *
 * 说明文字与参数 Schema 唯一来自 TOOL.md manifest（factory 只消费它，不再有第二份运行时定义）。
 */
import { existsSync, readFileSync } from "node:fs";
import { join, resolve, sep } from "node:path";
import { LiveDoc, defineEntry, defineTool, type ConversationId, type ToolRegistration } from "@earendil-works/pi-durable";
import { validateOutbound } from "../../egress/policy.ts";
import { ledgerOf, recordMedia, recordSent } from "../../egress/ledger.ts";
import { synthesizeToMedia } from "../../tts.ts";
import { renderTemplate } from "../../prompts.ts";
import { OutboxDoc } from "../../store.ts";
import { manifestParameters, toolFullDescription } from "../manifest.ts";
import type { ToolManifest, ToolPackageDeps } from "../types.ts";

export interface OutboundPayload {
  /** 按顺序发出的几条文本。 */
  items: string[];
  media?: string;
  /** 语音文件（相对 mediaRoot），与 media 互斥。 */
  voice?: string;
  /** 是否引用触发这一轮的那条消息。 */
  quote: boolean;
  /** 主动 @ 的 QQ 号（已去重的纯数字，出口层验过身份与群成员）；只挂在第一条文本上。 */
  mentions?: string[];
  at: number;
  /** 幂等键：重放时用同一个，发送侧据此去重。 */
  key: string;
  /** 本轮触发消息的 id（由宿主在 submit 时绑定），引用不再串到别人的消息。 */
  quoteId?: number | string;
  /** 本轮触发是否@了鱼：被@必引用，出口层兑底。 */
  quoteForce?: boolean;
}

export const OutboundEntry = defineEntry<OutboundPayload>("fish.outbound");

/** args 静态类型：与 TOOL.md 的参数 Schema 一一对应；运行时 Schema 只有 manifest 这一份。 */
interface SayArgs {
  messages: string[];
  media?: string;
  meme?: string;
  voice?: boolean;
  quote?: boolean;
  mentions?: string[];
}

/** 依赖不齐（缺出口限额）时返回 undefined，由注册方跳过。 */
export function createSayTool(manifest: ToolManifest, deps: ToolPackageDeps): ToolRegistration | undefined {
  const limits = deps.limits;
  if (!limits) return undefined;
  const now = deps.now ?? Date.now;
  // 本地待收目录（meme-inbox/）不是出口的图源：它里面的图必须先 look + meme_add 进库，
  // 否则「主人把图放进目录」就成了一条绕过审核的直达出口。
  const mediaRoot = resolve(limits.mediaRoot);
  const inboxDir = join(mediaRoot, "meme-inbox");
  const inMemeInbox = (ref: string): boolean => {
    const full = resolve(mediaRoot, ref);
    return full === inboxDir || full.startsWith(inboxDir + sep);
  };

  // 轮计数：会话 → { 轮标识, 已开口次数 }（pi.live.run.taskId，一次 agent loop 一个）。
  // 上限 3 次只是闸门：不鼓励多说，一句能说完的事别拆三条（人格书仍这么引导）。
  // 轮标识由 pi-durable 自己维护，say 执行时现读，不需要外部重置信号；只在内存，重启丢一次不致命。
  const saidIn = new Map<ConversationId, { round: number; count: number }>();

  return defineTool({
    name: manifest.name,
    description: toolFullDescription(manifest),
    callers: ["model"], // 脚本 / 嵌套调用不能绕过校验
    parameters: manifestParameters<SayArgs>(manifest),
    execute: async (args, api, context) => {
      // 静默轮（自动收表情包）只允许调工具，不许冒话
      const live = await api.snapshot(LiveDoc, api.conversationId, context);
      const round = live?.run?.inputs?.[0];
      if (round !== undefined && deps.silentOf?.(round)) {
        throw new Error(deps.prompts.messages["say_silent"] ?? "say_silent");
      }

      // 本轮触发消息：主动 @ 的身份闸和引用目标都钉在它上面
      const trigger = round !== undefined ? deps.triggerOf?.(round) : undefined;

      // 主动 @：去重 → 禁 all/非数字 → 身份闸 → 群成员核对，全程机械判定，任何一环缺失都 fail closed。
      // 语音 payload 没有文本 item，带 @ 等于静默丢人，所以这里直接拒。
      const mentions = [...new Set((args.mentions ?? []).map((qq) => qq.trim()))];
      if (mentions.length > 0) {
        if (args.voice === true) throw new Error(deps.prompts.messages["say_mention_voice"] ?? "say_mention_voice");
        if (mentions.includes("all")) throw new Error(deps.prompts.messages["say_mention_all"] ?? "say_mention_all");
        if (mentions.some((qq) => !/^\d+$/.test(qq))) {
          throw new Error(deps.prompts.messages["say_mention_bad"] ?? "say_mention_bad");
        }
        if (mentions.length > 3) throw new Error(deps.prompts.messages["say_mention_too_many"] ?? "say_mention_too_many");
        if (trigger === undefined) throw new Error(deps.prompts.messages["say_mention_no_trigger"] ?? "say_mention_no_trigger");
        const policy = deps.mentionPolicyOf?.(String(api.conversationId), trigger.userId);
        if (policy === "not_group") throw new Error(deps.prompts.messages["say_mention_private"] ?? "say_mention_private");
        if (policy !== "allow") {
          throw new Error(deps.prompts.messages["say_mention_not_privileged"] ?? "say_mention_not_privileged");
        }
        const members = deps.membersOf ? await deps.membersOf(String(api.conversationId)) : undefined;
        if (!members || members.length === 0) {
          throw new Error(deps.prompts.messages["say_mention_members_missing"] ?? "say_mention_members_missing");
        }
        const known = new Set(members.map((member) => member.userId));
        const missing = mentions.filter((qq) => !known.has(qq));
        if (missing.length > 0) {
          throw new Error(renderTemplate(deps.prompts.messages["say_mention_not_member"] ?? "", { userIds: missing.join("、") }));
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
          const synth = await (deps.ttsSynthesize ?? synthesizeToMedia)(tts, spoken, limits.mediaRoot);
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
        const picked = pickMeme(limits.mediaRoot, args.meme);
        if (!picked) throw new Error(deps.prompts.messages["say_meme_nomatch"] ?? "say_meme_nomatch");
        media = `memes/${picked}`;
        sentMeme = true;
      } else if (media !== undefined && ledger.mediaThisRun >= 1) {
        throw new Error(deps.prompts.messages["say_media_used"] ?? "say_media_used");
      }
      // meme-inbox/ 里的图不能直接当 media 发：先 look 看一眼、再用 meme_add 收进库，
      // 之后从库里（memes/…）或 meme 参数发。正常媒体目录（inbound/、gen/、memes/）不受影响。
      if (media !== undefined && inMemeInbox(media)) {
        throw new Error(deps.prompts.messages["say_media_inbox"] ?? "say_media_inbox");
      }

      const rejection = validateOutbound(
        { messages: args.voice === true ? [] : args.messages, ...(media === undefined ? {} : { media }), ...(voice === undefined ? {} : { voice }) },
        {
          limits,
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
      if (round !== undefined && media === undefined && voice === undefined) {
        const said = saidIn.get(api.conversationId);
        if (said?.round === round && said.count >= 3) {
          throw new Error(deps.prompts.messages["say_once"] ?? "already said this round");
        }
        saidIn.set(api.conversationId, { round, count: said?.round === round ? said.count + 1 : 1 });
      }
      // 把本轮触发消息钉进 payload：出口层引用/强制引用都用它，不会被后续消息顶掉
      const payload: OutboundPayload = {
        // 语音消息只发语音，不再重复发一条文字（说了什么全在音频里）
        items: voice !== undefined ? [] : args.messages.map((m) => m.trim()),
        ...(media === undefined ? {} : { media }),
        ...(voice === undefined ? {} : { voice }),
        ...(mentions.length === 0 ? {} : { mentions }),
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
function pickMeme(mediaRoot: string, keyword: string): string | undefined {
  const indexUrl = join(mediaRoot, "memes", "index.json");
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
