/**
 * 工具包共享类型：TOOL.md manifest、动态词表上下文与工具包工厂合同。
 *
 * TOOL.md 的解析实现在 ./manifest.ts；T3–T5 的工具包 factory 与 T6 的 loader 都从这里取类型。
 * 合同要点：一个工具包 = src/tools/<name>/ 下的 TOOL.md + tool.ts；factory 只消费 manifest 的
 * Schema，不得再写第二份运行时参数定义；依赖不齐（无主人、无出口限额）时 factory 返回 undefined，
 * 由 loader 跳过，不进入 agent.tools / deferred / tool_catalog。
 */
import type { Models } from "@earendil-works/pi-ai";
import type { AnyTask, ConversationId, ToolRegistration } from "@earendil-works/pi-durable";
import type { PromptSet } from "../prompt/index.ts";

/** TOOL.md Schema 里受控的动态枚举扩展键；x-yugang-* 是保留命名空间，其它键一律拒绝。 */
export const ENUM_FROM_KEY = "x-yugang-enum-from";

/** 目前唯一受控的动态词表键：prompt/meme-tags.md 的一级情绪词。 */
export type EnumFromContextKey = "memeTags";

/**
 * 轮类型（搭话 next，决策 7 + 外部计划 E4）：answer = 既有必答 / 私聊 / legacy 轮
 * （语义不变）；ambient = open 窗的 shard 轮（free_pass 消息每拍合并提交，非必答）；
 * injection = 开窗瞬间的积压注入轮（背景板语义）；worker = 后台作业轮（弹药逛轮，
 * 独立 worker 会话，say_* 机械拒绝，模型只经 ammo_submit 提交结构化候选）。
 * legacy 轮全部 answer。
 */
export type RoundKind = "ambient" | "injection" | "answer" | "worker" | "news";

/**
 * triggerOf 的值：本轮触发消息 + 轮类型 + quoteMsgId 窗口。
 * shard / injection 轮没有锚点消息（无 messageId），quoteIds = 本轮注入窗口的消息 id
 * （[m:…] 锚点），是 T4 quoteMsgId 的合法目标集合；随轮 settle 一并清除。
 */
export interface RoundTrigger {
  messageId?: number | string;
  mentionsBot: boolean;
  userId?: number;
  /** 缺省 = answer（legacy 轮全部 answer）。 */
  kind?: RoundKind;
  /** 本轮注入窗口的消息 id 集合（[m:…] 锚点里的数字）；T4 消费。 */
  quoteIds?: ReadonlySet<string>;
  /**
   * worker 轮（弹药逛轮，外部计划 E4）的作业上下文：runKey = 作业幂等键（date + slot，
   * jobKeyOf），maxPicks = 本轮入库上限（ammo.maxPicksPerRun，作业起时定格），
   * ttlHours = 弹药存活时长（ammo.ttlHours）。ammo_submit 只在携带它的轮里可用。
   */
  workerRun?: { runKey: string; maxPicks: number; ttlHours: number };
  /**
   * 主人私聊手动逛轮的窄口上下文（与 workerRun 同形，已停用、兼容保留）：只在主人私聊的普通 answer 轮由
   * 宿主钉上（身份与 chatKey 双重机械核对 config.master）；runKey = 该条私聊 messageId
   * 稳定派生（缺失时宿主时间戳，同一条消息的轮内重试共用一键 → 上限按消息计），
   * maxPicks/ttlHours 每轮从 ammo 配置现读。ammo_submit 放行前还会二次机械核对当前
   * 会话确为主人私聊（chatKeyOf + master）；群聊、陌生私聊、无此上下文的轮一律 fail closed。
   * 【2026-11-04 模型输入计划 T3】宿主已不再钉这个字段（manual ammo 接线已摘除）。
   */
  manualAmmoRun?: { runKey: string; maxPicks: number; ttlHours: number };
  /**
   * 视频浏览授权（2026-11-04 模型输入计划 T3）：只在 open 空窗的零新增主动轮
   * （「主动交流机会」模板）由宿主钉上——browseWindow = 本窗稳定 windowId（engage-next
   * 派生，同窗恒定、关窗作废），browseTopic = 本窗随机选定的 topic（VIDEO_TOPICS 枚举）。
   * ambient shard、injection 有消息轮、answer 轮与私聊轮一律不携带 = 无浏览授权；
   * T4 的 bili_hot（按 topic 取候选）/ video（登记实际观看）/ say_words（链接白名单）
   * 只认这两个字段，不得按群 open 相位自行推断授权。
   */
  browseWindow?: string;
  browseTopic?: string;
  /** 新闻备料轮：run key 与本次尝试序号，工具只认这一组宿主绑定。 */
  newsRunId?: string;
  newsAttempt?: number;
}

