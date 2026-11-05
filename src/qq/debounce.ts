/**
 * 群消息的 10 秒静默合并（debounce）与「整组连续发言」的上下文渲染。
 *
 * 为什么要有它：同一个人在群里连着打字很常见，一句话常被拆成三五条。以前每条过闸的消息
 * 都立刻 conv.submit()，鱼就会对着半句话作答；而且 A 说完、B 插一句、A 又说时，
 * 会话级的 lastMessageId 会被后来那条顶掉，引用目标就串到别人身上。
 *
 * 现在是：gate 放行不提交，先按「群 + 发送者」攒 10 秒——同一发送者的新消息取消旧 timer
 * 重新计时，不同发送者互不干扰，10 秒没有新消息才把整组提交一次。整组最后**收到**的那条
 * （按 arrivalSeq，不是最后处理完的那条）是 quote 锚点（A-B-A 里 B 只能出现在背景，
 * 不可能顶掉 A 的位置），整组里任意一条 @鱼，整组都算被点名（mustAnswer），
 * 回复引用语义同理。连续发言没有额外的最长等待：一直在说就一直往后延，静默 10 秒才 flush。
 *
 * 这个文件只有状态机与上下文渲染：时钟、定时器、提交动作、压缩守卫、轮级清账都在
 * src/index.ts（便于注入假时钟验证）。pending 只活在内存里——重启时没 flush 的窗口
 * 直接丢弃，宁可少答一句，也不要在重启后补一句陈年旧话。
 */
import type { MessageTable } from "./gate.ts";
import {
  mentionTargetsOf,
  renderForwardAttachment,
  renderMessageList,
  renderQuotedOriginal,
  type ForwardAttachment,
  type ModelMessage,
  type QuotedMessage,
} from "./model-input.ts";
import { orderByArrival, type IncomingMessage } from "./onebot.ts";

/** 最近流水里的一条（背景栏与 burst 共用同一套字段）。 */
export interface RecentChatMessage {
  /** 收到这一帧时分配的单调序号；旧流水可能没有，此时按 bucket 顺序。 */
  arrivalSeq?: number;
  messageId?: number | string;
  userId: number;
  nickname: string;
  text: string;
  quoted?: QuotedMessage;
  forward?: ForwardAttachment;
  /** 这条消息 @ 的其他人（不含 @鱼/@全体）：渲染「接收对象是…，不是你」。 */
  mentionTargets?: readonly string[];
  /** 指向性标签专用：引用作者昵称与「是不是鱼自己」（不携带完整 quoted）。 */
  quotedAuthor?: string;
  quotedAuthorIsSelf?: boolean;
  at: number;
  /** 纯媒体消息形态（onebot 解析层透传，开窗积压/shard 过滤消费）：
 *  gif = 纯 GIF 消息，image = 纯图片无文字。undefined = 普通消息。 */
  mediaOnly?: "gif" | "image";
}

/** burst 里的一条：多带两个「整组语义」需要的标记。 */
export interface BurstMessage extends RecentChatMessage {
  mentionsBot: boolean;
  replyIds: readonly string[];
  /** 宿主绑在这一条上的 opaque 载荷（例如 bypass 段），flush 时取锚点那份。 */
  payload?: string;
}

export type DebounceTimer = ReturnType<typeof setTimeout>;

export interface PendingBurst {
  chatKey: string;
  userId: number;
  /** 这一组按到达顺序排好的消息（模型可见文本）。 */
  messages: BurstMessage[];
  lastReceivedAt: number;
  /** 整组里任意一条 @鱼 → 整组必答。 */
  mustAnswer: boolean;
  /** 整组里任意一条在回复别人 → 这一轮回应仍然引用。 */
  quoteFromReply: boolean;
  /** 状态机持有的定时器；调用方不要动它。 */
  timer?: DebounceTimer;
  /** quote 锚点：这一组里按收到顺序最后一条原始入站消息。 */
  anchor: IncomingMessage;
  /**
   * 宿主首次 push 时绑定的不透明上下文（会话 / 人格）。flush 只认这一份：
   * 10 秒窗口里主人 `/切换人格` 之后，这一组仍然落在切换前那个会话里。
   */
  binding?: unknown;
}

export interface BurstInput {
  msg: IncomingMessage;
  /** 模型可见文本（合集已折叠、bypass 已替换成占位）。 */
  text: string;
  /** T2 接入共享消息渲染器时使用的结构化附件。 */
  quoted?: QuotedMessage;
  forward?: ForwardAttachment;
  /** 宿主绑定的 opaque 载荷（bypass 段），flush 时取整组里最近一条非空的。 */
  payload?: string;
  /** 首次 push 时绑定的不透明上下文（会话 / 人格）；之后的 push 改不动它。 */
  binding?: unknown;
}

