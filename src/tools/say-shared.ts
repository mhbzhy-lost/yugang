/**
 * say_* 出口工具组的共享底座：出口 payload、轮上下文解析、mentions 机械校验、
 * 每轮开口计数、outbox 入队与表情包挑图。
 *
 * 四个出口工具（say_words / say_media / say_meme / say_voice）共用这里，出口语义只有
 * 一份，不得在各工具里各自漂移。本模块不暴露任何模型可调工具（manifest 扫描只认目录，
 * 平铺 .ts 不构成工具包，参照 fs-shared.ts 先例）。
 *
 * 轮闸：四个工具共享「每轮 3 次调用」额度（轮标识 = LiveDoc 的 run.inputs[0]，与压缩/
 * 引用绑定同源）；任何组合第 4 次以 say_once 拒，无豁免（配图、语音都计数）。计数点在
 * 全部校验通过后、入队前——被拒的尝试不消耗额度。
 */
import { existsSync, readFileSync } from "node:fs";
import { join, resolve, sep } from "node:path";
import { LiveDoc, defineEntry } from "@earendil-works/pi-durable";
import { renderTemplate } from "../prompt/index.ts";
import { isCurfewAt } from "../qq/curfew.ts";
import { OutboxDoc } from "../store.ts";
import type { Rejection } from "../egress/policy.ts";
import type { RoundKind, RoundTrigger, ToolPackageDeps } from "./types.ts";

export interface OutboundPayload {
  /** 按顺序发出的几条文本。 */
  items: string[];
  media?: string;
  /** 语音文件（相对 mediaRoot），与 media 互斥。 */
  voice?: string;
  /** 是否引用（quoteMsgId 命中窗口 / 旧 quote:true 兼容时置位；emit 层四条件之一）。 */
  quote: boolean;
  /** 主动 @ 的 QQ 号（已去重的纯数字，出口层验过身份与群成员）；只挂在第一条文本（或唯一一条附件消息）上。 */
  mentions?: string[];
  at: number;
  /** 幂等键：重放时用同一个，发送侧据此去重。 */
  key: string;
  /** 引用目标的消息 id：缺省钉在本轮触发消息上（宿主 submit 时绑定，引用不串到别人的
   *  消息）；quoteMsgId 命中本轮窗口时是模型点名的窗口消息 id。 */
  quoteId?: number | string;
  /** 本轮触发是否@了鱼：被@必引用，出口层兜底。 */
  quoteForce?: boolean;
}

export const OutboundEntry = defineEntry<OutboundPayload>("fish.outbound");

/** defineTool execute 里共享 helper 需要的最小 api 形状（LiveDoc 快照 + 事务提交）。 */
export interface SayApi {
  conversationId: string;
  callId: string;
  snapshot: (doc: unknown, id: string, context: unknown) => Promise<unknown>;
  commit: (change: (tx: SayTx) => Promise<void>, context: unknown) => Promise<unknown>;
}

/** enqueueOutbound 的 commit 事务形状（appendEntry + OutboxDoc）。 */
export interface SayTx {
  appendEntry: (entry: unknown, id: string, payload: { data: OutboundPayload }) => Promise<unknown>;
  doc: (doc: unknown, id: string) => Promise<{ queue: OutboundPayload[] }>;
}

/** 一轮的出口上下文：轮标识与钉在它上面的触发消息（含轮类型与 quoteMsgId 窗口）。 */
export interface SayRound {
  /** LiveDoc 的 run.inputs[0]；拿不到轮标识时为 undefined（计数与引用绑定都跳过）。 */
  round: unknown;
  /** 本轮触发消息：主动 @ 的身份闸、轮类型与引用窗口都钉在它上面。 */
  trigger: RoundTrigger | undefined;
}

/**
 * 解析本轮出口上下文：snapshot 取轮标识 → onSayCall 回调（成败都算一次开口）→
 * 静默轮（自动收表情包）拒绝 → triggerOf 取触发消息 → worker 轮拒绝（逛轮禁言）。
 */
