/**
 * 上下文压缩：换页 + 剖面卡片（T12：剖面 + transcript 尾巴）。
 *
 * pi-durable 自带的 compaction 会在中途注入一段库自带的提示词，我们关掉了（不可审查）。
 * 这里自己实现：攒到阈值后，让一个便宜模型读一遍最近的对话，产出一张严格字段化的
 * 剖面卡片，然后 conversation.reset(handoff)——换一页，鱼带着「卡片 + 被压缩页尾部
 * 最近 50 条原文」继续。尾巴只从被压缩页的 transcript 机械截取（不碰 recent / chatlog，
 * 不把鱼没见过的消息伪装成已读上下文），保持原 entry 顺序与标注格式，不二次渲染。
 *
 * 三道机械防线：逐字引用校验（话头 / 承诺的 quote 与 [m:id] 锚点必须逐字命中本页
 * transcript 或上一页剖面原文，否则丢条目）；事务性（卡片校验通过才 reset，失败保留
 * 原页）；有界重试（3 次）耗尽后走既有机械降级换页——机械时间头 + 尾部原文，任何
 * 模型都不再参与，不许在失败页上死循环。
 *
 * 跨页抗漂移：上一页剖面从 pi.reset head 提取，字段级合并（还开着的话头 / 未兑现
 * 承诺 verbatim 带入、完结的标掉），不重新叙事、不 summary-of-summary；提取失败按
 * 无旧剖面处理（首换页语义）。
 *
 * 剖面提示词在 prompt/handoff.md，卡片与机械时间头的渲染模板在 prompt/messages.md，
 * 降级告警文案同在 prompt/messages.md，和其它 prompt 一起受审查。
 */
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import type { Models } from "@earendil-works/pi-ai/models";
import type { Conversation, ConversationId } from "@earendil-works/pi-durable";
import { renderTemplate, type PromptSet } from "./prompt/index.ts";
import { renderMessageList, type ModelMessage } from "./qq/model-input.ts";
import { extractMemories, type ExtractSaved } from "./memory/extract.ts";
import { MEMORY_EVAL_KIND, MEMORY_INBOUND_KIND, MEMORY_ZERO_EXTRACT_PAGES, type EvalEventData, type MemoryInbound } from "./memory/index.ts";

const ctx = BACKGROUND_CONTEXT;

/**
 * 开窗积压注入轮（injection）与 open 窗 shard 轮（ambient，engagement=next）的 entry kind：
 * 背景板 / 分片摘要不是群友原话——不写 fish.inbound、不进摘要与记忆抽取，
 * 但计入换页阈值（entries）：它们真实占用模型上下文。行是否进 T12 的机械尾巴由 T12 裁定。
 */
export const MEMORY_ENGAGE_KIND = "fish.engage_tick";

/**
 * worker 轮（弹药逛轮，外部计划 Task E4）的 entry kind：触发语是宿主任务文案，不是群友
 * 原话——不写 fish.inbound、不进摘要与记忆抽取，但计入换页阈值（entries 与 chars：
 * worker 会话也要能被顶到换页，否则上下文无限涨），原文行进换页尾巴（同 engage_tick 口径）。
 */
export const MEMORY_WORKER_KIND = "fish.worker_round";

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
  /** 用来生成剖面卡片的模型；比主模型便宜一档即可。 */
  model: { provider: string; modelId: string };
  prompts: PromptSet;
  /** 攒够多少条就压。 */
  maxEntries: number;
  /** 现取的阈值（热更新用）；给了就盖过上面两个静态值。 */
  limits?: () => { maxEntries: number; maxChars: number };
  /** 或者攒够多少字就压。 */
  maxChars: number;
  /** conversation → 当前人格的鱼昵称与真实 self QQ；拿不到 QQ 时留空，不伪造。 */
  selfOf?: (conversationId: ConversationId) => { nickname: string; userId: string };
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
  /** 剖面生成失败原因摘要（已脱敏，不含对话内容）；仅 fallback 时携带，供宿主告警日志使用。 */
  detail?: string;
}

export interface Compactor {
  maybeCompact(conversation: Conversation, force?: boolean): Promise<CompactResult>;
}

