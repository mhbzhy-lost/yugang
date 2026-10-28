/**
 * 把 pi-durable 组装成「鱼」。
 *
 * 一只鱼身上只有：
 *   一张嘴  say               唯一出口，硬校验
 *   手写的工具（src/tools/）  能力扩展的唯一方式——没有 shell、没有文件读取、没有 MCP
 *
 * 一个 Conversation = 一个 QQ 群，自带 cwd，互不串。
 */
import { mkdirSync } from "node:fs";
import { join, resolve } from "node:path";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { createModels, type Models } from "@earendil-works/pi-ai/models";
import {
  Harness,
  createRegistry,
  defineEntry,
  defineExtension,
  section,
  type Conversation,
  type ConversationId,
  type Storage,
} from "@earendil-works/pi-durable";
import { DEFAULT_LIMITS, REJECTION_CODES, type EgressLimits } from "./egress/policy.ts";
import { createSayTool, OutboundEntry, type OutboundPayload } from "./egress/say.ts";
import { createReactTool } from "./egress/react.ts";
import { loadPrompts, renderTemplate, type PromptSet } from "./prompts.ts";
import { createTools } from "./tools/index.ts";
import { createCompactor, type CompactResult, type Compactor } from "./compact.ts";
import { ChatsDoc, OutboxDoc } from "./store.ts";

/** 群档案作为一条 system 消息放进 transcript，只在建会话时写一次。 */
export const GroupProfileEntry = defineEntry("fish.group-profile");

const ctx = BACKGROUND_CONTEXT;

export interface GroupProfile {
  name: string;
  groupId: string;
  count: number;
  owner: string;
  master: string;
  members: { nickname: string; userId: string }[];
}

export interface ModelRef {
  provider: string;
  modelId: string;
}

export interface FishOptions {
  storage: Storage;
  models?: Models;
  model: ModelRef;
  /** prompt 目录：人格、工具说明、工具文案。 */
  promptRoot: string;
  /** 媒体白名单根目录（发图只能发这里面的）。 */
  mediaRoot: string;
  /** DeepSeek Search API 的 key；给了才有联网搜索能力。 */
  searchKey?: string;
  /** 主人 QQ：fs/restart 自改工具的身份闸，给了才注册这些工具。 */
  master?: string;
  /** submissionId → 本轮触发消息；把回复引用绑在轮上，防串线。 */
  triggerOf?: (roundId: unknown) => { messageId?: number | string; mentionsBot: boolean; userId?: number } | undefined;
  /** 每个群的工作目录根；实际 cwd 是 <workspaceRoot>/<groupKey>。 */
  workspaceRoot: string;
  limits?: Partial<Omit<EgressLimits, "mediaRoot">>;
  /** 上下文压缩：攒到阈值就 reset + handoff。不给就不压。 */
  compact?: {
    model?: ModelRef;
    maxEntries?: number;
    maxChars?: number;
  };
  emit: (conversationId: ConversationId, payload: OutboundPayload) => void | Promise<void>;
  /** 贴表情回应，只带表情编号；目标消息由宿主自己记。 */
  react: (conversationId: ConversationId, emoji: string) => void | Promise<void>;
  now?: () => number;
}

export interface Fish {
  harness: Harness;
  models: Models;
  prompts: PromptSet;
  /** 实际的 harness settings，便于审查（compaction 必须为 false）。 */
  settings: { compaction: { enabled: boolean } };
  toolNames: string[];
  /** 压缩一次上下文；没到阈值就什么都不做。 */
  compact(conversation: Conversation): Promise<CompactResult>;
  /** 取（或创建）某个群的会话；映射持久化，重启后还是同一个会话。 */
  group(groupKey: string, profile?: GroupProfile): Promise<Conversation>;
  /** 把 outbox 里排队的消息发出去；返回实际发了几条。 */
  drain(extra?: readonly ConversationId[]): Promise<number>;
  /** 不经模型直接往 outbox 里排队一条（宿主侧机械回复专用，同样走唯一出口）。 */
  enqueue(conversationId: ConversationId, payload: OutboundPayload): Promise<void>;
  /** 有意重启后的恢复：把卡在 sending 的消息翻回 queued（配合 restart.marker 使用）。 */
  recoverStaleSends(): Promise<number>;
  close(): Promise<void>;
}