export async function resolveSayContext(api: SayApi, deps: ToolPackageDeps, context: unknown): Promise<SayRound> {
  // 静默轮（自动收表情包）只允许调工具，不许冒话
  const live = (await api.snapshot(LiveDoc, api.conversationId, context)) as
    | { run?: { inputs?: unknown[] } }
    | undefined;
  const round = live?.run?.inputs?.[0];
  // 出口计数：进了 execute 就算模型开了口（成败都算一次），宿主据此识别「零出口轮」。
  // 未登记的轮（如收图轮）由宿主回调自行忽略，不产生孤儿计数；只加计数，不改校验与出口语义。
  if (round !== undefined) deps.onSayCall?.(round);
  if (round !== undefined && deps.silentOf?.(round)) {
    throw new Error(deps.prompts.messages["say_silent"] ?? "say_silent");
  }
  const trigger = round !== undefined ? deps.triggerOf?.(round) : undefined;
  // worker 轮（弹药逛轮，外部计划 E4）：后台作业不是聊天，say_* 一律机械拒绝——
  // 模型只能用 ammo_submit 提交结构化候选，出口零开放（复用收图轮同款的轮闸思路）
  if (trigger?.kind === "worker") {
    throw new Error(deps.prompts.messages["say_worker_round"] ?? "say_worker_round");
  }
  return { round, trigger };
}

/**
 * 主动 @ 的机械校验：去重 → 禁 all/非数字 → 身份闸（按轮类型）→ 群成员核对，任何一环缺失都
 * fail closed（文案来自 prompt/messages.md）。语音工具没有 mentions 参数，不经过这里。
 */
export async function assertMentions(
  deps: ToolPackageDeps,
  api: SayApi,
  trigger: SayRound["trigger"],
  mentions: readonly string[],
): Promise<void> {
  const list = [...new Set(mentions.map((qq) => qq.trim()))];
  if (list.length === 0) return;
  if (list.includes("all")) throw new Error(deps.prompts.messages["say_mention_all"] ?? "say_mention_all");
  if (list.some((qq) => !/^\d+$/.test(qq))) {
    throw new Error(deps.prompts.messages["say_mention_bad"] ?? "say_mention_bad");
  }
  if (list.length > 3) throw new Error(deps.prompts.messages["say_mention_too_many"] ?? "say_mention_too_many");
  if (trigger === undefined) throw new Error(deps.prompts.messages["say_mention_no_trigger"] ?? "say_mention_no_trigger");
  const kind: RoundKind = trigger.kind ?? "answer";
  // 身份闸按轮类型（决策 7）：answer/legacy 看触发者（被点名才可 @，语义零变化）；
  // ambient/injection 环境轮没有锚点身份（injection 连 messageId 都没有），改为对每个
  // @ 目标各过一次白名单（{主人} ∪ 本群 watched，宿主实现并记审计）——按轮类型放行而非拒绝
  const ensureAllowed = (userId: number | undefined) => {
    const policy = deps.mentionPolicyOf?.(String(api.conversationId), userId, kind);
    if (policy === "not_group") throw new Error(deps.prompts.messages["say_mention_private"] ?? "say_mention_private");
    if (policy !== "allow") {
      throw new Error(deps.prompts.messages["say_mention_not_privileged"] ?? "say_mention_not_privileged");
    }
  };
  if (kind === "ambient" || kind === "injection") {
    for (const qq of list) ensureAllowed(Number(qq));
  } else {
    ensureAllowed(trigger.userId);
  }
  // 群成员名单核对照旧（两个分支共用；拿不到名单拒）
  const members = deps.membersOf ? await deps.membersOf(String(api.conversationId)) : undefined;
  if (!members || members.length === 0) {
    throw new Error(deps.prompts.messages["say_mention_members_missing"] ?? "say_mention_members_missing");
  }
  const known = new Set(members.map((member) => member.userId));
  const missing = list.filter((qq) => !known.has(qq));
  if (missing.length > 0) {
    throw new Error(renderTemplate(deps.prompts.messages["say_mention_not_member"] ?? "", { userIds: missing.join("、") }));
  }
}

/**
 * 末条自言禁言（决策 24）的工具侧依赖形状：在 ToolPackageDeps 之上补一个宿主回调。
 * 字段的运行时接线在宿主（src/index.ts 维护标记，经 harness 的 packageDeps 下发）；
 * 类型声明就地放在这里而不动 src/tools/types.ts，运行时形状与字段直接落在
 * ToolPackageDeps 完全一致（宿主侧用条件展开传入，与既有可选回调同一套惯用法）。
 */
