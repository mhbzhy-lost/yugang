/**
 * draw 工具面重构测试（Plan Task 4）：
 *  - 3 个内存夹具（fake_anima2b / fake_sdxl / fake_limited）覆盖热切、全序严格能力预检与 7 类拒绝；
 *  - 跨族角色 LoRA 自动降级纯 tag + ref+fast 叠加 + drawEnabled 双复核 + onLongWork 时序 + stageNodes 透传；
 *  - 取消围栏、outbox 机械直发与 fallback、Schema/文案/文档清理、runtime 宿主装配。
 */
import test, { after } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { LiveDoc } from "@earendil-works/pi-durable";
import { loadPrompts } from "../src/prompt/index.ts";
import { loadToolManifests, toolFullDescription } from "../src/tools/manifest.ts";
import { mergeToolMessages } from "../src/tools/loader.ts";
import { createDrawTool } from "../src/tools/draw/tool.ts";
import type { DrawBackend, DrawBuildRequest, DrawBuiltGraph, DrawRatio } from "../src/tools/draw/backends/types.ts";
import type { ExecOpts, Graph } from "../src/tools/draw/engine.ts";
import { OutboundEntry } from "../src/tools/say-shared.ts";
import { OutboxDoc } from "../src/store.ts";

const ROOT = fileURLToPath(new URL("..", import.meta.url));
const WORK = mkdtempSync(join(tmpdir(), "yg-draw-tool-"));

const PNG = Buffer.from([
  0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a,
  0x00, 0x00, 0x00, 0x0d, 0x49, 0x48, 0x44, 0x52,
  0x00, 0x00, 0x00, 0x01, 0x00, 0x00, 0x00, 0x01,
  0x08, 0x06, 0x00, 0x00, 0x00, 0x1f, 0x15, 0xc4,
  0x89, 0x00, 0x00, 0x00, 0x0a, 0x49, 0x44, 0x41,
  0x54, 0x78, 0x9c, 0x63, 0x00, 0x01, 0x00, 0x00,
  0x05, 0x00, 0x01, 0x0d, 0x0a, 0x2d, 0xb4, 0x00,
  0x00, 0x00, 0x00, 0x49, 0x45, 0x4e, 0x44, 0xae,
  0x42, 0x60, 0x82,
]);

after(() => rmSync(WORK, { recursive: true, force: true }));

function makeRatios(scale: number): Readonly<Record<DrawRatio, readonly [number, number]>> {
  return {
    "1:1": [512 * scale, 512 * scale],
    "3:4": [448 * scale, 576 * scale],
    "4:3": [576 * scale, 448 * scale],
    "2:3": [384 * scale, 576 * scale],
    "3:2": [576 * scale, 384 * scale],
    "9:16": [320 * scale, 576 * scale],
    "16:9": [576 * scale, 320 * scale],
  };
}

interface RecordedBuild {
  backendId: string;
  request: DrawBuildRequest;
}

interface RecordedExec {
  url: string;
  graph: Graph;
  opts: ExecOpts;
}