export function createCompactor(options: CompactorOptions): Compactor {
  return {
    async maybeCompact(conversation, force = false) {
      const self = options.selfOf?.(conversation.id) ?? { nickname: "Elysia", userId: "" };
      const counted = await renderCountedEntries(conversation, self);
      const transcript = counted.flatMap((e) => e.lines).join("\n");
      if (counted.length === 0) return { compacted: false, reason: "empty" };

      const entries = counted.length;
      // 阈值字符数按 CountedEntry.chars 累加：engage_tick 背景板行不进摘要（lines 空）
      // 但字符计入阈值（终审 #2），否则背景板永远顶不动 maxChars
      const chars = counted.reduce((sum, entry) => sum + entry.chars, 0);
      const limits = options.limits ? options.limits() : { maxEntries: options.maxEntries, maxChars: options.maxChars };
      if (!force && entries < limits.maxEntries && chars < limits.maxChars) {
        return { compacted: false, reason: "below_threshold", entries, chars };
      }

      // 页里只有 engage_tick 这类无文本 entry（背景板轮把条数/字符阈值顶到）时没有可摘要的内容：
      // 直接机械降级换页（时间头照旧），不做三次注定失败的摘要尝试
      if (transcript.trim().length === 0) {
        try {
          await conversation.reset(mechanicalHandoff(counted, options.prompts.messages), ctx);
          return { compacted: true, entries, chars, fallback: true, detail: "no_summary_text" };
        } catch (error) {
          options.onError?.(error);
          return { compacted: false, reason: "failed", entries, chars };
        }
      }

      try {
        // T12 正常路径：剖面卡片（严格字段化 + 逐字校验），不再生成自由叙事摘要。
        // 上一页剖面从 pi.reset head 提取作字段级合并的输入；提取失败按无旧剖面处理（首换页语义）。
        const previous = await extractPreviousProfile(conversation);
        const profile = await profileBounded(options, transcript, previous);
        const handoff = buildProfileHandoff(profile, counted, options.prompts.messages);

        // 记忆抽取（T11 抽取评价机制）：在剖面生成成功之后、reset 之前（抽取行为零变化，
        // 仍吃 renderMemoryTranscript 的结构化原始转录）。任何异常（含
        // knownMemory、savePendingMemories 和 onError 自身抛错）都不得阻止后面的 reset——
        // 宁可没记上，不能不换页。解析失败（parse_failed）不计零提取、不推进 lastExtractAt，
        // 单独走 MemoryExtractError 上报；零提取（empty）按人格累计，达阈值用宽松复查提示词
        // 重跑本页一次（只一次不循环；复查失败不清计数、不阻塞换页）。
        // 无 memory key（worker 会话隔离，harness 不登记）双重 fail-closed：不注入、不抽取，
        // 只做换页；留一行日志让隔离可核对。
        const memoryKey = options.memoryKeyOf?.(conversation.id);
        if (!memoryKey && options.extract !== undefined) {
          console.log("[鱼缸] 无记忆 key，跳过记忆抽取");
        }
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

        await conversation.reset(handoff, ctx);
        return { compacted: true, entries, chars };
      } catch (error) {
        // 剖面生成有界重试全败（含逐字校验/JSON 形状不过）：机械降级换页——换页必须总能
        // 完成，不许在失败页上死循环。新页 = 机械时间头 + 被压缩页尾部最近 50 条 entry 的
        // 原文（顺序与格式照旧），照常 reset；reset 失败则保持原行为：报错、保留原页。
        try {
          await conversation.reset(mechanicalHandoff(counted, options.prompts.messages), ctx);
        } catch {
          options.onError?.(error);
          return { compacted: false, reason: "failed", entries, chars };
        }
        return { compacted: true, entries, chars, fallback: true, detail: errorDigest(error) };
      }
    },
  };
}

/** 剖面卡片的一个逐字引用字段：quote 必须逐字命中本页 transcript 或上一页剖面原文。 */
export interface ProfileItem {
  /** 逐字抄来的原文短语（禁转述）；机械校验 substring 命中才保留。 */
  quote: string;
  /** 话头所在消息的锚点（[m:<id>] 括号里的数字）；鱼自己的话没有锚点时缺省。 */
  anchor?: string;
  /** open = 还开着 / 未兑现；done = 本页内已完结 / 已兑现（不再跨页带入）。 */
  status: "open" | "done";
}

/** 换页剖面（T12）：时间范围与活跃成员纯机械生成（不经过模型），话头 / 承诺逐字引用，氛围一行。 */
export interface PageProfile {
  threads: ProfileItem[];
  promises: ProfileItem[];
  mood: string;
}

