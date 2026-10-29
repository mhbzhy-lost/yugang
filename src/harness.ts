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
  configure,
  createRegistry,
  defineEntry,
  defineExtension,
  section,
  type Conversation,
  type ConversationId,
  type Extension,
  type Storage,
  type ToolRegistration,
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

/** 人格名的「默认」哨兵：默认人格的会话键不带后缀，也不另外选扩展。 */
export const DEFAULT_PERSONA = "默认";

/**
 * 人格 = 一个 Fish 扩展实例：默认人格叫 `fish`（人格来自 prompt/persona.md），
 * 其余叫 `fish:<名>`（人格 = 人格书全文）。工具实例共享，会话只选其中一个。
 */
function makeFishExtension(
  name: string,
  persona: string,
  parts: { tools: readonly ToolRegistration[]; prompts: PromptSet },
): Extension {
  return defineExtension({
    name,
    tools: parts.tools,
    sections: [
      section("persona", () => persona, { tag: false }),
      // 手工维护的人物档：比对话记忆更牢，和 handoff 互补
      section("people", () => parts.prompts.people, { tag: true }),
    ],
  });
}

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
  /** 思考档位；缺省 off。最低可用思考档是 low（deepseek 的 minimal 不支持）。 */
  thinkingLevel?: "off" | "minimal" | "low" | "medium" | "high" | "xhigh" | "max";
  /** prompt 目录：人格、工具说明、工具文案。 */
  promptRoot: string;
  /** 媒体白名单根目录（发图只能发这里面的）。 */
  mediaRoot: string;
  /** DeepSeek Search API 的 key；给了才有联网搜索能力。 */
  searchKey?: string;
  /** ModelScope API-KEY：生图凭据；给了才有生图能力。 */
  modelscopeKey?: string;
  /** SD WebUI（Windows 宿主机）的 baseUrl；给了才有本地画图。 */
  sdUrl?: string;
  /** danbooru.csv 路径；给了才能查 tag 词表。 */
  tagsCsv?: string;
  /** 主人 QQ：fs/restart 自改工具的身份闸，给了才注册这些工具。 */
  master?: string;
  /** submissionId → 本轮触发消息；把回复引用绑在轮上，防串线。 */
  triggerOf?: (roundId: unknown) => { messageId?: number | string; mentionsBot: boolean; userId?: number } | undefined;
  /** submissionId → 本轮触发消息自带的 bypass 段；仅 draw 消费，轮结束失效。 */
  bypassOf?: (roundId: unknown) => string | undefined;
  /** 每个群的工作目录根；实际 cwd 是 <workspaceRoot>/<groupKey>。 */
  workspaceRoot: string;
  limits?: Partial<Omit<EgressLimits, "mediaRoot">>;
  /** 上下文压缩：攒到阈值就 reset + handoff。不给就不压。 */
  compact?: {
    model?: ModelRef;
    maxEntries?: number;
    maxChars?: number;
  };
  /** look 的视觉描述模型；缺省用主模型。 */
  visionModel?: ModelRef;
  emit: (conversationId: ConversationId, payload: OutboundPayload) => void | Promise<void>;
  /** 贴表情回应，只带表情编号；目标消息由宿主自己记。 */
  react: (conversationId: ConversationId, emoji: string) => void | Promise<void>;
  now?: () => number;
}

export interface Fish {
  harness: Harness;
  models: Models;
  prompts: PromptSet;
  /** 实际的 harness settings，便于审查（compaction 必须为 false；extensions 钉住默认人格）。 */
  settings: { compaction: { enabled: boolean }; extensions: readonly Extension[] };
  /** 注册的人格名单：["默认", ...人格书文件名]。 */
  personas: string[];
  /** 有人格书 frontmatter 开场白的人格：名 → opener 文本；宿主切换成功后机械补发，不进模型。 */
  openers: Record<string, string>;
  toolNames: string[];
  /** 压缩一次上下文；没到阈值就什么都不做。 */
  compact(conversation: Conversation, force?: boolean): Promise<CompactResult>;
  /** 取（或创建）某个群在指定人格下的会话；映射持久化，重启后还是同一个会话。未注册人格回退默认。 */
  group(groupKey: string, profile?: GroupProfile, persona?: string): Promise<Conversation>;
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
  const tools = createTools({ mediaRoot, prompts, models, visionModel: options.visionModel ?? options.model, searchKey: options.searchKey, modelscopeKey: options.modelscopeKey, sdUrl: options.sdUrl, tagsCsv: options.tagsCsv, master: options.master, triggerOf: options.triggerOf, bypassOf: options.bypassOf });

  // 启动即校验：每个工具都必须有一份 prompt/tools/<name>.md，缺了就起不来
  for (const tool of [say, react, ...tools]) {
    if (!prompts.tools[tool.name]) {
      throw new Error(`缺少 prompt/tools/${tool.name}.md`);
    }
  }

