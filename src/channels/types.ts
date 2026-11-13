/**
 * 通道适配器契约（docs/plans/2026-11-13-slave1-channel-adapter.md §4.2）。
 *
 * 一个通道（QQ / 钉钉 / …）= 一个 ChannelAdapter。宿主（src/app/runtime.ts）只认本契约：
 * 入站经 start → ChannelMessage → gate → present → render 进入模型；
 * 出站经 send / react 离开。QQ 专属的解析/渲染住在 src/channels/qq/，
 * 「QQ 群行为策略」（gate 窗口、debounce、engage 等）留在 src/qq/，由 QQ adapter 组合。
 *
 * 钉钉 adapter 协议待定（本文件只提供接入点，不实现）。
 */
import type { BurstMessage, ContextOptions, RecentChatMessage, RoundContext } from "../../qq/debounce.ts";
import type { GateDecision } from "../../qq/gate.ts";
import type {
  ForwardAttachment,
  MessageTable,
  ModelMessage,
  QuotedMessage,
} from "../../qq/model-input.ts";
import type {
  OpenMessage,
  RoundContentBlock,
} from "../../qq/round-input.ts";
import type { RoundImagePlan } from "../../qq/round-images.ts";

export type ChannelId = "qq" | "dingtalk";
export type ChatScope = "group" | "private";

/**
 * 归一后的入站消息。chatKey = `${ChannelId}:${ChatScope}:${id}`。
 * QQ 扩展字段（cards / forward / 合集水合结果等）挂在同名属性上，其他通道不填
 * （见 src/channels/qq/onebot.ts 的 IncomingMessage —— 它是本类型的别名 + 扩展）。
 */
export interface ChannelMessage {
  chatKey: string;
  channel: ChannelId;
  scope: ChatScope;
  /** QQ 号 / DingTalk staffId。 */
  userId: string;
  nickname: string;
  text: string;
  mentionsBot: boolean;
  messageId?: number | string;
  replyIds: string[];
  images: { ref: string }[];
  mentions?: { qq: string; name: string; kind: "bot" | "other" | "all" }[];
  quoted?: QuotedMessage;
}

/** 出站载荷：文字与媒体引用的具体形态由各 adapter 自定（QQ 是 OneBot segment）。 */
export interface OutboundPayload {
  text?: string;
  mediaRefs?: readonly string[];
  replyTo?: number | string;
  mentionUserIds?: readonly string[];
  [key: string]: unknown;
}

export interface SentMessageIds {
  messageIds: (number | string)[];
}

/**
 * 通道适配器。方法全部可选保底的只有 members / groupInfo / expandPendingForward；
 * start / stop / gate / present / render / send 是宿主接线的必备面。
 */
export interface ChannelAdapter {
  readonly id: ChannelId;
  owns(chatKey: string): boolean;
  start(onMessage: (msg: ChannelMessage) => void): Promise<void>;
  stop(): Promise<void>;
  selfId(): string;
  /** 记忆/画像的主体键：qq:123 / dingtalk:456。 */
  personSubject(userId: string): string;
  /** 入站准入：QQ 群窗/私聊主人；钉钉私聊白名单。 */
  gate(msg: ChannelMessage): GateDecision | Promise<GateDecision>;
  /** 入站文本归一（卡片渲染、bypass 剥离）；宿主仍负责 recent/chatlog 记账。 */
  present(msg: ChannelMessage): { text: string; bypass?: { clean: string; stash: string } };
  /** 模型输入渲染：运行时只经这里拿进入模型的字符串与 image blocks。 */
  render: ChannelRenderer;
  send(chatKey: string, payload: OutboundPayload): Promise<SentMessageIds | void>;
  react(chatKey: string, messageId: number | string, emoji: string): Promise<void>;
  members?(chatKey: string): Promise<{ nickname: string; userId: string }[]>;
  groupInfo?(chatKey: string): Promise<{ name?: string } | undefined>;
  expandPendingForward?(chatKey: string, anchor: ChannelMessage): Promise<ForwardAttachment | undefined>;
}

/**
 * 渲染面：签名与 src/channels/qq/ 下现有纯函数一一对应（T3 接线时由 adapter 组合）。
 * 参数细节沿用 QQ 实现的类型；gif 轮拼装已在 2026-11 退役（gifIngestRetired），不进契约。
 */
export interface ChannelRenderer {
  /** QQ：planRoundImages(anchor, burst, mediaRoot, inline, messages, …)。 */
  planImages(
    anchor: ChannelMessage,
    burst: readonly BurstMessage[],
    mediaRoot: string,
    inline: boolean,
    messages: MessageTable,
  ): RoundImagePlan;
  /** QQ：withContext(anchor, bucket, burst, options)。 */
  answer(
    anchor: ChannelMessage,
    bucket: readonly RecentChatMessage[],
    burst: readonly BurstMessage[],
    options: ContextOptions,
  ): RoundContext;
  /** QQ：renderOpenMessageList(items, messages, masterOf, watchedOf)。 */
  openList(
    items: readonly OpenMessage[],
    messages: MessageTable,
    masterOf: (userId: number) => boolean,
    watchedOf: (userId: number) => boolean,
  ): string;
  /** QQ：renderOpenQuotedText(items, messages, imageNumbers?, gifFrames?)。 */
  openQuoted(
    items: readonly OpenMessage[],
    messages: MessageTable,
    imageNumbers?: ReadonlyMap<string, number>,
    gifFrames?: ReadonlyMap<string, number>,
  ): string;
  browseOpportunity(messages: MessageTable): string;
  /** QQ：assembleRoundContent(base, options, messages)。 */
  assemble(
    base: string,
    options: { recentForward?: ForwardAttachment; tags?: readonly string[]; lookHint?: boolean },
    messages: MessageTable,
  ): string;
  /** QQ：submitContentOf(content, imageBlocks)。 */
  submitContent(content: string, blocks: readonly { type: "image"; data: string; mimeType: string }[]): string | RoundContentBlock[];
  appendVoiceHint(content: string, hint: string): string;
  appendAnswerRules(content: string, rules: readonly string[]): string;
}
