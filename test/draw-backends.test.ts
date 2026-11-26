import test from "node:test";
import assert from "node:assert/strict";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = fileURLToPath(new URL("..", import.meta.url));
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

type MockHandler = (req: IncomingMessage, res: ServerResponse, body: string) => void;

async function withMockComfy(
  handler: MockHandler,
  onWs?: (send: (payload: unknown) => void) => void,
): Promise<{ url: string; close: () => Promise<void> }> {
  const server = createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on("data", (c: Buffer) => chunks.push(c));
    req.on("end", () => handler(req, res, Buffer.concat(chunks).toString("utf8")));
  });

  if (onWs) {
    server.on("upgrade", (req, socket) => {
      const key = req.headers["sec-websocket-key"];
      if (typeof key !== "string") {
        socket.destroy();
        return;
      }
      const accept = createHash("sha1")
        .update(`${key}258EAFA5-E914-47DA-95CA-C5AB0DC85B11`)
        .digest("base64");
      socket.write(
        "HTTP/1.1 101 Switching Protocols\r\n" +
        "Upgrade: websocket\r\n" +
        "Connection: Upgrade\r\n" +
        `Sec-WebSocket-Accept: ${accept}\r\n\r\n`,
      );
      socket.on("data", (buf: Buffer) => {
        if ((buf[0] & 0x0f) === 0x08) socket.end();
      });
      const send = (payload: unknown) => {
        if (socket.destroyed) return;
        const data = Buffer.from(JSON.stringify(payload), "utf8");
        const header = data.length < 126
          ? Buffer.from([0x81, data.length])
          : Buffer.from([0x81, 126, (data.length >> 8) & 0xff, data.length & 0xff]);
        socket.write(Buffer.concat([header, data]));
      };
      onWs(send);
    });
  }

  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", () => resolve()));
  const addr = server.address();
  assert.ok(addr && typeof addr === "object");
  return {
    url: `http://127.0.0.1:${addr.port}/`,
    close: () => new Promise<void>((resolve) => {
      server.closeAllConnections();
      server.close(() => resolve());
    }),
  };
}

function sendJson(res: ServerResponse, data: unknown, status = 200): void {
  res.writeHead(status, { "content-type": "application/json" });
  res.end(JSON.stringify(data));
}

