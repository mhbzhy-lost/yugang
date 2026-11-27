/**
 * draw_remote 工具包（异步远程生图）的工具级测试。
 *
 * 覆盖：
 *  - 即时受理返回 draw_remote_accepted（含通道名、引导 say_words、劝阻 say_media），绝不调 onLongWork；
 *  - 后台成功经 deliverDrawRemote 机械直发，且受理时快照的 trigger 引用锚点不受原轮清理 triggerOf 影响；
 *  - 每群同时最多 1 个在途（按 chatKeyOf 归群，同群不同人格共享槽位），不同群可并发；
 *  - 单轮最多提交 1 次（即使上一张瞬间完成，同轮仍报 draw_remote_used）；
 *  - 同步预检（总开关 / 停机态 / 缺 deliverDrawRemote / prompt / 参考图安全围栏 / models.json & auth.json 真预检）
 *    失败立即抛错给模型，不占槽、不锁轮；
 *  - 后台失败（4xx/5xx/超时/空结果/deliver 抛错/onSubmitted 热关闭）静默只打已脱敏日志、不发群消息、释放槽位；
 *  - 停机信号 drawRemoteSignal 中止与整体硬超时（660s）不漏投递、不永久占槽。
 */
import test, { after } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { LiveDoc } from "@earendil-works/pi-durable";
import { DRAW_REMOTE_DEFAULTS, type DrawRemoteConfig, type DrawRemoteProvider } from "../src/fish-config.ts";
import {
  DRAW_REMOTE_TIMEOUT_MS,
  DrawRemoteError,
  validateDrawRemoteInput,
  type DrawRemoteRunRequest,
} from "../src/media/draw-remote/index.ts";
import { loadPrompts } from "../src/prompt/index.ts";
import { loadToolManifests } from "../src/tools/manifest.ts";
import { mergeToolMessages } from "../src/tools/loader.ts";
import type { OutboundPayload } from "../src/tools/say-shared.ts";
import type { RoundTrigger, ToolPackageDeps } from "../src/tools/types.ts";
import { createDrawRemoteTool } from "../src/tools/draw_remote/tool.ts";

const ROOT = fileURLToPath(new URL("..", import.meta.url));
const prompts = loadPrompts(join(ROOT, "prompt"));
const manifests = loadToolManifests(fileURLToPath(new URL("../src/tools/", import.meta.url)), { memeTags: prompts.memeTags });
mergeToolMessages(manifests, prompts.messages);
const manifest = manifests.get("draw_remote")!;

const PNG_MAGIC = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
const JPEG_MAGIC = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46, 0x49, 0x46]);
const GIF_MAGIC = Buffer.from("GIF89a");
const MiB = 1024 * 1024;
const png = (bytes: number) => Buffer.concat([PNG_MAGIC, Buffer.alloc(Math.max(0, bytes - PNG_MAGIC.length), 7)]);
const jpeg = (bytes: number) => Buffer.concat([JPEG_MAGIC, Buffer.alloc(Math.max(0, bytes - JPEG_MAGIC.length), 1)]);
const gif = (bytes: number) => Buffer.concat([GIF_MAGIC, Buffer.alloc(Math.max(0, bytes - GIF_MAGIC.length), 1)]);

const work: string[] = [];
after(() => {
  for (const dir of work) rmSync(dir, { recursive: true, force: true });
});

let seq = 0;

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

type SettledEvent = { conversationId: string; status: "ok" | "failed" | "aborted"; files?: string[]; error?: unknown };

interface Fixture {
  tool: ReturnType<typeof createDrawRemoteTool>;
  mediaRoot: string;
  inbound: string;
  delivered: Array<{ conversationId: string; payloads: OutboundPayload[] }>;
  outbox: OutboundPayload[];
  longWorks: Array<[string, unknown]>;
  calls: DrawRemoteRunRequest[];
  settled: SettledEvent[];
  conv: string;
  setConfig: (next: Partial<Omit<DrawRemoteConfig, "models">> & { models?: DrawRemoteConfig["models"] }) => void;
  setTrigger: (next: RoundTrigger | undefined) => void;
  behave: (next: (request: DrawRemoteRunRequest) => Promise<{ files: string[] }>) => void;
  setDeliver: (next: (conversationId: string, payloads: readonly OutboundPayload[]) => Promise<void>) => void;
  waitSettled: (count?: number) => Promise<SettledEvent[]>;
  api: (round?: unknown, convId?: string) => never;
}

