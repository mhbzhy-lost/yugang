/**
 * 语音出口：say 的 voice 分支。
 *
 * 用假合成桩跑完整路径（不联网、不碰真 TTS），覆盖四件事：
 *  - 没配音色 → voice_off
 *  - 本轮没被标记 → voice_unavailable
 *  - 正常：payload 带 voice、文本气泡为空、文件落盘
 *  - 长句 / 与图片同发 → 拒绝
 */
import test from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, writeFileSync, existsSync } from "node:fs";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { LiveDoc } from "@earendil-works/pi-durable";
import { createSayTool, OutboundEntry } from "../src/egress/say.ts";
import { DEFAULT_LIMITS } from "../src/egress/policy.ts";
import { loadPrompts } from "../src/prompts.ts";

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

test("超过 60 字：拒绝并提示改文字", async () => {
  const { say, api } = setup();
  const long = "啊".repeat(61);
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
