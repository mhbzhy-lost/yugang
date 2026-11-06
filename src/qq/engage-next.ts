/**
 * engage 状态机：自由活动模式是唯一的搭话机制（2026-11-06 合并，开窗两态已退役）。
 *
 * 所有 GROUPS 群恒可搭话：非 @（free_pass）消息不走按发送者的 debounce/burst 管线，
 * 由宿主路由进这里的 shard 收集器（collectShard，相位懒建总是收），每 freeSeconds
 * （缺省 60 秒，1 秒 tick 现读配置比对——热改下一拍生效）一拍，把这一拍收集的
 * **全部发送者**消息合成一轮交给 onShard 提交（ambient 轮，多发送者逐行渲染）。
 *
 * 背压：到期时会话忙（在途轮 / 换页 / 收图）就不提交，消息累积并入下一拍——绝不丢、
 * 绝不并发提交；提交失败（onShard 抛错 / Promise reject）同样把整拍原子回收进收集器
 * 并入下一拍。有正在攒的 @ 组时 yieldTo 返回 true，本拍让行（@ 必答轮优先，消息顺延）。
 *
 * 单拍超限（engage.freeBatchMax，缺省 50）在收集时丢最旧并计数，flush 时留一行日志
 * ——这是唯一的有损点（防爆闸）。
 *
 * 空拍不提交；只在空拍、会话不忙、宵禁（本地 00:00–08:00）外时掷一次自主门
 * （engage.freeBrowseChance，缺省 0.03，严格 random() < 概率：0 永不开放），门开才
 * 回调 onFreeIdle（宿主提交「主动交流机会」轮）。windowId 用 free- 前缀
 * （chatKey+拍时刻 sha256 派生），语义只是「本拍的浏览授权」，下一拍作废；
 * 宿主与工具侧经 videoBrowseGateOf 查询（fail closed）。
 *
 * 相位与收集器都只活在内存里：重启丢弃在途拍（宁少说一句，不补陈年旧话），
 * stop 清掉全部并留日志。
 */
import { createHash } from "node:crypto";
import { isCurfewAt } from "./curfew.ts";
import { VIDEO_TOPICS } from "../external/video-browse.ts";
import type { QuotedMessage } from "./onebot.ts";

/** 群白名单判定：chatKey 形如 qq:group:NNN（含人格后缀也认前缀），群号在名单内才算命中。 */
export function engageGroupsIncludes(groups: readonly string[], chatKey: string): boolean {
  const m = /^qq:group:(\d+)/.exec(chatKey);
  return m !== null && groups.includes(m[1]!);
}

/** shard 收集器里的一条：多带 bypass 段（沿用整组语义，取整拍里最近一条非空的），
 *  以及批内回复关系（replyIds 渲染 [回复了m:id]，quoted 在列表后渲染 [引用原文]）。 */
export interface EngageShardItem {
  arrivalSeq?: number;
  messageId?: number | string;
  userId: number;
  nickname: string;
  text: string;
  at: number;
  /** 纯媒体消息形态（onebot 解析层透传）。 */
  mediaOnly?: "gif" | "image";
  payload?: string;
  replyIds?: readonly string[];
  quoted?: QuotedMessage;
  /** 这条 @ 的其他人（不含 @鱼/@全体）：批内渲染「接收对象是…，不是你」。 */
  mentionTargets?: readonly string[];
}

/** 每 tick 现读的拍参数（宿主从 fishConfig().config 现取）。 */
export interface EngageTickConfig {
  /** 拍长（秒，engage.freeSeconds）：缺省 60，每 tick 现读热生效。 */
  freeSeconds?: number;
  /** 空拍的自主开口概率（engage.freeBrowseChance）：缺省 0.03，宵禁内恒关。 */
  freeBrowseChance?: number;
  /** 单拍收集上限（条，engage.freeBatchMax）：缺省 50，超出丢最旧并计数。 */
  freeBatchMax?: number;
}

export type EngageTimer = ReturnType<typeof setTimeout>;

