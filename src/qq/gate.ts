/**
 * 门外的闸：决定这条消息要不要进 agent loop。
 *
 * 顺序是刻意的：先做零成本的规则判断（主人、作息、配额、冷却、冷场），
 * 只有"拿不准"的时候才花一次便宜模型的调用去打分。
 *
 * 门内还有一次机会——模型可以选择不调用 say，那才是沉默的终态。
 */
import type { Models } from "@earendil-works/pi-ai/models";
import { renderTemplate, type PromptSet } from "../prompts.ts";
import type { IncomingMessage } from "./onebot.ts";

export interface GateOptions {
  prompts: PromptSet;
  models: Models;
  /** 用来打分的便宜模型。 */
  model: { provider: string; modelId: string };
  /** 主人 QQ；私聊只认他，群里他不需要过闸。 */
  master: string;
  /** 只在白名单群里说话；空数组 = 所有群。 */
  groups: readonly string[];
  /** 安静时段 [开始, 结束)，本地小时。 */
  quietHours?: readonly [number, number];
  /** 每群每天最多主动进几轮（被叫不算）。 */
  dailyQuota: number;
  /** 同一个群两次主动开口的最小间隔。 */
  cooldownMs: number;
  /** 没被叫、也没到冷却时，先按这个概率粗筛，省钱。 */
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
  | { enter: true; reason: "private" | "mentioned" | "master" | "scored"; score?: number }
  | { enter: false; reason: string };

export interface Gate {
  decide(input: GateInput): Promise<GateDecision>;
}

export function createGate(options: GateOptions): Gate {
  const now = options.now ?? Date.now;
  const random = options.random ?? Math.random;

  return {
    async decide({ msg, recent, lastSpokeAt, spokenToday }) {
      // 私聊：只认主人
      if (msg.chatKey.startsWith("qq:private:")) {
        if (String(msg.userId) === options.master) return { enter: true, reason: "private" };
        return { enter: false, reason: "stranger_private" };
      }

      if (options.groups.length > 0 && !options.groups.includes(String(msg.groupId))) {
        return { enter: false, reason: "group_not_allowed" };
      }

      const isMaster = String(msg.userId) === options.master;
      if (isMaster) return { enter: true, reason: "master" };
      if (msg.mentionsBot) return { enter: true, reason: "mentioned" };

      const hour = new Date(now()).getHours();
      if (inQuietHours(hour, options.quietHours)) return { enter: false, reason: "quiet_hours" };

      if (spokenToday >= options.dailyQuota) return { enter: false, reason: "quota" };
      if (now() - lastSpokeAt < options.cooldownMs) return { enter: false, reason: "cooldown" };

      // 粗筛：绝大多数消息到这就结束了，不进模型
      if (random() > options.ambientChance) return { enter: false, reason: "sampled_out" };

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

function inQuietHours(hour: number, window?: readonly [number, number]): boolean {
  if (!window) return false;
  const [start, end] = window;
  return start <= end ? hour >= start && hour < end : hour >= start || hour < end;
}

/** 群消息的结构化包装：身份与内容分开，避免群员把指令混进 system。 */
export function renderForModel(msg: IncomingMessage, master: string): string {
  const where = msg.groupId ? `群${msg.groupId}` : "私聊";
  const reply = msg.messageId ? ` 回复msg:${msg.messageId}` : "";
  const tags = [msg.mentionsBot ? "对你说话" : "", String(msg.userId) === master ? "你主人" : ""]
    .filter(Boolean)
    .join(" ");
  return `[${where} | ${msg.nickname}(${msg.userId})${reply}${tags ? ` ${tags}` : ""}] ${msg.text}`;
}
