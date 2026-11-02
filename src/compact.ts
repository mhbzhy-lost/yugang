/**
 * 上下文压缩：换页 + 备忘。
 *
 * pi-durable 自带的 compaction 会在中途注入一段库自带的提示词，我们关掉了（不可审查）。
 * 这里自己实现：攒到阈值后，让一个便宜模型读一遍最近的对话，写一段 handoff，
 * 然后 conversation.reset(handoff) —— 换一页，鱼只带着这段备忘继续。
 *
 * 换页必须总能完成：摘要有界重试（上限 2 次）后仍失败（如网关内容拦截），
 * 机械降级换页——不生成摘要，新页起点 = 尾部最近 50 条 entry 原文 + 机械时间头。
 *
 * 摘要提示词在 prompt/handoff.md 里，降级告警文案在 prompt/messages.md，和其它 prompt 一起受审查。
 */
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import type { Models } from "@earendil-works/pi-ai/models";
import type { Conversation, ConversationId } from "@earendil-works/pi-durable";
import { renderTemplate, type PromptSet } from "./prompts.ts";
import { extractMemories, type ExtractSaved } from "./memory-extract.ts";
import { MEMORY_EVAL_KIND, MEMORY_INBOUND_KIND, MEMORY_ZERO_EXTRACT_PAGES, type EvalEventData, type MemoryInbound } from "./memory.ts";

const ctx = BACKGROUND_CONTEXT;

/**
 * 开窗积压注入轮（injection）与 open 窗 shard 轮（ambient，engagement=next）的 entry kind：
 * 背景板 / 分片摘要不是群友原话——不写 fish.inbound、不进摘要与记忆抽取，
 * 但计入换页阈值（entries）：它们真实占用模型上下文。行是否进 T12 的机械尾巴由 T12 裁定。
 */
export const MEMORY_ENGAGE_KIND = "fish.engage_tick";

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
  /** 人格名 + 会话 → 已知记忆（公共 doc 与该会话私有 doc 的合并渲染，事实行带 YYYY-MM 锚点，
 *  附 factId→subject 机械解析所需的行结构）；不给就当空白。 */
  knownMemory?: (memoryKey: string, conversationId: ConversationId) => Promise<{ text: string; subjects: { subject: string; name: string }[] }>;
  /** 只入待审库（携带来源人格 + 经 harness 映射解析的来源 chatKey）；批准时才由审批通道 apply
 *  进公共或私有 doc。返回更新后的连续零提取页数（驱动复查模式：达 MEMORY_ZERO_EXTRACT_PAGES
 *  时用宽松提示词重跑本页一次）。 */
  savePendingMemories?: (
    memoryKey: string,
    outcome: ExtractSaved,
    conversationId: ConversationId,
  ) => Promise<{ zeroStreak: number }>;
}

export interface CompactResult {
  compacted: boolean;
  reason?: "below_threshold" | "empty" | "failed";
  entries?: number;
  chars?: number;
  /** 机械降级换页：摘要有界重试全败后的兜底（新页 = 尾部原文 + 机械时间头），换页已完成。 */
  fallback?: boolean;
  /** 摘要失败原因摘要（已脱敏，不含对话内容）；仅 fallback 时携带，供宿主告警日志使用。 */
  detail?: string;
}

export interface Compactor {
  maybeCompact(conversation: Conversation, force?: boolean): Promise<CompactResult>;
}