test("零 IO ids.ts 与分层红线：不含 fs / fish-config 依赖", async () => {
  const ids = await import("../src/tools/draw/backends/ids.ts");
  assert.equal(ids.DEFAULT_DRAW_BACKEND, "anima3.8b");
  assert.deepEqual(ids.DRAW_BACKEND_IDS, ["anima3.8b"]);

  const idsSource = readFileSync(join(ROOT, "src/tools/draw/backends/ids.ts"), "utf8");
  assert.ok(!/from\s+["']node:/.test(idsSource), "ids.ts 不应引入 node:* 模块");
  assert.ok(!/import\s/.test(idsSource), "ids.ts 应保持零外部 import");

  for (const rel of [
    "src/tools/draw/engine.ts",
    "src/tools/draw/backends/types.ts",
    "src/tools/draw/backends/registry.ts",
    "src/tools/draw/backends/anima3.8b/index.ts",
  ]) {
    const src = readFileSync(join(ROOT, rel), "utf8");
    assert.ok(!src.includes("fish-config"), `${rel} 严禁 import fish-config.ts`);
  }
});

test("backends registry 键集一致、getDrawBackend 与 validateAllDrawBackends", async () => {
  const ids = await import("../src/tools/draw/backends/ids.ts");
  const registry = await import("../src/tools/draw/backends/registry.ts");
  const anima = await import("../src/tools/draw/backends/anima3.8b/index.ts");

  assert.deepEqual([...registry.DRAW_BACKENDS.keys()], [...ids.DRAW_BACKEND_IDS]);
  assert.equal(registry.getDrawBackend("anima3.8b"), anima.anima38bBackend);
  assert.equal(registry.getDrawBackend("missing"), undefined);

  const customMap = new Map([["custom", anima.anima38bBackend]]);
  assert.equal(registry.getDrawBackend("custom", customMap), anima.anima38bBackend);
  assert.equal(registry.getDrawBackend("anima3.8b", customMap), undefined);

  assert.doesNotThrow(() => registry.validateAllDrawBackends());
});

test("validateAnima38bTemplates 纯函数：篡改模板关键节点或底模名抛 contract mismatch", async () => {
  const { validateAnima38bTemplates } = await import("../src/tools/draw/backends/anima3.8b/index.ts");
  const main = JSON.parse(readFileSync(join(ROOT, "src/tools/draw/backends/anima3.8b/workflow.json"), "utf8"));
  const interaction = JSON.parse(readFileSync(join(ROOT, "src/tools/draw/backends/anima3.8b/workflow-interaction.json"), "utf8"));
  const single = JSON.parse(readFileSync(join(ROOT, "src/tools/draw/backends/anima3.8b/workflow-interaction-single.json"), "utf8"));

  assert.doesNotThrow(() => validateAnima38bTemplates({ main, interaction, single }));

  const badMainNode = structuredClone(main);
  badMainNode["7"].class_type = "WrongNode";
  assert.throws(() => validateAnima38bTemplates({ main: badMainNode, interaction, single }), /contract mismatch/);

  const badMainUnet = structuredClone(main);
  badMainUnet["1"].inputs.unet_name = "other.safetensors";
  assert.throws(() => validateAnima38bTemplates({ main: badMainUnet, interaction, single }), /contract mismatch/);

  const badInteraction = structuredClone(interaction);
  badInteraction["11"].class_type = "WrongSampler";
  assert.throws(() => validateAnima38bTemplates({ main, interaction: badInteraction, single }), /contract mismatch/);

  const badSingle = structuredClone(single);
  badSingle["38"].class_type = "PreviewImage";
  assert.throws(() => validateAnima38bTemplates({ main, interaction, single: badSingle }), /contract mismatch/);
});

test("anima3.8b 后端四模式、ref+fast 叠加、stageNodes 与跨族降级矩阵", async () => {
  const { anima38bBackend } = await import("../src/tools/draw/backends/anima3.8b/index.ts");

  assert.equal(anima38bBackend.id, "anima3.8b");
  assert.equal(anima38bBackend.loraFamily, "anima");
  assert.deepEqual(anima38bBackend.capabilities, {
    modes: { single: true, fast: true, ref: true, multi: true },
    hd: true,
    styleModes: ["fast", "ref"],
    framing: true,
    spacing: true,
  });
  for (const [w, h] of Object.values(anima38bBackend.ratioSizes)) {
    assert.equal(w % 8, 0);
    assert.equal(h % 8, 0);
  }

  // 1. single（有 LoRA vs 跨族降级）
  const singleWithLora = anima38bBackend.buildGraph({
    mode: "single",
    fast: false,
    prompt: "standing outdoors",
    width: 912,
    height: 1216,
    hd: false,
    seed: 101,
    role: { inject: "claude_girl, orange hair", lora: { file: "claude.safetensors", weight: 1 } },
    bypass: "bp1",
    pbypass: "bp2",
  });
  assert.equal(singleWithLora.workingVariant, "draw_interaction");
  assert.equal(singleWithLora.stageNodes, undefined);
  assert.equal(singleWithLora.outputNode, "38");
  assert.equal(singleWithLora.outputType, "output");
  assert.equal(singleWithLora.deadline, 1_500_000);
  assert.equal(singleWithLora.graph["4"]?.class_type, "AnimaLoRARemapTagLoader");
  assert.deepEqual(singleWithLora.graph["11"]?.inputs.model, ["4", 0]);
  assert.ok(String(singleWithLora.graph["7"]?.inputs.text).includes("claude_girl, orange hair"));

  const singleDegraded = anima38bBackend.buildGraph({
    mode: "single",
    fast: false,
    prompt: "standing outdoors",
    width: 912,
    height: 1216,
    hd: false,
    seed: 101,
    role: { inject: "claude_girl, orange hair", lora: undefined },
  });
  assert.equal(singleDegraded.stageNodes, undefined);
  assert.equal(singleDegraded.graph["4"], undefined);
  assert.deepEqual(singleDegraded.graph["11"]?.inputs.model, ["1", 0]);
  assert.deepEqual(singleDegraded.graph["7"]?.inputs.clip, ["2", 0]);
  assert.ok(String(singleDegraded.graph["7"]?.inputs.text).includes("claude_girl, orange hair"));
  assert.ok(String(singleDegraded.graph["25"]?.inputs.text).includes("claude_girl, orange hair"));

  // 2. fast（有 LoRA+style vs 跨族降级）
  const fastWithLora = anima38bBackend.buildGraph({
    mode: "fast",
    fast: true,
    prompt: "smiling",
    width: 1056,
    height: 1056,
    hd: false,
    seed: 202,
    role: { inject: "claude_girl, orange hair", lora: { file: "claude.safetensors", weight: 1 } },
    style: { file: "hsr.safetensors", weight: 0.7 },
  });
  assert.equal(fastWithLora.workingVariant, "draw_fast");
  assert.deepEqual(fastWithLora.stageNodes, ["43", "91"]);
  assert.equal(fastWithLora.outputNode, "9");
  assert.equal(fastWithLora.outputType, "temp");
  assert.equal(fastWithLora.deadline, 240_000);
  assert.equal(fastWithLora.graph["92"]?.inputs.scale_by, 0.3);
  assert.equal(fastWithLora.graph["7"]?.inputs.steps, 28);
  assert.equal(fastWithLora.graph["72"]?.inputs.steps, 8);
  assert.equal(fastWithLora.graph["88"]?.class_type, "AnimaLoRARemapTagLoader");
  assert.equal(fastWithLora.graph["93"]?.class_type, "AnimaLoRARemapTagLoader");

  const fastDegraded = anima38bBackend.buildGraph({
    mode: "fast",
    fast: true,
    prompt: "smiling",
    width: 1056,
    height: 1056,
    hd: false,
    role: { inject: "claude_girl, orange hair", lora: undefined },
  });
  assert.equal(fastDegraded.graph["93"], undefined);
  assert.ok(String(fastDegraded.graph["4"]?.inputs.text).includes("claude_girl, orange hair"));
  assert.ok(String(fastDegraded.graph["71"]?.inputs.text).includes("claude_girl, orange hair"));

  // 3. ref (fast=false) 与 ref+fast (fast=true)
  const refInput = "yugang-ref-12345678-1234-1234-1234-1234567890ab.png";
  const refNormal = anima38bBackend.buildGraph({
    mode: "ref",
    fast: false,
    prompt: "red dress",
    width: 912,
    height: 1216,
    hd: false,
    refInputName: refInput,
    refStrength: 0.45,
    role: { inject: "claude_girl, orange hair", lora: undefined },
  });
  assert.equal(refNormal.workingVariant, "draw");
  assert.deepEqual(refNormal.stageNodes, ["43", "91"]);
  assert.equal(refNormal.graph["6"], undefined);
  assert.equal(refNormal.graph["19"]?.inputs.image, refInput);
  assert.equal(refNormal.graph["7"]?.inputs.denoise, 0.45);
  assert.equal(refNormal.graph["7"]?.inputs.steps, 30);
  assert.equal(refNormal.graph["93"], undefined);
  assert.ok(String(refNormal.graph["4"]?.inputs.text).includes("claude_girl, orange hair"));

  const refFast = anima38bBackend.buildGraph({
    mode: "ref",
    fast: true,
    prompt: "red dress",
    width: 912,
    height: 1216,
    hd: false,
    refInputName: refInput,
    refStrength: 0.45,
  });
  assert.equal(refFast.workingVariant, "draw_fast");
  assert.deepEqual(refFast.stageNodes, ["43", "91"]);
  assert.equal(refFast.graph["6"], undefined);
  assert.equal(refFast.graph["19"]?.inputs.image, refInput);
  assert.equal(refFast.graph["7"]?.inputs.denoise, 0.45);
  assert.equal(refFast.graph["7"]?.inputs.steps, 28);
  assert.equal(refFast.graph["72"]?.inputs.steps, 8);
  assert.equal(refFast.graph["92"]?.inputs.scale_by, 0.3);

  // 4. multi（有 LoRA+wide+apart+hd vs 跨族降级）
  const multiWithLora = anima38bBackend.buildGraph({
    mode: "multi",
    fast: false,
    prompt: "talking in cafe",
    width: 1216,
    height: 912,
    hd: true,
    framing: "wide",
    spacing: "apart",
    bypass: "bp_common",
    pbypass: "bp_part",
    parts: [
      { text: "on left, smiling", role: { inject: "claude_girl, orange hair", lora: { file: "claude.safetensors", weight: 1 } } },
      { text: "on right, waving", role: { inject: "aigirls, blue hair", lora: { file: "aigirls.safetensors", weight: 1 } } },
    ],
  });
  assert.equal(multiWithLora.workingVariant, "draw_interaction");
  assert.equal(multiWithLora.stageNodes, undefined);
  assert.equal(multiWithLora.outputNode, "38");
  assert.equal(multiWithLora.outputType, "output");
  assert.equal(multiWithLora.graph["60"]?.inputs.framing, "wide");
  assert.equal(multiWithLora.graph["60"]?.inputs.spacing, "apart");
  assert.equal(multiWithLora.graph["2"]?.inputs.character1_lora, "claude.safetensors");
  assert.equal(multiWithLora.graph["2"]?.inputs.character2_lora, "aigirls.safetensors");
  assert.equal(multiWithLora.graph["93"]?.class_type, "AnimaLoRARemapTagLoader");
  assert.equal(multiWithLora.graph["94"]?.class_type, "AnimaLoRARemapTagLoader");
  assert.equal(multiWithLora.graph["95"]?.class_type, "UpscaleModelLoader");
  assert.ok(String(multiWithLora.graph["60"]?.inputs.base_prompt).includes("bp_common"));
  assert.ok(String(multiWithLora.graph["1"]?.inputs.character1).includes("bp_part"));

  const multiDegraded = anima38bBackend.buildGraph({
    mode: "multi",
    fast: false,
    prompt: "talking in cafe",
    width: 1216,
    height: 912,
    hd: false,
    parts: [
      { text: "on left, smiling", role: { inject: "claude_girl, orange hair", lora: undefined } },
      { text: "on right, waving", role: { inject: "aigirls, blue hair", lora: undefined } },
    ],
  });
  assert.equal(multiDegraded.stageNodes, undefined);
  assert.equal(multiDegraded.graph["2"]?.inputs.character1_lora, "None");
  assert.equal(multiDegraded.graph["2"]?.inputs.character2_lora, "None");
  assert.equal(multiDegraded.graph["93"], undefined);
  assert.ok(String(multiDegraded.graph["1"]?.inputs.character1).includes("claude_girl, orange hair"));
  assert.ok(String(multiDegraded.graph["1"]?.inputs.character2).includes("aigirls, blue hair"));
  assert.ok(String(multiDegraded.graph["71"]?.inputs.text).includes("claude_girl, orange hair"));
  assert.ok(String(multiDegraded.graph["71"]?.inputs.text).includes("aigirls, blue hair"));
});

test("comfy.ts 兼容门面保留全部 11 个既有值导出 + runExclusive 且 ComfyBusy 类同一", async () => {
  const comfy = await import("../src/tools/draw/comfy.ts");
  const engine = await import("../src/tools/draw/engine.ts");
  const keys = Object.keys(comfy);
  for (const expected of [
    "ComfyBusy",
    "ComfyExecutionFailed",
    "comfyUrl",
    "execGraph",
    "makeGraph",
    "makeInteractionGraph",
    "makeInteractionSingleGraph",
    "runComfy",
    "runInteraction",
    "runInteractionSingle",
    "uploadRefImage",
    "runExclusive",
  ]) {
    assert.ok(keys.includes(expected), `comfy.ts 缺少导出 ${expected}`);
  }
  assert.equal(comfy.ComfyBusy, engine.ComfyBusy);
  assert.equal(comfy.ComfyExecutionFailed, engine.ComfyExecutionFailed);
  assert.equal(comfy.runExclusive, engine.runExclusive);

  // 兼容构图函数 smoke check
  const g1 = comfy.makeGraph({ prompt: "1girl", fast: true, lora: { file: "a.safetensors", weight: 1, inject: "tag1" } });
  assert.equal(g1["7"]?.inputs.steps, 28);
  const g2 = comfy.makeInteractionGraph({
    prompt: "talking",
    width: 1216,
    height: 912,
    preset: { scene_json: "{}", scene_json_2x: "{}", camera_extension: "{}", box: [{ x: 0.34, y: 0.5, width: 0.3, height: 0.8 }, { x: 0.66, y: 0.5, width: 0.3, height: 0.8 }] },
    parts: [{ text: "left" }, { text: "right" }],
    label: "t",
  });
  assert.equal(g2["1"]?.class_type, "RSMultiCharacterPrompt");
  const g3 = comfy.makeInteractionSingleGraph({
    prompt: "standing",
    width: 912,
    height: 1216,
    preset: { scene_json: "{}", scene_json_2x: "{}", camera_extension: "{}", box: [{ x: 0.5, y: 0.5, width: 0.3, height: 0.8 }] },
    part: { text: "" },
    label: "s",
  });
  assert.equal(g3["11"]?.class_type, "KSampler");
});

test("统一单飞锁 runExclusive：并发拒、异常/abort 释放，与 runComfy/runInteraction/runQwenDraw 共用", async () => {
  const { runExclusive, ComfyBusy } = await import("../src/tools/draw/engine.ts");
  const { runComfy, runInteraction } = await import("../src/tools/draw/comfy.ts");
  const { runQwenDraw } = await import("../src/tools/qwen_draw/comfy.ts");

  let release!: () => void;
  const gate = new Promise<void>((resolve) => { release = resolve; });
  const holder = runExclusive(async () => {
    await gate;
    return "ok";
  });

  await assert.rejects(() => runExclusive(async () => "dup"), (e: unknown) => e instanceof ComfyBusy);
  await assert.rejects(() => runComfy("http://127.0.0.1:1/", { prompt: "1girl" }, () => {}), (e: unknown) => e instanceof ComfyBusy);
  await assert.rejects(
    () => runInteraction("http://127.0.0.1:1/", {
      prompt: "talking",
      width: 1216,
      height: 912,
      preset: { scene_json: "{}", scene_json_2x: "{}", camera_extension: "{}", box: [{ x: 0.34, y: 0.5, width: 0.3, height: 0.8 }, { x: 0.66, y: 0.5, width: 0.3, height: 0.8 }] },
      parts: [{ text: "left" }, { text: "right" }],
      label: "t",
    }, () => {}),
    (e: unknown) => e instanceof ComfyBusy,
  );
  await assert.rejects(
    () => runQwenDraw("http://127.0.0.1:1/", { prompt: "hello", ratio: "1:1", resolution: 1024, fast: false }, () => {}),
    (e: unknown) => e instanceof ComfyBusy,
  );

  release();
  assert.equal(await holder, "ok");

  // 内部抛错后释放锁
  await assert.rejects(() => runExclusive(async () => { throw new Error("boom"); }), /boom/);
  // AbortError 后释放锁
  const ac = new AbortController();
  ac.abort(new Error("cancelled"));
  await assert.rejects(() => runExclusive(async () => { ac.signal.throwIfAborted(); return "never"; }), /cancelled/);
  // 锁已恢复可用
  assert.equal(await runExclusive(async () => "recovered"), "recovered");
});

test("execGraph 多架构模型与 LoRA 清单核对、未注册节点区分及 stageNodes", async () => {
  const { execGraph } = await import("../src/tools/draw/engine.ts");

  let objectInfo: Record<string, unknown> = {};
  let wsEvents: unknown[] = [];
  let wsSend: ((payload: unknown) => void) | undefined;
  let submittedPromptId = "";

  const flushWsEvents = () => {
    if (!wsSend || !submittedPromptId || wsEvents.length === 0) return;
    const pending = wsEvents.splice(0);
    for (const ev of pending) {
      wsSend({ ...(ev as object), data: { ...((ev as { data?: object }).data ?? {}), prompt_id: submittedPromptId } });
    }
  };

  const server = await withMockComfy(
    (req, res, body) => {
      const url = req.url ?? "";
      if (url === "/queue") {
        sendJson(res, { queue_running: [], queue_pending: [] });
        return;
      }
      if (url.startsWith("/object_info/")) {
        const cls = decodeURIComponent(url.slice("/object_info/".length));
        sendJson(res, objectInfo[cls] ?? {});
        return;
      }
      if (url === "/prompt") {
        const parsed = JSON.parse(body) as { prompt_id: string };
        submittedPromptId = parsed.prompt_id;
        flushWsEvents();
        sendJson(res, { prompt_id: parsed.prompt_id });
        return;
      }
      if (url.startsWith("/history/")) {
        const id = url.slice("/history/".length);
        const respond = () => sendJson(res, {
          [id]: {
            status: { status_str: "success", completed: true },
            outputs: { "9": { images: [{ filename: "out.png", type: "temp", subfolder: "" }] } },
          },
        });
        if (wsEvents.length > 0) setTimeout(respond, 30);
        else respond();
        return;
      }
      if (url.startsWith("/view?")) {
        res.writeHead(200, { "content-type": "image/png", "content-length": String(PNG.length) });
        res.end(PNG);
        return;
      }
      sendJson(res, {}, 404);
    },
    (send) => {
      wsSend = send;
      flushWsEvents();
    },
  );

  try {
    // 1. LoraLoader / LoraLoaderModelOnly 缺文件拒、在场放行
    objectInfo = {
      LoraLoader: { LoraLoader: { input: { required: { lora_name: [["present.safetensors"], {}] } } } },
    };
    let submitted = false;
    await assert.rejects(
      () => execGraph(server.url, {
        "1": { class_type: "LoraLoader", inputs: { lora_name: "missing_lora.safetensors" } },
      }, { deadline: 5000, outputNode: "9", outputType: "temp", onSubmitted: () => { submitted = true; } }),
      /ComfyUI LoRA files missing: missing_lora\.safetensors/,
    );
    assert.equal(submitted, false);

    await assert.rejects(
      () => execGraph(server.url, {
        "1": { class_type: "LoraLoaderModelOnly", inputs: { lora_name: "missing_only.safetensors" } },
      }, { deadline: 5000, outputNode: "9", outputType: "temp", onSubmitted: () => { submitted = true; } }),
      /ComfyUI LoRA files missing: missing_only\.safetensors/,
    );
    assert.equal(submitted, false);

    // 2. DualCLIPLoader 逐字段（clip_name1 / clip_name2）与 CheckpointLoaderSimple 与 extraModelFileFields
    objectInfo = {
      LoraLoader: { LoraLoader: { input: { required: { lora_name: [["present.safetensors"], {}] } } } },
      CheckpointLoaderSimple: { CheckpointLoaderSimple: { input: { required: { ckpt_name: [["sdxl.safetensors"], {}] } } } },
      DualCLIPLoader: {
        DualCLIPLoader: {
          input: {
            required: {
              clip_name1: [["clip1.safetensors"], {}],
              clip_name2: [["clip2.safetensors"], {}],
            },
          },
        },
      },
      CustomLoader: { CustomLoader: { input: { required: { my_model: [["custom.safetensors"], {}] } } } },
    };

    // DualCLIPLoader 缺 clip_name2
    await assert.rejects(
      () => execGraph(server.url, {
        "1": { class_type: "DualCLIPLoader", inputs: { clip_name1: "clip1.safetensors", clip_name2: "missing2.safetensors" } },
      }, { deadline: 5000, outputNode: "9", outputType: "temp", onSubmitted: () => { submitted = true; } }),
      /ComfyUI model files missing: DualCLIPLoader missing2\.safetensors/,
    );
    assert.equal(submitted, false);

    // extraModelFileFields 缺文件
    await assert.rejects(
      () => execGraph(server.url, {
        "1": { class_type: "CustomLoader", inputs: { my_model: "missing_custom.safetensors" } },
      }, {
        deadline: 5000,
        outputNode: "9",
        outputType: "temp",
        extraModelFileFields: { CustomLoader: ["my_model"] },
        onSubmitted: () => { submitted = true; },
      }),
      /ComfyUI model files missing: CustomLoader missing_custom\.safetensors/,
    );
    assert.equal(submitted, false);

    // 3. 未注册节点（{}）与清单格式异常区分
    objectInfo = {
      DualCLIPLoader: {},
      CheckpointLoaderSimple: { CheckpointLoaderSimple: { input: { required: { ckpt_name: "not-an-array" } } } },
    };
    await assert.rejects(
      () => execGraph(server.url, {
        "1": { class_type: "DualCLIPLoader", inputs: { clip_name1: "a", clip_name2: "b" } },
      }, { deadline: 5000, outputNode: "9", outputType: "temp", onSubmitted: () => {} }),
      /ComfyUI node not registered: DualCLIPLoader/,
    );
    await assert.rejects(
      () => execGraph(server.url, {
        "1": { class_type: "CheckpointLoaderSimple", inputs: { ckpt_name: "sdxl.safetensors" } },
      }, { deadline: 5000, outputNode: "9", outputType: "temp", onSubmitted: () => {} }),
      /invalid ComfyUI model inventory/,
    );

    // 4. 全在场放行 + stageNodes 自定义触发
    objectInfo = {
      LoraLoader: { LoraLoader: { input: { required: { lora_name: [["present.safetensors"], {}] } } } },
      CheckpointLoaderSimple: { CheckpointLoaderSimple: { input: { required: { ckpt_name: [["sdxl.safetensors"], {}] } } } },
      DualCLIPLoader: {
        DualCLIPLoader: {
          input: {
            required: {
              clip_name1: [["clip1.safetensors"], {}],
              clip_name2: [["clip2.safetensors"], {}],
            },
          },
        },
      },
      CustomLoader: { CustomLoader: { input: { required: { my_model: [["custom.safetensors"], {}] } } } },
    };
    wsEvents = [{ type: "executing", data: { node: "50" } }];
    const stages: string[] = [];
    const out = await execGraph(server.url, {
      "1": { class_type: "LoraLoader", inputs: { lora_name: "present.safetensors" } },
      "2": { class_type: "LoraLoaderModelOnly", inputs: { lora_name: "present.safetensors" } },
      "3": { class_type: "CheckpointLoaderSimple", inputs: { ckpt_name: "sdxl.safetensors" } },
      "4": { class_type: "DualCLIPLoader", inputs: { clip_name1: "clip1.safetensors", clip_name2: "clip2.safetensors" } },
      "5": { class_type: "CustomLoader", inputs: { my_model: "custom.safetensors" } },
    }, {
      deadline: 5000,
      outputNode: "9",
      outputType: "temp",
      stageNodes: ["50"],
      extraModelFileFields: { CustomLoader: ["my_model"] },
      onSubmitted: () => { submitted = true; },
      onStage: (s) => stages.push(s),
    });
    assert.equal(submitted, true);
    assert.ok(out.equals(PNG));
    assert.deepEqual(stages, ["sketch"]);

    // stageNodes 为空数组时不触发 onStage
    const emptyStages: string[] = [];
    await execGraph(server.url, {
      "3": { class_type: "CheckpointLoaderSimple", inputs: { ckpt_name: "sdxl.safetensors" } },
    }, {
      deadline: 5000,
      outputNode: "9",
      outputType: "temp",
      stageNodes: [],
      onSubmitted: () => {},
      onStage: (s) => emptyStages.push(s),
    });
    assert.deepEqual(emptyStages, []);
  } finally {
    await server.close();
  }
});