export async function openFish(options: FishOptions): Promise<Fish> {
  const models = options.models ?? createModels();
  const now = options.now ?? Date.now;
  const mediaRoot = resolve(options.mediaRoot);
  const workspaceRoot = resolve(options.workspaceRoot);
  const limits: EgressLimits = { ...DEFAULT_LIMITS, ...options.limits, mediaRoot };

  const prompts = loadPrompts(resolve(options.promptRoot));
  for (const code of [...REJECTION_CODES, "say_sent", "say_once", "busy_reply"]) {
    if (!prompts.messages[code]) throw new Error(`prompt/messages.md 缺少文案：${code}`);
  }

  const say = createSayTool({ limits, prompts, now, triggerOf: options.triggerOf });
  const react = createReactTool({ prompts, react: options.react, now });
  const tools = createTools({ mediaRoot, prompts, searchKey: options.searchKey, master: options.master, triggerOf: options.triggerOf });

  // 启动即校验：每个工具都必须有一份 prompt/tools/<name>.md，缺了就起不来
  for (const tool of [say, react, ...tools]) {
    if (!prompts.tools[tool.name]) {
      throw new Error(`缺少 prompt/tools/${tool.name}.md`);
    }
  }

  const Fish = defineExtension({
    name: "fish",
    tools: [say, react, ...tools],
    sections: [
      section("persona", () => prompts.persona, { tag: false }),
      // 手工维护的人物档：比对话记忆更牢，和 handoff 互补
      section("people", () => prompts.people, { tag: true }),
    ],
  });

  const registry = createRegistry();
  registry.install(Fish);

  mkdirSync(workspaceRoot, { recursive: true });
  mkdirSync(mediaRoot, { recursive: true });

  // pi-durable 默认的 compaction 会在中途注入一段库自带的总结提示词（不可审查），
  // 所以显式关掉：上下文靠分群隔离与 reset 控制，而不是靠一个我们看不到的 prompt。
  const settings = { compaction: { enabled: false } };

  const harness = await Harness.open(
    options.storage,
    {
      models,
      registry,
      now,
      settings,
    },
    ctx,
  );

  const compactor: Compactor | undefined = options.compact
    ? createCompactor({
        models,
        model: options.compact.model ?? options.model,
        prompts,
        maxEntries: options.compact.maxEntries ?? 80,
        maxChars: options.compact.maxChars ?? 12_000,
        onError: (error) => console.error("[鱼缸] 压缩失败", error instanceof Error ? error.message : error),
      })
    : undefined;

  const groups = new Map<string, Promise<Conversation>>();
  const sending = new Set<string>();

  async function drainConversation(conversationId: ConversationId): Promise<number> {
    let sent = 0;
    for (;;) {
      const box = await harness.snapshot(OutboxDoc, conversationId, ctx);
      const next = box?.queue.find((record) => record.status === "queued");
      if (!next) return sent;

      // 先标 sending 再发：崩在这中间的消息状态是"不确定"，重启时不重发（宁可少发不重复）
      await harness.commit(async (tx) => {
        const doc = await tx.doc(OutboxDoc, conversationId);
        const record = doc.queue.find((item) => item.key === next.key);
        if (record) record.status = "sending";
      }, ctx);

      try {
        await options.emit(conversationId, {
          items: next.items,
          ...(next.media === undefined ? {} : { media: next.media }),
          quote: next.quote,
          at: next.at,
          key: next.key,
        });
      } catch (error) {
        // 发送失败：放回队列重试，超过三次就丢弃并报错
        await harness.commit(async (tx) => {
          const doc = await tx.doc(OutboxDoc, conversationId);
          const index = doc.queue.findIndex((item) => item.key === next.key);
          if (index < 0) return;
          if (next.attempts + 1 >= 3) doc.queue.splice(index, 1);
          else {
            doc.queue[index].status = "queued";
            doc.queue[index].attempts += 1;
          }
        }, ctx);
        if (next.attempts + 1 >= 3) {
          throw new Error(`发送失败三次，已丢弃：${error instanceof Error ? error.message : error}`);
        }
        await new Promise((resolve) => setTimeout(resolve, 1500).unref?.());
        continue;
      }

      await harness.commit(async (tx) => {
        const doc = await tx.doc(OutboxDoc, conversationId);
        const index = doc.queue.findIndex((item) => item.key === next.key);
        if (index >= 0) doc.queue.splice(index, 1);
      }, ctx);
      sent++;
    }
  }

  return {
    harness,
    models,
    prompts,
    settings,
    toolNames: [say.name, react.name, ...tools.map((t) => t.name)],
    async compact(conversation) {
      if (!compactor) return { compacted: false, reason: "below_threshold" };
      return compactor.maybeCompact(conversation);
    },
    async enqueue(conversationId, payload) {
      await harness.commit(async (tx) => {
        const doc = await tx.doc(OutboxDoc, conversationId);
        doc.queue.push({ ...payload, status: "queued", attempts: 0 });
      }, ctx);
    },
    async recoverStaleSends() {
      const snapshot = await harness.snapshot(ChatsDoc, ctx);
      let recovered = 0;
      for (const conversationId of Object.values(snapshot?.chats ?? {})) {
        await harness.commit(async (tx) => {
          const doc = await tx.doc(OutboxDoc, conversationId);
          for (const item of doc.queue) {
            if (item.status === "sending") {
              item.status = "queued";
              recovered++;
            }
          }
        }, ctx);
      }
      return recovered;
    },
    async drain(extra = []) {
      const snapshot = await harness.snapshot(ChatsDoc, ctx);
      const ids = new Set<ConversationId>([...Object.values(snapshot?.chats ?? {}), ...extra]);
      let total = 0;
      for (const conversationId of ids) {
        if (sending.has(String(conversationId))) continue;
        sending.add(String(conversationId));
        try {
          total += await drainConversation(conversationId);
        } finally {
          sending.delete(String(conversationId));
        }
      }
      return total;
    },
    group(groupKey, profile) {
      let existing = groups.get(groupKey);
      if (!existing) {
        existing = (async () => {
          // 先按持久化的映射找回来；找不到才建新的
          const snapshot = await harness.snapshot(ChatsDoc, ctx);
          const known = snapshot?.chats?.[groupKey];
          if (typeof known === "number") {
            const reused = await harness.conversation(known, ctx);
            if (reused) return reused;
          }

          const cwd = join(workspaceRoot, safeName(groupKey));
          mkdirSync(cwd, { recursive: true });
          const created = await harness.createConversation(
            {
              ownership: { kind: "ownerless" },
              agent: { model: options.model, cwd },
              init: profile
                ? async (tx, conversationId) => {
                    const text = renderTemplate(prompts.groupProfile, {
                      name: profile.name,
                      groupId: profile.groupId,
                      count: String(profile.count),
                      owner: profile.owner,
                      master: profile.master,
                      members:
                        profile.members.map((m) => `${m.nickname} / ${m.userId}`).join("\n") || "（拿不到名单）",
                    });
                    await tx.appendEntry(GroupProfileEntry, conversationId, {
                      model: [{ role: "system", content: text, timestamp: now() }],
                    });
                  }
                : undefined,
            },
            ctx,
          );
          await harness.commit(async (tx) => {
            const chats = await tx.doc(ChatsDoc);
            chats.chats[groupKey] = created.id;
          }, ctx);
          return created;
        })();
        groups.set(groupKey, existing);
      }
      return existing;
    },
    async close() {
      await harness.close(ctx);
    },
  };
}

function safeName(key: string): string {
  return key.replace(/[^A-Za-z0-9._-]+/g, "_");
}
