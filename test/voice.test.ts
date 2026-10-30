/**
 * 语音出口：say 的 voice 分支。
 *
 * 用假合成桩跑完整路径（不联网、不碰真 TTS），覆盖：
 *  - 没配音色 → 拒绝
 *  - 正常：payload 带 voice、文本气泡为空、文件落盘
 *  - 长句 / 与图片同发 → 拒绝
 *  - drain 把 voice 透传给 emit（漏字段 = 语音凭空消失）
 */
import test from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, writeFileSync, existsSync } from "node:fs";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { createModels } from "@earendil-works/pi-ai/models";
import { fauxProvider } from "@earendil-works/pi-ai/providers/faux";
import { MemoryStorage } from "@earendil-works/pi-durable";
import { openFish } from "../src/harness.ts";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { LiveDoc } from "@earendil-works/pi-durable";
import { createSayTool, OutboundEntry } from "../src/egress/say.ts";
import { DEFAULT_LIMITS } from "../src/egress/policy.ts";
import { loadPrompts } from "../src/prompts.ts";
import { personaOf, pickVoice } from "../src/voice-route.ts";

const ctx = BACKGROUND_CONTEXT;
const PROMPTS = fileURLToPath(new URL("../prompt", import.meta.url));

interface Captured {
  items: string[];
  media?: string;
  voice?: string;
}

function setup(over: { tts?: boolean } = {}) {
  const mediaRoot = mkdtempSync(join(tmpdir(), "yg-voice-"));
  mkdirSync(join(mediaRoot, "voice"), { recursive: true });
  const prompts = loadPrompts(PROMPTS);
  // 出站队列：say 在 commit 里 push 进 OutboxDoc
  const outbox: { items: string[]; media?: string; voice?: string }[] = [];

  const say = createSayTool({
    limits: { ...DEFAULT_LIMITS, mediaRoot },
    prompts,
    now: () => 1_000,
    ...(over.tts === false ? {} : { ttsOf: () => ({ url: "http://127.0.0.1:9/tts" }) }),
    // 假合成：写一个真文件，返回相对引用
    ttsSynthesize: async (_config, text, root) => {
      const file = `voice/${text.length}-test.wav`;
      writeFileSync(join(root, file), Buffer.alloc(4096, 1));
      return { bytes: Buffer.alloc(4096, 1), ref: file };
    },
  });

  const api = {
    conversationId: "1",
    callId: "call_test",
    snapshot: async (doc: unknown) => (doc === LiveDoc ? { run: { inputs: [42] } } : undefined),
    commit: async (fn: (tx: unknown) => Promise<void>) =>
      fn({
        doc: async () => ({ queue: outbox }),
        appendEntry: async () => ({ id: 1 }),
      }),
  } as never;

  return { say, api, mediaRoot, outbox };
}

test("没配音色：voice 直接被拒", async () => {
  const { say, api } = setup({ tts: false });
  await assert.rejects(
    () => say.execute({ messages: ["晚安"], voice: true } as never, api, ctx),
    /还没有语音能力/,
  );
});

test("正常路径：payload 带 voice、不发文字气泡、音频落盘", async () => {
  const { say, api, mediaRoot, outbox } = setup();
  const result = (await say.execute({ messages: ["晚安啦"], voice: true } as never, api, ctx)) as {
    output: { type: string; text: string }[];
  };
  assert.match(result.output[0]?.text ?? "", /已发到群里/);

  const file = join(mediaRoot, "voice/3-test.wav");
  assert.ok(existsSync(file), "音频应写进 media/voice/");

  assert.equal(outbox.length, 1, "应入队一条");
  assert.ok(outbox[0]?.voice, "payload 必须带 voice");
  assert.deepEqual(outbox[0]?.items, [], "语音消息不再发文字气泡");
});

test("超过 100 字：拒绝并提示改文字", async () => {
  const { say, api } = setup();
  const long = "啊".repeat(101);
  await assert.rejects(
    () => say.execute({ messages: [long], voice: true } as never, api, ctx),
    /voice_too_long|太长/,
  );
});

test("语音与图片同发：拒绝", async () => {
  const { say, api } = setup();
  await assert.rejects(
    () => say.execute({ messages: ["晚安"], voice: true, media: "gen/x.png" } as never, api, ctx),
    /不能和图片/,
  );
});

test("drain 把 voice 透传给 emit（漏字段会让整条语音消失）", async () => {
  const outbox: { items: string[]; voice?: string }[] = [];
  const dir = mkdtempSync(join(tmpdir(), "yg-voice-drain-"));
  const models = createModels();
  const provider = fauxProvider();
  models.setProvider(provider.provider);
  const fish = await openFish({
    storage: new MemoryStorage(),
    models,
    model: { provider: provider.provider.id, modelId: provider.models[0].id },
    promptRoot: PROMPTS,
    mediaRoot: dir,
    workspaceRoot: mkdtempSync(join(tmpdir(), "yg-ws-")),
    emit: (_id, payload) => {
      outbox.push({ items: payload.items, ...(payload.voice ? { voice: payload.voice } : {}) });
    },
    react: () => {},
    master: "1",
  });
  try {
    const conv = await fish.group("qq:group:9");
    await fish.enqueue(conv.id, {
      items: [],
      voice: "voice/test.wav",
      quote: false,
      at: Date.now(),
      key: "test:voice:1",
    });
    const sent = await fish.drain();
    assert.equal(sent, 1);
    assert.equal(outbox[0]?.voice, "voice/test.wav", "voice 必须透传到 emit");
  } finally {
    await fish.close();
  }
});

test("音色按人格隔离：没配音色的人格拿不到别人的声音", () => {
  const voices = { 爱莉希雅: { url: "http://127.0.0.1:9880" } };

  // 长征机群：映射键带 #长征机，voices 里没有 → 没有语音能力（不能回落到爱莉）
  assert.equal(pickVoice(voices, "qq:group:5278#长征机"), undefined);

  // 爱莉群：正常命中
  assert.deepEqual(pickVoice(voices, "qq:group:5915#爱莉希雅"), { url: "http://127.0.0.1:9880" });

  // 默认人格（没有 # 后缀）也没有配置 → 没有语音（曾经的 .env 兜底就是这么串音的）
  assert.equal(pickVoice(voices, "qq:private:2928390812"), undefined);

  assert.equal(personaOf("qq:group:5278#长征机"), "长征机");
  assert.equal(personaOf("qq:private:2928390812"), "默认");
});