function setup(extraDeps: Partial<ToolPackageDeps> = {}, opts: { useRealPreflight?: boolean } = {}): Fixture {
  const mediaRoot = mkdtempSync(join(tmpdir(), "yg-draw-remote-"));
  work.push(mediaRoot);
  const inbound = join(mediaRoot, "inbound");
  mkdirSync(inbound);
  writeFileSync(join(inbound, "a.png"), png(64));
  writeFileSync(join(inbound, "b.png"), png(64));
  writeFileSync(join(inbound, "p.jpg"), jpeg(58));
  writeFileSync(join(inbound, "anim.gif"), gif(39));

  let config: DrawRemoteConfig = DRAW_REMOTE_DEFAULTS;
  let currentTrigger: RoundTrigger | undefined = { messageId: 5001, mentionsBot: true, userId: 10001 };
  let behaviour: (request: DrawRemoteRunRequest) => Promise<{ files: string[] }> = async (request) => {
    request.onSubmitted?.();
    return { files: ["1-test.png"] };
  };
  const calls: DrawRemoteRunRequest[] = [];
  const longWorks: Array<[string, unknown]> = [];
  const delivered: Array<{ conversationId: string; payloads: OutboundPayload[] }> = [];
  const outbox: OutboundPayload[] = [];
  const settled: SettledEvent[] = [];
  const waiters: Array<{ target: number; resolve: (events: SettledEvent[]) => void }> = [];

  let deliverImpl: (conversationId: string, payloads: readonly OutboundPayload[]) => Promise<void> = async (conversationId, payloads) => {
    const copy = payloads.map((p) => ({ ...p }));
    delivered.push({ conversationId, payloads: copy });
    outbox.push(...copy);
  };

  const conv = `conv-draw-remote-${++seq}`;
  const externalSettled = extraDeps.onDrawRemoteSettled;

  const deps: ToolPackageDeps = {
    prompts,
    mediaRoot,
    drawRemote: () => config,
    drawRemoteRun: async (request) => {
      calls.push(request);
      const outcome = await behaviour(request);
      return { provider: request.provider, model: request.model, files: outcome.files };
    },
    ...(opts.useRealPreflight
      ? {}
      : {
          drawRemotePreflight: (req) => validateDrawRemoteInput(req.provider, req.prompt, req.imagesCount),
        }),
    deliverDrawRemote: async (conversationId, payloads) => {
      await deliverImpl(String(conversationId), payloads);
    },
    onLongWork: (tool, round) => {
      longWorks.push([tool, round]);
    },
    triggerOf: () => currentTrigger,
    modelsPath: join(mediaRoot, "models.json"),
    ...extraDeps,
    onDrawRemoteSettled: (event) => {
      settled.push(event);
      for (let i = waiters.length - 1; i >= 0; i--) {
        if (settled.length >= waiters[i]!.target) {
          waiters.splice(i, 1)[0]!.resolve([...settled]);
        }
      }
      externalSettled?.(event);
    },
  };

  const tool = createDrawRemoteTool(manifest, deps);
  return {
    tool,
    mediaRoot,
    inbound,
    delivered,
    outbox,
    longWorks,
    calls,
    settled,
    conv,
    setConfig: (next) => {
      config = {
        enabled: next.enabled ?? config.enabled,
        provider: next.provider ?? config.provider,
        models: next.models ?? config.models,
      };
    },
    setTrigger: (next) => {
      currentTrigger = next;
    },
    behave: (next) => {
      behaviour = next;
    },
    setDeliver: (next) => {
      deliverImpl = next;
    },
    waitSettled: (count = settled.length + 1) => {
      if (settled.length >= count) return Promise.resolve([...settled]);
      return new Promise<SettledEvent[]>((resolve) => {
        waiters.push({ target: count, resolve });
      });
    },
    api: (round: unknown = 1, convId: string = conv) => ({
      conversationId: convId,
      callId: `call-${++seq}`,
      snapshot: async (doc: unknown) => (doc === LiveDoc && round !== null ? { run: { inputs: [round] } } : undefined),
      commit: async () => {
        throw new Error("异步 draw_remote 不得复用工具 api.commit");
      },
    }) as never,
  };
}

const ctx = (signal?: AbortSignal) => (signal ? { abortSignal: signal } : {}) as never;

