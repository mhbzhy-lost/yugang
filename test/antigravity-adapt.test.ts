/**
 * Antigravity / Google Code Assist 适配与 proxy-fetch 超时单测：
 *  - gemini-4-hydrogen-low 在静默或调用工具后输出 thinking + 带 thoughtSignature 的空文本
 *    且省略 finishReason 时，按正常 stop 收口，不误报 "Google stream ended without a finish reason"
 *  - 真正异常（安全策略拒绝文本、无签名半途断流、非空文本断流）仍照旧报错
 *  - 适配器单次 HTTP 请求超时与 SSE 流空闲超时（timeoutMs）及时熔断为 error，不误判 aborted
 *  - createProxyFetch socket 空闲超时及时拒绝并透传 retry-after 响应头
 */
import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import http from "node:http";
import https from "node:https";
import net from "node:net";
import type { Duplex } from "node:stream";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Model, TranscriptContext } from "@earendil-works/pi-ai";
import { isRetryableAssistantError } from "@earendil-works/pi-ai/utils/retry";
import { discoverProject, stream as streamCodeAssist } from "../src/model/google-code-assist.ts";
import { createProxyFetch } from "../src/media/proxy-fetch.ts";

const TEST_MODEL: Model<"google-code-assist"> = {
  id: "gemini-4-hydrogen-low",
  name: "Gemini 4 Hydrogen (Low)",
  api: "google-code-assist",
  provider: "google-antigravity",
  baseUrl: "https://daily-cloudcode-pa.googleapis.com",
  reasoning: true,
  input: ["text", "image"],
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
  contextWindow: 1048576,
  maxTokens: 65536,
};

const TEST_CONTEXT: TranscriptContext = {
  messages: [{ role: "user", content: [{ type: "text", text: "hi" }], timestamp: 1 }],
};

function sseResponse(events: unknown[]): Response {
  const text = events.map((event) => `data: ${JSON.stringify(event)}\n\n`).join("");
  return new Response(text, {
    status: 200,
    headers: { "content-type": "text/event-stream" },
  });
}

test("google-code-assist：带 thoughtSignature 的空文本封口块省略 finishReason 时按正常 stop 收口", async () => {
  const fakeFetch: typeof fetch = async () =>
    sseResponse([
      {
        response: {
          responseId: "resp_empty_stop_1",
          candidates: [
            {
              content: {
                role: "model",
                parts: [{ thought: true, text: "Transmission complete. Execution finalized.\n\n" }],
              },
            },
          ],
          usageMetadata: { promptTokenCount: 10801, thoughtsTokenCount: 6, totalTokenCount: 10807 },
        },
      },
      {
        response: {
          responseId: "resp_empty_stop_1",
          candidates: [
            {
              content: {
                role: "model",
                parts: [{ text: "", thoughtSignature: "ErcBCrQB_signed_stop_token" }],
              },
            },
          ],
          usageMetadata: { promptTokenCount: 10801, thoughtsTokenCount: 6, totalTokenCount: 10807 },
        },
      },
    ]);

  const s = streamCodeAssist(TEST_MODEL, TEST_CONTEXT, {
    apiKey: "test-token",
    flavor: "antigravity",
    fetch: fakeFetch,
    maxRetries: 0,
  });
  const msg = await s.result();
  assert.equal(msg.stopReason, "stop");
  assert.equal(msg.errorMessage, undefined);
  assert.equal(msg.responseId, "resp_empty_stop_1");
  assert.equal(msg.content.length, 2);
  assert.equal(msg.content[0]?.type, "thinking");
  assert.equal(msg.content[1]?.type, "text");
});

