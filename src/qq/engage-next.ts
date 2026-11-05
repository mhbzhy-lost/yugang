/**
 * engage-next 状态机：按群循环「closed → open → closed」的开窗节拍
 * （默认 closed 10 分钟 → open 3 分钟，fish.config.json 的 engage 块可调；2026-11 起
 * 这是唯一的搭话行为，legacy 判定已下线，闸只认这里的相位）。
 *
 * 为什么不是消息驱动：closed 期间非 @ 消息根本不进模型，如果只在消息到来时推进状态，
 * 无消息的群永远停在 closed。所以状态机自带 tick 定时器（时钟注入参照 debounce 的先例），
 * 每 tick 现读 fishConfig()，为白名单群维护相位——closed 满 closedMinutes 开窗，
 * open 满 openMinutes 关窗；时长热改下一拍生效。群表直取 .env GROUPS（安全域即行为域）。
 * stop 后重新 start 相位从零建：closed 从零计时，lastCloseSeq 懒定 recent 末条
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
 * （忙则丢弃并留日志，宁少勿答）；stop 同样清掉。@ 消息不走 shard，
 * 仍由 debounce 的 burst 即时路径提交（answer 轮）。
 *
 * 沉默递进（旧 T8 nudge，2026-11-04 模型输入计划 T3 停用）：原本由宿主在 ambient/injection
 * 轮 settle 且出口数 >0 时调 noteExit 上报，状态机在关窗时结算连续零出口窗数，宿主据此决定
 * nudge 档位。空窗不再由沉默触发后，宿主侧已无调用方（noteExit / silenceOf 与 shareGateOf
 * 同待遇：保留为兼容源码，不驱动任何模型面）；内部簿记照旧自洽，不得据此重新接线。
 *
 * 分享门（外部计划 E5，决策 9）：open 进入瞬间生成稳定 windowId（chatKey+开窗时刻
 * sha256 派生，同窗恒定、跨窗不撞）并**一次挷随机门**（严格 random() < ammo.shareChance，shareChance=0 永不开放，
 * 每 tick 现读热生效）落相位内存——窗内不变，关窗作废。出口层（say_words 的 ammoId
 * 链）经 shareGateOf(chatKey) 查询：closed/未跟踪 = undefined（门没开，claim 一律拒）。
 * 门只定「本窗能不能分享」，每窗一条与 available 校验在 claim 事务里机械保证。
 * 【2026-11-04 模型输入计划 T3】弹药管线已停用：宿主不再接线 shareGateOf（出口 claim
 * 恒 fail closed），这套门与沉默计数保留为兼容源码，不再驱动任何模型面。
 *
 * 视频浏览门（2026-11-04 模型输入计划 T3）：open 进入瞬间复用同一枚稳定 windowId 与
 * random 注入点，**只掷一次** video.browseChance（严格 random() < 概率，缺省 0 = 恒关，
 * 每 tick 现读热生效）并从 VIDEO_TOPICS 里随机选定本窗 topic——同窗稳定、关窗作废。
 * 宿主经 videoBrowseGateOf(chatKey) 查询：门开时空窗零新增轮才提交「主动交流机会」模板
 * 并把 windowId/topic 钉上 RoundTrigger（browseWindow/browseTopic）；ambient shard 与其它
 * 轮不携带，即无浏览授权。
 * 自由活动模式（2026-11-05，freeGroups 专用白名单）：命中的群不走 closed/open 节拍，
 * 由宿主经 deps.freeOf 声明后**恒为 open**：`isOpen` 恒 true（相位还没建也认），
 * `collectShard` 懒建相位并总是收，拍长取 engage.freeSeconds（缺省 60 秒，每 tick 现读，
 * 由既有的 1 秒 tick 驱动而不是自续定时器——热改才能在下一拍生效）。非 @ 消息按期合并成
 * 一轮 ambient；空拍不提交，只在空拍且会话不忙时掷一次自主门
 * （engage.freeBrowseChance，宵禁恒关），门开才回调 onFreeIdle（宿主提交「主动交流机会」）。
 * 单拍超限（engage.freeBatchMax）在收集时丢最旧并计数，flush 时留一行日志——这是本模式
 * 唯一的有损点。有 pending @ 组时 yieldTo 返回 true，本拍让行、不掷门。自由群不结算 T8
 * 沉默簿记（不进入 open/closed 迁移，spokeInWindow/silentWindows 恒为初值）。
 *
 * 相位、lastCloseSeq 与 shard 收集器都只活在内存里：重启回到 closed 从零计时，与
 * debounce 的 pending 同一个取舍——宁可少说一句，不补陈年旧话。沉默计数同生命周期，
 * stop 清相位时一并归零。
 */