function makeFixtureBackends(builds: RecordedBuild[]): ReadonlyMap<string, DrawBackend> {
  const fakeAnima2b: DrawBackend = {
    id: "fake_anima2b",
    loraFamily: "anima",
    ratioSizes: makeRatios(1),
    capabilities: {
      modes: { single: true, fast: true, ref: false, multi: false },
      hd: false,
      styleModes: ["single", "fast"],
      framing: false,
      spacing: false,
    },
    validateStartup() {},
    buildGraph(request): DrawBuiltGraph {
      builds.push({ backendId: "fake_anima2b", request });
      return {
        graph: { "1": { class_type: "FakeAnima2B", inputs: {} } },
        outputNode: "21",
        outputType: "temp",
        deadline: 120_000,
        workingVariant: request.mode === "fast" ? "draw_fast" : "draw_interaction",
        stageNodes: ["20"],
      };
    },
  };

  const fakeSdxl: DrawBackend = {
    id: "fake_sdxl",
    loraFamily: "sdxl",
    ratioSizes: makeRatios(2),
    capabilities: {
      modes: { single: true, fast: true, ref: true, multi: true },
      hd: true,
      styleModes: ["single", "fast", "ref"],
      framing: true,
      spacing: true,
    },
    extraModelFileFields: { CustomSDXLLoader: ["ckpt"] },
    validateStartup() {},
    buildGraph(request): DrawBuiltGraph {
      builds.push({ backendId: "fake_sdxl", request });
      return {
        graph: { "1": { class_type: "FakeSDXL", inputs: {} } },
        outputNode: "99",
        outputType: "output",
        deadline: 300_000,
        workingVariant: request.fast ? "draw_fast" : request.mode === "ref" ? "draw" : "draw_interaction",
        stageNodes: ["50", "51"],
      };
    },
  };

  const fakeLimited: DrawBackend = {
    id: "fake_limited",
    loraFamily: "anima",
    ratioSizes: makeRatios(1),
    capabilities: {
      modes: { single: true, fast: false, ref: true, multi: true },
      hd: true,
      styleModes: ["fast", "ref"],
      framing: false,
      spacing: false,
    },
    validateStartup() {},
    buildGraph(request): DrawBuiltGraph {
      builds.push({ backendId: "fake_limited", request });
      return {
        graph: { "1": { class_type: "FakeLimited", inputs: {} } },
        outputNode: "12",
        outputType: "output",
        deadline: 180_000,
        workingVariant: "draw",
        stageNodes: undefined,
      };
    },
  };

  return new Map<string, DrawBackend>([
    [fakeAnima2b.id, fakeAnima2b],
    [fakeSdxl.id, fakeSdxl],
    [fakeLimited.id, fakeLimited],
  ]);
}

function createHarness(opts: {
  initialBackend?: string;
  initialEnabled?: boolean;
  failEnqueue?: boolean;
  execImpl?: (url: string, graph: Graph, execOpts: ExecOpts) => Promise<Buffer>;
} = {}) {
  const mediaRoot = mkdtempSync(join(WORK, "media-"));
  mkdirSync(join(mediaRoot, "inbound"), { recursive: true });
  writeFileSync(join(mediaRoot, "inbound", "ref.png"), PNG);

  const prompts = loadPrompts(join(ROOT, "prompt"));
  const manifests = loadToolManifests(join(ROOT, "src", "tools"), { memeTags: prompts.memeTags });
  mergeToolMessages(manifests, prompts.messages);

  let backendId = opts.initialBackend ?? "fake_anima2b";
  let enabled = opts.initialEnabled ?? true;
  const builds: RecordedBuild[] = [];
  const execCalls: RecordedExec[] = [];
  const uploadCalls: Array<{ url: string; ext: string }> = [];
  const longWorks: Array<{ variant: string; round: unknown }> = [];
  const stageEvents: Array<{ round: unknown; stage: string }> = [];
  const outbox: Array<Record<string, unknown>> = [];
  const outboundEntries: Array<Record<string, unknown>> = [];
  const backends = makeFixtureBackends(builds);

  const tool = createDrawTool(manifests.get("draw")!, {
    prompts,
    mediaRoot,
    comfyUrl: "http://127.0.0.1:18190/",
    drawEnabled: () => enabled,
    drawBackend: () => backendId,
    drawBackends: backends,
    drawUploadRef: async (url, _buf, ext) => {
      uploadCalls.push({ url, ext });
      return "yugang-ref-11111111-1111-1111-1111-111111111111.png";
    },
    drawExec: async (url, graph, execOpts) => {
      execCalls.push({ url, graph, opts: execOpts });
      if (opts.execImpl) return await opts.execImpl(url, graph, execOpts);
      execOpts.onSubmitted();
      return PNG;
    },
    onLongWork: (variant, round) => {
      longWorks.push({ variant, round });
    },
    onDrawStage: (round, stage) => {
      stageEvents.push({ round, stage });
    },
    triggerOf: (round) => ({ kind: "answer", mentionsBot: true, messageId: Number(String(round).replace(/\D/g, "")) || 101 }),
    react: () => {},
  });

  const apiFor = (conversationId: string, round: string | undefined) => ({
    conversationId,
    callId: "call_1",
    snapshot: async (doc: unknown) => (doc === LiveDoc ? { run: { inputs: round === undefined ? [] : [round] } } : undefined),
    commit: async (change: (tx: unknown) => Promise<void>) => {
      if (opts.failEnqueue) throw new Error("disk full");
      const box = { queue: outbox };
      const tx = {
        appendEntry: async (entry: unknown, _id: string, payload: { data: Record<string, unknown> }) => {
          if (entry === OutboundEntry) outboundEntries.push(payload.data);
        },
        doc: async (doc: unknown) => {
          assert.equal(doc, OutboxDoc);
          return box;
        },
      };
      await change(tx);
    },
  });

  const run = async (
    args: Record<string, unknown>,
    conv = "conv-default",
    round: string | undefined = "round-1",
    signal?: AbortSignal,
  ) => {
    const res = (await tool.execute(args as never, apiFor(conv, round) as never, { abortSignal: signal } as never)) as {
      output: Array<{ type: string; text: string }>;
    };
    return res.output.map((o) => o.text).join("\n");
  };

  const expectReject = async (
    args: Record<string, unknown>,
    conv: string,
    round: string | undefined = "round-1",
  ): Promise<string> => {
    try {
      await run(args, conv, round);
    } catch (err) {
      return err instanceof Error ? err.message : String(err);
    }
    return assert.fail(`应当拒绝：${JSON.stringify(args)}`);
  };

  return {
    mediaRoot,
    prompts,
    manifests,
    tool,
    builds,
    execCalls,
    uploadCalls,
    longWorks,
    stageEvents,
    outbox,
    outboundEntries,
    setBackend: (id: string) => { backendId = id; },
    setEnabled: (flag: boolean) => { enabled = flag; },
    run,
    expectReject,
  };
}

