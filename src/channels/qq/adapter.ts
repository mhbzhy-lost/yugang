/**
 * QQ 通道适配器（2026-11-13 通道适配器 T3）：把既有单例 OneBot 与规则闸包装成
 * ChannelAdapter 契约面。QQ 行为逐字不变——发送/收线仍走同一个 OneBot 实例，
 * 出入站的具体策略（群窗、debounce、engage 等）在 src/qq/，由宿主按
 * channels.has("qq") 守卫调用。
 */
import type {
  ChannelAdapter,
  ChannelMessage,
  ChannelRenderer,
} from "../types.ts";
import type { Gate, GateDecision } from "../../qq/gate.ts";
import type { MessageTable } from "../render.ts";
import { withContext } from "./round-input.ts";
import { planRoundImages } from "./round-images.ts";
import {
  appendAnswerRules,
  appendVoiceHint,
  assembleRoundContent,
  renderBrowseOpportunity,
  renderOpenMessageList,
  renderOpenQuotedText,
  submitContentOf,
  type OpenMessage,
} from "./round-input.ts";
import { presentQQ } from "./normalize.ts";
import type { OneBot } from "./onebot.ts";

export interface QqAdapterOptions {
  onebot: OneBot;
  gate: Gate;
}

/** 渲染面：QQ 实现就是 round-input / round-images 的现有纯函数（行为逐字不变）。 */
export const qqRenderer: ChannelRenderer = {
  planImages: (anchor, burst, mediaRoot, inline, messages) =>
    planRoundImages(anchor, burst, mediaRoot, inline, messages),
  answer: (anchor, bucket, burst, options) => withContext(anchor, bucket, burst, options),
  openList: (items, messages, masterOf, watchedOf) =>
    renderOpenMessageList(items, messages, masterOf, watchedOf),
  openQuoted: (items, messages, imageNumbers, gifFrames) =>
    renderOpenQuotedText(items, messages, imageNumbers, gifFrames),
  browseOpportunity: (messages) => renderBrowseOpportunity(messages),
  assemble: (base, options, messages) => assembleRoundContent(base, options, messages),
  submitContent: (content, blocks) => submitContentOf(content, blocks),
  appendVoiceHint: (content, hint) => appendVoiceHint(content, hint),
  appendAnswerRules: (content, rules) => appendAnswerRules(content, rules),
};

/** QQ：chatKey 前缀 qq: 且 OneBot 在线。 */
export function createQqAdapter(options: QqAdapterOptions): ChannelAdapter {
  const { onebot, gate } = options;
  return {
    id: "qq",
    owns: (chatKey) => chatKey.startsWith("qq:"),
    async start() {
      await onebot.connect();
    },
    async stop() {
      onebot.close();
    },
    selfId: () => (onebot.selfId > 0 ? String(onebot.selfId) : ""),
    personSubject: (userId) => `qq:${userId}`,
    gate: (msg) => gate.decide({ msg }) as GateDecision | Promise<GateDecision>,
    present: (msg, presentOptions) =>
      presentQQ(msg, {
        messages: presentOptions.messages as MessageTable,
        bypassAllowed: presentOptions.bypassAllowed,
      }),
    render: qqRenderer,
    async send() {
      // QQ 出站路径仍由宿主 emit 直驱 OneBot（配速/末条自言/幂等都在那一层），此处留作
      // 契约占位：钉钉接入后新通道实现自己的 send，QQ 不双写。
      return undefined;
    },
    async react(chatKey, messageId, emoji) {
      void chatKey;
      await onebot.react(messageId, emoji);
    },
    async members(chatKey) {
      const groupId = Number(chatKey.split(":")[2]);
      return onebot.groupMembers(groupId, 10_000);
    },
    async groupInfo(chatKey) {
      const groupId = Number(chatKey.split(":")[2]);
      return onebot.groupInfo(groupId);
    },
  };
}

export type { ChannelMessage };
