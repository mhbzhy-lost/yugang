/**
 * 装配的 base 状态（2026-11-05）：`openFish` 一开始就把“与具体能力无关”的东西算好，
 * 后面每个 `installX` 只读它或往上加自己的产物。
 *
 * 这里是进程级单例的装配期快照，不是每条消息的上下文；不放任何 runtime 回调。
 */
import { resolve } from "node:path";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { createModels, type Models } from "@earendil-works/pi-ai/models";
import type { Conversation } from "@earendil-works/pi-durable";
import { DEFAULT_LIMITS, type EgressLimits } from "../egress/policy.ts";
import { loadPrompts, type PromptSet } from "../prompt/index.ts";
import type { FishOptions } from "./types.ts";

export interface FishBase {
  options: FishOptions;
  models: Models;
  now: () => number;
  mediaRoot: string;
  workspaceRoot: string;
  limits: EgressLimits;
  prompts: PromptSet;
  ctx: typeof BACKGROUND_CONTEXT;
  /** conversationId → 该会话当前人格名（memory doc key）。 */
  memoryKeyByConversation: Map<string, string>;
  /** conversationId → 原始 chatKey（不带人格后缀）。 */
  chatKeyByConversation: Map<string, string>;
  /** 映射键（chatKey 或 chatKey#人格）→ 已创建的会话。 */
  groups: Map<string, Promise<Conversation>>;
  /** drain 的会话互斥：同一会话同一时刻只允许一个 drain 协程。 */
  sending: Set<string>;
}

/** 计算与能力无关的 base：模型、路径、文案、内存映射。 */
export function createFishBase(options: FishOptions): FishBase {
  const mediaRoot = resolve(options.mediaRoot);
  const workspaceRoot = resolve(options.workspaceRoot);
  return {
    options,
    models: options.models ?? createModels(),
    now: options.now ?? Date.now,
    mediaRoot,
    workspaceRoot,
    limits: { ...DEFAULT_LIMITS, ...options.limits, mediaRoot },
    prompts: loadPrompts(resolve(options.promptRoot)),
    ctx: BACKGROUND_CONTEXT,
    memoryKeyByConversation: new Map<string, string>(),
    chatKeyByConversation: new Map<string, string>(),
    groups: new Map<string, Promise<Conversation>>(),
    sending: new Set<string>(),
  };
}