test("热切后端生效：同一 createDrawTool 实例切换 fake_anima2b → fake_sdxl 命中各自构图与参数", async () => {
  const h = createHarness({ initialBackend: "fake_anima2b" });
  const msg1 = await h.run({ prompt: "1girl, smile", ratio: "1:1" }, "conv-hot", "r1");
  assert.match(msg1, /^gen\/.*\.png/);
  assert.equal(h.builds.length, 1);
  assert.equal(h.builds[0]!.backendId, "fake_anima2b");
  assert.equal(h.builds[0]!.request.width, 512);
  assert.equal(h.builds[0]!.request.height, 512);
  assert.equal(h.execCalls[0]!.opts.outputNode, "21");
  assert.equal(h.execCalls[0]!.opts.outputType, "temp");
  assert.equal(h.execCalls[0]!.opts.deadline, 120_000);

  h.setBackend("fake_sdxl");
  const msg2 = await h.run({ prompt: "1girl, smile", ratio: "1:1" }, "conv-hot", "r2");
  assert.match(msg2, /^gen\/.*\.png/);
  assert.equal(h.builds.length, 2);
  assert.equal(h.builds[1]!.backendId, "fake_sdxl");
  assert.equal(h.builds[1]!.request.width, 1024);
  assert.equal(h.builds[1]!.request.height, 1024);
  assert.equal(h.execCalls[1]!.opts.outputNode, "99");
  assert.equal(h.execCalls[1]!.opts.outputType, "output");
  assert.equal(h.execCalls[1]!.opts.deadline, 300_000);
  assert.deepEqual(h.execCalls[1]!.opts.extraModelFileFields, { CustomSDXLLoader: ["ckpt"] });
});

