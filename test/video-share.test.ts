/**
 * 「看过的视频就应该能发出来」的机械兜底（2026-11-05 主人反馈）。
 *
 * 两件事：
 *  1. video 返回的 canonical 链接要能被 say_words 的链接白名单登记；
 *     并且本轮实际看过的 BV，无论链接写法（query / 尾斜杠 / 子域）都放行。
 *  2. 重耗时工具的机械回执只在有人在等的 answer 轮发；自由交流 / 开窗注入 / 自己逛
 *     的轮里没人问，不许冒「稍等」。
 */
import test from "node:test";
import assert from "node:assert/strict";
import { biliOpusUrl, biliVideoUrl, bvidOfUrl } from "../src/external/video-links.ts";
import { clearAllSeenLinks, extractLinks, recordSeenLinks, seenLinksOf } from "../src/egress/seen-links.ts";
import { clearViewedVideos, recordViewedVideo, viewedVideoOf } from "../src/external/video-browse.ts";
import { shouldSendWorkingReceipt } from "../src/working-receipt.ts";

test("video 返回的 canonical 链接能被白名单原样登记", () => {
  const round = {};
  const url = biliVideoUrl("BV1eqZJYaESc");
  assert.equal(url, "https://www.bilibili.com/video/BV1eqZJYaESc");
  recordSeenLinks(round, extractLinks(`《标题》\n链接：${url}`));
  assert.ok(seenLinksOf(round).has(url), "canonical 链接没进白名单");
  clearAllSeenLinks();
});

test("看过的 BV 按 BV 认链接：query / 尾斜杠 / 子域变体都算", () => {
  const round = "round-viewed";
  recordViewedVideo(round, "BV1eqZJYaESc");
  for (const url of [
    "https://www.bilibili.com/video/BV1eqZJYaESc",
    "https://www.bilibili.com/video/BV1eqZJYaESc/?spm_id_from=333.999",
    "https://m.bilibili.com/video/BV1eqZJYaESc",
  ]) {
    assert.equal(bvidOfUrl(url), "BV1eqZJYaESc", `${url} 没认出 BV`);
    assert.ok(viewedVideoOf(round).has(bvidOfUrl(url)!), `${url} 没被「看过」放行`);
  }
  clearViewedVideos(round);
  assert.equal(viewedVideoOf(round).size, 0, "轮末没清空 viewed");
});

test("非 bilibili 域即使带 BV 也不算看过", () => {
  assert.equal(bvidOfUrl("https://evil.example/video/BV1eqZJYaESc"), undefined);
  assert.equal(bvidOfUrl("https://bilibili.com.evil.example/video/BV1eqZJYaESc"), undefined);
});

test("图文动态也有 canonical 链接", () => {
  assert.equal(biliOpusUrl("12345"), "https://www.bilibili.com/opus/12345");
});

test("机械回执只在有人等的 answer 轮发", () => {
  assert.equal(shouldSendWorkingReceipt(undefined, "video"), true, "缺省轮类型按 answer");
  assert.equal(shouldSendWorkingReceipt("answer", "video"), true);
  assert.equal(shouldSendWorkingReceipt("ambient", "video"), false, "自由交流轮不该冒回执");
  assert.equal(shouldSendWorkingReceipt("injection", "video"), false, "开窗注入/主动逛轮不该冒回执");
  assert.equal(shouldSendWorkingReceipt("worker", "video"), false);
  assert.equal(shouldSendWorkingReceipt("injection", "restart"), true, "重启前必须告知");
});
