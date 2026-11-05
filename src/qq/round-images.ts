/** 一轮消息的图片输入规划：真实生产拼装入口，供宿主与权威模板机械测试共用。 */
import { existsSync } from "node:fs";
import { join } from "node:path";
import type { IncomingMessage } from "./onebot.ts";
import type { BurstMessage } from "./debounce.ts";
import { shrinkForModel } from "../media/shrink-image.ts";
import { imageCompressedTagOf, imageTagOf, type ForwardAttachment, type MessageTable } from "./model-input.ts";

const INLINE_IMAGE_MAX = 2;
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
      if (n !== undefined) return imageTagOf(n, messages);
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

/** 统一规划直发图与合集子图的编号、压缩 block、末尾标签和 look fallback。 */
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

  const numbers = new Map<string, number>();
  const blocks: RoundImageBlock[] = [];
  const tags: string[] = [];
  if (inline) {
    const eligible = distinct.filter((ref) => !ref.toLowerCase().endsWith(".gif") && existsSync(join(mediaRoot, ref)));
    for (const ref of eligible.slice(0, INLINE_IMAGE_MAX)) {
      const shrunk = shrink({ file: join(mediaRoot, ref) });
      if (!shrunk.ok) continue;
      const n = blocks.length + 1;
      numbers.set(ref, n);
      blocks.push({ type: "image", data: shrunk.buffer.toString("base64"), mimeType: shrunk.mimeType });
      tags.push(imageCompressedTagOf(n, messages));
    }
  }

  let lookHint = false;
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
    for (const [ref, n] of numbers) text = text.split(`[图片 ${ref}]`).join(imageTagOf(n, messages));
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
