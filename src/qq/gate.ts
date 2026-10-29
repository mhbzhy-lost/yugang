/**
 * 门外的闸：决定这条消息要不要进 agent loop。
 *
 * 当前策略——@ 必答 + 随机粗筛 + 打分闸：
 *   私聊只认主人；群里任何人 @ → 必答；其余消息（含主人的）先过一道随机粗筛
 *   （AMBIENT_CHANCE，绝大多数到这就结束、零成本），筛过的再花一次便宜模型打分
 *   （prompt/gate.md），值得开口才进。回复这件事上不分主人。
 *
 * 旧的作息/配额/冷却/抽样不再参与判定，字段仅兼容保留；
 * 门内模型仍可以选择不调用 say，那才是沉默的终态。
 */
import type { Models } from "@earendil-works/pi-ai/models";
import { renderTemplate, type PromptSet } from "../prompts.ts";
import type { IncomingMessage } from "./onebot.ts";

export interface GateOptions {
  prompts: PromptSet;
  models: Models;
  /** 用来打分的模型（默认与主模型同源，可经 GATE_PROVIDER/GATE_MODEL_ID 换便宜的）。 */
  model: { provider: string; modelId: string };
  /** 主人 QQ；私聊只认他。群里他与所有人同权：@ 必答，非 @ 过打分。 */
  master: string;
  /** 只在白名单群里说话；空数组 = 所有群。 */
  groups: readonly string[];
  /** 【仅兼容保留，当前策略下无效】旧安静时段。 */
  quietHours?: readonly [number, number];
  /** 【仅兼容保留，当前策略下无效】旧每日主动配额。 */
  dailyQuota: number;
  /** 【仅兼容保留，当前策略下无效】旧开口冷却。 */
  cooldownMs: number;
  /** 非 @ 消息进入打分的概率（随机粗筛，零成本挡掉大多数）。 */
  ambientChance: number;
  now?: () => number;
  random?: () => number;
}

export interface GateInput {
  msg: IncomingMessage;
  /** 最近的群聊流水，喂给打分模型。 */
  recent: readonly { nickname: string; text: string }[];
  lastSpokeAt: number;
  spokenToday: number;
}

export type GateDecision =
  | { enter: true; reason: "private" | "mentioned" | "scored"; score?: number }
  | { enter: false; reason: string };

export interface Gate {
  decide(input: GateInput): Promise<GateDecision>;
}

export function createGate(options: GateOptions): Gate {
  const random = options.random ?? Math.random;
  return {
    async decide({ msg, recent }) {
      // 私聊：只认主人
      if (msg.chatKey.startsWith("qq:private:")) {
        if (String(msg.userId) === options.master) return { enter: true, reason: "private" };
        return { enter: false, reason: "stranger_private" };
      }

      // 群白名单对谁都生效
      if (options.groups.length > 0 && !options.groups.includes(String(msg.groupId))) {
        return { enter: false, reason: "group_not_allowed" };
      }

      // 任何人 @（含裸 @）必答，零模型调用
      if (msg.mentionsBot) return { enter: true, reason: "mentioned" };

      // 合并转发合集直接放行：特意发合集基本就是要给鱼看的，不该赌 10% 粗筛
      if ((msg.forwardIds?.length ?? 0) > 0) return { enter: true, reason: "forward" };

      // 随机粗筛：绝大多数非 @ 消息到这就结束，不花模型调用
      if (random() > options.ambientChance) return { enter: false, reason: "sampled_out" };

      // 粗筛过的再打分，值得开口才进
      const verdict = await askGate(options, msg, recent);
      if (verdict === null) return { enter: false, reason: "gate_failed" };
      if (!verdict.speak || verdict.score < 0.5) return { enter: false, reason: "gate_said_no" };
      return { enter: true, reason: "scored", score: verdict.score };
    },
  };
}

interface Score {
  speak: boolean;
  score: number;
  why: string;
}

async function askGate(options: GateOptions, msg: IncomingMessage, recent: readonly { nickname: string; text: string }[]): Promise<Score | null> {
  const model = options.models.getModel(options.model.provider, options.model.modelId);
  if (!model) return null;

  const context = recent.map((m) => `${m.nickname}: ${m.text}`).join("\n") || "（群里还没人说话）";
  const prompt = renderTemplate(options.prompts.gate, {
    context,
    incoming: `${msg.nickname}: ${msg.text}`,
    master: options.master,
  });

  try {
    const stream = options.models.streamSimple(model, { messages: [{ role: "user", content: prompt }] });
    const message = await stream.result();
    const text = message.content
      .filter((block): block is { type: "text"; text: string } => block.type === "text")
      .map((block) => block.text)
      .join("\n");

    const json = /\{[\s\S]*\}/.exec(text);
    if (!json) return null;
    const parsed = JSON.parse(json[0]) as Partial<Score>;
    return { speak: parsed.speak === true, score: Number(parsed.score ?? 0), why: String(parsed.why ?? "") };
  } catch {
    return null;
  }
}

/** 进闸消息渲染成模型的 user 文本：带群/人/是否@/是否主人的标注。 */
export function renderForModel(msg: IncomingMessage, master: string): string {
  const where = msg.groupId ? `群${msg.groupId}` : `私聊`;
  const reply = msg.messageId ? ` 回复msg:${msg.messageId}` : "";
  const tags = [msg.mentionsBot ? "对你说话" : "", String(msg.userId) === master ? "你主人" : ""]
    .filter(Boolean)
    .join(" ");
  return `[${where} | ${msg.nickname}(${msg.userId})${reply}${tags ? ` ${tags}` : ""}] ${msg.text}`;
}