test("全部 7 类严格能力预检：均在 onLongWork / onSubmitted 前拒绝、不锁轮、同轮改参可重试", async () => {
  const h = createHarness({ initialBackend: "missing_secret_backend" });

  // 1. 未知后端（文案不得泄露未知 ID）
  const unknownErr = await h.expectReject({ prompt: "scenery" }, "conv-r1", "r1");
  assert.equal(unknownErr, h.prompts.messages["draw_backend_unknown"]);
  assert.ok(!unknownErr.includes("missing_secret_backend"), "不得向模型暴露内部后端 ID");

  // 2. fake_anima2b 缺 multi / ref / hd
  h.setBackend("fake_anima2b");
  const multiErr = await h.expectReject({
    prompt: "cafe",
    characters: [{ description: "left girl" }, { description: "right girl" }],
  }, "conv-r1", "r1");
  assert.match(multiErr, /双人同框模式/);

  const refErr = await h.expectReject({ prompt: "redraw", ref: "inbound/ref.png" }, "conv-r1", "r1");
  assert.match(refErr, /改图模式/);

  const hdErr = await h.expectReject({ prompt: "1girl", hd: true }, "conv-r1", "r1");
  assert.equal(hdErr, h.prompts.messages["draw_hd_unsupported"]);

  // 3. fake_limited 缺 fast / ref+fast / single+style / framing / spacing
  h.setBackend("fake_limited");
  const fastErr = await h.expectReject({ prompt: "1girl", fast: true }, "conv-r1", "r1");
  assert.match(fastErr, /快速模式/);

  const refFastErr = await h.expectReject({ prompt: "redraw", ref: "inbound/ref.png", fast: true }, "conv-r1", "r1");
  assert.match(refFastErr, /快速模式/);

  const styleModeErr = await h.expectReject({ prompt: "1girl", style: "hsr" }, "conv-r1", "r1");
  assert.equal(styleModeErr, h.prompts.messages["draw_style_mode_unsupported"]);

  const framingErr = await h.expectReject({
    prompt: "park",
    characters: [{ description: "a" }, { description: "b" }],
    framing: "wide",
  }, "conv-r1", "r1");
  assert.equal(framingErr, h.prompts.messages["draw_composition_unsupported"]);

  const spacingErr = await h.expectReject({
    prompt: "park",
    characters: [{ description: "a" }, { description: "b" }],
    spacing: "apart",
  }, "conv-r1", "r1");
  assert.equal(spacingErr, h.prompts.messages["draw_composition_unsupported"]);

  // 4. fake_sdxl 跨族无画风 LoRA
  h.setBackend("fake_sdxl");
  const styleBackendErr = await h.expectReject({ prompt: "1girl", style: "hsr" }, "conv-r1", "r1");
  assert.match(styleBackendErr, /没有「hsr」对应的画风 LoRA/);

  // 上述全部拒绝均未触发 onLongWork 与 execGraph，且同轮未锁死可重试成功
  assert.equal(h.longWorks.length, 0);
  assert.equal(h.execCalls.length, 0);
  const ok = await h.run({ prompt: "1girl, smile" }, "conv-r1", "r1");
  assert.match(ok, /^gen\/.*\.png/);
  assert.equal(h.longWorks.length, 1);
});

test("跨模型族角色 LoRA 自动降级纯 tag，同族带 LoRA，ref + fast 正确叠加", async () => {
  const h = createHarness({ initialBackend: "fake_anima2b" });

  // fake_anima2b 传 character="claude" 与 style="hsr" → 均带真实 Anima LoRA
  await h.run({ prompt: "happy", character: "claude", style: "hsr", fast: true }, "conv-fam-1", "r1");
  const animaReq = h.builds[0]!.request;
  assert.equal(animaReq.mode, "fast");
  assert.equal(animaReq.fast, true);
  assert.ok(animaReq.role?.inject.length);
  assert.equal(animaReq.role?.lora?.file, "claude_girl_anima_lora_clean.safetensors");
  assert.equal(animaReq.style?.file, "HSR Anima.safetensors");

  // fake_sdxl 传 character="claude"（单人 & 双人）→ role.lora === undefined 且 inject 非空
  h.setBackend("fake_sdxl");
  await h.run({ prompt: "happy", character: "claude" }, "conv-fam-2", "r1");
  const sdxlSingle = h.builds[1]!.request;
  assert.equal(sdxlSingle.mode, "single");
  assert.ok(sdxlSingle.role?.inject.length);
  assert.equal(sdxlSingle.role?.lora, undefined);

  await h.run({
    prompt: "cafe",
    characters: [{ character: "claude", description: "sitting left" }, { description: "standing right" }],
  }, "conv-fam-3", "r1");
  const sdxlMulti = h.builds[2]!.request;
  assert.equal(sdxlMulti.mode, "multi");
  assert.ok(sdxlMulti.parts?.[0]?.role?.inject.length);
  assert.equal(sdxlMulti.parts?.[0]?.role?.lora, undefined);

  // fake_sdxl 传 ref + fast: true → mode === "ref" 且 fast === true
  await h.run({ prompt: "redraw", ref: "inbound/ref.png", fast: true }, "conv-fam-4", "r1");
  const sdxlRefFast = h.builds[3]!.request;
  assert.equal(sdxlRefFast.mode, "ref");
  assert.equal(sdxlRefFast.fast, true);
  assert.equal(h.uploadCalls.length, 1);
  assert.ok(sdxlRefFast.refInputName?.startsWith("yugang-ref-"));
});

