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
import { stream as streamCodeAssist } from "../src/model/google-code-assist.ts";
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
