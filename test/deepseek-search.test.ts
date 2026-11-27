/**
 * DeepSeek Search 共享客户端（src/external/deepseek-search.ts）与 search 工具行为回归。
 *
 * 全部注入 mock fetch，不发真实外网请求：
 *  - deepseekSearch：字段解析（date/publishedAtMs/rerankScore）、slice(0, count) 先于 URL 过滤、
 *    响应封顶/结构校验抛 SearchResponseError、网络/超时/外部取消原样上抛；
 *  - cleanSearchText：控制字符、内嵌 URL 抹除、按上限截断；
 *  - createSearchTool：渲染优先序（summary || snippet）、同轮 SEARCHED 锁、空结果释放、
 *    SearchResponseError → search_failed、网络错误原样透出、context.abortSignal 透传。
 */
import test from "node:test";
import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { LiveDoc } from "@earendil-works/pi-durable";
import {
  DEEPSEEK_SEARCH_ENDPOINT,
  SEARCH_RESPONSE_MAX_BYTES,
  SEARCH_RESULTS_MAX,
  SearchResponseError,
  cleanSearchText,
  deepseekSearch,
} from "../src/external/deepseek-search.ts";
import { createSearchTool } from "../src/tools/search/tool.ts";
import { loadToolManifests } from "../src/tools/manifest.ts";
import { mergeToolMessages } from "../src/tools/loader.ts";
import { loadPrompts } from "../src/prompt/index.ts";

const ctx = BACKGROUND_CONTEXT;
const PROMPTS = fileURLToPath(new URL("../prompt", import.meta.url));
const TOOL_ROOT = fileURLToPath(new URL("../src/tools/", import.meta.url));

function jsonResponse(payload: unknown, status = 200): Response {
  return new Response(JSON.stringify(payload), { status, headers: { "content-type": "application/json" } });
}

/** 记录调用的 mock fetch；responses 逐次弹出，耗尽后重复最后一个。 */
function mockFetch(responses: (Response | Error | ((init: RequestInit) => Promise<Response>))[]) {
  const calls: { url: string; init: RequestInit }[] = [];
  let index = 0;
  const fn = (async (url: string | URL | Request, init?: RequestInit) => {
    calls.push({ url: String(url), init: init ?? {} });
    const item = responses[Math.min(index, responses.length - 1)]!;
    index += 1;
    if (item instanceof Error) throw item;
    if (typeof item === "function") return item(init ?? {});
    return item;
  }) as unknown as typeof fetch;
  return { fn, calls };
}

test("deepseekSearch 解析 url/rawTitle/rawSummary/rawSnippet/date/publishedAtMs/rerankScore 并保留 slice(0, count) 后滤非法 URL", async () => {
  const validDate = "2026-11-18T16:00:00+00:00";
  const { fn, calls } = mockFetch([
    jsonResponse({
      results: [
        { url: "https://example.com/a", title: "标题A", summary: "摘要A", snippet: "片段A", date: validDate, rerank_score: 0.87 },
        { url: "javascript:alert(1)", title: "坏链接" },
        { url: "https://example.com/c", title: "越界C" },
      ],
    }),
  ]);
  const items = await deepseekSearch({ apiKey: "k", query: "q", count: 2, fetch: fn });
  // slice(0, 2) 先截断：前 2 条里 1 条非法 URL → 只返回 1 条，不越界补第 3 条
  assert.equal(items.length, 1);
  assert.equal(items[0]!.url, "https://example.com/a");
  assert.equal(items[0]!.rawTitle, "标题A");
  assert.equal(items[0]!.rawSummary, "摘要A");
  assert.equal(items[0]!.rawSnippet, "片段A");
  assert.equal(items[0]!.date, validDate);
  assert.equal(items[0]!.publishedAtMs, Date.parse(validDate));
  assert.equal(items[0]!.rerankScore, 0.87);
  assert.equal(calls.length, 1);
  assert.equal(calls[0]!.url, DEEPSEEK_SEARCH_ENDPOINT);
  assert.equal(calls[0]!.init.method, "POST");
  assert.deepEqual(JSON.parse(String(calls[0]!.init.body)), { query: "q", count: 2 });
  assert.equal((calls[0]!.init.headers as Record<string, string>)["authorization"], "Bearer k");

  // date null / 非法字符串 → publishedAtMs undefined；非有限数 rerank_score → undefined
  const second = mockFetch([
    jsonResponse({
      results: [
        { url: "https://example.com/x", title: "X", date: null, rerank_score: "high" },
        { url: "https://example.com/y", title: "Y", date: "invalid", rerank_score: Number.NaN },
      ],
    }),
  ]);
  const items2 = await deepseekSearch({ apiKey: "k", query: "q", count: 10, fetch: second.fn });
  assert.equal(items2.length, 2);
  for (const item of items2) {
    assert.equal(item.publishedAtMs, undefined);
    assert.equal(item.rerankScore, undefined);
  }
  assert.equal(items2[0]!.date, undefined);
  assert.equal(items2[1]!.date, "invalid");
});

