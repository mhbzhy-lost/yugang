/**
 * 把 pi-durable 组装成「鱼」。
 *
 * 一只鱼身上只有：
 *   一张嘴  say_*             唯一出口族（say_words / say_media / say_meme / say_voice），硬校验
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
  defineDoc,
  defineEntry,
  defineExtension,
  LiveDoc,
  section,
  type Conversation,
  type ConversationId,
  type Extension,
  type Storage,
  type ToolRegistration,
} from "@earendil-works/pi-durable";
import { DEFAULT_LIMITS, REJECTION_CODES, type EgressLimits } from "./egress/policy.ts";
import { OutboundEntry, type OutboundPayload } from "./tools/say-shared.ts";
import { loadPrompts, renderTemplate, type PromptSet } from "./prompts.ts";
import { loadToolSurface } from "./tools/loader.ts";
import { renderToolCatalog } from "./tools/catalog.ts";
import type { RoundKind, RoundTrigger, ToolManifest, ToolPackageDeps } from "./tools/types.ts";
import type { EngagementMode } from "./fish-config.ts";
import { withSeenLinkHarvest, withToolTimeout } from "./tools/timeout.ts";
import { WatchDoc } from "./store.ts";
import { createCompactor, MemoryExtractError, type CompactResult, type Compactor } from "./compact.ts";
import { ChatsDoc, MemoryDoc, MemoryPendingDoc, MemoryPrivateDoc, OutboxDoc } from "./store.ts";
import {
  approvePending,
  deleteFactById,
  hasFact,
  isPatchEmpty,
  mergeMemoryStates,
  monthAnchor,
  newPendingId,
  rejectPending,
  renderMemorySection,
  signalsSuffix,
  summarizeFeedback,
  summarizePatch,
  formatAgeShort,
  MEMORY_CAPS,
  MEMORY_PENDING_CAP,
  MEMORY_ZERO_EXTRACT_PAGES,
  type MemoryCommand,
  type PendingMemoryEntry,
} from "./memory.ts";
import { memoryKeyOf, peekScope, privateMemoryKeyOf } from "./memory-scope.ts";

/** 群档案作为一条 system 消息放进 transcript，只在建会话时写一次。 */
export const GroupProfileEntry = defineEntry("fish.group-profile");

/** fish.sentmap 的一条：实际发出的 QQ 消息 id → outbound entry（评价定位链路的唯一事实源）。 */
export interface SentmapEntry {
  /** 被评 outbound 条目所在的会话。 */
  conversationId: string;
  /** fish.outbound transcript entry 的 id（按 outbox 幂等 key 关联解析）。 */
  entryId: number;
  at: number;
}

export interface SentmapState {
  version: 1;
  /** QQ 消息 id（字符串化）→ 映射；30 天滚动清理（drain 写入时顺手淘汰）。 */
  map: Record<string, SentmapEntry>;
}

/**
 * 发送回执映射（/评 指向型定位，决策 11b B2①）：drain 每条实际发出的 QQ 消息
 * 在此记 sentMessageId → outbound entryId；fish.enqueue 的机械消息（busy/cmd/working
 * 等）没有 transcript entry，不在此列。部分发送失败只记成功条目。
 */
export const SentmapDoc = defineDoc<SentmapState>({
  kind: "fish.sentmap",
  version: 1,
  scope: "session",
  initial: () => ({ version: 1, map: {} }),
  checkpointWhen: () => true,
});

/** emit 的返回值：实际发出的 QQ 消息 id 列表（群文本/图片逐条；void = 无可记录 id，如私聊发送）。 */
export type SentMessageIds = (number | string)[];

/** 人格名的「默认」哨兵：默认人格的会话键不带后缀，也不另外选扩展。 */
export const DEFAULT_PERSONA = "默认";

/**
 * 人格 = 一个 Fish 扩展实例：默认人格叫 `fish`（人格来自 prompt/persona.md），
 * 其余叫 `fish:<名>`（人格 = 人格书全文）。工具实例共享，会话只选其中一个。
 *
 * sections 顺序固定：runtime（人格无关的运行时协议）→ persona（人格）→ tool_catalog
 * （已启用工具目录，只用于发现）→ ops / people / watched / memory。表情包库存不进
 * system：动态库存提前注入会让 openai-completions 的前缀缓存整轮失效，改为引导
 * 模型直接调 meme 按一级情绪词检索（见 src/tools/meme/TOOL.md）。
 */
function makeFishExtension(
  name: string,
  persona: string,
  parts: {
    tools: readonly ToolRegistration[];
    prompts: PromptSet;
    manifests: readonly ToolManifest[];
    /** conversationId → 原始 chatKey（人格后缀已去掉）；root 会话没有记忆，返回 undefined */
    memoryKeyOf: (conversationId: string) => string | undefined;
    /** conversationId → 原始 chatKey：私有层 doc key（人格名@chatKey）由它现算 */
    chatKeyOf: (conversationId: string) => string | undefined;
    /** 携话模式现取（热）：runtime 的「自由交流窗口」小节仅 next 注入（决策 18，T3 接线）。 */
    engagementOf: (chatKey: string) => EngagementMode;
  },
): Extension {
  return defineExtension({
    name,
    tools: parts.tools,
    sections: [
      // 运行时协议：能力边界、输入信任、出口、错误处理、渐进加载；人格无关，不随人格换页。
      // 「自由交流窗口」小节是 next 专属的窗口协议，legacy 下动态裁掉（见 runtimeTextOf）
      section("runtime", (input) => runtimeTextOf(parts.prompts.runtime, parts.engagementOf(parts.chatKeyOf?.(String(input.conversationId)) ?? "")), { tag: false }),
      section("persona", () => persona, { tag: false }),
      // 工具目录：每次请求由 trusted manifest 现渲染，只列已启用工具的 name + 顶部摘要；
      // 「目录 ≠ 已加载」的行为说明在 prompt/runtime.md，这里不内嵌提示词
      section("tool_catalog", () => renderToolCatalog(parts.manifests, parts.prompts.messages), { tag: true }),
      // 运维书：只给主人用的管理工具怎么用（模型切换 + 重启）
      section("ops", () => parts.prompts.ops, { tag: true }),
      // 手工维护的人物档：比对话记忆更牢，和 handoff 互补
      section("people", () => parts.prompts.people, { tag: true }),
      // 特别关注名单：会话级文档，每次请求重新渲染（换页不动它），空名单不占位
      section("watched", async (input, context) => {
        const snapshot = await input.read.snapshot(WatchDoc, input.conversationId, context);
        const people = snapshot?.people ?? [];
        if (people.length === 0) return undefined;
        const header = parts.prompts.messages["watch_section_header"] ?? "";
        const lines = people.map((p) => `${p.name ? `${p.name}(${p.userId})` : p.userId}：${p.note}`);
        return [header, ...lines].filter((line) => line.length > 0).join("\n");
      }, { tag: true }),
      // 长期记忆：只经这一个 system section 注入，绝不进 user message。只读 session
      // family（不 commit、不写 lastUsedAt）；当前会话可见 = 公共 doc + 本会话私有 doc
      // 合并渲染（mergeMemoryStates，总预算 ≤900 字不变）；私有层绝不注入非来源会话。
      // 没有可渲染内容时不占位。改动这里或 renderMemoryTranscript 的白名单前必读
      // src/memory.ts 的安全边界注释：记忆抽取只读结构化原始 entry，必须继续排除
      // pi.system、宿主任务文案和工具结果，否则「记忆 → 抽取 → 记忆」的自我污染闭环会复活。
      section("memory", async (input, context) => {
        const memoryKey = parts.memoryKeyOf(String(input.conversationId));
        if (!memoryKey) return undefined;
        const chatKey = parts.chatKeyOf(String(input.conversationId));
        const [pub, priv] = await Promise.all([
          input.read.snapshot(MemoryDoc, memoryKey, context),
          chatKey === undefined
            ? Promise.resolve(undefined)
            : input.read.snapshot(MemoryPrivateDoc, privateMemoryKeyOf(memoryKey, chatKey), context),
        ]);
        if (!pub && !priv) return undefined;
        return renderMemorySection(mergeMemoryStates(pub, priv), peekScope(String(input.conversationId)), parts.prompts.messages);
      }, { tag: true }),
    ],
  });
}

