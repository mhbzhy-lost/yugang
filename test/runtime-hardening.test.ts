import test from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, symlinkSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { LiveDoc } from "@earendil-works/pi-durable";
import { loadPrompts } from "../src/prompt/index.ts";
import { DEFAULT_LIMITS } from "../src/egress/policy.ts";
import { loadToolManifests } from "../src/tools/manifest.ts";
import { mergeToolMessages } from "../src/tools/loader.ts";
import { createSayWordsTool } from "../src/tools/say_words/tool.ts";
import { createSayMediaTool } from "../src/tools/say_media/tool.ts";
import { isQuoteForced } from "../src/tools/say-shared.ts";
import type { CompactResult } from "../src/compact.ts";
import {
  cleanupExpiredMedia,
  createCompactQueue,
  createSentStore,
  readJsonSafe,
  writeJsonAtomic,
} from "../src/app/runtime-helpers.ts";

const ROOT = fileURLToPath(new URL("../", import.meta.url));
const PNG = readFileSync(fileURLToPath(new URL("./fixtures/dot.png", import.meta.url)));

test("runtime-helpers：readJsonSafe 与 writeJsonAtomic 损坏回退且不留 .tmp", (t) => {
  const dir = mkdtempSync(join(tmpdir(), "yg-rt-json-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));

  const missingPath = join(dir, "missing.json");
  assert.deepEqual(readJsonSafe(missingPath, ["fallback"]), ["fallback"]);

  const corruptPath = join(dir, "corrupt.json");
  writeFileSync(corruptPath, "{broken");
  assert.deepEqual(readJsonSafe(corruptPath, [] as string[], (v): v is string[] => Array.isArray(v)), []);

  const wrongShapePath = join(dir, "wrong.json");
  writeFileSync(wrongShapePath, JSON.stringify({ notAnArray: true }));
  assert.deepEqual(readJsonSafe(wrongShapePath, ["ok"], (v): v is string[] => Array.isArray(v)), ["ok"]);

  const targetPath = join(dir, "nested", "data.json");
  writeJsonAtomic(targetPath, { a: 1, b: ["x"] });
  assert.deepEqual(JSON.parse(readFileSync(targetPath, "utf8")), { a: 1, b: ["x"] });
  const leftoverTmp = readdirSync(join(dir, "nested")).filter((n) => n.includes(".tmp"));
  assert.deepEqual(leftoverTmp, []);
});

test("runtime-helpers：createSentStore 损坏容错、严格封顶与原子写盘", (t) => {
  const dir = mkdtempSync(join(tmpdir(), "yg-rt-sent-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));

  const sentPath = join(dir, "sent.json");
  writeFileSync(sentPath, "[corrupt");
  const store = createSentStore(sentPath, 3);
  assert.equal(store.size, 0);

  assert.equal(store.mark("k1"), true);
  assert.equal(store.mark("k1"), false);
  assert.equal(store.mark("k2"), true);
  assert.equal(store.mark("k3"), true);
  assert.equal(store.mark("k4"), true);

  assert.equal(store.size, 3);
  assert.equal(store.has("k1"), false);
  assert.equal(store.has("k2"), true);
  assert.equal(store.has("k4"), true);

  const persisted = JSON.parse(readFileSync(sentPath, "utf8")) as string[];
  assert.deepEqual(persisted, ["k2", "k3", "k4"]);
  assert.deepEqual(readdirSync(dir).filter((n) => n.includes(".tmp")), []);

  // 默认上限 5000 封顶验证
  const defaultCapPath = join(dir, "sent-5000.json");
  const store5000 = createSentStore(defaultCapPath);
  for (let i = 0; i < 5010; i++) store5000.mark(`m:${i}`);
  assert.equal(store5000.size, 5000);
  assert.equal(store5000.has("m:0"), false);
  assert.equal(store5000.has("m:5009"), true);
});

test("runtime-helpers：createCompactQueue 串行排队、force 不被 below_threshold 吞掉、成功可复用且非空期 isCompacting 恒为 true", async () => {
  const queue = createCompactQueue<CompactResult>();
  const events: string[] = [];

  // 1) 同会话并发两次非 force：严格串行，第 2 次拿锁后复判阈值返回 below_threshold
  let releaseFirst!: () => void;
  const waitFirst = new Promise<void>((resolve) => { releaseFirst = resolve; });
  let compactedAlready = false;

  const p1 = queue.enqueue(101, false, async () => {
    events.push("p1:start");
    assert.equal(queue.isCompacting(101), true);
    await waitFirst;
    compactedAlready = true;
    events.push("p1:end");
    return { compacted: true, entries: 10, chars: 500, tokens: 9000 };
  });

  const p2 = queue.enqueue("101", false, async () => {
    events.push("p2:start");
    assert.equal(queue.isCompacting(101), true);
    events.push("p2:end");
    return compactedAlready
      ? { compacted: false, reason: "below_threshold", tokens: 100 }
      : { compacted: true, entries: 10, chars: 500, tokens: 9000 };
  });

  assert.equal(queue.isCompacting(101), true);
  releaseFirst();
  const [r1, r2] = await Promise.all([p1, p2]);
  assert.equal(r1.compacted, true);
  assert.equal(r2.compacted, false);
  assert.equal(r2.reason, "below_threshold");
  assert.deepEqual(events, ["p1:start", "p1:end", "p2:start", "p2:end"]);
  assert.equal(queue.isCompacting(101), false);

  // 2) force 排在非 force 后，前者 below_threshold 不得吞掉后者
  let releaseCheck!: () => void;
  const waitCheck = new Promise<void>((resolve) => { releaseCheck = resolve; });
  let forceRan = 0;

  const nonForceBelow = queue.enqueue(202, false, async () => {
    await waitCheck;
    return { compacted: false, reason: "below_threshold", tokens: 500 };
  });
  const forceAfterBelow = queue.enqueue(202, true, async () => {
    forceRan += 1;
    assert.equal(queue.isCompacting(202), true);
    return { compacted: true, entries: 3, chars: 120, tokens: 500 };
  });

  assert.equal(queue.isCompacting(202), true);
  releaseCheck();
  const [belowRes, forceRes] = await Promise.all([nonForceBelow, forceAfterBelow]);
  assert.equal(belowRes.compacted, false);
  assert.equal(forceRes.compacted, true);
  assert.equal(forceRan, 1);
  assert.equal(queue.isCompacting(202), false);

  // 3) force 排在非 force 后，前者已成功换页时后者可直接复用结果而不重复 compact
  let releaseCompact!: () => void;
  const waitCompact = new Promise<void>((resolve) => { releaseCompact = resolve; });
  let forceCalls = 0;
  let observedCompactingBetween = false;

  const nonForceOk = queue.enqueue(303, false, async () => {
    await waitCompact;
    return { compacted: true, entries: 8, chars: 320, tokens: 8500 };
  }).then((res) => {
    observedCompactingBetween = queue.isCompacting(303);
    return res;
  });
  const forceAfterOk = queue.enqueue(303, true, async () => {
    forceCalls += 1;
    return { compacted: true, entries: 1, chars: 10, tokens: 10 };
  });

  releaseCompact();
  const [okRes, reusedRes] = await Promise.all([nonForceOk, forceAfterOk]);
  assert.equal(observedCompactingBetween, true, "前一个任务结束但后继仍在排队时 isCompacting 必须保持 true");
  assert.equal(okRes.compacted, true);
  assert.deepEqual(reusedRes, okRes);
  assert.equal(forceCalls, 0);
  assert.equal(queue.isCompacting(303), false);

  // 4) 前置异常后后继仍执行且最终释放 isCompacting
  let releaseFail!: () => void;
  const waitFail = new Promise<void>((resolve) => { releaseFail = resolve; });
  const failing = queue.enqueue(404, false, async () => {
    await waitFail;
    throw new Error("compact_boom");
  });
  const afterFail = queue.enqueue(404, true, async () => ({ compacted: true, entries: 2, chars: 80 }));
  releaseFail();
  await assert.rejects(failing, /compact_boom/);
  assert.equal((await afterFail).compacted, true);
  assert.equal(queue.isCompacting(404), false);
});

test("runtime-helpers：cleanupExpiredMedia 仅清理 inbound/gen/voice 过期文件，绝不触碰 memes/meme-inbox/inbound-video", async (t) => {
  const mediaRoot = mkdtempSync(join(tmpdir(), "yg-rt-media-"));
  t.after(() => rmSync(mediaRoot, { recursive: true, force: true }));

  const dirs = ["inbound", "gen", "voice", "memes", "meme-inbox", "inbound-video"];
  for (const d of dirs) mkdirSync(join(mediaRoot, d), { recursive: true });

  const now = Date.now();
  const ttlMs = 7 * 86_400_000;
  const oldDate = new Date(now - ttlMs - 60_000);
  const freshDate = new Date(now - 60_000);

  const expiredTargets = [
    join(mediaRoot, "inbound", "old.png"),
    join(mediaRoot, "gen", "old.png"),
    join(mediaRoot, "voice", "old.wav"),
  ];
  const freshTargets = [
    join(mediaRoot, "inbound", "fresh.png"),
    join(mediaRoot, "gen", "fresh.png"),
    join(mediaRoot, "voice", "fresh.wav"),
  ];
  const protectedFiles = [
    join(mediaRoot, "memes", "old-meme.png"),
    join(mediaRoot, "meme-inbox", "old-inbox.png"),
    join(mediaRoot, "inbound-video", "old-video.mp4"),
  ];

  for (const f of [...expiredTargets, ...protectedFiles]) {
    writeFileSync(f, "old");
    utimesSync(f, oldDate, oldDate);
  }
  for (const f of freshTargets) {
    writeFileSync(f, "fresh");
    utimesSync(f, freshDate, freshDate);
  }

  // 符号链接即使在 inbound 下也不触碰目标
  const outsideFile = join(mediaRoot, "memes", "linked-target.png");
  writeFileSync(outsideFile, "keep");
  utimesSync(outsideFile, oldDate, oldDate);
  symlinkSync(outsideFile, join(mediaRoot, "inbound", "sym.png"));

  const deleted = await cleanupExpiredMedia(mediaRoot, ttlMs, now);
  assert.equal(deleted, 3);

  for (const f of expiredTargets) assert.equal(existsSync(f), false, `${f} 应被清理`);
  for (const f of freshTargets) assert.equal(existsSync(f), true, `${f} 未过期不应删除`);
  for (const f of protectedFiles) assert.equal(existsSync(f), true, `受保护目录 ${f} 绝不能删除`);
  assert.equal(existsSync(outsideFile), true);
});

test("isQuoteForced 与出口工具：reply 触发强制引用不依赖全局 lastMention/lastReply", async (t) => {
  assert.equal(isQuoteForced(undefined), false);
  assert.equal(isQuoteForced({ mentionsBot: false }), false);
  assert.equal(isQuoteForced({ mentionsBot: true }), true);
  assert.equal(isQuoteForced({ mentionsBot: false, reply: true }), true);

  const mediaRoot = mkdtempSync(join(tmpdir(), "yg-rt-say-"));
  t.after(() => rmSync(mediaRoot, { recursive: true, force: true }));
  mkdirSync(join(mediaRoot, "inbound"), { recursive: true });
  writeFileSync(join(mediaRoot, "inbound", "a.png"), PNG);

  const prompts = loadPrompts(join(ROOT, "prompt"));
  const manifests = loadToolManifests(join(ROOT, "src/tools"), { memeTags: prompts.memeTags });
  mergeToolMessages(manifests, prompts.messages);

  const outbox: Array<{ quoteForce?: boolean; quoteId?: number | string }> = [];
  const api = {
    conversationId: "conv-quote-test",
    callId: "call-1",
    snapshot: async (doc: unknown) => (doc === LiveDoc ? { run: { inputs: ["r1"] } } : undefined),
    commit: async (fn: (tx: unknown) => Promise<void>) =>
      fn({
        appendEntry: async () => ({ id: 1 }),
        doc: async () => ({ queue: outbox }),
      }),
  };

  const sayWords = createSayWordsTool(manifests.get("say_words")!, {
    prompts,
    mediaRoot,
    limits: { ...DEFAULT_LIMITS, mediaRoot },
    triggerOf: () => ({ messageId: 9001, mentionsBot: false, reply: true, kind: "answer" }),
  })!;
  await sayWords.execute({ text: "收到回复" } as never, api as never, {} as never);
  assert.equal(outbox.at(-1)?.quoteForce, true);
  assert.equal(outbox.at(-1)?.quoteId, 9001);

  const sayMedia = createSayMediaTool(manifests.get("say_media")!, {
    prompts,
    mediaRoot,
    limits: { ...DEFAULT_LIMITS, mediaRoot },
    triggerOf: () => ({ messageId: 9002, mentionsBot: false, reply: true, kind: "answer" }),
  })!;
  await sayMedia.execute({ media: "inbound/a.png" } as never, { ...api, callId: "call-2" } as never, {} as never);
  assert.equal(outbox.at(-1)?.quoteForce, true);
  assert.equal(outbox.at(-1)?.quoteId, 9002);
});

test("源码回归守卫：零 spawnSync 图像模块、runtime 竞态与泄露清理接线", () => {
  for (const rel of ["src/media/image-ops.ts", "src/media/shrink-image.ts", "src/media/gif-frames.ts"]) {
    const src = readFileSync(join(ROOT, rel), "utf8");
    assert.equal(src.includes("spawnSync"), false, `${rel} 不应再包含 spawnSync`);
  }

  const rt = readFileSync(join(ROOT, "src/app/runtime.ts"), "utf8");
  for (const forbidden of [
    "burstMustAnswer",
    "lastMention",
    "lastReply",
    "chatKeys.get(conversationId)",
    "mappingKeys.set(conv.id",
    "shrinkForModel",
  ]) {
    assert.equal(rt.includes(forbidden), false, `runtime.ts 不应再出现 ${forbidden}`);
  }

  assert.ok(rt.includes("async function compactWithGuard("), "必须保留 compactWithGuard 声明供切片测试");
  assert.match(rt, /compactQueue\.enqueue\(/, "compactWithGuard 必须接入 compactQueue");
  assert.match(rt, /drawStageSent\.delete\(subId\)/, "runSubmission finally 必须清理 drawStageSent");
  assert.match(rt, /shouldDownloadMedia\s*:/, "OneBot 必须注入 shouldDownloadMedia");
  assert.match(rt, /onReconnect\s*:/, "OneBot 必须注入 onReconnect");
  assert.match(rt, /weeklyStatsAsync\(/, "周报必须改用 weeklyStatsAsync");
  assert.match(rt, /cleanupExpiredMedia\(/, "必须接入 cleanupExpiredMedia 定时清理");
  assert.match(rt, /conversationLoading/, "conversationFor 必须使用 conversationLoading 单飞防重");
  assert.match(rt, /msg\.text === "\/压缩"[\s\S]*?conversationBusy\(conv\.id\)[\s\S]*?busy_reply/, "/压缩 遇忙必须复用 busy_reply 拒绝");
});