test("drawEnabled 双复核、onLongWork 时序与 stageNodes 透传", async () => {
  // 入口关闭即拒
  const h1 = createHarness({ initialBackend: "fake_limited", initialEnabled: false });
  assert.equal(await h1.expectReject({ prompt: "1girl" }, "conv-en-1", "r1"), h1.prompts.messages["draw_disabled"]);
  assert.equal(h1.longWorks.length, 0);

  // onSubmitted 瞬间关闭：拒、submitted 保持 false、onLongWork 0 次，重开同轮可重试
  let turnOffBeforeSubmit = true;
  const h2 = createHarness({
    initialBackend: "fake_limited",
    execImpl: async (_url, _graph, execOpts) => {
      assert.equal(execOpts.onStage, undefined, "stageNodes 为 undefined 时不得向 execGraph 传 onStage");
      if (turnOffBeforeSubmit) h2.setEnabled(false);
      execOpts.onSubmitted();
      return PNG;
    },
  });
  const blocked = await h2.expectReject({ prompt: "1girl" }, "conv-en-2", "r1");
  assert.equal(blocked, h2.prompts.messages["draw_disabled"]);
  assert.equal(h2.longWorks.length, 0, "onSubmitted 被 drawEnabled 拦下时不得调 onLongWork");

  turnOffBeforeSubmit = false;
  h2.setEnabled(true);
  const retried = await h2.run({ prompt: "1girl" }, "conv-en-2", "r1");
  assert.match(retried, /^gen\/.*\.png/);
  assert.deepEqual(h2.longWorks, [{ variant: "draw", round: "r1" }]);

  // 声明了 stageNodes 时正确传递 onStage 与 stageNodes 并触发 onDrawStage
  const h3 = createHarness({
    initialBackend: "fake_sdxl",
    execImpl: async (_url, _graph, execOpts) => {
      assert.ok(typeof execOpts.onStage === "function");
      assert.deepEqual(execOpts.stageNodes, ["50", "51"]);
      execOpts.onSubmitted();
      execOpts.onStage!("sketch");
      return PNG;
    },
  });
  await h3.run({ prompt: "1girl" }, "conv-stage", "r9");
  assert.deepEqual(h3.stageEvents, [{ round: "r9", stage: "sketch" }]);
});