function text(result: unknown): string {
  const output = (result as { output?: Array<{ type: string; text?: string }> })?.output ?? [];
  return output.map((item) => item.text ?? "").join("");
}

async function rejection(fn: () => Promise<unknown>): Promise<string> {
  try {
    await fn();
  } catch (error) {
    return error instanceof Error ? error.message : String(error);
  }
  assert.fail("期望抛错但成功返回了");
}

test("异步受理与后台直发：立即返回 accepted、不调 onLongWork、清空 triggerOf 后仍保留引用锚点并释放槽位", async () => {
  const fixture = setup();
  const gate = deferred<{ files: string[] }>();
  fixture.behave(async (request) => {
    request.onSubmitted?.();
    return gate.promise;
  });

  // execute 立刻返回，不等待后台生图完成
  const result = await fixture.tool.execute({ prompt: "画一只橘猫" } as never, fixture.api(77), ctx());
  const reply = text(result);
  assert.match(reply, /qwen/);
  assert.match(reply, /say_words/);
  assert.match(reply, /say_media/);
  assert.equal(fixture.longWorks.length, 0, "异步工具不再调用宿主 onLongWork 发机械稍等");
  assert.equal(fixture.outbox.length, 0, "返回瞬间图尚未画完");
  assert.equal(fixture.calls.length, 1);
  assert.equal(fixture.calls[0]?.timeoutMs, DRAW_REMOTE_TIMEOUT_MS);

  // 模拟原轮结束：宿主清理 triggerOf Map（Review Focus #1）
  fixture.setTrigger(undefined);

  // 后台完成返回两张图
  const settledPromise = fixture.waitSettled(1);
  gate.resolve({ files: ["111-a.png", "222-b.png"] });
  const events = await settledPromise;
  assert.equal(events[0]?.status, "ok");
  assert.deepEqual(events[0]?.files, ["111-a.png", "222-b.png"]);
  assert.equal(fixture.delivered.length, 1);
  assert.equal(fixture.delivered[0]?.conversationId, fixture.conv);
  assert.deepEqual(
    fixture.outbox.map(({ at: _at, ...rest }) => rest),
    [
      { media: "gen/111-a.png", key: `${fixture.conv}:draw_remote:77:111-a.png`, items: [], quote: false, quoteId: 5001, quoteForce: true },
      { media: "gen/222-b.png", key: `${fixture.conv}:draw_remote:77:222-b.png`, items: [], quote: false, quoteId: 5001, quoteForce: true },
    ],
  );

  // 槽位已释放，下一轮可正常受理
  fixture.behave(async (request) => {
    request.onSubmitted?.();
    return { files: ["333-c.png"] };
  });
  const nextSettled = fixture.waitSettled(2);
  await fixture.tool.execute({ prompt: "再画一只" } as never, fixture.api(78), ctx());
  await nextSettled;
  assert.equal(fixture.outbox.length, 3);
});

test("每群单飞 + 跨群真并发 + 同群不同人格共享槽位（S7）+ 单轮最多 1 次", async () => {
  const chatMap = new Map<string, string>([
    ["conv-g1-a", "qq:group:1"],
    ["conv-g1-b", "qq:group:1"],
    ["conv-g2-a", "qq:group:2"],
  ]);
  const fixture = setup({ chatKeyOf: (id) => chatMap.get(id) });
  const g1Gate = deferred<{ files: string[] }>();
  const g2Gate = deferred<{ files: string[] }>();
  let callIndex = 0;
  fixture.behave(async (request) => {
    request.onSubmitted?.();
    return ++callIndex === 1 ? g1Gate.promise : g2Gate.promise;
  });

  // 群 1 人格 A 受理
  await fixture.tool.execute({ prompt: "群1第一张" } as never, fixture.api(1, "conv-g1-a"), ctx());
  // 群 1 新轮次仍被在途挡住
  assert.match(await rejection(() => fixture.tool.execute({ prompt: "群1第二张" } as never, fixture.api(2, "conv-g1-a"), ctx())), /正在画/);
  // 群 1 切到人格 B 仍共享同一群槽位，被挡住（S7）
  assert.match(await rejection(() => fixture.tool.execute({ prompt: "群1人格B" } as never, fixture.api(1, "conv-g1-b"), ctx())), /正在画/);
  assert.equal(fixture.calls.length, 1);

  // 群 2 独立并发不受群 1 阻塞
  await fixture.tool.execute({ prompt: "群2第一张" } as never, fixture.api(1, "conv-g2-a"), ctx());
  assert.equal(fixture.calls.length, 2);

  // 群 1 画完释放槽位后，同一轮（round=1）仍受单轮限制报 draw_remote_used，新轮（round=2）放行
  const done1 = fixture.waitSettled(1);
  g1Gate.resolve({ files: ["g1.png"] });
  await done1;
  assert.match(await rejection(() => fixture.tool.execute({ prompt: "同轮再来" } as never, fixture.api(1, "conv-g1-a"), ctx())), /这轮已经提交过/);

  const done2 = fixture.waitSettled(2);
  g2Gate.resolve({ files: ["g2.png"] });
  await done2;
});

