/** 可导入的轮级输入拼装入口：index.ts 与权威模板机械测试共用，无副作用。 */
import { orderByArrival, type IncomingMessage } from "./onebot.ts";
import type { BurstMessage, RecentChatMessage } from "../../qq/debounce.ts";
import { renderForwardAttachment, renderMessageList, renderQuotedOriginal, type ForwardAttachment, type MessageTable, type ModelMessage, type QuotedMessage } from "./model-input.ts";

export interface OpenMessage {
  messageId?: number | string;
  userId: number;
  nickname: string;
  text: string;
  /** 这一条在回复谁（渲染 [回复了m:id]）；批内与 injection 共用，缺省空。 */
  replyIds?: readonly string[];
  /** 被引消息的结构化原文（列表后附 [引用原文]）；批内与 injection 共用，缺省无。 */
  quoted?: QuotedMessage;
  /** 这条 @ 的其他人（不含 @鱼/@全体）：渲染「接收对象是…，不是你」。 */
  mentionTargets?: readonly string[];
}

/** 批内引用原文附加段：把各条 quoted 用 @ 轮同款渲染器渲染成 `[引用原文]` 行，按 id 去重；
 *  inline 开启时传编号表（vision==main 时引用图同样走 base64 直读，不再留给 look 转述），
 *  关闭时缺省——被引图保持 `[图片 inbound/…]` 交给 look。 */
export function renderOpenQuotedText(
  items: readonly OpenMessage[],
  messages: MessageTable,
  imageNumbers?: ReadonlyMap<string, number>,
  gifFrames?: ReadonlyMap<string, number>,
): string {
  const seen = new Set<string>();
  const lines: string[] = [];
  for (const item of items) {
    if (!item.quoted) continue;
    const id = String(item.quoted.id);
    if (seen.has(id)) continue;
    seen.add(id);
    lines.push(renderQuotedOriginal(item.quoted, messages, imageNumbers, gifFrames));
  }
  return lines.join("\n");
}

/** 背景记账只留合集短标记，展开内容不进入背景。 */
export function backgroundTextOf(msg: IncomingMessage, messages: MessageTable): string {
  const marker = messages["forward_collapsed"] ?? "";
  if ((msg.forward !== undefined || (msg.forwardIds?.length ?? 0) > 0) && marker.length > 0) return marker;
  if (!/\[转发合集 \d+ 条\]/.test(msg.text)) return msg.text;
  return marker.length > 0 ? marker : "[收集]";
}

/** injection 与 shard 共用同一标准群消息列表；调用方保证 items 已是真实接收顺序。 */
export function renderOpenMessageList(
  items: readonly OpenMessage[],
  messages: MessageTable,
  masterOf: (userId: number) => boolean,
  watchedOf: (userId: number) => boolean,
): string {
  const models: ModelMessage[] = items.map((item) => ({
    ...(item.messageId !== undefined ? { messageId: item.messageId } : {}),
    userId: String(item.userId),
    nickname: item.nickname,
    text: item.text,
    mentionsBot: false,
    replyIds: item.replyIds ?? [],
    master: masterOf(item.userId),
    watched: watchedOf(item.userId),
    ...(item.mentionTargets !== undefined ? { mentionTargets: item.mentionTargets } : {}),
    // quoted 只用于「接收对象」标签（引用原文由 renderOpenQuotedText 在列表后另渲染）：
    // 行内不重复输出被引内容，只借 nickname / fromSelf 判断这句话是不是在回鱼
    ...(item.quoted !== undefined ? { quoted: item.quoted } : {}),
  }));
  return renderMessageList(models, messages, "group");
}

/** 零新增主动交流机会固定模板。 */
export function renderBrowseOpportunity(messages: MessageTable): string {
  return [
    messages["ctx_browse_active_header"] ?? "",
    messages["ctx_browse_active_line"] ?? "",
    "",
    messages["ctx_browse_actions_header"] ?? "",
    messages["ctx_browse_actions_line"] ?? "",
  ].join("\n");
}

