/**
 * 群消息的 5 秒静默合并（debounce）与「整组连续发言」的上下文渲染。
 *
 * 为什么要有它：同一个人在群里连着打字很常见，一句话常被拆成三五条。以前每条过闸的消息
 * 都立刻 conv.submit()，鱼就会对着半句话作答；而且 A 说完、B 插一句、A 又说时，
 * 会话级的 lastMessageId 会被后来那条顶掉，引用目标就串到别人身上。
 *
 * 现在是：gate 放行不提交，先按「群 + 发送者」攒 5 秒——同一发送者的新消息取消旧 timer
 * 重新计时，不同发送者互不干扰，5 秒没有新消息才把整组提交一次。整组最后一条是 quote
 * 锚点（A-B-A 里 B 只能出现在背景，不可能顶掉 A 的位置），整组里任意一条 @鱼，
 * 整组都算被点名（mustAnswer），回复引用语义同理。连续发言没有额外的最长等待：
 * 一直在说就一直往后延，静默 5 秒才 flush。
 *
 * 这个文件只有状态机与上下文渲染：时钟、定时器、提交动作、压缩守卫、轮级清账都在
 * src/index.ts（便于注入假时钟验证）。pending 只活在内存里——重启时没 flush 的窗口
 * 直接丢弃，宁可少答一句，也不要在重启后补一句陈年旧话。
 */
import { renderTemplate } from "../prompts.ts";
import { renderForModel, type MessageTable } from "./gate.ts";
import type { IncomingMessage } from "./onebot.ts";

/** 最近流水里的一条（背景栏与 burst 共用同一套字段）。 */
export interface RecentChatMessage {
  /** 收到这一帧时分配的单调序号；旧流水可能没有，此时按 bucket 顺序。 */
  arrivalSeq?: number;
  messageId?: number | string;
  userId: number;
  nickname: string;
  text: string;
  at: number;
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
  /** quote 锚点：这一组里最后一条原始入站消息。 */
  anchor: IncomingMessage;
}

export interface BurstInput {
  msg: IncomingMessage;
  /** 模型可见文本（合集已折叠、bypass 已替换成占位）。 */
  text: string;
  /** 宿主绑定的 opaque 载荷，flush 时按锚点取用。 */
  payload?: string;
}

export interface DebouncerOptions {
  /** 静默窗口，固定 5000ms；留参数只是为了验证时注入。 */
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
  /** 丢掉窗口（压缩守卫命中、异常收尾用）。 */
  drop(chatKey: string, userId: number): boolean;
  size(): number;
  dropAll(): void;
}

export const DEBOUNCE_WINDOW_MS = 5_000;

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
    push({ msg, text, payload }) {
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
        ...(payload !== undefined ? { payload } : {}),
      };
      burst.messages.push(line);
      burst.lastReceivedAt = line.at;
      // 整组语义：任何一条 @鱼 / 任何一条是回复，都算整组
      burst.mustAnswer = burst.messages.some((m) => m.mentionsBot);
      burst.quoteFromReply = burst.messages.some((m) => m.replyIds.length > 0);
      // 锚点永远是这一组最后收到的那条；不同发送者的新消息改动不了它
      burst.anchor = msg;

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

/** 判断一条流水是不是已经在这组连续发言里：有 id/序号就精确，没有就按「同人同话」。 */
function burstMatcher(burst: readonly BurstMessage[]): (line: RecentChatMessage) => boolean {
  const ids = new Set<string>();
  const seqs = new Set<number>();
  const loose = new Set<string>();
  for (const message of burst) {
    if (message.messageId !== undefined) ids.add(String(message.messageId));
    if (message.arrivalSeq !== undefined) seqs.add(message.arrivalSeq);
    loose.add(`${message.userId}\u0000${message.text}`);
  }
  return (line) => {
    if (line.messageId !== undefined && ids.has(String(line.messageId))) return true;
    if (line.arrivalSeq !== undefined && seqs.has(line.arrivalSeq)) return true;
    // 宁可少一条背景，也不要同一句话在背景和连续发言区各出现一次
    return loose.has(`${line.userId}\u0000${line.text}`);
  };
}

/**
 * 锚点之前最多 `limit` 条群消息，按流水顺序（已经按 arrivalSeq 排好），撇掉整组自己。
 * 旧流水缺 arrivalSeq 时就是 bucket 顺序——与改版前一致。
 */
export function backgroundFor(
  anchor: IncomingMessage,
  bucket: readonly RecentChatMessage[],
  burst: readonly BurstMessage[],
  limit = 10,
): RecentChatMessage[] {
  const index = anchorIndex(anchor, bucket);
  if (index <= 0) return [];
  const inBurst = burstMatcher(burst);
  return bucket.slice(0, index).filter((line) => !inBurst(line)).slice(-limit);
}

export interface ContextOptions {
  /** 主人 QQ：renderForModel 用它标注「你主人」。 */
  master: string;
  /** prompt/messages.md 的文案表：所有可见文案从这里来。 */
  messages: MessageTable;
  /** 特别关注标注（宿主按当前 watchedByChat 现算），只挂在这一轮要说的人前面。 */
  watchedNote?: string;
}

/**
 * 这一轮的 user 文本：背景（带 QQ 号，给主动 @ 提供可信目标）+ 连续发言整组 + 锚点。
 *
 * 顺序是刻意的：先说「刚才群里聊了什么」，再说「这几条是同一个人连着的」，最后才是
 * 要回的那一行（带 @ / 回复 / 主人标注）。锚点之外的消息一律只作背景，且整组不会
 * 在背景里重复出现。
 */
export function withContext(
  anchor: IncomingMessage,
  bucket: readonly RecentChatMessage[],
  burst: readonly BurstMessage[],
  options: ContextOptions,
): string {
  const messages = options.messages;
  const anchorLine = renderForModel(anchor, options.master, messages);
  if (!anchor.chatKey.startsWith("qq:group:")) return anchorLine;

  const parts: string[] = [];
  const background = backgroundFor(anchor, bucket, burst);
  if (background.length > 0) {
    parts.push(renderTemplate(messages["ctx_header"] ?? "", { count: String(background.length) }));
    const template = messages["ctx_bg_line"] ?? "";
    for (const line of background) {
      parts.push(renderTemplate(template, { who: line.nickname, qq: String(line.userId), text: line.text }));
    }
  }

  // 多才叫「连续发言」：一条就还是原来的「要你回应的就是这一条」
  if (burst.length > 1) {
    const marker = messages["ctx_burst_marker"] ?? "";
    const template = messages["ctx_burst_line"] ?? "";
    parts.push(renderTemplate(messages["ctx_burst_header"] ?? "", { who: anchor.nickname, count: String(burst.length), marker }));
    // 除锚点外都按普通行渲染；同一句只出现一次
    for (const line of burst.slice(0, -1)) {
      const rendered = renderTemplate(template, { who: line.nickname, qq: String(line.userId), text: line.text });
      parts.push(`${marker} ${rendered}`.trim());
    }
    parts.push(messages["ctx_anchor_note"] ?? "", options.watchedNote ?? "");
    // 锚点这一行走带结构化标注的那份（群号 / 昵称(QQ) / 回复 id / @ 目标），仍打同组标记
    parts.push(`${marker} ${anchorLine}`.trim());
  } else {
    parts.push(messages["ctx_target"] ?? "", options.watchedNote ?? "", anchorLine);
  }

  return parts.filter((part) => part.length > 0).join("\n");
}
