/**
 * engage-next 状态机：engagement=next 时按群循环「closed → open → closed」的开窗节拍
 * （默认 closed 10 分钟 → open 3 分钟，fish.config.json 的 engage 块可调）。
 *
 * 为什么不是消息驱动：closed 期间非 @ 消息根本不进模型，如果只在消息到来时推进状态，
 * 无消息的群永远停在 closed，engagement 热切换（改 fish.config.json）也就无从生效。
 * 所以状态机自带 tick 定时器（时钟注入参照 debounce 的先例），每 tick 现读 fishConfig()：
 *   - legacy：清掉全部群相位（热切换 stop），tick 空转；
 *   - next：为白名单群维护相位——closed 满 closedMinutes 开窗，open 满 openMinutes 关窗。
 * 热切换重新进入 next 时相位从零建：closed 从零计时，lastCloseSeq 懒定 recent 末条
 * arrivalSeq（宁少勿答：宁可少注入一条积压，不把已进过模型的消息再注入一遍）。
 *
 * open 进入瞬间回调 onPhase(chatKey, "open", backlog)：积压 = (lastCloseSeq, now] 排除
 * pending burst（backlogOf 由宿主落地：再过滤 / 指令与纯 GIF、超 windowSize 截最近 N）。
 * 会话忙（在途轮 / 换页 / 收图轮）时放弃注入（宁少勿答），相位照常切换。
 *
 * open 态的窗口分片（shard，2026-11-02 修订）：free_pass（非 @）消息不走按发送者的
 * debounce/burst 管线，由宿主路由进这里的 shard 收集器（collectShard）——open 窗内每
 * shardSeconds 一拍（engage.shardSeconds，缺省 20 秒，每拍现读配置热生效），到期把这一拍
 * 收集的**全部发送者**消息合成一轮交给
 * onShard 提交（ambient 轮，多发送者逐行渲染）。背压：到期时会话忙（在途
 * ambient/injection 轮、换页、收图）就不提交，消息累积并入下一拍——绝不丢、绝不
 * 并发提交、绝不向 pi 的 steering 队列塞多条；提交失败（onShard 抛错 / Promise reject）
 * 同样把整拍原子回收进收集器并入下一拍。关窗时收集器里还有整拍消息就补交一拍
 * （忙则丢弃并留日志，宁少勿答）；热切换离开 next / stop 同样清掉。@ 消息不走 shard，
 * 仍由 debounce 的 burst 即时路径提交（answer 轮）。
 *
 * 沉默递进（T8）：宿主在 ambient/injection 轮 settle 时发现出口数 >0 就调 noteExit，
 * 状态机只给当前 open 窗记一笔「本窗开过口」；关窗时结算——开过口则连续零出口计数
 * 清零，全程零出口则 +1。仅统计 open 窗：@ 轮/私聊不开口上报，关窗后的残轮 settle
 * 也找不到 open 窗，一律不计不清。计数供宿主定 nudge 档位（达 silenceThreshold 尾部
 * 追加 nudge 文案，2×阈值另放宽积压窗口），状态机本身不读阈值配置。
 *
 * 分享门（外部计划 E5，决策 9）：open 进入瞬间生成稳定 windowId（chatKey+开窗时刻
 * sha256 派生，同窗恒定、跨窗不撞）并**一次挷随机门**（random() <= ammo.shareChance，
 * 每 tick 现读热生效）落相位内存——窗内不变，关窗作废。出口层（say_words 的 ammoId
 * 链）经 shareGateOf(chatKey) 查询：closed/未跟踪 = undefined（门没开，claim 一律拒）。
 * 门只定「本窗能不能分享」，每窗一条与 available 校验在 claim 事务里机械保证。
 * 相位、lastCloseSeq 与 shard 收集器都只活在内存里：重启回到 closed 从零计时，与
 * debounce 的 pending 同一个取舍——宁可少说一句，不补陈年旧话。沉默计数同生命周期，
 * 热切换离开 next / stop 清相位时一并归零。
 */
import { createHash } from "node:crypto";
import type { EngagementMode } from "./fish-config.ts";

