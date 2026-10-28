/**
 * 门：先规则后打分。
 *  - 私聊只认主人，陌生人一律不进
 *  - 群里 @ 和主人免检；作息 / 配额 / 冷却挡在前面
 *  - 只有"拿不准"时才花一次模型调用
 */
import test from "node:test";
import assert from "node:assert/strict";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { createModels } from "@earendil-works/pi-ai/models";
import { fauxAssistantMessage, fauxProvider } from "@earendil-works/pi-ai/providers/faux";
import { createGate } from "../src/qq/gate.ts";
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
    ...over,
  };
}

function build(gateResponse?: string) {
  const faux = fauxProvider();
  const models = createModels();
  models.setProvider(faux.provider);
  if (gateResponse) faux.setResponses([fauxAssistantMessage(gateResponse)]);
  const gate = createGate({
    prompts: loadPrompts(PROMPTS),
    models,
    model: { provider: faux.provider.id, modelId: faux.models[0].id },
    master: MASTER,
    groups: [],
    dailyQuota: 10,
    cooldownMs: 60_000,
    ambientChance: 1,
    now: () => new Date("2026-05-01T12:00:00").getTime(),
    random: () => 0,
  });
  return { gate, faux };
}

const idle = { recent: [], lastSpokeAt: 0, spokenToday: 0 };

test("陌生人私聊不进，主人的私聊直接进", async () => {
  const { gate } = build();
  const stranger = await gate.decide({ msg: msg({ chatKey: "qq:private:2000" }), ...idle });
  assert.equal(stranger.enter, false);
  assert.equal(denyReason(stranger), "stranger_private");

  const master = await gate.decide({ msg: msg({ chatKey: "qq:private:1000", userId: 1000 }), ...idle });
  assert.equal(master.enter, true);
});

test("@ 和主人免检，不花模型调用", async () => {
  const { gate, faux } = build();
  const mentioned = await gate.decide({ msg: msg({ mentionsBot: true }), ...idle });
  assert.equal(mentioned.enter, true);
  assert.equal(denyReason(mentioned), "mentioned");

  const master = await gate.decide({ msg: msg({ userId: 1000 }), ...idle });
  assert.equal(denyReason(master), "master");
  assert.equal(faux.state.callCount, 0, "免检路径不该调用模型");
});

test("作息、配额、冷却挡在前面", async () => {
  const quietModels = createModels();
  quietModels.setProvider(fauxProvider().provider);
  const quietGate = createGate({
    prompts: loadPrompts(PROMPTS),
    models: quietModels,
    model: { provider: "faux", modelId: "faux-1" },
    master: MASTER,
    groups: [],
    quietHours: [11, 13],
    dailyQuota: 10,
    cooldownMs: 1000,
    ambientChance: 1,
    now: () => new Date("2026-05-01T12:00:00").getTime(),
    random: () => 0,
  });
  assert.equal(denyReason(await quietGate.decide({ msg: msg(), ...idle })), "quiet_hours");

  const { gate } = build();
  assert.equal(denyReason(await gate.decide({ msg: msg(), ...idle, spokenToday: 10 })), "quota");
  assert.equal(denyReason(await gate.decide({ msg: msg(), ...idle, lastSpokeAt: Date.now() })), "cooldown");
});

test("打分说不要就不进，说要就进", async () => {
  const no = build('{"speak": false, "score": 0.1, "why": "插不进去"}');
  assert.equal(denyReason(await no.gate.decide({ msg: msg(), ...idle })), "gate_said_no");

  const yes = build('{"speak": true, "score": 0.8, "why": "可以接"}');
  const decision = await yes.gate.decide({ msg: msg(), ...idle });
  assert.equal(decision.enter, true);
  assert.equal(denyReason(decision), "scored");
});

test("模型答歪了就保守放弃，不放行", async () => {
  const broken = build("我觉得可以聊");
  assert.equal(denyReason(await broken.gate.decide({ msg: msg(), ...idle })), "gate_failed");
});

test("抽样没中就不花模型调用", async () => {
  const faux = fauxProvider();
  const models = createModels();
  models.setProvider(faux.provider);
  const gate = createGate({
    prompts: loadPrompts(PROMPTS),
    models,
    model: { provider: faux.provider.id, modelId: faux.models[0].id },
    master: MASTER,
    groups: [],
    dailyQuota: 10,
    cooldownMs: 0,
    ambientChance: 0.1,
    now: () => 0,
    random: () => 0.9,
  });
  assert.equal(denyReason(await gate.decide({ msg: msg(), ...idle })), "sampled_out");
  assert.equal(faux.state.callCount, 0);
});

function denyReason(decision: { enter: boolean; reason: string }): string {
  return decision.reason;
}
