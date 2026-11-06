/**
 * installExtensions：默认人格扩展 + 每本人格书的扩展、registry、harness settings
 * （2026-11-05 从 harness.ts 拆出）。
 */
import { mkdirSync } from "node:fs";
import { createRegistry, defineExtension, type Extension, type ToolRegistration } from "@earendil-works/pi-durable";
import type { ToolManifest } from "../tools/types.ts";
import type { FishBase } from "./base.ts";
import { makeFishExtension } from "./extension.ts";
import type { ToolSurfaceParts } from "./tool-surface.ts";

export interface ExtensionParts {
  fishExtension: Extension;
  personaExtensions: Map<string, Extension>;
  openers: Record<string, string>;
  registry: ReturnType<typeof createRegistry>;
  settings: {
    compaction: { enabled: boolean };
    extensions: readonly Extension[];
    stream?: { transport: NonNullable<FishBase["options"]["streamTransport"]> };
    restartLimit: number;
  };
}

export function installExtensions(
  state: FishBase & ToolSurfaceParts,
): ExtensionParts {
  const { options, prompts, mediaRoot, workspaceRoot } = state;
  const { tools, surface } = state;

  // conversationId → 人格名 / 原始 chatKey：扩展的 memory section 与压缩链路共用。
  const memoryKeyOfConversation = (conversationId: string): string | undefined =>
    state.memoryKeyByConversation.get(conversationId);
  const chatKeyOfConversation = (conversationId: string): string | undefined =>
    state.chatKeyByConversation.get(conversationId);
  const engagementOf = (chatKey: string) => options.engagementOf?.(chatKey) ?? "legacy";

  const fishExtension = makeFishExtension("fish", prompts.persona, {
    tools,
    prompts,
    manifests: surface.manifests as readonly ToolManifest[],
    memoryKeyOf: memoryKeyOfConversation,
    chatKeyOf: chatKeyOfConversation,
    engagementOf,
  });
  const personaExtensions = new Map<string, Extension>();
  const openers: Record<string, string> = {};
  for (const [name, book] of Object.entries(prompts.personas)) {
    personaExtensions.set(name, makeFishExtension(`fish:${name}`, book.body, {
      tools: tools as readonly ToolRegistration[],
      prompts,
      manifests: surface.manifests as readonly ToolManifest[],
      memoryKeyOf: memoryKeyOfConversation,
      chatKeyOf: chatKeyOfConversation,
      engagementOf,
    }));
    if (book.opener) openers[name] = book.opener;
  }

  const registry = createRegistry();
  registry.install(fishExtension);
  for (const extension of personaExtensions.values()) registry.install(extension);
  // fish.reminder 任务定义单独一个小 extension 装：任务按 name 全局解析（不依赖会话
  // 选择哪个 extension），这里只解决「Harness 的 registry 认得这个 kind」。
  if (options.reminderTask) {
    registry.install(defineExtension({ name: "fish:reminders", tasks: [options.reminderTask] }));
  }

  mkdirSync(workspaceRoot, { recursive: true });
  mkdirSync(mediaRoot, { recursive: true });

  // pi-durable 默认的 compaction 会在中途注入一段库自带的总结提示词（不可审查），
  // 所以显式关掉：上下文靠分群隔离与 reset 控制，而不是靠一个我们看不到的 prompt。
  // extensions 必须钉住默认实例：缺省语义是「全部已装、后装者胜」——不钉住的话，
  // 没写 selection 的存量会话会被后装的 fish:<名> 顶替 persona section。
  const settings = {
    compaction: { enabled: false },
    extensions: [fishExtension],
    ...(options.streamTransport ? { stream: { transport: options.streamTransport } } : {}),
    // 中断的轮不恢复重跑：重启后针对陈年消息的迟到回复很怪（主人定案丢了就丢）
    restartLimit: 0,
  };

  return { fishExtension, personaExtensions, openers, registry, settings };
}