test("同步预检与开关围栏：总开关关闭 / 缺 deliverDrawRemote / 停机信号已中止 / 缺轮次 / 真预检缺配置 均同步拒绝且不占槽", async () => {
  // 1. 总开关关闭
  const disabled = setup();
  disabled.setConfig({ enabled: false });
  assert.match(await rejection(() => disabled.tool.execute({ prompt: "猫" } as never, disabled.api(1), ctx())), /已被主人关闭/);
  assert.equal(disabled.calls.length, 0);
  // 重新打开同轮可直接受理
  disabled.setConfig({ enabled: true });
  const s1 = disabled.waitSettled(1);
  await disabled.tool.execute({ prompt: "猫" } as never, disabled.api(1), ctx());
  await s1;
  assert.equal(disabled.calls.length, 1);

  // 2. 未注入 deliverDrawRemote：同步报 unconfigured，绝不谎报 accepted（S2）
  const noDeliver = setup({ deliverDrawRemote: undefined });
  assert.match(await rejection(() => noDeliver.tool.execute({ prompt: "猫" } as never, noDeliver.api(1), ctx())), /还没配置好/);
  assert.equal(noDeliver.calls.length, 0);

  // 3. drawRemoteSignal 已 aborted：同步拒（S2）
  const stopped = new AbortController();
  stopped.abort();
  const stopping = setup({ drawRemoteSignal: stopped.signal });
  assert.match(await rejection(() => stopping.tool.execute({ prompt: "猫" } as never, stopping.api(1), ctx())), /暂时用不了/);
  assert.equal(stopping.calls.length, 0);

  // 4. 缺轮次
  const noRound = setup();
  assert.match(await rejection(() => noRound.tool.execute({ prompt: "猫" } as never, noRound.api(null), ctx())), /无法确认当前轮次/);

  // 5. 空 prompt / 超 4000 字
  const badPrompt = setup();
  assert.match(await rejection(() => badPrompt.tool.execute({ prompt: "   " } as never, badPrompt.api(1), ctx())), /画面描述不合适/);
  assert.match(await rejection(() => badPrompt.tool.execute({ prompt: "a".repeat(4001) } as never, badPrompt.api(1), ctx())), /画面描述不合适/);
  assert.equal(badPrompt.calls.length, 0);

  // 6. C1 回归：生产总是传入 drawRemoteRun，未覆盖 drawRemotePreflight 时必须真正走 preflightDrawRemote
  const realPreflight = setup({}, { useRealPreflight: true });
  // modelsPath 不存在 → 同步抛 unconfigured
  assert.match(
    await rejection(() => realPreflight.tool.execute({ prompt: "画只猫" } as never, realPreflight.api(1), ctx())),
    /还没配置好.*models\.json/,
  );
  assert.equal(realPreflight.calls.length, 0);
  // 补齐 models.json 与 auth.json 后同轮可受理
  writeFileSync(join(realPreflight.mediaRoot, "models.json"), JSON.stringify({
    providers: { "qwen-token-plan-cn": { baseUrl: "https://dashscope.test/compatible-mode/v1" } },
  }));
  writeFileSync(join(realPreflight.mediaRoot, "auth.json"), JSON.stringify({ "qwen-token-plan-cn": "sk-real-preflight" }));
  const doneReal = realPreflight.waitSettled(1);
  await realPreflight.tool.execute({ prompt: "画只猫" } as never, realPreflight.api(1), ctx());
  await doneReal;
  assert.equal(realPreflight.calls.length, 1);
});

