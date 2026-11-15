/**
 * 语音出口：say_voice 工具包。
 *
 * 用假合成桩跑完整路径（不联网、不碰真 TTS），覆盖：
 *  - 没配音色 → 拒绝
 *  - 正常：payload 带 voice、文本气泡为空、文件落盘
 *  - 长句 / 本轮已发过附件 → 拒绝
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
import { createSayVoiceTool } from "../src/tools/say_voice/tool.ts";
import { loadToolManifests } from "../src/tools/manifest.ts";
import { mergeToolMessages } from "../src/tools/loader.ts";
import { DEFAULT_LIMITS } from "../src/egress/policy.ts";
import { recordMedia } from "../src/egress/ledger.ts";
import { loadPrompts } from "../src/prompt/index.ts";
import { personaOf, pickVoice } from "../src/qq/voice-route.ts";
import { synthesizeToMedia, type TtsConfig } from "../src/tts.ts";

const ctx = BACKGROUND_CONTEXT;
const PROMPTS = fileURLToPath(new URL("../prompt", import.meta.url));
const TOOL_ROOT = fileURLToPath(new URL("../src/tools/", import.meta.url));

interface Captured {
  items: string[];
  media?: string;
  voice?: string;
}

function setup(over: { tts?: boolean } = {}) {
  const mediaRoot = mkdtempSync(join(tmpdir(), "yg-voice-"));
  mkdirSync(join(mediaRoot, "voice"), { recursive: true });
  const prompts = loadPrompts(PROMPTS);
  // 与 loader 同款合并：把各工具 TOOL.md 的 tool-messages 并进全局 messages 视图
  // （线上由 loadToolSurface 完成，这里手工拼 deps 也要拿到同一份合并视图）
  const manifests = loadToolManifests(TOOL_ROOT, { memeTags: prompts.memeTags });
  mergeToolMessages(manifests, prompts.messages);
  // 出站队列：say 在 commit 里 push 进 OutboxDoc
  const outbox: { items: string[]; media?: string; voice?: string }[] = [];

  const say = createSayVoiceTool(
    // 说明与参数 Schema 唯一来自 TOOL.md manifest（加载 src/tools/ 下的工具包清单）
    manifests.get("say_voice")!,
    {
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
    },
  )!;

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

  return { say, api, mediaRoot, outbox, prompts };
}

test("没配音色：say_voice 直接被拒", async () => {
  const { say, api } = setup({ tts: false });
  await assert.rejects(
    () => say.execute({ text: "晚安" } as never, api, ctx),
    /还没有语音能力/,
  );
});

test("正常路径：payload 带 voice、不发文字气泡、音频落盘", async () => {
  const { say, api, mediaRoot, outbox } = setup();
  const result = (await say.execute({ text: "晚安啦" } as never, api, ctx)) as {
    output: { type: string; text: string }[];
  };
  assert.match(result.output[0]?.text ?? "", /已发到群里/);

  const file = join(mediaRoot, "voice/3-test.wav");
  assert.ok(existsSync(file), "音频应写进 media/voice/");

  assert.equal(outbox.length, 1, "应入队一条");
  assert.ok(outbox[0]?.voice, "payload 必须带 voice");
  assert.deepEqual(outbox[0]?.items, [], "语音消息不再发文字气泡");
});

test("超过 200 字：拒绝并提示改文字", async () => {
  const { say, api } = setup();
  // 独立会话号：前置用例成功发过语音后，附件闸（一轮一条）会在字数检查前先把路拦死
  const longApi = { ...api, conversationId: "conv-long" } as never;
  const long = "啊".repeat(201);
  await assert.rejects(
    () => say.execute({ text: long } as never, longApi, ctx),
    /voice_too_long|太长/,
  );
});

test("本轮已发过图片/表情：语音被附件闸拒", async () => {
  const { say, api } = setup();
  // 附件闸按会话记在账本里：先用独立会话号预置一条，避免污染其它用例
  recordMedia("conv-media-used", 1_000);
  const usedApi = { ...api, conversationId: "conv-media-used" } as never;
  await assert.rejects(
    () => say.execute({ text: "晚安" } as never, usedApi, ctx),
    /这一轮已经配过图/,
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

test("TTS 单实例按模型与参考音频串行热切", async () => {
  const mediaRoot = mkdtempSync(join(tmpdir(), "yg-tts-hot-"));
  const calls: { path: string; body: Record<string, unknown> }[] = [];
  let active = 0;
  let maxActive = 0;
  const originalFetch = globalThis.fetch;
  globalThis.fetch = (async (input, init) => {
    const url = String(input);
    const body = JSON.parse(String(init?.body ?? "{}")) as Record<string, unknown>;
    active++;
    maxActive = Math.max(maxActive, active);
    try {
      calls.push({ path: new URL(url).pathname, body });
      if (url.endsWith("/set_model")) {
        if (body.gpt_model_path === "/fail.ckpt") {
          return new Response(JSON.stringify({ code: 1, message: "bad model" }), { status: 200 });
        }
        return new Response(JSON.stringify({ code: 0, message: "Success" }), { status: 200 });
      }
      if (url.endsWith("/change_refer")) return new Response(JSON.stringify({ code: 0, message: "Success" }), { status: 200 });
      return new Response(Buffer.alloc(4096, 1), { status: 200 });
    } finally {
      active--;
    }
  }) as typeof fetch;

  const a: TtsConfig = {
    url: "http://tts-hot-switch.test",
    gptModel: "/a.ckpt",
    sovitsModel: "/a.pth",
    referWav: "/a.wav",
    referText: "甲",
  };
  const b: TtsConfig = {
    ...a,
    gptModel: "/b.ckpt",
    sovitsModel: "/b.pth",
    referWav: "/b.wav",
    referText: "乙",
  };

  try {
    await Promise.all([
      synthesizeToMedia(a, "第一句", mediaRoot),
      synthesizeToMedia(b, "第二句", mediaRoot),
    ]);
    assert.equal(maxActive, 1, "同一 TTS 服务的切模和合成必须串行");
    assert.deepEqual(calls.slice(0, 6).map((call) => call.path), [
      "/set_model", "/change_refer", "/", "/set_model", "/change_refer", "/",
    ]);
    assert.equal(calls[0]?.body.gpt_model_path, "/a.ckpt");
    assert.equal(calls[3]?.body.gpt_model_path, "/b.ckpt");
    assert.equal(calls[1]?.body.refer_wav_path, "/a.wav");
    assert.equal(calls[4]?.body.refer_wav_path, "/b.wav");

    let before = calls.length;
    await synthesizeToMedia(b, "第三句", mediaRoot);
    assert.equal(calls.slice(before).filter((call) => call.path === "/set_model").length, 0, "同模型不应重复加载");

    before = calls.length;
    await assert.rejects(
      () => synthesizeToMedia({ ...a, gptModel: "/fail.ckpt" }, "失败", mediaRoot),
      /tts_control_failed/,
    );
    assert.equal(calls.slice(before).filter((call) => call.path === "/").length, 0, "切模失败不得继续合成");
    await assert.rejects(
      () => synthesizeToMedia({ url: a.url } as TtsConfig, "缺配置", mediaRoot),
      /tts_profile_incomplete/,
    );
  } finally {
    globalThis.fetch = originalFetch;
  }
});