export type SelfMuteDeps = ToolPackageDeps & {
  /** conversationId → 该会话（chatKey 级）最新一条消息是否鱼自己发的；缺省 = 否。 */
  lastWasFishOf?: (conversationId: string) => boolean;
};

/**
 * 末条自言禁言的机械校验（决策 24，T15）：群里最新一条消息是鱼自己发的（lastWasFish）时，
 * ambient/injection 轮未声明分享的出口一律 tool 错误拒绝——分享意图认 share: true
 * （兑现承诺/交付委托结果）与旧 ammoId（旧弹药内核已停用、兼容保留）。
 * 2026-11-05 起没有 videoBvid 这种专用声明：分享视频就是普通文本带一个本轮见过的链接，
 * 声不声明为素材分享由 share 决定，so 普通文字不能靠「带个 URL」绕过禁言。
 * answer 轮天然豁免（有人 @ 必有入站，标记已翻 false），trigger 拿不到时
 * 同样豁免；lastWasFishOf 未接线时缺省放行（宁松勿严）。调用点必须在 chargeSayRound
 * 之前：被拒的尝试不占开口额度；既有 @/quote/额度校验不受影响。
 */
export function assertShareAllowed(deps: SelfMuteDeps, api: SayApi, trigger: SayRound["trigger"], share: unknown, ammoId?: unknown): void {
  const kind: RoundKind = trigger?.kind ?? "answer";
  if (kind === "answer") return;
  if (share === true) return;
  if (typeof ammoId === "string" && ammoId.trim().length > 0) return;
  if (deps.lastWasFishOf?.(String(api.conversationId)) !== true) return;
  throw new Error(deps.prompts.messages["say_self_mute"] ?? "say_self_mute");
}

/**
 * 模型侧引用参数解析（决策 6，say_words/say_media/say_meme 共用；say_voice 不走这里）：
 * - quoteMsgId（接受 [m:123] 或裸数字，机械剥掉包装）属本轮 quoteIds 窗口 → 有效：返回该 id
 *   并等效 quote=true（防 emit 层四条件静默丢弃）；
 * - 不在窗口（含拿不到窗口）→ quote_msg_invalid tool 错误；调用方须在 chargeSayRound 之前
 *   调用本函数，被拒的尝试不占开口额度；
 * - 缺省不传 = 不引用：quoteId 仍钉在本轮锚点上（机械必答引用链照旧消费它），现行为不变；
 * - 旧 quote:true 字段 schema 已移除、运行时容忍：模型若仍输出，按「引用本轮锚点」处理，
 *   行为与 legacy 一致，不报错不忽略；机械必答引用（quoteForce/@ 必答）不受模型参数影响。
 */
export function resolveQuoteArg(
  deps: ToolPackageDeps,
  trigger: SayRound["trigger"],
  quoteMsgId: unknown,
  legacyQuote: unknown,
): { quote: boolean; quoteId?: number | string } {
  const raw = (typeof quoteMsgId === "string" ? quoteMsgId : quoteMsgId == null ? "" : String(quoteMsgId)).trim();
  const id = raw.startsWith("[m:") && raw.endsWith("]") ? raw.slice(3, -1).trim() : raw;
  if (id.length > 0) {
    if (trigger?.quoteIds?.has(id)) return { quote: true, quoteId: id };
    throw new Error(deps.prompts.messages["quote_msg_invalid"] ?? "quote_msg_invalid");
  }
  const anchor = trigger?.messageId;
  if (legacyQuote === true && anchor !== undefined) return { quote: true, quoteId: anchor };
  return { quote: false, ...(anchor !== undefined ? { quoteId: anchor } : {}) };
}

/** 出口校验拒绝 → 以 tool 错误返回给模型（不静默丢弃），文案渲染自 prompt/messages.md。 */
export function throwSayRejection(messages: Record<string, string>, rejection: Rejection): never {
  const template = messages[rejection.code];
  if (!template) throw new Error(`prompt/messages.md 缺少文案：${rejection.code}`);
  const text = renderTemplate(template, rejection.vars ?? {});
  const which = rejection.index === undefined ? "" : `（第 ${rejection.index + 1} 条）`;
  throw new Error(`${which}${text}`);
}

