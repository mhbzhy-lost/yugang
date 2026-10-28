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
  /** 取（或创建）某个群的会话；profile 只在首次创建时写入。 */
  group(groupKey: string, profile?: GroupProfile): Promise<Conversation>;
  close(): Promise<void>;
}

export async function openFish(options: FishOptions): Promise<Fish> {
  const models = options.models ?? createModels();
  const now = options.now ?? Date.now;
  const mediaRoot = resolve(options.mediaRoot);
  const workspaceRoot = resolve(options.workspaceRoot);
  const limits: EgressLimits = { ...DEFAULT_LIMITS, ...options.limits, mediaRoot };

  const prompts = loadPrompts(resolve(options.promptRoot));
  for (const code of [...REJECTION_CODES, "say_sent"]) {
    if (!prompts.messages[code]) throw new Error(`prompt/messages.md 缺少文案：${code}`);
  }

  const say = createSayTool({ limits, prompts, emit: options.emit, now });
  const react = createReactTool({ prompts, react: options.react, now });
  const tools = createTools({ mediaRoot, prompts });

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
    group(groupKey, profile) {
      let existing = groups.get(groupKey);
      if (!existing) {
        const cwd = join(workspaceRoot, safeName(groupKey));
        mkdirSync(cwd, { recursive: true });
        existing = harness.createConversation(
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