test("google-code-assist：安全拦截拒绝文本或半途断流缺少 finishReason 时仍照旧报错", async () => {
  // 1) Google 安全策略拒绝文本（usage=0、无 responseId、非空拒绝文本）
  const policyBlockFetch: typeof fetch = async () =>
    sseResponse([
      {
        response: {
          candidates: [
            {
              content: {
                role: "model",
                parts: [{ text: "The prompt could not be submitted. The prompt contains sensitive words." }],
              },
            },
          ],
        },
      },
    ]);
  const blocked = await streamCodeAssist(TEST_MODEL, TEST_CONTEXT, {
    apiKey: "test-token",
    flavor: "antigravity",
    fetch: policyBlockFetch,
    maxRetries: 0,
  }).result();
  assert.equal(blocked.stopReason, "error");
  assert.match(blocked.errorMessage ?? "", /Google stream ended without a finish reason/);

  // 2) 半途断流：只有 thinking，没有带 thoughtSignature 的封口空文本块
  const midThinkingDropFetch: typeof fetch = async () =>
    sseResponse([
      {
        response: {
          responseId: "resp_drop_mid_thinking",
          candidates: [{ content: { role: "model", parts: [{ thought: true, text: "Thinking..." }] } }],
          usageMetadata: { promptTokenCount: 100, thoughtsTokenCount: 5, totalTokenCount: 105 },
        },
      },
    ]);
  const dropped = await streamCodeAssist(TEST_MODEL, TEST_CONTEXT, {
    apiKey: "test-token",
    flavor: "antigravity",
    fetch: midThinkingDropFetch,
    maxRetries: 0,
  }).result();
  assert.equal(dropped.stopReason, "error");
  assert.match(dropped.errorMessage ?? "", /Google stream ended without a finish reason/);

  // 3) 非空正文半途断流（即使最后块带了签名，非空正文缺 finishReason 也不得吞错）
  const midTextDropFetch: typeof fetch = async () =>
    sseResponse([
      {
        response: {
          responseId: "resp_drop_mid_text",
          candidates: [{ content: { role: "model", parts: [{ text: "写到一半突然断", thoughtSignature: "sig" }] } }],
          usageMetadata: { promptTokenCount: 100, candidatesTokenCount: 10, totalTokenCount: 110 },
        },
      },
    ]);
  const midText = await streamCodeAssist(TEST_MODEL, TEST_CONTEXT, {
    apiKey: "test-token",
    flavor: "antigravity",
    fetch: midTextDropFetch,
    maxRetries: 0,
  }).result();
  assert.equal(midText.stopReason, "error");
  assert.match(midText.errorMessage ?? "", /Google stream ended without a finish reason/);
});

test("google-code-assist：HTTP 挂起与 SSE 流中途卡死均按 timeoutMs 及时熔断为 error（非 aborted）", async () => {
  // 1) fetch 永不返回：受 timeoutMs 熔断
  const hangingFetch: typeof fetch = (_url, init) =>
    new Promise((_resolve, reject) => {
      init?.signal?.addEventListener("abort", () => reject(init.signal?.reason ?? new Error("aborted")), { once: true });
    });
  const t0 = Date.now();
  const reqTimeoutMsg = await streamCodeAssist(TEST_MODEL, TEST_CONTEXT, {
    apiKey: "test-token",
    flavor: "antigravity",
    fetch: hangingFetch,
    timeoutMs: 60,
    maxRetries: 0,
  }).result();
  assert.equal(reqTimeoutMsg.stopReason, "error");
  assert.match(reqTimeoutMsg.errorMessage ?? "", /timed out/);
  assert.ok(Date.now() - t0 < 2000, "HTTP 请求超时应及时返回");

  // 2) 响应头已到但 SSE 流中途不再吐 chunk：受 SSE idle timeout 熔断
  const stalledSseFetch: typeof fetch = async () => {
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        const first = `data: ${JSON.stringify({
          response: {
            responseId: "resp_stalled",
            candidates: [{ content: { role: "model", parts: [{ thought: true, text: "thinking..." }] } }],
          },
        })}\n\n`;
        controller.enqueue(new TextEncoder().encode(first));
        // 故意不再 close，模拟上游半开挂起
      },
    });
    return new Response(body, { status: 200, headers: { "content-type": "text/event-stream" } });
  };
  const t1 = Date.now();
  const sseTimeoutMsg = await streamCodeAssist(TEST_MODEL, TEST_CONTEXT, {
    apiKey: "test-token",
    flavor: "antigravity",
    fetch: stalledSseFetch,
    timeoutMs: 60,
    maxRetries: 0,
  }).result();
  assert.equal(sseTimeoutMsg.stopReason, "error");
  assert.match(sseTimeoutMsg.errorMessage ?? "", /timed out/);
  assert.ok(Date.now() - t1 < 2000, "SSE 流空闲超时应及时返回");
});

