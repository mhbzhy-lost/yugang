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
import type { Conversation } from "@earendil-works/pi-durable";
import { renderTemplate, type PromptSet } from "./prompts.ts";

const ctx = BACKGROUND_CONTEXT;

export interface CompactorOptions {
  models: Models;
  /** 用来写备忘的模型；比主模型便宜一档即可。 */
  model: { provider: string; modelId: string };
  prompts: PromptSet;
  /** 攒够多少条就压。 */
  maxEntries: number;
  /** 或者攒够多少字就压。 */
  maxChars: number;
  onError?: (error: unknown) => void;
}

export interface CompactResult {
  compacted: boolean;
  reason?: "below_threshold" | "empty" | "failed";
  entries?: number;
  chars?: number;
}

export interface Compactor {
  maybeCompact(conversation: Conversation): Promise<CompactResult>;
}

export function createCompactor(options: CompactorOptions): Compactor {
  return {
    async maybeCompact(conversation) {
      const rendered = await renderTranscript(conversation);
      if (rendered.transcript.trim().length === 0) return { compacted: false, reason: "empty" };

      const { entries, chars, transcript } = rendered;
      if (entries < options.maxEntries && chars < options.maxChars) {
        return { compacted: false, reason: "below_threshold", entries, chars };
      }

      try {
        const summary = await summarize(options, transcript);
        if (!summary.trim()) return { compacted: false, reason: "failed", entries, chars };
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
 */
export async function renderTranscript(conversation: Conversation): Promise<RenderedTranscript> {
  const view = await conversation.viewState(ctx);
  const lines: string[] = [];
  let entries = 0;

  try {
    for (const entry of view.value.entries) {
      if (entry.kind === "pi.user") {
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