test("cleanSearchText 清洗控制字符、抹除内嵌 URL 并按上限截断", () => {
  assert.equal(cleanSearchText("看 https://evil.example/x 这个\u0007视频", 100), "看 这个 视频");
  assert.equal(cleanSearchText("前 www.spam.example/a 后", 100), "前 后");
  assert.equal(cleanSearchText("a".repeat(50), 10), "a".repeat(10));
  assert.equal(cleanSearchText(null, 10), "");
  assert.equal(cleanSearchText(undefined, 10), "");
  assert.equal(cleanSearchText(42, 10), "");
});

test("deepseekSearch 响应非 2xx / 非 JSON / 非法结构 / 超结果上限 / 超 1MiB 抛 SearchResponseError", async () => {
  const cases: (Response | (() => Response))[] = [
    jsonResponse({}, 500),
    new Response("not json", { status: 200 }),
    jsonResponse([1, 2]),
    jsonResponse({ results: "x" }),
    jsonResponse({ results: Array.from({ length: SEARCH_RESULTS_MAX + 1 }, (_, i) => ({ url: `https://e.example/${i}` })) }),
    new Response("x", { status: 200, headers: { "content-length": String(SEARCH_RESPONSE_MAX_BYTES + 1) } }),
  ];
  for (const res of cases) {
    const { fn } = mockFetch([typeof res === "function" ? res() : res]);
    await assert.rejects(
      () => deepseekSearch({ apiKey: "k", query: "q", count: 4, fetch: fn }),
      SearchResponseError,
    );
  }
  // 真流式超限：两个 600KiB chunk，读流途中超限
  const chunk = new Uint8Array(600 * 1024);
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(chunk);
      controller.enqueue(chunk);
      controller.close();
    },
  });
  const streamed = new Response(stream, { status: 200 });
  const { fn } = mockFetch([streamed]);
  await assert.rejects(
    () => deepseekSearch({ apiKey: "k", query: "q", count: 4, fetch: fn }),
    SearchResponseError,
  );
  // 无 ReadableStream body 的运行时：text() 兜底也要封顶
  const bigText = "a".repeat(SEARCH_RESPONSE_MAX_BYTES + 1);
  const bodyless = {
    ok: true,
    headers: new Headers(),
    text: async () => bigText,
  } as unknown as Response;
  const third = mockFetch([bodyless]);
  await assert.rejects(
    () => deepseekSearch({ apiKey: "k", query: "q", count: 4, fetch: third.fn }),
    SearchResponseError,
  );
});

/** 挂起直到 signal 中止的 fetch：中止时以 signal.reason（AbortError）拒绝。 */
function hangingFetch(): typeof fetch {
  return (async (_url: string | URL | Request, init?: RequestInit) =>
    new Promise<Response>((_resolve, reject) => {
      const signal = init?.signal;
      if (signal?.aborted) {
        reject(signal.reason);
        return;
      }
      signal?.addEventListener("abort", () => reject(signal.reason), { once: true });
    })) as unknown as typeof fetch;
}

