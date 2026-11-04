/** 可导入的轮级输入拼装入口：index.ts 与权威模板机械测试共用，无副作用。 */
import type { IncomingMessage } from "./onebot.ts";
import { renderTemplate } from "../prompts.ts";
import { renderForwardAttachment, renderMessageList, type ForwardAttachment, type MessageTable, type ModelMessage } from "./model-input.ts";

export interface OpenMessage {
  messageId?: number | string;
  userId: number;
  nickname: string;
  text: string;
}

/** 背景记账只留合集短标记，展开内容不进入背景。 */
export function backgroundTextOf(msg: IncomingMessage, messages: MessageTable): string {
  const marker = messages["forward_collapsed"] ?? "";
  if ((msg.forward !== undefined || (msg.forwardIds?.length ?? 0) > 0) && marker.length > 0) return marker;
  if (!/\[转发合集 \d+ 条\]/.test(msg.text)) return msg.text;
  return marker.length > 0 ? marker : "[收集]";
}

/** injection 与 shard 共用同一标准群消息列表；调用方保证 items 已是真实接收顺序。 */
export function renderOpenMessageList(
  items: readonly OpenMessage[],
  messages: MessageTable,
  masterOf: (userId: number) => boolean,
  watchedOf: (userId: number) => boolean,
): string {
  const models: ModelMessage[] = items.map((item) => ({
    ...(item.messageId !== undefined ? { messageId: item.messageId } : {}),
    userId: String(item.userId),
    nickname: item.nickname,
    text: item.text,
    mentionsBot: false,
    replyIds: [],
    master: masterOf(item.userId),
    watched: watchedOf(item.userId),
  }));
  return renderMessageList(models, messages, "group");
}

/** 零新增主动交流机会固定模板。 */
export function renderBrowseOpportunity(messages: MessageTable): string {
  return [
    messages["ctx_browse_active_header"] ?? "",
    messages["ctx_browse_active_line"] ?? "",
    "",
    messages["ctx_browse_actions_header"] ?? "",
    messages["ctx_browse_actions_line"] ?? "",
  ].join("\n");
}

/** GIF 静默收图：标准消息列表 + 绑定真实消息 ID 的任务段。 */
export function renderGifIngestInput(history: readonly ModelMessage[], target: ModelMessage, messages: MessageTable): string {
  const task = renderTemplate(messages["gif_ingest_task"] ?? "", { id: String(target.messageId ?? "") });
  const suffix = [messages["gif_ingest_header"] ?? "", task, messages["gif_ingest_outcome"] ?? ""]
    .filter((line) => line.length > 0)
    .join("\n");
  return `${renderMessageList([...history, target], messages, "group")}\n\n${suffix}`;
}

/** answer 列表后的附加段统一顺序：最近合集 → 压缩图标签 → look 提示。 */
export function assembleRoundContent(
  base: string,
  options: {
    recentForward?: ForwardAttachment;
    tags?: readonly string[];
    lookHint?: boolean;
  },
  messages: MessageTable,
): string {
  const sections = [base];
  if (options.recentForward) sections.push(renderForwardAttachment(options.recentForward, messages));
  if ((options.tags?.length ?? 0) > 0) sections.push((options.tags ?? []).join("\n"));
  if (options.lookHint) sections.push(messages["image_look_hint"] ?? "");
  return sections.filter((section) => section.length > 0).join("\n\n");
}

export interface RoundContentBlock { type: "text" | "image"; text?: string; data?: string; mimeType?: string }

/** submitRound 的唯一 content 形状：一个 text block 在前，压缩 image blocks 在后。 */
export function submitContentOf(content: string, imageBlocks: readonly { type: "image"; data: string; mimeType: string }[]): string | RoundContentBlock[] {
  return imageBlocks.length > 0 ? [{ type: "text", text: content }, ...imageBlocks] : content;
}

/** 附加段之间统一空一行（语音提示、answer 轮规范段共用这条拼装）。 */
export function appendVoiceHint(content: string, hint: string): string {
  return hint.length > 0 ? `${content}\n\n${hint}` : content;
}

/**
 * answer 轮的规范段（目前是 `video_answer_rule`：没被要求看视频就别看）。
 *
 * 放在这里而不是 `src/index.ts`：宿主与权威模板测试必须走同一段拼装，否则测试会
 * 在「多一段 / 少一段」时仍然全绿（2026-11-05 就是这么发现的）。顺序按数组顺序
 * 依次追加，每段之间空一行。
 */
export function appendAnswerRules(content: string, rules: readonly string[]): string {
  let out = content;
  for (const rule of rules) out = appendVoiceHint(out, rule);
  return out;
}