/** 群白名单判定：chatKey 形如 qq:group:NNN（含人格后缀也认前缀），群号在名单内才算命中。 */
export function engageGroupsIncludes(groups: readonly string[], chatKey: string): boolean {
  const m = /^qq:group:(\d+)/.exec(chatKey);
  return m !== null && groups.includes(m[1]);
}

export type EngagePhase = "closed" | "open";

/** 相位回调里的积压消息：与 recent 流水同构（宿主的 injection 轮按行渲染）。 */
export interface EngageBacklogItem {
  arrivalSeq?: number;
  messageId?: number | string;
  userId: number;
  nickname: string;
  text: string;
  at: number;
  /** 纯媒体消息形态（onebot 解析层透传）：gif = 纯 GIF（宿主过滤不进积压行）。 */
  mediaOnly?: "gif" | "image";
}

/** shard 收集器里的一条：多带 bypass 段（沿用整组语义，取整拍里最近一条非空的）。 */
export interface EngageShardItem extends EngageBacklogItem {
  payload?: string;
}

/** 每 tick 现读的窗口参数（宿主从 fishConfig().config 现取）。 */
export interface EngageTickConfig {
  engagement: EngagementMode;
  closedMinutes: number;
  openMinutes: number;
  /** open 态分片节拍（秒，engage.shardSeconds）：每拍排程时现读，热加载下一拍生效。 */
  shardSeconds: number;
  /** open 窗随机门概率（ammo.shareChance）：开窗挷一次，窗内不变；缺省 0 = 门恒关（fail closed）。 */
  ammoShareChance?: number;
}

export type EngageTimer = ReturnType<typeof setTimeout>;

export interface EngageNextDeps {
  /** 白名单群（GROUPS）：状态机只为这些群维护相位；空名单 = 没有可开窗的群。 */
  groups(): readonly string[];
  /** 该群 recent 流水：closed 进入时取末条 arrivalSeq 懒定 lastCloseSeq 基线。 */
  recentOf(chatKey: string): readonly EngageBacklogItem[];
  /** backlog 查询口：(lastCloseSeq 之后、排除 pending burst)。宿主的 injection 轮消费；缺省视为恒空。 */
  backlogOf?(chatKey: string, afterSeq: number | undefined): readonly EngageBacklogItem[];
  /** 会话忙（在途轮 / 换页 / 收图轮）：忙时开窗放弃积压注入、shard 到期累积背压（宁少勿答）。 */
  busy(chatKey: string): boolean;
  /** 相位迁移回调：closed 进入积压恒空；open 进入带积压（injection 注入由宿主完成）。 */
  onPhase(chatKey: string, phase: EngagePhase, backlog: readonly EngageBacklogItem[]): void | Promise<void>;
  /** shard 到期回调：把这拍收集的全部 free_pass 消息合成一轮 ambient 提交（宿主实现）。
 *  提供了 shard 机制才生效；不提供时 collectShard 恒 false（宿主丢弃并留日志）。 */
  onShard?(chatKey: string, messages: readonly EngageShardItem[]): void | Promise<void>;
  /** 每 tick 现读：engagement 热切换与窗口时长都从这里来（无消息也生效）。 */
  config(): EngageTickConfig;
  now?: () => number;
  setTimer?: (flush: () => void, ms: number) => EngageTimer;
  clearTimer?: (timer: EngageTimer) => void;
  /** tick 周期（默认 1000ms）；留参数只为验证时注入。 */
  tickMs?: number;
  /** shard 时长覆盖（毫秒）；缺省每拍现读 config().shardSeconds（缺省 20 秒）。留参数只为验证时注入。 */
  shardMs?: number;
  /** 随机门 RNG 注入（内联验证用）；缺省 Math.random。 */
  random?: () => number;
  /** 启动/停止等状态机自身事件的日志出口；缺省静默。 */
  log?: (message: string) => void;
  /** onPhase / onShard 回调与 tick 的异常出口；缺省静默（状态机自身永不抛错中断循环）。 */
  onError?: (error: unknown) => void;
}

