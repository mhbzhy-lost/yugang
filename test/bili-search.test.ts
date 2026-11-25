/**
 * bili_search —— 基于 DeepSeek Search 的 B 站视频关键词检索（替换旧固定榜单工具）。
 *
 * 全部注入 mock search 与假 LiveDoc/VideoPoolDoc，不发真实外网请求：
 *  - normalizeBiliSearchQuery / buildBiliSearchQuery：算子剥离、UTF-16 长度边界、UTC+8 跨日；
 *  - cleanBiliVideoTitle：B 站页面后缀剥离与空标题兜底；
 *  - runBiliSearchFunnel：严格 /video/BV 过滤、多锚点去重、去重表剔除、时间窗兜底、
 *    4 条文本硬筛、snippet 优先、无 URL 泄露与竖线冲突；
 *  - createBiliSearchTool：缺省 60 天 + 不足自动放宽合并、放宽失败降级、错误分类、
 *    参数/凭据/轮标识/每轮 2 次额度、abortSignal 取消安全与 search 租约互不干扰。
 */
import test from "node:test";
import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { LiveDoc } from "@earendil-works/pi-durable";
import {
  SearchResponseError,
  type DeepSeekSearchItem,
  type DeepSeekSearchOptions,
  type deepseekSearch,
} from "../src/external/deepseek-search.ts";
import { DEFAULT_BILI_FILTERS } from "../src/external/bili-client.ts";
import { VideoPoolDoc, type VideoPoolState } from "../src/external/video-pool.ts";
import { extractLinks } from "../src/egress/seen-links.ts";
import {
  BILI_SEARCH_FETCH_COUNT,
  BILI_SEARCH_PRIMARY_TIMEOUT_MS,
  BILI_SEARCH_TOTAL_TIMEOUT_MS,
  buildBiliSearchQuery,
  cleanBiliVideoTitle,
  createBiliSearchTool,
  normalizeBiliSearchQuery,
  runBiliSearchFunnel,
} from "../src/tools/bili_search/tool.ts";
import { createSearchTool } from "../src/tools/search/tool.ts";
import { loadToolManifests } from "../src/tools/manifest.ts";
import { mergeToolMessages } from "../src/tools/loader.ts";
import { loadPrompts } from "../src/prompt/index.ts";
import type { ToolPackageDeps } from "../src/tools/types.ts";

const ctx = BACKGROUND_CONTEXT;
const PROMPTS = fileURLToPath(new URL("../prompt", import.meta.url));
const TOOL_ROOT = fileURLToPath(new URL("../src/tools/", import.meta.url));

const prompts = loadPrompts(PROMPTS);
const manifests = loadToolManifests(TOOL_ROOT, { memeTags: prompts.memeTags });
mergeToolMessages(manifests, prompts.messages);

/** 固定时钟：UTC 2026-11-24T19:00Z = UTC+8 2026-11-25 03:00（跨日用例）。 */
const NOW = Date.parse("2026-11-25T03:00:00+08:00");
const DAY = 86_400_000;

function makeDeps(over: Partial<ToolPackageDeps> = {}): ToolPackageDeps {
  return { prompts, searchKey: "test-key", now: () => NOW, chatKeyOf: () => "qq:group:1", ...over } as ToolPackageDeps;
}

/** 假 api：LiveDoc 返回指定轮 inputs；VideoPoolDoc 返回可变的池 state（commit 直接改它）。 */
function makeApi(conversationId: string, over: { inputs?: unknown[]; pool?: VideoPoolState } = {}) {
  const poolState: VideoPoolState = over.pool ?? { items: [] };
  const inputs = over.inputs ?? [1];
  const api = {
    conversationId,
    callId: 1,
    snapshot: async (doc: unknown) => {
      if (doc === LiveDoc) return { run: { inputs } };
      if (doc === VideoPoolDoc) return poolState;
      return undefined;
    },
    commit: async (fn: (tx: { doc: (doc: unknown, key: string) => Promise<VideoPoolState> }) => Promise<unknown>) =>
      fn({ doc: async () => poolState }),
  };
  return { api: api as never, poolState };
}