export interface EngageNextDeps {
  /** 白名单群（GROUPS）：状态机只为这些群维护相位；空名单 = 没有可搭话的群。 */
  groups(): readonly string[];
  /** 会话忙（在途轮 / 换页 / 收图）：忙时本拍作废（消息留到下一拍），不掷门。 */
  busy(chatKey: string): boolean;
  /** 拍到期回调：把这拍收集的全部 free_pass 消息合成一轮 ambient 提交（宿主实现）。
   *  提供了 shard 机制才生效；不提供时 collectShard 恒 false（宿主丢弃并留日志）。 */
  onShard?(chatKey: string, messages: readonly EngageShardItem[]): void | Promise<void>;
  /** 空拍且自主门开时的回调：宿主提交「主动交流机会」轮（browseWindow/browseTopic 用
   *  传进来的 gate）。门没开不回调；忙 / 让行时不掷门也不回调。 */
  onFreeIdle?(chatKey: string, gate: { windowId: string; topic: string }): void | Promise<void>;
  /** 本拍是否让行（有正在攒的 @ 组）：true 时本拍不提交、不掷门，消息顺延到下一拍。 */
  yieldTo?(chatKey: string): boolean;
  /** 每 tick 现读（带 chatKey，支持按群覆盖）：拍长与概率都从这里来（无消息也生效）。 */
  config(chatKey: string): EngageTickConfig;
  now?: () => number;
  setTimer?: (flush: () => void, ms: number) => EngageTimer;
  clearTimer?: (timer: EngageTimer) => void;
  /** tick 周期（默认 1000ms）；留参数只为验证时注入。 */
  tickMs?: number;
  /** 拍长覆盖（毫秒）；缺省每 tick 现读 config().freeSeconds（缺省 60 秒）。留参数只为验证时注入。 */
  freeMs?: number;
  /** 随机门 RNG 注入（内联验证用）；缺省 Math.random。 */
  random?: () => number;
  /** 启动/停止等状态机自身事件的日志出口；缺省静默。 */
  log?: (message: string) => void;
  /** onShard / onFreeIdle 回调与 tick 的异常出口；缺省静默（状态机自身永不抛错中断循环）。 */
  onError?: (error: unknown) => void;
}

export interface EngageNext {
  /** 开始 tick 循环（幂等）；拍长热改由 tick 现读消化。 */
  start(): void;
  /** 停止 tick 并清掉全部群相位与收集器：未提交的消息丢弃并留日志。 */
  stop(): void;
  /**
   * 往收集器里塞一条 free_pass 消息（宿主路由）；相位懒建并总是收（启动首秒也认）。
   * 未接 onShard 时返回 false（宿主丢弃并留日志）。
   */
  collectShard(chatKey: string, message: EngageShardItem): boolean;
  /**
   * 最近一次掷出的视频浏览门（空拍自主门）：windowId + topic + 门结果；没掷过 = undefined
   * （宿主与工具侧据此拒绝零新增主动轮与一切浏览授权，fail closed）。
   */
  videoBrowseGateOf(chatKey: string): { windowId: string; topic: string; open: boolean } | undefined;
}

interface GroupPhase {
  /** 拍收集器：待提交消息。 */
  shard?: { messages: EngageShardItem[] };
  /** 上一次拍时刻（毫秒）：拍长由 1 秒 tick 现读配置比对，热改下一拍生效。 */
  lastBeatAt?: number;
  /** 本拍因超限被丢弃的最旧消息条数（flush 时打一行日志后归零）。 */
  droppedSinceBeat?: number;
  /** 最近一次自主门的 windowId / topic / 结果（free- 前缀，下一拍作废）。 */
  windowId?: string;
  videoTopic?: string;
  videoBrowseOpen?: boolean;
}

