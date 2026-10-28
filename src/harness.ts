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
  defineExtension,
  section,
  type Conversation,
  type ConversationId,
  type Storage,
} from "@earendil-works/pi-durable";
import { DEFAULT_LIMITS, REJECTION_CODES, type EgressLimits } from "./egress/policy.ts";
import { createSayTool, type OutboundPayload } from "./egress/say.ts";
import { loadPrompts, type PromptSet } from "./prompts.ts";
import { createTools } from "./tools/index.ts";
import { createCompactor, type CompactResult, type Compactor } from "./compact.ts";

const ctx = BACKGROUND_CONTEXT;

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
  group(groupKey: string): Promise<Conversation>;
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
  const tools = createTools({ mediaRoot, prompts });

  // 启动即校验：每个工具都必须有一份 prompt/tools/<name>.md，缺了就起不来
  for (const tool of [say, ...tools]) {
    if (!prompts.tools[tool.name]) {
      throw new Error(`缺少 prompt/tools/${tool.name}.md`);
    }
  }

  const Fish = defineExtension({
    name: "fish",
    tools: [say, ...tools],
    sections: [section("persona", () => prompts.persona, { tag: false })],
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
    toolNames: [say.name, ...tools.map((t) => t.name)],
    async compact(conversation) {
      if (!compactor) return { compacted: false, reason: "below_threshold" };
      return compactor.maybeCompact(conversation);
    },
    group(groupKey) {
      let existing = groups.get(groupKey);
      if (!existing) {
        const cwd = join(workspaceRoot, safeName(groupKey));
        mkdirSync(cwd, { recursive: true });
        existing = harness.createConversation(
          { ownership: { kind: "ownerless" }, agent: { model: options.model, cwd } },
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