function item(bvid: string, over: Partial<DeepSeekSearchItem> = {}): DeepSeekSearchItem {
  return {
    url: `https://www.bilibili.com/video/${bvid}`,
    rawTitle: `标题${bvid}`,
    rawSummary: "",
    rawSnippet: `简介${bvid}`,
    ...over,
  };
}

type SearchResponse = DeepSeekSearchItem[] | Error | ((options: DeepSeekSearchOptions) => Promise<DeepSeekSearchItem[]>);

/** 记录调用的 mock search；responses 逐次弹出，耗尽后重复最后一个。 */
function mockSearch(responses: SearchResponse[]) {
  const calls: DeepSeekSearchOptions[] = [];
  let index = 0;
  const fn = (async (options: DeepSeekSearchOptions) => {
    calls.push(options);
    const resp = responses[Math.min(index, responses.length - 1)]!;
    index += 1;
    if (resp instanceof Error) throw resp;
    if (typeof resp === "function") return resp(options);
    return resp;
  }) as typeof deepseekSearch;
  return { fn, calls };
}

function makeTool(deps: ToolPackageDeps, responses: SearchResponse[], audit: (line: string) => void = () => {}) {
  const search = mockSearch(responses);
  const tool = createBiliSearchTool(manifests.get("bili_search")!, deps, {
    search: search.fn,
    filters: () => DEFAULT_BILI_FILTERS,
    audit,
  });
  return { tool, calls: search.calls };
}

function textOf(result: { output: { type: string; text?: string }[] }): string {
  return result.output.map((block) => block.text ?? "").join("\n");
}

test("normalizeBiliSearchQuery 与 buildBiliSearchQuery：精准剥离算子、UTF-16 长度边界、UTC+8 跨日切分", () => {
  assert.equal(
    normalizeBiliSearchQuery("site:zhihu.com -site:x.com after:2020-01-01崩坏3 爱莉希雅 before:2026-01-01"),
    "崩坏3 爱莉希雅",
  );
  assert.equal(buildBiliSearchQuery("崩坏3 爱莉希雅", 60, NOW), "site:bilibili.com/video 崩坏3 爱莉希雅 after:2026-09-26");
  assert.equal(buildBiliSearchQuery("崩坏3 爱莉希雅", 0, NOW), "site:bilibili.com/video 崩坏3 爱莉希雅");

  // UTF-16 .length 边界：80 汉字 / 40 emoji（80 单位）拼完 ≤128；41 emoji（82 单位）超限
  const han80 = "鱼".repeat(80);
  assert.equal(normalizeBiliSearchQuery(han80).length, 80);
  assert.ok(buildBiliSearchQuery(han80, 60, NOW).length <= 128);
  const emoji40 = "🐟".repeat(40);
  assert.equal(normalizeBiliSearchQuery(emoji40).length, 80);
  assert.ok(buildBiliSearchQuery(emoji40, 60, NOW).length <= 128);
  const emoji41 = "🐟".repeat(41);
  assert.equal(normalizeBiliSearchQuery(emoji41).length, 82); // > 80，execute 层拒绝（见参数校验测试）
});

test("cleanBiliVideoTitle 精准去除 B 站页面后缀并兜底空标题", () => {
  assert.equal(cleanBiliVideoTitle("【LLM雷达图】Fable 5.2_哔哩哔哩_bilibili"), "【LLM雷达图】Fable 5.2");
  assert.equal(cleanBiliVideoTitle("AI 早报 2026-11-10_哔哩哔哩_bilibili - 00:41"), "AI 早报 2026-11-10");
  assert.equal(cleanBiliVideoTitle("《崩坏3》爱莉希雅_哔哩哔哩bilibili_崩坏3"), "《崩坏3》爱莉希雅");
  assert.equal(cleanBiliVideoTitle("【崩坏3】爱愿妖精登场_游戏热门视频"), "【崩坏3】爱愿妖精登场");
  assert.equal(cleanBiliVideoTitle("_哔哩哔哩_bilibili"), "无标题");
});