/**
 * text 参数的机械规整：模型偶发把单条文本按旧 messages 习惯包成数组——
 * 字符串化的 JSON 数组（"["…"]"）或真数组都可能出现，两者都解包；
 * 多元素按语音同款用「，」连成一条（text 语义就是一条消息）。
 */
export function normalizeTextInput(raw: unknown): string {
  if (Array.isArray(raw)) {
    return raw.map((item) => (typeof item === "string" ? item : String(item)).trim()).filter(Boolean).join("，");
  }
  const t = typeof raw === "string" ? raw.trim() : String(raw ?? "").trim();
  if (t.startsWith("[") && t.endsWith("]")) {
    try {
      const parsed = JSON.parse(t) as unknown;
      if (Array.isArray(parsed) && parsed.length > 0 && parsed.every((item) => typeof item === "string")) {
        return parsed.map((item) => item.trim()).filter(Boolean).join("，");
      }
    } catch {
      // 不是 JSON 数组字面量：按普通文本放行
    }
  }
  return t;
}

// 轮计数：会话 → { 轮标识, 已开口次数 }（pi.live.run 的 inputs[0]，一次 agent loop 一个）。
// 四个 say_* 工具共享这一份（模块级），任何组合都吃同一个额度。上限 3 次只是闸门：
// 不鼓励多说，一句能说完的事别拆三条（人格书仍这么引导）。轮标识由 pi-durable 自己维护，
// 执行时现读，不需要外部重置信号；只在内存，重启丢一次不致命。
const saidIn = new Map<string, { round: unknown; count: number }>();

/**
 * 每轮开口计数：校验通过、真要开口前才调用——被拒绝的尝试不消耗机会，
 * 模型在同一轮里改口重说的设计得以保留。判定与记录同步，并发第二个也拦得住。
 * 轮标识用 run.inputs[0]（本轮要 settle 的输入任务）：整轮跨 generation 不变；
 * run.taskId 每代都会换，不能用。轮结束后 run 整个移除，下一轮自然换新标识。
 */
export function chargeSayRound(conversationId: string, round: unknown, onceMessage: string, max = 3): void {
  if (round === undefined) return;
  const said = saidIn.get(conversationId);
  if (said?.round === round && said.count >= max) throw new Error(onceMessage);
  saidIn.set(conversationId, { round, count: said?.round === round ? said.count + 1 : 1 });
}

/**
 * 额度 peek（E5 外部弹药链路专用）：判定口径与 chargeSayRound 完全一致但**不记账**——
 * claim 前先问「这次开口会不会超」，超额先拒，避免 claim 成功后 chargeSayRound 再抛
 * say_once 把条目卡在 claimed（只能等 TTL）。单轮内工具调用顺序执行，peek 过了 charge
 * 就不会再抛；未登记的轮（round undefined）与 charge 同口径直接放行。
 */
export function peekSayRound(conversationId: string, round: unknown, onceMessage: string, max = 3): void {
  if (round === undefined) return;
  const said = saidIn.get(conversationId);
  if (said?.round === round && said.count >= max) throw new Error(onceMessage);
}

// ── 外部弹药分享（外部计划 E5，决策 9）：门适配 / 宵禁 / URL 宿主渲染 ──────────

/**
 * 宿主门适配器：engage-next 的开窗相位（windowId + 随机门）与出口层在这里接线。
 * 宿主（src/index.ts）起好状态机后调 wireAmmoShareHost 注册；出口层经 ammoShareGateOf
 * 读取（bili-client 单例同款先例）。未注册 = 门恒关（fail closed，claim 一律拒）。
 */
export interface AmmoShareGate {
  windowId: string;
  open: boolean;
}

export interface AmmoShareHost {
  /** chatKey → 当前 open 窗的分享门；closed / 未跟踪 = undefined。 */
  gateOf: (chatKey: string) => AmmoShareGate | undefined;
}

let ammoShareHost: AmmoShareHost | undefined;

