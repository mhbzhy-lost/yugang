/**
 * 工具即扩展：
 *  - 初始工具面只有 say_* 四出口 / react / tool_search，其余已启用工具全部 deferred（tool_search 加载）
 *  - 每个工具的说明逐字来自 src/tools/<name>/TOOL.md
 */
import test from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { createModels } from "@earendil-works/pi-ai/models";
import { fauxAssistantMessage, fauxProvider, fauxToolCall } from "@earendil-works/pi-ai/providers/faux";
import { LiveDoc, MemoryStorage } from "@earendil-works/pi-durable";
import { openFish } from "../src/harness.ts";
import { loadPrompts } from "../src/prompt/index.ts";
import { loadToolManifests, toolFullDescription } from "../src/tools/manifest.ts";
import { mergeToolMessages } from "../src/tools/loader.ts";
import { makeReminderTask, RemindersDoc } from "../src/tools/remind/task.ts";

const ctx = BACKGROUND_CONTEXT;
const PROMPTS = fileURLToPath(new URL("../prompt", import.meta.url));
const TOOL_ROOT = fileURLToPath(new URL("../src/tools/", import.meta.url));
const PNG = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.alloc(64, 7)]);

function boot() {
  const faux = fauxProvider();
  const models = createModels();
  models.setProvider(faux.provider);
  const mediaRoot = mkdtempSync(join(tmpdir(), "yg-media-"));
  const workspaceRoot = mkdtempSync(join(tmpdir(), "yg-ws-"));
  const outbox: { text: string; media?: string }[] = [];

  const fish = openFish({
    storage: new MemoryStorage(),
    models,
    model: { provider: faux.provider.id, modelId: faux.models[0].id },
    promptRoot: PROMPTS,
    mediaRoot,
    workspaceRoot,
    emit: (_id, payload) => {
      outbox.push({ text: payload.items.join("|"), media: payload.media });
    },
    react: () => {},
    master: "1",
    newsPrepare: async () => ({ status: "rejected", reason: "test_only" }),
    // remind 工具的底座任务（宿主没传就不注册；工具面断言要求它在册）
    reminderTask: makeReminderTask({ messages: () => ({}), drain: async () => {}, log: () => {} }),
  });
  return { faux, mediaRoot, outbox, fish };
}

test("工具面为窄接口：无 bash，自改工具已注册", async () => {
  const { fish } = boot();
  const open = await fish;
  try {
    const root = await open.harness.root(ctx);
    const agent = await root.agent(ctx);
    const names = agent.tools.map((t) => t.name);
    // 初始工具面：四个出口 say_*、轻回应 react 和按需加载的检索入口 tool_search
    assert.deepEqual(names, ["react", "say_media", "say_meme", "say_voice", "say_words", "tool_search"]);
    assert.ok(!names.includes("bash"), "bash 必须不存在");
    assert.ok(!names.includes("shell"), "shell 必须不存在");
    // 其余已启用工具（含 meme_import）全部等在 deferred 里，等 tool_search 加载；
    // ammo_list / ammo_submit 已进 loader 的 DISABLED_TOOL_PACKAGES（2026-11-04 T3 弹药管线停用），
    // 完整性校验照旧但不进 active/deferred/catalog。
    // 远程静态生图已收归 draw_remote（2026-11-25）：旧 gpt_image / wan_image 工具包已删，不在工具面里；
    // drawRemote 配置 / 凭据 / modelsPath 缺失也不影响注册（恒返回注册，缺凭据在执行期回执）
    assert.deepEqual(
      agent.deferred.map((t) => t.name),
      ["bili_search", "bili_video", "config", "draw", "draw_remote", "grep", "look", "meme", "meme_add", "meme_import", "news_prepare", "now", "qwen_draw", "read", "remind", "restart", "search", "tags", "tree", "video", "wan_gif", "watch", "write"],
    );
  } finally {
    await open.close();
  }
});