test("proxy-fetch：挂起连接按 idleTimeoutMs 及时拒绝，并透传 retry-after 响应头", async (t) => {
  const dir = mkdtempSync(join(tmpdir(), "proxy-timeout-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const keyPath = join(dir, "key.pem");
  const certPath = join(dir, "cert.pem");
  const cert = spawnSync(
    "openssl",
    ["req", "-x509", "-newkey", "rsa:2048", "-nodes", "-days", "1", "-subj", "/CN=127.0.0.1", "-keyout", keyPath, "-out", certPath],
    { encoding: "utf8" },
  );
  if (cert.status !== 0) {
    t.skip("需要 openssl");
    return;
  }

  const tlsSockets = new Set<Duplex>();
  const tlsServer = https.createServer(
    { key: readFileSync(keyPath), cert: readFileSync(certPath) },
    (req, res) => {
      if (req.url === "/hang") {
        // 接收请求但不回响应头，模拟半开挂起
        req.resume();
        return;
      }
      if (req.url === "/rate-limited") {
        req.resume();
        res.writeHead(429, { "content-type": "application/json", "retry-after": "12" });
        res.end(JSON.stringify({ error: "too many requests" }));
        return;
      }
      res.writeHead(404);
      res.end();
    },
  );
  tlsServer.on("connection", (s) => {
    tlsSockets.add(s);
    s.on("close", () => tlsSockets.delete(s));
  });
  await new Promise<void>((resolve) => tlsServer.listen(0, "127.0.0.1", resolve));
  const tlsAddr = tlsServer.address();
  assert.ok(tlsAddr && typeof tlsAddr !== "string");

  const proxySockets = new Set<Duplex>();
  const proxyServer = http.createServer();
  proxyServer.on("connect", (req, clientSocket, head) => {
    const [host, port] = String(req.url).split(":");
    const upstream = net.connect(Number(port), host, () => {
      clientSocket.write("HTTP/1.1 200 Connection established\r\n\r\n");
      if (head.length > 0) upstream.write(head);
      upstream.pipe(clientSocket);
      clientSocket.pipe(upstream);
    });
    proxySockets.add(clientSocket);
    proxySockets.add(upstream);
    const drop = () => {
      upstream.destroy();
      clientSocket.destroy();
    };
    upstream.on("error", drop);
    clientSocket.on("error", drop);
  });
  await new Promise<void>((resolve) => proxyServer.listen(0, "127.0.0.1", resolve));
  const proxyAddr = proxyServer.address();
  assert.ok(proxyAddr && typeof proxyAddr !== "string");

  t.after(async () => {
    for (const s of [...proxySockets, ...tlsSockets]) s.destroy();
    await new Promise<void>((r) => proxyServer.close(() => r()));
    await new Promise<void>((r) => tlsServer.close(() => r()));
  });

  const previousTls = process.env["NODE_TLS_REJECT_UNAUTHORIZED"];
  process.env["NODE_TLS_REJECT_UNAUTHORIZED"] = "0";
  try {
    const proxied = createProxyFetch(`http://127.0.0.1:${proxyAddr.port}`, { idleTimeoutMs: 120 });
    assert.ok(proxied);

    const t0 = Date.now();
    await assert.rejects(
      proxied(`https://127.0.0.1:${tlsAddr.port}/hang`),
      /proxy fetch timed out after 120ms/,
    );
    assert.ok(Date.now() - t0 < 2000, "proxy-fetch 应在 idleTimeoutMs 后迅速失败");

    const res = await proxied(`https://127.0.0.1:${tlsAddr.port}/rate-limited`);
    assert.equal(res.status, 429);
    assert.equal(res.headers.get("retry-after"), "12");
  } finally {
    if (previousTls === undefined) delete process.env["NODE_TLS_REJECT_UNAUTHORIZED"];
    else process.env["NODE_TLS_REJECT_UNAUTHORIZED"] = previousTls;
  }
});

test("google-code-assist：默认内层重试为 0；isImageFormat400 剥图仅重试 1 次且不触发内层重试", async () => {
  let calls429 = 0;
  const fetch429: typeof fetch = async () => {
    calls429 += 1;
    return new Response("too many requests", { status: 429, headers: { "retry-after-ms": "1" } });
  };
  const msg429 = await streamCodeAssist(TEST_MODEL, TEST_CONTEXT, {
    apiKey: "test-token",
    flavor: "antigravity",
    fetch: fetch429,
  }).result();
  assert.equal(msg429.stopReason, "error");
  assert.equal(calls429, 1, "默认内层重试必须为 0（429 只发 1 次请求，交给外层 pi-durable）");

  // isImageFormat400：带 inlineData 首轮 400 后剥图再试 1 次；即使降级分支遇 503 也不内层重试
  const imageCtx: TranscriptContext = {
    messages: [
      {
        role: "user",
        content: [
          { type: "text", text: "describe" },
          { type: "image", data: "AQID", mimeType: "image/png" },
        ],
        timestamp: 1,
      },
    ],
  };
  let imageCalls = 0;
  const fetchImage400Then503: typeof fetch = async () => {
    imageCalls += 1;
    if (imageCalls === 1) return new Response("invalid inline image payload", { status: 400 });
    return new Response("upstream unavailable", { status: 503 });
  };
  const msgImg = await streamCodeAssist(TEST_MODEL, imageCtx, {
    apiKey: "test-token",
    flavor: "antigravity",
    fetch: fetchImage400Then503,
    maxRetries: 3,
  }).result();
  assert.equal(msgImg.stopReason, "error");
  assert.equal(imageCalls, 2, "剥图降级只发 1 次降级请求，且强制 maxRetries: 0");
});

test("google-code-assist：readSseEvents 跳过 [DONE]、识别行内 parsed.error、早退 cancel()、EOF 半包命中可重试正则", async () => {
  // 1) [DONE] 被跳过，正常结束
  const doneEvents =
    `data: ${JSON.stringify({
      response: {
        responseId: "resp_done",
        candidates: [{ content: { role: "model", parts: [{ text: "ok" }] }, finishReason: "STOP" }],
        usageMetadata: { promptTokenCount: 1, candidatesTokenCount: 1, totalTokenCount: 2 },
      },
    })}\n\n` + "data: [DONE]\n\n";
  const msgDone = await streamCodeAssist(TEST_MODEL, TEST_CONTEXT, {
    apiKey: "test-token",
    flavor: "antigravity",
    fetch: async () => new Response(doneEvents, { status: 200, headers: { "content-type": "text/event-stream" } }),
  }).result();
  assert.equal(msgDone.stopReason, "stop");

  // 2) 行内 parsed.error 立即抛错（含状态码与消息）
  const inlineErrSse = `data: ${JSON.stringify({ error: { code: 503, message: "service temporarily overloaded" } })}\n\n`;
  const msgInlineErr = await streamCodeAssist(TEST_MODEL, TEST_CONTEXT, {
    apiKey: "test-token",
    flavor: "antigravity",
    fetch: async () => new Response(inlineErrSse, { status: 200, headers: { "content-type": "text/event-stream" } }),
  }).result();
  assert.equal(msgInlineErr.stopReason, "error");
  assert.match(msgInlineErr.errorMessage ?? "", /503/);
  assert.match(msgInlineErr.errorMessage ?? "", /service temporarily overloaded/);

  // 3) EOF 残留半包 JSON 抛出的错误必须命中 pi-durable isRetryableAssistantError === true
  const truncatedSse =
    `data: ${JSON.stringify({
      response: { responseId: "resp_partial", candidates: [{ content: { role: "model", parts: [{ text: "hi" }] } }] },
    })}\n\n` + 'data: {"response":{"candidates":[{"content":{"parts":[{"text":"cut';
  const msgTruncated = await streamCodeAssist(TEST_MODEL, TEST_CONTEXT, {
    apiKey: "test-token",
    flavor: "antigravity",
    fetch: async () => new Response(truncatedSse, { status: 200, headers: { "content-type": "text/event-stream" } }),
  }).result();
  assert.equal(msgTruncated.stopReason, "error");
  assert.equal(
    isRetryableAssistantError(msgTruncated),
    true,
    `EOF 半包错必须命中 isRetryableAssistantError，实际 errorMessage=${msgTruncated.errorMessage}`,
  );

  // 4) 早退 / 取消时必须调用 reader.cancel()
  let cancelled = false;
  const ac = new AbortController();
  const s = streamCodeAssist(TEST_MODEL, TEST_CONTEXT, {
    apiKey: "test-token",
    flavor: "antigravity",
    signal: ac.signal,
    fetch: async () => {
      const body = new ReadableStream<Uint8Array>({
        start(controller) {
          controller.enqueue(
            new TextEncoder().encode(
              `data: ${JSON.stringify({
                response: { responseId: "r_cancel", candidates: [{ content: { role: "model", parts: [{ text: "part1" }] } }] },
              })}\n\n`,
            ),
          );
          setTimeout(() => ac.abort(new Error("user cancelled")), 30);
        },
        cancel() {
          cancelled = true;
        },
      });
      return new Response(body, { status: 200, headers: { "content-type": "text/event-stream" } });
    },
  });
  const msgCancelled = await s.result();
  assert.equal(msgCancelled.stopReason, "aborted");
  assert.equal(cancelled, true, "早退时必须调用 reader.cancel()");
});

test("discoverProject：5000ms 轮询响应 AbortSignal 立即退出", async () => {
  const ac = new AbortController();
  let calls = 0;
  const fakeFetch: typeof fetch = async (input) => {
    calls += 1;
    const url = String(input);
    if (url.endsWith(":loadCodeAssist")) {
      return new Response(JSON.stringify({}), { status: 200, headers: { "content-type": "application/json" } });
    }
    if (url.endsWith(":onboardUser")) {
      setTimeout(() => ac.abort(new Error("aborted-poll")), 40);
      return new Response(JSON.stringify({ done: false, name: "operations/op-1" }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    }
    throw new Error(`unexpected ${url}`);
  };
  const t0 = Date.now();
  await assert.rejects(discoverProject("tok", "gemini", fakeFetch, ac.signal));
  assert.ok(Date.now() - t0 < 1000, "discoverProject 轮询应立即响应 AbortSignal");
  assert.equal(calls, 2);
});
