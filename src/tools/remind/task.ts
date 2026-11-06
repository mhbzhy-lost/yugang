/**
 * fish.reminder —— 提醒/定时任务（durable task，工具包 remind 的执行底座）。
 *
 * 不自研调度器：定时能力全部来自 pi-durable 内建的 durable task 系统——
 * `sleepUntil()` 把任务睡到时钟到点（崩溃/重启后由 Harness 恢复唤醒），到点
 * 在 `due` 相位往本会话 submit 一条注入输入（entry kind 复用 fish.engage_tick
 * 口径：计数入换页阈值、不进摘要与抽取），模型据此用 say_* 把提醒说出来。
 *
 * 清单与取消标记在 `fish.reminders` conversation doc：工具 add/cancel/list 都
 * 读写它，任务到点先查取消标记（取消即时生效于用户视角——不再开口，任务在
 * 到点时静默落终态）。一次性任务触发后从清单移除；周期任务（daily/weekly）
 * 一直留在清单里，算好下一次到点继续睡。
 */
import { defineDoc, defineTask, type Task } from "@earendil-works/pi-durable";
import { renderTemplate } from "../../prompt/index.ts";
import { MEMORY_ENGAGE_KIND } from "../../compact.ts";
import type { JsonObject } from "@earendil-works/chord";

/** 清单条目：一条活着的提醒（canceledAt 置位 = 已取消，等任务到点自清）。 */
export interface ReminderItem {
  /** fish.reminder 任务的 id（字符串化）。 */
  id: string;
  /** 首次触发时间（epoch ms）。 */
  at: number;
  /** 要做的事（add 时的 note，≤120 字）。 */
  note: string;
  /** none=一次；daily=每天同一时刻；weekly=每周同一时刻。 */
  repeat: "none" | "daily" | "weekly";
  /** 谁让设的（展示用昵称；主人私聊里就是主人）。 */
  by: string;
  /** 创建时间（epoch ms）。 */
  createdAt: number;
  /** 取消时间（epoch ms）；没有 = 还活着。 */
  canceledAt?: number;
}

export interface RemindersState {
  items: ReminderItem[];
}

/** 每会话一份的提醒清单（latest conversation doc；与 fish.outbox 同款语义）。 */
export const RemindersDoc = defineDoc<RemindersState>({
  kind: "fish.reminders",
  version: 1,
  scope: "conversation",
  history: "latest",
  fork: "current",
  initial: () => ({ items: [] }),
  checkpointWhen: () => true,
});

/** 每个会话同时存活的提醒上限（防刷屏：到点一条条说，多了就是骚扰）。 */
export const REMIND_CAP = 8;
/** 相对定时的上限：7 天内（更远的让用户到时再说）。 */
export const REMIND_MAX_AHEAD_MS = 7 * 24 * 60 * 60 * 1000;
/** note 的长度上限（码点）。 */
export const REMIND_NOTE_MAX = 120;

/** 任务输入：add 时由工具构造，随任务持久化。 */
export interface ReminderInput {
  note: string;
  at: number;
  repeat: "none" | "daily" | "weekly";
  by: string;
}

/** 相位：wait=睡到 at；due=触发（周期任务触发后再睡回 due）。 */
export type ReminderCheckpoint = { phase: "wait" } | { phase: "due" };

/** 终态回执。 */
export interface ReminderResult extends JsonObject {
  /** 最后一次触发的时间（epoch ms）；被取消的任务没有。 */
  firedAt?: number;
  /** 取消时间（epoch ms）；正常触发的任务没有。 */
  canceledAt?: number;
}

/** 任务运行需要的宿主回调（runtime 注入，全部懒取）。 */
export interface ReminderHost {
  /** 到点注入轮的文案模板（prompt/messages.md 的 reminder_due）。 */
  messages: () => Record<string, string>;
  /** 轮收束后冲一次 outbox（直接提交的轮不走 submitRound，宿主不会顺手 flush）。 */
  drain: () => Promise<void>;
  /** 日志。 */
  log: (message: string) => void;
}

/** 周期任务的下一次到点：从原始 at 按周期推进到 now 之后（不按时钟漂移）。 */
export function nextDueAt(at: number, repeat: "daily" | "weekly", now: number): number {
  const period = repeat === "daily" ? 86_400_000 : 7 * 86_400_000;
  let next = at;
  while (next <= now) next += period;
  return next;
}

