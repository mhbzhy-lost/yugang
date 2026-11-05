/**
 * say_words 工具包 —— 文字出口。
 *
 * 一次调用 = 一条消息（text 单条字符串）。mentions 校验、出口校验、每轮开口计数与
 * 入队全部走 say-shared.ts 的共享实现，这里只做参数面的窄适配。
 * 视频分享（2026-11-05 定稿）：分享视频就是「一句推荐语 + 一个链接」，没有专用字段。
 * 唯一的机械约束是链接白名单——文本里的每个 URL 都必须是本轮工具结果里真的出现过的
 * 那一条（src/egress/seen-links.ts，宿主在工具包装层机械登记），**或者**是本轮 video
 * 实际看过的那条视频的链接（按 BV 认，见 src/external/video-links.ts）；所以模型编不出
 * URL，也不能把群友贴的链接原样播出去。文本里出现 B 站 BV 链接时顺手记进会话私有池
 * （fish.video_pool，bili_hot 用它过滤重复推荐），与 outbound/outbox 同一次提交。
 * 什么时候该看、该不该分享由 prompt 的 `[本轮要求]` 约束，工具不区分钟类型。
 * 旧外部弹药分享（ammoId，外部计划 E5）内核源码保留但模型 Schema 已不再暴露：
 * 分享门接线（wireAmmoShareHost）已随弹药管线停用摘除，这条链恒 fail closed。
 * 说明文字与参数 Schema 唯一来自 TOOL.md manifest。
 */
import { defineTool, type ToolRegistration } from "@earendil-works/pi-durable";
import { validateOutbound } from "../../egress/policy.ts";
import { ledgerOf, recordSent } from "../../egress/ledger.ts";
import { extractLinks, seenLinksOf } from "../../egress/seen-links.ts";
import { ExternalAmmoDoc, ammoVideoUrlOf, applyAmmoClaim } from "../../external/ammo-store.ts";
import { bvidOfUrl } from "../../external/video-links.ts";
import { viewedVideoOf } from "../../external/video-browse.ts";
import { VideoPoolDoc, applyVideoPoolAdd, videoPoolKeyOf, viewedVideoTitleOf } from "../../external/video-pool.ts";
import { renderTemplate } from "../../prompt/index.ts";
import { OutboxDoc } from "../../store.ts";
import { manifestParameters, toolFullDescription } from "../manifest.ts";
import type { ToolManifest, ToolPackageDeps } from "../types.ts";
import { ammoCurfewAt, ammoShareGateOf, assertMentions, assertShareAllowed, chargeSayRound, enqueueOutbound, normalizeTextInput, OutboundEntry, peekSayRound, prefixAmmoLink, registerAmmoShare, resolveQuoteArg, resolveSayContext, stripOutboundLinks, throwSayRejection, type OutboundPayload } from "../say-shared.ts";

/** args 静态类型：与 TOOL.md 的参数 Schema 对应（quote 是 schema 已移除的旧布尔，运行时容忍）；
 *  运行时 Schema 只有 manifest 这一份。 */
interface SayWordsArgs {
  text: string;
  quoteMsgId?: string;
  /** 旧参数：schema 不再暴露；模型仍输出 quote:true 时按「引用本轮锚点」容忍，不报错。 */
  quote?: boolean;
  /** 素材分享声明（决策 24）：ambient/injection 轮末条自言时必须为 true 才放行。 */
  share?: boolean;
  /**
   * 旧外部弹药编号（外部计划 E5，已停用）：Schema 不再暴露，内核源码兼容保留——
   * 分享门接线已摘除，这条链恒 fail closed（ammo_gate_closed）。
   */
  ammoId?: string;
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

      // 末条自言禁言（决策 24）：群里最后一条是自己发的时，ambient/injection 轮只放行
      // 素材分享——share: true（承诺/委托）这一种声明；必须在开口计数前（被拒不占额度），
      // answer 轮天然豁免。2026-11-05 起不再有 videoBvid：分享视频就是「推荐语 + 链接」，
      // 声不声明是素材分享由 share 决定。
      assertShareAllowed(deps, api, trigger, args.share, args.ammoId);

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

      const ammoId = String(args.ammoId ?? "").trim();
      let outboundText = text;
      const payloadBase = {
        ...(mentions.length === 0 ? {} : { mentions }),
        quote: quoteArg.quote,
        ...(quoteArg.quoteId !== undefined ? { quoteId: quoteArg.quoteId } : {}),
        ...(trigger ? { quoteForce: trigger.mentionsBot } : {}),
        at: ts,
        key: `${api.conversationId}:${api.callId}`,
      };

      // 链接白名单（2026-11-05）：文本里出现的每个 http(s) 链接都必须是**本轮工具结果
      // 里真的出现过**的那一条（video 卡片、bili_video 卡片、search 摘要、新闻成品…由
      // 宿主在工具包装层机械登记）。这样「分享一个视频」就只是「推荐语 + 链接」两个普通
      // 东西，不再需要 videoBvid 这种专用字段；同时模型编不出 URL，也无法把群友贴的链接
      // 原样播出去——想转发别人的链接，得先用工具打开一遍拿回 canonical 链接。
      const links = extractLinks(text);
      const sharedBvids: string[] = [];
      if (links.length > 0) {
        const allowed = seenLinksOf(round);
        const viewed = viewedVideoOf(round);
        const denied = links.filter((url) => {
          if (allowed.has(url)) return false;
          // 本轮实际看过的视频：链接写法（query / 尾斜杠 / m.bilibili.com）可能和工具结果
          // 的 canonical 形不完全一致，按 BV 认——「看过的视频就能分享」是 video 的承诺，
          // 不能被字符串比对漏掉（2026-11-05 主人反馈：看了却发不出来）。
          const bvid = bvidOfUrl(url);
          return bvid === undefined || !viewed.has(bvid);
        });
        if (denied.length > 0) {
          throw new Error(renderTemplate(
            deps.prompts.messages["say_link_not_allowed"] ?? "say_link_not_allowed",
            { url: denied[0]! },
          ));
        }
      }
      // 已分享的视频记进去重表（bili_hot 用它过滤重复推荐）：纯机械——本条消息里出现的
      // BV 号就记一笔，**不要求带链接**。2026-11-05 修：此前只认 URL，模型退化成「只发
      // BV 号」（见 findProvenanceLeak 的链接豁免）时就不进表，于是同一条视频会被发第二遍。
      for (const bvid of text.match(/BV[0-9A-Za-z]{10}/g) ?? []) {
        if (!sharedBvids.includes(bvid)) sharedBvids.push(bvid);
      }