/** 上一页剖面（字段级合并的输入）：profile 只保留还开着的条目；text 是旧页换页文本， */
/** 作为带入条目逐字校验的 corpus（旧剖面里的 quote 在自己那页已经过同一道校验）； */
/** at 是落页时间（pi.reset head 时间戳），T13 开窗弹药行的时间锚点消费它。 */
interface PreviousProfile {
  profile: PageProfile;
  text: string;
  at?: number;
}

/** 换页尾巴（机械降级与剖面页共用）的条数：机械截取，不经过模型。 */
const FALLBACK_TAIL_ENTRIES = 50;

/** 剖面卡片（含时间头）的字数上限：机械裁决，超出时丢条目而不是放宽。 */
const PROFILE_CARD_CHARS = 300;

/** 剖面单条逐字引用的上限：短语级的“话头/梗”，不是整句搬运。 */
const PROFILE_QUOTE_CHARS = 40;

/** 逐字条目每类（话头 / 承诺）的上限。 */
const PROFILE_ITEM_CAP = 5;

/** 机械时间头的兑底模板（prompt/messages.md 缺 key 时用）：纯数字/时间戳拼接、不含中文 */
/**（终审 #8：机械降级路径不内嵌中文文案），必须无条件可渲染，不许因文案缺失卡死换页。 */
const TIME_HEADER_FALLBACK = "{{count}} · {{start}} ~ {{end}}";

/** 条目状态词（卡片渲染与旧剖面回读共用同一套词，改词要同步 extractPreviousProfile 的解析）。 */
const THREAD_STATUS = { open: "进行中", done: "已完结" } as const;
const PROMISE_STATUS = { open: "未兑现", done: "已兑现" } as const;

/** 消费 prompt/messages.md 的文案 key：缺 key 直接报错（被 maybeCompact 捕获后走机械降级）。 */
function messageOf(text: string | undefined, key: string): string {
  if (typeof text !== "string" || !text) throw new Error(`缺少文案 key：${key}`);
  return text;
}

/** 单条逐字条目的机械校验：quote 逐字命中 corpus、锚点存在才保留，否则整条丢掉（F15：丢字段）。 */
function profileItem(raw: unknown, corpus: string): ProfileItem | undefined {
  if (typeof raw !== "object" || raw === null) return undefined;
  const item = raw as { quote?: unknown; anchor?: unknown; status?: unknown };
  if (typeof item.quote !== "string") return undefined;
  const quote = item.quote.trim().slice(0, PROFILE_QUOTE_CHARS);
  if (!quote || !corpus.includes(quote)) return undefined;
  const status = item.status === "done" ? "done" : "open";
  let anchor: string | undefined;
  if (typeof item.anchor === "string" && item.anchor.trim()) {
    const digits = /\d+/.exec(item.anchor)?.[0];
    if (digits === undefined || !corpus.includes(`[m:${digits}]`)) return undefined;
    anchor = digits;
  }
  return { quote, ...(anchor !== undefined ? { anchor } : {}), status };
}

/** 列表级的机械过滤：逐条校验 + 去重 + 截到上限（转述/伪锚点在这里无声丢掉）。 */
function profileItems(raw: unknown, corpus: string): ProfileItem[] {
  if (!Array.isArray(raw)) throw new Error("profile_bad_shape");
  const out: ProfileItem[] = [];
  const seen = new Set<string>();
  for (const entry of raw) {
    const item = profileItem(entry, corpus);
    if (item === undefined || seen.has(item.quote)) continue;
    seen.add(item.quote);
    out.push(item);
    if (out.length >= PROFILE_ITEM_CAP) break;
  }
  return out;
}

/**
 * 模型输出的剖面 JSON 的严格解析与校验：只认 {threads, promises, mood} 形状；
 * JSON / 形状坏了直接抛异常（算一次失败，有界重试后走机械降级）；条目级逐字校验
 * 不过则丢条目（F15「丢字段或整次失败」两道都机械，不重新叙事、不事后补救）。
 * corpus = 本页 transcript + 上一页剖面原文：带入条目的 quote / 锚点在旧页已过同一道
 * 校验，逐字链不断。
 */