test("后台失败静默只打已脱敏日志、绝不往群里发失败提示、释放槽位且 settle 只调一次（S4/S5/Review Focus #3）", async () => {
  const logs: unknown[][] = [];
  const origError = console.error;
  console.error = (...args: unknown[]) => logs.push(args);
  try {
    let settleThrows = true;
    const fixture = setup({
      onDrawRemoteSettled: () => {
        if (settleThrows) {
          settleThrows = false;
          throw new Error("observer boom");
        }
      },
    });

    // 1. 后台抛带未脱敏 cause 的 DrawRemoteError：不投递任何消息、不打印 cause 对象里的秘密、observer 抛错也不二次触发
    const rawCause = new Error("UPSTREAM_SECRET_TOKEN_XYZ_999");
    fixture.behave(async (request) => {
      request.onSubmitted?.();
      throw new DrawRemoteError("qwen", "failed", "qwen 生图超时（600 秒，阶段：post），结果不明", true, { cause: rawCause });
    });
    const s1 = fixture.waitSettled(1);
    await fixture.tool.execute({ prompt: "猫" } as never, fixture.api(1), ctx());
    const ev1 = await s1;
    assert.equal(ev1.length, 1);
    assert.equal(ev1[0]?.status, "failed");
    assert.equal(fixture.outbox.length, 0, "后台失败绝不往群里发提示");
    assert.ok(logs.length >= 1);
    const joined = logs.map((row) => row.map(String).join(" ")).join("\n");
    assert.match(joined, /600 秒/);
    assert.doesNotMatch(joined, /UPSTREAM_SECRET_TOKEN_XYZ_999/, "日志绝不打印未脱敏 cause 内容");

    // 2. 后台 onSubmitted 瞬间发现热关闭（Review Focus #3）：释放槽位、不发消息
    const gate = deferred<void>();
    fixture.behave(async (request) => {
      await gate.promise;
      request.onSubmitted?.();
      return { files: ["never.png"] };
    });
    const s2 = fixture.waitSettled(2);
    await fixture.tool.execute({ prompt: "狗" } as never, fixture.api(2), ctx());
    fixture.setConfig({ enabled: false });
    gate.resolve();
    await s2;
    assert.equal(fixture.outbox.length, 0);

    // 3. 重新打开后新轮次正常受理，deliverDrawRemote 抛错也静默释放槽位
    fixture.setConfig({ enabled: true });
    fixture.behave(async (request) => {
      request.onSubmitted?.();
      return { files: ["fail-deliver.png"] };
    });
    fixture.setDeliver(async () => {
      throw new Error("outbox write error");
    });
    const s3 = fixture.waitSettled(3);
    await fixture.tool.execute({ prompt: "鸟" } as never, fixture.api(3), ctx());
    await s3;
    assert.equal(fixture.settled[2]?.status, "failed");

    // 4. 空 files 同样按静默失败释放槽位
    fixture.setDeliver(async (_convId, payloads) => {
      fixture.outbox.push(...payloads);
    });
    fixture.behave(async (request) => {
      request.onSubmitted?.();
      return { files: [] };
    });
    const s4 = fixture.waitSettled(4);
    await fixture.tool.execute({ prompt: "鱼" } as never, fixture.api(4), ctx());
    await s4;
    assert.equal(fixture.settled[3]?.status, "failed");
    assert.equal(fixture.outbox.length, 0);
  } finally {
    console.error = origError;
  }
});

