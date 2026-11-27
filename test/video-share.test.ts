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
import { fileURLToPath } from "node:url";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { LiveDoc } from "@earendil-works/pi-durable";
import { biliOpusUrl, biliVideoBvidOfUrl, biliVideoUrl, bvidOfUrl } from "../src/external/video-links.ts";
import { clearViewedVideos, recordViewedVideo, viewedResourceCount, viewedVideoOf } from "../src/external/video-browse.ts";
import type { BiliClient } from "../src/external/bili-client.ts";
import { clearAllSeenLinks, extractLinks, recordSeenLinks, seenLinksOf } from "../src/egress/seen-links.ts";
import { shouldSendWorkingReceipt } from "../src/working-receipt.ts";
import { createVideoTool } from "../src/tools/video/tool.ts";
import { buildBiliVideoReport, createBiliVideoTool } from "../src/tools/bili_video/tool.ts";
import { loadToolManifests } from "../src/tools/manifest.ts";
import { mergeToolMessages } from "../src/tools/loader.ts";
import { loadPrompts } from "../src/prompt/index.ts";
import type { ToolPackageDeps } from "../src/tools/types.ts";

const PROMPTS = fileURLToPath(new URL("../prompt", import.meta.url));
const TOOL_ROOT = fileURLToPath(new URL("../src/tools/", import.meta.url));
const prompts = loadPrompts(PROMPTS);
const manifests = loadToolManifests(TOOL_ROOT, { memeTags: prompts.memeTags });
mergeToolMessages(manifests, prompts.messages);

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

