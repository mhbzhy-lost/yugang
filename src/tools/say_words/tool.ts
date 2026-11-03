/**
 * say_words 工具包 —— 文字出口。
 *
 * 一次调用 = 一条消息（text 单条字符串）。mentions 校验、出口校验、每轮开口计数与
 * 入队全部走 say-shared.ts 的共享实现，这里只做参数面的窄适配。
 * 外部弹药分享（外部计划 E5，决策 9）：ammoId 参数触发机械校验链（门开 ∧ available ∧
 * 本窗未消费 ∧ 非宵禁 → 原子 claim），canonical 链接由宿主从 doc 渲染前缀进 payload，
 * 模型文本只作推荐语；发送成功置 shared 的接线在宿主 emit（payload.ammo 记账）。
 * 说明文字与参数 Schema 唯一来自 TOOL.md manifest。
 */
import { defineTool, type ToolRegistration } from "@earendil-works/pi-durable";
import { validateOutbound } from "../../egress/policy.ts";
import { ledgerOf, recordSent } from "../../egress/ledger.ts";
import { ExternalAmmoDoc, ammoVideoUrlOf, applyAmmoClaim } from "../../external/ammo-store.ts";
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
   * 外部弹药编号（外部计划 E5）：开窗弹药栏里给的 ammoId。门开 ∧ item available ∧
   * 本窗未消费 ∧ 非宵禁才放行（失败不占开口额度）；每窗最多一条；链接由系统自动
   * 附上，text 只写推荐语。
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
      // 素材分享——share: true（承诺/委托）或 ammoId（外部弹药）都算分享意图；必须在
      // 开口计数前（被拒不占额度），answer 轮天然豁免
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

      // 外部弹药分享（E5）：全链在出口校验之后、开口计数之前——任何失败路径都不占额度。
      // 额度 peek 先行：claim 成功后 chargeSayRound 才不会再抛 say_once（避免条目卡在 claimed）
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
