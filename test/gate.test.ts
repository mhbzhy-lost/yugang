/**
 * 门：@ 必答 + 打分闸。
 *  - 私聊只认主人，陌生人一律不进
 *  - 群里任何人 @ 硬通行，零模型调用
 *  - 其余消息（含主人的非 @）一律过打分：模型说过才进，说不过/打分失败就不进
 */
import test from "node:test";
import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";
import { createModels } from "@earendil-works/pi-ai/models";
import { fauxAssistantMessage, fauxProvider } from "@earendil-works/pi-ai/providers/faux";
import { createGate, type GateOptions } from "../src/qq/gate.ts";
import { loadPrompts } from "../src/prompts.ts";
import type { IncomingMessage } from "../src/qq/onebot.ts";

const PROMPTS = fileURLToPath(new URL("../prompt", import.meta.url));
const MASTER = "1000";

function msg(over: Partial<IncomingMessage> = {}): IncomingMessage {
  return {
    chatKey: "qq:group:42",
    groupId: 42,
    userId: 2000,
    nickname: "张三",
    text: "今天好热",
    mentionsBot: false,
    images: [],
    imageSegments: [],
    replyIds: [],
    ...over,
  };
}

function build(gateResponse?: string, over: Partial<GateOptions> = {}) {
  const faux = fauxProvider();
  const models = createModels();
  models.setProvider(faux.provider);
  if (gateResponse !== undefined) faux.setResponses([fauxAssistantMessage(gateResponse)]);
  const gate = createGate({
    prompts: loadPrompts(PROMPTS),
    models,
    model: { provider: faux.provider.id, modelId: faux.models[0].id },
    master: MASTER,
    groups: [],
    dailyQuota: 10,
    cooldownMs: 60_000,
    ambientChance: 1,
    ...over,
  });
  return { gate, faux };
}

const idle = { recent: [], lastSpokeAt: 0, spokenToday: 0 };
const yes = JSON.stringify({ speak: true, score: 0.9, why: "在问鱼" });
const no = JSON.stringify({ speak: false, score: 0.1, why: "闲聊无关" });

test("陌生人私聊不进，主人的私聊直接进", async () => {
  const { gate } = build();
  const stranger = await gate.decide({ msg: msg({ chatKey: "qq:private:2000" }), ...idle });
  assert.equal(stranger.enter, false);
  assert.equal(denyReason(stranger), "stranger_private");

  const master = await gate.decide({ msg: msg({ chatKey: "qq:private:1000", userId: 1000 }), ...idle });
  assert.equal(master.enter, true);
});

test("任何群友 @ 都硬通行，不花模型调用", async () => {
  const { gate, faux } = build();
  const mentioned = await gate.decide({ msg: msg({ mentionsBot: true }), ...idle });
  assert.equal(mentioned.enter, true);
  assert.equal(denyReason(mentioned), "mentioned");
  assert.equal(faux.state.callCount, 0, "@ 通行不该调用模型");
});

test("主人的非 @ 过随机粗筛+打分：说过才进，说不过就沉默", async () => {
  const { gate } = build(yes, { random: () => 0 });
  const master = await gate.decide({ msg: msg({ userId: 1000, text: "不带 @ 说话" }), ...idle });
  assert.equal(master.enter, true);
  assert.equal(denyReason(master), "scored");

  const { gate: noGate } = build(no, { random: () => 0 });
  const rejected = await noGate.decide({ msg: msg({ userId: 1000, text: "随便唠嗑" }), ...idle });
  assert.equal(rejected.enter, false);
  assert.equal(denyReason(rejected), "gate_said_no");
});

test("随机粗筛挡掉绝大多数非 @ 消息，零模型调用", async () => {
  const { gate, faux } = build(undefined, { random: () => 1, ambientChance: 0.1 });
  const master = await gate.decide({ msg: msg({ userId: 1000 }), ...idle });
  assert.equal(master.enter, false);
  assert.equal(denyReason(master), "sampled_out");
  assert.equal(faux.state.callCount, 0, "粗筛拦下的不该花模型调用");
});

test("群友非 @ 粗筛过后同样打分；打分输出不成 JSON 按失败处理不进", async () => {
  const { gate } = build(yes, { random: () => 0 });
  const enter = await gate.decide({ msg: msg(), ...idle });
  assert.equal(enter.enter, true);
  assert.equal(denyReason(enter), "scored");

  const { gate: brokenGate } = build("今天天气不错", { random: () => 0 });
  const failed = await brokenGate.decide({ msg: msg(), ...idle });
  assert.equal(failed.enter, false);
  assert.equal(denyReason(failed), "gate_failed");
});

function denyReason(decision: { enter: boolean; reason: string }): string {
  return decision.reason;
}