test("biliVideoBvidOfUrl 仅认 bilibili.com/video/BV 路径并拦截 av/opus/query/伪造域名", () => {
  for (const url of [
    "https://www.bilibili.com/video/BV1eqZJYaESc",
    "https://www.bilibili.com/video/BV1eqZJYaESc/?spm_id_from=1#2",
    "https://m.bilibili.com/video/BV1eqZJYaESc/",
    "https://bilibili.com/video/BV1eqZJYaESc",
  ]) {
    assert.equal(biliVideoBvidOfUrl(url), "BV1eqZJYaESc", `${url} 没认出 BV`);
  }
  for (const url of [
    "https://www.bilibili.com/video/av115138879295226/",
    "https://www.bilibili.com/opus/123?ref=BV1eqZJYaESc",
    "https://www.bilibili.com/read/cv123/BV1eqZJYaESc",
    "https://bilibili.com.evil.example/video/BV1eqZJYaESc",
    "https://evil.example/video/BV1eqZJYaESc",
    "javascript:https://www.bilibili.com/video/BV1eqZJYaESc",
    "not-a-url",
  ]) {
    assert.equal(biliVideoBvidOfUrl(url), undefined, `${url} 不该被认成 B 站视频`);
  }
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

test("video：校验失败不触发 onLongWork、b23.tv 展开释放 body、opus 计次且图片限 15MB、透传 signal 与 AbortError 原样上抛", async () => {
  let longWorkCalls = 0;
  const round = "round-video-hardening";
  const makeApi = () => ({
    conversationId: "conv-video",
    callId: 1,
    snapshot: async (doc: unknown) => (doc === LiveDoc ? { run: { inputs: [round] } } : undefined),
  }) as never;
  const makeDeps = (over: Partial<ToolPackageDeps> = {}): ToolPackageDeps => ({
    prompts,
    onLongWork: () => { longWorkCalls += 1; },
    ...over,
  } as ToolPackageDeps);

  // 1. 参数校验失败不触发 onLongWork
  {
    longWorkCalls = 0;
    const tool = createVideoTool(manifests.get("video")!, makeDeps());
    await assert.rejects(tool.execute({ url: "   " } as never, makeApi(), BACKGROUND_CONTEXT));
    assert.equal(longWorkCalls, 0, "参数校验失败不应触发 onLongWork");
  }

  // 2. b23.tv 展开后取消 body、透传 signal 到 BiliClient
  {
    longWorkCalls = 0;
    let b23Cancelled = false;
    const seenSignals: (AbortSignal | undefined)[] = [];
    const ctrl = new AbortController();
    const mockClient: BiliClient = {
      popular: async () => [],
      ranking: async () => [],
      related: async () => [],
      view: async (_bvid: string, sig?: AbortSignal) => {
        seenSignals.push(sig);
        return {
          bvid: "BV1eqZJYaESc",
          aid: 100,
          title: "测试视频",
          desc: "简介",
          durationSeconds: 120,
          pubdate: 1700000000,
          owner: { mid: 1, name: "UP" },
          stat: { view: 10, danmaku: 1, reply: 1, favorite: 1, coin: 1, share: 1, like: 1 },
          cid: 200,
        };
      },
      danmakuXml: async (_cid: string, sig?: AbortSignal) => { seenSignals.push(sig); return ""; },
      hotReplies: async (_oid: string | number, _type?: number, sig?: AbortSignal) => { seenSignals.push(sig); return []; },
      upCard: async () => ({ mid: 1, name: "UP", fans: 1, level: 5, officialType: -1 }),
      setDailyBudget: () => {},
      snapshot: () => ({ day: "2026-11-28", used: 0, budget: 60, intervalMs: 0, tripped: [], hasBuvid3: true }),
    } as BiliClient;
    const mockFetch = (async () => {
      const res = new Response(new ReadableStream({ start() {}, cancel() { b23Cancelled = true; } }), { status: 200 });
      Object.defineProperty(res, "url", { value: "https://www.bilibili.com/video/BV1eqZJYaESc" });
      return res;
    }) as unknown as typeof fetch;

    const tool = (createVideoTool as (m: unknown, d: unknown, o?: unknown) => ReturnType<typeof createVideoTool>)(
      manifests.get("video")!,
      makeDeps(),
      { fetch: mockFetch, client: mockClient },
    );
    await tool.execute({ url: "https://b23.tv/abc123" } as never, makeApi(), { abortSignal: ctrl.signal } as never);
    assert.equal(b23Cancelled, true, "b23.tv 展开后应立即 cancel body");
    assert.deepEqual(seenSignals, [ctrl.signal, ctrl.signal, ctrl.signal], "video 应透传 abortSignal 给 BiliClient");
    assert.equal(longWorkCalls, 1);

    // AbortError 原样上抛不被吞成视频没打开
    const abortClient: BiliClient = {
      ...mockClient,
      view: async () => {
        const err = new Error("aborted");
        err.name = "AbortError";
        throw err;
      },
    };
    const abortTool = (createVideoTool as (m: unknown, d: unknown, o?: unknown) => ReturnType<typeof createVideoTool>)(
      manifests.get("video")!,
      makeDeps(),
      { fetch: mockFetch, client: abortClient },
    );
    await assert.rejects(
      abortTool.execute({ url: "https://www.bilibili.com/video/BV1eqZJYaESc" } as never, makeApi(), { abortSignal: ctrl.signal } as never),
      (e: unknown) => e instanceof Error && e.name === "AbortError",
    );
  }

  // 3. opus 计入观看次数且图片下载有 15MB 上限
  {
    clearViewedVideos(round);
    let oversizedPicCancelled = false;
    const mockFetch = (async (url: string | URL | Request) => {
      const u = String(url);
      if (u.includes("opus/detail")) {
        return new Response(JSON.stringify({
          code: 0,
          data: {
            item: {
              modules: [
                { module_type: "MODULE_TYPE_AUTHOR", module_author: { name: "作者", pub_time: "今天" } },
                {
                  module_type: "MODULE_TYPE_CONTENT",
                  module_content: {
                    paragraphs: [{
                      text: { nodes: [{ type: "TEXT_NODE_TYPE_WORD", word: { words: "动态正文" } }] },
                      pic: { pics: [{ url: "https://i0.hdslb.com/big.jpg" }] },
                    }],
                  },
                },
              ],
            },
          },
        }), { status: 200 });
      }
      return new Response(new ReadableStream({ start() {}, cancel() { oversizedPicCancelled = true; } }), {
        status: 200,
        headers: { "content-length": String(16 * 1024 * 1024), "content-type": "image/jpeg" },
      });
    }) as unknown as typeof fetch;
    const tool = (createVideoTool as (m: unknown, d: unknown, o?: unknown) => ReturnType<typeof createVideoTool>)(
      manifests.get("video")!,
      makeDeps({ models: {} as never, visionModel: {} as never }),
      { fetch: mockFetch },
    );
    await tool.execute({ url: "https://www.bilibili.com/opus/999" } as never, makeApi(), BACKGROUND_CONTEXT);
    assert.equal(oversizedPicCancelled, true, "opus 超 15MB 图片应 cancel 并跳过");
    assert.equal(viewedResourceCount(round), 1, "opus 应计入观看次数");
    clearViewedVideos(round);
  }
});

test("bili_video：透传 signal 到 BiliClient", async () => {
  const seenSignals: (AbortSignal | undefined)[] = [];
  const ctrl = new AbortController();
  const mockClient: BiliClient = {
    popular: async () => [],
    ranking: async () => [],
    related: async () => [],
    view: async (_bvid: string, sig?: AbortSignal) => {
      seenSignals.push(sig);
      return {
        bvid: "BV1eqZJYaESc",
        aid: 100,
        title: "测试视频",
        desc: "简介",
        durationSeconds: 120,
        pubdate: 1700000000,
        owner: { mid: 1, name: "UP" },
        stat: { view: 10, danmaku: 1, reply: 1, favorite: 1, coin: 1, share: 1, like: 1 },
        cid: 200,
      };
    },
    upCard: async (_mid: string | number, sig?: AbortSignal) => {
      seenSignals.push(sig);
      return { mid: 1, name: "UP", fans: 100, level: 6, officialType: -1 };
    },
    hotReplies: async (_oid: string | number, _type?: number, sig?: AbortSignal) => {
      seenSignals.push(sig);
      return [];
    },
    danmakuXml: async (_cid: string, sig?: AbortSignal) => {
      seenSignals.push(sig);
      return "";
    },
    setDailyBudget: () => {},
    snapshot: () => ({ day: "2026-11-28", used: 0, budget: 60, intervalMs: 0, tripped: [], hasBuvid3: true }),
  } as BiliClient;

  await (buildBiliVideoReport as (c: BiliClient, a: unknown, s?: AbortSignal) => Promise<string>)(
    mockClient,
    { bvid: "BV1eqZJYaESc", withComments: true, withDanmaku: true },
    ctrl.signal,
  );
  assert.deepEqual(seenSignals, [ctrl.signal, ctrl.signal, ctrl.signal, ctrl.signal]);
  void createBiliVideoTool;
});