test("停机取消信号与整体硬超时（C2 / Review Focus #2）：中止后即使晚到也不投递并释放槽位", async () => {
  // 1. 停机信号中止：即使桩无视 signal 晚到返回了图片，绝不调 deliverDrawRemote
  const stop = new AbortController();
  const late = deferred<{ files: string[] }>();
  const fixture = setup({ drawRemoteSignal: stop.signal });
  let seenSignal: AbortSignal | undefined;
  fixture.behave(async (request) => {
    seenSignal = request.signal;
    request.onSubmitted?.();
    return late.promise;
  });
  const s1 = fixture.waitSettled(1);
  await fixture.tool.execute({ prompt: "停机测试" } as never, fixture.api(1), ctx());
  stop.abort();
  assert.equal(seenSignal?.aborted, true, "停机信号应立即传播到后台运行信号");
  late.resolve({ files: ["too-late.png"] });
  await s1;
  assert.equal(fixture.settled[0]?.status, "aborted");
  assert.equal(fixture.outbox.length, 0, "停机后晚到的图绝不投递");

  // 2. 后台整体硬超时（覆盖 POST 前的 refreshTokens 等挂死，C2）
  const hung = setup({ drawRemoteJobTimeoutMs: 40 });
  hung.behave(async (request) => new Promise((_resolve, reject) => {
    request.signal?.addEventListener("abort", () => reject(request.signal?.reason ?? new DOMException("aborted", "AbortError")), { once: true });
  }));
  const s2 = hung.waitSettled(1);
  await hung.tool.execute({ prompt: "前置刷新挂死" } as never, hung.api(1), ctx());
  await s2;
  assert.equal(hung.settled[0]?.status, "failed");
  assert.equal(hung.outbox.length, 0);
  // 槽位已释放，下一轮可恢复
  hung.behave(async (request) => {
    request.onSubmitted?.();
    return { files: ["recovered.png"] };
  });
  const s3 = hung.waitSettled(2);
  await hung.tool.execute({ prompt: "恢复" } as never, hung.api(2), ctx());
  await s3;
  assert.equal(hung.outbox.length, 1);
});

test("热切配置：通道与模型随 fish.config.json 现值切换，不传比例不透传 aspectRatio", async () => {
  const fixture = setup();
  const s1 = fixture.waitSettled(1);
  await fixture.tool.execute({ prompt: "第一张" } as never, fixture.api(1), ctx());
  await s1;
  assert.equal(fixture.calls[0]?.provider, "qwen");
  assert.equal(fixture.calls[0]?.model, "qwen-image-3.0-pro");
  assert.equal(fixture.calls[0]?.aspectRatio, undefined);

  fixture.setConfig({ provider: "gemini", models: { ...DRAW_REMOTE_DEFAULTS.models, gemini: "gemini-custom" } });
  const s2 = fixture.waitSettled(2);
  await fixture.tool.execute({ prompt: "第二张", aspect_ratio: "16:9" } as never, fixture.api(2), ctx());
  await s2;
  assert.equal(fixture.calls[1]?.provider, "gemini");
  assert.equal(fixture.calls[1]?.model, "gemini-custom");
  assert.equal(fixture.calls[1]?.aspectRatio, "16:9");
});

test("参考图：方括号兼容，按真实字节读图交给适配器", async () => {
  const fixture = setup();
  fixture.setConfig({ provider: "gpt" });
  const s1 = fixture.waitSettled(1);
  const result = await fixture.tool.execute(
    { prompt: "把这几张拼起来", images: ["[inbound/a.png]", " inbound/p.jpg ", "[inbound/anim.gif]"] } as never,
    fixture.api(),
    ctx(),
  );
  assert.match(text(result), /已交给在线画师/);
  await s1;
  const images = fixture.calls[0]?.images ?? [];
  assert.equal(images.length, 3);
  assert.deepEqual(
    images.map((image) => ({ mimeType: image.mimeType, length: image.bytes.length })),
    [
      { mimeType: "image/png", length: 64 },
      { mimeType: "image/jpeg", length: 58 },
      { mimeType: "image/gif", length: 39 },
    ],
  );
  assert.ok(png(64).equals(images[0]!.bytes), "字节原样（不经任何转码）");
});