import { createHash } from "node:crypto";
import { isCurfewAt } from "./curfew.ts";
import { VIDEO_TOPICS } from "../external/video-browse.ts";
import type { QuotedMessage } from "./onebot.ts";

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

/** shard 收集器里的一条：多带 bypass 段（沿用整组语义，取整拍里最近一条非空的），
 *  以及批内回复关系（replyIds 渲染 [回复了m:id]，quoted 在列表后渲染 [引用原文]）。 */
export interface EngageShardItem extends EngageBacklogItem {
  payload?: string;
  replyIds?: readonly string[];
  quoted?: QuotedMessage;
}

/** 每 tick 现读的窗口参数（宿主从 fishConfig().config 现取）。 */
export interface EngageTickConfig {
  closedMinutes: number;
  openMinutes: number;
  /** open 态分片节拍（秒，engage.shardSeconds）：每拍排程时现读，热加载下一拍生效。 */
  shardSeconds: number;
  /** open 窗随机门概率（ammo.shareChance）：开窗挷一次，窗内不变；缺省 0 = 门恒关（fail closed）。
   *  弹药管线已停用（T3），保留为兼容字段。 */
  ammoShareChance?: number;
  /** open 窗视频浏览门概率（video.browseChance）：开窗挷一次并选定 topic，窗内不变；
   *  缺省 0 = 门恒关（fail closed，零新增主动轮不提交）。 */
  videoBrowseChance?: number;
  /** 自由活动模式的拍长（秒，engage.freeSeconds）：缺省 60，每 tick 现读热生效。
   *  可选是为了兼容旧调用形状（不传即按缺省走）。 */
  freeSeconds?: number;
  /** 自由群空拍的自主开口概率（engage.freeBrowseChance）：缺省 0.03，宵禁内恒关。 */
  freeBrowseChance?: number;
  /** 自由群单拍收集上限（条，engage.freeBatchMax）：缺省 50，超出丢最旧并计数。 */
  freeBatchMax?: number;
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
  /** 该群是否处于自由活动模式（engage.freeGroups ∩ GROUPS）；缺省 = 否（走开窗节拍）。 */
  freeOf?(chatKey: string): boolean;
  /** 自由群空拍且自主门开时的回调：宿主提交「主动交流机会」轮（browseWindow/browseTopic 用
   *  传进来的 gate）。门没开不回调；忙 / 让行时不掷门也不回调。 */
  onFreeIdle?(chatKey: string, gate: { windowId: string; topic: string }): void | Promise<void>;
  /** 自由群本拍是否让行（有正在攒的 @ 组）：true 时本拍不提交、不掷门，消息顺延到下一拍。 */
  yieldTo?(chatKey: string): boolean;
  /** 每 tick 现读：窗口时长都从这里来（无消息也生效）。 */
  config(): EngageTickConfig;
  now?: () => number;
  setTimer?: (flush: () => void, ms: number) => EngageTimer;
  clearTimer?: (timer: EngageTimer) => void;
  /** tick 周期（默认 1000ms）；留参数只为验证时注入。 */
  tickMs?: number;
  /** shard 时长覆盖（毫秒）；缺省每拍现读 config().shardSeconds（缺省 20 秒）。留参数只为验证时注入。 */
  shardMs?: number;
  /** 自由拍时长覆盖（毫秒）；缺省每拍现读 config().freeSeconds（缺省 60 秒）。留参数只为验证时注入。 */
  freeMs?: number;
  /** 随机门 RNG 注入（内联验证用）；缺省 Math.random。 */
  random?: () => number;
  /** 启动/停止等状态机自身事件的日志出口；缺省静默。 */
  log?: (message: string) => void;
  /** onPhase / onShard 回调与 tick 的异常出口；缺省静默（状态机自身永不抛错中断循环）。 */
  onError?: (error: unknown) => void;
}

