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
import { renderTemplate } from "../prompts.ts";
import { OutboxDoc } from "../store.ts";
import type { Rejection } from "../egress/policy.ts";
import type { ToolPackageDeps } from "./types.ts";

export interface OutboundPayload {
  /** 按顺序发出的几条文本。 */
  items: string[];
  media?: string;
  /** 语音文件（相对 mediaRoot），与 media 互斥。 */
  voice?: string;
  /** 是否引用触发这一轮的那条消息。 */
  quote: boolean;
  /** 主动 @ 的 QQ 号（已去重的纯数字，出口层验过身份与群成员）；只挂在第一条文本（或唯一一条附件消息）上。 */
  mentions?: string[];
  at: number;
  /** 幂等键：重放时用同一个，发送侧据此去重。 */
  key: string;
  /** 本轮触发消息的 id（由宿主在 submit 时绑定），引用不再串到别人的消息。 */
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

/** 一轮的出口上下文：轮标识与钉在它上面的触发消息。 */
export interface SayRound {
  /** LiveDoc 的 run.inputs[0]；拿不到轮标识时为 undefined（计数与引用绑定都跳过）。 */
  round: unknown;
  /** 本轮触发消息：主动 @ 的身份闸和引用目标都钉在它上面。 */
  trigger: { messageId?: number | string; mentionsBot: boolean; userId?: number } | undefined;
}

/**
 * 解析本轮出口上下文：snapshot 取轮标识 → onSayCall 回调（成败都算一次开口）→
 * 静默轮（自动收表情包）拒绝 → triggerOf 取触发消息。
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
  return { round, trigger };
}

/**
 * 主动 @ 的机械校验：去重 → 禁 all/非数字 → 身份闸 → 群成员核对，任何一环缺失都
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
  const missing = list.filter((qq) => !known.has(qq));
  if (missing.length > 0) {
    throw new Error(renderTemplate(deps.prompts.messages["say_mention_not_member"] ?? "", { userIds: missing.join("、") }));
  }
}

/** 出口校验拒绝 → 以 tool 错误返回给模型（不静默丢弃），文案渲染自 prompt/messages.md。 */
export function throwSayRejection(messages: Record<string, string>, rejection: Rejection): never {
  const template = messages[rejection.code];
  if (!template) throw new Error(`prompt/messages.md 缺少文案：${rejection.code}`);
  const text = renderTemplate(template, rejection.vars ?? {});
  const which = rejection.index === undefined ? "" : `（第 ${rejection.index + 1} 条）`;
  throw new Error(`${which}${text}`);
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