test("say_* 每轮硬上限 3 次调用：四工具任意组合第 4 次拒，下一轮恢复", async () => {
  const { faux, mediaRoot, outbox, fish } = boot();
  const open = await fish;
  try {
    const root = await open.harness.root(ctx, {
      agent: { model: { provider: faux.provider.id, modelId: faux.models[0].id } },
    });
    mkdirSync(join(mediaRoot, "gen"), { recursive: true });
    writeFileSync(join(mediaRoot, "gen", "a.png"), PNG);

    // 同一轮四个出口工具混合调用三次（words+media+words），第四次以 tool 错误拒绝，不 emit
    faux.setResponses([
      fauxAssistantMessage([fauxToolCall("say_words", { text: "头一句" })], { stopReason: "toolUse" }),
      fauxAssistantMessage([fauxToolCall("say_media", { media: "gen/a.png" })], { stopReason: "toolUse" }),
      fauxAssistantMessage([fauxToolCall("say_words", { text: "第三句" })], { stopReason: "toolUse" }),
      fauxAssistantMessage([fauxToolCall("say_words", { text: "第四句" })], { stopReason: "toolUse" }),
      fauxAssistantMessage("说完了"),
    ]);
    const settled = await (await root.submit({ type: "input", content: "说两句" }, ctx)).wait(ctx);
    assert.equal(settled.status, "done");
    await open.drain([root.id]);
    assert.deepEqual(outbox.map((o) => o.text), ["头一句", "", "第三句"], "一轮内前三次开口落进 outbox（纯图那条无字）");
    assert.equal(outbox[1]?.media, "gen/a.png", "say_media 那次应带图");

    const view = await root.context(ctx);
    const results = view.entries.filter((e) => e.kind === "pi.tool-result");
    assert.ok(
      results.some((e) => JSON.stringify(e.model ?? "").includes("开口 3 次") ||
        JSON.stringify(e.model ?? "").includes("就此打住")),
      "第 4 次调用的拒绝没有以 tool 错误回给模型（say_once 文案）",
    );

    // 下一轮（新的一轮）恢复：上限按轮计，不株连。
    faux.setResponses([
      fauxAssistantMessage([fauxToolCall("say_words", { text: "新一轮" })], { stopReason: "toolUse" }),
      fauxAssistantMessage("嗯"),
    ]);
    await (await root.submit({ type: "input", content: "再说" }, ctx)).wait(ctx);
    await open.drain([root.id]);
    assert.deepEqual(outbox.map((o) => o.text), ["头一句", "", "第三句", "新一轮"]);
  } finally {
    await open.close();
  }
});

test("工具说明逐字来自 src/tools/<name>/TOOL.md，缺文件就报错", async () => {
  const { fish } = boot();
  const open = await fish;
  try {
    const root = await open.harness.root(ctx);
    const agent = await root.agent(ctx);
    const manifests = loadToolManifests(TOOL_ROOT, { memeTags: open.prompts.memeTags });
    for (const tool of [...agent.tools, ...agent.deferred]) {
      const manifest = manifests.get(tool.name);
      assert.ok(manifest, `src/tools/${tool.name}/TOOL.md 不存在`);
      assert.equal(tool.description, toolFullDescription(manifest), `${tool.name} 的说明不是文件原文`);
    }
  } finally {
    await open.close();
  }
});

function loadMergedManifests() {
  const prompts = loadPrompts(PROMPTS);
  const manifests = loadToolManifests(TOOL_ROOT, { memeTags: prompts.memeTags });
  mergeToolMessages(manifests, prompts.messages);
  return { prompts, manifests };
}

test("grep 跳过 var/ 并拦截嵌套量词 ReDoS；read 分段模式超限报 fs_too_big", async () => {
  const { createGrepTool } = await import("../src/tools/grep/tool.ts");
  const { createReadTool } = await import("../src/tools/read/tool.ts");
  const { SAND_ROOT } = await import("../src/tools/fs-shared.ts");
  const { prompts, manifests } = loadMergedManifests();
  const masterDeps = {
    prompts,
    mediaRoot: mkdtempSync(join(tmpdir(), "yg-fs-")),
    master: "1",
    triggerOf: () => ({ mentionsBot: false, userId: "1" }),
    react: () => {},
  };
  const api = {
    conversationId: "conv-fs",
    callId: "c1",
    snapshot: async (doc: unknown) => (doc === LiveDoc ? { run: { inputs: ["r1"] } } : undefined),
  } as never;

  const grep = createGrepTool(manifests.get("grep")!, masterDeps)!;
  // 嵌套量词 ReDoS 拦截
  await assert.rejects(
    () => grep.execute({ pattern: "(a+)+b", path: "src/tools/grep" } as never, api, ctx),
    new RegExp(prompts.messages["grep_bad_regex"]!),
  );
  // 验证 grep 默认跳过 var/
  const grepSrc = readFileSync(fileURLToPath(new URL("../src/tools/grep/tool.ts", import.meta.url)), "utf8");
  assert.match(grepSrc, /"var"/);

  // read 分段模式超 READ_CAP 报 fs_too_big
  const read = createReadTool(manifests.get("read")!, masterDeps)!;
  const bigFile = join(SAND_ROOT, `yg-big-read-${Date.now()}.txt`);
  writeFileSync(bigFile, `${"x".repeat(100)}\n`.repeat(600)); // ~60KB > READ_CAP(32KB)
  try {
    await assert.rejects(
      () => read.execute({ path: bigFile, startLine: 1 } as never, api, ctx),
      new RegExp(prompts.messages["fs_too_big"]!),
    );
  } finally {
    rmSync(bigFile, { force: true });
  }
});