export interface EngageNext {
  /** 开始 tick 循环（幂等）；tick 自行消化窗口时长热改。 */
  start(): void;
  /** 停止 tick 并清掉全部群相位与 shard 收集器：下次 start 从 closed 零计时重来。 */
  stop(): void;
  /** 该群是否处于 open 窗；自由活动模式的群恒 true（相位还没建也认）。
   *  未跟踪（未 start / 白名单外）= closed。 */
  isOpen(chatKey: string): boolean;
  /** 该群当前相位；自由活动模式恒 open；未跟踪返回 undefined（观测用）。 */
  phaseOf(chatKey: string): EngagePhase | undefined;
  /**
   * 往当前 open 窗的 shard 收集器里塞一条 free_pass 消息（宿主路由）；
   * 自由群的相位懒建并总是收；closed / 未跟踪 / 未接 onShard 时返回 false（宿主丢弃并留日志）。
   */
  collectShard(chatKey: string, message: EngageShardItem): boolean;
  /**
   * 零出口观测上报（旧 T8 nudge，已停用）：宿主已不再调用（空窗不由沉默触发）；
   * 保留为兼容接口，内部账照旧自洽，不要据此重新接回 nudge。
   */
  noteExit(chatKey: string): void;
  /** 该群当前连续全程零出口的 open 窗数（旧 T8 nudge 档位依据）；宿主无消费方，仅诊断可见。 */
  silenceOf(chatKey: string): number;
  /**
   * 当前 open 窗的分享门（E5，兼容保留）：windowId + 开窗时一次挷出的门结果；closed / 未跟踪 /
   * 白名单外 = undefined（出口层的 ammoId 链据此拒绝且不占额度）。
   */
  shareGateOf(chatKey: string): { windowId: string; open: boolean } | undefined;
  /**
   * 当前 open 窗的视频浏览门（T3）：与 shareGateOf 同一枚稳定 windowId + 开窗时一次挷出的
   * browseChance 结果与随机选定的 topic；closed / 未跟踪 / 白名单外 = undefined（宿主与工具侧
   * 据此拒绝零新增主动轮与一切浏览授权）。
   */
  videoBrowseGateOf(chatKey: string): { windowId: string; topic: string; open: boolean } | undefined;
}

interface GroupPhase {
  phase: EngagePhase;
  phaseSince: number;
  /** 上次关窗时 recent 末条 arrivalSeq：open 进入据此取积压。 */
  lastCloseSeq?: number;
  /** open 态的 shard 收集器：待提交消息 + 自续定时器；关窗 / stop 时清掉。 */
  shard?: { messages: EngageShardItem[]; timer?: EngageTimer };
  /** 连续全程零出口的 open 窗数（T8）：窗内有 ambient/injection 轮开口即清零。 */
  silentWindows: number;
  /** 本 open 窗内是否已有 ambient/injection 轮开口（settle 观测，关窗时结算归位）。 */
  spokeInWindow: boolean;
  /** 本窗稳定 windowId（E5，chatKey+开窗时刻派生）：窗内恒定，关窗作废。 */
  windowId?: string;
  /** 本窗随机门结果（E5，兼容保留）：开窗进入时一次落定，窗内不变。 */
  shareOpen?: boolean;
  /** 本窗视频浏览门结果（T3）：开窗进入时一次挷落定，窗内不变，关窗作废。 */
  videoBrowseOpen?: boolean;
  /** 本窗视频浏览 topic（T3）：开窗进入时从 VIDEO_TOPICS 随机选定，窗内稳定，关窗作废。 */
  videoTopic?: string;
  /** 自由活动模式的上一次拍时刻（毫秒）：拍长由 1 秒 tick 现读配置比对，热改下一拍生效。 */
  lastBeatAt?: number;
  /** 该相位当前是否由自由活动模式接管（热移出白名单时据此做窗口节拍交还）。 */
  free?: boolean;
  /** 本拍因超限被丢弃的最旧消息条数（flush 时打一行日志后归零）。 */
  droppedSinceBeat?: number;
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