export interface DebouncerOptions {
  /** 静默窗口，固定 10000ms；留参数只是为了验证时注入。 */
  windowMs?: number;
  now?: () => number;
  setTimer?: (flush: () => void, ms: number) => DebounceTimer;
  clearTimer?: (timer: DebounceTimer) => void;
  onFlush: (burst: PendingBurst) => void | Promise<void>;
  onError?: (error: unknown) => void;
}

export interface Debouncer {
  /** 并入这个发送者的窗口（没有就新建），并重新计时。返回合并后的整组。 */
  push(input: BurstInput): PendingBurst;
  /** 这个发送者现在有没有待定窗口（被闸拦下的 follow-up 要靠它判断是否并入）。 */
  pending(chatKey: string, userId: number): PendingBurst | undefined;
  /** 这个群当前的全部待定窗口（open 窗的积压查询要排除其中的消息，不重复注入）。 */
  pendingOf(chatKey: string): PendingBurst[];
  /** 丢掉窗口（压缩守卫命中、异常收尾用）。 */
  drop(chatKey: string, userId: number): boolean;
  size(): number;
  dropAll(): void;
}

export const DEBOUNCE_WINDOW_MS = 10_000;

/** chatKey + userId 是窗口的唯一键：同一个人在不同群互不影响。 */
function burstKey(chatKey: string, userId: number): string {
  return `${chatKey}\u0000${userId}`;
}

export function createDebouncer(options: DebouncerOptions): Debouncer {
  const windowMs = options.windowMs ?? DEBOUNCE_WINDOW_MS;
  const now = options.now ?? Date.now;
  const setTimer = options.setTimer ?? ((flush, ms) => setTimeout(flush, ms));
  const clearTimer = options.clearTimer ?? ((timer) => clearTimeout(timer));
  const bursts = new Map<string, PendingBurst>();

  const run = (burst: PendingBurst): void => {
    try {
      const result = options.onFlush(burst);
      if (result instanceof Promise) {
        result.catch((error: unknown) => options.onError?.(error));
      }
    } catch (error) {
      options.onError?.(error);
    }
  };

  return {
    push({ msg, text, quoted, forward, payload, binding }) {
      const key = burstKey(msg.chatKey, msg.userId);
      const existing = bursts.get(key);
      // 同一发送者的新消息：取消旧 timer，整组继续加长
      if (existing) clearTimer(existing.timer as DebounceTimer);

      const burst: PendingBurst = existing ?? {
        chatKey: msg.chatKey,
        userId: msg.userId,
        messages: [],
        lastReceivedAt: 0,
        mustAnswer: false,
        quoteFromReply: false,
        anchor: msg,
        // 会话 / 人格只认首次 push 那一份：后续 push（包括不带 binding 的 follow-up）改不动它
        ...(binding !== undefined ? { binding } : {}),
      };

      const line: BurstMessage = {
        userId: msg.userId,
        nickname: msg.nickname,
        text,
        at: now(),
        mentionsBot: msg.mentionsBot === true,
        replyIds: [...(msg.replyIds ?? [])],
        ...(msg.messageId !== undefined ? { messageId: msg.messageId } : {}),
        ...(msg.arrivalSeq !== undefined ? { arrivalSeq: msg.arrivalSeq } : {}),
        mentionTargets: mentionTargetsOf(msg.mentions),
        ...((quoted ?? msg.quoted) !== undefined ? { quoted: quoted ?? msg.quoted } : {}),
        ...((forward ?? msg.forward) !== undefined ? { forward: forward ?? msg.forward } : {}),
        ...(payload !== undefined ? { payload } : {}),
      };
      burst.messages.push(line);
      // 整组按「收到顺序」排：入站补充（查名片 / 下头像 / 拉合集）是异步的，
      // 处理完成顺序可能倒过来，整组不能跟着乱。没序号的旧流水保持并入顺序。
      burst.messages = orderByArrival(burst.messages);
      burst.lastReceivedAt = line.at;
      // 整组语义：任何一条 @鱼 / 任何一条是回复，都算整组
      burst.mustAnswer = burst.messages.some((m) => m.mentionsBot);
      burst.quoteFromReply = burst.messages.some((m) => m.replyIds.length > 0);
      // 锚点 = 按收到顺序最后一条；乱序完成时后 push 的那条不一定更晚
      if (isLaterArrival(msg, burst.anchor)) burst.anchor = msg;

      burst.timer = setTimer(() => {
        // 先从表里摘掉再提交：submit/wait 抛错也不会留下一个陈年的 pending
        const current = bursts.get(key);
        if (current === burst) bursts.delete(key);
        run(burst);
      }, windowMs);

      bursts.set(key, burst);
      return burst;
    },

    pending(chatKey, userId) {
      return bursts.get(burstKey(chatKey, userId));
    },

    pendingOf(chatKey) {
      const prefix = `${chatKey}\u0000`;
      return [...bursts.entries()]
        .filter(([key]) => key.startsWith(prefix))
        .map(([, burst]) => burst);
    },

    drop(chatKey, userId) {
      const key = burstKey(chatKey, userId);
      const burst = bursts.get(key);
      if (!burst) return false;
      if (burst.timer !== undefined) clearTimer(burst.timer);
      bursts.delete(key);
      return true;
    },

    size() {
      return bursts.size;
    },

    dropAll() {
      for (const burst of bursts.values()) {
        if (burst.timer !== undefined) clearTimer(burst.timer);
      }
      bursts.clear();
    },
  };
}

