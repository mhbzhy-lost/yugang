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
import { loadPrompts } from "../src/prompt/index.ts";
import { personaOf, pickVoice } from "../src/qq/voice-route.ts";
import { fixWavHeader, synthesizeToMedia, type TtsConfig } from "../src/tts.ts";
import { loadFishConfig } from "../src/fish-config.ts";

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
  // 独立会话号：避免前置用例的轮级状态串进本用例
  const longApi = { ...api, conversationId: "conv-long" } as never;
  const long = "啊".repeat(201);
  await assert.rejects(
    () => say.execute({ text: long } as never, longApi, ctx),
    /voice_too_long|太长/,
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

/** 构造带占位长度（0x7FFFFFFF）的流式 WAV 缓冲，复现 Qwen-Audio-TTS 真实响应。 */
function makeStreamingWav(pcmLen: number, sampleRate = 24000): Buffer {
  const header = Buffer.alloc(44);
  header.write("RIFF", 0, "ascii");
  header.writeUInt32LE(0x7fffffff, 4);
  header.write("WAVE", 8, "ascii");
  header.write("fmt ", 12, "ascii");
  header.writeUInt32LE(16, 16);
  header.writeUInt16LE(1, 20);
  header.writeUInt16LE(1, 22);
  header.writeUInt32LE(sampleRate, 24);
  header.writeUInt32LE(sampleRate * 2, 28);
  header.writeUInt16LE(2, 32);
  header.writeUInt16LE(16, 34);
  header.write("data", 36, "ascii");
  header.writeUInt32LE(0x7fffffff, 40);
  return Buffer.concat([header, Buffer.alloc(pcmLen, 0x11)]);
}

test("fixWavHeader 把流式占位长度重写为真实 PCM 字节数并保留 fmt 参数", () => {
  const raw = makeStreamingWav(4800, 24000);
  const fixed = fixWavHeader(raw);
  assert.equal(fixed.length, 44 + 4800);
  assert.equal(fixed.readUInt32LE(4), 36 + 4800);
  assert.equal(fixed.readUInt32LE(24), 24000);
  assert.equal(fixed.readUInt32LE(40), 4800);
});

test("Qwen 云端 TTS：SpeechSynthesizer 合成、修复 WAV 头、透传参数与 fail closed", async () => {
  const mediaRoot = mkdtempSync(join(tmpdir(), "yg-qwen-tts-"));
  const calls: { url: string; method: string; auth?: string; body?: Record<string, unknown> }[] = [];
  const originalFetch = globalThis.fetch;
  let synthAttempts = 0;

  globalThis.fetch = (async (input, init) => {
    const url = String(input);
    const headers = (init?.headers ?? {}) as Record<string, string>;
    const body = init?.body ? (JSON.parse(String(init.body)) as Record<string, unknown>) : undefined;
    calls.push({ url, method: init?.method ?? "GET", auth: headers["authorization"], body });

    if (url.endsWith("/SpeechSynthesizer")) {
      synthAttempts++;
      if ((body?.input as Record<string, unknown>)?.text === "触发500") {
        return new Response("boom", { status: 500 });
      }
      if ((body?.input as Record<string, unknown>)?.text === "内联base64") {
        return new Response(
          JSON.stringify({ output: { audio: { data: makeStreamingWav(2048).toString("base64") } } }),
          { status: 200 },
        );
      }
      return new Response(
        JSON.stringify({ output: { audio: { url: "https://oss.test/audio.wav" } } }),
        { status: 200 },
      );
    }
    if (url === "https://oss.test/audio.wav") {
      // 第一次返回空字节测试重试，之后返回带 0x7FFFFFFF 占位头的合法 WAV
      if (synthAttempts === 2) {
        return new Response(Buffer.alloc(100), { status: 200 });
      }
      return new Response(makeStreamingWav(4096), { status: 200 });
    }
    return new Response("not found", { status: 404 });
  }) as typeof fetch;

  const baseCfg: TtsConfig = {
    engine: "qwen-tts",
    url: "https://token-plan.cn-beijing.maas.aliyuncs.com/api/v1/services/audio/tts/SpeechSynthesizer",
    model: "qwen-audio-3.0-tts-plus",
    voice: "qwen-audio-3.0-tts-plus-elysia30s-demo",
    apiKey: "sk-sp-test-token",
    language: "zh",
    speed: 1.08,
  };

  try {
    // 1. 正常 URL 下载 + WAV 头修复 + 参数透传（无 instruction 时不发该字段）
    const res = await synthesizeToMedia(baseCfg, "欸嘿，早安呀！", mediaRoot);
    assert.ok(existsSync(join(mediaRoot, res.ref)), "音频应落盘");
    assert.equal(res.bytes.readUInt32LE(4), 36 + 4096, "RIFF 长度应已修复");
    assert.equal(res.bytes.readUInt32LE(40), 4096, "data 长度应已修复");
    assert.equal(calls[0]?.auth, "Bearer sk-sp-test-token");
    assert.deepEqual(calls[0]?.body, {
      model: "qwen-audio-3.0-tts-plus",
      input: {
        text: "欸嘿，早安呀！",
        voice: "qwen-audio-3.0-tts-plus-elysia30s-demo",
        format: "wav",
        sample_rate: 24000,
        language_hints: ["zh"],
        rate: 1.08,
      },
    });

    // 2. 空音频自动重试一次（第 2 次 synth 返回 100B，第 3 次成功）
    const retryRes = await synthesizeToMedia(baseCfg, "重试测试", mediaRoot);
    assert.equal(retryRes.bytes.length, 44 + 4096);
    assert.equal(synthAttempts, 3);

    // 3. 支持内联 base64 data 且透传 instruction
    const b64Res = await synthesizeToMedia({ ...baseCfg, instruction: "轻柔带笑意" }, "内联base64", mediaRoot);
    assert.equal(b64Res.bytes.length, 44 + 2048);
    assert.equal((calls.at(-1)?.body?.input as Record<string, unknown>)?.instruction, "轻柔带笑意");

    // 4. fail closed：缺 key / 缺 model / HTTP 500
    await assert.rejects(() => synthesizeToMedia({ ...baseCfg, apiKey: "" }, "缺key", mediaRoot), /tts_api_key_missing/);
    await assert.rejects(() => synthesizeToMedia({ ...baseCfg, model: "" }, "缺model", mediaRoot), /tts_profile_incomplete/);
    await assert.rejects(() => synthesizeToMedia(baseCfg, "触发500", mediaRoot), /tts_http_500/);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("fish.config voices 校验：支持 qwen-tts 与 gpt-sovits，禁止写入 apiKey", () => {
  const dir = mkdtempSync(join(tmpdir(), "yg-voice-cfg-"));
  const cfgPath = join(dir, "fish.config.json");

  // 合法的 qwen-tts 与 gpt-sovits 并存
  writeFileSync(cfgPath, JSON.stringify({
    voices: {
      爱莉希雅: {
        engine: "qwen-tts",
        url: "https://token-plan.cn-beijing.maas.aliyuncs.com/api/v1/services/audio/tts/SpeechSynthesizer",
        model: "qwen-audio-3.0-tts-plus",
        voice: "qwen-audio-3.0-tts-plus-elysia30s-demo",
        provider: "qwen-token-plan-cn",
        language: "zh",
        speed: 1.08,
      },
      凯尔希: {
        url: "http://host.docker.internal:9884",
        gptModel: "/a.ckpt",
        sovitsModel: "/a.pth",
        referWav: "/a.wav",
        referText: "原话",
        speed: 0.9,
      },
    },
  }));
  const ok = loadFishConfig({ path: cfgPath });
  assert.deepEqual(ok.problems, []);
  assert.equal(ok.config.voices["爱莉希雅"]?.engine, "qwen-tts");
  assert.equal(ok.config.voices["爱莉希雅"]?.speed, 1.08);
  assert.equal(ok.config.voices["凯尔希"]?.url, "http://host.docker.internal:9884");

  // 拒绝把 apiKey 写入 fish.config.json
  writeFileSync(cfgPath, JSON.stringify({
    voices: {
      爱莉希雅: {
        engine: "qwen-tts",
        url: "https://token-plan.cn-beijing.maas.aliyuncs.com/api/v1/services/audio/tts/SpeechSynthesizer",
        model: "qwen-audio-3.0-tts-plus",
        voice: "v1",
        apiKey: "sk-leak",
      },
    },
  }));
  const leak = loadFishConfig({ path: cfgPath });
  assert.equal(Object.keys(leak.config.voices).length, 0);
  assert.match(leak.problems.join(" "), /apiKey/);

  // 缺 voice / 非法 engine 整块 fail closed
  writeFileSync(cfgPath, JSON.stringify({
    voices: {
      爱莉希雅: {
        engine: "qwen-tts",
        url: "https://token-plan.cn-beijing.maas.aliyuncs.com/api/v1/services/audio/tts/SpeechSynthesizer",
        model: "qwen-audio-3.0-tts-plus",
      },
    },
  }));
  const missing = loadFishConfig({ path: cfgPath });
  assert.equal(Object.keys(missing.config.voices).length, 0);
  assert.match(missing.problems.join(" "), /voice 缺失/);
});