/** answer 列表后的附加段统一顺序：最近合集 → 压缩图标签 → look 提示。 */
export function assembleRoundContent(
  base: string,
  options: {
    recentForward?: ForwardAttachment;
    tags?: readonly string[];
    lookHint?: boolean;
  },
  messages: MessageTable,
): string {
  const sections = [base];
  if (options.recentForward) sections.push(renderForwardAttachment(options.recentForward, messages));
  if ((options.tags?.length ?? 0) > 0) sections.push((options.tags ?? []).join("\n"));
  if (options.lookHint) sections.push(messages["image_look_hint"] ?? "");
  return sections.filter((section) => section.length > 0).join("\n\n");
}

export interface RoundContentBlock { type: "text" | "image"; text?: string; data?: string; mimeType?: string }

/** submitRound 的唯一 content 形状：一个 text block 在前，压缩 image blocks 在后。 */
export function submitContentOf(content: string, imageBlocks: readonly { type: "image"; data: string; mimeType: string }[]): string | RoundContentBlock[] {
  return imageBlocks.length > 0 ? [{ type: "text", text: content }, ...imageBlocks] : content;
}

/** 附加段之间统一空一行（语音提示、answer 轮规范段共用这条拼装）。 */
export function appendVoiceHint(content: string, hint: string): string {
  return hint.length > 0 ? `${content}\n\n${hint}` : content;
}

/**
 * answer 轮的规范段（目前是 `video_answer_rule`：没被要求看视频就别看）。
 *
 * 放在这里而不是 `src/index.ts`：宿主与权威模板测试必须走同一段拼装，否则测试会
 * 在「多一段 / 少一段」时仍然全绿（2026-11-05 就是这么发现的）。顺序按数组顺序
 * 依次追加，每段之间空一行。
 */
export function appendAnswerRules(content: string, rules: readonly string[]): string {
  let out = content;
  for (const rule of rules) out = appendVoiceHint(out, rule);
  return out;
}

// —— 以下自 src/qq/debounce.ts 迁入（2026-11-13 通道适配器 T2）：背景板与整组的上下文拼装 ——
/** 锚点在流水里的位置：优先到达序号，其次消息 id，最后同人同名的最后一条。 */
function anchorIndex(anchor: IncomingMessage, bucket: readonly RecentChatMessage[]): number {
  if (anchor.arrivalSeq !== undefined) {
    const bySeq = bucket.findIndex((m) => m.arrivalSeq === anchor.arrivalSeq);
    if (bySeq >= 0) return bySeq;
  }
  if (anchor.messageId !== undefined) {
    const id = String(anchor.messageId);
    const byId = bucket.findIndex((m) => m.messageId !== undefined && String(m.messageId) === id);
    if (byId >= 0) return byId;
  }
  // 旧流水没有序号也没有 id：沿用 bucket 顺序，取这个人最后一条的位置
  for (let index = bucket.length - 1; index >= 0; index -= 1) {
    if (bucket[index].userId === anchor.userId) return index;
  }
  return bucket.length;
}

/** 判断一条流水是不是已经在这组连续发言里：有 id/序号就精确，都没有才按「同人同话」。 */
function burstMatcher(burst: readonly BurstMessage[]): (line: RecentChatMessage) => boolean {
  const ids = new Set<string>();
  const seqs = new Set<number>();
  const loose = new Set<string>();
  for (const message of burst) {
    if (message.messageId !== undefined) ids.add(String(message.messageId));
    if (message.arrivalSeq !== undefined) seqs.add(message.arrivalSeq);
    loose.add(`${message.userId}\u0000${message.text}`);
  }
  // 旧流水（fixture / 外部构造）既没 id 也没序号，只能按「同人同话」回退；
  // 有 id 或序号时绝不能走这条路：同一个人在不同时刻说同一句话是两件事，loose 会把真背景误删。
  const legacyOnly = ids.size === 0 && seqs.size === 0;
  return (line) => {
    if (line.messageId !== undefined) {
      if (ids.has(String(line.messageId))) return true;
      return false;
    }
    if (line.arrivalSeq !== undefined) return seqs.has(line.arrivalSeq);
    return legacyOnly && loose.has(`${line.userId}\u0000${line.text}`);
  };
}