export function createCompactor(options: CompactorOptions): Compactor {
  return {
    async maybeCompact(conversation, force = false) {
      const counted = await renderCountedEntries(conversation);
      const transcript = counted.flatMap((e) => e.lines).join("\n");
      if (counted.length === 0) return { compacted: false, reason: "empty" };

      const entries = counted.length;
      const chars = transcript.length;
      const limits = options.limits ? options.limits() : { maxEntries: options.maxEntries, maxChars: options.maxChars };
      if (!force && entries < limits.maxEntries && chars < limits.maxChars) {
        return { compacted: false, reason: "below_threshold", entries, chars };
      }

      // 页里只有 engage_tick 这类无文本 entry（背景板轮把条数顶到阈值）时没有可摘要的内容：
      // 直接机械降级换页（时间头照旧），不做三次注定失败的摘要尝试
      if (transcript.trim().length === 0) {
        try {
          await conversation.reset(mechanicalHandoff(counted), ctx);
          return { compacted: true, entries, chars, fallback: true, detail: "no_summary_text" };
        } catch (error) {
          options.onError?.(error);
          return { compacted: false, reason: "failed", entries, chars };
        }
      }

      try {
        const summary = (await summarizeBounded(options, transcript)).trim();

        // 记忆抽取（T11 抽取评价机制）：在 summarize 成功之后、reset 之前。任何异常（含
        // knownMemory、savePendingMemories 和 onError 自身抛错）都不得阻止后面的 reset——
        // 宁可没记上，不能不换页。解析失败（parse_failed）不计零提取、不推进 lastExtractAt，
        // 单独走 MemoryExtractError 上报；零提取（empty）按人格累计，达阈值用宽松复查提示词
        // 重跑本页一次（只一次不循环；复查失败不清计数、不阻塞换页）。
        const memoryKey = options.memoryKeyOf?.(conversation.id);
        if (memoryKey && options.extract && options.savePendingMemories) {
          try {
            const known = options.knownMemory
              ? await options.knownMemory(memoryKey, conversation.id)
              : { text: "", subjects: [] };
            const memoryTranscript = await renderMemoryTranscript(conversation);
            const extractInput = {
              transcript: memoryTranscript.transcript,
              known: known.text,
              subjects: [...known.subjects, ...memoryTranscript.subjects],
            };
            const outcome = await extractMemories(options.extract, extractInput);
            if (outcome.status === "parse_failed") {
              // 解析失败不是零提取：单独上报，不写入计数，也不推进 lastExtractAt
              throw new Error(`memory_extract_${outcome.status}:${outcome.reason}`);
            }
            // 只入待审库，不直接 apply：未批准的 patch 不进任何记忆 doc；
            // 空 patch 也推进 lastExtractAt（在待审写入的同一个 commit 里），并累计零提取页数
            const saved = await options.savePendingMemories(memoryKey, outcome, conversation.id);
            if (outcome.status === "ok") {
              console.log(
                `[鱼缸] 记忆抽取 人${outcome.patch.people?.length ?? 0} 说法${outcome.patch.lore?.length ?? 0} 卡${outcome.patch.cards?.length ?? 0} skip${outcome.skipped}`,
              );
            } else if (saved.zeroStreak >= MEMORY_ZERO_EXTRACT_PAGES) {
              // 复查模式：连续零提取达阈值，宽松提示词重跑本页一次；失败不清计数、不阻塞换页
              console.log(`[鱼缸] 记忆复查 零提取${saved.zeroStreak}页`);
              try {
                const review = await extractMemories(options.extract, extractInput, { review: true });
                if (review.status === "ok") {
                  await options.savePendingMemories(memoryKey, review, conversation.id);
                  console.log(
                    `[鱼缸] 复查命中 人${review.patch.people?.length ?? 0} 说法${review.patch.lore?.length ?? 0} 卡${review.patch.cards?.length ?? 0}`,
                  );
                } else if (review.status === "parse_failed") {
                  console.error(`[鱼缸] 记忆复查失败 ${review.reason}`);
                } else {
                  console.log("[鱼缸] 记忆复查仍零提取");
                }
              } catch (error) {
                console.error("[鱼缸] 记忆复查异常", error instanceof Error ? error.message : error);
              }
            } else {
              console.log(`[鱼缸] 记忆零提取 连续${saved.zeroStreak}页`);
            }
          } catch (error) {
            try {
              options.onError?.(new MemoryExtractError(error));
            } catch {
              /* 记录失败不能阻止 reset */
            }
          }
        }

        await conversation.reset(summary, ctx);
        return { compacted: true, entries, chars };
      } catch (error) {
        // 摘要有界重试全败：机械降级换页——换页必须总能完成，不许在失败页上死循环。
        // 新页 = 机械时间头 + 被压缩页尾部最近 50 条 entry 的原文（顺序与格式照旧），
        // 照常 reset；reset 失败则保持原行为：报错、保留原页。
        try {
          await conversation.reset(mechanicalHandoff(counted), ctx);
        } catch {
          options.onError?.(error);
          return { compacted: false, reason: "failed", entries, chars };
        }
        return { compacted: true, entries, chars, fallback: true, detail: errorDigest(error) };
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
  // 网关拦截/断流不抛异常，只回来一条 error 消息（content 为空）：必须主动翻成异常，
  // 否则空摘要会被当成失败而页永远压不动
  if (message.stopReason === "error" || message.stopReason === "aborted") {
    throw new Error(message.errorMessage ?? `summary_${message.stopReason}`);
  }
  return message.content
    .filter((block): block is { type: "text"; text: string } => block.type === "text")
    .map((block) => block.text)
    .join("\n");
}

/** 摘要尝试次数上限：首次 + 2 次重试。重试必须有界，耗尽后走机械降级而不是卡死换页。 */
const SUMMARY_ATTEMPTS = 3;

/** 有界重试的摘要：空摘要与异常都算失败，耗尽上限后抛最后一次的原因。 */
async function summarizeBounded(options: CompactorOptions, transcript: string): Promise<string> {
  let lastError: unknown = new Error("empty_summary");
  for (let attempt = 0; attempt < SUMMARY_ATTEMPTS; attempt++) {
    try {
      const summary = await summarize(options, transcript);
      if (summary.trim()) return summary;
    } catch (error) {
      lastError = error;
    }
  }
  throw lastError;
}

/** 降级换页携带的尾部 entry 条数：机械截取，不经过模型。 */
const FALLBACK_TAIL_ENTRIES = 50;

/**
 * 机械降级的新页起点：不生成摘要，直接把被压缩页尾部最近 50 条 entry 的原文
 * （顺序与 transcript 格式照旧）搬进新页，头部加一行机械时间说明（起止时间与条数，
 * 取自 entry 时间戳；短拼接文案，不占 prompt/messages.md 的 key）。任何模型都不再参与。
 */
function mechanicalHandoff(counted: CountedEntry[]): string {
  const tail = counted.slice(-FALLBACK_TAIL_ENTRIES);
  const stamps = tail.map((e) => e.at).filter((at): at is number => typeof at === "number");
  const start = stamps.length ? formatStamp(Math.min(...stamps)) : "?";
  const end = stamps.length ? formatStamp(Math.max(...stamps)) : "?";
  const header = `（前情 ${tail.length} 条 · ${start} ~ ${end}）`;
  return [header, ...tail.flatMap((e) => e.lines)].join("\n");
}

/** 时间戳 → 本地「YYYY-MM-DD HH:mm」；降级头与用量一样按本地时区展示。 */
function formatStamp(ts: number): string {
  const at = new Date(ts);
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${at.getFullYear()}-${pad(at.getMonth() + 1)}-${pad(at.getDate())} ${pad(at.getHours())}:${pad(at.getMinutes())}`;
}

/** 错误摘要：类名 + 去控制字符、截断后的 message（同 MemoryExtractError 的脱敏口径），不含对话内容。 */
function errorDigest(error: unknown): string {
  const name = error instanceof Error ? error.constructor.name : typeof error;
  const detail = error instanceof Error ? String(error.message).replace(/[\r\n\u0000-\u001F]/g, " ").slice(0, 120) : "";
  return detail ? `${name}: ${detail}` : name;
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
 * fish.gif_ingest（收图任务）与 fish.engage_tick（开窗积压 / shard 轮）不是群友原话，
 * 不进摘要（engage_tick 仍计入换页阈值，见 renderCountedEntries）；fish.eval（主人
 * 评价事件）同被排除（决策 11b，只进抽取白名单）。
 */
export async function renderTranscript(conversation: Conversation): Promise<RenderedTranscript> {
  const counted = await renderCountedEntries(conversation);
  const transcript = counted.flatMap((e) => e.lines).join("\n");
  return { transcript, entries: counted.length, chars: transcript.length };
}

/** 一条入册 entry 摊平后的行与它的时间戳（机械降级头用；没有可靠时间戳时为 undefined）。 */
interface CountedEntry {
  lines: string[];
  at?: number;
}

/** entry 时间戳：pi.user / fish.inbound 取首条 user message，fish.outbound 取 payload 的 at。 */
function entryTimestamp(entry: { kind: string; model?: unknown; data?: unknown }): number | undefined {
  if (entry.kind === "fish.outbound") {
    const at = (entry.data as { at?: unknown } | undefined)?.at;
    return typeof at === "number" ? at : undefined;
  }
  if (!Array.isArray(entry.model)) return undefined;
  for (const message of entry.model) {
    const ts = (message as { timestamp?: unknown }).timestamp;
    if (typeof ts === "number") return ts;
  }
  return undefined;
}

/**
 * 只把「谁说了什么」摊平：群消息 + 鱼真正发出去的话，按 entry 逐条返回。
 * thinking、tool 调用、tool 结果、系统提示一律不进去——它们不进摘要，也就不进下一轮的上下文。
 * 群消息的 entry 有两种 kind：存量 pi.user，以及带结构化原始数据的 fish.inbound
 * （记忆入口）；两者部读 entry.model（宿主拼装的 user message），handoff 行为不变。
 * fish.gif_ingest（收图任务）不是群友原话，不进摘要；fish.engage_tick（开窗积压 /
 * shard 轮）计入换页阈值（entries），但不写 handoff 文本（决策 4：背景板不进摘要）；
 * fish.eval（主人评价事件，T6）是书记性 entry（无 model 字段、不占模型上下文），
 * 既不计数也不进 handoff（决策 11b：排除摘要，只进抽取白名单）。
 */
async function renderCountedEntries(conversation: Conversation): Promise<CountedEntry[]> {
  const view = await conversation.viewState(ctx);
  const counted: CountedEntry[] = [];

  try {
    for (const entry of view.value.entries) {
      if (entry.kind === "pi.user" || entry.kind === MEMORY_INBOUND_KIND) {
        const text = entryText(entry.model);
        counted.push({ lines: text ? [`群友: ${text}`] : [], at: entryTimestamp(entry) });
      } else if (entry.kind === MEMORY_ENGAGE_KIND) {
        // engage_tick：计入阈值（entries），不写 handoff 文本——时间戳保留给降级头
        counted.push({ lines: [], at: entryTimestamp(entry) });
      } else if (entry.kind === "fish.outbound") {
        const data = entry.data as { items?: string[]; at?: unknown } | undefined;
        counted.push({
          lines: (data?.items ?? []).map((text) => `鱼: ${text}`),
          at: typeof data?.at === "number" ? data.at : undefined,
        });
      }
    }
  } finally {
    view.dispose();
  }

  return counted;
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
 * fish.gif_ingest / fish.engage_tick / 工具结果 / thinking，也不复用上面宿主拼装
 * 文案的 renderTranscript。改动这个白名单前必读 src/memory.ts 的安全边界注释：
 * 混入任何宿主文案都会让「记忆 → 抽取 → 记忆」的自我污染闭环复活。
 * fish.eval（主人评价事件，T6）是唯一的有意新增：从结构化 data 渲染一行评价事实，
 * 决策 11b——评价进抽取白名单、排除摘要。抽取器看到评价行后产出的任何候选照旧
 * 只进待审（savePendingMemories）；kind="feedback" 的 fact 仅由审批链机器装配（T7），
 * 不经抽取器。
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
        // 行首 [MM-DD]（T11）：lore 候选的首次出现时间锚点需要说话日期；拿不到可靠时间戳就不标
        if (text) {
          const stamp = dayStamp(entryTimestamp(entry));
          lines.push(`${stamp ? `[${stamp}] ` : ""}${nickname}(${subject}): ${text}`);
        }
      } else if (entry.kind === MEMORY_EVAL_KIND) {
        const data = entry.data as Partial<EvalEventData> | undefined;
        const direction = data?.direction === "差" ? "差" : "好";
        const masterText = typeof data?.masterText === "string" ? data.masterText.trim() : "";
        const target = typeof data?.targetSummary === "string" ? data.targetSummary.trim() : "";
        if (masterText || target) {
          const stamp = typeof data?.day === "string" && /^\d{4}-\d{2}-\d{2}$/.test(data.day) ? data.day.slice(5) : "";
          lines.push(`${stamp ? `[${stamp}] ` : ""}主人评价(${direction}): ${masterText}（针对：${target}${data?.degraded === true ? "，未定位" : ""}）`);
        }
      } else if (entry.kind === "fish.outbound") {
        const data = entry.data as { items?: string[]; at?: unknown } | undefined;
        const stamp = typeof data?.at === "number" ? dayStamp(data.at) : "";
        for (const text of data?.items ?? []) {
          if (text.trim()) lines.push(`${stamp ? `[${stamp}] ` : ""}鱼: ${text}`);
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

/** 时间戳 → 本地「MM-DD」：抽取转录行的日期锚点（年份由提示词的 {{today}} 补全）。 */
function dayStamp(ts: number | undefined): string {
  if (ts === undefined || !Number.isFinite(ts)) return "";
  const at = new Date(ts);
  return `${String(at.getMonth() + 1).padStart(2, "0")}-${String(at.getDate()).padStart(2, "0")}`;
}