      // 旧外部弹药分享（E5，已停用兼容保留）：Schema 不再暴露 ammoId，分享门接线已摘除，
      // 这条链恒 fail closed（ammo_gate_closed）；全链在出口校验之后、开口计数之前——任何失败路径都不占额度。
      // 额度 peek 先行：claim 成功后 chargeSayRound 才不会再抛 say_once（避免条目卡在 claimed）
      if (ammoId.length > 0) {
        peekSayRound(String(api.conversationId), round, deps.prompts.messages["say_once"] ?? "already said this round");
        // 门与宵禁：fail closed——chatKey 拿不到 / 非 open 窗 / 门未开 / 深夜，一律拒不 claim
        const chatKey = deps.chatKeyOf?.(String(api.conversationId));
        const gate = chatKey === undefined ? undefined : ammoShareGateOf(chatKey);
        if (gate === undefined || !gate.open) {
          throw new Error(deps.prompts.messages["ammo_gate_closed"] ?? "ammo_gate_closed");
        }
        if (ammoCurfewAt(ts)) throw new Error(deps.prompts.messages["ammo_curfew"] ?? "ammo_curfew");
        // claim 与入队同一事务（工具调用内多次 commit 不可靠，且 claim+outbox 原子性更优：
        // 任一环失败整体回滚，不会出现条目已 claimed 而消息没入队的裂缝）：
        // 惰性 TTL sweep + 本窗未消费 + available → URL 宿主从 doc 渲染前缀 →
        // appendEntry + outbox push；所需字段在事务内拷成纯值——事务返回后 result.item
        // 是已分离的 doc proxy，不能再读（amro_submit 同款教训：只读 status）
        let claimed: { id: string; bvid: string } | undefined;
        const outcome = await api.commit(async (tx) => {
          const doc = await tx.doc(ExternalAmmoDoc);
          const result = applyAmmoClaim(doc, ammoId, gate.windowId, ts);
          if (result.status !== "ok") return result;
          claimed = { id: result.item.id, bvid: result.item.bvid };
          const finalText = prefixAmmoLink(ammoVideoUrlOf(result.item), stripOutboundLinks(text));
          const payload: OutboundPayload = { items: [finalText], ...payloadBase };
          await tx.appendEntry(OutboundEntry, api.conversationId, { data: payload });
          const box = await tx.doc(OutboxDoc, api.conversationId);
          box.queue.push({ ...payload, status: "queued", attempts: 0 });
          return result;
        }, context);
        if (outcome.status === "missing") {
          throw new Error(renderTemplate(deps.prompts.messages["ammo_missing"] ?? "", { id: ammoId }));
        }
        if (outcome.status === "not_available") {
          throw new Error(deps.prompts.messages["ammo_not_available"] ?? "ammo_not_available");
        }
        if (outcome.status === "window_used") {
          throw new Error(deps.prompts.messages["ammo_window_used"] ?? "ammo_window_used");
        }
        outboundText = prefixAmmoLink(ammoVideoUrlOf(claimed!), stripOutboundLinks(text));
        registerAmmoShare(payloadBase.key, { id: claimed!.id, windowId: gate.windowId });
        console.log(`[鱼缸] 弹药分享 claim ${claimed!.bvid} 窗 ${gate.windowId}`);
      }

      // 每轮硬上限（四个 say_* 共享）：校验通过才计数，被拒的尝试不消耗额度
      chargeSayRound(String(api.conversationId), round, deps.prompts.messages["say_once"] ?? "already said this round");

      if (ammoId.length === 0) {
        const payload: OutboundPayload = { items: [outboundText], ...payloadBase };
        if (sharedBvids.length === 0) {
          // 普通路径走共享入队（ammo 路径已在上方事务里入队）
          await enqueueOutbound(api, payload, context);
        } else {
          // 分享过视频：池记账与 outbound entry / outbox 同一次提交，任一环失败整体回滚
          await api.commit(async (tx) => {
            // 去重表按 chatKey 绑定（同群换人格也共享历史）
            const pool = await tx.doc(VideoPoolDoc, videoPoolKeyOf(deps.chatKeyOf?.(String(api.conversationId)), api.conversationId));
            for (const bvid of sharedBvids) {
              applyVideoPoolAdd(
                pool,
                {
                  bvid,
                  title: viewedVideoTitleOf(round, bvid),
                  note: stripOutboundLinks(text),
                  topic: "自选",
                },
                ts,
              );
            }
            await tx.appendEntry(OutboundEntry, api.conversationId, { data: payload });
            const box = await tx.doc(OutboxDoc, api.conversationId);
            box.queue.push({ ...payload, status: "queued", attempts: 0 });
          }, context);
        }
      }

      recordSent(api.conversationId, [outboundText], ts);
      return { output: [{ type: "text", text: deps.prompts.messages["say_sent"] ?? "ok" }] };
    },
  });
}
