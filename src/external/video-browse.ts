/**
 * 视频浏览 topic 枚举与当前轮 viewed 登记（2026-11-04 模型输入计划 T3；
 * 2026-11-06 开窗两态退役：浏览门单例查询已删，授权由 RoundTrigger 直接携带）。
 *
 * 浏览授权：engage-next 空拍掷门（engage.freeBrowseChance）→ onFreeIdle → 宿主把
 * browseWindow/browseTopic 钉上 RoundTrigger（submitBrowseOpportunity）；ambient 拍
 * 与其它轮一律不携带——工具与出口侧不需要查询任何全局门。
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