function parseProfileOutput(text: string, corpus: string): PageProfile {
  const start = text.indexOf("{");
  const end = text.lastIndexOf("}");
  if (start < 0 || end <= start) throw new Error("profile_no_json");
  let parsed: unknown;
  try {
    parsed = JSON.parse(text.slice(start, end + 1));
  } catch {
    throw new Error("profile_bad_json");
  }
  if (typeof parsed !== "object" || parsed === null) throw new Error("profile_bad_shape");
  const shape = parsed as { threads?: unknown; promises?: unknown; mood?: unknown };
  const mood = typeof shape.mood === "string" ? shape.mood.replace(/\s+/g, " ").trim().slice(0, 60) : "";
  if (!mood) throw new Error("profile_bad_shape");
  return {
    threads: profileItems(shape.threads, corpus),
    promises: profileItems(shape.promises, corpus),
    mood,
  };
}

/** 剖面生成尝试次数上限：首次 + 2 次重试。重试必须有界，耗尽后走机械降级而不是卡死换页。 */
const PROFILE_ATTEMPTS = 3;

/** 上一页剖面拼进提示词的形态：还开着的条目逐条一行（quote 一字不改），没有则“（无）”。 */
function renderPreviousProfile(previous: PreviousProfile, messages: Record<string, string>): string {
  const lines = [
    ...previous.profile.threads.map((item) => profileLine(item, THREAD_STATUS[item.status], messages)),
    ...previous.profile.promises.map((item) => profileLine(item, PROMISE_STATUS[item.status], messages)),
  ];
  return lines.length > 0 ? lines.join("\n") : "（无）";
}

/** 卡片条目行的渲染（模板 key 在 prompt/messages.md；旧剖面回读与卡片共用同一格式）。 */
function profileLine(item: ProfileItem, status: string, messages: Record<string, string>): string {
  return renderTemplate(messageOf(messages["compact_profile_line"], "compact_profile_line"), {
    quote: item.quote,
    anchor: item.anchor !== undefined ? `[m:${item.anchor}] ` : "",
    status,
  });
}

/**
 * 让模型产出剖面卡片字段：提示词是 prompt/handoff.md（唯一源），输出只认严格 JSON；
 * 网关拦截 / 断流不抛异常只回来一条空 content 的 error 消息，必须主动翻成异常，
 * 否则空剖面会被当成失败而页永远压不动（12dab09 的教训）。
 */
async function buildProfile(
  options: CompactorOptions,
  transcript: string,
  previous: PreviousProfile | undefined,
): Promise<PageProfile> {
  const model = options.models.getModel(options.model.provider, options.model.modelId);
  if (!model) throw new Error(`找不到剖面生成用的模型：${options.model.provider}/${options.model.modelId}`);

  const prompt = renderTemplate(await loadHandoff(options), {
    transcript,
    previous: previous ? renderPreviousProfile(previous, options.prompts.messages) : "（无）",
  });
  const stream = options.models.streamSimple(model, { messages: [{ role: "user", content: prompt }] });
  const message = await stream.result();
  if (message.stopReason === "error" || message.stopReason === "aborted") {
    throw new Error(message.errorMessage ?? `profile_${message.stopReason}`);
  }
  const text = message.content
    .filter((block): block is { type: "text"; text: string } => block.type === "text")
    .map((block) => block.text)
    .join("\n");
  const corpus = previous ? `${transcript}\n${previous.text}` : transcript;
  return parseProfileOutput(text, corpus);
}

/** 有界重试的剖面生成：异常与形状失败都算失败，耗尽上限后抛最后一次的原因（机械降级兑底）。 */
async function profileBounded(
  options: CompactorOptions,
  transcript: string,
  previous: PreviousProfile | undefined,
): Promise<PageProfile> {
  let lastError: unknown = new Error("empty_profile");
  for (let attempt = 0; attempt < PROFILE_ATTEMPTS; attempt++) {
    try {
      const profile = await buildProfile(options, transcript, previous);
      if (profile.mood.trim()) return profile;
    } catch (error) {
      lastError = error;
    }
  }
  throw lastError;
}

/**
 * 机械尾巴（挂点冻结的纯函数，12dab09/cbf5c41 起降级换页消费，T12 起正常剖面页共用）：
 * 取被压缩页 transcript 尾部最近 limit 条 counted entry 的原文，顺序与模型见过的标注
 * 格式（[m:id] 锚点 / [主人][特别关注] 打标 / 背景板声明）原样保留，不二次渲染。
 * 来源硬约束：只从被压缩页的 transcript 取——不碰 recent / chatlog，不把鱼没见过的
 * 消息伪装成已读上下文。engage_tick（开窗积压 / shard 背景板）行包含在内：T12 裁定
 * 背景板也是模型见过的内容，行进尾巴；但它们不进摘要输入（renderCountedEntries 的
 * lines 仍为空，摘要零变化；阈值字符数经 chars 计入，终审 #2）。
 */
