/**
 * 把 pi-durable 组装成「鱼」。
 *
 * 一只鱼身上只有三样东西：
 *   两只手  bash + read        （能力全靠 skills 里的脚本，用 bash 调）
 *   一张嘴  say                （唯一出口，硬校验）
 *
 * 一个 Conversation = 一个 QQ 群，自带 cwd 与 env，互不串。
 */
import { mkdirSync } from "node:fs";
import { join, resolve } from "node:path";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { createModels, type Models } from "@earendil-works/pi-ai/models";
import { NodeExecutionEnv } from "@earendil-works/pi-durable/env/node";
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
import { createHands } from "./sandbox.ts";
import { discoverSkills, renderSkillsPrompt } from "./skills.ts";

const ctx = BACKGROUND_CONTEXT;

export interface ModelRef {
  provider: string;
  modelId: string;
}

export interface FishOptions {
  storage: Storage;
  models?: Models;
  model: ModelRef;
  /** 人格书全文。 */
  persona: string;
  /** skills 根目录；每个子目录一个 SKILL.md。 */
  skillsRoot: string;
  /** 媒体白名单根目录（发图只能发这里面的）。 */
  mediaRoot: string;
  /** 每个群的工作目录根；实际 cwd 是 <workspaceRoot>/<groupKey>。 */
  workspaceRoot: string;
  limits?: Partial<Omit<EgressLimits, "mediaRoot">>;
  emit: (conversationId: ConversationId, payload: OutboundPayload) => void | Promise<void>;
  now?: () => number;
}

export interface Fish {
  harness: Harness;
  models: Models;
  skills: ReturnType<typeof discoverSkills>;
  group(groupKey: string): Promise<Conversation>;
  close(): Promise<void>;
}

export async function openFish(options: FishOptions): Promise<Fish> {
  const models = options.models ?? createModels();
  const now = options.now ?? Date.now;
  const limits: EgressLimits = { ...DEFAULT_LIMITS, ...options.limits, mediaRoot: options.mediaRoot };

  // 脚本要在任意 cwd 下都能跑，所以这两个根必须是绝对路径
  const skillsRoot = resolve(options.skillsRoot);
  const mediaRoot = resolve(options.mediaRoot);
  const workspaceRoot = resolve(options.workspaceRoot);
  limits.mediaRoot = mediaRoot;

  const skills = discoverSkills(skillsRoot);
  const say = createSayTool({ limits, emit: options.emit, now });
  const hands = createHands({ mediaRoot, skillsRoot });

  // 手：bash + read，就这两样
  const Hands = defineExtension({ name: "hands", tools: [hands.bash, hands.read] });

  // 嘴 + 身份 + 手艺清单
  const Fish = defineExtension({
    name: "fish",
    tools: [say],
    sections: [
      section("persona", () => options.persona, { tag: false }),
      section("skills", () => renderSkillsPrompt(skills), { tag: true }),
    ],
  });

  const registry = createRegistry();
  registry.install(Hands);
  registry.install(Fish);

  mkdirSync(workspaceRoot, { recursive: true });

  const harness = await Harness.open(
    options.storage,
    {
      models,
      registry,
      now,
      // 每个群一个 cwd：文件、临时产物、skill 生成的东西都落在这里
      env: (target) => {
        const cwd = target.cwd ?? join(workspaceRoot, String(target.conversationId));
        mkdirSync(cwd, { recursive: true });
        return new NodeExecutionEnv({ cwd });
      },
    },
    ctx,
  );

  const groups = new Map<string, Promise<Conversation>>();

  return {
    harness,
    models,
    skills,
    group(groupKey) {
      let existing = groups.get(groupKey);
      if (!existing) {
        const cwd = join(workspaceRoot, safeName(groupKey));
        mkdirSync(cwd, { recursive: true });
        existing = harness.createConversation(
          { ownership: { kind: "ownerless" }, agent: { model: options.model, cwd } },
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

function safeName(key: string): string {
  return key.replace(/[^A-Za-z0-9._-]+/g, "_");
}
