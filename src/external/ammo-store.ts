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
 * applyAmmoSubmit 是纯函数（doc state 读改），调用方把它放进事务里保证原子。
 *
 * 状态机（外部计划 E5，决策 9）：available → claimed（claim，带 windowId 防跨窗）→
 * shared（发送成功置位）/ expired（TTL 惰性清理）。全部状态迁移都是纯函数，调用方放进
 * 事务保证原子；windowId 记账挂在条目上（claim 时打上、shared 保留），「本窗未消费外部」
 * 的唯一判据就是库里是否已有携带该 windowId 的条目——每窗最多一条由它机械保证。
 */
import { randomBytes } from "node:crypto";
import { defineDoc } from "@earendil-works/pi-durable";
import { renderTemplate } from "../prompts.ts";

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
  /** 消费窗（E5）：claim 时打上的 windowId，shared 保留——每窗一条的记账依据。 */
  windowId?: string;
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

// ── 状态机（外部计划 E5）：claim / markShared / TTL 惰性清理 ────────────────────

/**
 * TTL 惰性清理：available/claimed 且到 ttlAt → expired（claimed 未发出的也过期——
 * 长期滞留 claimed 只会堵死分享面，TTL 是统一回收点；shared 已消费，保留作历史）。
 * 纯函数返回是否有改动；读路径（开窗挑选）与写路径（claim）都顺手调它。
 */
export function applyAmmoSweep(doc: ExternalAmmoState, nowMs: number): boolean {
  let touched = false;
  for (const item of doc.items) {
    if ((item.state === "available" || item.state === "claimed") && nowMs >= item.ttlAt) {
      item.state = "expired";
      touched = true;
    }
  }
  return touched;
}

export type AmmoClaimOutcome =
  | { status: "ok"; item: ExternalAmmoItem }
  | { status: "missing" }
  | { status: "not_available" }
  | { status: "window_used"; windowId: string };

/**
 * 原子 claim（纯函数，调用方放进事务）：惰性 sweep → 本窗未消费检查（库里已有携带该
 * windowId 的条目 = 本窗已消费，含 shared/过期残留）→ 条目必须 available → 置 claimed
 * 并打上 windowId。每条失败路径都不产生状态迁移（出口层据此拒绝且不占额度）。
 */
export function applyAmmoClaim(doc: ExternalAmmoState, itemId: string, windowId: string, nowMs: number): AmmoClaimOutcome {
  applyAmmoSweep(doc, nowMs);
  if (doc.items.some((item) => item.windowId === windowId)) {
    return { status: "window_used", windowId };
  }
  const item = doc.items.find((entry) => entry.id === itemId);
  if (item === undefined) return { status: "missing" };
  if (item.state !== "available") return { status: "not_available" };
  item.state = "claimed";
  item.windowId = windowId;
  return { status: "ok", item };
}

/**
 * 发送成功置位（纯函数，调用方放进事务）：按 id + windowId 双匹配——跨窗或查无此条
 * 一律 no-op（emit 重放/陈旧 payload 不能改写别人的记账）。windowId 保留：本窗已消费
 * 的判据在 shared 后依然成立。
 */
export function applyAmmoShared(doc: ExternalAmmoState, itemId: string, windowId: string): boolean {
  const item = doc.items.find((entry) => entry.id === itemId && entry.windowId === windowId);
  if (item === undefined) return false;
  item.state = "shared";
  return true;
}

/** 可分享条目（只读）：available 且未过期，FIFO 取最旧——先到先分享，压 TTL 浪费。 */
export function shareableAmmoOf(doc: ExternalAmmoState, nowMs: number): ExternalAmmoItem | undefined {
  return [...doc.items]
    .filter((item) => item.state === "available" && item.ttlAt > nowMs)
    .sort((a, b) => a.pickedAt - b.pickedAt)[0];
}

/** canonical 链接（决策 9）：宿主从 doc 渲染进 payload，模型文本只作推荐语。 */
export function ammoVideoUrlOf(item: Pick<ExternalAmmoItem, "bvid">): string {
  return "https://www.bilibili.com/video/" + item.bvid;
}

// ── T13 合并口径（决策 8/P1-4）：debt 优先、external ≤1 只占剩余预算、nudge 只数 debt ──

/** 弹药段条目（宿主拼装层的中性形状；kind 缺省 = debt 旧账）。 */
export interface AmmoSectionItem {
  /** 原文（逐字不生成）；external 时是入库标题。 */
  what: string;
  who: string;
  at?: number;
  kind?: "debt" | "external";
  /** external 专用：分享时要传回的编号（缺了整行不注，防出不来锚点的死行）。 */
  ammoId?: string;
  /** external 专用：入库 topic。 */
  topic?: string;
}

/** 弹药段模板（宿主从 prompt/messages.md 直取；header 缺失整段不注）。 */
export interface AmmoSectionTemplates {
  header: string;
  debtLine: string;
  externalLine: string;
}

/** 弹药段预算：条数先截、字符预算再裁，超限丢条目不放宽（机械裁决）。 */
export interface AmmoSectionBudget {
  chars: number;
  cap: number;
}

/** 「N 天前」机械锚点：不伪造时间，拿不到时间戳退化为「之前」。 */
function ammoDaysAgo(at: number | undefined, nowMs: number): string {
  if (at === undefined) return "之前";
  const days = Math.floor((nowMs - at) / 86_400_000);
  return days >= 1 ? days + " 天前" : "之前";
}

/**
 * 弹药段渲染（纯函数，T13+E5 合并口径的唯一实现）：头 + debt 逐条一行（debtLine）+
 * external 至多一行（externalLine，独立模板）。条数先截（cap）、预算再裁；external
 * 最多 1 条且只占剩余预算（debt 满 cap 或字符预算装不下就整行不注）。返回的 count
 * 只数 debt——nudge_2 的 {{n}} 是「未兑现数」，外部库存不算欠账。空段返回空 lines
 * （整段不注入不占位）；debtLine 模板缺失时 debt 行退化不注（external 行不受牵连）。
 */
export function renderAmmoSectionOf(
  items: readonly AmmoSectionItem[],
  templates: AmmoSectionTemplates,
  budget: AmmoSectionBudget,
  nowMs: number,
): { lines: string[]; count: number } {
  const { header, debtLine, externalLine } = templates;
  const debt = items.filter((item) => item.kind !== "external");
  const external = items.find((item) => item.kind === "external");
  if (!header || (debt.length === 0 && external === undefined)) return { lines: [], count: 0 };
  const lines: string[] = [];
  let total = header.length;
  let count = 0;
  if (debtLine) {
    for (const item of debt) {
      const line = renderTemplate(debtLine, { days: ammoDaysAgo(item.at, nowMs), who: item.who, what: item.what });
      if (total + line.length > budget.chars) break;
      lines.push(line);
      total += line.length;
      count += 1;
    }
  }
  if (external !== undefined && externalLine && external.ammoId && count < budget.cap) {
    const line = renderTemplate(externalLine, { title: external.what, topic: external.topic ?? "", id: external.ammoId });
    if (total + line.length <= budget.chars) lines.push(line);
  }
  return lines.length > 0 ? { lines: [header, ...lines], count } : { lines: [], count: 0 };
}