/**
 * 锚点之前最多 `limit` 条群消息，按流水顺序（已经按 arrivalSeq 排好），撇掉整组自己。
 *
 * 背景优先按「收到序号小于锚点」取，而不是先在 recent 里找到锚点再切：锚点可能已经被
 * 30 条 recent 裁掉（群里刷屏），那时不能拿整张流水当背景——那全是锚点之后的话，
 * 模型会把后续对话当成「刚才说的」。只有旧流水没有序号时才按 bucket 位置回退。
 */
export function backgroundFor(
  anchor: IncomingMessage,
  bucket: readonly RecentChatMessage[],
  burst: readonly BurstMessage[],
  limit?: number,
): RecentChatMessage[] {
  const candidates =
    anchor.arrivalSeq !== undefined && bucket.some((line) => line.arrivalSeq !== undefined)
      ? bucket.filter((line) => line.arrivalSeq !== undefined && line.arrivalSeq < (anchor.arrivalSeq as number))
      : bucket.slice(0, Math.max(0, anchorIndex(anchor, bucket)));
  const inBurst = burstMatcher(burst);
  const filtered = candidates.filter((line) => !inBurst(line));
  return limit === undefined ? filtered : filtered.slice(-limit);
}

/**
 * 整组里最近一条非空载荷（bypass 段）：它可能落在中间（画图指令后面又跟了两句普通闲聊），
 * 只取最后一条会当成没有指令，整个 draw 就静默失效了。
 */
export function lastPayload(burst: readonly BurstMessage[]): { stash: string; pstash?: string } | string | undefined {
  for (let index = burst.length - 1; index >= 0; index -= 1) {
    const payload = burst[index].payload;
    if (payload !== undefined && (typeof payload === "string" ? payload.length > 0 : payload.stash.length > 0)) return payload;
  }
  return undefined;
}

export interface ContextOptions {
  /** 主人 QQ：命中的行打 [主人] 标签（与 [特别关注] 互斥，master 优先）。 */
  master: string;
  /** prompt/messages.md 的文案表：所有可见文案从这里来。 */
  messages: MessageTable;
  /** 背景板条数上限：undefined = 不限（全量未读，@ 轮缺省）；数值 = 取最近 N 条再剔已读。 */
  backgroundLimit?: number;
  /** 已读标记（决策 20）：背景板先取上限再剔除 arrivalSeq ≤ 它的行（已进过模型的不重复注入）；缺省不去重。 */
  seenSeq?: number;
  /** 特别关注判定（宿主现读 watchedByChat）：命中的行打 [特别关注] 标签（[主人] 行不重复打）。 */
  watched?: (userId: number | string) => boolean;
  /** inline 附图编号表（planRoundImages 的 numbers）：引用原文里的图命中就渲染成 [图片#N]。 */
  imageNumbers?: ReadonlyMap<string, number>;
  /** GIF 路径 → 帧数（与 imageNumbers 配套，引用原文里渲染「·动图N帧」）。 */
  gifFrames?: ReadonlyMap<string, number>;
}

/**
 * 一条进了本轮模型输入的消息锚点（渲染处现算、不另存）：counted entry 渲染行的 [m:id]
 * 前缀契约结构，T4 的 quoteIds 窗口与 T12 的逐字引用校验都认它。
 */
export interface SeenMessage {
  messageId?: number | string;
  arrivalSeq?: number;
  at?: number;
  author: string;
  text: string;
}