  // 人格扩展：默认 fish + 每本人格书一个 fish:<名>；同一套工具实例，会话按名只选其一
  const fishTools: readonly ToolRegistration[] = [say, react, ...tools];
  const fishExtension = makeFishExtension("fish", prompts.persona, { tools: fishTools, prompts });
  const personaExtensions = new Map<string, Extension>();
  const openers: Record<string, string> = {};
  for (const [name, book] of Object.entries(prompts.personas)) {
    personaExtensions.set(name, makeFishExtension(`fish:${name}`, book.body, { tools: fishTools, prompts }));
    if (book.opener) openers[name] = book.opener;
  }

  const registry = createRegistry();
  registry.install(fishExtension);
  for (const extension of personaExtensions.values()) registry.install(extension);

  mkdirSync(workspaceRoot, { recursive: true });
  mkdirSync(mediaRoot, { recursive: true });

  // pi-durable 默认的 compaction 会在中途注入一段库自带的总结提示词（不可审查），
  // 所以显式关掉：上下文靠分群隔离与 reset 控制，而不是靠一个我们看不到的 prompt。
  // extensions 必须钉住默认实例：缺省语义是「全部已装、后装者胜」——不钉住的话，
  // 没写 selection 的存量会话会被后装的 fish:<名> 顶替 persona section。
  const settings = {
    compaction: { enabled: false },
    extensions: [fishExtension],
    // 中断的轮不恢复重跑：重启后针对陈年消息的迟到回复很怪（主人定案丢了就丢）
    restartLimit: 0,
  };

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
      console.warn(`  该会话失去全部 section 与工具（含 say）`);
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

      // 陈年消息不补：超过 2 分钟的排队消息直接丢弃。过时回复比不回复更怪
      // （主人定案「丢了就丢了」）；新鲜消息（优雅退出/秒级重启场景）照常补发。
      if (now() - next.at > 120_000) {
        await harness.commit(async (tx) => {
          const doc = await tx.doc(OutboxDoc, conversationId);
          const index = doc.queue.findIndex((item) => item.key === next.key);
          if (index >= 0) doc.queue.splice(index, 1);
        }, ctx);
        console.log(`[鱼缸] 丢弃过期消息（${Math.round((now() - next.at) / 1000)}s 前）`);
        continue;
      }

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
          // 引用绑定全链路贯通：早期漏传这两个字段，靠 lastMessageId 回退掩盖（会错位）；
          // 回退删除后 @ 场景全部裸发——不传，引用的真实修复在这里
          ...(next.quoteId !== undefined ? { quoteId: next.quoteId } : {}),
          ...(next.quoteForce !== undefined ? { quoteForce: next.quoteForce } : {}),
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
    personas: [DEFAULT_PERSONA, ...Object.keys(prompts.personas)],
    openers,
    toolNames: [say.name, react.name, ...tools.map((t) => t.name)],
    async compact(conversation, force) {
      if (!compactor) return { compacted: false, reason: "below_threshold" };
      return compactor.maybeCompact(conversation, force);
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
    group(groupKey, profile, persona = DEFAULT_PERSONA) {
      let effective = persona;
      if (effective !== DEFAULT_PERSONA && !personaExtensions.has(effective)) {
        // 人格书被删后的悬空名：回退默认人格键，不建空人格会话
        console.warn(`[鱼缸] group(${groupKey}) 人格 ${effective} 未注册，回退默认`);
        effective = DEFAULT_PERSONA;
      }
      // 映射键：默认人格 = 原键（存量零迁移）；人格 X = 原键#X
      const key = effective === DEFAULT_PERSONA ? groupKey : `${groupKey}#${effective}`;
      let existing = groups.get(key);
      if (!existing) {
        existing = (async () => {
          // 先按持久化的映射找回来；找不到才建新的
          const snapshot = await harness.snapshot(ChatsDoc, ctx);
          const known = snapshot?.chats?.[key];
          if (typeof known === "number") {
            const reused = await harness.conversation(known, ctx);
            if (reused) return reused;
          }

          const extension = effective === DEFAULT_PERSONA ? undefined : personaExtensions.get(effective);
          const cwd = join(workspaceRoot, safeName(groupKey) + (extension ? `#${effective}` : ""));
          mkdirSync(cwd, { recursive: true });
          const created = await harness.createConversation(
            {
              ownership: { kind: "ownerless" },
              // 默认人格不传 extensions：跟 host 钉住的默认选择，存量会话行为不变
              agent: {
                model: options.model,
                ...(options.thinkingLevel ? { thinkingLevel: options.thinkingLevel } : {}),
                cwd,
                ...(extension ? { extensions: [extension] } : {}),
              },
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
            chats.chats[key] = created.id;
          }, ctx);
          return created;
        })();
        groups.set(key, existing);
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
