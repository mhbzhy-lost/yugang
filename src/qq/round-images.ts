/** 一轮消息的图片输入规划：真实生产拼装入口，供宿主与权威模板机械测试共用。 */
import { existsSync } from "node:fs";
import { join } from "node:path";
import type { IncomingMessage } from "./onebot.ts";
import type { BurstMessage } from "./debounce.ts";
import { extractGifFrames, GIF_FRAME_LONG_SIDE, type GifFramePlan } from "../media/gif-frames.ts";
import { inlineImageOf, shrinkForModel, type ShrinkResult } from "../media/shrink-image.ts";
import { gifCompressedTagOf, gifTagOf, imageCompressedTagOf, imageTagOf, type ForwardAttachment, type MessageTable } from "./model-input.ts";

// vision==main 时静态图应全部直读（主人裁定 2026-11-06：不再为省额度强制 look 转述），
// 上限只为防一轮几十张图把上下文撑爆；GIF 同样参与编号（算 1 张），帧数另算
const INLINE_IMAGE_MAX = 8;
/** GIF 抽帧上限（普通轮 / shard 批）。 */
const GIF_MAX_FRAMES = 4;
const IMAGE_REF_PATTERN = /\[图片 (inbound\/[^\]\s]+)\]/g;
const FORWARD_IMAGE_PATTERN = /\[图片#\d+\]/g;

export interface RoundImageBlock { type: "image"; data: string; mimeType: string }

export interface RoundImagePlan {
  numbers: Map<string, number>;
  blocks: RoundImageBlock[];
  tags: string[];
  /** GIF 路径 → 帧数（静态图不进表）：标签渲染「·动图N帧」用。 */
  gifFrames: Map<string, number>;
  lookHint: boolean;
  messages: BurstMessage[];
}

function rewriteForwardImages(
  forward: ForwardAttachment,
  numbers: ReadonlyMap<string, number>,
  gifFrames: ReadonlyMap<string, number>,
  messages: MessageTable,
): ForwardAttachment {
  let changed = false;
  const children = forward.children.map((child) => {
    let index = 0;
    const text = child.text.replace(FORWARD_IMAGE_PATTERN, () => {
      const ref = child.images[index] ?? "";
      index += 1;
      const n = ref.length > 0 ? numbers.get(ref) : undefined;
      if (n !== undefined) {
        const frames = gifFrames.get(ref);
        return frames !== undefined ? gifTagOf(n, ref, frames, messages) : imageTagOf(n, ref, messages);
      }
      return ref.length > 0 ? `[图片 ${ref}]` : "[图片 未展开]";
    });
    if (text === child.text) return child;
    changed = true;
    return { ...child, text };
  });
  return changed ? { ...forward, children } : forward;
}

/** 合集补展开的子图也走同一换编实现，避免宿主与测试出现两套编号。 */
export function rewriteRoundForwardImages(
  forward: ForwardAttachment,
  numbers: ReadonlyMap<string, number>,
  gifFrames: ReadonlyMap<string, number>,
  messages: MessageTable,
): ForwardAttachment {
  return rewriteForwardImages(forward, numbers, gifFrames, messages);
}

/**
 * inline 编号 + 压缩 block + 末尾压缩图标签：answer 轮（planRoundImages）与
 * 开窗批（shard 引用原文）共用的核心。inline 关闭时返回空（fallback 模式）。
 * GIF 走抽帧多 block（网关对 image/gif 只解码首帧，2026-11-06 实测；帧数记进
 * gifFrames 供调用方渲染「·动图N帧」后缀）；抽帧失败降级首帧单张。缺失文件
 * 不编号；压缩失败的跳过、不占编号。GIF 占 1 个编号、N 个 block。
 */
export interface InlineImagePlan extends Pick<RoundImagePlan, "numbers" | "blocks" | "tags"> {
  /** GIF 路径 → 实际抽到的帧数（静态图不进这张表）。 */
  gifFrames: Map<string, number>;
}

export function planInlineImages(
  refs: readonly string[],
  mediaRoot: string,
  inline: boolean,
  messages: MessageTable,
  shrink: (input: { file: string }) => ShrinkResult = shrinkForModel,
  gifFramesOf: (file: string, maxFrames: number) => GifFramePlan = extractGifFrames,
): InlineImagePlan {
  const numbers = new Map<string, number>();
  const blocks: RoundImageBlock[] = [];
  const tags: string[] = [];
  const gifFrames = new Map<string, number>();
  if (!inline) return { numbers, blocks, tags, gifFrames };
  const eligible = refs.filter((ref) => ref && existsSync(join(mediaRoot, ref)));
  for (const ref of eligible.slice(0, INLINE_IMAGE_MAX)) {
    if (ref.toLowerCase().endsWith(".gif")) {
      const plan = gifFramesOf(join(mediaRoot, ref), GIF_MAX_FRAMES);
      if (plan.frames.length === 0) continue;
      const n = blocks.length + 1;
      numbers.set(ref, n);
      for (const frame of plan.frames) blocks.push({ type: "image", data: frame, mimeType: "image/jpeg" });
      gifFrames.set(ref, plan.frames.length);
      tags.push(gifCompressedTagOf(n, plan.frames.length, messages));
      continue;
    }
    const image = inlineImageOf(join(mediaRoot, ref), shrink);
    if (!image.ok) continue;
    const n = blocks.length + 1;
    numbers.set(ref, n);
    blocks.push({ type: "image", data: image.buffer.toString("base64"), mimeType: image.mimeType });
    tags.push(imageCompressedTagOf(n, messages));
  }
  return { numbers, blocks, tags, gifFrames };
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
  shrink: (input: { file: string }) => ShrinkResult = shrinkForModel,
  gifFramesOf: (file: string, maxFrames: number) => GifFramePlan = extractGifFrames,
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

  const { numbers, blocks, tags, gifFrames } = planInlineImages(distinct, mediaRoot, inline, messages, shrink, gifFramesOf);

  // look 提示只在 fallback 模式出现（inline 模式下 look 已被机械锁死，提示反而误导）：
  // inline 时未编号的图（超 8 张、缺文件）就是「看不了」，模型没必要去调一个必被拒的工具
  let lookHint = false;
  if (!inline) {
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
  }

  const rewritten = burst.map((line) => {
    let text = line.text;
    for (const [ref, n] of numbers) {
      const frames = gifFrames.get(ref);
      const tag = frames !== undefined ? gifTagOf(n, ref, frames, messages) : imageTagOf(n, ref, messages);
      text = text.split(`[图片 ${ref}]`).join(tag);
    }
    const forward = line.forward ? rewriteForwardImages(line.forward, numbers, gifFrames, messages) : undefined;
    const quotedForward = line.quoted?.forward ? rewriteForwardImages(line.quoted.forward, numbers, gifFrames, messages) : undefined;
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

  return { numbers, blocks, tags, gifFrames, lookHint, messages: rewritten };
}