test("参考图围栏：穿越 / 绝对路径 / 符号链接 / 非图 / 魔数不符 / 0 字节 / 超限 / 超出通道张数上限 一律 bad_ref", async () => {
  const fixture = setup();
  const outside = mkdtempSync(join(tmpdir(), "yg-draw-remote-outside-"));
  work.push(outside);
  writeFileSync(join(outside, "secret.png"), png(64));
  symlinkSync(join(outside, "secret.png"), join(fixture.inbound, "link-out.png"));
  symlinkSync(join(fixture.inbound, "a.png"), join(fixture.inbound, "link-in.png"));
  writeFileSync(join(fixture.inbound, "note.txt"), "不是图片");
  writeFileSync(join(fixture.inbound, "fake.png"), jpeg(40));
  writeFileSync(join(fixture.inbound, "empty.png"), Buffer.alloc(0));
  writeFileSync(join(fixture.inbound, "big.png"), png(10 * MiB + 1));

  const bad: Array<[string, string[]]> = [
    ["../ 穿越", ["../etc/passwd"]],
    ["绝对路径", [join(outside, "secret.png")]],
    ["目录本身", ["inbound"]],
    ["不存在的文件", ["inbound/missing.png"]],
    ["指向目录外的符号链接", ["inbound/link-out.png"]],
    ["指向目录内的符号链接", ["inbound/link-in.png"]],
    ["非图片", ["inbound/note.txt"]],
    ["魔数与后缀不符", ["inbound/fake.png"]],
    ["0 字节", ["inbound/empty.png"]],
    ["单张超过 10MiB", ["inbound/big.png"]],
    ["超出通道张数上限（6 张）", ["inbound/a.png", "inbound/a.png", "inbound/a.png", "inbound/a.png", "inbound/a.png", "inbound/a.png"]],
    ["好图夹带一张坏图整批拒", ["inbound/a.png", "inbound/fake.png"]],
    ["空字符串", ["   "]],
  ];
  for (const [name, images] of bad) {
    const rejected = await rejection(() => fixture.tool.execute({ prompt: "改这张", images } as never, fixture.api(), ctx()));
    assert.match(rejected, /用不了/, name);
  }
  assert.equal(fixture.calls.length, 0);
  assert.equal(fixture.outbox.length, 0);

  // 拒绝之后同一轮仍可修正重试
  const done = fixture.waitSettled(1);
  assert.match(text(await fixture.tool.execute({ prompt: "改这张", images: ["[inbound/a.png]"] } as never, fixture.api(), ctx())), /已交给在线画师/);
  await done;
});

