/**
 * watch —— 特别关注名单（仅主人可用）。
 *
 * 主人在群里 @ 或回复鱼，点名要留意某个群友时，鱼把这个人记进**本会话**的关注名单：
 * QQ 号 + 可选称呼 + 一段自由备注（「下次见到他叫宝宝」「他是你老师」都行）。
 *
 * 名单存在会话级文档 fish.watch 里：
 *   - 换页（compact）不动它 —— 压缩只重置 transcript entries，文档是另一层
 *   - 每次请求由 harness 的 `watched` section 渲染进 system prompt —— 等同于人格书
 *
 * 身份闸：和 fs/restart 一样，靠 triggerOf 拿本轮触发的消息，非主人才拒绝。
 *
 * 说明文字与参数 Schema 唯一来自 TOOL.md manifest（factory 只消费它，不再有第二份运行时定义）。
 */
import { LiveDoc, defineTool, type ToolRegistration } from "@earendil-works/pi-durable";
import { renderTemplate } from "../../prompts.ts";
import { WatchDoc, type WatchedPerson } from "../../store.ts";
import { manifestParameters, toolFullDescription } from "../manifest.ts";
import type { ToolManifest, ToolPackageDeps } from "../types.ts";

/** args 静态类型：与 TOOL.md 的参数 Schema 一一对应；运行时 Schema 只有 manifest 这一份。 */
interface WatchArgs {
  action: "add" | "remove" | "list";
  userId?: string;
  name?: string;
  note?: string;
}

/** 主人闸是硬前提：无主人配置时 factory 返回 undefined，由注册方跳过（不进工具面）。 */
export function createWatchTool(manifest: ToolManifest, deps: ToolPackageDeps): ToolRegistration | undefined {
  if (!deps.master) return undefined;

  /** 把该会话最新名单整份推给宿主（随机门、命中注入与主动 @ 闸都要知道谁是特别关注）。 */
  async function notify(
    conversationId: string,
    read: { snapshot: (doc: typeof WatchDoc, id: string, context: unknown) => Promise<{ people?: WatchedPerson[] } | undefined> },
    context: unknown,
  ): Promise<void> {
    if (!deps.onWatchChanged) return;
    const snapshot = await read.snapshot(WatchDoc, conversationId, context);
    // 传整份名单而不是 ids：宿主侧不能增量合并，否则 remove 撤不掉旧条目
    deps.onWatchChanged(conversationId, snapshot?.people ?? []);
  }

  return defineTool({
    name: manifest.name,
    description: toolFullDescription(manifest),
    callers: ["model"],
    parameters: manifestParameters<WatchArgs>(manifest),
    execute: async (args, api, context) => {
      // 身份闸：机械判定，看本轮触发消息的 userId 是不是主人（与 fs 系列同源）
      const live = await api.snapshot(LiveDoc, api.conversationId, context);
      const round = live?.run?.inputs?.[0];
      const triggered = round !== undefined ? deps.triggerOf?.(round) : undefined;
      if (!deps.master || String(triggered?.userId ?? "") !== deps.master) {
        throw new Error(deps.prompts.messages["watch_no_master"] ?? "watch_no_master");
      }

      const list = async (): Promise<WatchedPerson[]> => {
        const snapshot = await api.snapshot(WatchDoc, api.conversationId, context);
        return snapshot?.people ?? [];
      };

      if (args.action === "list") {
        const people = await list();
        if (people.length === 0) {
          return { output: [{ type: "text", text: deps.prompts.messages["watch_empty"] ?? "watch_empty" }] };
        }
        const text = people
          .map((p) => `${p.name ? `${p.name}(${p.userId})` : p.userId}：${p.note}`)
          .join("\n");
        return { output: [{ type: "text", text }] };
      }

      const userId = (args.userId ?? "").trim();
      if (!/^\d{3,}$/.test(userId)) {
        throw new Error(deps.prompts.messages["watch_need_id"] ?? "watch_need_id");
      }

      // 撤销放在成员校验之前：退了群的人再也验不到，但撤销权限必须永远做得到
      // （名单只活在内存镜像里，撤不掉就是同进程内持续有效）。
      if (args.action === "remove") {
        let removed = false;
        await api.commit(async (tx) => {
          const doc = await tx.doc(WatchDoc, api.conversationId);
          const before = doc.people.length;
          doc.people = doc.people.filter((p) => p.userId !== userId);
          removed = doc.people.length !== before;
        }, context);
        if (removed) await notify(api.conversationId, api as never, context);
        const text = removed
          ? renderTemplate(deps.prompts.messages["watch_removed"] ?? "", { userId })
          : renderTemplate(deps.prompts.messages["watch_not_found"] ?? "", { userId });
        return { output: [{ type: "text", text }] };
      }

      // 号码校验（只约束 add）：只能关注本群真实存在的人（模型偶尔会抄错号，抄错了永远命中不了）
      const members = deps.groupMembersOf ? await deps.groupMembersOf(String(api.conversationId)) : undefined;
      if (members !== undefined) {
        if (members.length === 0) {
          throw new Error(deps.prompts.messages["watch_no_members"] ?? "watch_no_members");
        }
        if (!members.some((m) => m.userId === userId)) {
          throw new Error(renderTemplate(deps.prompts.messages["watch_unknown_member"] ?? "", { userId }));
        }
      }

      const note = (args.note ?? "").trim();
      if (!note) throw new Error(deps.prompts.messages["watch_need_note"] ?? "watch_need_note");
      const name = (args.name ?? "").trim();

      await api.commit(async (tx) => {
        const doc = await tx.doc(WatchDoc, api.conversationId);
        const existing = doc.people.find((p) => p.userId === userId);
        if (existing) {
          existing.note = note;
          existing.at = Date.now();
          if (name) existing.name = name;
        } else {
          doc.people.push({ userId, ...(name ? { name } : {}), note, at: Date.now() });
        }
        // 上限：名单是给模型读的，太长会挤占上下文
        if (doc.people.length > 20) doc.people.splice(0, doc.people.length - 20);
      }, context);

      await notify(api.conversationId, api as never, context);
      const text = renderTemplate(deps.prompts.messages["watch_added"] ?? "", {
        who: name ? `${name}(${userId})` : userId,
        note,
      });
      return { output: [{ type: "text", text }] };
    },
  });
}