test("runBiliSearchFunnel：严格 /video/BV 过滤、多锚点 BV 去重、inLibrary 剔除、minPublishedAtMs 兜底、4 条文本硬筛、优先 snippet、无 URL 与竖线冲突", () => {
  const items: DeepSeekSearchItem[] = [
    item("BV1eqZJYaESc", { url: "https://example.com/video/BV1eqZJYaESc" }), // 非 B 站域
    item("BV1eqZJYaESc", { url: "https://www.bilibili.com/video/av123" }), // av 号
    item("BV1eqZJYaESc", { url: "https://www.bilibili.com/opus/456" }), // 图文动态
    item("BV5eqZJYaESc", { publishedAtMs: NOW - 100 * DAY }), // 超窗旧条目
    item("BV1eqZJYaESc", { rawTitle: "正常视频A", rawSnippet: "简介A", publishedAtMs: NOW - 5 * DAY }),
    item("BV1eqZJYaESc", { url: "https://www.bilibili.com/video/BV1eqZJYaESc/#2", rawTitle: "重复A2" }),
    item("BV1eqZJYaESc", { url: "https://www.bilibili.com/video/BV1eqZJYaESc?spm_id_from=x#5", rawTitle: "重复A5" }),
    item("BV2eqZJYaESc"), // 已在去重表
    item("BV3eqZJYaESc", { rawTitle: "震惊！这是标题" }), // titleBait
    item("BV4eqZJYaESc", { rawSnippet: "不看后悔系列" }), // uc（简介命中）
    item("BV6eqZJYaESc", { rawTitle: "年度大盘点" }), // listicle
    item("BV7eqZJYaESc", { rawSnippet: "关注领优惠券" }), // promoDesc
    item("BV8eqZJYaESc", { rawTitle: "日期未知的视频", rawSnippet: "简介8" }), // 无日期保留
    item("BV9eqZJYaESc", { rawSnippet: "正常简介", rawSummary: "侧栏噪音\n推荐列表" }), // snippet 优先
    item("BVaeqZJYaESc", { rawSnippet: "", rawSummary: "# 首段简介\n侧栏推荐" }), // summary 首段回退
    item("BVbeqZJYaESc", { rawTitle: "左|右 https://evil.example/x 看看", rawSnippet: "带链接 https://evil.example/y 的简介" }),
  ];
  const audits: string[] = [];
  const result = runBiliSearchFunnel(items, 10, {
    filters: DEFAULT_BILI_FILTERS,
    inLibrary: new Map([["BV2eqZJYaESc", "shared"]]),
    audit: (line) => audits.push(line),
    minPublishedAtMs: NOW - 61 * DAY,
  });

  assert.deepEqual(result.bvids, ["BV1eqZJYaESc", "BV8eqZJYaESc", "BV9eqZJYaESc", "BVaeqZJYaESc", "BVbeqZJYaESc"]);
  assert.deepEqual(result.stats, { raw: 16, bili: 10, inLibrary: 1, hardVeto: 4, returned: 5 });
  // 多锚点去重保留首条；日期按 UTC+8 渲染；无日期条目标「日期未知」
  assert.ok(result.rows[0]!.startsWith("正常视频A|2026-11-20|简介A|BV1eqZJYaESc"));
  assert.ok(result.rows[1]!.includes("|日期未知|"));
  assert.ok(result.rows[2]!.includes("正常简介"));
  assert.ok(!result.rows[2]!.includes("侧栏噪音"));
  assert.ok(result.rows[3]!.includes("首段简介"));
  assert.ok(!result.rows[3]!.includes("侧栏推荐"));
  // 无 URL 泄露、字段内竖线替换为全角
  assert.deepEqual(extractLinks(result.rows.join("\n")), []);
  assert.ok(result.rows[4]!.includes("左｜右"));
  assert.ok(!result.rows[4]!.includes("evil.example"));
  for (const row of result.rows) assert.ok(!row.includes("http"));

  // 审计：in_library 与 4 条硬筛都有元数据行，且不含标题/简介原文
  assert.ok(audits.some((l) => l.includes("BV=BV2eqZJYaESc") && l.includes("rule=in_library") && l.includes("value=shared")));
  for (const rule of ["hard.titleBaitPatterns", "hard.ucPatterns", "hard.listiclePatterns", "hard.promoDescPatterns"]) {
    assert.ok(audits.some((l) => l.includes(`rule=${rule}`)), `缺审计 ${rule}`);
  }
  for (const line of audits) {
    assert.ok(!line.includes("震惊！这是标题"));
    assert.ok(!line.includes("不看后悔系列"));
    assert.ok(!line.includes("关注领优惠券"));
  }
});

