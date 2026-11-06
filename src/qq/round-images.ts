/** 一轮消息的图片输入规划：真实生产拼装入口，供宿主与权威模板机械测试共用。 */
import { existsSync } from "node:fs";
import { join } from "node:path";
import type { IncomingMessage } from "./onebot.ts";
import type { BurstMessage } from "./debounce.ts";
import { shrinkForModel } from "../media/shrink-image.ts";
import { imageCompressedTagOf, imageTagOf, type ForwardAttachment, type MessageTable } from "./model-input.ts";

// vision==main 时静态图应全部直读（主人裁定 2026-11-06：不再为省额度强制 look 转述），
// 上限只为防一轮几十张图把上下文撑爆；GIF 不 inline（sips 只出静态帧），仍走 look/收图轮
const INLINE_IMAGE_MAX = 8;
const IMAGE_REF_PATTERN = /\[图片 (inbound\/[^\]\s]+)\]/g;
const FORWARD_IMAGE_PATTERN = /\[图片#\d+\]/g;

export interface RoundImageBlock { type: "image"; data: string; mimeType: string }

export interface RoundImagePlan {
  numbers: Map<string, number>;
  blocks: RoundImageBlock[];
  tags: string[];
  lookHint: boolean;
  messages: BurstMessage[];
}

function rewriteForwardImages(forward: ForwardAttachment, numbers: ReadonlyMap<string, number>, messages: MessageTable): ForwardAttachment {
  let changed = false;
  const children = forward.children.map((child) => {
    let index = 0;
    const text = child.text.replace(FORWARD_IMAGE_PATTERN, () => {
      const ref = child.images[index] ?? "";
      index += 1;
      const n = ref.length > 0 ? numbers.get(ref) : undefined;
      if (n !== undefined) return imageTagOf(n, ref, messages);
      return ref.length > 0 ? `[图片 ${ref}]` : "[图片 未展开]";
    });
    if (text === child.text) return child;
    changed = true;
    return { ...child, text };
  });
  return changed ? { ...forward, children } : forward;
}

/** 合集补展开的子图也走同一换编实现，避免宿主与测试出现两套编号。 */
export function rewriteRoundForwardImages(forward: ForwardAttachment, numbers: ReadonlyMap<string, number>, messages: MessageTable): ForwardAttachment {
  return rewriteForwardImages(forward, numbers, messages);
}

/**
 * inline 编号 + 压缩 block + 末尾压缩图标签：answer 轮（planRoundImages）与
 * 开窗批（shard 引用原文）共用的核心。inline 关闭时返回空（fallback 模式）。
 * GIF 与缺失文件不编号（GIF 只有静态帧压缩通道，静默收图轮/look 兜底）；
 * 压缩失败的跳过、不占编号。
 */
export function planInlineImages(
  refs: readonly string[],
  mediaRoot: string,
  inline: boolean,
  messages: MessageTable,
  shrink: typeof shrinkForModel = shrinkForModel,
): Pick<RoundImagePlan, "numbers" | "blocks" | "tags"> {
  const numbers = new Map<string, number>();
  const blocks: RoundImageBlock[] = [];
  const tags: string[] = [];
  if (!inline) return { numbers, blocks, tags };
  const eligible = refs.filter((ref) => ref && !ref.toLowerCase().endsWith(".gif") && existsSync(join(mediaRoot, ref)));
  for (const ref of eligible.slice(0, INLINE_IMAGE_MAX)) {
    const shrunk = shrink({ file: join(mediaRoot, ref) });
    if (!shrunk.ok) continue;
    const n = blocks.length + 1;
    numbers.set(ref, n);
    blocks.push({ type: "image", data: shrunk.buffer.toString("base64"), mimeType: shrunk.mimeType });
    tags.push(imageCompressedTagOf(n, messages));
  }
  return { numbers, blocks, tags };
}

/** 统一规划直发图与合集子图的编号、压缩 block、末尾标签和 look fallback。
 *  编号标签始终带 inbound 路径（[图片#N inbound/…]）：模型可直接把路径填给
 *  draw / gpt_image 等吃图片引用的工具，读图本身不需要 look。 */
export function planRoundImages(
  anchor: IncomingMessage,
  burst: readonly BurstMessage[],
  mediaRoot: string,
  inline: boolean,
  messages: MessageTable,
  shrink: typeof shrinkForModel = shrinkForModel,
): RoundImagePlan {
  const distinct: string[] = [];
  const seen = new Set<string>();
  const push = (ref: string): void => {
    if (ref && !seen.has(ref)) {
      seen.add(ref);
      distinct.push(ref);
    }
  };
  for (const image of anchor.images) push(image.ref);
  for (const line of burst) for (const match of line.text.matchAll(IMAGE_REF_PATTERN)) push(match[1] ?? "");
  // 被引消息的图（2026-11-05）：回复一张图说「收图」时，图只存在于 quoted.images 里；
  // 不纳入本轮编号就既不会 inline、也不会触发 look 提示。
  for (const line of burst) for (const ref of line.quoted?.images ?? []) push(ref);
  for (const line of burst) {
    for (const attachment of [line.forward, line.quoted?.forward]) {
      if (!attachment) continue;
      for (const child of attachment.children) for (const ref of child.images) push(ref);
    }
  }

  const { numbers, blocks, tags } = planInlineImages(distinct, mediaRoot, inline, messages, shrink);

  let lookHint = false;
  // 未编号的图才提示 look：inline 开启时静态图日常全量编号（≤8 张），提示只剩 GIF、
  // 超限与缺文件三类兜底；inline 关闭（fallback 模式）时全部走 look
  for (const line of burst) {
    for (const match of line.text.matchAll(IMAGE_REF_PATTERN)) {
      const ref = match[1] ?? "";
      if (ref && !ref.toLowerCase().endsWith(".gif") && !numbers.has(ref)) lookHint = true;
    }
    // 被引图没有别的读取路径（直发 GIF 有静默收图轮，引用图没有），GIF 也给 look 提示
    for (const ref of line.quoted?.images ?? []) {
      if (ref && !numbers.has(ref)) lookHint = true;
    }
    for (const attachment of [line.forward, line.quoted?.forward]) {
      if (!attachment) continue;
      for (const child of attachment.children) {
        for (const ref of child.images) {
          if (ref && !ref.toLowerCase().endsWith(".gif") && !numbers.has(ref)) lookHint = true;
        }
      }
    }
  }

  const rewritten = burst.map((line) => {
    let text = line.text;
    for (const [ref, n] of numbers) text = text.split(`[图片 ${ref}]`).join(imageTagOf(n, ref, messages));
    const forward = line.forward ? rewriteForwardImages(line.forward, numbers, messages) : undefined;
    const quotedForward = line.quoted?.forward ? rewriteForwardImages(line.quoted.forward, numbers, messages) : undefined;
    if (text === line.text && forward === undefined && quotedForward === undefined) return line;
    return {
      ...line,
      text,
      ...(forward !== undefined && forward !== line.forward ? { forward } : {}),
      ...(quotedForward !== undefined && quotedForward !== line.quoted?.forward && line.quoted
        ? { quoted: { ...line.quoted, forward: quotedForward } }
        : {}),
    };
  });

  return { numbers, blocks, tags, lookHint, messages: rewritten };
}