const ctx = BACKGROUND_CONTEXT;

/** runtime.md 里 next 专属小节的段首前缀（T1 契约：稳定段首，动态裁剪的定位锚）。 */
const ENGAGE_RUNTIME_PREFIX = "自由交流窗口：";

/**
 * runtime 的模型可见动态裁剪（决策 18）：engagement≠next 时把「自由交流窗口」整段
 * 裁掉——那是 next 的窗口协议，legacy 下看到只会误导。按段首前缀定位、按空行分段
 * 裁剪，不引入新文案；找不到该段（prompt 被改坏）时原样返回，缺省（未接回调）= legacy。
 */
function runtimeTextOf(base: string, engagement: EngagementMode): string {
  if (engagement === "next") return base;
  const lines = base.split("\n");
  const start = lines.findIndex((line) => line.startsWith(ENGAGE_RUNTIME_PREFIX));
  if (start < 0) return base;
  let end = lines.length;
  for (let index = start + 1; index < lines.length; index++) {
    if (lines[index].trim() === "") {
      end = index;
      break;
    }
  }
  const kept = [...lines.slice(0, start), ...lines.slice(end)];
  const text = kept.join("\n").replace(/\n{3,}/g, "\n\n").trim();
  return text.length > 0 ? text : base;
}

export interface GroupProfile {
  groupId: string;
  count: number;
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
  /** ChatGPT/Codex 图片通道（models.image）：authPath + provider 决定登录凭据，model 是默认模型名；proxy 只给这条通道用。 */
  gptImage?: { authPath: string; provider: string; model: string; proxy?: string };
  /** config/models.json 路径；config 工具写回 models 角色表时用。 */
  modelsPath?: string;
  /** SD WebUI（Windows 宿主机）的 baseUrl；给了才有本地画图。 */
  sdUrl?: string;
  /** danbooru.csv 路径；给了才能查 tag 词表。 */
  tagsCsv?: string;
  /** 主人 QQ：fs/config/restart 自改工具的身份闸，给了才注册这些工具。 */
  master?: string;
  /** submissionId → 本轮触发消息（轮类型 + quoteIds 窗口）；把回复引用绑在轮上，防串线。 */
  triggerOf?: (roundId: unknown) => RoundTrigger | undefined;
  /** conversationId → 原始 chatKey（不带人格后缀）：config 工具判定「主人私聊轮」用。 */
  chatKeyOf?: (conversationId: string) => string | undefined;
  /** conversationId → 当前人格的鱼昵称与真实 self QQ，供换页历史统一消息行使用。 */
  selfOf?: (conversationId: string) => { nickname: string; userId: string };
  /**
   * 主动 @ 的身份闸：由宿主机械提供（私聊 = not_group；群内白名单 = allow），按轮类型
   * （决策 7）：answer/legacy 轮 userId 是本轮触发者；ambient/injection 环境轮对每个
   * @ 目标各调一次、userId 携带目标 QQ，白名单同为 {主人} ∪ 本群 watched（宿主记审计）。
   * 同时交给 say_*（出口校验）使用；不提供时主动 @ 一律 fail closed。
   */
  mentionPolicyOf?: (conversationId: string, userId: number | undefined, kind: RoundKind) => "allow" | "not_group" | "not_privileged";
  /**
   * 末条自言禁言（决策 24，T15）的宿主事实：conversationId → 该会话（chatKey 级）最新一条
   * 消息是否鱼自己发的（drain 实际发送成功置 true，任一入站消息置 false，内存态重启归 false）。
   * 交给 say_*（ambient/injection 轮的素材分享校验）使用；不提供时缺省放行（宁松勿严）。
   */
  lastWasFishOf?: (conversationId: string) => boolean;
  /**
   * 会话 → 当前群成员名单：say_*（主动 @ 目标校验）与 watch（关注对象校验）共用同一条链路。
   * 群号必须由宿主自己从映射键解析，不能采信模型给的号码。
   */
  groupMembersOf?: (conversationId: string) => Promise<{ nickname: string; userId: string }[]>;
  /** 特别关注名单变更后通知宿主（整份新名单，宿主据此替换内存镜像与随机门概率）。 */
  onWatchChanged?: (conversationId: string, people: import("./store.ts").WatchedPerson[]) => void;
  /** 表情包跨轮冷却（毫秒）；传函数则每次现取，改配置立即生效。 */
  memeCooldownMs?: number | (() => number);
  /** 单次工具调用超时（秒），缺省 30。 */
  toolTimeoutSeconds?: number;
  /** 个别工具的单独超时（秒）：只放宽指定工具，其余仍按 toolTimeoutSeconds。 */
  toolTimeoutOverrides?: Record<string, number>;
  /**
   * 模型请求的传输方式；缺省 auto（provider 自己挑，codex 会优先 WebSocket）。
   * 走 HTTP 代理时必须设 sse：Node 的 WebSocket 不吃 --use-env-proxy，会直接报 WebSocket error。
   */
  streamTransport?: "sse" | "websocket" | "websocket-cached" | "auto";
  /** 按会话取 TTS 配置（人格相关）；返回 undefined 表示这个会话没有语音能力。 */
  ttsOf?: (conversationId: string) => import("./tts.ts").TtsConfig | undefined;
  /** 携话模式现取（热）：runtime 的「自由交流窗口」小节仅 next 注入；缺省 = legacy（裁掉）。 */
  engagementOf?: (chatKey: string) => EngagementMode;
  /** 静默轮（自动收表情包）：这一轮 say_* 一律拒绝。 */
  silentOf?: (roundId: unknown) => boolean;
  /** 本轮 say_* 的 execute 被进入时回调；宿主按 submission 计数，识别零出口轮。 */
  onSayCall?: (roundId: unknown) => void;
  /** 重耗时工具 execute 入口的宿主回调：本轮第一次调用时发「正在执行」机械提示；restart 会 await 返回的 Promise。 */
  onLongWork?: (tool: string, submissionId: unknown) => void | Promise<void>;
  /** submissionId → 本轮触发消息自带的 bypass 段；仅 draw 消费，轮结束失效。 */
  bypassOf?: (roundId: unknown) => string | undefined;
  /** 每个群的工作目录根；实际 cwd 是 <workspaceRoot>/<groupKey>。 */
  workspaceRoot: string;
  limits?: Partial<Omit<EgressLimits, "mediaRoot">>;
  /** 上下文压缩：攒到阈值就 reset + handoff。不给就不压。 */
  compact?: {
    model?: ModelRef;
    /** 记忆抽取用的模型；缺省与 handoff 同一个。 */
    memoryModel?: ModelRef;
    maxEntries?: number;
    maxChars?: number;
    /** 现取的阈值（热更新用）：改配置后下一轮压缩就按新值判断。 */
    limits?: () => { maxEntries: number; maxChars: number };
  };
  /** look 的视觉描述模型；缺省用主模型。 */
  visionModel?: ModelRef;
  /** look / video 视觉描述的兜底模型（models.vision_fallback）；省略 = 无兜底。 */
  visionFallbackModel?: ModelRef;
  emit: (conversationId: ConversationId, payload: OutboundPayload) => void | SentMessageIds | Promise<void | SentMessageIds>;
  /** 贴表情回应，只带表情编号；目标消息由本轮触发绑定（不取会话级 lastMessageId）。 */
  react: (conversationId: ConversationId, emoji: string, messageId?: number | string) => void | Promise<void>;
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
  /** 待审记忆一览（全局单视图）：按人格分组，组内最旧在前；不含没注册人格的残留 doc。 */
  pendingMemories(): Promise<{ persona: string; entries: PendingMemoryEntry[] }[]>;
  /** 同意一条待审：公共=并入人格公共 doc；私有=并入该人格在来源会话的私有 doc。 */
  approveMemory(id: string, track: "公共" | "私有"): Promise<
    { status: "ok"; track: "公共" | "私有"; persona: string; originChatKey: string; digest: string }
      | { status: "missing" | "no_origin" }
  >;
  /** 拒绝待审：单条 id 或 "all"（全部人格的全部待审）；返回删掉的条数。 */
  rejectMemory(id: string | "all"): Promise<number>;
  /** /记忆 指令的机械回复（闸前通道，不进模型）：群内只回引导语，私聊里执行列表/同意/拒绝/删除。 */
  memoryCommandReply(chatKey: string, command: MemoryCommand): Promise<string>;
  /** 取（或创建）某个群在指定人格下的会话；映射持久化，重启后还是同一个会话。未注册人格回退默认。 */
  group(groupKey: string, profile?: GroupProfile, persona?: string): Promise<Conversation>;
  /** 把 outbox 里排队的消息发出去；返回实际发了几条。队首卡在 sending 的会话会被跳过（不重发）。 */
  drain(extra?: readonly ConversationId[]): Promise<number>;
  /** 不经模型直接往 outbox 里排队一条（宿主侧机械回复专用，同样走唯一出口）。 */
  enqueue(conversationId: ConversationId, payload: OutboundPayload): Promise<void>;
  close(): Promise<void>;
}

