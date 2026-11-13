/**
 * QQ 入站文本归一（2026-11-13 通道适配器 T3，从 src/app/runtime.ts 的
 * normalizeInbound 抽出）：分享卡片渲染与 bypass 段剥离是「进入模型前的文本整形」，
 * 属于通道输入转换；recent/chatlog/昵称映射等跨轮记账留在宿主。
 */
import { renderTemplate } from "../../prompt/index.ts";
import { splitBypass } from "../../qq/bypass.ts";
import type { MessageTable } from "../render.ts";
import type { IncomingMessage } from "./onebot.ts";

export interface PresentOptions {
  messages: MessageTable;
  /** bypass 白名单判定结果（宿主用 bypassAllowed 现算，归一层不自持配置）。 */
  bypassAllowed: boolean;
}

export interface PresentResult {
  text: string;
  bypass?: { clean: string; stash: string; pstash?: string };
}

/** 分享卡片：文本里只有 [卡片#N] 占位，按卡片内容渲染成可读文本（B 站带 b23.tv 短链，
 *  鱼据此就能调 video 去看那条视频）。就地改写 msg.text 与 msg.quoted.text。 */
export function renderCardsInPlace(msg: IncomingMessage, messages: MessageTable): void {
  if (!msg.cards || msg.cards.length === 0) return;
  for (const [index, card] of msg.cards.entries()) {
    const isBili = /bilibili\.com|b23\.tv/i.test(card.url ?? "");
    const template = (isBili ? messages["card_bilibili"] : messages["card_link"]) ?? "";
    const rendered = renderTemplate(template, {
      title: card.title ?? "",
      desc: card.desc ?? "",
      url: card.url ?? "",
    }).trim();
    if (rendered) {
      msg.text = msg.text.replace(`[卡片#${index}]`, rendered);
      // 引用原文里的卡片占位与正文共享同一个 cards 下标空间（onebot 水合时追加），
      // 同样换成可读文本；否则模型只能看到裸占位
      if (msg.quoted) msg.quoted.text = msg.quoted.text.replace(`[卡片#${index}]`, rendered);
    }
  }
}

/** 卡片渲染 + bypass 剥离：返回干净文本（改写 msg.text）与剥出的 bypass 载荷。 */
export function presentQQ(msg: IncomingMessage, options: PresentOptions): PresentResult {
  renderCardsInPlace(msg, options.messages);
  const bypass = options.bypassAllowed ? splitBypass(msg.text) : null;
  if (bypass) msg.text = bypass.clean || (options.messages["bypass_placeholder"] ?? "(draw)");
  return bypass ? { text: msg.text, bypass } : { text: msg.text };
}