export function mechanicalTail(
  counted: CountedEntry[],
  limit: number,
  messages: Record<string, string>,
): { lines: string[]; entries: number; start: string; end: string } {
  const tail = counted.slice(-limit);
  const stamps = tail.map((e) => e.at).filter((at): at is number => typeof at === "number");
  const models = tail.flatMap((entry) => entry.tailMessages ?? historyInputProjection((entry.tailLines ?? []).join("\n")).messages);
  const attachments = tail.flatMap((entry) => entry.tailAttachments ?? historyInputProjection((entry.tailLines ?? []).join("\n")).attachments);
  const history = models.length > 0 ? renderMessageList(models, messages, "history") : "";
  return {
    lines: history ? [history, ...attachments.map((attachment) => `\n${attachment}`)] : [],
    entries: tail.length,
    start: stamps.length ? formatStamp(Math.min(...stamps)) : "?",
    end: stamps.length ? formatStamp(Math.max(...stamps)) : "?",
  };
}

/**
 * 机械降级的新页起点：不生成摘要，直接消费 mechanicalTail（被压缩页尾部最近 50 条
 * entry 的原文）搬进新页，头部加一行机械时间说明（起止时间与条数取自 entry 时间戳，
 * 模板 key 在 prompt/messages.md，缺 key 时用纯时间戳拼接兑底——降级路径必须无条件
 * 可渲染）。任何模型都不再参与。
 */
function mechanicalHandoff(counted: CountedEntry[], messages: Record<string, string>): string {
  const tail = mechanicalTail(counted, FALLBACK_TAIL_ENTRIES, messages);
  const header = renderTemplate(messages["compact_time_header"] ?? TIME_HEADER_FALLBACK, {
    count: String(tail.entries),
    start: tail.start,
    end: tail.end,
  });
  return [header, ...tail.lines].join("\n");
}

/**
 * 正常路径的新页起点（T12）：剖面卡片（≤300 字）+ 被压缩页尾部最近 50 条原文。
 * 卡片与尾巴之间空一行；尾巴只从被压缩页 transcript 机械截取（mechanicalTail，与降级
 * 共用同一纯函数）。时间范围与活跃成员由代码从 entry 时间戳 / fish.inbound 结构化数据
 * 纯机械生成——模型不产出这两个字段，也就无从编造。
 */
export function buildProfileHandoff(profile: PageProfile, counted: CountedEntry[], messages: Record<string, string>): string {
  return [...renderProfileCard(profile, counted, messages), "", ...mechanicalTail(counted, FALLBACK_TAIL_ENTRIES, messages).lines].join("\n");
}

