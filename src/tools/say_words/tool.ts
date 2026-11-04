/**
 * say_words 工具包 —— 文字出口。
 *
 * 一次调用 = 一条消息（text 单条字符串）。mentions 校验、出口校验、每轮开口计数与
 * 入队全部走 say-shared.ts 的共享实现，这里只做参数面的窄适配。
 * 自主浏览视频分享（2026-11-04 模型输入计划 T4）：videoBvid 参数触发双重白名单——
 * ① 本轮必须是带有效 browseWindow/browseTopic 的 open injection browse 轮且宿主门
 * 现窗匹配；② BV 必须在本轮被 video 工具实际成功观看过（viewedVideoOf）。放行后
 * 在同一 transaction 里完成：会话私有池（fish.video_pool）BV 去重写入 + 宿主拼
 * canonical 链接前缀进 payload + fish.outbox 入队 + outbound entry；发送仍由既有
 * drain 负责。任何失败整体回滚且不消耗开口额度（peek 先行、charge 在事务成功后）。
 * 旧外部弹药分享（ammoId，外部计划 E5）内核源码保留但模型 Schema 已不再暴露：
 * 分享门接线（wireAmmoShareHost）已随弹药管线停用摘除，这条链恒 fail closed。
 * 说明文字与参数 Schema 唯一来自 TOOL.md manifest。
 */
import { defineTool, type ToolRegistration } from "@earendil-works/pi-durable";
import { validateOutbound } from "../../egress/policy.ts";
import { ledgerOf, recordSent } from "../../egress/ledger.ts";
import { ExternalAmmoDoc, ammoVideoUrlOf, applyAmmoClaim } from "../../external/ammo-store.ts";
import { isValidBvid } from "../../external/bili-client.ts";
import { viewedVideoOf, videoBrowseGateOf } from "../../external/video-browse.ts";
import { VideoPoolDoc, applyVideoPoolAdd, videoUrlOf, viewedVideoTitleOf } from "../../external/video-pool.ts";
import { renderTemplate } from "../../prompts.ts";
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
   * 自主浏览视频分享（T4）：本轮用 video 工具实际成功观看过的 BV 号。双重白名单
   * （browse 轮授权 + viewed 登记）都过才放行；同一事务写会话私有池并入队，
   * canonical 链接由宿主拼进 payload，text 只作推荐语。
   */
  videoBvid?: string;
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
      // 素材分享——share: true（承诺/委托）、videoBvid（自主浏览看过的视频，T4）或旧
      // ammoId（已停用内核）都算分享意图；必须在开口计数前（被拒不占额度），answer 轮天然豁免
      assertShareAllowed(deps, api, trigger, args.share, args.ammoId, args.videoBvid);

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

      // 自主浏览视频分享（T4）：与旧 ammo 链同位——全链在出口校验之后、开口计数之前，
      // 任何失败路径都不占额度。双重白名单：① 本轮是带有效 browseWindow/browseTopic 的
      // open injection browse 轮，且宿主门现窗匹配（门已关 / window / topic 不符都拒）；
      // ② BV 在本轮被 video 工具实际成功观看过（viewedVideoOf，宿主 settle 时整份清掉）。
      // 放行后同一 transaction：会话私有池 BV 去重写入 + canonical 链接前缀 + outbound
      // entry + outbox 入队；任一环失败整体回滚（不会出现池写了而消息没入队的裂缝）。
      const videoBvid = String(args.videoBvid ?? "").trim();
      if (videoBvid.length > 0) {
        peekSayRound(String(api.conversationId), round, deps.prompts.messages["say_once"] ?? "already said this round");
        if (!isValidBvid(videoBvid)) {
          throw new Error(deps.prompts.messages["video_bvid_invalid"] ?? "video_bvid_invalid");
        }
        const browseWindow = typeof trigger?.browseWindow === "string" && trigger.browseWindow.length > 0 ? trigger.browseWindow : undefined;
        const browseTopic = typeof trigger?.browseTopic === "string" && trigger.browseTopic.length > 0 ? trigger.browseTopic : undefined;
        const chatKey = deps.chatKeyOf?.(String(api.conversationId));
        const gate = trigger?.kind === "injection" && browseWindow !== undefined && browseTopic !== undefined && chatKey !== undefined
          ? videoBrowseGateOf(chatKey)
          : undefined;
        if (
          browseWindow === undefined ||
          browseTopic === undefined ||
          gate === undefined ||
          !gate.open ||
          gate.windowId !== browseWindow ||
          gate.topic !== browseTopic
        ) {
          throw new Error(deps.prompts.messages["video_share_denied"] ?? "video_share_denied");
        }
        // 实际看过才放行：未观看 / 跨轮 / 轮已 settle（viewed 已清）一律拒
        if (round === undefined || !viewedVideoOf(round).has(videoBvid)) {
          throw new Error(deps.prompts.messages["video_share_not_viewed"] ?? "video_share_not_viewed");
        }
        // canonical 链接宿主拼（模型文本剥 URL 只作推荐语，prefixAmmoLink 同款渲染）；
        // 池条目标题从 video 工具观看时登记的轮内缓存取（拿不到 = 空串，不阻塞分享）
        const finalText = prefixAmmoLink(videoUrlOf(videoBvid), stripOutboundLinks(text));
        const payload: OutboundPayload = { items: [finalText], ...payloadBase };
        await api.commit(async (tx) => {
          const pool = await tx.doc(VideoPoolDoc, api.conversationId);
          // 去重写入：同会话同 BV 已入池 = dup，不改状态不报错（跨会话不互斥，
          // 另一个会话的池是另一份 doc）；链接照发，池不产生重复条目
          applyVideoPoolAdd(
            pool,
            {
              bvid: videoBvid,
              title: viewedVideoTitleOf(round, videoBvid),
              note: stripOutboundLinks(text),
              topic: browseTopic,
            },
            ts,
          );
          await tx.appendEntry(OutboundEntry, api.conversationId, { data: payload });
          const box = await tx.doc(OutboxDoc, api.conversationId);
          box.queue.push({ ...payload, status: "queued", attempts: 0 });
        }, context);
        // 事务成功后才计数（peek 已保证这里不会再抛 say_once）；失败路径在上面 throw，不消耗额度
        chargeSayRound(String(api.conversationId), round, deps.prompts.messages["say_once"] ?? "already said this round");
        recordSent(api.conversationId, [finalText], ts);
        console.log(`[鱼缸] 视频分享 ${videoBvid} 窗 ${browseWindow}`);
        return { output: [{ type: "text", text: deps.prompts.messages["say_sent"] ?? "ok" }] };
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
        // 非 ammo 路径走共享入队（ ammo 路径已在上方事务里入队）
        const payload: OutboundPayload = { items: [outboundText], ...payloadBase };
        await enqueueOutbound(api, payload, context);
      }

      recordSent(api.conversationId, [outboundText], ts);
      return { output: [{ type: "text", text: deps.prompts.messages["say_sent"] ?? "ok" }] };
    },
  });
}