export function createEngageNext(deps: EngageNextDeps): EngageNext {
  const now = deps.now ?? Date.now;
  const setTimer = deps.setTimer ?? ((flush, ms) => setTimeout(flush, ms));
  const clearTimer = deps.clearTimer ?? ((timer) => clearTimeout(timer));
  const tickMs = deps.tickMs ?? 1_000;
  const shardEnabled = deps.onShard !== undefined;
  const random = deps.random ?? Math.random;

  /** 拍长（毫秒）：验证注入优先；否则每 tick 现读 engage.freeSeconds（缺省 60，热改下一拍生效）。 */
  const freeMsOf = (chatKey: string): number => deps.freeMs ?? (deps.config(chatKey).freeSeconds ?? 60) * 1000;
  /** 拍收集上限（条）：缺省 50，超出丢最旧并计数。 */
  const freeCapOf = (chatKey: string): number => Math.max(1, Math.floor(deps.config(chatKey).freeBatchMax ?? 50));

  const phases = new Map<string, GroupPhase>();
  let running = false;
  let timer: EngageTimer | undefined;

  /** 浏览门作废：每拍开头清一次。 */
  const clearBrowseGate = (state: GroupPhase): void => {
    state.windowId = undefined;
    state.videoBrowseOpen = undefined;
    state.videoTopic = undefined;
  };

  /** 群相位懒建（首条消息 / 首 tick），本刻起算拍。 */
  const ensureState = (chatKey: string, at: number): GroupPhase => {
    let state = phases.get(chatKey);
    if (!state) {
      state = { lastBeatAt: at };
      phases.set(chatKey, state);
      deps.log?.(`自由活动模式启动 ${chatKey}`);
    }
    state.lastBeatAt ??= at;
    return state;
  };

  /** 丢弃收集器里未提交的消息（stop）：宁少勿答，但必须留痕。 */
  const dropShard = (state: GroupPhase, chatKey: string, why: string): void => {
    if (state.shard && state.shard.messages.length > 0) {
      deps.log?.(`自由拍丢弃 ${chatKey} ${state.shard.messages.length} 条（${why}）`);
    }
    state.shard = undefined;
  };

  /** 拍到期：会话忙就不提交（消息累积并入下一拍，背压）。
   *  提交成功才算数：onShard 同步抛错或 Promise reject（onError 路径）时，整拍消息原子放回
   *  收集器队首（保持到达序）并入下一拍，绝不丢。 */
  const flushShard = (chatKey: string, state: GroupPhase): void => {
    const shard = state.shard;
    if (!shard || shard.messages.length === 0) return;
    if (deps.busy(chatKey)) return;
    const messages = shard.messages;
    shard.messages = [];
    /** 提交失败的原子回收：整拍消息放回收集器队首，下一拍先提交它们（新到的照旧排在后面）。
     *  先恢复再上报：上报出口抛错时也不能把这一拍弄丢。 */
    const recycle = (error: unknown): void => {
      const target = state.shard ?? { messages: [] as EngageShardItem[] };
      state.shard = target;
      target.messages = [...messages, ...target.messages];
      deps.onError?.(error);
    };
    try {
      const result = deps.onShard?.(chatKey, messages);
      if (result instanceof Promise) result.then(() => {}, recycle);
    } catch (error) {
      recycle(error);
    }
  };

  /** 空拍的自主门：只在空拍且不忙时掷一次（严格小于：概率 0 永不开放）。
   *  windowId 用 free- 前缀，语义只是「本拍的浏览授权」；宵禁由调用方提前拦掉。 */
  const rollFreeBrowse = (chatKey: string, state: GroupPhase, at: number): { windowId: string; topic: string; open: boolean } => {
    const topic = VIDEO_TOPICS[Math.floor(random() * VIDEO_TOPICS.length)] ?? VIDEO_TOPICS[0]!;
    const windowId = "free-" + createHash("sha256").update(chatKey + "@" + String(at)).digest("hex").slice(0, 16);
    const open = random() < (deps.config(chatKey).freeBrowseChance ?? 0.03);
    state.windowId = windowId;
    state.videoTopic = topic;
    state.videoBrowseOpen = open;
    return { windowId, topic, open };
  };

  /** 一拍（由 1 秒 tick 比对 lastBeatAt 驱动，热改下一拍生效）：
   *  - 在途（轮 / 换页 / 收图）→ 本拍作废，消息留到下一拍，不掷门；
   *  - 有正在攒的 @ 组 → 让行，不提交不掷门；
   *  - 宵禁（本地 00:00–08:00）→ 不提交拍（消息留收集器顺延到早上第一拍；
   *    拍间可能超上限丢最旧——夜间高流量群的接受损耗），也不掷门；
   *    @ 必答不经这里，照常；
   *  - 有消息 → 提交一拍 ambient（背压与失败回收沿用 flushShard），超限丢弃条数留日志；
   *  - 空拍 → 掷一次自主门，门开才回调 onFreeIdle。 */
  const freeBeat = (chatKey: string, state: GroupPhase, at: number): void => {
    state.lastBeatAt = at;
    if (deps.busy(chatKey)) return;
    if (deps.yieldTo?.(chatKey) === true) return;
    clearBrowseGate(state);
    // 宵禁：夜里不主动起 ambient 轮、不自起话题；@ 必答与 pending 组合并不受影响
    if (isCurfewAt(at)) return;
    if ((state.shard?.messages.length ?? 0) > 0) {
      const dropped = state.droppedSinceBeat ?? 0;
      const size = state.shard?.messages.length ?? 0;
      deps.log?.(`自由拍 ${chatKey} 提交 ${size} 条`);
      if (dropped > 0) deps.log?.(`自由拍 ${chatKey} 超限丢弃 ${dropped} 条`);
      state.droppedSinceBeat = 0;
      flushShard(chatKey, state);
      return;
    }
    // 宵禁已在本拍开头统一拦截（不提交、不掷门）；这里只掷门
    const gate = rollFreeBrowse(chatKey, state, at);
    if (!gate.open) return;
    deps.log?.(`自由拍 ${chatKey} 自主门开`);
    try {
      const result = deps.onFreeIdle?.(chatKey, gate);
      if (result instanceof Promise) result.catch((error: unknown) => deps.onError?.(error));
    } catch (error) {
      deps.onError?.(error);
    }
  };

  const tick = (): void => {
    const at = now();
    for (const chatKey of deps.groups()) {
      const state = ensureState(chatKey, at);
      if (state.lastBeatAt !== undefined && at - state.lastBeatAt >= freeMsOf(chatKey)) freeBeat(chatKey, state, at);
    }
  };

  // 自续定时器：每 tick 重新排程，tick 抛错只记不改，循环不中断
  const schedule = (): void => {
    timer = setTimer(() => {
      timer = undefined;
      if (!running) return;
      try {
        tick();
      } catch (error) {
        deps.onError?.(error);
      }
      if (running) schedule();
    }, tickMs);
  };

  return {
    start() {
      if (running) return;
      running = true;
      schedule();
    },
    stop() {
      running = false;
      if (timer !== undefined) {
        clearTimer(timer);
        timer = undefined;
      }
      for (const [chatKey, state] of phases) dropShard(state, chatKey, "stop");
      phases.clear();
    },
    collectShard(chatKey, message) {
      if (!shardEnabled) return false;
      const state = ensureState(chatKey, now());
      const shard = (state.shard ??= { messages: [] });
      shard.messages.push(message);
      // 拍有界：超出上限丢最旧并计数（flush 时留一行日志）——唯一的有损点
      const cap = freeCapOf(chatKey);
      const over = shard.messages.length - cap;
      if (over > 0) {
        shard.messages.splice(0, over);
        state.droppedSinceBeat = (state.droppedSinceBeat ?? 0) + over;
      }
      return true;
    },
    videoBrowseGateOf(chatKey) {
      const state = phases.get(chatKey);
      if (!state || state.windowId === undefined || state.videoTopic === undefined) return undefined;
      return { windowId: state.windowId, topic: state.videoTopic, open: state.videoBrowseOpen === true };
    },
  };
}