/**
 * 造一个 fish.reminder 任务定义。宿主（runtime）经 FishOptions.reminderTask 注入，
 * 同一个对象既进 registry（Harness 才能跑它），又进 remind 工具的 deps（add 用）。
 */
export function makeReminderTask(host: ReminderHost): Task<ReminderInput, ReminderCheckpoint, ReminderResult, object> {
  return defineTask<ReminderInput, ReminderCheckpoint, ReminderResult, object>({
    name: "fish.reminder",
    version: 1,
    initial: () => ({ phase: "wait" }),
    phases: {
      wait: async (task, runtime, context) => {
        // 睡到 at；醒了从 due 相位继续（周期任务后续直接睡回 due）
        await runtime.sleepUntil(task.input.at, { phase: "due" }, context);
      },
      due: async (task, runtime, context) => {
        const input = task.input;
        const selfId = String(runtime.taskId);

        // 先查取消标记：取消的任务静默落终态并清出清单
        const doc = await runtime.snapshot(RemindersDoc, runtime.conversationId, context);
        const item = doc?.items?.find((i) => i.id === selfId);
        if (item?.canceledAt !== undefined) {
          await runtime.commit(async (tx) => {
            const d = await tx.doc(RemindersDoc, runtime.conversationId);
            d.items = d.items.filter((i) => i.id !== selfId);
            return {
              status: "terminal",
              outcome: { status: "aborted", reason: "canceled", result: { canceledAt: item.canceledAt } },
            };
          }, context);
          return;
        }

        // 到点注入一轮：文案模板来自 prompt/messages.md，缺了用硬兜底（不阻塞触发）
        const messages = host.messages();
        const content = renderTemplate(messages["reminder_due"] ?? "[定时任务到点] {{note}}", {
          note: input.note,
          by: input.by.length > 0 ? input.by : "大家",
        }).replaceAll("\\n", "\n");
        const conv = await runtime.conversation(runtime.conversationId, context);
        if (!conv) {
          host.log(`[鱼缸] reminder ${selfId} no conversation`);
          await runtime.commit(
            () => ({ status: "terminal", outcome: { status: "failed", error: { message: "conversation_missing" } } }),
            context,
          );
          return;
        }
        // 直接提交的轮不走 runtime 的 submitRound：不登记 triggerOf（say_* 的
        // mentions/身份闸见无触发者信息即 fail closed，提醒不需要这些）、无正文
        // 兜底（模板里已写明必须开口）、无机械提示。entry kind 用 fish.engage_tick
        // 口径：背景板非对话输入，不进摘要与记忆抽取。
        const submission = await conv.submit(
          { type: "input", content, entry: { kind: MEMORY_ENGAGE_KIND } },
          context,
        );
        const settled = await submission.wait(context);
        host.log(`[鱼缸] reminder ${selfId} fired -> ${settled.status}`);
        // 顺带把 outbox 冲出去：宿主不会在这轮结束时顺手 flush
        await host.drain().catch(() => {});

        if (input.repeat === "none") {
          // 一次性：清单出列 + 落终态，同一个 commit
          await runtime.commit(async (tx) => {
            const d = await tx.doc(RemindersDoc, runtime.conversationId);
            d.items = d.items.filter((i) => i.id !== selfId);
            return {
              status: "terminal",
              outcome: { status: "completed", result: { firedAt: runtime.now() } },
            };
          }, context);
          return;
        }
        // 周期：算下一次，继续睡（清单条目保留，repeat 描述仍成立）
        const next = nextDueAt(input.at, input.repeat, runtime.now());
        await runtime.sleepUntil(next, { phase: "due" }, context);
      },
    },
    abort: async (task, runtime, context) => {
      // Harness 关闭等场景的兜底：清单自清 + 落 aborted
      const selfId = String(runtime.taskId);
      await runtime.commit(async (tx) => {
        const d = await tx.doc(RemindersDoc, runtime.conversationId);
        d.items = d.items.filter((i) => i.id !== selfId);
        return { status: "terminal", outcome: { status: "aborted", reason: "abort" } };
      }, context);
    },
  });
}
