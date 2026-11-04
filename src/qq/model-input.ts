/**
 * 共享消息模板（docs/decisions/2026-11-04-model-input-templates.md §2–§5）：
 * 消息行、列表边界、引用原文与合集附件的纯渲染函数。
 *
 * 消息行统一为 `[m:id][可选标签] 昵称(QQ): 正文`——`: ` 后永远是当前消息正文，
 * 其它信息全部放在 `: ` 前的标签里；标签顺序固定 m → 回复 → 转发合集 → @ →
 * 主人/特别关注。标签只陈述事实，语义与应对规则统一写在 system prompt。
 *
 * 引用原文与合集附件是消息列表后的附加段，不参与时间线排序；顺序由装配方保证
 * （先引用原文、再合集附件，最近合集补展开最后）。文案唯一来源是 prompt/messages.md
 * 的模板 key；这里的 ?? 兜底只服务于拿不到文案表的调用（值与 messages.md 一致）。
 */
import { renderTemplate } from "../prompts.ts";

export const MESSAGE_LIST_START = "> 消息起始";
export const MESSAGE_LIST_END = "> 消息结束";

export type MessageTable = Readonly<Record<string, string>>;

/** 一轮 user 输入的组成件（T2 接线用）：一个 text block 与按编号在后的压缩 image blocks。 */
export interface MessageBlockParts {
  text: string;
  images: readonly string[];
}

/** 合集里的一条子消息：只有 API 真实返回了 ID / QQ 才有对应字段，缺失不伪造。 */
export interface ForwardChildMessage {
  position: number;
  messageId?: number | string;
  userId?: string;
  nickname: string;
  text: string;
  images: readonly string[];
}

/** 消息列表后的合集附加段：sourceMessageId 缺失（最近合集补展开）时不渲染 [来自m:id]。 */
export interface ForwardAttachment {
  id: string;
  sourceMessageId?: number | string;
  total: number;
  children: readonly ForwardChildMessage[];
  truncated: boolean;
}

/** 直接回复水合出的引用原文；forward 在场时被引的是合集父消息（不重复展开）。 */
export interface QuotedMessage {
  id: string;
  nickname: string;
  userId: string;
  text: string;
  images: readonly string[];
  forward?: ForwardAttachment;
}

export interface ModelMessage {
  messageId?: number | string;
  userId: string;
  nickname: string;
  text: string;
  mentionsBot: boolean;
  replyIds: readonly string[];
  master: boolean;
  watched: boolean;
  quoted?: QuotedMessage;
  forward?: ForwardAttachment;
}

/** 一行正文：空白折叠成单空格（decisions §2：每条消息占一行）。 */
function lineText(text: string): string {
  return text.replace(/\s+/g, " ").trim();
}

/** `[m:id]` 锚点：没有真实 id 就不渲染，不伪造。 */
function idTag(id: number | string | undefined): string {
  return id === undefined || String(id).length === 0 ? "" : `[m:${id}]`;
}

/** 「昵称(QQ)」；缺一边就只写另一边，都缺返回空。 */
function person(nickname: string, userId: string): string {
  const name = nickname.trim();
  const qq = userId.trim();
  if (name && qq) return `${name}(${qq})`;
  return name || qq;
}

/**
 * 单条消息行：`[m:id][回复了m:rid][转发合集][这条消息@了你][主人/特别关注] 昵称(QQ): 正文`。
 * 父消息没有附带文字时用 [转发合集] 内容占位；引用原文不在行内渲染（装配方后置）。
 */
export function renderMessageLine(message: ModelMessage, messages: MessageTable): string {
  const tags: string[] = [];
  const anchor = idTag(message.messageId);
  if (anchor) tags.push(anchor);
  for (const replyId of message.replyIds) {
    if (!replyId) continue;
    tags.push(renderTemplate(messages["message_reply"] ?? "[回复了m:{{id}}]", { id: replyId }));
  }
  if (message.forward) tags.push(messages["message_forward"] ?? "[转发合集]");
  if (message.mentionsBot) tags.push(messages["message_mention_bot"] ?? "[这条消息@了你]");
  // [主人] 与 [特别关注] 互斥，master 优先
  if (message.master) tags.push(messages["message_master"] ?? "[主人]");
  else if (message.watched) tags.push(messages["message_watched"] ?? "[特别关注]");

  const body = lineText(message.text)
    || (message.forward ? messages["forward_parent_placeholder"] ?? "[转发合集]" : "");
  const prefix = tags.join("");
  const speaker = person(message.nickname, message.userId);
  return `${prefix}${prefix.length > 0 ? " " : ""}${speaker}: ${body}`.trimEnd();
}