export interface EngageNext {
  /** 开始 tick 循环（幂等）；engagement=legacy 时 tick 空转，热切换由 tick 自行消化。 */
  start(): void;
  /** 停止 tick 并清掉全部群相位与 shard 收集器：下次 start 从 closed 零计时重来。 */
  stop(): void;
  /** 该群是否处于 open 窗；未跟踪（未 start / legacy / 白名单外）= closed。 */
  isOpen(chatKey: string): boolean;
  /** 该群当前相位；未跟踪返回 undefined（观测用）。 */
  phaseOf(chatKey: string): EngagePhase | undefined;
  /**
   * 往当前 open 窗的 shard 收集器里塞一条 free_pass 消息（宿主路由）；
   * closed / 未跟踪 / 未接 onShard 时返回 false（宿主丢弃并留日志，宁少勿答）。
   */
  collectShard(chatKey: string, message: EngageShardItem): boolean;
  /**
   * 零出口观测上报（T8）：宿主在某 ambient/injection 轮 settle 时发现出口数 >0 就调
   * 它，状态机给该群当前 open 窗记一笔「本窗开过口」（关窗时据此清零/累加沉默计数）。
   * 仅 open 窗记账：@ 轮/私聊不报，closed / 未跟踪（关窗后的残轮）不计不清。
   */
  noteExit(chatKey: string): void;
  /** 该群当前连续全程零出口的 open 窗数（T8 沉默计数，宿主据此定 nudge 档位）；未跟踪 = 0。 */
  silenceOf(chatKey: string): number;
  /**
   * 当前 open 窗的分享门（E5）：windowId + 开窗时一次挷出的门结果；closed / 未跟踪 /
   * 白名单外 = undefined（出口层的 ammoId 链据此拒绝且不占额度）。
   */
  shareGateOf(chatKey: string): { windowId: string; open: boolean } | undefined;
}

interface GroupPhase {
  phase: EngagePhase;
  phaseSince: number;
  /** 上次关窗时 recent 末条 arrivalSeq：open 进入据此取积压。 */
  lastCloseSeq?: number;
  /** open 态的 shard 收集器：待提交消息 + 自续定时器；关窗 / 热切换时清掉。 */
  shard?: { messages: EngageShardItem[]; timer?: EngageTimer };
  /** 连续全程零出口的 open 窗数（T8）：窗内有 ambient/injection 轮开口即清零。 */
  silentWindows: number;
  /** 本 open 窗内是否已有 ambient/injection 轮开口（settle 观测，关窗时结算归位）。 */
  spokeInWindow: boolean;
  /** 本窗稳定 windowId（E5，chatKey+开窗时刻派生）：窗内恒定，关窗作废。 */
  windowId?: string;
  /** 本窗随机门结果（E5）：开窗进入时一次落定，窗内不变。 */
  shareOpen?: boolean;
}

