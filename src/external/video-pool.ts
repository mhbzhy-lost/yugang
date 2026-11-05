/**
 * fish.video_pool —— 会话私有视频池（2026-11-04 模型输入计划 T4）。
 *
 * 每个 **chatKey（群 / 私聊）** 一份：session scope doc，key = chatKey（2026-11-05 改绑，
 * 原来按 conversationId 隔离，导致同群换人格后又能把同一条视频发一遍）。池是「已分享过」
 * 的视频历史 + 去重表：say_words 发出含 B 站链接**或裸 BV 号**的文本时机械记账
 * （pool 写入与 outbound entry / fish.outbox 同一次提交），bili_hot 用它过滤本群
 * 已分享过的候选。换页不动 session doc，池跨页存续。
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
  /** shared = 已分享过（永久去重）；seen = 只是在本群候选里出现过（带 TTL，避免同一批反复刷）。 */
  state: "shared" | "seen";
}

export interface VideoPoolState {
  items: VideoPoolItem[];
}

/**
 * 视频去重表 doc：session scope，key = **chatKey（群号/私聊号）**，2026-11-05 起由
 * conversation scope 改绑（主人要求：同一个群里换人格也不该把同一条视频发两遍）。
 * 换页不动它，人格切换不另开表——同群共享一份去重历史。
 */
export const VideoPoolDoc = defineDoc<VideoPoolState>({
  kind: "fish.video_pool",
  version: 1,
  scope: "session",
  history: "latest",
  fork: "current",
  initial: () => ({ items: [] }),
  checkpointWhen: () => true,
});

/** 推荐语写池的截断上限（码点）：出口校验管发送文本，池内记账再收一道。 */
export const VIDEO_POOL_NOTE_MAX = 120;

/** seen 条目的存活时间：7 天后允许重新出现（榜单是慢变的，太短会反复刷同一条）。 */
export const VIDEO_SEEN_TTL_MS = 7 * 24 * 60 * 60_000;
/** seen 条目总量上限（按新到旧保留）：防止池无限增长；shared 条目不受此限。 */
export const VIDEO_SEEN_CAP = 300;

/** 当前仍生效的 seen BV 集合（读侧过滤用；过期项不参与去重）。 */
export function activeSeenOf(state: VideoPoolState | undefined, nowMs: number): Set<string> {
  const out = new Set<string>();
  for (const item of state?.items ?? []) {
    if (item.state === "seen" && nowMs - item.at <= VIDEO_SEEN_TTL_MS) out.add(item.bvid);
  }
  return out;
}

/**
 * 机械记录「已展示」候选（纯函数，调用方放进事务）：bili_hot 每次返回给模型的 BV 都记一笔，
 * 7 天后自然过期；同时清理过期的 seen 与超出上限的老 seen。shared 条目不动。
 */
export function applyVideoPoolSeen(doc: VideoPoolState, bvids: readonly string[], nowMs: number): number {
  const existing = new Set(doc.items.map((item) => item.bvid));
  let added = 0;
  for (const bvid of bvids) {
    if (existing.has(bvid)) continue;
    existing.add(bvid);
    doc.items.push({ bvid, title: "", note: "", topic: "", at: nowMs, state: "seen" });
    added += 1;
  }
  doc.items = doc.items.filter((item) => item.state !== "seen" || nowMs - item.at <= VIDEO_SEEN_TTL_MS);
  const seen = doc.items.filter((item) => item.state === "seen");
  if (seen.length > VIDEO_SEEN_CAP) {
    const drop = new Set(seen.sort((a, b) => a.at - b.at).slice(0, seen.length - VIDEO_SEEN_CAP).map((item) => item.bvid));
    doc.items = doc.items.filter((item) => !(item.state === "seen" && drop.has(item.bvid)));
  }
  return added;
}

/**
 * 去重表 key（唯一派生点）：优先 chatKey（群号/私聊号），拿不到才退回 conversationId。
 * 读写两侧必须都走这里，否则会写出「同一群两份表」的分叉。
 */
export function videoPoolKeyOf(chatKey: string | undefined, conversationId: string | number): string {
  return chatKey !== undefined && chatKey.length > 0 ? chatKey : String(conversationId);
}

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
  const existing = doc.items.find((item) => item.bvid === input.bvid);
  if (existing !== undefined) {
    // 之前只是「展示过」，现在真的分享出去了：升级成 shared（永久去重），保留原条目
    if (existing.state === "seen") {
      existing.state = "shared";
      existing.title = truncate(input.title, 60);
      existing.note = truncate(input.note, VIDEO_POOL_NOTE_MAX);
      existing.topic = input.topic;
      existing.at = nowMs;
      return { status: "ok", item: existing };
    }
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