test("look 透传 abortSignal 给 describeImage", async () => {
  const { createLookTool } = await import("../src/tools/look/tool.ts");
  const { prompts, manifests } = loadMergedManifests();
  const mediaRoot = mkdtempSync(join(tmpdir(), "yg-look-sig-"));
  mkdirSync(join(mediaRoot, "inbound"), { recursive: true });
  writeFileSync(join(mediaRoot, "inbound", "small.png"), PNG);

  let seenSignal: AbortSignal | undefined;
  const models = {
    getModel: () => ({ id: "v-1", provider: "mock" }),
    streamSimple: (_model: unknown, _req: unknown, opts?: { signal?: AbortSignal }) => {
      seenSignal = opts?.signal;
      return {
        result: async () => ({
          content: [{ type: "text", text: "一只小猫" }],
          stopReason: "stop",
        }),
      };
    },
  } as never;

  const look = createLookTool(manifests.get("look")!, {
    prompts,
    mediaRoot,
    models,
    visionModel: { provider: "mock", modelId: "v-1" },
    react: () => {},
  });
  const ac = new AbortController();
  const api = {
    conversationId: "conv-look",
    callId: "c1",
    snapshot: async (doc: unknown) => (doc === LiveDoc ? { run: { inputs: ["r1"] } } : undefined),
  } as never;
  const res = (await look.execute({ ref: "inbound/small.png" } as never, api, { abortSignal: ac.signal } as never)) as {
    output: Array<{ text: string }>;
  };
  assert.equal(res.output[0]?.text, "一只小猫");
  assert.equal(seenSignal, ac.signal, "context.abortSignal 必须透传到视觉模型请求");
});

test("tags 无 danbooru.csv 时仍可查询 lora 与内置角色/风格", async () => {
  const { createTagsTool } = await import("../src/tools/tags/tool.ts");
  const { prompts, manifests } = loadMergedManifests();
  const tags = createTagsTool(manifests.get("tags")!, {
    prompts,
    mediaRoot: mkdtempSync(join(tmpdir(), "yg-tags-")),
    tagsCsv: join(tmpdir(), "nonexistent-danbooru.csv"),
    react: () => {},
  });
  const api = { conversationId: "1", callId: "c1" } as never;

  const listRes = (await tags.execute({ keyword: "lora" } as never, api, ctx)) as { output: Array<{ text: string }> };
  assert.match(listRes.output[0]?.text ?? "", /claude/);

  const charRes = (await tags.execute({ keyword: "claude" } as never, api, ctx)) as { output: Array<{ text: string }> };
  assert.match(charRes.output[0]?.text ?? "", /claude_girl_anima_lora_clean\.safetensors/);

  await assert.rejects(
    () => tags.execute({ keyword: "nonexistent_danbooru_tag_xyz" } as never, api, ctx),
    /danbooru\.csv/,
  );
});

