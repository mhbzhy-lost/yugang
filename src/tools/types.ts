/**
 * 工具包共享类型：TOOL.md manifest、动态词表上下文与工具包工厂合同。
 *
 * TOOL.md 的解析实现在 ./manifest.ts；T3–T5 的工具包 factory 与 T6 的 loader 都从这里取类型。
 * 合同要点：一个工具包 = src/tools/<name>/ 下的 TOOL.md + tool.ts；factory 只消费 manifest 的
 * Schema，不得再写第二份运行时参数定义；依赖不齐（无主人、无出口限额）时 factory 返回 undefined，
 * 由 loader 跳过，不进入 agent.tools / deferred / tool_catalog。
 */
import type { Models } from "@earendil-works/pi-ai";
import type { ConversationId, ToolRegistration } from "@earendil-works/pi-durable";
import type { PromptSet } from "../prompts.ts";

/** TOOL.md Schema 里受控的动态枚举扩展键；x-yugang-* 是保留命名空间，其它键一律拒绝。 */
export const ENUM_FROM_KEY = "x-yugang-enum-from";

/** 目前唯一受控的动态词表键：prompt/meme-tags.md 的一级情绪词。 */
export type EnumFromContextKey = "memeTags";

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
  /** 第二块之后的正文使用指南（非空），注册时拼进 description。 */
  readonly guide: string;
  /** ---tool-schema 块解析出的 parameters；动态 enum 已由 loader 按 context 解析。 */
  readonly parameters: ToolParametersSchema;
  /** TOOL.md 的路径；诊断与审查用。 */
  readonly path: string;
}

/** 所有工具包共享的运行时依赖：现有 ToolDeps 与出口 say/react 依赖的并集，字段语义不变。 */
export interface ToolPackageDeps {
  /** prompt 集合：共享 messages、memeTags 是唯一文案来源。 */
  prompts: PromptSet;
  /** 媒体根目录：look / draw / meme 系工具的路径围栏。 */
  mediaRoot: string;
  /** 出口限额；say 必需，缺省时出口 factory 返回 undefined。 */
  limits?: import("../egress/policy.ts").EgressLimits;
  now?: () => number;
  /** 模型池：look / video 用独立请求把图描述成文字，图片不进主会话。 */
  models?: Models;
  /** 视觉描述模型；省略时与 main 相同。 */
  visionModel?: { provider: string; modelId: string };
  /** DeepSeek Search API 的 key；有才具备联网搜索能力。 */
  searchKey?: string;
  /** 主人 QQ：主人专属工具的身份闸；缺省则这些 factory 返回 undefined。 */
  master?: string;
  /** config/models.json 路径；model 工具写回时用。 */
  modelsPath?: string;
  /** 会话 → 群成员名单；watch 用它校验被关注人真的在群里。 */
  groupMembersOf?: (conversationId: string) => Promise<{ nickname: string; userId: string }[]>;
  /** watch 名单变更回调。 */
  onWatchChanged?: (conversationId: string, people: import("../store.ts").WatchedPerson[]) => void;
  /** ChatGPT/Codex 图片通道（models.image）；authPath 决定用哪份登录凭据，proxy 只给这条通道。 */
  gptImage?: { authPath: string; provider: string; model: string; proxy?: string };
  /** SD WebUI 的 baseUrl；给了才有本地画图。 */
  sdUrl?: string;
  /** danbooru.csv 路径；给了才能查 tag 词表。 */
  tagsCsv?: string;
  /** submissionId → 本轮触发消息；say 的引用绑定与各工具身份闸同源。 */
  triggerOf?: (roundId: unknown) => { messageId?: number | string; mentionsBot: boolean; userId?: number } | undefined;
  /** submissionId → 本轮触发消息自带的 bypass 段；仅 draw 消费。 */
  bypassOf?: (roundId: unknown) => string | undefined;
  /** 贴表情实现；react 必需，缺省时 factory 返回 undefined。 */
  react?: (conversationId: ConversationId, emoji: string, messageId?: number | string) => void | Promise<void>;
  /** say 主动 @ 用的群成员名单（宿主从当前群现拉）；与 watch 的 groupMembersOf 同源，字段名保持原样。 */
  membersOf?: (conversationId: string) => Promise<{ nickname: string; userId: string }[]>;
  /** 主动 @ 的身份闸；未提供回调时 fail closed。 */
  mentionPolicyOf?: (conversationId: string, triggerUserId: number | undefined) => "allow" | "not_group" | "not_privileged";
  /** 语音合成配置（按会话现取：一个会话一个人格，音色跟着人格走）。 */
  ttsOf?: (conversationId: string) => import("../tts.ts").TtsConfig | undefined;
  /** 语音合成实现；测试可注入桩，线上用 synthesizeToMedia。 */
  ttsSynthesize?: (config: import("../tts.ts").TtsConfig, text: string, mediaRoot: string) => Promise<{ ref: string; bytes: Buffer }>;
  /** 静默轮（如收图轮）：这一轮不许说话。 */
  silentOf?: (roundId: unknown) => boolean;
  /** 表情包跨轮冷却（毫秒）；给函数是每次现取。 */
  memeCooldownMs?: number | (() => number);
}

/** 工具包工厂：manifest + 依赖 → 注册对象；依赖不齐时返回 undefined，由 loader 跳过。 */
export type ToolPackageFactory = (
  manifest: ToolManifest,
  deps: ToolPackageDeps,
) => ToolRegistration | undefined | Promise<ToolRegistration | undefined>;