/** loadToolManifests 的动态上下文；词表为空时对应属性退化为普通字符串（与现行为一致）。 */
export interface ManifestLoadContext {
  readonly memeTags: readonly string[];
}

/** 严格 JSON 解析并通过校验的工具参数 Schema（对象参数）。 */
export interface ToolParametersSchema {
  readonly type: "object";
  readonly properties?: Readonly<Record<string, unknown>>;
  readonly required?: readonly string[];
  readonly additionalProperties?: boolean | Readonly<Record<string, unknown>>;
  readonly [key: string]: unknown;
}

/** 一份解析完成的 TOOL.md；name = 目录名 = 注册名。 */
export interface ToolManifest {
  readonly name: string;
  /** 顶部 frontmatter 摘要；注册用完整 description 由 toolFullDescription() 拼出。 */
  readonly description: string;
  /** 元数据块之后的正文使用指南（非空），注册时拼进 description。 */
  readonly guide: string;
  /** ---tool-schema 块解析出的 parameters；动态 enum 已由 loader 按 context 解析。 */
  readonly parameters: ToolParametersSchema;
  /** ---tool-messages 块解析出的工具专属回执文案（可含 {{var}}）；无块时为空表。 */
  readonly messages: Readonly<Record<string, string>>;
  /** TOOL.md 的路径；诊断与审查用。 */
  readonly path: string;
}