test("createBiliSearchTool：缺省 days=60 生效；近 60 天结果 < 3 条自动放宽重搜合并去重（时间窗优先）并记账 seen", async () => {
  const a = item("BV1eqZJYaESc", { rawTitle: "视频A", publishedAtMs: NOW - 10 * DAY });
  const b = item("BV2eqZJYaESc", { rawTitle: "视频B", publishedAtMs: NOW - 200 * DAY });
  const c = item("BV3eqZJYaESc", { rawTitle: "视频C", publishedAtMs: NOW - 300 * DAY });
  const aDup = item("BV1eqZJYaESc", { url: "https://www.bilibili.com/video/BV1eqZJYaESc/#2", rawTitle: "重复A" });
  const { api, poolState } = makeApi("conv-fallback");
  const { tool, calls } = makeTool(makeDeps(), [[a], [aDup, b, c]]);
  const ctrl = new AbortController();
  const result = await tool.execute({ query: "爱莉希雅" } as never, api, { abortSignal: ctrl.signal } as never);
  const text = textOf(result as never);

  assert.equal(calls.length, 2);
  assert.equal(calls[0]!.query, "site:bilibili.com/video 爱莉希雅 after:2026-09-26");
  assert.equal(calls[1]!.query, "site:bilibili.com/video 爱莉希雅");
  assert.equal(calls[0]!.count, BILI_SEARCH_FETCH_COUNT);
  assert.equal(calls[0]!.timeoutMs, BILI_SEARCH_PRIMARY_TIMEOUT_MS);
  assert.ok(calls[1]!.timeoutMs! >= 4_000 && calls[1]!.timeoutMs! <= BILI_SEARCH_TOTAL_TIMEOUT_MS);
  assert.equal(calls[0]!.signal, ctrl.signal);
  assert.equal(calls[1]!.signal, ctrl.signal);

  // 合并去重：A（时间窗内首条）优先，B/C 追加；放宽如实标注
  assert.ok(text.indexOf("视频A|") < text.indexOf("视频B|"));
  assert.ok(text.indexOf("视频B|") < text.indexOf("视频C|"));
  assert.ok(!text.includes("重复A"));
  assert.ok(text.includes("近60天不足已自动放宽时间"));
  assert.deepEqual(extractLinks(text), []);
  // seen 记账：A/B/C 全部入池
  assert.deepEqual(poolState.items.map((i) => i.bvid).sort(), ["BV1eqZJYaESc", "BV2eqZJYaESc", "BV3eqZJYaESc"]);
  assert.ok(poolState.items.every((i) => i.state === "seen" && i.at === NOW));
});

