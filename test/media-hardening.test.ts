import test from "node:test";
import assert from "node:assert/strict";
import {
  chmodSync,
  existsSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import http from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import sharp from "sharp";
import { describeImage } from "../src/media/describe.ts";
import {
  lookShrinkViaWorkerAsync,
  normalizeInitViaWorkerAsync,
  readFileHead,
  shrinkViaWorkerAsync,
  toJpegViaWorkerAsync,
} from "../src/media/image-ops.ts";
import { InboundVideoStore } from "../src/media/inbound-video.ts";
import { addMeme, checkMemeSource, loadMemeIndex } from "../src/media/meme-store.ts";
import { inlineImageOfAsync, shrinkForModelAsync } from "../src/media/shrink-image.ts";
import { spawnCapture } from "../src/media/spawn-capture.ts";
import { describeVideoFrames, extractVideoFrames } from "../src/media/video.ts";
import { generateWanGif, readWanGifRef } from "../src/media/wan-video.ts";

const PNG_HEAD = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

function makePngBytes(size = 2048): Buffer {
  const buf = Buffer.alloc(size, 0x42);
  PNG_HEAD.copy(buf, 0);
  return buf;
}

function isPidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

// =====================================================================
// 1. spawnCapture：已中止不 spawn、SIGTERM→SIGKILL 升级、exit 后等 close、stderr 超限
// =====================================================================

test("spawnCapture：signal 已中止时不拉起子进程直接返回 status=null", async (t) => {
  const dir = mkdtempSync(join(tmpdir(), "yg-spawn-abort-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const marker = join(dir, "spawned.txt");
  const ac = new AbortController();
  ac.abort();

  const res = await spawnCapture(
    process.execPath,
    ["-e", `require("node:fs").writeFileSync(${JSON.stringify(marker)}, "1")`],
    { timeoutMs: 5000, signal: ac.signal },
  );
  assert.equal(res.status, null);
  assert.equal(existsSync(marker), false, "已中止时不得 spawn 子进程");
});

test("spawnCapture：忽略 SIGTERM 的子进程超时/取消后升级 SIGKILL，且在真正退出后才 resolve", async (t) => {
  const dir = mkdtempSync(join(tmpdir(), "yg-spawn-kill-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const pidFile = join(dir, "child.pid");
  const script = `
    const fs = require("node:fs");
    process.on("SIGTERM", () => {});
    fs.writeFileSync(${JSON.stringify(pidFile)}, String(process.pid));
    setInterval(() => {}, 1000);
  `;
  const ac = new AbortController();
  const promise = spawnCapture(process.execPath, ["-e", script], { timeoutMs: 10_000, signal: ac.signal });
  // 等子进程完成 SIGTERM 处理器注册后再中止，避免并发重负载下在 V8 启动期即被默认 SIGTERM 杀掉
  while (!existsSync(pidFile)) await new Promise((r) => setTimeout(r, 15));
  const started = Date.now();
  ac.abort();
  const res = await promise;
  const elapsed = Date.now() - started;

  assert.equal(res.status, null);
  assert.ok(elapsed >= 1300, `应等 SIGTERM 宽限再 SIGKILL（实际 ${elapsed}ms）`);
  const pid = Number(readFileSync(pidFile, "utf8").trim());
  assert.ok(Number.isInteger(pid) && pid > 0);
  assert.equal(isPidAlive(pid), false, "resolve 时子进程必须已被 SIGKILL 彻底结束");
});

test("spawnCapture：stderr 超过 maxBytes 时终止子进程并标 status=null", async () => {
  const script = `
    const chunk = "e".repeat(4096);
    const id = setInterval(() => process.stderr.write(chunk), 5);
    setTimeout(() => clearInterval(id), 10000);
  `;
  const res = await spawnCapture(process.execPath, ["-e", script], {
    timeoutMs: 10_000,
    maxBytes: 1024,
  });
  assert.equal(res.status, null);
  assert.ok(res.stderr.length <= 1024);
});

test("spawnCapture：子进程 exit 后若孙进程占住 stdio 超过 2s，销毁 stdio 并 settle", async () => {
  const script = `
    const { spawn } = require("node:child_process");
    const grand = spawn(process.execPath, ["-e", "setTimeout(() => {}, 10000)"], {
      stdio: ["ignore", "inherit", "inherit"],
    });
    grand.unref();
    process.stdout.write("hi");
    process.exit(0);
  `;
  const started = Date.now();
  const res = await spawnCapture(process.execPath, ["-e", script], { timeoutMs: 15_000 });
  const elapsed = Date.now() - started;
  assert.equal(res.status, 0);
  assert.equal(res.stdout.toString(), "hi");
  assert.ok(elapsed < 5000, `exit 后应在 ~2s 内销毁 stdio 返回，不得等满 10s（实际 ${elapsed}ms）`);
});

// =====================================================================
// 2. wan-video：临时 .mp4 零残留、失败不留 .gif、即时取消、防伪装与符号链接
// =====================================================================

test("generateWanGif：已中止 signal 立即 reject 不空等 15s；轮询期间取消亦立即退出", async (t) => {
  const dir = mkdtempSync(join(tmpdir(), "yg-wan-abort-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));

  let requests = 0;
  const server = http.createServer((req, res) => {
    requests += 1;
    req.resume();
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({ output: { task_id: "task-1" } }));
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  t.after(() => new Promise<void>((r) => server.close(() => r())));
  const port = (server.address() as { port: number }).port;
  const baseUrl = `http://127.0.0.1:${port}`;

  // 1) 已中止 signal：零请求、立刻 reject
  const pre = new AbortController();
  pre.abort(new DOMException("aborted", "AbortError"));
  const t0 = Date.now();
  await assert.rejects(
    generateWanGif({ apiKey: "k", baseUrl, prompt: "cat", mediaRoot: dir, signal: pre.signal }),
  );
  assert.equal(requests, 0);
  assert.ok(Date.now() - t0 < 500);

  // 2) 轮询睡眠期间中止：不空等 15s
  const mid = new AbortController();
  setTimeout(() => mid.abort(new DOMException("aborted", "AbortError")), 80);
  const t1 = Date.now();
  await assert.rejects(
    generateWanGif({ apiKey: "k", baseUrl, prompt: "cat", mediaRoot: dir, signal: mid.signal }),
  );
  assert.ok(Date.now() - t1 < 1500, "轮询等待期间取消不得等满 15s");
});

test("generateWanGif：成功与转换失败/取消均不在 gen/ 残留 .mp4，失败/取消不残留半成品 .gif", async (t) => {
  const dir = mkdtempSync(join(tmpdir(), "yg-wan-clean-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const fakeBin = join(dir, "bin");
  const mediaRoot = join(dir, "media");
  const modeFile = join(dir, "ffmpeg-mode");
  // 用 node 写一个假 ffmpeg 放到 PATH 最前，分别模拟成功、失败写半成品、挂起被取消
  const fakeFfmpeg = join(fakeBin, "ffmpeg");
  const prevPath = process.env["PATH"] ?? "";
  process.env["PATH"] = `${fakeBin}:${prevPath}`;
  t.after(() => {
    process.env["PATH"] = prevPath;
  });

  await import("node:fs/promises").then((fs) => fs.mkdir(fakeBin, { recursive: true }));
  writeFileSync(
    fakeFfmpeg,
    `#!${process.execPath}
const fs = require("node:fs");
const mode = fs.readFileSync(${JSON.stringify(modeFile)}, "utf8").trim();
const out = process.argv[process.argv.length - 1];
if (mode === "ok") {
  fs.writeFileSync(out, Buffer.from("GIF89a-ok"));
  process.exit(0);
} else if (mode === "fail") {
  fs.writeFileSync(out, Buffer.from("GIF89a-partial"));
  process.exit(1);
} else {
  fs.writeFileSync(out, Buffer.from("GIF89a-partial"));
  setInterval(() => {}, 1000);
}
`,
  );
  chmodSync(fakeFfmpeg, 0o755);

  let videoRequested = false;
  const server = http.createServer((req, res) => {
    req.resume();
    if (req.method === "POST") {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ output: { task_id: "t-1" } }));
      return;
    }
    if (req.url?.startsWith("/api/v1/tasks/")) {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ output: { task_status: "SUCCEEDED", video_url: `${baseUrl}/video.mp4` } }));
      return;
    }
    if (req.url === "/video.mp4") {
      videoRequested = true;
      res.writeHead(200, { "content-type": "video/mp4" });
      res.end(Buffer.alloc(1024, 0x11));
      return;
    }
    res.writeHead(404);
    res.end();
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  t.after(() => new Promise<void>((r) => server.close(() => r())));
  const baseUrl = `http://127.0.0.1:${(server.address() as { port: number }).port}`;

  const runWithSinglePollTick = async (mode: "ok" | "fail" | "hang", signal?: AbortSignal): Promise<string> => {
    videoRequested = false;
    writeFileSync(modeFile, mode);
    t.mock.timers.enable({ apis: ["setTimeout"] });
    const p = generateWanGif({ apiKey: "k", baseUrl, prompt: "cat", mediaRoot, signal });
    while (!videoRequested) {
      t.mock.timers.tick(15_000);
      await new Promise((r) => setImmediate(r));
    }
    t.mock.timers.reset();
    return p;
  };

  // 成功：生成 1 个 .gif，gen/ 中无 .mp4
  const gifName = await runWithSinglePollTick("ok");
  assert.match(gifName, /\.gif$/);
  const genFilesAfterOk = readdirSync(join(mediaRoot, "gen"));
  assert.deepEqual(genFilesAfterOk, [gifName]);
  assert.equal(genFilesAfterOk.some((f) => f.endsWith(".mp4")), false);

  // 失败：ffmpeg 写了半成品 gif 后 exit(1)，不残留新 .gif 或 .mp4
  await assert.rejects(runWithSinglePollTick("fail"), /wan_gif_convert/);
  assert.deepEqual(readdirSync(join(mediaRoot, "gen")), [gifName], "失败不得残留半成品 .gif 或 .mp4");

  // 取消：ffmpeg 写了半成品 gif 后挂起，signal 中止后不残留新 .gif 或 .mp4
  const ac = new AbortController();
  setTimeout(() => ac.abort(new DOMException("aborted", "AbortError")), 150);
  await assert.rejects(runWithSinglePollTick("hang", ac.signal));
  assert.deepEqual(readdirSync(join(mediaRoot, "gen")), [gifName], "取消不得残留半成品 .gif 或 .mp4");
});

test("readWanGifRef：拒绝伪装扩展名与符号链接", async (t) => {
  const dir = mkdtempSync(join(tmpdir(), "yg-wan-ref-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const inbound = join(dir, "inbound");
  await import("node:fs/promises").then((fs) => fs.mkdir(inbound, { recursive: true }));

  const validPng = join(inbound, "real.png");
  writeFileSync(validPng, makePngBytes(2048));
  const ok = readWanGifRef(dir, "inbound/real.png");
  assert.equal(ok?.ext, "png");

  // 伪装扩展名：.png 文件实为纯文本
  const fakePng = join(inbound, "fake.png");
  writeFileSync(fakePng, Buffer.from("not really a png image"));
  assert.throws(() => readWanGifRef(dir, "inbound/fake.png"), /wan_gif_ref_bad/);

  // 符号链接
  const linkPng = join(inbound, "sym.png");
  symlinkSync(validPng, linkPng);
  assert.throws(() => readWanGifRef(dir, "inbound/sym.png"), /wan_gif_ref_bad/);
});

// =====================================================================
// 3. meme-store：index.json 损坏备份 .corrupt.* 并拒写，checkMemeSource 仅读 16B
// =====================================================================

test("addMeme：memes/index.json 损坏时备份 .corrupt.* 并抛错拒写，绝不清空原库", async (t) => {
  const dir = mkdtempSync(join(tmpdir(), "yg-meme-corrupt-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const memesDir = join(dir, "memes");
  const inboundDir = join(dir, "inbound");
  await import("node:fs/promises").then(async (fs) => {
    await fs.mkdir(memesDir, { recursive: true });
    await fs.mkdir(inboundDir, { recursive: true });
  });

  const corruptContent = '{"broken": [1, 2';
  writeFileSync(join(memesDir, "index.json"), corruptContent);
  writeFileSync(join(inboundDir, "a.png"), makePngBytes(2048));

  await assert.rejects(
    addMeme({ mediaRoot: dir, source: "inbound/a.png", caption: "测试", tags: ["开心"] }),
  );

  // 原 index.json 未被覆盖清空，且生成了 .corrupt.* 备份
  assert.equal(readFileSync(join(memesDir, "index.json"), "utf8"), corruptContent);
  const files = readdirSync(memesDir);
  assert.ok(files.some((f) => f.startsWith("index.json.corrupt.")), `应有 .corrupt.* 备份：${files.join(",")}`);
  assert.equal(files.filter((f) => f.endsWith(".png")).length, 0, "拒写期间不得写入图片文件");
  assert.deepEqual(loadMemeIndex(dir), []);
});

test("readFileHead 与 checkMemeSource：只读取文件头部字节", async (t) => {
  const dir = mkdtempSync(join(tmpdir(), "yg-head-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const inboundDir = join(dir, "inbound");
  await import("node:fs/promises").then((fs) => fs.mkdir(inboundDir, { recursive: true }));
  const big = makePngBytes(512 * 1024);
  const p = join(inboundDir, "big.png");
  writeFileSync(p, big);

  const head = readFileHead(p, 16);
  assert.equal(head.length, 16);
  assert.ok(head.equals(big.subarray(0, 16)));

  const check = checkMemeSource(dir, "inbound/big.png", 1024 * 1024);
  assert.equal(check.ok, true);
});

// =====================================================================
// 4. describe & video：429 退避可中止、并发 ≤ 2、损坏 JSON 抛 video_decode_failed
// =====================================================================

test("describeImage：429 退避期间响应 AbortSignal 立即中止，不空等 2.5s", async () => {
  let calls = 0;
  const models = {
    getModel: () => ({ provider: "stub", modelId: "stub" }),
    streamSimple: () => {
      calls += 1;
      return {
        result: async () => ({
          content: [],
          stopReason: "error",
          errorMessage: "429: rate limited",
        }),
      };
    },
  } as never;

  const ac = new AbortController();
  setTimeout(() => ac.abort(), 60);
  const started = Date.now();
  const res = await describeImage(
    { models, visionModel: { provider: "stub", modelId: "stub" }, prompts: { messages: {} } as never },
    "AAAA",
    "image/jpeg",
    ac.signal,
  );
  const elapsed = Date.now() - started;
  assert.deepEqual(res, { ok: false, reason: "failed" });
  assert.equal(calls, 1);
  assert.ok(elapsed < 500, `429 退避期间应立刻中止（实际 ${elapsed}ms）`);
});

test("describeVideoFrames：6 帧描述并发严格 <= 2", async (t) => {
  const dir = mkdtempSync(join(tmpdir(), "yg-video-conc-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const frames = Array.from({ length: 6 }, (_, i) => {
    const p = join(dir, `f${i}.jpg`);
    writeFileSync(p, Buffer.from([0xff, 0xd8, 0xff, i]));
    return { time: i * 5, path: p, width: 640 };
  });

  let active = 0;
  let peak = 0;
  const models = {
    getModel: () => ({ provider: "stub", modelId: "stub" }),
    streamSimple: () => ({
      result: async () => {
        active += 1;
        peak = Math.max(peak, active);
        await new Promise((r) => setTimeout(r, 40));
        active -= 1;
        return { content: [{ type: "text", text: "一帧画面" }], stopReason: "stop" };
      },
    }),
  } as never;

  const out = await describeVideoFrames(
    { models, visionModel: { provider: "stub", modelId: "stub" }, prompts: { messages: {} } as never },
    { durationSeconds: 30, coveredSeconds: 30, frames, failedFrames: 0 },
  );
  assert.equal(out.lines.length, 6);
  assert.equal(out.failed, 0);
  assert.ok(peak <= 2 && peak >= 1, `并发上限应为 2（实际峰值 ${peak}）`);
});

test("extractVideoFrames：损坏 JSON 输出统一抛 video_decode_failed", async (t) => {
  const dir = mkdtempSync(join(tmpdir(), "yg-video-badjson-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const fakePython = join(dir, "fake-python");
  writeFileSync(fakePython, `#!/bin/sh\necho "{not-valid-json"\nexit 0\n`);
  chmodSync(fakePython, 0o755);

  const prev = process.env["VIDEO_PYTHON"];
  process.env["VIDEO_PYTHON"] = fakePython;
  t.after(() => {
    if (prev === undefined) delete process.env["VIDEO_PYTHON"];
    else process.env["VIDEO_PYTHON"] = prev;
  });

  await assert.rejects(
    extractVideoFrames({ kind: "local", file: join(dir, "in.mp4") }, dir),
    (err: unknown) => err instanceof Error && err.message === "video_decode_failed",
  );
});

// =====================================================================
// 5. InboundVideoStore：命中内存缓存不重复全扫 200 文件
// =====================================================================

test("InboundVideoStore.bind：首次加载后命中内存缓存，不再对 200 文件反复 stat/read", async (t) => {
  const dir = mkdtempSync(join(tmpdir(), "yg-ivstore-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const store = new InboundVideoStore(dir);
  const chatKey = "qq:group:1001";
  const convId = "99";
  const refs: string[] = [];
  for (let i = 0; i < 200; i++) {
    refs.push(store.register(chatKey, { kind: "video", fileId: `fid-${i}`, name: `v${i}.mp4` }).ref);
  }
  // 冷启动写入 seen-99.json 并预热缓存
  store.bind(convId, "r1", chatKey, refs);

  // 删除磁盘上的 seen-99.json 以证明后续 bind 命中内存缓存而不走磁盘全扫
  const seenFile = join(dir, "inbound-video", "1001", `seen-${convId}.json`);
  rmSync(seenFile, { force: true });

  store.bind(convId, "r2", chatKey, []);
  const newest = refs.at(-1)!;
  // 若未命中缓存，seen-99.json 已删，r2 会是空集；命中缓存则仍保留全部 200 条
  await assert.rejects(
    store.download(convId, "r2", newest, dir, async () => {
      throw new Error("stop_before_network");
    }),
    /stop_before_network/,
  );

  // 新注入 1 条时同步刷新磁盘与内存缓存
  const extra = store.register(chatKey, { kind: "video", fileId: "fid-extra", name: "extra.mp4" }).ref;
  store.bind(convId, "r3", chatKey, [extra]);
  assert.equal(existsSync(seenFile), true, "新增视频时应同步写回 seen 索引");
});

// =====================================================================
// 6. 异步图像底座：不阻塞事件循环、heif 临时目录清理、Async 导出可用
// =====================================================================

test("异步图像底座：shrinkViaWorkerAsync / inlineImageOfAsync 正常出图且不阻塞事件循环，临时目录清理无残留", async (t) => {
  const dir = mkdtempSync(join(tmpdir(), "yg-async-img-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const imgPath = join(dir, "sample.png");
  const pngBuf = await sharp({
    create: { width: 1600, height: 1200, channels: 4, background: { r: 20, g: 120, b: 220, alpha: 1 } },
  })
    .png()
    .toBuffer();
  writeFileSync(imgPath, pngBuf);

  // 记录调用前 tmpdir 里的 yugang-img-* 数量
  const beforeTmp = new Set(readdirSync(tmpdir()).filter((n) => n.startsWith("yugang-img-")));

  let ticks = 0;
  const timer = setInterval(() => {
    ticks += 1;
  }, 15);
  t.after(() => clearInterval(timer));

  const [shrunk, looked, inited, jpeged, inlined] = await Promise.all([
    shrinkViaWorkerAsync(imgPath),
    lookShrinkViaWorkerAsync(imgPath),
    normalizeInitViaWorkerAsync(imgPath),
    toJpegViaWorkerAsync(imgPath),
    inlineImageOfAsync(imgPath),
  ]);

  assert.equal(shrunk.ok, true);
  assert.ok(looked && looked.length > 0);
  assert.ok(inited && inited.subarray(0, 8).equals(PNG_HEAD));
  assert.ok(jpeged && jpeged.subarray(0, 3).toString("hex") === "ffd8ff");
  assert.equal(inlined.ok, true);
  assert.ok(ticks >= 1, `异步图像 worker 期间事件循环定时器应能触发（ticks=${ticks}）`);

  // 已中止 signal：直接失败且不遗留临时目录
  const ac = new AbortController();
  ac.abort();
  const aborted = await shrinkForModelAsync({ file: imgPath, signal: ac.signal });
  assert.equal(aborted.ok, false);

  const afterTmp = readdirSync(tmpdir()).filter((n) => n.startsWith("yugang-img-") && !beforeTmp.has(n));
  assert.deepEqual(afterTmp, [], "所有调用级临时目录必须在 finally 中清理");
});