function listHeader(messages: MessageTable, kind: "group" | "private" | "history"): string {
  if (kind === "private") return messages["message_private_header"] ?? "私聊有新消息啦。";
  if (kind === "history") return messages["message_history_header"] ?? "[历史消息]";
  return messages["message_group_header"] ?? "群里有新消息啦。";
}

/**
 * 标准消息列表：边界头 + `> 消息起始` + 逐行 + `> 消息结束`。
 * lines 接受已渲染的行（背景/历史尾巴）或 ModelMessage（现渲染），顺序即真实接收顺序。
 */
export function renderMessageList(
  lines: readonly (ModelMessage | string)[],
  messages: MessageTable,
  kind: "group" | "private" | "history",
): string {
  const rendered = lines.map((line) => (typeof line === "string" ? line : renderMessageLine(line, messages)));
  return [
    listHeader(messages, kind),
    messages["message_list_start"] ?? MESSAGE_LIST_START,
    ...rendered,
    messages["message_list_end"] ?? MESSAGE_LIST_END,
  ].join("\n");
}

/**
 * 引用原文附加段（消息列表后）。三种形态：
 * - 被引的是合集父消息：半角冒号 + [转发合集] 占位，不重复展开（附件另行渲染）；
 * - 普通文字引用：全角冒号 + 「原文」；
 * - 水合失败（昵称/QQ/正文/合集全缺）：显式读取失败标记，不伪造内容。
 */
export function renderQuotedOriginal(quoted: QuotedMessage, messages: MessageTable): string {
  const who = person(quoted.nickname, quoted.userId);
  if (quoted.forward) {
    return renderTemplate(messages["quoted_original_forward"] ?? "[引用原文][m:{{id}}] {{who}}: [转发合集]", {
      id: quoted.id,
      who,
    });
  }
  const text = lineText(quoted.text);
  if (!who && !text) {
    return renderTemplate(messages["quoted_read_failed"] ?? "[引用原文][m:{{id}}]（读取失败）", { id: quoted.id });
  }
  return renderTemplate(messages["quoted_original"] ?? "[引用原文][m:{{id}}] {{who}}：「{{text}}」", {
    id: quoted.id,
    who,
    text,
  });
}

/**
 * 合集附加段（消息列表后）：`[转发合集 N 条][来自m:id]` + 边界内 `[合集#N]` 子消息行
 * （保持 OneBot 返回顺序，仅渲染真实存在的子消息 ID/QQ），截断行在 `> 消息结束` 之后。
 * 子消息文本里的 [图片#N] 占位与压缩 image block 的编号对齐由装配方（T2）负责。
 * 拉取失败/空合集渲染显式读取失败标记，不伪造条数。
 */
export function renderForwardAttachment(forward: ForwardAttachment, messages: MessageTable): string {
  const source = forward.sourceMessageId === undefined || String(forward.sourceMessageId).length === 0
    ? ""
    : renderTemplate(messages["forward_source"] ?? "[来自m:{{id}}]", { id: String(forward.sourceMessageId) });
  if (forward.children.length === 0) {
    return messages["forward_read_failed"] ?? "[转发合集读取失败]";
  }
  const header = renderTemplate(messages["forward_header"] ?? "[转发合集 {{count}} 条]{{source}}", {
    count: String(forward.total),
    source,
  });
  const lines = forward.children.map((child) => {
    const prefix = `${renderTemplate(messages["forward_child_prefix"] ?? "[合集#{{position}}]", { position: String(child.position) })}${idTag(child.messageId)}`;
    const who = person(child.nickname || "?", child.userId ?? "");
    return `${prefix} ${who}: ${lineText(child.text)}`.trimEnd();
  });
  const parts = [
    header,
    messages["message_list_start"] ?? MESSAGE_LIST_START,
    ...lines,
    messages["message_list_end"] ?? MESSAGE_LIST_END,
  ];
  if (forward.truncated) {
    parts.push(renderTemplate(messages["forward_truncated"] ?? "…共 {{count}} 条", { count: String(forward.total) }));
  }
  return parts.join("\n");
}