/** 所有工具包共享的运行时依赖：现有 ToolDeps 与出口 say_* 和 react 依赖的并集，字段语义不变。 */
export interface ToolPackageDeps {
  /** prompt 集合：共享 messages、memeTags 是唯一文案来源。 */
  prompts: PromptSet;
  /** 媒体根目录：look / draw / meme 系工具的路径围栏。 */
  mediaRoot: string;
  /** 出口限额；say_* 必需，缺省时出口 factory 返回 undefined。 */
  limits?: import("../egress/policy.ts").EgressLimits;
  now?: () => number;
  /** 模型池：look / video 用独立请求把图描述成文字，图片不进主会话。 */
  models?: Models;
  /** 视觉描述模型；省略时与 main 相同。 */
  visionModel?: { provider: string; modelId: string };
  /** 视觉描述的兜底模型；省略 = 无兜底（describeImage 行为不变）。 */
  visionFallbackModel?: { provider: string; modelId: string };
  /** DeepSeek Search API 的 key；有才具备联网搜索能力。 */
  searchKey?: string;
  /** 主人 QQ：主人专属工具的身份闸；缺省则这些 factory 返回 undefined。 */
  master?: string;
  /** config/models.json 路径；config 工具写回 models 角色表时用。 */
  modelsPath?: string;
  /** conversationId → 原始 chatKey（不带人格后缀）；config 工具用它判定「会话为主人私聊」，缺省时 fail closed。 */
  chatKeyOf?: (conversationId: string) => string | undefined;
  /** 会话 → 群成员名单；watch 用它校验被关注人真的在群里。 */
  groupMembersOf?: (conversationId: string) => Promise<{ nickname: string; userId: string }[]>;
  /** watch 名单变更回调。 */
  onWatchChanged?: (conversationId: string, people: import("../store.ts").WatchedPerson[]) => void;
  /** ChatGPT/Codex 图片通道（models.image）；authPath 决定用哪份登录凭据，proxy 只给这条通道。 */
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
  /** ComfyUI 环回隧道地址；给了才有本地画图。 */
  comfyUrl?: string;
  /** danbooru.csv 路径；给了才能查 tag 词表。 */
  tagsCsv?: string;
  /** submissionId → 本轮触发消息（轮类型 + quoteIds 窗口）；出口工具的引用绑定与各工具身份闸同源。 */
  triggerOf?: (roundId: unknown) => RoundTrigger | undefined;
  /** submissionId → 本轮触发消息自带的 bypass 段；仅 draw 消费。 */
  bypassOf?: (roundId: unknown) => { bypass?: string; pbypass?: string } | undefined;
  /** 贴表情实现；react 必需，缺省时 factory 返回 undefined。 */
  react?: (conversationId: ConversationId, emoji: string, messageId?: number | string) => void | Promise<void>;
  /** 出口工具主动 @ 用的群成员名单（宿主从当前群现拉）；与 watch 的 groupMembersOf 同源，字段名保持原样。 */
  membersOf?: (conversationId: string) => Promise<{ nickname: string; userId: string }[]>;
  /**
   * 主动 @ 的身份闸（按轮类型，决策 7）；未提供回调时 fail closed。
   * answer/legacy 轮 userId 是本轮触发者（被点名才可 @，语义不变）；ambient/injection
   * 环境轮没有锚点身份，出口层对每个 @ 目标各调一次、userId 携带目标 QQ，白名单同为
   * {主人} ∪ 本群 watched（成员名单校验在出口层照旧）。宿主对环境轮的放行/越界拒绝记审计。
   */
  mentionPolicyOf?: (conversationId: string, userId: number | undefined, kind: RoundKind) => "allow" | "not_group" | "not_privileged";
  /** 语音合成配置（按会话现取：一个会话一个人格，音色跟着人格走）。 */
  ttsOf?: (conversationId: string) => import("../tts.ts").TtsConfig | undefined;
  /** 语音合成实现；测试可注入桩，线上用 synthesizeToMedia。 */
  ttsSynthesize?: (config: import("../tts.ts").TtsConfig, text: string, mediaRoot: string) => Promise<{ ref: string; bytes: Buffer }>;
  /** 新闻备料窄接口：宿主核验 run/attempt/会话、候选与截止，并原子保存成品。 */
  newsPrepare?: (input: {
    runId: string;
    attempt: number;
    conversationId: string;
    digest: import("../external/news-broadcast.ts").NewsDigest;
  }) => Promise<{ status: "prepared" | "rejected"; reason?: string }>;
  /** 静默轮（如收图轮）：这一轮不许说话。 */
  silentOf?: (roundId: unknown) => boolean;
  /** 本轮出口工具的 execute 被进入时回调（成败都算一次）；宿主据此识别「零出口轮」。 */
  onSayCall?: (roundId: unknown) => void;
  /**
   * 重耗时工具（video/draw/gpt_image/meme_import/meme_add/restart）execute 入口的宿主回调：
   * 传本轮轮标识（LiveDoc 的 run.inputs[0]，拿不到就不调），宿主按「submissionId × 工具名」
   * 去重后经 outbox 发「正在执行」机械提示（文案 prompt/messages.md 的 working_*）。
   * restart 会 await 返回的 Promise，保证提示在进程退出前先入队并冲一次 outbox。
   */
  onLongWork?: (tool: string, submissionId: unknown) => void | Promise<void>;
  /** draw 阶段进度机械提示（不过模型）：初采样完成进入超分链（sketch）一个节点回调，
   *  宿主经 outbox 发拟人文案（prompt/messages.md 的 draw_stage_*），幂等键 stage:draw:<round>:<stage>；
   *  缺省时不发（ws 不可用/测试环境），不影响出图。 */
  onDrawStage?: (roundId: unknown, stage: "sketch") => void;
  /** 表情包跨轮冷却（毫秒）；给函数是每次现取。 */
  memeCooldownMs?: number | (() => number);

  /** GIF 自动收图豁免开关（fish.config.json 的 gifAutoCollect，热加载）：true 才允许 meme_add 在非主人轮收 inbound/ 动图。 */
  gifAutoCollect?: () => boolean;
  /** 本地画图总开关（fish.config.json 的 drawEnabled，热加载，资源闸）：false 时 draw 入口即拒、提交前再复核；缺省视为开。 */
  drawEnabled?: () => boolean;
  /** fish.reminder 任务定义（宿主装配时注入）：remind 工具 add 时建任务用；缺省不注册该工具。 */
  reminderTask?: AnyTask;
  /** 主模型直读图的宿主事实（vision==main 且白名单且未 /关看图）：look 与 meme_import 消费；缺省 = fallback。 */
  inlineVisionOn?: () => boolean;
}

/** 工具包工厂：manifest + 依赖 → 注册对象；依赖不齐时返回 undefined，由 loader 跳过。 */
export type ToolPackageFactory = (
  manifest: ToolManifest,
  deps: ToolPackageDeps,
) => ToolRegistration | undefined | Promise<ToolRegistration | undefined>;