/** withContext 的产物：本轮 user 文本 + 现算的注入窗口锚点集（宿主据此登记 quoteIds）。 */
export interface RoundContext {
  content: string;
  /** 本轮注入窗口（背景 + 整组 + 锚点）的消息锚点。 */
  seen: SeenMessage[];
}

/** 锚点结构现算：id / 序号 / 时间缺什么就不带什么，不另存。 */
function seenOf(line: { messageId?: number | string; arrivalSeq?: number; at?: number; nickname: string; text: string }): SeenMessage {
  return {
    ...(line.messageId !== undefined ? { messageId: line.messageId } : {}),
    ...(line.arrivalSeq !== undefined ? { arrivalSeq: line.arrivalSeq } : {}),
    ...(line.at !== undefined ? { at: line.at } : {}),
    author: line.nickname,
    text: line.text,
  };
}

/** 合并排序槽：背景与整组按真实到达顺序进同一个消息列表（orderByArrival 只动有序号的槽）。 */
interface ListSlot {
  arrivalSeq?: number;
  model: ModelMessage;
  seen: SeenMessage;
}

/**
 * 这一轮的 user 文本（decisions §2–§5 标准群消息模板）：背景 + 整组合并成
 * **一个**消息列表，严格按真实接收顺序排列（A-B-A 里 B 留在原位，当前消息留在
 * 真实时间线位置，不为「锚点」重排或特殊渲染）；标签（[m:id][回复了][转发合集]
 * [@了你][主人]/[特别关注]）由 renderMessageLine 机械拼装。引用原文与合集附件是
 * 列表后的附加段（先引用原文、再合集附件；最近合集补展开与图片段由宿主接在
 * 后面），不参与时间线排序。背景先取上限 N 再剔除已进过模型的（seenSeq）；
 * 锚点集（seen）随返回值现算，宿主据此登记 quoteIds，顺序与渲染顺序一致。
 */
