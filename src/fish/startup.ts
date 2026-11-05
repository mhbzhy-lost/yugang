/**
 * installStartupMigrations：启动时对存量会话做两件只写 model 的修正
 * （2026-11-05 从 harness.ts 拆出）。
 *
 *  1. 映射键里的人格名已不在注册名单：打告警（人格书被删后的残留键选不到扩展）。
 *  2. 存量会话的 pi.agent 钉着启动时的 model 引用：换模型后旧引用查不到 provider，
 *     每轮直接 no_model；这里把 model 对齐回当前配置，不动 extensions/cwd。
 */
import { configure, type ConversationId, type Harness } from "@earendil-works/pi-durable";
import { ChatsDoc } from "../store.ts";
import type { FishBase } from "./base.ts";
import type { ExtensionParts } from "./extensions.ts";
import { DEFAULT_PERSONA } from "./types.ts";

export async function installStartupMigrations(
  state: FishBase & ExtensionParts & { harness: Harness },
): Promise<Record<string, never>> {
  const { harness, options, personaExtensions, ctx } = state;

  // 启动告警：映射键里的人格名已不在注册名单（人格书被删后 ChatsDoc 残留）。
  // 那个会话存的是按名绑定，名字没了就选不到任何扩展，只剩 salvage 兕底。
  {
    const registered = new Set([DEFAULT_PERSONA, ...personaExtensions.keys()]);
    const snapshot = await harness.snapshot(ChatsDoc, ctx);
    for (const key of Object.keys(snapshot?.chats ?? {})) {
      const mark = key.lastIndexOf("#");
      if (mark < 0) continue;
      const name = key.slice(mark + 1);
      if (registered.has(name)) continue;
      console.warn(`[鱼缸] 会话键 ${key} 的人格 ${name} 未注册`);
      console.warn(`  该会话失去全部 section 与工具（含 say_*）`);
    }
  }

  // 模型以部署配置为准：存量会话的 pi.agent 里钉着启动时的 model 引用。换模型后
  // registry 只注册新 provider，旧引用（如 glm）查不到 → 每轮直接 no_model。
  // 所以每次启动把已有会话的 model 对齐回当前配置；只写 model，不动 extensions/cwd。
  {
    const snapshot = await harness.snapshot(ChatsDoc, ctx);
    const ids = new Set<number>(Object.values(snapshot?.chats ?? {}).map(Number));
    for (const id of ids) {
      if (!Number.isFinite(id)) continue;
      const conversation = await harness.conversation(id as ConversationId, ctx);
      if (!conversation) continue;
      await harness.commit(async (tx) => {
        await configure(tx, id as ConversationId, {
          model: options.model,
          ...(options.thinkingLevel ? { thinkingLevel: options.thinkingLevel } : {}),
        });
      }, ctx);
    }
  }

  return {};
}