  /** 该群是否走自由活动模式（宿主按 freeGroups ∩ GROUPS 判定；缺省 = 否）。 */
  const isFree = (chatKey: string): boolean => deps.freeOf?.(chatKey) === true;
  /** 自由拍时长（毫秒）：验证注入优先；否则每拍现读 engage.freeSeconds（缺省 60，热改下一拍生效）。 */
  const freeMsOf = (): number => deps.freeMs ?? (deps.config().freeSeconds ?? 60) * 1000;
  /** 自由拍收集上限（条）：缺省 50，超出丢最旧并计数。 */
  const freeCapOf = (): number => Math.max(1, Math.floor(deps.config().freeBatchMax ?? 50));

  const phases = new Map<string, GroupPhase>();
  let running = false;
  let timer: EngageTimer | undefined;

  /** 浏览门作废：自由群每拍开头清一次，窗口模式仍只在关窗时清。 */
  const clearBrowseGate = (state: GroupPhase): void => {
    state.windowId = undefined;
    state.videoBrowseOpen = undefined;
    state.videoTopic = undefined;
  };

  /** 自由群的相位：懒建并恒为 open（不进入 open/closed 迁移，也不结算 T8 沉默簿记）。
   *  热加入白名单时接管：摘掉窗口模式残留的 shard 自续定时器（消息保留，改由自由拍提交），
   *  相位重置为本刻起的 open，浏览门作废。 */
  const ensureFreeState = (chatKey: string, at: number): GroupPhase => {
    let state = phases.get(chatKey);
    if (!state) {
      state = { phase: "open", phaseSince: at, lastBeatAt: at, free: true, silentWindows: 0, spokeInWindow: false };
      phases.set(chatKey, state);
      deps.log?.(`自由活动模式启动 ${chatKey}`);
      return state;
    }
    if (state.free !== true || state.phase !== "open") {
      // 窗口模式的 20 秒自续定时器必须摘掉：它只看 phase，接管后仍会按 20 秒冲刷
      if (state.shard?.timer !== undefined) {
        clearTimer(state.shard.timer);
        state.shard.timer = undefined;
      }
      const carried = state.shard?.messages.length ?? 0;
      state.free = true;
      state.phase = "open";
      state.phaseSince = at;
      state.lastBeatAt = at;
      // 上次关窗基线在这里重钉：移出自由模式后第一个真正的 open 窗才不会拿陈年流水当积压
      state.lastCloseSeq = lastSeqOf(deps.recentOf(chatKey));
      clearBrowseGate(state);
      state.shareOpen = undefined;
      deps.log?.(`自由活动模式接管 ${chatKey}（承接 ${carried} 条）`);
    }
    state.lastBeatAt ??= at;
    return state;
  };

  /** 从自由模式移回窗口模式（热移出白名单）：改走 open 态的 20 秒 shard，不补开窗注入轮
   *  （收集器里的消息就是本窗的待提交批次，由 shard 定时器接手）。 */
  const handOffToWindow = (chatKey: string, state: GroupPhase, at: number): void => {
    state.free = false;
    state.phase = "open";
    state.phaseSince = at;
    state.lastBeatAt = undefined;
    state.lastCloseSeq = lastSeqOf(deps.recentOf(chatKey));
    clearBrowseGate(state);
    state.shareOpen = undefined;
    deps.log?.(`自由活动模式移出 ${chatKey}：回到 20 秒 shard`);
    if (state.shard?.timer !== undefined) {
      clearTimer(state.shard.timer);
      state.shard.timer = undefined;
    }
    scheduleShard(chatKey, state);
  };

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