test("deepseekSearch 网络错误、超时与外部 AbortSignal 取消均原样上抛，不包装成 SearchResponseError", async () => {
  const netErr = new TypeError("net down");
  const net = mockFetch([netErr]);
  await assert.rejects(
    () => deepseekSearch({ apiKey: "k", query: "q", count: 4, fetch: net.fn }),
    (error: unknown) => error === netErr,
  );

  // 超时：AbortError 原样上抛
  await assert.rejects(
    () => deepseekSearch({ apiKey: "k", query: "q", count: 4, timeoutMs: 10, fetch: hangingFetch() }),
    (error: unknown) => error instanceof Error && error.name === "AbortError" && !(error instanceof SearchResponseError),
  );

  // 外部信号已 aborted：直接拒绝，不发请求
  const pre = new AbortController();
  pre.abort();
  const never = mockFetch([jsonResponse({ results: [] })]);
  await assert.rejects(
    () => deepseekSearch({ apiKey: "k", query: "q", count: 4, signal: pre.signal, fetch: never.fn }),
    (error: unknown) => error instanceof Error && error.name === "AbortError",
  );
  assert.equal(never.calls.length, 0, "已中止的信号不该发出请求");

  // 在途中外部取消：AbortError 原样上抛
  const mid = new AbortController();
  const pending = deepseekSearch({ apiKey: "k", query: "q", count: 4, signal: mid.signal, fetch: hangingFetch() });
  mid.abort();
  await assert.rejects(
    pending,
    (error: unknown) => error instanceof Error && error.name === "AbortError" && !(error instanceof SearchResponseError),
  );
});

// ── createSearchTool 行为回归 ────────────────────────────────────────────────

let convSeq = 0;
function setupSearch(over: { noKey?: boolean; round?: unknown } = {}) {
  const prompts = loadPrompts(PROMPTS);
  const manifests = loadToolManifests(TOOL_ROOT, { memeTags: prompts.memeTags });
  mergeToolMessages(manifests, prompts.messages);
  const round = over.round === undefined ? { r: ++convSeq } : over.round;
  const conversationId = `conv-search-${++convSeq}`;
  const api = {
    conversationId,
    callId: "call_test",
    snapshot: async (doc: unknown) => (doc === LiveDoc ? { run: { inputs: [round] } } : undefined),
  } as never;
  const deps = {
    prompts,
    mediaRoot: "/tmp/yg-unused",
    ...(over.noKey ? {} : { searchKey: "k" }),
  } as never;
  return { prompts, manifests, api, deps, conversationId, round };
}

