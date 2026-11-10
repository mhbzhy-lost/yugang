/**
 * 鱼的公共类型（2026-11-05 从 harness.ts 拆出）。
 *
 * `harness.ts` 继续 re-export 这些名字，外部 importer 不用改。
 */
import type { Models } from "@earendil-works/pi-ai/models";
import type {
  AnyTask,
  Conversation,
  ConversationId,
  Extension,
  Harness,
  Storage,
} from "@earendil-works/pi-durable";
import type { EgressLimits } from "../egress/policy.ts";
import type { EngagementMode } from "../fish-config.ts";
import type { PromptSet } from "../prompt/index.ts";
import type { OutboundPayload } from "../tools/say-shared.ts";
import type { RoundKind, RoundTrigger, ToolPackageDeps } from "../tools/types.ts";
import type { CompactResult } from "../compact.ts";
import type { MemoryApprovalPreparation, MemoryCommand, PendingMemoryEntry } from "../memory/index.ts";
import type { WatchedPerson } from "../store.ts";
import type { TtsConfig } from "../tts.ts";

/** emit 的返回值：实际发出的 QQ 消息 id 列表（群文本/图片逐条；void = 无可记录 id，如私聊发送）。 */
export type SentMessageIds = (number | string)[];

/** 人格名的「默认」哨兵：默认人格的会话键不带后缀，也不另外选扩展。 */
export const DEFAULT_PERSONA = "默认";

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
  gptImage?: {
    authPath: string;
    provider: string;
    model: string;
    proxy?: string;
    /** 官方 API key（config/auth.json 的 openai.key 或 OPENAI_API_KEY）：只给动图通道用。 */
    apiKey?: string;
    /** 官方 API 根地址覆盖（测试/代理用）。 */
    apiBaseUrl?: string;
  };
  /** config/models.json 路径；config 工具写回 models 角色表时用。 */
  modelsPath?: string;
  /** ComfyUI 环回隧道地址；给了才有本地画图。 */
  comfyUrl?: string;
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
   * fish.reminder 任务定义（宿主用 makeReminderTask 造好传入）：同一个对象进
   * registry（Harness 能跑）与 remind 工具的 deps（add 时建任务）。缺省 = 无定时任务能力。
   */
  reminderTask?: AnyTask;
  /**
   * 主模型直读图（vision==main 且通道在白名单且未 /关看图）的宿主事实，每轮现算。
   * 为 true 时 inline 附图生效、look 机械锁死；缺省 = 恒按 fallback（look 转述）。
   */
  inlineVisionOn?: () => boolean;
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
  onWatchChanged?: (conversationId: string, people: WatchedPerson[]) => void;
  /** 表情包跨轮冷却（毫秒）；传函数则每次现取，改配置立即生效。 */
  memeCooldownMs?: number | (() => number);
  /** GIF 自动收图豁免开关（fish.config.json 的 gifAutoCollect，热加载）；传函数每次现取。 */
  gifAutoCollect?: () => boolean;
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
  ttsOf?: (conversationId: string) => TtsConfig | undefined;
  /** 搭话模式现取（热）：runtime 的「自由活动群」小节仅 free（GROUPS 群）注入；缺省 = legacy（裁掉）。 */
  engagementOf?: (chatKey: string) => EngagementMode;
  /** 新闻备料工具的生产适配；缺省不注册 news_prepare。 */
  newsPrepare?: ToolPackageDeps["newsPrepare"];
  /** 静默轮（自动收表情包）：这一轮 say_* 一律拒绝。 */
  silentOf?: (roundId: unknown) => boolean;
  /** 本轮 say_* 的 execute 被进入时回调；宿主按 submission 计数，识别零出口轮。 */
  onSayCall?: (roundId: unknown) => void;
  /** 重耗时工具 execute 入口的宿主回调：本轮第一次调用时发「正在执行」机械提示；restart 会 await 返回的 Promise。 */
  onLongWork?: (tool: string, submissionId: unknown) => void | Promise<void>;
  /** draw 阶段进度机械提示（不过模型）：sketch=初采样、refine=脸修；宿主经 outbox 立即发出。 */
  onDrawStage?: (roundId: unknown, stage: "sketch" | "refine") => void;
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
    maxTokens?: number;
    /** 现取的 token 阈值（热更新用）：改配置后下一轮压缩就按新值判断。 */
    limits?: () => { maxTokens: number };
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
  /** 同意父条目或一个子项：公共必须携带内存公共化准备；私有并入来源会话。 */
  approveMemory(id: string, track: "公共" | "私有", preparation?: MemoryApprovalPreparation): Promise<
    { status: "ok"; track: "公共" | "私有"; persona: string; originChatKey: string; digest: string; remaining: number }
      | { status: "missing" | "no_origin" | "changed" | "expire_mismatch" | "supersede_mismatch" | "publicize_required" }
  >;
  /** 拒绝待审：单条 id 或 "all"（全部人格的全部待审）；返回删掉的条数。 */
  rejectMemory(id: string | "all"): Promise<number>;
  /** /记忆 指令的机械回复（闸前通道，不进模型）：群内只回引导语，私聊里执行列表/同意/拒绝/删除。 */
  memoryCommandReply(chatKey: string, command: MemoryCommand, preparation?: MemoryApprovalPreparation): Promise<string>;
  /** 取（或创建）某个群在指定人格下的会话；映射持久化，重启后还是同一个会话。未注册人格回退默认。 */
  group(groupKey: string, profile?: GroupProfile, persona?: string): Promise<Conversation>;
  /** 把 outbox 里排队的消息发出去；返回实际发了几条。队首卡在 sending 的会话会被跳过（不重发）。 */
  drain(extra?: readonly ConversationId[]): Promise<number>;
  /** 不经模型直接往 outbox 里排队一条（宿主侧机械回复专用，同样走唯一出口）。 */
  enqueue(conversationId: ConversationId, payload: OutboundPayload): Promise<void>;
  close(): Promise<void>;
}