/** 剖面卡片的机械渲染：时间头（整页口径）+ 成员 + 话头 + 承诺 + 氛围，总长 ≤ PROFILE_CARD_CHARS。 */
function renderProfileCard(profile: PageProfile, counted: CountedEntry[], messages: Record<string, string>): string[] {
  const stamps = counted.map((e) => e.at).filter((at): at is number => typeof at === "number");
  const header = renderTemplate(messages["compact_time_header"] ?? TIME_HEADER_FALLBACK, {
    count: String(counted.length),
    start: stamps.length ? formatStamp(Math.min(...stamps)) : "?",
    end: stamps.length ? formatStamp(Math.max(...stamps)) : "?",
  });
  const members = activeMembers(counted);

  let threads = profile.threads;
  let promises = profile.promises;
  const assemble = (): string[] => {
    const lines = [header];
    if (members.length > 0) lines.push(renderTemplate(messageOf(messages["compact_profile_members"], "compact_profile_members"), { members: members.join("、") }));
    if (threads.length > 0) {
      lines.push(messageOf(messages["compact_profile_threads_header"], "compact_profile_threads_header"));
      lines.push(...threads.map((item) => profileLine(item, THREAD_STATUS[item.status], messages)));
    }
    if (promises.length > 0) {
      lines.push(messageOf(messages["compact_profile_promises_header"], "compact_profile_promises_header"));
      lines.push(...promises.map((item) => profileLine(item, PROMISE_STATUS[item.status], messages)));
    }
    lines.push(renderTemplate(messageOf(messages["compact_profile_mood"], "compact_profile_mood"), { mood: profile.mood }));
    return lines;
  };

  let lines = assemble();
  // 300 字上限是机械裁决：超了丢条目而不是放宽。优先丢已完结（历史包袱），再丢话头，
  // 承诺（鱼自己的欠账）最后丢；全丢完还超就截氛围行。逐字条目本身有长度/数量上限，
  // 这里兑底的是模型仍写出长引用的极端情况。
  while (lines.join("\n").length > PROFILE_CARD_CHARS) {
    if (threads.some((item) => item.status === "done")) {
      const at = threads.findIndex((item) => item.status === "done");
      threads = threads.filter((_, i) => i !== at);
    } else if (promises.some((item) => item.status === "done")) {
      const at = promises.findIndex((item) => item.status === "done");
      promises = promises.filter((_, i) => i !== at);
    } else if (threads.length > 0) {
      threads = threads.slice(0, -1);
    } else if (promises.length > 0) {
      promises = promises.slice(0, -1);
    } else {
      break;
    }
    lines = assemble();
  }
  const overflow = lines.join("\n").length - PROFILE_CARD_CHARS;
  if (overflow > 0) {
    const body = lines.slice(0, -1);
    const mood = lines[lines.length - 1];
    const room = PROFILE_CARD_CHARS - body.join("\n").length - 1;
    lines = room > 0 ? [...body, mood.slice(0, room)] : body;
  }
  return lines;
}

/** 活跃成员 top≤5（纯机械统计）：按 fish.inbound 结构化数据里的 QQ 号计数，昵称取最新一条。 */
function activeMembers(counted: CountedEntry[]): string[] {
  const stats = new Map<string, { nickname: string; n: number }>();
  for (const entry of counted) {
    if (entry.speaker === undefined) continue;
    const hit = stats.get(entry.speaker.userId) ?? { nickname: entry.speaker.nickname, n: 0 };
    hit.nickname = entry.speaker.nickname.slice(0, 12);
    hit.n += 1;
    stats.set(entry.speaker.userId, hit);
  }
  return [...stats.entries()]
    .sort((a, b) => b[1].n - a[1].n)
    .slice(0, 5)
    .map(([userId, hit]) => `${hit.nickname}(${userId})`);
}

/**
 * 从 pi.reset head 提取上一页剖面（字段级合并的输入）：reset 后 viewState 的首个 entry
 * 就是携带换页文本的 pi.reset（head: self，model 里是那条 user message）；卡片条目行
 * 按状态词（进行中/已完结/未兑现/已兑现）机械回读，只留还开着的条目。旧页是叙事摘要 /
 * 机械降级页 / 解析不出条目时返回 undefined——按首换页处理，不报错不阻塞。
 * text（整份旧换页文本）作为带入条目逐字校验的 corpus 一并返回；at 是落页时间
 * （pi.reset head 的 entry 时间戳），T13 开窗弹药行的「N 天前」锚点消费它，拿不到为 undefined。
 */
async function extractPreviousProfile(conversation: Conversation): Promise<PreviousProfile | undefined> {
  try {
    const view = await conversation.viewState(ctx);
    let text = "";
    let at: number | undefined;
    try {
      const head = view.value.entries.find((entry) => entry.kind === "pi.reset");
      if (head) {
        text = entryText(head.model);
        at = entryTimestamp(head);
      }
    } finally {
      view.dispose();
    }
    const threads: ProfileItem[] = [];
    const promises: ProfileItem[] = [];
    for (const raw of text.split(/\r?\n/)) {
      const match = /^- 「(.+)」(?:\[m:(\d+)\] )?（(进行中|已完结|未兑现|已兑现)）$/.exec(raw.trim());
      if (!match) continue;
      const done = match[3] === "已完结" || match[3] === "已兑现";
      const item: ProfileItem = { quote: match[1], ...(match[2] !== undefined ? { anchor: match[2] } : {}), status: done ? "done" : "open" };
      (match[3] === "未兑现" || match[3] === "已兑现" ? promises : threads).push(item);
    }
    const open: PageProfile = {
      threads: threads.filter((item) => item.status === "open"),
      promises: promises.filter((item) => item.status === "open"),
      mood: "",
    };
    if (open.threads.length + open.promises.length === 0) return undefined;
    return { profile: open, text, ...(at !== undefined ? { at } : {}) };
  } catch {
    return undefined;
  }
}