test("createSearchTool 行为回归：渲染 1. title\\nurl\\nbrief（summary 优先于 snippet）、成功锁同轮抛 search_used、空结果释放可重试、SearchResponseError 翻为 search_failed", async () => {
  const { manifests, api, deps, prompts } = setupSearch();
  const { fn, calls } = mockFetch([
    jsonResponse({
      results: [
        { url: "https://a.example/1", title: "标".repeat(100), summary: "摘要一", snippet: "片段一" },
        { url: "https://b.example/2", title: "标题二", summary: "", snippet: "片段二" },
      ],
    }),
    jsonResponse({ results: [] }),
  ]);
  const tool = createSearchTool(manifests.get("search")!, deps, { fetch: fn });
  const result = (await tool.execute({ query: "测试" } as never, api, ctx)) as { output: { type: string; text: string }[] };
  const text = result.output[0]!.text;
  assert.equal(
    text,
    `1. ${"标".repeat(80)}\nhttps://a.example/1\n摘要一\n\n2. 标题二\nhttps://b.example/2\n片段二`,
  );
  assert.equal(JSON.parse(String(calls[0]!.init.body)).count, 4, "count 固定 4");

  // 成功锁：同轮再搜抛 search_used
  await assert.rejects(
    () => tool.execute({ query: "再搜" } as never, api, ctx),
    (error: unknown) => error instanceof Error && error.message === prompts.messages["search_used"],
  );

  // 空结果释放：另一会话空结果后可同轮重试
  const empty = setupSearch();
  const emptyFetch = mockFetch([jsonResponse({ results: [] }), jsonResponse({ results: [{ url: "https://c.example/3", title: "T", summary: "S" }] })]);
  const emptyTool = createSearchTool(empty.manifests.get("search")!, empty.deps, { fetch: emptyFetch.fn });
  const first = (await emptyTool.execute({ query: "q" } as never, empty.api, ctx)) as { output: { text: string }[] };
  assert.equal(first.output[0]!.text, "没搜到相关结果");
  const retry = (await emptyTool.execute({ query: "q" } as never, empty.api, ctx)) as { output: { text: string }[] };
  assert.match(retry.output[0]!.text, /https:\/\/c\.example\/3/);

  // SearchResponseError → search_failed 文案
  const failed = setupSearch();
  const failFetch = mockFetch([jsonResponse({}, 502)]);
  const failTool = createSearchTool(failed.manifests.get("search")!, failed.deps, { fetch: failFetch.fn });
  await assert.rejects(
    () => failTool.execute({ query: "q" } as never, failed.api, ctx),
    (error: unknown) => error instanceof Error && error.message === prompts.messages["search_failed"],
  );

  // 网络错误原样上抛（不伪装成 search_failed）
  const net = setupSearch();
  const netErr = new TypeError("socket hang up");
  const netTool = createSearchTool(net.manifests.get("search")!, net.deps, { fetch: mockFetch([netErr]).fn });
  await assert.rejects(
    () => netTool.execute({ query: "q" } as never, net.api, ctx),
    (error: unknown) => error === netErr,
  );

  // 缺 key / 缺轮标识 / 参数校验
  const noKey = setupSearch({ noKey: true });
  const noKeyTool = createSearchTool(noKey.manifests.get("search")!, noKey.deps, { fetch: fn });
  await assert.rejects(
    () => noKeyTool.execute({ query: "q" } as never, noKey.api, ctx),
    (error: unknown) => error instanceof Error && error.message === prompts.messages["search_nokey"],
  );
  const badQuery = setupSearch();
  const badTool = createSearchTool(badQuery.manifests.get("search")!, badQuery.deps, { fetch: fn });
  await assert.rejects(
    () => badTool.execute({ query: "x".repeat(129) } as never, badQuery.api, ctx),
    (error: unknown) => error instanceof Error && error.message === prompts.messages["search_query"],
  );
});

test("createSearchTool 透传 context.abortSignal：外部取消原样上抛 AbortError", async () => {
  const { manifests, api, deps } = setupSearch();
  const tool = createSearchTool(manifests.get("search")!, deps, { fetch: hangingFetch() });
  const ctrl = new AbortController();
  const pending = tool.execute({ query: "q" } as never, api, { abortSignal: ctrl.signal } as never);
  ctrl.abort();
  await assert.rejects(
    pending,
    (error: unknown) => error instanceof Error && error.name === "AbortError",
  );
});

test("deepseekSearch 在 !res.ok 与 content-length 超限路径调用 res.body.cancel()", async () => {
  let errCancelled = false;
  const errRes = new Response(
    new ReadableStream<Uint8Array>({
      start() {},
      cancel() { errCancelled = true; },
    }),
    { status: 502 },
  );
  await assert.rejects(
    () => deepseekSearch({ apiKey: "k", query: "q", count: 4, fetch: mockFetch([errRes]).fn }),
    SearchResponseError,
  );
  assert.equal(errCancelled, true, "!res.ok 应调用 res.body.cancel()");

  let oversizedCancelled = false;
  const oversizedRes = new Response(
    new ReadableStream<Uint8Array>({
      start() {},
      cancel() { oversizedCancelled = true; },
    }),
    { status: 200, headers: { "content-length": String(SEARCH_RESPONSE_MAX_BYTES + 1) } },
  );
  await assert.rejects(
    () => deepseekSearch({ apiKey: "k", query: "q", count: 4, fetch: mockFetch([oversizedRes]).fn }),
    SearchResponseError,
  );
  assert.equal(oversizedCancelled, true, "content-length 超限应调用 res.body.cancel()");
});