test("createBiliSearchTool：放宽重搜时首轮超窗旧条目不得挤掉窗口内与放宽结果（I-1 回归），且读取去重池失败释放租约（M1 回归）", async () => {
  // I-1：首轮前 12 条均早于 60 天窗口，第 13/14 条在窗口内；放宽返 1 条新结果
  const oldPrimary = Array.from({ length: 12 }, (_, idx) =>
    item(`BV1old${String(idx).padStart(6, "0")}`, { rawTitle: `旧视频${idx}`, publishedAtMs: NOW - (120 + idx) * DAY }),
  );
  const inWin1 = item("BV1win000001", { rawTitle: "窗口内1", publishedAtMs: NOW - 5 * DAY });
  const inWin2 = item("BV1win000002", { rawTitle: "窗口内2", publishedAtMs: NOW - 20 * DAY });
  const relaxed = item("BV1rel000001", { rawTitle: "放宽命中1", publishedAtMs: NOW - 90 * DAY });
  {
    const { api, poolState } = makeApi("conv-i1-regression");
    const { tool } = makeTool(makeDeps(), [[...oldPrimary, inWin1, inWin2], [relaxed]]);
    const text = textOf(await tool.execute({ query: "测试话题" } as never, api, ctx) as never);
    assert.ok(text.includes("窗口内1|"), "窗口内1 不应被首轮超窗条目挤掉");
    assert.ok(text.includes("窗口内2|"), "窗口内2 不应被首轮超窗条目挤掉");
    assert.ok(text.includes("放宽命中1|"), "放宽结果不应被首轮超窗条目挤掉");
    assert.ok(text.indexOf("窗口内1|") < text.indexOf("窗口内2|"));
    assert.ok(text.indexOf("窗口内2|") < text.indexOf("放宽命中1|"));
    assert.ok(text.indexOf("放宽命中1|") < text.indexOf("旧视频0|"));
    assert.ok(poolState.items.some((i) => i.bvid === "BV1win000001"));
    assert.ok(poolState.items.some((i) => i.bvid === "BV1rel000001"));
  }

  // M1：读 VideoPoolDoc 失败时必须释放租约，不得占掉每轮 2 次额度
  {
    let failCount = 2;
    const round = { id: "r-m1" };
    const poolState: VideoPoolState = { items: [] };
    const api = {
      conversationId: "conv-m1-regression" as never,
      snapshot: async (doc: unknown) => {
        if (doc === LiveDoc) return { run: { inputs: [round] } };
        if (doc === VideoPoolDoc) {
          if (failCount > 0) {
            failCount -= 1;
            throw new Error("pool read failed");
          }
          return poolState;
        }
        return undefined;
      },
      commit: async (fn: (tx: { doc: () => Promise<VideoPoolState> }) => Promise<void>) => {
        await fn({ doc: async () => poolState });
      },
    } as never;
    const { tool } = makeTool(makeDeps(), [[inWin1, inWin2, relaxed]]);
    await assert.rejects(tool.execute({ query: "q", days: 0 } as never, api, ctx), /pool read failed/);
    await assert.rejects(tool.execute({ query: "q", days: 0 } as never, api, ctx), /pool read failed/);
    const okText = textOf(await tool.execute({ query: "q", days: 0 } as never, api, ctx) as never);
    assert.ok(okText.includes("窗口内1|"), "两次快照失败不应耗尽轮内额度");
  }
});