/**
 * 开窗弹药栏（T13）的剖面来源：当前页 pi.reset head 里上一页剖面还开着的未兑现承诺
 * 与话头（T12 字段，quote 逐字、锚点原样）。开窗时刻会话空闲（injection 轮已过 busy
 * 检查），viewState 只读快照随时可取——提取失败 / 无旧剖面 / 无开条目一律返回空数组，
 * 不报错不阻塞开窗注入（弹药栏是可选增强，宁缺勿错）。
 */
export interface ProfileAmmo {
  items: ProfileItem[];
  /** 剖面落页时间（pi.reset head 时间戳）：弹药行「N 天前」的机械锚点；拿不到为 undefined。 */
  at?: number;
}

/** 剖面弹药（T13 开窗拼装的来源①）：承诺（鱼的欠账）在前、话头（还在聊的）在后。 */
export async function profileAmmoOf(conversation: Conversation): Promise<ProfileAmmo> {
  const previous = await extractPreviousProfile(conversation);
  if (!previous) return { items: [] };
  return {
    items: [...previous.profile.promises, ...previous.profile.threads],
    ...(previous.at !== undefined ? { at: previous.at } : {}),
  };
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
 * 不进摘要（engage_tick 仍计入换页阈值的条数与字符数、原文行进换页尾巴，见 renderCountedEntries）；
 * fish.eval（主人评价事件）同被排除（决策 11b，只进抽取白名单）。
 */
export async function renderTranscript(conversation: Conversation): Promise<RenderedTranscript> {
  const counted = await renderCountedEntries(conversation);
  const transcript = counted.flatMap((e) => e.lines).join("\n");
  return { transcript, entries: counted.length, chars: transcript.length };
}

/**
 * 一条入册 entry 摊平后的行与它的时间戳（时间头 / 尾巴用；没有可靠时间戳时为 undefined）。
 * lines 进摘要输入（剖面生成的 transcript）；chars 是计入换页阈值的字符数——engage_tick
 * 的 tailLines 不进摘要但同样计入 chars（终审 #2：背景板行必须能顶动 maxChars 阈值）；
 * speaker（fish.inbound 的结构化数据）供剖面卡片的活跃成员纯机械统计。
 */
export interface CountedEntry {
  lines: string[];
  /** 计入换页阈值的字符数（lines 与 tailLines 的正文，不含宿主拼接的分隔换行）。 */
  chars: number;
  at?: number;
  /** 旧字段：只保留作历史输入投影，不再直接拼成换页尾。 */
  tailLines?: string[];
  /** 新尾部：真实顺序的标准消息行（旧 entry 只有可读文本时保留字符串，不伪造 m:id）。 */
  tailMessages?: (ModelMessage | string)[];
  /** 新尾部：当页模型实际见过的引用/合集附件，统一放在完整历史列表之后。 */
  tailAttachments?: string[];
  speaker?: { userId: string; nickname: string };
}

/**
 * 从模型实际见过的 user text 提取历史消息与附件。当前标准输入直接取列表内原文；
 * 旧格式没有统一边界时只保留带真实 [m:id] 的可读行，旧窗口说明/footer/任务提示不进场。
 * 附加段只认引用原文与合集附件；[本轮要求]、图片标签和工具过程不进历史尾。
 */
function historyInputProjection(text: string): { messages: string[]; attachments: string[] } {
  const lines = text.split("\n");
  const start = lines.indexOf("> 消息起始");
  const end = start >= 0 ? lines.indexOf("> 消息结束", start + 1) : -1;
  if (start >= 0 && end > start) {
    const messages = lines.slice(start + 1, end).filter((line) => line.trim().length > 0);
    const rest = lines.slice(end + 1).join("\n").trim();
    const attachments = rest
      .split(/\n\s*\n/)
      .map((part) => part.trim())
      .filter((part) => part.startsWith("[引用原文]") || part.startsWith("[转发合集"));
    return { messages, attachments };
  }
  const messages = lines
    .filter((line) => /^(?:➤\s*)?(?:\[特别关注\]\s*)?\[m:/.test(line))
    .map((line) => line.replace(/^➤\s*/, ""));
  return { messages, attachments: [] };
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
 * shard 轮）计入换页阈值（entries 与 chars：tailLines 字符数也算，终审 #2），不进摘要输入
 * （决策 4：背景板不进摘要），但
 * 原文行进换页尾巴（T12 裁定：背景板也是模型见过的内容，tailLines）；
 * fish.worker_round（worker 会话的逛轮触发语，E4）同 engage_tick 口径：计数入阈值、
 * 行进尾巴、不进摘要输入；
 * fish.eval（主人评价事件，T6）是书记性 entry（无 model 字段、不占模型上下文），
 * 既不计数也不进 handoff（决策 11b：排除摘要，只进抽取白名单）。
 * stopReason:error 的空 assistant entry（生产观察：失败轮会留一条 content 空的错误
 * entry 在活跃链，重放成噪音）在这里显式跳过，不进摘要也不进尾巴。
 */
async function renderCountedEntries(conversation: Conversation, self: { nickname: string; userId: string } = { nickname: "Elysia", userId: "" }): Promise<CountedEntry[]> {
  const view = await conversation.viewState(ctx);
  const counted: CountedEntry[] = [];

  try {
    for (const entry of view.value.entries) {
      if (isEmptyErrorAssistant(entry)) continue;
      if (entry.kind === "pi.user" || entry.kind === MEMORY_INBOUND_KIND) {
        const text = entryText(entry.model);
        const projection = historyInputProjection(text);
        const data = entry.kind === MEMORY_INBOUND_KIND ? (entry.data as Partial<MemoryInbound> | undefined) : undefined;
        const speaker =
          typeof data?.userId === "string" && data.userId.trim() && typeof data?.nickname === "string"
            ? { userId: data.userId.trim(), nickname: data.nickname.trim() }
            : undefined;
        const lines = text ? [`群友: ${text}`] : [];
        counted.push({
          lines,
          chars: lines.join("\n").length,
          at: entryTimestamp(entry),
          tailMessages: projection.messages,
          tailAttachments: projection.attachments,
          ...(speaker ? { speaker } : {}),
        });
      } else if (entry.kind === MEMORY_ENGAGE_KIND || entry.kind === MEMORY_WORKER_KIND) {
        // engage_tick / worker_round：计入阈值（entries 与 chars），不进摘要输入；原文行只进换页尾巴（tailLines），
        // 时间戳保留给时间头
        const text = entryText(entry.model);
        const projection = historyInputProjection(text);
        counted.push({
          lines: [],
          chars: text.length,
          at: entryTimestamp(entry),
          tailMessages: projection.messages,
          tailAttachments: projection.attachments,
        });
      } else if (entry.kind === "fish.outbound") {
        const data = entry.data as { items?: string[]; at?: unknown; messageId?: number | string } | undefined;
        const lines = (data?.items ?? []).map((text) => `我: ${text}`);
        const tailMessages: ModelMessage[] = (data?.items ?? []).map((text, index) => ({
          ...(index === 0 && data?.messageId !== undefined ? { messageId: data.messageId } : {}),
          userId: self.userId,
          nickname: self.nickname,
          text,
          mentionsBot: false,
          replyIds: [],
          master: false,
          watched: false,
        }));
        counted.push({
          lines,
          chars: lines.join("\n").length,
          at: typeof data?.at === "number" ? data.at : undefined,
          tailMessages,
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

/** 生产观察（T12）：模型错误轮会在活跃链里留下 content 空的 assistant entry（stopReason:error），
 * 重放成噪音。renderCountedEntries / renderTranscript / 换页尾巴都显式跳过它们。 */
function isEmptyErrorAssistant(entry: { kind: string; model?: unknown }): boolean {
  if (entry.kind !== "pi.assistant" || !Array.isArray(entry.model) || entry.model.length === 0) return false;
  return entry.model.every((message) => (message as { stopReason?: unknown }).stopReason === "error") && !entryText(entry.model);
}

export interface MemoryTranscript {
  transcript: string;
  subjects: { subject: string; name: string }[];
}

/**
 * 记忆抽取专用的原始转录：只读结构化原始 entry（fish.inbound 的 data 与
 * fish.outbound 的 items），带结构化说话人元数据；不读 pi.user / pi.system /
 * fish.gif_ingest / fish.engage_tick / 工具结果 / thinking，也不复用上面宿主拼装
 * 文案的 renderTranscript。改动这个白名单前必读 src/memory/model.ts 的安全边界注释：
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
          if (text.trim()) lines.push(`${stamp ? `[${stamp}] ` : ""}我: ${text}`);
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