export async function openFish(options: FishOptions): Promise<Fish> {
  const models = options.models ?? createModels();
  const now = options.now ?? Date.now;
  const mediaRoot = resolve(options.mediaRoot);
  const workspaceRoot = resolve(options.workspaceRoot);
  const limits: EgressLimits = { ...DEFAULT_LIMITS, ...options.limits, mediaRoot };

  const prompts = loadPrompts(resolve(options.promptRoot));

  // conversationId → 该会话当前人格名（memory doc key）：压缩链路找记忆 doc、
  // memory section 找渲染对象都靠它。一个人格在所有会话（各群、私聊）指向同一个
  // family member；root conversation 没有映射，记忆相关的一切都返回 undefined
  // （不注入、不抽取）。
  const memoryKeyByConversation = new Map<string, string>();
  const memoryKeyOfConversation = (conversationId: string): string | undefined => memoryKeyByConversation.get(conversationId);
  // conversationId → 原始 chatKey（不带人格后缀）：待审条目的来源会话与私有层 doc key
  // （人格名@chatKey）都由它现算；group() 的创建与复用两条路径都会登记。
  const chatKeyByConversation = new Map<string, string>();
  const chatKeyOfConversation = (conversationId: string): string | undefined => chatKeyByConversation.get(conversationId);

  // 最终 loader：扫描 src/tools/<name>/TOOL.md + tool.ts，严格一一对应后调 factory 注册；
  // say_* 四工具 / react / tool_search eager，其余已启用工具 deferred。依赖不满足（无 master、
  // 无出口限额等）的 factory 返回 undefined：不进 agent.tools、agent.deferred、tool_catalog。
  const packageDeps: ToolPackageDeps = {
    prompts,
    mediaRoot,
    limits,
    now,
    ...(models ? { models } : {}),
    visionModel: options.visionModel ?? options.model,
    ...(options.visionFallbackModel ? { visionFallbackModel: options.visionFallbackModel } : {}),
    ...(options.searchKey === undefined ? {} : { searchKey: options.searchKey }),
    ...(options.master === undefined ? {} : { master: options.master }),
    ...(options.modelsPath === undefined ? {} : { modelsPath: options.modelsPath }),
    ...(options.chatKeyOf ? { chatKeyOf: options.chatKeyOf } : {}),
    // 同一条链路两用：watch 校验关注对象、say_* 校验主动 @ 的目标
    ...(options.groupMembersOf ? { groupMembersOf: options.groupMembersOf, membersOf: options.groupMembersOf } : {}),
    ...(options.onWatchChanged ? { onWatchChanged: options.onWatchChanged } : {}),
    ...(options.gptImage ? { gptImage: options.gptImage } : {}),
    ...(options.sdUrl === undefined ? {} : { sdUrl: options.sdUrl }),
    ...(options.tagsCsv === undefined ? {} : { tagsCsv: options.tagsCsv }),
    ...(options.triggerOf ? { triggerOf: options.triggerOf } : {}),
    ...(options.bypassOf ? { bypassOf: options.bypassOf } : {}),
    ...(options.mentionPolicyOf ? { mentionPolicyOf: options.mentionPolicyOf } : {}),
    // 末条自言禁言（决策 24）：宿主事实回调，say_* 的 ambient/injection 轮素材分享校验消费
    ...(options.lastWasFishOf ? { lastWasFishOf: options.lastWasFishOf } : {}),
    ...(options.ttsOf ? { ttsOf: options.ttsOf } : {}),
    ...(options.silentOf ? { silentOf: options.silentOf } : {}),
    ...(options.onSayCall ? { onSayCall: options.onSayCall } : {}),
    ...(options.onLongWork ? { onLongWork: options.onLongWork } : {}),
    ...(options.memeCooldownMs !== undefined ? { memeCooldownMs: options.memeCooldownMs } : {}),
    // 宿主侧 limits 与 react 是 FishOptions 硬性要求，这里只是统一交给 factory
    react: options.react,
  };
  const surface = await loadToolSurface(packageDeps);

  // 启动必要 key 校验：作用于合并后的视图（中心 prompt/messages.md + 各工具 TOOL.md 的
  // tool-messages 块，loadToolSurface 已就地并入 prompts.messages），清单与迁移前一致
  for (const code of [
    ...REJECTION_CODES,
    "say_sent",
    "say_once",
    "busy_reply",
    "tool_catalog_header",
    "tool_catalog_line",
    "tool_search_ok",
    "tool_search_line",
    "tool_search_none",
    "tool_search_empty",
    "tool_search_bad_limit",
    "memory_section_header",
    "memory_people_header",
    "memory_lore_header",
    "memory_cards_header",
    "cmd_memory_group",
    "cmd_memory_usage",
    "cmd_memory_empty",
    "cmd_memory_list_header",
    "cmd_memory_entry",
    "cmd_memory_more",
    "cmd_memory_ok",
    "cmd_memory_missing",
    "cmd_memory_no_origin",
    "cmd_memory_rejected",
    "cmd_memory_rejected_all",
    "cmd_memory_deleted",
    "cmd_memory_delete_missing",
    "cmd_memory_supersede_note",
    "cmd_memory_zero_extract",
    "memory_feedback_missing_quote",
  ]) {
    if (!prompts.messages[code]) throw new Error(`缺少文案 key：${code}（中心或 TOOL.md）`);
  }

  const registered = new Map(surface.tools.map((tool) => [tool.name, tool]));
  for (const name of ["say_words", "say_media", "say_meme", "say_voice", "react", "tool_search"]) {
    if (!registered.has(name)) throw new Error(`核心工具未注册：${name}`);
    if (registered.get(name)!.deferred === true) throw new Error(`核心工具必须是 eager：${name}`);
  }

  // 人格扩展：默认 fish + 每本人格书一个 fish:<名>；同一套工具实例，会话按名只选其一
  // 单次工具调用超时（默认 30 秒）：卡住的通常是某一个工具，不是整轮。
  // withToolTimeout 用展开拷贝包装：deferred / callers / parameters / description 原样保留
  const toolTimeoutMs = (options.toolTimeoutSeconds ?? 30) * 1000;
  const toolTimeoutMessage = prompts.messages["tool_timeout"] ?? "tool_timeout";
  const fishTools: readonly ToolRegistration[] = surface.tools.map((tool) => {
    const override = options.toolTimeoutOverrides?.[tool.name];
    const wrapped = withToolTimeout(tool, override === undefined ? toolTimeoutMs : override * 1000, toolTimeoutMessage);
    return withSeenLinkHarvest(wrapped, async (api, context) => {
      const live = (await (api as { snapshot: (doc: unknown, id: string, c: unknown) => Promise<unknown>; conversationId: string })
        .snapshot(LiveDoc, (api as { conversationId: string }).conversationId, context)) as { run?: { inputs?: unknown[] } } | undefined;
      return live?.run?.inputs?.[0];
    });
  });
  const fishExtension = makeFishExtension("fish", prompts.persona, { tools: fishTools, prompts, manifests: surface.manifests, memoryKeyOf: memoryKeyOfConversation, chatKeyOf: chatKeyOfConversation, engagementOf: (chatKey: string) => options.engagementOf?.(chatKey) ?? "legacy" });
  const personaExtensions = new Map<string, Extension>();
  const openers: Record<string, string> = {};
  for (const [name, book] of Object.entries(prompts.personas)) {
    personaExtensions.set(name, makeFishExtension(`fish:${name}`, book.body, { tools: fishTools, prompts, manifests: surface.manifests, memoryKeyOf: memoryKeyOfConversation, chatKeyOf: chatKeyOfConversation, engagementOf: (chatKey: string) => options.engagementOf?.(chatKey) ?? "legacy" }));
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
    ...(options.streamTransport ? { stream: { transport: options.streamTransport } } : {}),
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

  const compactor: Compactor | undefined = options.compact
    ? createCompactor({
        models,
        model: options.compact.model ?? options.model,
        prompts,
        selfOf: options.selfOf,
        maxEntries: options.compact.maxEntries ?? 80,
        maxChars: options.compact.maxChars ?? 12_000,
        ...(options.compact.limits ? { limits: options.compact.limits } : {}),
        onError: (error) => {
          if (error instanceof MemoryExtractError) console.error("[鱼缸] 记忆抽取失败", error.message);
          else console.error("[鱼缸] 压缩失败", error instanceof Error ? error.message : error);
        },
        // 记忆抽取与 handoff 各自的模型；缺省都落在 handoff 模型上（比主模型便宜一档即可）
        extract: {
          models,
          model: options.compact.memoryModel ?? options.compact.model ?? options.model,
          prompts,
        },
        memoryKeyOf: (conversationId) => memoryKeyByConversation.get(String(conversationId)),
        // 已知记忆（T11）：公共 doc + 当前会话私有 doc 的合并渲染（mergeMemoryStates，
        // 同主体事实去重），行格式与抽取器的机械解析同构：主体行「subject 昵称/昵称」、
        // 事实行「f-id YYYY-MM 事实」——SUPERSEDE 的 factId→subject 解析与 people 信号
        // 都从这份结构里机械读出。known 只喂给一次内部抽取请求，不写入会话。
        knownMemory: async (memoryKey, conversationId) => {
          const originChatKey = chatKeyByConversation.get(String(conversationId));
          const privKey = originChatKey ? privateMemoryKeyOf(memoryKey, originChatKey) : undefined;
          const pubSnap = await harness.snapshot(MemoryDoc, memoryKey, ctx);
          const privSnap = privKey !== undefined ? await harness.snapshot(MemoryPrivateDoc, privKey, ctx) : undefined;
          const merged = mergeMemoryStates(pubSnap, privSnap);
          const subjects = Object.values(merged.people).map((person) => ({
            subject: person.subject,
            name: person.names[0] ?? person.subject,
          }));
          // 已知记忆只喂给一次内部抽取请求；总长封顶 knownChars；不写入 conversation、pi.user 或 handoff
          const lines = Object.values(merged.people).flatMap((person) => [
            `${person.subject} ${person.names.join("/")}`,
            ...person.facts.filter((fact) => fact.invalidAt === undefined).map((fact) => `${fact.id} ${monthAnchor(fact.at)} ${fact.text}`),
          ]);
          const text = lines.reduce(
            (out, line) => (out.length + line.length + 1 <= MEMORY_CAPS.knownChars ? `${out}${out ? "\n" : ""}${line}` : out),
            "",
          );
          return { text, subjects };
        },
        // 只入待审库：patch 不直接 apply，主人批准后才进公共/私有 doc（审批闸硬约束）。
        // originChatKey 由 harness 的 conversation→chatKey 映射解析；同一 commit 内读改
        // 同一 family member，不能先在 commit 外 snapshot 再整份覆盖（后写会把先写的吃掉）。
        // 零提取计数（T11）：empty 累计、ok 清零（解析失败不进这里，不计零提取）；返回更新后的
        // 计数驱动压缩链路的复查模式（达 MEMORY_ZERO_EXTRACT_PAGES 重跑本页一次）
        savePendingMemories: async (memoryKey, outcome, conversationId) => {
          const originChatKey = chatKeyByConversation.get(String(conversationId)) ?? "";
          let zeroStreak = 0;
          await harness.commit(async (tx) => {
            const extractedAt = now();
            if (outcome.status === "ok" && !isPatchEmpty(outcome.patch)) {
              const pending = await tx.doc(MemoryPendingDoc, memoryKey, memoryKey);
              pending.entries.push({
                id: newPendingId(),
                patch: outcome.patch,
                originChatKey,
                at: extractedAt,
                // 抽取信号（T11）：机械重算的计数，只进待审列表展示；两类都为零时不占字段
                ...(outcome.signals.people > 0 || outcome.signals.conflict > 0 ? { signals: outcome.signals } : {}),
              });
              // 待审淘汰：超上限挤掉最旧（观察期 MEMORY_PENDING_CAP=Infinity 不生效）。
              // 只打 id 与人格名，被淘汰条目的内容不进日志（隐私）
              while (pending.entries.length > MEMORY_PENDING_CAP) {
                const evicted = pending.entries.shift();
                if (evicted !== undefined) console.log(`[鱼缸] 记忆待审淘汰 ${evicted.id} ${memoryKey}`);
              }
            }
            // 空 patch 不进待审，但 lastExtractAt 照样推进（待审写入即推进）；
            // 零提取累计 / 命中清零（解析失败不进这里，不计零提取）
            const doc = await tx.doc(MemoryDoc, memoryKey, memoryKey);
            doc.lastExtractAt = extractedAt;
            const previous = typeof doc.zeroStreak === "number" ? doc.zeroStreak : 0;
            zeroStreak = outcome.status === "empty" ? previous + 1 : 0;
            doc.zeroStreak = zeroStreak;
          }, ctx);
          return { zeroStreak };
        },
      })
    : undefined;

  const groups = new Map<string, Promise<Conversation>>();
  const sending = new Set<string>();

  /** sentmap 保留窗口：30 天滚动清理（drain 写入时顺手淘汰过期项）。 */
  const SENTMAP_TTL_MS = 30 * 24 * 60 * 60 * 1000;

  /** 幂等 key → fish.outbound transcript entry id：outbox 记录与 entry 在同一次提交里落库，
   *  用 key 关联（fish.enqueue 的机械消息没有 entry，返回 undefined）。 */
  async function outboundEntryIdOf(conversationId: ConversationId, key: string): Promise<number | undefined> {
    const conversation = await harness.conversation(conversationId, ctx);
    if (!conversation) return undefined;
    const view = await conversation.viewState(ctx);
    try {
      let found: number | undefined;
      for (const entry of view.value.entries) {
        if (entry.kind === "fish.outbound" && (entry.data as { key?: unknown } | undefined)?.key === key) {
          found = entry.id as number;
        }
      }
      return found;
    } finally {
      view.dispose();
    }
  }

  /** drain 后记 sentmap（决策 11b）：每条实际发出的 QQ 消息 id → outbound entryId，30 天滚动
   *  清理。失败只打日志不阻塞 drain（定位链路宁可少记，不影响发送语义）。 */
  async function recordSentmap(conversationId: ConversationId, key: string, sentIds: readonly (number | string)[]): Promise<void> {
    if (sentIds.length === 0) return;
    try {
      const entryId = await outboundEntryIdOf(conversationId, key);
      if (entryId === undefined) return;
      const at = now();
      await harness.commit(async (tx) => {
        const doc = await tx.doc(SentmapDoc);
        for (const id of sentIds) doc.map[String(id)] = { conversationId: String(conversationId), entryId, at };
        const cutoff = at - SENTMAP_TTL_MS;
        for (const [id, value] of Object.entries(doc.map)) {
          if (value.at < cutoff) delete doc.map[id];
        }
      }, ctx);
    } catch (error) {
      console.error("[鱼缸] sentmap 记录失败", error instanceof Error ? error.message : error);
    }
  }

  async function drainConversation(conversationId: ConversationId): Promise<number> {
    let sent = 0;
    for (;;) {
      // 只看队首：sending 在队首意味着上一次发送中断（发出多少不确定），整个会话停在这里——
      // 不翻回 queued、不重试，也绝不跳过它去发后面的 queued（宁可少发不重复）
      const box = await harness.snapshot(OutboxDoc, conversationId, ctx);
      const head = box?.queue[0];
      if (!head) return sent;
      if (head.status === "sending") return sent;

      // 陈年消息不补：超过 10 分钟的排队消息直接丢弃。原先设 2 分钟，
      // 但模型慢时（比如走订阅的 codex 一轮 30–90 秒）消息会在队列里等到过期，
      // 表现就是「鱼想回了，但回复被当成过期丢了」。10 分钟足够覆盖正常慢轮。
      if (now() - head.at > 600_000) {
        await harness.commit(async (tx) => {
          const doc = await tx.doc(OutboxDoc, conversationId);
          const index = doc.queue.findIndex((item) => item.key === head.key);
          if (index >= 0) doc.queue.splice(index, 1);
        }, ctx);
        console.log(`[鱼缸] 丢弃过期消息（${Math.round((now() - head.at) / 1000)}s 前）`);
        continue;
      }

      // 出站配速已下沉到 onebot 实际发送层（每条物理消息发送前按会话等待，见 src/qq/onebot.ts
      // 的 #pacedSend）：条目级等待只隔开 outbox 条目，挡不住一条 payload 拆出的多条物理消息。
      // 等待窗口随之下挪进发送段（标 sending 之后）：等待中进程退出，这条消息停在 sending
      // 不重发（宁少勿答）——两阶段语义不变，崩溃窗口从「等待中」变成「等待+发送中」。

      // 先标 sending 再发：崩在这中间的消息状态是"不确定"，重启时不重发（宁可少发不重复）
      await harness.commit(async (tx) => {
        const doc = await tx.doc(OutboxDoc, conversationId);
        const record = doc.queue.find((item) => item.key === head.key);
        if (record) record.status = "sending";
      }, ctx);

      try {
        const result = await options.emit(conversationId, {
          items: head.items,
          ...(head.media === undefined ? {} : { media: head.media }),
          // voice 也要透传：和 quoteId 一样，漏一个字段就等于整条消息丢一半
          ...(head.voice === undefined ? {} : { voice: head.voice }),
          // 主动 @ 跟 outbox 一起持久化：重启后补发必须还是同一条 @，不能静默降级成裸消息
          ...(head.mentions === undefined ? {} : { mentions: head.mentions }),
          quote: head.quote,
          // 引用绑定全链路贯通：早期漏传这两个字段，靠 lastMessageId 回退掩盖（会错位）；
          // 回退删除后 @ 场景全部裸发——不传，引用的真实修复在这里
          ...(head.quoteId !== undefined ? { quoteId: head.quoteId } : {}),
          ...(head.quoteForce !== undefined ? { quoteForce: head.quoteForce } : {}),
          at: head.at,
          key: head.key,
        });
        // 发送链记账（T6，/评 定位）：每条实际发出的 QQ 消息写 fish.sentmap
        await recordSentmap(conversationId, head.key, Array.isArray(result) ? result : []);
      } catch (error) {
        // 部分发送失败只记成功条目：emit 可能把已发出的 id 挂在错误的 sentIds 上
        //（onebot.SendFailure 约定），成功记完再沿用既有语义（保留 sending 不重试）。
        const partial = (error as { sentIds?: unknown }).sentIds;
        const extra = Array.isArray(partial)
          ? partial.filter((id): id is number | string => typeof id === "number" || typeof id === "string")
          : [];
        if (extra.length > 0) await recordSentmap(conversationId, head.key, extra);
        // 发送异常 = 不确定状态（sendGroup 可能已发出第一条文本和第一条 @）：保留 sending
        // 供诊断，绝不翻回 queued 重试——重试会把可能已送达的内容再发一遍。停止本会话的
        // 后续 drain（不能跳过队首发后面的记录），其余会话不受影响。
        console.error(
          `[鱼缸] ${String(conversationId)} 发送失败，保留 sending 不重试：` +
            `${error instanceof Error ? error.message : error}`,
        );
        return sent;
      }

      // 实际发送成功的记账收尾：配速时钟与末条自言标记都已在 onebot 层逐条处理
      // （#pacedSend 记钟 + onSent 逐条回调），drain 只负责摘除队列条目。
      await harness.commit(async (tx) => {
        const doc = await tx.doc(OutboxDoc, conversationId);
        const index = doc.queue.findIndex((item) => item.key === head.key);
        if (index >= 0) doc.queue.splice(index, 1);
      }, ctx);
      sent++;
    }
  }

  // 待审批的三件实现（返回对象的同名方法与 memoryCommandReply 共用）：全局单视图，
  // 所有注册人格的待审 doc 都看；人格书被删后残留的待审 doc 这里看不到（用
  // npm run memory -- --pending 查）。id 在生成时即跨人格唯一（72 位随机），
  // /记忆 同意/拒绝按 id 全局定位。
  const personaKeys = [DEFAULT_PERSONA, ...Object.keys(prompts.personas)];
  async function pendingMemoriesLocal(): Promise<{ persona: string; entries: PendingMemoryEntry[] }[]> {
    const views: { persona: string; entries: PendingMemoryEntry[] }[] = [];
    for (const persona of personaKeys) {
      const snapshot = await harness.snapshot(MemoryPendingDoc, persona, ctx);
      const entries = [...(snapshot?.entries ?? [])].sort((a, b) => a.at - b.at);
      if (entries.length > 0) views.push({ persona, entries });
    }
    return views;
  }
  async function approveMemoryLocal(id: string, track: "公共" | "私有") {
    for (const persona of personaKeys) {
      const snapshot = await harness.snapshot(MemoryPendingDoc, persona, ctx);
      const entry = snapshot?.entries.find((item) => item.id === id);
      if (!entry) continue;
      if (track === "私有" && !entry.originChatKey) return { status: "no_origin" as const };
      const targetKey = track === "私有" ? privateMemoryKeyOf(persona, entry.originChatKey) : persona;
      const digest = summarizePatch(entry.patch);
      const originChatKey = entry.originChatKey;
      try {
        await harness.commit(async (tx) => {
          const pending = await tx.doc(MemoryPendingDoc, persona, persona);
          const target = await tx.doc(track === "私有" ? MemoryPrivateDoc : MemoryDoc, targetKey, targetKey);
          const result = approvePending(pending, id, target, now());
          if (result.status === "missing") throw new Error("memory_pending_missing");
        }, ctx);
      } catch (error) {
        // 并发下条目刚好被批掉：回 missing；其它错误照实抛给宿主日志
        if (error instanceof Error && error.message === "memory_pending_missing") return { status: "missing" as const };
        throw error;
      }
      return { status: "ok" as const, track, persona, originChatKey, digest };
    }
    return { status: "missing" as const };
  }
  async function rejectMemoryLocal(id: string | "all"): Promise<number> {
    let removed = 0;
    for (const persona of personaKeys) {
      const snapshot = await harness.snapshot(MemoryPendingDoc, persona, ctx);
      if (!snapshot || snapshot.entries.length === 0) continue;
      if (id !== "all" && !snapshot.entries.some((item) => item.id === id)) continue;
      await harness.commit(async (tx) => {
        const pending = await tx.doc(MemoryPendingDoc, persona, persona);
        removed += rejectPending(pending, id);
      }, ctx);
    }
    return removed;
  }

  /** 某人格的全部私有层 doc key（人格名@chatKey）：从 ChatsDoc 的映射键推导（chatKey 或
   *  chatKey#人格 → 人格@chatKey）。known 是公共+当前私有的合并渲染（T11），supersede
   *  id 可能指向私有层事实，/记忆 的「将失效」原文查找要覆盖它们。 */
  async function privateKeysOf(persona: string): Promise<string[]> {
    const chats = await harness.snapshot(ChatsDoc, ctx);
    const keys = new Set<string>();
    for (const mappingKey of Object.keys(chats?.chats ?? {})) {
      const mark = mappingKey.lastIndexOf("#");
      const owner = mark > 0 ? mappingKey.slice(mark + 1) : DEFAULT_PERSONA;
      const base = mark > 0 ? mappingKey.slice(0, mark) : mappingKey;
      if (owner === persona) keys.add(`${persona}@${base}`);
    }
    return [...keys];
  }

  // 删除通道（/记忆 删除，仅主人私聊）：按全局唯一的 fact id 在该人格公共层与全部
  // 私有层 doc 里定位并真删除（从数组移除，区别于 supersede 的 invalidAt 失效）。
  // 私有层候选 key 由 ChatsDoc 的映射键推导（chatKey 或 chatKey#人格 → 人格@chatKey）；
  // 人格书已删的残留 doc 只有 scripts/memory.ts --delete 能查到。宿主日志只带
  // id 与所在 doc key，不打印记忆内容。
  async function deleteMemoryLocal(id: string): Promise<{ status: "ok"; doc: string } | { status: "missing" }> {
    const chats = await harness.snapshot(ChatsDoc, ctx);
    const privateKeys = new Set<string>();
    for (const mappingKey of Object.keys(chats?.chats ?? {})) {
      const mark = mappingKey.lastIndexOf("#");
      const persona = mark > 0 ? mappingKey.slice(mark + 1) : DEFAULT_PERSONA;
      const base = mark > 0 ? mappingKey.slice(0, mark) : mappingKey;
      privateKeys.add(`${persona}@${base}`);
    }
    const candidates: { token: typeof MemoryDoc | typeof MemoryPrivateDoc; key: string }[] = [
      ...personaKeys.map((persona) => ({ token: MemoryDoc as typeof MemoryDoc, key: persona })),
      ...[...privateKeys].map((key) => ({ token: MemoryPrivateDoc as typeof MemoryPrivateDoc, key })),
    ];
    for (const candidate of candidates) {
      const snapshot = await harness.snapshot(candidate.token, candidate.key, ctx);
      if (!snapshot || !hasFact(snapshot, id)) continue;
      const removed = await harness.commit(async (tx) => {
        const doc = await tx.doc(candidate.token, candidate.key, candidate.key);
        return deleteFactById(doc, id);
      }, ctx);
      if (removed) {
        console.log(`[鱼缸] 记忆删除 ${id} ${candidate.key}`);
        return { status: "ok", doc: candidate.key };
      }
      // 并发下刚好被删掉：继续找下一候选
    }
    return { status: "missing" };
  }

  return {
    harness,
    models,
    prompts,
    settings,
    personas: [DEFAULT_PERSONA, ...Object.keys(prompts.personas)],
    openers,
    toolNames: surface.tools.map((tool) => tool.name),
    async compact(conversation, force) {
      if (!compactor) return { compacted: false, reason: "below_threshold" };
      return compactor.maybeCompact(conversation, force);
    },
    async pendingMemories() {
      return pendingMemoriesLocal();
    },
    async approveMemory(id, track) {
      return approveMemoryLocal(id, track);
    },
    async rejectMemory(id) {
      return rejectMemoryLocal(id);
    },
    async memoryCommandReply(chatKey, command) {
      const messages = prompts.messages;
      // 群内 /记忆 一律只回引导语：无任何副作用（不预选、不过滤、不列部分内容）
      if (chatKey.startsWith("qq:group:")) return messages["cmd_memory_group"] ?? "";
      if (command.kind === "usage") return messages["cmd_memory_usage"] ?? "";
      if (command.kind === "approve") {
        const result = await approveMemoryLocal(command.id, command.track);
        if (result.status === "missing") return renderTemplate(messages["cmd_memory_missing"] ?? "", { id: command.id });
        if (result.status === "no_origin") return renderTemplate(messages["cmd_memory_no_origin"] ?? "", { id: command.id });
        return renderTemplate(messages["cmd_memory_ok"] ?? "", { track: result.track, digest: result.digest });
      }
      if (command.kind === "reject") {
        const removed = await rejectMemoryLocal(command.id);
        if (removed === 0) return renderTemplate(messages["cmd_memory_missing"] ?? "", { id: command.id });
        return command.all
          ? renderTemplate(messages["cmd_memory_rejected_all"] ?? "", { count: String(removed) })
          : renderTemplate(messages["cmd_memory_rejected"] ?? "", { id: command.id });
      }
      if (command.kind === "delete") {
        // 真删除：从公共层与全部私有层 doc 里按全局唯一 id 定位并移除；日志在 deleteMemoryLocal 里
        const result = await deleteMemoryLocal(command.id);
        if (result.status === "missing") return renderTemplate(messages["cmd_memory_delete_missing"] ?? "", { id: command.id });
        return renderTemplate(messages["cmd_memory_deleted"] ?? "", { id: command.id, doc: result.doc });
      }
      // 列表：全局单视图（所有人格），最旧在前——最先会被淘汰的排最前，头部给汇总行。
      // 含 supersede 的条目附「将失效」行：原文从该人格公共 doc 与各私有 doc 现查
      // （T11 起 known 是公共+当前私有的合并渲染，supersede id 可能指向私有层事实；
      // 查不到就只标 id）
      const views = await pendingMemoriesLocal();
      const entries = views
        .flatMap((view) => view.entries.map((entry) => ({ entry, persona: view.persona })))
        .sort((a, b) => a.entry.at - b.entry.at);
      // 零提取头部提示（T11）：全部注册人格里，连续零提取达阈值（常量 5）的在汇总头部
      // 各打一行——抽取器长期零产出时主人应该第一眼看到（哪怕当前没有待审条目）
      const zeroHints: string[] = [];
      for (const persona of personaKeys) {
        const snapshot = await harness.snapshot(MemoryDoc, persona, ctx);
        const streak = snapshot?.zeroStreak ?? 0;
        if (streak >= MEMORY_ZERO_EXTRACT_PAGES) {
          zeroHints.push(renderTemplate(messages["cmd_memory_zero_extract"] ?? "", { pages: String(streak), persona }));
        }
      }
      if (entries.length === 0) {
        return zeroHints.length > 0 ? [...zeroHints, messages["cmd_memory_empty"] ?? ""].join("\n") : messages["cmd_memory_empty"] ?? "";
      }
      const header = renderTemplate(messages["cmd_memory_list_header"] ?? "", {
        count: String(entries.length),
        age: formatAgeShort(now() - entries[0].entry.at),
      });
      // fact id → 原文：公共 doc + 该人格全部私有 doc（ChatsDoc 映射键推导 persona@chatKey）
      const factTexts = new Map<string, Map<string, string>>();
      const factTextOf = async (persona: string, id: string): Promise<string> => {
        let table = factTexts.get(persona);
        if (!table) {
          table = new Map(
            Object.values((await harness.snapshot(MemoryDoc, persona, ctx))?.people ?? {}).flatMap((person) =>
              person.facts.map((fact) => [fact.id, fact.text] as const),
            ),
          );
          for (const privKey of await privateKeysOf(persona)) {
            const priv = await harness.snapshot(MemoryPrivateDoc, privKey, ctx);
            for (const person of Object.values(priv?.people ?? {})) {
              for (const fact of person.facts) if (!table.has(fact.id)) table.set(fact.id, fact.text);
            }
          }
          factTexts.set(persona, table);
        }
        return table.get(id) ?? "";
      };
      const shown = entries.slice(0, 30);
      const lines: string[] = [];
      for (const { entry, persona } of shown) {
        lines.push(
          renderTemplate(messages["cmd_memory_entry"] ?? "", {
            id: entry.id,
            persona,
            origin: entry.originChatKey || "-",
            age: formatAgeShort(now() - entry.at),
            // 评价类待审（/评）展示关联摘要：哪条（targetSummary）+ 哪天；哪群在 origin 列里；
            // 引用链查不到的评价保留「被引消息不可回溯」标注（终验 #6，文案 key 化）；
            // 普通抽取条目附 signal 标签（T11：已知人物/事实冲突，机械重算的计数）
            digest: (entry.feedback
              ? summarizeFeedback(entry.feedback)
                + (entry.feedback.quotedFromMissing === true ? messages["memory_feedback_missing_quote"] ?? "" : "")
              : summarizePatch(entry.patch)) + signalsSuffix(entry.signals),
          }),
        );
        for (const note of entry.patch.supersede ?? []) {
          for (const id of note.ids) {
            const text = await factTextOf(persona, id);
            lines.push(renderTemplate(messages["cmd_memory_supersede_note"] ?? "", { id, text: text || "-" }));
          }
        }
      }
      const rest = entries.length - shown.length;
      return [
        header,
        ...zeroHints,
        ...lines,
        ...(rest > 0 ? [renderTemplate(messages["cmd_memory_more"] ?? "", { count: String(rest) })] : []),
      ].join("\n");
    },
    async enqueue(conversationId, payload) {
      await harness.commit(async (tx) => {
        const doc = await tx.doc(OutboxDoc, conversationId);
        doc.queue.push({ ...payload, status: "queued", attempts: 0 });
      }, ctx);
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
                      groupId: profile.groupId,
                      count: String(profile.count),
                      master: profile.master,
                      // 首次群档案 system prompt 只放群号/人数/QQ 号：群名、群主、昵称都是外部可变输入，
                      // 实时消息里已有 昵称(QQ) 背景行；master 是本地配置，可信
                      members: profile.members.map((m) => m.userId).join("\n") || "（拿不到名单）",
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
        })().then((conversation) => {
          // 创建与复用两条路径都在这里登记：key 是映射键（chatKey 或 chatKey#人格），
          // memoryKeyOf 提取人格名（无后缀 = 默认）——同一个人格的所有会话
          // （各群、私聊）都指向同一个公共 family member；原始 chatKey 另存一份，
          // 待审条目的来源会话与私有层 doc key（人格名@chatKey）都由它现算。
          // worker 会话（worker:*，如 index.ts 的 WORKER_CHAT_KEY）不登记 memory key：
          // 后台作业不是聊天，memory section 与 compactor 抽取都靠「无 key 双重 fail-closed」
          // 隔离——不注入共享记忆、不做抽取（compact.ts 无 key 分支）。chatKey 照常登记，
          // 用量记账与换页检查不受影响。
          if (!key.startsWith("worker:")) {
            memoryKeyByConversation.set(String(conversation.id), memoryKeyOf(key));
          }
          chatKeyByConversation.set(String(conversation.id), groupKey);
          return conversation;
        });
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