test("createBiliSearchTool：放宽重搜抛 SearchResponseError 时保留首次 1-2 条结果（不标已放宽）；0 条且 SearchResponseError 抛 bili_search_failed；网络错误/AbortError 原样上抛且不写 seen/不扣额度", async () => {
  const a = item("BV1eqZJYaESc", { rawTitle: "视频A", publishedAtMs: NOW - 10 * DAY });
  const b = item("BV2eqZJYaESc", { rawTitle: "视频B" });
  const c = item("BV3eqZJYaESc", { rawTitle: "视频C" });

  // 放宽失败但首次有 1 条：保留、不标放宽、照常记 seen
  {
    const { api, poolState } = makeApi("conv-fallback-keep");
    const { tool } = makeTool(makeDeps(), [[a], new SearchResponseError("放宽失败")]);
    const text = textOf(await tool.execute({ query: "爱莉希雅" } as never, api, ctx) as never);
    assert.ok(text.includes("视频A|"));
    assert.ok(!text.includes("已自动放宽"));
    assert.deepEqual(poolState.items.map((i) => i.bvid), ["BV1eqZJYaESc"]);
  }

  // 首次 0 条 + 放宽 SearchResponseError：翻为 bili_search_failed，不写池
  {
    const { api, poolState } = makeApi("conv-fallback-fail");
    const { tool } = makeTool(makeDeps(), [[], new SearchResponseError("boom")]);
    await assert.rejects(
      tool.execute({ query: "爱莉希雅" } as never, api, ctx),
      (error: Error) => error.message.includes("B 站视频搜索没成功") && error.message.includes("爱莉希雅") && error.message.includes("boom"),
    );
    assert.deepEqual(poolState.items, []);
  }

  // 网络错误原样上抛、不写 seen、不扣额度（同轮第二次成功）
  {
    const netErr = new TypeError("fetch failed");
    const { api, poolState } = makeApi("conv-net-err");
    const { tool } = makeTool(makeDeps(), [netErr, [a, b, c]]);
    await assert.rejects(tool.execute({ query: "q", days: 0 } as never, api, ctx), (error: unknown) => error === netErr);
    assert.deepEqual(poolState.items, []);
    const text = textOf(await tool.execute({ query: "q", days: 0 } as never, api, ctx) as never);
    assert.ok(text.includes("视频A|"));
  }

  // AbortError 原样上抛、不扣额度
  {
    const abortErr = new Error("The operation was aborted");
    abortErr.name = "AbortError";
    const { api, poolState } = makeApi("conv-abort-err");
    const { tool } = makeTool(makeDeps(), [abortErr, [a, b, c]]);
    await assert.rejects(tool.execute({ query: "q", days: 0 } as never, api, ctx), (error: unknown) => error === abortErr);
    assert.deepEqual(poolState.items, []);
    const text = textOf(await tool.execute({ query: "q", days: 0 } as never, api, ctx) as never);
    assert.ok(text.includes("视频A|"));
  }
});

test("createBiliSearchTool：参数/凭据/轮标识/每轮 2 次上限校验", async () => {
  const a = item("BV1eqZJYaESc");
  const b = item("BV2eqZJYaESc");
  const c = item("BV3eqZJYaESc");
  const msg = (key: string) => prompts.messages[key]!;

  // 缺 searchKey
  {
    const { api } = makeApi("conv-nokey");
    const { tool } = makeTool(makeDeps({ searchKey: undefined }), [[a, b, c]]);
    await assert.rejects(tool.execute({ query: "q" } as never, api, ctx), (e: Error) => e.message === msg("bili_search_nokey"));
  }
  // 非法 query：空 / 纯空白 / 81 汉字 / 41 emoji（82 UTF-16 单位）/ 纯算子剥完为空
  for (const bad of ["", "   ", "鱼".repeat(81), "🐟".repeat(41), "site:zhihu.com"]) {
    const { api } = makeApi(`conv-badq-${bad.length}`);
    const { tool } = makeTool(makeDeps(), [[a, b, c]]);
    await assert.rejects(tool.execute({ query: bad } as never, api, ctx), (e: Error) => e.message === msg("bili_search_query"));
  }
  // 非法 days
  for (const bad of [-1, 366, 1.5]) {
    const { api } = makeApi(`conv-badd-${bad}`);
    const { tool } = makeTool(makeDeps(), [[a, b, c]]);
    await assert.rejects(tool.execute({ query: "q", days: bad } as never, api, ctx), (e: Error) => e.message === msg("bili_search_bad_days"));
  }
  // 缺轮标识
  {
    const { api } = makeApi("conv-noround", { inputs: [] });
    const { tool } = makeTool(makeDeps(), [[a, b, c]]);
    await assert.rejects(tool.execute({ query: "q" } as never, api, ctx), (e: Error) => e.message === msg("bili_search_round_missing"));
  }
  // 成功 2 次后第 3 次拒（两次用不同 BV，避免第二次被 seen 去重筛空）
  {
    const { api } = makeApi("conv-quota");
    const d = item("BV4eqZJYaESc");
    const e = item("BV5eqZJYaESc");
    const f = item("BV6eqZJYaESc");
    const { tool, calls } = makeTool(makeDeps(), [[a, b, c], [d, e, f]]);
    await tool.execute({ query: "q", days: 0 } as never, api, ctx);
    await tool.execute({ query: "q", days: 0 } as never, api, ctx);
    await assert.rejects(tool.execute({ query: "q", days: 0 } as never, api, ctx), (e: Error) => e.message === msg("bili_search_used"));
    assert.equal(calls.length, 2);
  }
  // 空结果释放不计数：两次空 + 第三次成功
  {
    const { api, poolState } = makeApi("conv-empty-release");
    const { tool } = makeTool(makeDeps(), [[], [], [a, b, c]]);
    const first = textOf(await tool.execute({ query: "q", days: 0 } as never, api, ctx) as never);
    assert.equal(first, msg("bili_search_empty"));
    assert.deepEqual(poolState.items, []);
    await tool.execute({ query: "q", days: 0 } as never, api, ctx);
    const third = textOf(await tool.execute({ query: "q", days: 0 } as never, api, ctx) as never);
    assert.ok(third.includes("BV1eqZJYaESc"));
  }
});