  /** 丢弃收集器里未提交的消息（关窗时忙 / stop）：宁少勿答，但必须留痕。 */
  const dropShard = (state: GroupPhase, chatKey: string, why: string): void => {
    if (state.shard && state.shard.messages.length > 0) {
      deps.log?.(`搭话 shard 丢弃 ${chatKey} ${state.shard.messages.length} 条（${why}）`);
    }
    clearShard(state);
  };

  /** shard 到期：会话忙就不提交（消息累积并入下一拍，背压）；final 只在关窗收尾时为 true。
   *  提交成功才算数：onShard 同步抛错或 Promise reject（onError 路径）时，整拍消息原子放回
   *  收集器队首（保持到达序）并入下一拍，绝不丢；收集器已被关窗清掉就重建承接
   *  （下次开窗的 scheduleShard 会复用并补交；stop 后的整份清除仍按既有语义丢弃）。 */
  const flushShard = (chatKey: string, state: GroupPhase, final: boolean): void => {
    const shard = state.shard;
    if (!shard || shard.messages.length === 0) return;
    if (deps.busy(chatKey)) {
      if (final) dropShard(state, chatKey, "关窗时会话忙");
      return;
    }
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

  /** 自由群的自主门：只在空拍且不忙时掷一次（严格小于：概率 0 永不开放）。
   *  windowId 用 free- 前缀，语义只是「本拍的浏览授权」；宵禁由调用方提前拦掉。 */
  const rollFreeBrowse = (chatKey: string, state: GroupPhase, at: number): { windowId: string; topic: string; open: boolean } => {
    const topic = VIDEO_TOPICS[Math.floor(random() * VIDEO_TOPICS.length)] ?? VIDEO_TOPICS[0]!;
    const windowId = "free-" + createHash("sha256").update(chatKey + "@" + String(at)).digest("hex").slice(0, 16);
    const open = random() < (deps.config().freeBrowseChance ?? 0.03);
    state.windowId = windowId;
    state.videoTopic = topic;
    state.videoBrowseOpen = open;
    return { windowId, topic, open };
  };

  /** 自由群一拍（由 1 秒 tick 比对 lastBeatAt 驱动，热改下一拍生效）：
   *  - 在途（轮 / 换页 / 收图）→ 本拍作废，消息留到下一拍，不掷门；
   *  - 有正在攒的 @ 组 → 让行，不提交不掷门；
   *  - 有消息 → 提交一拍 ambient（背压与失败回收沿用 flushShard），超限丢弃条数留日志；
   *  - 空拍 → 宵禁外掷一次自主门，门开才回调 onFreeIdle。 */
  const freeBeat = (chatKey: string, state: GroupPhase, at: number): void => {
    state.lastBeatAt = at;
    if (deps.busy(chatKey)) return;
    if (deps.yieldTo?.(chatKey) === true) return;
    clearBrowseGate(state);
    state.shareOpen = undefined;
    if ((state.shard?.messages.length ?? 0) > 0) {
      const dropped = state.droppedSinceBeat ?? 0;
      const size = state.shard?.messages.length ?? 0;
      deps.log?.(`自由拍 ${chatKey} 提交 ${size} 条`);
      if (dropped > 0) deps.log?.(`自由拍 ${chatKey} 超限丢弃 ${dropped} 条`);
      state.droppedSinceBeat = 0;
      flushShard(chatKey, state, false);
      return;
    }
    // 宵禁（本地 02:00–09:00）：不掷门、不回调——夜里回复照常，只是不自己起话题
    if (isCurfewAt(at)) return;
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
    // 分享门随窗作废（E5，兼容保留）：closed 后 shareGateOf 必须 undefined，出口层拒无可拒
    state.windowId = undefined;
    state.shareOpen = undefined;
    // 视频浏览门同生命周期（T3）：关窗即作废，下窗重掷重选 topic
    state.videoBrowseOpen = undefined;
    state.videoTopic = undefined;
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
    // 严格小于（终验 #5 修复）：random() 会精确返回 0，<= 会让 shareChance=0 在 RNG=0 时
    // 错误开门；< 之后 0 永不开放、1 全开放（random() ∈ [0,1) 恒 < 1）。
    state.shareOpen = random() < (deps.config().ammoShareChance ?? 0);
    // 视频浏览门（T3）：复用同一枚稳定 windowId 与 random 注入点，每窗只掷一次
    // video.browseChance（严格小于：0 永不开放），并随机选定本窗 topic——同窗稳定，
    // 空窗零新增轮与 T4 的浏览工具都只认这一份结果，不重掷。
    // 宵禁（本地 02:00–09:00，src/curfew.ts）：门恒关——夜间纯搭话，不起主动轮、
    // 不逛 B 站、不分享视频素材；关闸落在门上，没有 browse 授权时 bili_hot /
    // 分享视频的链接也自然拿不到（没有浏览结果就没有可发的 URL）。先掷再判，
    // 保证同一随机序列不因宵禁而串位（窗内 topic 可重现）。
    const browseRoll = random();
    state.videoTopic = VIDEO_TOPICS[Math.floor(random() * VIDEO_TOPICS.length)] ?? VIDEO_TOPICS[0]!;
    state.videoBrowseOpen = !isCurfewAt(at) && browseRoll < (deps.config().videoBrowseChance ?? 0);
    // 新窗从零观测开口（上一窗已在关窗时结算）；沉默计数跨窗保留，开口才清零
    state.spokeInWindow = false;
    // 忙（在途轮 / 换页 / 收图）时放弃注入（宁少勿答）；backlogOf 由宿主提供
    const backlog = deps.busy(chatKey) ? [] : (deps.backlogOf?.(chatKey, state.lastCloseSeq) ?? []);
    // open 进入即启动分片计时：free_pass 消息从这一刻起逐拍合并提交
    scheduleShard(chatKey, state);
    fire(chatKey, "open", backlog);
  };

  const tick = (): void => {
    const { closedMinutes, openMinutes } = deps.config();
    const at = now();
    for (const chatKey of deps.groups()) {
      // 自由活动模式：恒 open，只有拍长（1 秒 tick 现读配置比对）；不进 closed/open 迁移
      if (isFree(chatKey)) {
        const free = ensureFreeState(chatKey, at);
        if (free.lastBeatAt !== undefined && at - free.lastBeatAt >= freeMsOf()) freeBeat(chatKey, free, at);
        continue;
      }
      let state = phases.get(chatKey);
      // 热移出自由白名单：把拍子交还给窗口模式（20 秒 shard），不补开窗注入轮
      if (state?.free === true) {
        handOffToWindow(chatKey, state, at);
        continue;
      }
      if (!state) {
        // 初次进入（start / stop 后重来）：closed 从零计时，基线懒定 recent 末条
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
      // 自由活动模式恒可搭话：相位还没建（启动首秒）也认，否则那 1 秒的非 @ 消息会被闸丢掉
      return isFree(chatKey) || phases.get(chatKey)?.phase === "open";
    },
    phaseOf(chatKey) {
      if (isFree(chatKey)) return "open";
      return phases.get(chatKey)?.phase;
    },
    collectShard(chatKey, message) {
      if (!shardEnabled) return false;
      let state = phases.get(chatKey);
      if (!state || state.phase !== "open") {
        // 自由群懒建相位（启动首秒 / 相位被 stop 清掉后的第一条）：窗口模式仍是「窗口关了就不收」
        if (!isFree(chatKey)) return false;
        state = ensureFreeState(chatKey, now());
      }
      const shard = (state.shard ??= { messages: [] });
      shard.messages.push(message);
      // 自由拍有界：超出上限丢最旧并计数（flush 时留一行日志）——本模式唯一的有损点
      if (isFree(chatKey)) {
        const cap = freeCapOf();
        const over = shard.messages.length - cap;
        if (over > 0) {
          shard.messages.splice(0, over);
          state.droppedSinceBeat = (state.droppedSinceBeat ?? 0) + over;
        }
      }
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
    videoBrowseGateOf(chatKey) {
      const state = phases.get(chatKey);
      if (!state || state.phase !== "open" || state.windowId === undefined || state.videoTopic === undefined) return undefined;
      return { windowId: state.windowId, topic: state.videoTopic, open: state.videoBrowseOpen === true };
    },
  };
}
