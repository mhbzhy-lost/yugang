/**
 * 门：只响应艾特。
 *  - 私聊只认主人，陌生人一律不进
 *  - 群里主人免检；任何人 @ 都硬通行，作息/配额/冷却/抽样一律不拦
 *  - 其余群消息一律不进，也不花模型调用
 */
import test from "node:test";
import assert from "node:assert/strict";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { createModels } from "@earendil-works/pi-ai/models";
import { fauxProvider } from "@earendil-works/pi-ai/providers/faux";
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
    ...over,
  };
}

function build(over: Partial<GateOptions> = {}) {
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
    cooldownMs: 60_000,
    ambientChance: 1,
    ...over,
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

test("任何群友 @ 都硬通行，不花模型调用", async () => {
  const { gate, faux } = build();
  const mentioned = await gate.decide({ msg: msg({ mentionsBot: true }), ...idle });
  assert.equal(mentioned.enter, true);
  assert.equal(denyReason(mentioned), "mentioned");

  const master = await gate.decide({ msg: msg({ userId: 1000 }), ...idle });
  assert.equal(denyReason(master), "master");
  assert.equal(faux.state.callCount, 0, "免检路径不该调用模型");
});

test("作息、配额、冷却不再拦 @ 和主人", async () => {
  // 极端参数：安静时段 + 配额用光 + 冷却刚开口，@ 和主人照样进
  const { gate } = build({ quietHours: [0, 24], dailyQuota: 0, cooldownMs: 3_600_000 });
  const busy = { recent: [], lastSpokeAt: Date.now(), spokenToday: 999 };

  const master = await gate.decide({ msg: msg({ userId: 1000, text: "不带 @ 说话" }), ...busy });
  assert.equal(denyReason(master), "master");

  const mentioned = await gate.decide({ msg: msg({ mentionsBot: true }), ...busy });
  assert.equal(mentioned.enter, true);
  assert.equal(denyReason(mentioned), "mentioned");
});

test("非 @ 非主人一律沉默，不抽样也不打分", async () => {
  // ambientChance = 1（抽样必中）也无效：非 @ 非主人直接 drop，一个模型调用都不花
  const { gate, faux } = build({ ambientChance: 1 });
  const decision = await gate.decide({ msg: msg(), ...idle });
  assert.equal(decision.enter, false);
  assert.equal(denyReason(decision), "not_mentioned");
  assert.equal(faux.state.callCount, 0, "不该为非 @ 消息花模型调用");
});

function denyReason(decision: { enter: boolean; reason: string }): string {
  return decision.reason;
}
