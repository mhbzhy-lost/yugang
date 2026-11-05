/**
 * 开窗视频浏览门与当前轮 viewed 登记（2026-11-04 模型输入计划 T3）。
 *
 * 门（VideoBrowseGate）由宿主（src/index.ts）在 engage-next 状态机每个 open 窗进入时
 * 一次性掷出（video.browseChance，同窗稳定、关窗作废），经 wireVideoBrowseHost 接线；
 * 自由活动模式的群没有窗：改在**空拍**时掷一次（engage.freeBrowseChance，windowId 是
 * `free-` 前缀的拍 id）。有消息的拍不掷；忙 / 让行的那一拍在清门之前就返回，旧门因此
 * 会多留一拍，但没有任何提交路径会消费它（只有空拍才提交机会轮），下一拍开拍即作废。
 * 工具侧只通过 videoBrowseGateOf(chatKey) 只读查询——closed / 未跟踪 / 白名单外
 * 一律 undefined（fail closed）。零新增主动轮（decisions §5.6）只在门开时提交，
 * browseWindow / browseTopic 随 RoundTrigger 钉在轮上；ambient shard 与其它轮不携带。
 *
 * viewed 登记是 T4 的窄依赖：`video` 工具在 browse 轮实际成功观看一条视频后
 * recordViewedVideo(roundId, bvid)，每轮观看上限用 viewedVideoOf(roundId)
 * 机械核对「本轮真的看过」。登记只活在当前会话当前 browse 轮：宿主在轮 settle 时
 * clearViewedVideos(roundId) 整份清掉（与 triggerOf 同生命周期），跨轮 / 跨会话一律查不到。
 *
 * 这里不放任何模型可见文案；topic 枚举 VIDEO_TOPICS 是宿主侧机械词表（掷门时随机选一，
 * T4 的 bili_hot 按它取候选），不是 prompt。
 */

/** 视频浏览 topic 枚举（宿主掷门时随机选一；T4 的 bili_hot 候选过滤消费）。 */
export const VIDEO_TOPICS: readonly string[] = ["二次元", "游戏", "军事", "数码"];

/** 当前 open 窗的浏览门：windowId = 本窗稳定标识（engage-next 派生），topic = 本窗话题，
 *  open = 掷门结果。closed / 未跟踪时宿主接线返回 undefined。 */
export interface VideoBrowseGate {
  windowId: string;
  topic: string;
  open: boolean;
}

/** 宿主接线口：gateOf 由 src/index.ts 落到 engage-next 的相位内存（单例，启动时 wire 一次）。 */
export interface VideoBrowseHost {
  gateOf(chatKey: string): VideoBrowseGate | undefined;
}

let host: VideoBrowseHost | undefined;

/** 宿主接线（src/index.ts 启动时一次）；未接线时 videoBrowseGateOf 恒 undefined（fail closed）。 */
export function wireVideoBrowseHost(wired: VideoBrowseHost): void {
  host = wired;
}

/** 只读查询当前 open 窗的浏览门；closed / 未跟踪 / 未接线 = undefined。 */
export function videoBrowseGateOf(chatKey: string): VideoBrowseGate | undefined {
  return host?.gateOf(chatKey);
}

// roundId → 本轮实际成功观看的 BV 集合：只活在当前 browse 轮，宿主轮末整份清掉。
const viewedByRound = new Map<string, Set<string>>();

/** browse 轮内登记一条实际成功观看的视频（T4 的 video 工具消费）；同轮重复登记幂等。 */
export function recordViewedVideo(roundId: unknown, bvid: string): void {
  const key = String(roundId);
  let set = viewedByRound.get(key);
  if (set === undefined) {
    set = new Set<string>();
    viewedByRound.set(key, set);
  }
  set.add(bvid);
}

/** 当前轮已实际观看的 BV 集合（video 的每轮观看上限据此计数）；没登记过 = 空集。 */
export function viewedVideoOf(roundId: unknown): ReadonlySet<string> {
  return viewedByRound.get(String(roundId)) ?? new Set<string>();
}

/** 轮末清理（宿主 submitRound 的 settle finally 调用）：viewed 只属于当前 browse 轮，跨轮不残留。 */
export function clearViewedVideos(roundId: unknown): void {
  viewedByRound.delete(String(roundId));
}
