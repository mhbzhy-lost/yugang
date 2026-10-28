/**
 * 把 pi-durable 组装成「鱼」。
 *
 * 一个 Conversation = 一个 QQ 群。Harness 负责答案、工具调用、崩溃恢复；
 * 我们只贡献三样东西：人格 section、say 工具、以及一个不暴露 transcript 的出站口。
 */
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { createModels, type Models } from "@earendil-works/pi-ai/models";
import {
  Harness,
  createRegistry,
  defineExtension,
  section,
  type Conversation,
  type ConversationId,
  type Storage,
} from "@earendil-works/pi-durable";
import { DEFAULT_LIMITS, type EgressLimits } from "./egress/policy.ts";
import { createSayTool, type OutboundPayload } from "./egress/say.ts";

const ctx = BACKGROUND_CONTEXT;

export interface ModelRef {
  provider: string;
  modelId: string;
}

export interface FishOptions {
  storage: Storage;
  /** 已经配好 provider 的 Models；不传就新建一个空的。 */
  models?: Models;
  model: ModelRef;
  /** 人格书全文，作为 system prompt 的一个 section。 */
  persona: string;
  /** 媒体白名单根目录（发图只能发这里的）。 */
  mediaRoot: string;
  limits?: Partial<Omit<EgressLimits, "mediaRoot">>;
  /** 出站口：校验通过的消息落到这里，由 QQ 适配器负责真正发出去。 */
  emit: (conversationId: ConversationId, payload: OutboundPayload) => void | Promise<void>;
  now?: () => number;
}

export interface Fish {
  harness: Harness;
  models: Models;
  /** 取（或创建）某个群的会话。groupKey 建议用 `qq:group:<群号>`。 */
  group(groupKey: string): Promise<Conversation>;
  close(): Promise<void>;
}

export async function openFish(options: FishOptions): Promise<Fish> {
  const models = options.models ?? createModels();
  const now = options.now ?? Date.now;

  const limits: EgressLimits = { ...DEFAULT_LIMITS, ...options.limits, mediaRoot: options.mediaRoot };

  const say = createSayTool({ limits, emit: options.emit, now });

  const fish = defineExtension({
    name: "fish",
    // 人格书：不是「语气提示」而是身份，放最前面
    sections: [section("persona", () => options.persona, { tag: false })],
    tools: [say],
  });

  const registry = createRegistry();
  registry.install(fish);

  const harness = await Harness.open(options.storage, { models, registry, now }, ctx);

  const groups = new Map<string, Promise<Conversation>>();

  return {
    harness,
    models,
    group(groupKey) {
      let existing = groups.get(groupKey);
      if (!existing) {
        // 一个群一个 conversation：transcript、上下文、记忆、工具都自然隔离
        existing = harness.createConversation(
          { ownership: { kind: "ownerless" }, agent: { model: options.model } },
          ctx,
        );
        groups.set(groupKey, existing);
      }
      return existing;
    },
    async close() {
      await harness.close(ctx);
    },
  };
}
