import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  buildGifExtractArgs,
  finalizeGifFrame,
  GIF_FRAME_QSCALE,
  GIF_FRAME_TARGET_BYTES,
} from "../src/media/gif-frames.ts";

test("ffmpeg 抽帧参数必须在 -i 之后显式携带输出选项 -q:v 与 640px 缩放", () => {
  const args = buildGifExtractArgs("/tmp/a.gif", [0, 5], "/tmp/out/f%03d.jpg");
  const inputIdx = args.indexOf("-i");
  const qIdx = args.indexOf("-q:v");
  assert.notEqual(inputIdx, -1);
  assert.notEqual(qIdx, -1, "缺少 -q:v 参数");
  assert.ok(qIdx > inputIdx, "-q:v 必须是位于 -i 之后的输出选项");
  assert.equal(args[qIdx + 1], GIF_FRAME_QSCALE);
  assert.equal(args.at(-1), "/tmp/out/f%03d.jpg");
  const vfIdx = args.indexOf("-vf");
  assert.notEqual(vfIdx, -1);
  assert.match(args[vfIdx + 1] ?? "", /scale=w=640:h=640/);
});

test("单帧不超过 50KB 时直接返回原字节，不调用 shrink；空文件返回 null", () => {
  const dir = mkdtempSync(join(tmpdir(), "yg-gif-"));
  try {
    const empty = join(dir, "empty.jpg");
    writeFileSync(empty, Buffer.alloc(0));
    assert.equal(finalizeGifFrame(empty), null);

    const file = join(dir, "small.jpg");
    const raw = Buffer.alloc(12 * 1024, 0xaa);
    writeFileSync(file, raw);
    let calls = 0;
    const out = finalizeGifFrame(file, () => {
      calls += 1;
      return { ok: true, buffer: Buffer.from("shrunk"), mimeType: "image/jpeg" };
    });
    assert.equal(calls, 0);
    assert.deepEqual(out, raw);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("单帧超过 50KB 时调用 shrink 压回预算内；shrink 失败或未变小则回退保留原帧", () => {
  const dir = mkdtempSync(join(tmpdir(), "yg-gif-"));
  try {
    const file = join(dir, "big.jpg");
    const big = Buffer.alloc(GIF_FRAME_TARGET_BYTES + 4096, 0xbb);
    writeFileSync(file, big);

    const smaller = Buffer.alloc(24 * 1024, 0xcc);
    const shrunk = finalizeGifFrame(file, () => ({ ok: true, buffer: smaller, mimeType: "image/jpeg" }));
    assert.deepEqual(shrunk, smaller);

    const failed = finalizeGifFrame(file, () => ({ ok: false, reason: "fail" }));
    assert.deepEqual(failed, big, "shrink 失败时应回退原帧，不能丢帧");

    const bigger = Buffer.alloc(big.length + 100, 0xdd);
    const notSmaller = finalizeGifFrame(file, () => ({ ok: true, buffer: bigger, mimeType: "image/jpeg" }));
    assert.deepEqual(notSmaller, big, "shrink 未变小时应保留原帧");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