test("remind 任务在 !conv 或终态异常时清理 RemindersDoc 死条目；非法 action 拒绝", async () => {
  const { createRemindTool } = await import("../src/tools/remind/tool.ts");
  const { prompts, manifests } = loadMergedManifests();
  const task = makeReminderTask({ messages: () => prompts.messages, drain: async () => {}, log: () => {} });

  // 1. !conv 清理死条目
  let docItems = [{ id: "101", at: 1000, note: "喝水", repeat: "none" as const, by: "u", createdAt: 500 }];
  let committedOutcome: unknown;
  await task.definition.phases.due(
    { input: { note: "喝水", at: 1000, repeat: "none", by: "u" } } as never,
    {
      taskId: 101,
      conversationId: 1,
      snapshot: async () => ({ items: docItems }),
      conversation: async () => undefined,
      commit: async (fn: (tx: unknown) => Promise<unknown>) => {
        committedOutcome = await fn({
          doc: async (d: unknown) => {
            assert.equal(d, RemindersDoc);
            return { get items() { return docItems; }, set items(v) { docItems = v; } };
          },
        });
      },
      now: () => 2000,
    } as never,
    ctx,
  );
  assert.equal(docItems.length, 0, "!conv 必须清理死条目");
  assert.equal((committedOutcome as { status?: string })?.status, "terminal");

  // 2. conv.submit 抛错清理死条目
  let docItems2 = [{ id: "102", at: 1000, note: "开会", repeat: "none" as const, by: "u", createdAt: 500 }];
  await task.definition.phases.due(
    { input: { note: "开会", at: 1000, repeat: "none", by: "u" } } as never,
    {
      taskId: 102,
      conversationId: 1,
      snapshot: async () => ({ items: docItems2 }),
      conversation: async () => ({
        submit: async () => { throw new Error("conv_closed"); },
      }),
      commit: async (fn: (tx: unknown) => Promise<unknown>) => {
        committedOutcome = await fn({
          doc: async () => ({ get items() { return docItems2; }, set items(v) { docItems2 = v; } }),
        });
      },
      now: () => 2000,
    } as never,
    ctx,
  );
  assert.equal(docItems2.length, 0, "conv.submit 异常必须清理死条目");
  assert.equal((committedOutcome as { status?: string })?.status, "terminal");

  // 3. remind 非法 action 拒绝
  const remind = createRemindTool(manifests.get("remind")!, {
    prompts,
    mediaRoot: mkdtempSync(join(tmpdir(), "yg-rem-")),
    reminderTask: task,
    react: () => {},
  })!;
  await assert.rejects(
    () => remind.execute({ action: "bogus" } as never, { conversationId: 1 } as never, ctx),
    /add|list|cancel/,
  );
});

test("wan_gif 传错参考图返 wan_gif_ref_bad 且不触发 onLongWork / 不锁 submitted；meme_add 非法参数不触发 onLongWork", async () => {
  const { createWanGifTool } = await import("../src/tools/wan_gif/tool.ts");
  const { createMemeAddTool } = await import("../src/tools/meme_add/tool.ts");
  const { prompts, manifests } = loadMergedManifests();
  const mediaRoot = mkdtempSync(join(tmpdir(), "yg-wangif-"));
  let wanLongWork = 0;

  const wanGif = createWanGifTool(manifests.get("wan_gif")!, {
    prompts,
    mediaRoot,
    wanImage: { apiKey: "k", baseUrl: "http://127.0.0.1:1" },
    onLongWork: () => { wanLongWork++; },
    react: () => {},
  });
  const api = {
    conversationId: "conv-wg",
    callId: "c1",
    snapshot: async (doc: unknown) => (doc === LiveDoc ? { run: { inputs: ["r-wg"] } } : undefined),
  } as never;

  await assert.rejects(
    () => wanGif.execute({ prompt: "挥手", ref: "inbound/missing.png" } as never, api, ctx),
    new RegExp(prompts.messages["wan_gif_ref_bad"]!),
  );
  assert.equal(wanLongWork, 0, "wan_gif_ref_bad 不得触发 onLongWork");
  // 同轮再试另一个坏 ref，应仍返 wan_gif_ref_bad 而不是 draw_uncertain（证明 submitted 未锁死）
  await assert.rejects(
    () => wanGif.execute({ prompt: "挥手", ref: "../escape.png" } as never, api, ctx),
    new RegExp(prompts.messages["wan_gif_ref_bad"]!),
  );

  // meme_add 非主人/缺情绪词不触发 onLongWork
  let memeLongWork = 0;
  mkdirSync(join(mediaRoot, "inbound"), { recursive: true });
  writeFileSync(join(mediaRoot, "inbound", "a.png"), PNG);
  const memeAdd = createMemeAddTool(manifests.get("meme_add")!, {
    prompts,
    mediaRoot,
    master: "1",
    triggerOf: () => ({ mentionsBot: false, userId: "999" }),
    onLongWork: () => { memeLongWork++; },
    react: () => {},
  })!;
  await assert.rejects(
    () => memeAdd.execute({ ref: "inbound/a.png", caption: "好笑", tags: ["开心"] } as never, api, ctx),
    new RegExp(prompts.messages["meme_add_master"]!),
  );
  assert.equal(memeLongWork, 0, "meme_add 非主人不得触发 onLongWork");
});
