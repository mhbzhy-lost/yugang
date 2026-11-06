/**
 * remind —— 定时任务工具（提醒自己/群友到点做事）。
 *
 * 底座是 pi-durable 的 durable task（见 ./task.ts）：add 在同一个 commit 里
 * 建任务 + 进清单；到点由任务自己往会话注入一轮，模型用 say_* 把提醒说出来。
 * list/cancel 读写同一份 fish.reminders conversation doc；取消只是打标记，
 * 任务到点看见标记就静默了结（定时中的任务没有可用的 abort 通道）。
 *
 * 时间两种给法：at（本地时间 YYYY-MM-DD HH:MM）或 in_minutes（多少分钟后），
 * 都由模型换算；工具只做机械校验（过去的、超 7 天的、note 超长的全拒）。
 * 依赖不满足（宿主没给 reminderTask）时 factory 返回 undefined，不注册。
 */
import { defineTool, type ToolRegistration } from "@earendil-works/pi-durable";
import { renderTemplate } from "../../prompt/index.ts";
import { manifestParameters, toolFullDescription } from "../manifest.ts";
import type { ToolManifest, ToolPackageDeps } from "../types.ts";
import { REMIND_CAP, REMIND_MAX_AHEAD_MS, REMIND_NOTE_MAX, RemindersDoc } from "./task.ts";

interface RemindArgs {
  action: "add" | "list" | "cancel";
  at?: string;
  in_minutes?: number;
  note?: string;
  /** 谁让设的（昵称，add 用）：到点提醒里说明出处。 */
  by?: string;
  repeat?: "daily" | "weekly";
  id?: string;
}

/** 本地时间 YYYY-MM-DD HH:MM → epoch ms；解析失败返回 undefined。 */
function parseLocalAt(raw: string): number | undefined {
  const m = /^(\d{4})-(\d{2})-(\d{2})[ T](\d{2}):(\d{2})$/.exec(raw.trim());
  if (!m) return undefined;
  const at = new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3]), Number(m[4]), Number(m[5])).getTime();
  return Number.isFinite(at) ? at : undefined;
}

/** 触发时间换算成回执/清单里可读的本地时间串。 */
function formatAt(at: number): string {
  const d = new Date(at);
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

export function createRemindTool(manifest: ToolManifest, deps: ToolPackageDeps): ToolRegistration | undefined {
  // 宿主没装 fish.reminder 任务定义就不注册（factory 返回 undefined 的既定约定）
  const task = deps.reminderTask;
  if (!task) return undefined;
  const messages = deps.prompts.messages;

  return defineTool({
    name: manifest.name,
    description: toolFullDescription(manifest),
    callers: ["model"],
    parameters: manifestParameters<RemindArgs>(manifest),
    execute: async (args, api, context) => {
      const now = (deps.now ?? Date.now)();
      const convId = api.conversationId as number;

      if (args.action === "add") {
        const note = (args.note ?? "").trim();
        if (note.length === 0 || note.length > REMIND_NOTE_MAX) {
          throw new Error(messages["remind_note_bad"] ?? "remind_note_bad");
        }
        const by = (args.by ?? "").trim().slice(0, 24);
        const repeat: "none" | "daily" | "weekly" = args.repeat ?? "none";
        // 两种给时方式：at 绝对本地时间 / in_minutes 相对分钟
        let at: number | undefined;
        if (args.at !== undefined) at = parseLocalAt(args.at);
        else if (args.in_minutes !== undefined) {
          const mins = Number(args.in_minutes);
          if (Number.isFinite(mins) && mins > 0) at = now + Math.round(mins * 60_000);
        }
        if (at === undefined) throw new Error(messages["remind_time_bad"] ?? "remind_time_bad");
        if (at <= now + 30_000) throw new Error(messages["remind_time_past"] ?? "remind_time_past");
        if (args.at !== undefined && at - now > REMIND_MAX_AHEAD_MS) {
          throw new Error(messages["remind_time_far"] ?? "remind_time_far");
        }

        // 上限校验 + 建任务 + 进清单：同一个 commit，原子
        const id = await api.commit(async (tx) => {
          const doc = await tx.doc(RemindersDoc, convId);
          const live = doc.items.filter((i) => i.canceledAt === undefined).length;
          if (live >= REMIND_CAP) {
            throw new Error(renderTemplate(messages["remind_cap"] ?? "remind_cap", { cap: String(REMIND_CAP) }));
          }
          const taskId = await tx.createTask(
            task,
            { note, at, repeat, by },
            { ownership: { kind: "conversation" }, conversationId: convId, background: true },
          );
          doc.items.push({ id: String(taskId), at, note, repeat, by, createdAt: now });
          return String(taskId);
        }, context);
        return {
          output: [{
            type: "text",
            text: renderTemplate(messages["remind_added"] ?? "remind_added", { id, time: formatAt(at), note }),
          }],
        };
      }

      if (args.action === "list") {
        const doc = await api.snapshot(RemindersDoc, convId, context);
        const live = (doc?.items ?? []).filter((i) => i.canceledAt === undefined).sort((x, y) => x.at - y.at);
        if (live.length === 0) {
          return { output: [{ type: "text", text: messages["remind_list_empty"] ?? "remind_list_empty" }] };
        }
        const lines = live.map((i) => {
          const when = i.repeat === "none"
            ? formatAt(i.at)
            : `${i.repeat === "daily" ? "每天" : "每周"}${formatAt(i.at).slice(10)}`;
          const left = i.repeat === "none"
            ? `（还有 ${Math.max(1, Math.round((i.at - now) / 60_000))} 分钟）`
            : "";
          return renderTemplate(messages["remind_list_item"] ?? "remind_list_item", { id: i.id, when, note: i.note, left });
        });
        return {
          output: [{ type: "text", text: (messages["remind_list_header"] ?? "remind_list_header") + "\n" + lines.join("\n") }],
        };
      }

      // cancel：打取消标记，任务到点看见标记就静默了结并自清
      const id = (args.id ?? "").trim();
      if (id.length === 0) throw new Error(messages["remind_cancel_missing"] ?? "remind_cancel_missing");
      await api.commit(async (tx) => {
        const doc = await tx.doc(RemindersDoc, convId);
        const item = doc.items.find((i) => i.id === id && i.canceledAt === undefined);
        if (!item) throw new Error(messages["remind_cancel_missing"] ?? "remind_cancel_missing");
        item.canceledAt = now;
      }, context);
      return {
        output: [{ type: "text", text: renderTemplate(messages["remind_cancel_done"] ?? "remind_cancel_done", { id }) }],
      };
    },
  });
}
