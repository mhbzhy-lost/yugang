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
} from "../channels/qq/model-input.ts";
import { orderByArrival, type IncomingMessage } from "../channels/qq/onebot.ts";

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
  /** 宿主绑在这一条上的 opaque 载荷（bypass 段剥离结果对象，含 stash/pstash），flush 时取锚点那份。 */
  payload?: { stash: string; pstash?: string } | string;
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