test("取消围栏、outbox 机械直发与 fallback、Schema/文案/文档/runtime 清理", async () => {
  // 1. 正常直发 outbox
  const hOk = createHarness({ initialBackend: "fake_anima2b" });
  const doneMsg = await hOk.run({ prompt: "1girl" }, "conv-out-1", "r1");
  assert.match(doneMsg, /^gen\/.*\.png — 画好了/);
  assert.equal(hOk.outbox.length, 1);
  assert.equal(hOk.outboundEntries.length, 1);
  assert.match(String(hOk.outbox[0]!.media), /^gen\/.*\.png$/);
  assert.equal(hOk.outbox[0]!.key, "conv-out-1:drawimg:r1");

  // 2. enqueueOutbound 失败回退 say_media
  const hFallback = createHarness({ initialBackend: "fake_anima2b", failEnqueue: true });
  const fbMsg = await hFallback.run({ prompt: "1girl" }, "conv-out-2", "r1");
  assert.match(fbMsg, /say_media/);
  assert.equal(readdirSync(join(hFallback.mediaRoot, "gen")).length, 1);

  // 3. 出图后已 abort：零落盘零入队，submitted 保持 true，重试吃 draw_uncertain
  const ac = new AbortController();
  const hAbort = createHarness({
    initialBackend: "fake_anima2b",
    execImpl: async (_url, _graph, execOpts) => {
      execOpts.onSubmitted();
      ac.abort(new Error("timeout"));
      return PNG;
    },
  });
  await assert.rejects(() => hAbort.run({ prompt: "1girl" }, "conv-abort", "r1", ac.signal));
  assert.equal(existsSync(join(hAbort.mediaRoot, "gen")), false, "abort 后不得写 gen/");
  assert.equal(hAbort.outbox.length, 0, "abort 后不得入 outbox");
  const uncertain = await hAbort.expectReject({ prompt: "1girl" }, "conv-abort", "r1");
  assert.equal(uncertain, hAbort.prompts.messages["draw_uncertain"]);

  // 4. draw manifest 不含 placement_x/placement_y；interaction-presets.json 已删；messages.json 清理
  const drawManifest = hOk.manifests.get("draw")!;
  const props = (drawManifest.parameters as { properties: Record<string, unknown> }).properties;
  assert.equal(Object.hasOwn(props, "placement_x"), false);
  assert.equal(Object.hasOwn(props, "placement_y"), false);
  assert.equal(existsSync(join(ROOT, "src", "tools", "draw", "interaction-presets.json")), false);

  const msgs = JSON.parse(readFileSync(join(ROOT, "src", "tools", "draw", "messages.json"), "utf8")) as Record<string, string>;
  assert.equal(Object.hasOwn(msgs, "draw_preset_unknown"), false);
  for (const shared of ["draw_used", "draw_inflight", "draw_uncertain", "draw_busy", "draw_off", "draw_disabled", "draw_round_missing"]) {
    assert.ok(typeof msgs[shared] === "string" && msgs[shared].length > 0, `缺少共用 key: ${shared}`);
  }
  for (const added of [
    "draw_backend_unknown",
    "draw_mode_unsupported",
    "draw_hd_unsupported",
    "draw_style_mode_unsupported",
    "draw_style_backend_unsupported",
    "draw_composition_unsupported",
  ]) {
    assert.ok(typeof msgs[added] === "string" && msgs[added].length > 0, `缺少新 key: ${added}`);
  }

  // TOOL.md 去模型化与真实 createDrawTool 启动校验
  const fullDesc = toolFullDescription(drawManifest);
  assert.doesNotMatch(fullDesc, /single-haystack|sit-haystack|3\.8B|\bV8\b|28\s*步|姿态线忽略/);
  assert.doesNotThrow(() => createDrawTool(drawManifest, {
    prompts: hOk.prompts,
    mediaRoot: hOk.mediaRoot,
    react: () => {},
  }));

  // runtime.ts 注入 drawBackend 热配置
  const runtimeSrc = readFileSync(join(ROOT, "src", "app", "runtime.ts"), "utf8");
  assert.ok(runtimeSrc.includes("drawBackend: () => fishConfig().config.drawBackend"));
});

test("createDrawTool 启动期必调后端 validateStartup，坏契约后端立即拒启", () => {
  const prompts = loadPrompts(join(ROOT, "prompt"));
  const manifests = loadToolManifests(join(ROOT, "src", "tools"), { memeTags: prompts.memeTags });
  mergeToolMessages(manifests, prompts.messages);
  const drawManifest = manifests.get("draw")!;
  const brokenBackend: DrawBackend = {
    id: "broken_backend",
    loraFamily: "anima",
    ratioSizes: makeRatios(1),
    capabilities: {
      modes: { single: true, fast: false, ref: false, multi: false },
      hd: false,
      styleModes: [],
      framing: false,
      spacing: false,
    },
    validateStartup() {
      throw new Error("draw workflow contract mismatch: tampered node");
    },
    buildGraph(): DrawBuiltGraph {
      throw new Error("unreachable");
    },
  };
  assert.throws(
    () =>
      createDrawTool(drawManifest, {
        prompts,
        mediaRoot: WORK,
        react: () => {},
        drawBackends: new Map([["broken_backend", brokenBackend]]),
      }),
    /contract mismatch: tampered node/,
  );
});

