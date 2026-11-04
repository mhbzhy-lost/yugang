/**
 * fish.video_pool —— 会话私有视频池（2026-11-04 模型输入计划 T4）。
 *
 * 每个 conversation（群 × 当前人格）一份：conversation scope doc，id = conversationId
 * （OutboxDoc / WatchDoc 同款先例），跨会话天然隔离——同一个 BV 在两个会话的池里
 * 互不相干，不建立全局库存、不做 claim 竞争。池是「已实际看过且模型选择分享」的
 * 视频历史 + 去重表：say_words(videoBvid) 的原子事务里写入（pool 写入、canonical
 * 链接、fish.outbox 入队、outbound entry 同一 transaction），bili_hot 用它过滤本
 * 会话已分享过的候选。换页（compact/reset）不动 conversation doc，池跨页存续。
 *
 * 池不设 TTL、不淘汰：条目只在实际分享成功时追加（每窗至多一条），量级极小；
 * 淘汰会破坏「同会话 BV 去重」的历史完整性，得不偿失。
 *
 * 文件尾部另有一个**仅进程内**的 browse 轮已看视频标题缓存：video 工具实际观看成功
 * 时 rememberViewedVideoTitle(roundId, bvid, title)，say_words 分享事务从它取清洗后
 * 的标题写进池条目（viewed BV 集合本身在 video-browse.ts，这里只补标题元数据，
 * 不重复记账）。生命周期与 viewed 登记一致（轮末宿主清 viewed，这里的残留条目
 * 无害且有界：轮数超过 VIDEO_TITLE_CACHE_CAP 丢最老，registerAmmoShare 同款防泄漏
 * 惯用法；重启即清空，不伪造已看记录）。
 *
 * 这里不放任何模型可见文案。
 */
import { defineDoc } from "@earendil-works/pi-durable";

/** 池条目：BV + 清洗后的标题 + 鱼的推荐语 + 分享时的 topic + 时间 + 状态。 */
export interface VideoPoolItem {
  /** 已通过 isValidBvid 校验的 BV 号。 */
  bvid: string;
  /** 清洗后的视频标题（sanitizeExternalText ≤60；拿不到标题时为空串）。 */
  title: string;
  /** 鱼的推荐语（模型文本，写池前机械截断 ≤ VIDEO_POOL_NOTE_MAX）。 */
  note: string;
  /** 分享发生时 browse 窗选定的 topic（VIDEO_TOPICS 之一）。 */
  topic: string;
  /** 入库时间（ms）。 */
  at: number;
  /** 状态：目前唯一写入路径是分享事务，恒为 shared；字段保留作后续扩展。 */
  state: "shared";
}

export interface VideoPoolState {
  items: VideoPoolItem[];
}

/**
 * 会话私有视频池 doc：conversation scope（id = conversationId），按会话隔离去重；
 * history/fork 语义与 WatchDoc 一致——换页不动它，人格切换后是另一会话另一份池。
 */
export const VideoPoolDoc = defineDoc<VideoPoolState>({
  kind: "fish.video_pool",
  version: 1,
  scope: "conversation",
  history: "latest",
  fork: "current",
  initial: () => ({ items: [] }),
  checkpointWhen: () => true,
});

/** 推荐语写池的截断上限（码点）：出口校验管发送文本，池内记账再收一道。 */
export const VIDEO_POOL_NOTE_MAX = 120;

/** canonical B 站链接（宿主拼进 payload 的唯一来源，模型不写 URL；ammoVideoUrlOf 同款）。 */
export function videoUrlOf(bvid: string): string {
  return "https://www.bilibili.com/video/" + bvid;
}

/** 一次写池的全部输入（调用方已核验：BV 形、本轮实际看过、title/note 清洗）。 */
export interface VideoPoolAddInput {
  bvid: string;
  title: string;
  note: string;
  topic: string;
}

export type VideoPoolAddOutcome = { status: "ok"; item: VideoPoolItem } | { status: "dup"; bvid: string };

/** 按码点截断（不劈开代理对）；非字符串一律空串。 */
function truncate(text: unknown, max: number): string {
  if (typeof text !== "string") return "";
  const trimmed = text.trim();
  if ([...trimmed].length <= max) return trimmed;
  return [...trimmed].slice(0, max).join("");
}

/**
 * 机械写池（纯函数，调用方放进事务）：同会话 BV 判重 → 追加 shared 条目。
 * 判重命中返回 dup 且不改状态——重复分享同一条视频不产生重复条目（去重池语义），
 * 调用方（say_words）把 dup 当成功处理：链接照发、池不动。不做任何语义判断；
 * title/note 由调用方先清洗，这里再做机械截断兜底。
 */
export function applyVideoPoolAdd(doc: VideoPoolState, input: VideoPoolAddInput, nowMs: number): VideoPoolAddOutcome {
  if (doc.items.some((item) => item.bvid === input.bvid)) {
    return { status: "dup", bvid: input.bvid };
  }
  const item: VideoPoolItem = {
    bvid: input.bvid,
    title: truncate(input.title, 60),
    note: truncate(input.note, VIDEO_POOL_NOTE_MAX),
    topic: input.topic,
    at: nowMs,
    state: "shared",
  };
  doc.items.push(item);
  return { status: "ok", item };
}

// ── browse 轮已看视频标题缓存（仅进程内；viewed BV 集合在 video-browse.ts） ──────

/** 轮数上限：超过丢最老的轮（防泄漏，与 registerAmmoShare 的 100 条上限同款取舍）。 */
const VIDEO_TITLE_CACHE_CAP = 100;

const titlesByRound = new Map<string, Map<string, string>>();

/** video 工具实际观看成功后登记标题（清洗过的 ≤60 字）；同轮同 BV 覆盖幂等。 */
export function rememberViewedVideoTitle(roundId: unknown, bvid: string, title: string): void {
  const key = String(roundId);
  let titles = titlesByRound.get(key);
  if (titles === undefined) {
    titles = new Map<string, string>();
    titlesByRound.set(key, titles);
    while (titlesByRound.size > VIDEO_TITLE_CACHE_CAP) {
      const oldest = titlesByRound.keys().next().value;
      if (oldest === undefined) break;
      titlesByRound.delete(oldest);
    }
  }
  titles.set(bvid, title);
}

/** say_words 分享事务取标题写池；没登记过（拿不到轮标识等）返回空串，不阻塞分享。 */
export function viewedVideoTitleOf(roundId: unknown, bvid: string): string {
  return titlesByRound.get(String(roundId))?.get(bvid) ?? "";
}
