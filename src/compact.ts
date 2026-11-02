/**
 * 上下文压缩：换页 + 备忘。
 *
 * pi-durable 自带的 compaction 会在中途注入一段库自带的提示词，我们关掉了（不可审查）。
 * 这里自己实现：攒到阈值后，让一个便宜模型读一遍最近的对话，写一段 handoff，
 * 然后 conversation.reset(handoff) —— 换一页，鱼只带着这段备忘继续。
 *
 * 摘要提示词在 prompt/handoff.md 里，和其它 prompt 一起受审查。
 */
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import type { Models } from "@earendil-works/pi-ai/models";
import type { Conversation, ConversationId } from "@earendil-works/pi-durable";
import { renderTemplate, type PromptSet } from "./prompts.ts";
import { extractMemories } from "./memory-extract.ts";
import { MEMORY_INBOUND_KIND, type MemoryInbound, type MemoryPatch } from "./memory.ts";

const ctx = BACKGROUND_CONTEXT;

/** 记忆抽取阶段的失败标记：onError 据此区分换页失败与抽取失败，只携带安全的错误摘要。 */
export class MemoryExtractError extends Error {
  constructor(cause: unknown) {
    const name = cause instanceof Error ? cause.constructor.name : typeof cause;
    const detail = cause instanceof Error ? String(cause.message).replace(/[\r\n\u0000-\u001F]/g, " ").slice(0, 120) : "";
    super(detail ? `${name}: ${detail}` : name);
    this.name = "MemoryExtractError";
  }
}

export interface CompactorOptions {
  models: Models;
  /** 用来写备忘的模型；比主模型便宜一档即可。 */
  model: { provider: string; modelId: string };
  prompts: PromptSet;
  /** 攒够多少条就压。 */
  maxEntries: number;
  /** 现取的阈值（热更新用）；给了就盖过上面两个静态值。 */
  limits?: () => { maxEntries: number; maxChars: number };
  /** 或者攒够多少字就压。 */
  maxChars: number;
  onError?: (error: unknown) => void;
  /** 记忆抽取用的模型与提示词；不给就不拍取。 */
  extract?: { models: Models; model: { provider: string; modelId: string }; prompts: PromptSet };
  /** conversation → 该会话当前人格名（memory doc key）。未找到时跳过记忆抽取但照常 reset。 */
  memoryKeyOf?: (conversationId: ConversationId) => string | undefined;
  knownMemory?: (memoryKey: string) => Promise<{ text: string; subjects: { subject: string; name: string }[] }>;
  /** 只入待审库（携带来源人格 + 经 harness 映射解析的来源 chatKey）；批准时才由审批通道 apply 进公共或私有 doc。 */
  savePendingMemories?: (memoryKey: string, patch: MemoryPatch, conversationId: ConversationId) => Promise<void>;
}

export interface CompactResult {
  compacted: boolean;
  reason?: "below_threshold" | "empty" | "failed";
  entries?: number;
  chars?: number;
}

export interface Compactor {
  maybeCompact(conversation: Conversation, force?: boolean): Promise<CompactResult>;
}

export function createCompactor(options: CompactorOptions): Compactor {
  return {
    async maybeCompact(conversation, force = false) {
      const rendered = await renderTranscript(conversation);
      if (rendered.transcript.trim().length === 0) return { compacted: false, reason: "empty" };

      const { entries, chars, transcript } = rendered;
      const limits = options.limits ? options.limits() : { maxEntries: options.maxEntries, maxChars: options.maxChars };
      if (!force && entries < limits.maxEntries && chars < limits.maxChars) {
        return { compacted: false, reason: "below_threshold", entries, chars };
      }

      try {
        const summary = await summarize(options, transcript);
        if (!summary.trim()) return { compacted: false, reason: "failed", entries, chars };

        // 记忆抽取：在 summarize 成功之后、reset 之前。任何异常（含 knownMemory、
        // savePendingMemories 和 onError 自身抛错）都不得阻止后面的 reset——宁可没记上，不能不换页。
        const memoryKey = options.memoryKeyOf?.(conversation.id);
        if (memoryKey && options.extract && options.savePendingMemories) {
          try {
            const known = options.knownMemory ? await options.knownMemory(memoryKey) : { text: "", subjects: [] };
            const memoryTranscript = await renderMemoryTranscript(conversation);
            const patch = await extractMemories(options.extract, {
              transcript: memoryTranscript.transcript,
              known: known.text,
              subjects: [...known.subjects, ...memoryTranscript.subjects],
            });
            if (patch) {
              // 只入待审库，不直接 apply：未批准的 patch 不进任何记忆 doc；
              // 空 patch 也推进 lastExtractAt（在待审写入的同一个 commit 里）
              await options.savePendingMemories(memoryKey, patch, conversation.id);
              console.log(
                `[鱼缸] 记忆抽取 人${patch.people?.length ?? 0} 说法${patch.lore?.length ?? 0} 卡片${patch.cards?.length ?? 0}`,
              );
            } else throw new Error("memory_extract_unavailable");
          } catch (error) {
            try {
              options.onError?.(new MemoryExtractError(error));
            } catch {
              /* 记录失败不能阻止 reset */
            }
          }
        }

        await conversation.reset(summary.trim(), ctx);
        return { compacted: true, entries, chars };
      } catch (error) {
        options.onError?.(error);
        return { compacted: false, reason: "failed", entries, chars };
      }
    },
  };
}