test("createBiliSearchTool：context.abortSignal 中止时中止底层请求、不记账 seen、不占用额度；与 search 租约互不干扰", async () => {
  const a = item("BV1eqZJYaESc");
  const b = item("BV2eqZJYaESc");
  const c = item("BV3eqZJYaESc");
  const hangUntilAbort = (options: DeepSeekSearchOptions) =>
    new Promise<DeepSeekSearchItem[]>((_, reject) => {
      if (options.signal?.aborted) reject(options.signal.reason);
      else options.signal?.addEventListener("abort", () => reject(options.signal!.reason));
    });

  // 中途取消：底层请求收到 signal 并以 reason 拒绝；不写池、额度释放（同轮重试成功）
  {
    const { api, poolState } = makeApi("conv-mid-abort");
    const { tool, calls } = makeTool(makeDeps(), [hangUntilAbort, [a, b, c]]);
    const ctrl = new AbortController();
    const reason = new Error("用户取消");
    const pending = tool.execute({ query: "q", days: 0 } as never, api, { abortSignal: ctrl.signal } as never);
    ctrl.abort(reason);
    await assert.rejects(pending, (error: unknown) => error === reason);
    assert.equal(calls[0]!.signal, ctrl.signal);
    assert.deepEqual(poolState.items, []);
    const text = textOf(await tool.execute({ query: "q", days: 0 } as never, api, ctx) as never);
    assert.ok(text.includes("BV1eqZJYaESc"));
  }

  // 预先取消：同样原样上抛 reason
  {
    const { api, poolState } = makeApi("conv-pre-abort");
    const { tool } = makeTool(makeDeps(), [hangUntilAbort]);
    const ctrl = new AbortController();
    const reason = new Error("早已取消");
    ctrl.abort(reason);
    await assert.rejects(tool.execute({ query: "q", days: 0 } as never, api, { abortSignal: ctrl.signal } as never), (error: unknown) => error === reason);
    assert.deepEqual(poolState.items, []);
  }

  // 与 search 租约互不干扰：同一会话同一轮，search 成功后 bili_search 照常可用
  {
    const { api } = makeApi("conv-lease-independent");
    const fetchMock = (async () =>
      new Response(JSON.stringify({ results: [{ url: "https://example.com/a", title: "t", summary: "s" }] }), {
        status: 200,
        headers: { "content-type": "application/json" },
      })) as unknown as typeof fetch;
    const searchTool = createSearchTool(manifests.get("search")!, makeDeps(), { fetch: fetchMock });
    await searchTool.execute({ query: "x" } as never, api, ctx);
    const { tool } = makeTool(makeDeps(), [[a, b, c]]);
    const text = textOf(await tool.execute({ query: "y", days: 0 } as never, api, ctx) as never);
    assert.ok(text.includes("BV1eqZJYaESc"));
  }
});