test("bad_ref 回执点名具体是哪张图（去掉方括号后的原路径）", async () => {
  const fixture = setup();
  writeFileSync(join(fixture.inbound, "fake.png"), jpeg(40));
  const mismatch = await rejection(() => fixture.tool.execute({ prompt: "改这张", images: ["[inbound/fake.png]"] } as never, fixture.api(), ctx()));
  assert.match(mismatch, /inbound\/fake\.png.*用不了/);
  assert.doesNotMatch(mismatch, /\[/);
  const missing = await rejection(() => fixture.tool.execute({ prompt: "改这张", images: ["inbound/gone.png"] } as never, fixture.api(), ctx()));
  assert.match(missing, /inbound\/gone\.png.*用不了/);
});

test("gemini 通道的参考图能力：gif 与聚合超过 15MiB 拒掉；同样输入在 gpt 通道放行", async () => {
  const fixture = setup();
  writeFileSync(join(fixture.inbound, "m8-a.png"), png(8 * MiB));
  writeFileSync(join(fixture.inbound, "m8-b.png"), png(8 * MiB));

  fixture.setConfig({ provider: "gemini" });
  const gifRejected = await rejection(() =>
    fixture.tool.execute({ prompt: "参考这张", images: ["inbound/anim.gif"] } as never, fixture.api(), ctx()),
  );
  assert.match(gifRejected, /inbound\/anim\.gif.*用不了/);
  const totalRejected = await rejection(() =>
    fixture.tool.execute({ prompt: "拼起来", images: ["inbound/m8-a.png", "inbound/m8-b.png"] } as never, fixture.api(2), ctx()),
  );
  assert.match(totalRejected, /inbound\/m8-b\.png.*用不了/);
  assert.equal(fixture.calls.length, 0);

  fixture.setConfig({ provider: "gpt" });
  const s1 = fixture.waitSettled(1);
  await fixture.tool.execute({ prompt: "参考这张", images: ["inbound/anim.gif"] } as never, fixture.api(3), ctx());
  await s1;
  assert.equal(fixture.calls[0]?.images?.[0]?.mimeType, "image/gif");

  const s2 = fixture.waitSettled(2);
  await fixture.tool.execute({ prompt: "拼起来", images: ["inbound/m8-a.png", "inbound/m8-b.png"] } as never, fixture.api(4), ctx());
  await s2;
  assert.equal(fixture.calls[1]?.images?.length, 2);
});

test("参考图张数与类型按通道：qwen 最多 3 张且认 gif，gpt/wan/gemini 最多 5 张且 wan/gemini 不认 gif", async () => {
  for (const [provider, limit] of [
    ["qwen", 3],
    ["gpt", 5],
    ["wan", 5],
    ["gemini", 5],
  ] as const) {
    const fixture = setup();
    fixture.setConfig({ provider: provider as DrawRemoteProvider });
    writeFileSync(join(fixture.inbound, "c.png"), png(64));
    writeFileSync(join(fixture.inbound, "d.png"), png(64));
    writeFileSync(join(fixture.inbound, "e.png"), png(64));
    const refs = ["inbound/a.png", "inbound/b.png", "inbound/p.jpg", "inbound/c.png", "inbound/d.png", "inbound/e.png"];

    const s1 = fixture.waitSettled(1);
    const accepted = await fixture.tool.execute({ prompt: "拼起来", images: refs.slice(0, limit) } as never, fixture.api(1), ctx());
    assert.match(text(accepted), /已交给在线画师/, `${provider}：恰好 ${limit} 张放行`);
    await s1;
    assert.equal(fixture.calls[0]?.images?.length, limit);

    const over = refs[limit]!;
    const rejected = await rejection(() =>
      fixture.tool.execute({ prompt: "拼起来", images: refs.slice(0, limit + 1) } as never, fixture.api(2), ctx()),
    );
    assert.match(rejected, new RegExp(`${over.replaceAll(".", "\\.")}.*用不了`), `${provider}：第 ${limit + 1} 张起拒`);
    assert.match(rejected, provider === "qwen" ? /qwen 通道最多 3 张/ : /最多 5 张（qwen 通道最多 3 张）/, provider);
    assert.equal(fixture.calls.length, 1);
  }

  for (const provider of ["wan", "gemini"] as const) {
    const fixture = setup();
    fixture.setConfig({ provider });
    assert.match(
      await rejection(() => fixture.tool.execute({ prompt: "参考这张", images: ["inbound/anim.gif"] } as never, fixture.api(), ctx())),
      /inbound\/anim\.gif.*用不了/,
    );
  }
  for (const provider of ["gpt", "qwen"] as const) {
    const fixture = setup();
    fixture.setConfig({ provider });
    const done = fixture.waitSettled(1);
    await fixture.tool.execute({ prompt: "参考这张", images: ["inbound/anim.gif"] } as never, fixture.api(), ctx());
    await done;
    assert.equal(fixture.calls[0]?.images?.[0]?.mimeType, "image/gif");
  }
});

test("文案与 TOOL.md 契约：异步受理文案含通道名/say_words/say_media，移除旧同步死文案", () => {
  const messages = manifest.messages;
  for (const key of Object.keys(messages)) assert.match(key, /^draw_remote_[a-z0-9_]*$/);
  assert.match(messages["draw_remote_accepted"] ?? "", /\{\{provider\}\}/);
  assert.match(messages["draw_remote_accepted"] ?? "", /say_words/);
  assert.match(messages["draw_remote_accepted"] ?? "", /say_media/);
  for (const key of [
    "draw_remote_disabled",
    "draw_remote_round_missing",
    "draw_remote_inflight",
    "draw_remote_used",
    "draw_remote_prompt",
    "draw_remote_bad_ref",
    "draw_remote_unconfigured",
    "draw_remote_accepted",
  ]) {
    assert.ok(messages[key], `缺文案 ${key}`);
  }
  // 同步旧文案已退役，不留死文案
  for (const removed of [
    "draw_remote_done",
    "draw_remote_done_fallback",
    "draw_remote_failed",
    "draw_remote_failed_uncertain",
    "draw_remote_failed_internal",
    "draw_remote_uncertain",
    "draw_remote_no_ref",
  ]) {
    assert.equal(messages[removed], undefined, `不应残留旧同步文案 ${removed}`);
  }
  assert.match(messages["draw_remote_bad_ref"], /\{\{ref\}\}.*用不了/);
  assert.match(messages["draw_remote_bad_ref"], /最多 5 张（qwen 通道最多 3 张）/);

  const properties = manifest.parameters.properties as Record<string, Record<string, unknown>>;
  assert.deepEqual(manifest.parameters.required, ["prompt"]);
  assert.equal(properties["images"]?.["maxItems"], 5);
  assert.deepEqual(properties["aspect_ratio"]?.["enum"], ["1:1", "3:4", "4:3", "9:16", "16:9"]);
  assert.deepEqual(Object.keys(properties).sort(), ["aspect_ratio", "images", "prompt"]);
  assert.match(manifest.description, /GPT Image \/ Wan \/ Qwen \/ Gemini/);
  assert.match(manifest.guide, /异步|立刻返回|后台/);
  assert.match(manifest.guide, /say_words/);
  assert.match(manifest.guide, /say_media/);
  assert.match(manifest.guide, /drawRemote\.provider/);
});