/** 宿主启动时注册门适配器（可替换：内联验证 / 热切换）。 */
export function wireAmmoShareHost(host: AmmoShareHost): void {
  ammoShareHost = host;
}

/** 出口层读宿主门：未注册 / 非开窗 = undefined（门没开）。 */
export function ammoShareGateOf(chatKey: string): AmmoShareGate | undefined {
  return ammoShareHost?.gateOf(chatKey);
}

/** claim 时刻的宵禁（与 engage footer 二态同阈）：本地 00:00–08:00 门恒关，同窗白天门开着也不发。
 *  实现已收到 `src/qq/curfew.ts` 的 `isCurfewAt`（browse 门同源），这里保留旧名给已停用的弹药链。 */
export function ammoCurfewAt(nowMs: number): boolean {
  return isCurfewAt(nowMs);
}

/**
 * 模型文本链接剥离：canonical 链接一律由宿主从 doc 渲染（P0-5），模型文本只作推荐语——
 * 模型自己写的 http(s) 链接全部剥掉（防与宿主前缀重复、防绕过渲染源）。剥完连续空白
 * 折成一个空格再收边。
 */
export function stripOutboundLinks(text: string): string {
  return text.replace(/https?:\/\/\S+/g, " ").replace(/\s+/g, " ").trim();
}

/** 宿主前缀 canonical 链接：链接 + 一个空格 + 推荐语（推荐语剥空 = 只发链接）。 */
export function prefixAmmoLink(url: string, text: string): string {
  return text.length > 0 ? url + " " + text : url;
}

/**
 * 待发弹药记账（外部计划 E5，决策 9）：claim 成功后按 payload key 登记在内存，宿主
 * emit 实发成功后 takeAmmoShare 取走并 markShared（applyAmmoShared）。
 * 不走 payload 字段：harness.drain 逐字段重建 payload，未声明字段会被丢弃；key 是
 * 必透传字段，用它当登记键语义等价且不动 harness。
 * 崩溃窗口：登记丢失 → 条目滞留 claimed，TTL 惰性清理兜底（与 claim 后进程死的
 * 取舍一致，宁少分享不重发）。
 */
const pendingAmmoShares = new Map<string, { id: string; windowId: string }>();

/** claim 成功、入队前登记（key 重复覆盖，emit 重放不会重复消费）。 */
export function registerAmmoShare(key: string, ammo: { id: string; windowId: string }): void {
  // 防泄漏：未发送场景（过期丢弃）的残留登记超过 100 条时丢最老的（实际在途远小于此）
  while (pendingAmmoShares.size >= 100) {
    const oldest = pendingAmmoShares.keys().next().value;
    if (oldest === undefined) break;
    pendingAmmoShares.delete(oldest);
  }
  pendingAmmoShares.set(key, ammo);
}

/** 宿主 emit 实发成功后取走记账（取走即删：幂等重放不重复置位）；无登记返回 undefined。 */
export function takeAmmoShare(key: string): { id: string; windowId: string } | undefined {
  const ammo = pendingAmmoShares.get(key);
  pendingAmmoShares.delete(key);
  return ammo;
}

/** 把 payload 落进 outbox（和 transcript entry 同一次提交）：宿主崩了也不会丢，重启后接着发。 */
export async function enqueueOutbound(api: SayApi, payload: OutboundPayload, context: unknown): Promise<void> {
  await api.commit(async (tx) => {
    await tx.appendEntry(OutboundEntry, api.conversationId, { data: payload });
    const box = await tx.doc(OutboxDoc, api.conversationId);
    box.queue.push({ ...payload, status: "queued", attempts: 0 });
  }, context);
}

/** meme-inbox/ 是否包含这个媒体引用：本地待收目录不是出口的图源（必须先 look + meme_add 进库）。 */
export function inMemeInbox(mediaRoot: string, ref: string): boolean {
  const root = resolve(mediaRoot);
  const inboxDir = join(root, "meme-inbox");
  const full = resolve(root, ref);
  return full === inboxDir || full.startsWith(inboxDir + sep);
}

/** 从库里挑一张最贴关键词的（命中权重与 meme 工具一致），并列时随机，避免每次同图。 */
export function pickMeme(mediaRoot: string, keyword: string): string | undefined {
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