async function summarize(options: CompactorOptions, transcript: string): Promise<string> {
  const model = options.models.getModel(options.model.provider, options.model.modelId);
  if (!model) throw new Error(`找不到总结用的模型：${options.model.provider}/${options.model.modelId}`);

  const prompt = renderTemplate(await loadHandoff(options), { transcript });
  const stream = options.models.streamSimple(model, { messages: [{ role: "user", content: prompt }] });
  const message = await stream.result();
  return message.content
    .filter((block): block is { type: "text"; text: string } => block.type === "text")
    .map((block) => block.text)
    .join("\n");
}

async function loadHandoff(options: CompactorOptions): Promise<string> {
  const template = options.prompts.handoff;
  if (!template) throw new Error("prompt/handoff.md 没有加载进来");
  return template;
}

export interface RenderedTranscript {
  transcript: string;
  entries: number;
  chars: number;
}

/**
 * 只把「谁说了什么」摊平：群消息 + 鱼真正发出去的话。
 * thinking、tool 调用、tool 结果、系统提示一律不进去——它们不进摘要，也就不进下一轮的上下文。
 * 群消息的 entry 有两种 kind：存量 pi.user，以及带结构化原始数据的 fish.inbound
 * （记忆入口）；两者部读 entry.model（宿主拼装的 user message），handoff 行为不变。
 * fish.gif_ingest（收图任务）不是群友原话，不进摘要。
 */
export async function renderTranscript(conversation: Conversation): Promise<RenderedTranscript> {
  const view = await conversation.viewState(ctx);
  const lines: string[] = [];
  let entries = 0;

  try {
    for (const entry of view.value.entries) {
      if (entry.kind === "pi.user" || entry.kind === MEMORY_INBOUND_KIND) {
        const text = entryText(entry.model);
        if (text) lines.push(`群友: ${text}`);
        entries++;
      } else if (entry.kind === "fish.outbound") {
        const data = entry.data as { items?: string[] } | undefined;
        for (const text of data?.items ?? []) lines.push(`鱼: ${text}`);
        entries++;
      }
    }
  } finally {
    view.dispose();
  }

  const transcript = lines.join("\n");
  return { transcript, entries, chars: transcript.length };
}

function entryText(model: unknown): string {
  // 只取 text block：主会话 inline 附图（docs/plans/2026-11-01-inline-vision.md）的 image block
  // 在这里被有意丢弃——摘要永远只吃文本，图片随换页退出活跃上下文
  if (!Array.isArray(model)) return "";
  return model
    .map((message) => {
      const content = (message as { content?: unknown }).content;
      if (typeof content === "string") return content;
      if (!Array.isArray(content)) return "";
      return content
        .filter((block): block is { type: "text"; text: string } => block?.type === "text" && typeof block.text === "string")
        .map((block) => block.text)
        .join(" ");
    })
    .filter(Boolean)
    .join("\n");
}

export interface MemoryTranscript {
  transcript: string;
  subjects: { subject: string; name: string }[];
}

/**
 * 记忆抽取专用的原始转录：只读结构化原始 entry（fish.inbound 的 data 与
 * fish.outbound 的 items），带结构化说话人元数据；不读 pi.user / pi.system /
 * fish.gif_ingest / 工具结果 / thinking，也不复用上面宿主拼装文案的 renderTranscript。
 * 改动这个白名单前必读 src/memory.ts 的安全边界注释：混入任何宿主文案都会
 * 让「记忆 → 抽取 → 记忆」的自我污染闭环复活。
 */
export async function renderMemoryTranscript(conversation: Conversation): Promise<MemoryTranscript> {
  const view = await conversation.viewState(ctx);
  const lines: string[] = [];
  const subjects = new Map<string, string>();

  try {
    for (const entry of view.value.entries) {
      if (entry.kind === MEMORY_INBOUND_KIND) {
        const data = entry.data as Partial<MemoryInbound> | undefined;
        const text = typeof data?.text === "string" ? data.text.trim() : "";
        const nickname = typeof data?.nickname === "string" && data.nickname.trim() ? data.nickname.trim() : String(data?.userId ?? "");
        const userId = typeof data?.userId === "string" ? data.userId.trim() : "";
        const subject = /^\d{4,12}$/.test(userId) ? `qq:${userId}` : `name:${nickname.slice(0, 20)}`;
        if (!subjects.has(subject)) subjects.set(subject, nickname);
        if (text) lines.push(`${nickname}(${subject}): ${text}`);
      } else if (entry.kind === "fish.outbound") {
        const data = entry.data as { items?: string[] } | undefined;
        for (const text of data?.items ?? []) {
          if (text.trim()) lines.push(`鱼: ${text}`);
        }
      }
    }
  } finally {
    view.dispose();
  }

  return {
    transcript: lines.join("\n"),
    subjects: [...subjects.entries()].map(([subject, name]) => ({ subject, name })),
  };
}