test("submitAndWait：/queue 与复查 /history 连续 3 次均无作业时快速报错并释放单飞锁；间隙完成不误判", async () => {
  const { createServer } = await import("node:http");
  const { ComfyExecutionFailed, execGraph, runExclusive } = await import("../src/tools/draw/engine.ts");

  let mode: "vanished" | "race_finish" = "vanished";
  let trace: string[] = [];

  const server = createServer((req, res) => {
    const url = req.url ?? "";
    const chunks: Buffer[] = [];
    req.on("data", (c: Buffer) => chunks.push(c));
    req.on("end", () => {
      if (url === "/queue") {
        trace.push("queue");
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify({ queue_running: [], queue_pending: [] }));
        return;
      }
      if (url === "/prompt") {
        const parsed = JSON.parse(Buffer.concat(chunks).toString("utf8")) as { prompt_id: string };
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify({ prompt_id: parsed.prompt_id }));
        return;
      }
      if (url.startsWith("/history/")) {
        const id = url.slice("/history/".length);
        trace.push("history");
        res.writeHead(200, { "content-type": "application/json" });
        // race_finish: 刚查完轮询里的 /queue（第 2 次 /queue）为空后的复查 /history 返回已完成
        if (mode === "race_finish" && trace.filter((x) => x === "queue").length >= 2 && trace.at(-2) === "queue") {
          res.end(JSON.stringify({
            [id]: {
              status: { status_str: "success", completed: true },
              outputs: { "9": { images: [{ filename: "out.png", type: "temp", subfolder: "" }] } },
            },
          }));
          return;
        }
        res.end(JSON.stringify({}));
        return;
      }
      if (url.startsWith("/view?")) {
        res.writeHead(200, { "content-type": "image/png", "content-length": String(PNG.length) });
        res.end(PNG);
        return;
      }
      res.writeHead(404);
      res.end();
    });
  });

  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", () => resolve()));
  const addr = server.address() as { port: number };
  const baseUrl = `http://127.0.0.1:${addr.port}/`;

  try {
    // 1. vanished: 连续 3 次 (/queue 空 -> 复查 /history 空) 后立刻抛 ComfyExecutionFailed，不等 60s deadline，且释放 runExclusive
    mode = "vanished";
    trace = [];
    const t0 = Date.now();
    await assert.rejects(
      () => runExclusive(() => execGraph(baseUrl, {}, {
        deadline: 2_500,
        pollIntervalMs: 5,
        outputNode: "9",
        outputType: "temp",
        onSubmitted: () => {},
      })),
      (err: unknown) => err instanceof ComfyExecutionFailed && /vanished/.test(err.message),
    );
    assert.ok(Date.now() - t0 < 1_000, "应在远早于 deadline 时快速结束");
    // 验证每次 miss 顺序（跳过 execGraph 首检 /queue）：先 3 轮 history，然后 queue 再 history
    const pollTrace = trace.slice(1);
    assert.equal(pollTrace.filter((x) => x === "queue").length, 3);
    for (let i = 0; i < pollTrace.length; i++) {
      if (pollTrace[i] === "queue") assert.equal(pollTrace[i + 1], "history", "先查 /queue 后必须立刻复查 /history");
    }
    // 锁必须已释放
    assert.equal(await runExclusive(async () => "lock-free"), "lock-free");

    // 2. race_finish: 查完 /queue 为空后任务恰好进入 /history，复查命中并正常取图
    mode = "race_finish";
    trace = [];
    const png = await runExclusive(() => execGraph(baseUrl, {}, {
      deadline: 2_500,
      pollIntervalMs: 5,
      outputNode: "9",
      outputType: "temp",
      onSubmitted: () => {},
    }));
    assert.ok(png.equals(PNG));
    assert.equal(trace.slice(1).filter((x) => x === "queue").length, 1);
  } finally {
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});

test("qwen_draw 参数非法时不触发 onLongWork", async () => {
  const { createQwenDrawTool } = await import("../src/tools/qwen_draw/tool.ts");
  const prompts = loadPrompts(join(ROOT, "prompt"));
  const manifests = loadToolManifests(join(ROOT, "src", "tools"), { memeTags: prompts.memeTags });
  mergeToolMessages(manifests, prompts.messages);

  let longWorkCalls = 0;
  const tool = createQwenDrawTool(manifests.get("qwen_draw")!, {
    prompts,
    mediaRoot: WORK,
    comfyUrl: "http://127.0.0.1:18190/",
    onLongWork: () => { longWorkCalls++; },
    react: () => {},
  });
  const api = {
    conversationId: "conv-qwen-test",
    callId: "c1",
    snapshot: async (doc: unknown) => (doc === LiveDoc ? { run: { inputs: ["r1"] } } : undefined),
  } as never;

  await assert.rejects(() => tool.execute({ prompt: "" } as never, api, {} as never));
  await assert.rejects(() => tool.execute({ prompt: "a cat", ratio: "99:1" } as never, api, {} as never));
  await assert.rejects(() => tool.execute({ prompt: "a cat", ref: "inbound/missing.png" } as never, api, {} as never));
  assert.equal(longWorkCalls, 0, "参数或 ref 非法时不得触发 onLongWork");
});