export function withContext(
  anchor: IncomingMessage,
  bucket: readonly RecentChatMessage[],
  burst: readonly BurstMessage[],
  options: ContextOptions,
): RoundContext {
  const messages = options.messages;
  const masterOf = (userId: number | string): boolean =>
    options.master.length > 0 && String(userId) === options.master;
  const watchedOf = (userId: number | string): boolean =>
    !masterOf(userId) && options.watched?.(userId) === true;

  if (!anchor.chatKey.startsWith("qq:group:")) {
    // 私聊边界（decisions §5.3）：独立开场、只注入当前消息，不展示背景；
    // 引用原文与合集附件照旧后置。
    const model: ModelMessage = {
      ...(anchor.messageId !== undefined ? { messageId: anchor.messageId } : {}),
      userId: String(anchor.userId),
      nickname: anchor.nickname,
      text: anchor.text,
      mentionsBot: false,
      replyIds: [],
      master: masterOf(anchor.userId),
      watched: false,
      ...(anchor.mentionTargets !== undefined ? { mentionTargets: anchor.mentionTargets } : {}),
      ...(anchor.quoted ? { quoted: anchor.quoted } : {}),
      ...(anchor.forward ? { forward: anchor.forward } : {}),
    };
    const parts = [renderMessageList([model], messages, "private")];
    if (model.quoted) parts.push(renderQuotedOriginal(model.quoted, messages, options.imageNumbers, options.gifFrames));
    if (model.forward) parts.push(renderForwardAttachment(model.forward, messages));
    if (model.quoted?.forward) parts.push(renderForwardAttachment(model.quoted.forward, messages));
    return { content: parts.join("\n\n"), seen: [seenOf(anchor)] };
  }

  // 背景板（2026-11-06 合并）：answer 轮缺省全量（backgroundLimit 不传 = 不截），
  // answerContextSize 设了才取最近 N 条；先取条数再剔除已进过模型的（arrivalSeq ≤ seenSeq；
  // 旧流水没有序号的没法判已读，保守保留）。不传 seenSeq = 整段不去重。
  let background = backgroundFor(anchor, bucket, burst, options.backgroundLimit);
  if (options.seenSeq !== undefined) {
    const seenSeq = options.seenSeq;
    background = background.filter((line) => line.arrivalSeq === undefined || line.arrivalSeq > seenSeq);
  }

  const slots: ListSlot[] = [];
  for (const line of background) {
    // 引用作者两种来源都认：流水里可能只有轻量 quotedAuthor，也可能带完整 quoted
    //（旧数据/测试 fixture）；完整 quoted 不往下传，避免引用原文附加段跟着膨胀
    const quoteAuthor = line.quotedAuthor ?? line.quoted?.nickname;
    const quoteSelf = line.quotedAuthorIsSelf === true || line.quoted?.fromSelf === true;
    // 背景行只陈述事实：不带 @/回复标签（流水没存这些字段），合集在入站记账时
    // 已折叠成短标记（forward_collapsed），不渲染附加段。
    slots.push({
      ...(line.arrivalSeq !== undefined ? { arrivalSeq: line.arrivalSeq } : {}),
      model: {
        ...(line.messageId !== undefined ? { messageId: line.messageId } : {}),
        userId: String(line.userId),
        nickname: line.nickname,
        text: line.text,
        mentionsBot: false,
        replyIds: [],
        master: masterOf(line.userId),
        watched: watchedOf(line.userId),
        // 背景行同样要能看出「这条在 @ 谁 / 在回谁」：只喂指向性标签，
        // 不带完整 quoted（否则引用原文附加段会跟着膨胀，5.9 的附加段只给锚点）
        ...(line.mentionTargets !== undefined ? { mentionTargets: line.mentionTargets } : {}),
        ...(quoteAuthor !== undefined ? { quotedAuthor: quoteAuthor } : {}),
        ...(quoteSelf ? { quotedAuthorIsSelf: true } : {}),
      },
      seen: seenOf(line),
    });
  }
  for (const line of burst) {
    slots.push({
      ...(line.arrivalSeq !== undefined ? { arrivalSeq: line.arrivalSeq } : {}),
      model: {
        ...(line.messageId !== undefined ? { messageId: line.messageId } : {}),
        userId: String(line.userId),
        nickname: line.nickname,
        text: line.text,
        mentionsBot: line.mentionsBot === true,
        replyIds: [...line.replyIds],
        master: masterOf(line.userId),
        watched: watchedOf(line.userId),
        ...(line.mentionTargets !== undefined ? { mentionTargets: line.mentionTargets } : {}),
        ...(line.quoted ? { quoted: line.quoted } : {}),
        ...(line.forward ? { forward: line.forward } : {}),
      },
      seen: seenOf(line),
    });
  }

  // 严格真实接收顺序（decisions §2）；旧流水没序号时 orderByArrival 保持原位
  //（背景在前、整组在后的保守序，与改版前一致）。
  const ordered = orderByArrival(slots);
  const parts = [renderMessageList(ordered.map((slot) => slot.model), messages, "group")];
  // 列表后附加段（decisions §5.9）：先全部引用原文，再合集附件（自带合集在前、
  // 被引合集在后）；最近合集补展开与图片段由宿主（flushBurst）接在最后。
  for (const slot of ordered) {
    if (slot.model.quoted) parts.push(renderQuotedOriginal(slot.model.quoted, messages, options.imageNumbers, options.gifFrames));
  }
  for (const slot of ordered) {
    if (slot.model.forward) parts.push(renderForwardAttachment(slot.model.forward, messages));
    if (slot.model.quoted?.forward) parts.push(renderForwardAttachment(slot.model.quoted.forward, messages));
  }
  return { content: parts.join("\n\n"), seen: ordered.map((slot) => slot.seen) };
}
