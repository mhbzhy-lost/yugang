/**
 * fish.external_ammo 的正式 doc 与写入口（外部计划决策 4 / Task E4）。
 *
 * 全局抓取池（决策 2）：kind=bili、会话级 session doc、人格中立——不挂任何群/人格，
 * 分享轮只按 id 认领，措辞由分享轮所在群的当前人格自然人格化。
 * 形状与 src/tools/bili_hot/tool.ts 的只读投影 ExternalAmmoReadDoc 必须严格同形
 * （kind/version/scope/字段）：bili_hot 用它剔已入库候选，本模块是唯一写入方，
 * pi-durable 对语义不符的存档当场抛错，两边谁漂移谁起不来。
 *
 * 判重口径（计划 FE4）：BV 已在库（任何状态，含 expired/claimed/shared）即拒绝——
 * 逛轮重复触发、重启补跑都不产生重复条目；本轮入库上限按 run（date + slot 的作业键，
 * jobKeyOf）计数，同一作业最多 maxPicksPerRun 条，超额拒绝。
 * applyAmmoSubmit 是纯函数（doc state 读改），调用方把它放进事务里保证原子；
 * 状态机（available → claimed → shared / expired TTL 清理）归 E5，这里只写 available。
 */
import { randomBytes } from "node:crypto";
import { defineDoc } from "@earendil-works/pi-durable";

/** 弹药 topic 枚举（计划 Task E4）：与 ammo_submit 的 TOOL.md Schema 一一对应，改动两处同步。 */
export const AMMO_TOPICS: readonly string[] = ["二次元", "游戏", "军事", "数码"];

/** topic 枚举的唯一判法（工具参数闸与其它消费方共用）。 */
export function isAmmoTopic(topic: string): boolean {
  return AMMO_TOPICS.includes(topic);
}

/** 弹药库条目（计划决策 4 的形状；run 是 E4 的作业归属键，缺省无 = 兼容旧档/只读方）。 */
export interface ExternalAmmoItem {
  id: string;
  kind: string;
  bvid: string;
  title: string;
  summary: string;
  topic: string;
  pickedAt: number;
  ttlAt: number;
  state: "available" | "claimed" | "shared" | "expired";
  /** 入库时所属逛轮的作业键（date + slot）：单轮入库上限的判据。 */
  run?: string;
}

export interface ExternalAmmoState {
  items: ExternalAmmoItem[];
}

/** 弹药库 token：与 bili_hot 的 ExternalAmmoReadDoc 同形（见文件头）。 */
export const ExternalAmmoDoc = defineDoc<ExternalAmmoState>({
  kind: "fish.external_ammo",
  version: 1,
  scope: "session",
  initial: () => ({ items: [] }),
  checkpointWhen: () => true,
});

/** 条目 id：a- + 18 位十六进制（跨条目唯一，与记忆 fact id 同风格）。 */
export function newAmmoId(): string {
  return `a-${randomBytes(9).toString("hex")}`;
}

/** 一次入库的全部输入（宿主已核验：BV 形、summary 清洗、topic 枚举、卡片补全）。 */
export interface AmmoSubmitInput {
  bvid: string;
  /** 标题：宿主经 bili-client view 端点补全并清洗过（不可信文本）。 */
  title: string;
  summary: string;
  topic: string;
  /** 逛轮作业键（date + slot）。 */
  run: string;
  /** 本轮入库上限（作业起时定格的 ammo.maxPicksPerRun）。 */
  maxPicks: number;
  /** 存活时长（小时）：ttlAt = pickedAt + ttlHours。 */
  ttlHours: number;
}

export type AmmoSubmitOutcome =
  | { status: "ok"; item: ExternalAmmoItem }
  | { status: "dup"; bvid: string }
  | { status: "full"; maxPicks: number };

/**
 * 机械入库（纯函数，调用方放进事务）：判重（任何状态的同一 BV）→ 单轮上限（同 run
 * 计数）→ 追加 available 条目。不做任何语义判断；文本字段一律由调用方先清洗。
 */
export function applyAmmoSubmit(doc: ExternalAmmoState, input: AmmoSubmitInput, nowMs: number): AmmoSubmitOutcome {
  if (doc.items.some((item) => item.bvid === input.bvid)) {
    return { status: "dup", bvid: input.bvid };
  }
  const maxPicks = Math.max(1, Math.floor(input.maxPicks));
  if (doc.items.filter((item) => item.run === input.run).length >= maxPicks) {
    return { status: "full", maxPicks };
  }
  const item: ExternalAmmoItem = {
    id: newAmmoId(),
    kind: "bili",
    bvid: input.bvid,
    title: input.title,
    summary: input.summary,
    topic: input.topic,
    pickedAt: nowMs,
    ttlAt: nowMs + Math.max(1, Math.floor(input.ttlHours)) * 3_600_000,
    state: "available",
    run: input.run,
  };
  doc.items.push(item);
  return { status: "ok", item };
}