export function createEngageNext(deps: EngageNextDeps): EngageNext {
  const now = deps.now ?? Date.now;
  const setTimer = deps.setTimer ?? ((flush, ms) => setTimeout(flush, ms));
  const clearTimer = deps.clearTimer ?? ((timer) => clearTimeout(timer));
  const tickMs = deps.tickMs ?? 1_000;
  const shardEnabled = deps.onShard !== undefined;
  const random = deps.random ?? Math.random;

  /** shard 一拍的时长（毫秒）：验证注入优先；否则现读配置（engage.shardSeconds，缺省 20，热加载每拍现读）。 */
  const shardMsOf = (): number => deps.shardMs ?? deps.config().shardSeconds * 1000;

  const phases = new Map<string, GroupPhase>();
  let running = false;
  let timer: EngageTimer | undefined;

  const fire = (chatKey: string, phase: EngagePhase, backlog: readonly EngageBacklogItem[]): void => {
    try {
      const result = deps.onPhase(chatKey, phase, backlog);
      if (result instanceof Promise) result.catch((error: unknown) => deps.onError?.(error));
    } catch (error) {
      deps.onError?.(error);
    }
  };

  /** 流水按到达序排好，末条即最新；旧流水没有 arrivalSeq 时基线留空（宁少勿答）。 */
  const lastSeqOf = (messages: readonly EngageBacklogItem[]): number | undefined =>
    messages.length === 0 ? undefined : messages[messages.length - 1]?.arrivalSeq;

  const clearShard = (state: GroupPhase): void => {
    if (state.shard?.timer !== undefined) clearTimer(state.shard.timer);
    state.shard = undefined;
  };

  /** 丢弃收集器里未提交的消息（关窗时忙 / 热切换 / stop）：宁少勿答，但必须留痕。 */
  const dropShard = (state: GroupPhase, chatKey: string, why: string): void => {
    if (state.shard && state.shard.messages.length > 0) {
      deps.log?.(`搭话 shard 丢弃 ${chatKey} ${state.shard.messages.length} 条（${why}）`);
    }
    clearShard(state);
  };

  /** shard 到期：会话忙就不提交（消息累积并入下一拍，背压）；final 只在关窗收尾时为 true。
   *  提交成功才算数：onShard 同步抛错或 Promise reject（onError 路径）时，整拍消息原子放回
   *  收集器队首（保持到达序）并入下一拍，绝不丢；收集器已被关窗/热切换清掉就重建承接
   *  （下次开窗的 scheduleShard 会复用并补交；engagement 切离后的整份清除仍按既有语义丢弃）。 */
  const flushShard = (chatKey: string, state: GroupPhase, final: boolean): void => {
    const shard = state.shard;
    if (!shard || shard.messages.length === 0) return;
    if (deps.busy(chatKey)) {
      if (final) dropShard(state, chatKey, "关窗时会话忙");
      return;
    }
    const messages = shard.messages;
    shard.messages = [];
    /** 提交失败的原子回收：整拍消息放回收集器队首，下一拍先提交它们（新到的照旧排在后面）。 */
    const recycle = (error: unknown): void => {
      deps.onError?.(error);
      const target = state.shard ?? { messages: [] as EngageShardItem[] };
      state.shard = target;
      target.messages = [...messages, ...target.messages];
    };
    try {
      const result = deps.onShard?.(chatKey, messages);
      if (result instanceof Promise) result.then(() => {}, recycle);
    } catch (error) {
      recycle(error);
    }
  };

  /** open 态的分片自续定时器：每 shardMs 一拍，到期冲刷收集器后续排下一拍。 */
  const scheduleShard = (chatKey: string, state: GroupPhase): void => {
    if (!shardEnabled) return;
    const shard = state.shard ?? { messages: [] as EngageShardItem[] };
    state.shard = shard;
    shard.timer = setTimer(() => {
      shard.timer = undefined;
      // 相位已翻或收集器已换新：这拍作废（消息要么已随收尾提交，要么已丢弃）
      if (state.phase !== "open" || state.shard !== shard) return;
      flushShard(chatKey, state, false);
      if (state.phase === "open" && state.shard === shard) scheduleShard(chatKey, state);
    }, shardMsOf());
  };

  const enterClosed = (chatKey: string, state: GroupPhase, at: number): void => {
    state.phase = "closed";
    state.phaseSince = at;
    // 分享门随窗作废（E5）：closed 后 shareGateOf 必须 undefined，出口层拒无可拒
    state.windowId = undefined;
    state.shareOpen = undefined;
    // 关窗即懒定基线：open 期的消息已进过模型（injection / shard），不再算积压
    state.lastCloseSeq = lastSeqOf(deps.recentOf(chatKey));
    // 收集器里还有整拍消息就补交一拍；忙则丢弃留日志（宁少勿答）。
    // 收尾后只有提交失败的回收残留在收集器里：留窗承接（下次开窗补交），摘掉节拍定时器
    // （相位守卫会让它空转一拍，不如摘净）；空了才清。
    if (state.shard) {
      flushShard(chatKey, state, true);
      const leftover = state.shard;
      if (leftover === undefined || leftover.messages.length === 0) {
        clearShard(state);
      } else if (leftover.timer !== undefined) {
        clearTimer(leftover.timer);
        leftover.timer = undefined;
      }
    }
    // T8 沉默结算：本窗有 ambient/injection 轮开口（settle 观测）→ 计数清零；
    // 全程零出口 → +1。关窗后的残轮 settle 找不到 open 窗，不影响结算。
    if (state.spokeInWindow) {
      if (state.silentWindows > 0) deps.log?.(`搭话沉默清零 ${chatKey}（本窗有开口）`);
      state.silentWindows = 0;
    } else {
      state.silentWindows += 1;
      deps.log?.(`搭话沉默 ${chatKey}：连续 ${state.silentWindows} 窗零出口`);
    }
    state.spokeInWindow = false;
    fire(chatKey, "closed", []);
  };

  const enterOpen = (chatKey: string, state: GroupPhase, at: number): void => {
    state.phase = "open";
    state.phaseSince = at;
    // 分享门（E5）：稳定 windowId（chatKey+开窗时刻 sha256 派生，同窗恒定跨窗不撞）+
    // 随机门一次挷落相位——窗内不变，出口层 claim 时只认这份结果，不重挷
    state.windowId = "win-" + createHash("sha256").update(chatKey + "@" + String(at)).digest("hex").slice(0, 16);
    state.shareOpen = random() <= (deps.config().ammoShareChance ?? 0);
    // 新窗从零观测开口（上一窗已在关窗时结算）；沉默计数跨窗保留，开口才清零
    state.spokeInWindow = false;
    // 忙（在途轮 / 换页 / 收图）时放弃注入（宁少勿答）；backlogOf 由宿主提供
    const backlog = deps.busy(chatKey) ? [] : (deps.backlogOf?.(chatKey, state.lastCloseSeq) ?? []);
    // open 进入即启动分片计时：free_pass 消息从这一刻起逐拍合并提交
    scheduleShard(chatKey, state);
    fire(chatKey, "open", backlog);
  };

  const tick = (): void => {
    const { engagement, closedMinutes, openMinutes } = deps.config();
    if (engagement !== "next") {
      // 热切换 stop：清掉全部相位与 shard 收集器，下次进 next 从 closed 零计时重来
      if (phases.size > 0) {
        for (const [chatKey, state] of phases) dropShard(state, chatKey, "engagement 已切离 next");
        phases.clear();
        deps.log?.("搭话开窗 next 停止（engagement 已切离 next）");
      }
      return;
    }
    const at = now();
    for (const chatKey of deps.groups()) {
      let state = phases.get(chatKey);
      if (!state) {
        // 初次进入（start / 热切换回 next）：closed 从零计时，基线懒定 recent 末条
        state = { phase: "closed", phaseSince: at, lastCloseSeq: lastSeqOf(deps.recentOf(chatKey)), silentWindows: 0, spokeInWindow: false };
        phases.set(chatKey, state);
        deps.log?.(`搭话开窗 next 启动 ${chatKey}：closed 从零计时`);
        continue;
      }
      if (state.phase === "closed") {
        if (at - state.phaseSince >= closedMinutes * 60_000) enterOpen(chatKey, state, at);
      } else if (at - state.phaseSince >= openMinutes * 60_000) {
        enterClosed(chatKey, state, at);
      }
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
    isOpen(chatKey) {
      return phases.get(chatKey)?.phase === "open";
    },
    phaseOf(chatKey) {
      return phases.get(chatKey)?.phase;
    },
    collectShard(chatKey, message) {
      if (!shardEnabled) return false;
      const state = phases.get(chatKey);
      if (!state || state.phase !== "open") return false;
      (state.shard ??= { messages: [] }).messages.push(message);
      return true;
    },
    noteExit(chatKey) {
      const state = phases.get(chatKey);
      // 仅 open 窗记账：@ 轮/私聊本就不该报；关窗后的残轮 settle 找不到 open 窗不计不清
      if (!state || state.phase !== "open") return;
      state.spokeInWindow = true;
    },
    silenceOf(chatKey) {
      return phases.get(chatKey)?.silentWindows ?? 0;
    },
    shareGateOf(chatKey) {
      const state = phases.get(chatKey);
      if (!state || state.phase !== "open" || state.windowId === undefined) return undefined;
      return { windowId: state.windowId, open: state.shareOpen === true };
    },
  };
}