/** 收到顺序：有 arrivalSeq 就按序号比，两者都缺才按并入顺序（后来 push 的算更晚）。 */
function isLaterArrival(candidate: IncomingMessage, current: IncomingMessage): boolean {
  const next = candidate.arrivalSeq;
  const prev = current.arrivalSeq;
  if (next !== undefined && prev !== undefined) return next >= prev;
  return true;
}

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
  limit = 10,
): RecentChatMessage[] {
  const candidates =
    anchor.arrivalSeq !== undefined && bucket.some((line) => line.arrivalSeq !== undefined)
      ? bucket.filter((line) => line.arrivalSeq !== undefined && line.arrivalSeq < (anchor.arrivalSeq as number))
      : bucket.slice(0, Math.max(0, anchorIndex(anchor, bucket)));
  const inBurst = burstMatcher(burst);
  return candidates.filter((line) => !inBurst(line)).slice(-limit);
}

/**
 * 整组里最近一条非空载荷（bypass 段）：它可能落在中间（画图指令后面又跟了两句普通闲聊），
 * 只取最后一条会当成没有指令，整个 draw 就静默失效了。
 */
export function lastPayload(burst: readonly BurstMessage[]): string | undefined {
  for (let index = burst.length - 1; index >= 0; index -= 1) {
    const payload = burst[index].payload;
    if (payload !== undefined && payload.length > 0) return payload;
  }
  return undefined;
}

export interface ContextOptions {
  /** 主人 QQ：命中的行打 [主人] 标签（与 [特别关注] 互斥，master 优先）。 */
  master: string;
  /** prompt/messages.md 的文案表：所有可见文案从这里来。 */
  messages: MessageTable;
  /** 背景板条数上限（T5）：@（answer）轮传 engage.mentionContextSize，缺省 10。 */
  backgroundLimit?: number;
  /** 已读标记（决策 20）：背景板先取上限再剔除 arrivalSeq ≤ 它的行（已进过模型的不重复注入）；缺省不去重。 */
  seenSeq?: number;
  /** 特别关注判定（宿主现读 watchedByChat）：命中的行打 [特别关注] 标签（[主人] 行不重复打）。 */
  watched?: (userId: number | string) => boolean;
  /** inline 附图编号表（planRoundImages 的 numbers）：引用原文里的图命中就渲染成 [图片#N]。 */
  imageNumbers?: ReadonlyMap<string, number>;
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
    if (model.quoted) parts.push(renderQuotedOriginal(model.quoted, messages, options.imageNumbers));
    if (model.forward) parts.push(renderForwardAttachment(model.forward, messages));
    if (model.quoted?.forward) parts.push(renderForwardAttachment(model.quoted.forward, messages));
    return { content: parts.join("\n\n"), seen: [seenOf(anchor)] };
  }

  // 背景板（决策 20）：先按上限取最近 N 条，再剔除已进过模型的部分（arrivalSeq ≤ seenSeq；
  // 旧流水没有序号的没法判已读，保守保留）。不传 seenSeq = 整段不去重。
  let background = backgroundFor(anchor, bucket, burst, options.backgroundLimit ?? 10);
  if (options.seenSeq !== undefined) {
    const seenSeq = options.seenSeq;
    background = background.filter((line) => line.arrivalSeq === undefined || line.arrivalSeq > seenSeq);
  }

  const slots: ListSlot[] = [];
  for (const line of background) {
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
        ...(line.quotedAuthor !== undefined ? { quotedAuthor: line.quotedAuthor } : {}),
        ...(line.quotedAuthorIsSelf !== undefined ? { quotedAuthorIsSelf: line.quotedAuthorIsSelf } : {}),
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
    if (slot.model.quoted) parts.push(renderQuotedOriginal(slot.model.quoted, messages, options.imageNumbers));
  }
  for (const slot of ordered) {
    if (slot.model.forward) parts.push(renderForwardAttachment(slot.model.forward, messages));
    if (slot.model.quoted?.forward) parts.push(renderForwardAttachment(slot.model.quoted.forward, messages));
  }
  return { content: parts.join("\n\n"), seen: ordered.map((slot) => slot.seen) };
}
