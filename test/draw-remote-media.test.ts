/**
 * draw_remote 四通道适配器层（src/media/draw-remote/）与 proxy-fetch 二进制 / FormData 修复的兜底测试。
 *
 *  - proxy-fetch：本地 CONNECT 代理桩 + 自签名 TLS 服务，验证 PNG 逐字节无损、JSON 可读、
 *    FormData 保留 multipart/form-data boundary、传输中途 abort 与截断保护；
 *  - gemini：标准 Gemini Generative Language API（/models/<model>:generateContent + x-goog-api-key），
 *    URL 拼装、inlineData/inline_data 解析、submitted 边界、上游错误脱敏与清洗、取消围栏；
 *  - gpt：标准 OpenAI Images API（/images/generations JSON 与 /images/edits FormData + Bearer），
 *    单图 image / 多图 image[]、错误细节清洗与脱敏、submitted 边界；
 *  - wan / qwen：百炼原生多模态生图接口契约与 preflightDrawRemote 四通道统一纯 API Key 预检。
 *
 * 全部请求走注入的 fetchImpl 或本地回环服务，不碰真实上游；凭据全是测试字面量。
 */
import test, { type TestContext } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import http from "node:http";
import https from "node:https";
import net from "node:net";
import type { Duplex } from "node:stream";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { isRetryableAssistantError } from "@earendil-works/pi-ai/utils/retry";
import { createProxyFetch } from "../src/media/proxy-fetch.ts";
import { generateGptImages } from "../src/media/gpt-image.ts";
import { generateWanImage } from "../src/media/wan-image.ts";
import {
  DRAW_REMOTE_JOB_TIMEOUT_MS,
  DRAW_REMOTE_PROVIDER_IDS,
  DRAW_REMOTE_TIMEOUT_MS,
  DrawRemoteError,
  generateGeminiImage,
  preflightDrawRemote,
  runDrawRemote,
  type DrawRemoteAspectRatio,
  type DrawRemoteRunRequest,
  type DrawRemoteStageEvent,
  type GeminiImageRequest,
} from "../src/media/draw-remote/index.ts";

// ---------- 样本字节 ----------

const PNG = patternBytes(2048, [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
const JPEG = patternBytes(1536, [0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46, 0x49, 0x46]);
const GIF = patternBytes(1536, [0x47, 0x49, 0x46, 0x38, 0x39, 0x61]);
const WEBP = patternBytes(1536, [0x52, 0x49, 0x46, 0x46, 0x24, 0x06, 0x00, 0x00, 0x57, 0x45, 0x42, 0x50]);
const TINY_PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x00, 0x00, 0x0d]);

function patternBytes(length: number, head: number[]): Buffer {
  const bytes = Buffer.alloc(length);
  Buffer.from(head).copy(bytes, 0);
  for (let i = head.length; i < length; i++) bytes[i] = ((i * 31 + (i >> 3) + 7) ^ (i << 1)) & 0xff;
  return bytes;
}

// ---------- fetch 桩 ----------

interface FetchCall {
  url: string;
  init: RequestInit | undefined;
}

type FetchHandler = (url: string, init: RequestInit | undefined, index: number) => Response | Promise<Response>;

function fakeFetch(handler: FetchHandler): { impl: typeof fetch; calls: FetchCall[] } {
  const calls: FetchCall[] = [];
  const impl: typeof fetch = async (input, init) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    calls.push({ url, init });
    return handler(url, init, calls.length - 1);
  };
  return { impl, calls };
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
}

function bytesResponse(bytes: Buffer, type = "application/octet-stream", status = 200): Response {
  return new Response(new Uint8Array(bytes), { status, headers: { "content-type": type } });
}

function textResponse(text: string, status = 200): Response {
  return new Response(text, { status, headers: { "content-type": "text/plain" } });
}

function bodyOf(init: RequestInit | undefined): Record<string, any> {
  return JSON.parse(String(init?.body)) as Record<string, any>;
}

function headerOf(init: RequestInit | undefined, name: string): string | undefined {
  return new Headers(init?.headers).get(name) ?? undefined;
}

// ---------- 临时工作区与夹具 ----------

const GEMINI_PROVIDER_ID = "cliproxyapi-gemini";
const CODEX_PROVIDER_ID = "cliproxyapi-codex";
const QWEN = "qwen-token-plan-cn";

const GEMINI_BASE_URL = "http://cliproxyapi.test:8317/v1beta/";
const GEMINI_API_KEY = "sk-gemini-proxy-key-0001";
const GEMINI_GENERATE_URL = "http://cliproxyapi.test:8317/v1beta/models/gemini-3.1-flash-image:generateContent";

const CODEX_BASE_URL = "http://cliproxyapi.test:8317/v1/";
const CODEX_API_KEY = "sk-codex-proxy-key-0001";
const CODEX_GEN_URL = "http://cliproxyapi.test:8317/v1/images/generations";
const CODEX_EDIT_URL = "http://cliproxyapi.test:8317/v1/images/edits";

const GEMINI_PROVIDER = { api: "google-generative-ai", baseUrl: GEMINI_BASE_URL };
const CODEX_PROVIDER = { api: "openai-responses", baseUrl: CODEX_BASE_URL };

function geminiImageParts(bytes = JPEG, snakeCase = false): Record<string, unknown> {
  return snakeCase
    ? { inline_data: { mime_type: "image/jpeg", data: bytes.toString("base64") } }
    : { inlineData: { mimeType: "image/jpeg", data: bytes.toString("base64") } };
}

function workspace() {
  const dir = mkdtempSync(join(tmpdir(), "draw-remote-media-"));
  const modelsPath = join(dir, "models.json");
  const credentialsPath = join(dir, "auth.json");
  const mediaRoot = join(dir, "media");
  writeFileSync(modelsPath, JSON.stringify({ providers: {} }));
  return {
    dir,
    modelsPath,
    credentialsPath,
    mediaRoot,
    models(providers: Record<string, unknown>) {
      writeFileSync(modelsPath, JSON.stringify({ providers }));
    },
    credentials(entries: Record<string, unknown>) {
      writeFileSync(credentialsPath, JSON.stringify(entries));
    },
    files(): string[] {
      const gen = join(mediaRoot, "gen");
      return existsSync(gen) ? readdirSync(gen).sort() : [];
    },
    cleanup() {
      rmSync(dir, { recursive: true, force: true });
    },
  };
}

type Workspace = ReturnType<typeof workspace>;

function submitTracker(): { count: () => number; hook: () => void } {
  let count = 0;
  return {
    count: () => count,
    hook: () => {
      count += 1;
    },
  };
}

function geminiBase(ws: Workspace, overrides: Partial<GeminiImageRequest> = {}): GeminiImageRequest {
  return {
    baseUrl: GEMINI_BASE_URL,
    apiKey: GEMINI_API_KEY,
    model: "gemini-3.1-flash-image",
    prompt: "a cat sitting on a sofa",
    mediaRoot: ws.mediaRoot,
    ...overrides,
  };
}

function runRequest(ws: Workspace, overrides: Partial<DrawRemoteRunRequest> = {}): DrawRemoteRunRequest {
  return {
    provider: "gemini",
    model: "gemini-3.1-flash-image",
    prompt: "a cat sitting on a sofa",
    mediaRoot: ws.mediaRoot,
    modelsPath: ws.modelsPath,
    credentialsPath: ws.credentialsPath,
    ...overrides,
  };
}

function expectDrawRemoteError(
  provider: string,
  code: string,
  submitted: boolean,
  includes: readonly string[] = [],
  excludes: readonly string[] = [],
): (error: unknown) => boolean {
  return (error) => {
    assert.ok(error instanceof DrawRemoteError, `应为 DrawRemoteError，实际：${String(error)}`);
    assert.equal(error.provider, provider);
    assert.equal(error.code, code);
    assert.equal(error.submitted, submitted, `submitted 应为 ${submitted}：${error.message}`);
    for (const needle of includes) assert.ok(error.message.includes(needle), `错误文案应含「${needle}」：${error.message}`);
    for (const needle of excludes) assert.ok(!error.message.includes(needle), `错误文案不得含「${needle}」：${error.message}`);
    return true;
  };
}

function expectAbort(): (error: unknown) => boolean {
  return (error) => {
    assert.equal((error as { name?: unknown } | null)?.name, "AbortError", `应为 AbortError，实际：${String(error)}`);
    return true;
  };
}

// ---------- 本地 TLS 服务 + CONNECT 代理桩（只服务回环） ----------

interface LoopbackServer {
  url: string;
  close(): Promise<void>;
}

function makeCertificate(dir: string): { key: Buffer; cert: Buffer } | undefined {
  const key = join(dir, "tls-key.pem");
  const cert = join(dir, "tls-cert.pem");
  const variants = [
    ["req", "-x509", "-newkey", "ec", "-pkeyopt", "ec_paramgen_curve:prime256v1", "-nodes"],
    ["req", "-x509", "-newkey", "rsa:2048", "-nodes"],
  ];
  for (const args of variants) {
    const result = spawnSync("openssl", [...args, "-keyout", key, "-out", cert, "-days", "1", "-subj", "/CN=127.0.0.1"], {
      encoding: "utf8",
      env: { ...process.env, RANDFILE: join(dir, ".rnd") },
    });
    if (result.status === 0 && existsSync(key) && existsSync(cert)) {
      return { key: readFileSync(key), cert: readFileSync(cert) };
    }
  }
  return undefined;
}

function closeServer(server: http.Server | https.Server, sockets: Iterable<Duplex>): Promise<void> {
  for (const socket of sockets) socket.destroy();
  server.closeAllConnections();
  return new Promise((resolve) => server.close(() => resolve()));
}

async function startTlsServer(dir: string, handler: http.RequestListener): Promise<LoopbackServer | undefined> {
  const pem = makeCertificate(dir);
  if (!pem) return undefined;
  const server = https.createServer({ key: pem.key, cert: pem.cert }, handler);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (address === null || typeof address === "string") throw new Error("tls server 没有端口");
  return {
    url: `https://127.0.0.1:${address.port}`,
    close: () => closeServer(server, []),
  };
}

async function startConnectProxy(): Promise<LoopbackServer> {
  const sockets = new Set<Duplex>();
  const proxy = http.createServer();
  proxy.on("connect", (request, clientSocket, head) => {
    const [host, port] = String(request.url).split(":");
    if (host !== "127.0.0.1") {
      clientSocket.end("HTTP/1.1 403 Forbidden\r\n\r\n");
      return;
    }
    const upstream = net.connect(Number(port), host, () => {
      clientSocket.write("HTTP/1.1 200 Connection established\r\n\r\n");
      if (head.length > 0) upstream.write(head);
      upstream.pipe(clientSocket);
      clientSocket.pipe(upstream);
    });
    sockets.add(upstream);
    sockets.add(clientSocket);
    const drop = () => {
      upstream.destroy();
      clientSocket.destroy();
    };
    upstream.on("error", drop);
    clientSocket.on("error", drop);
  });
  await new Promise<void>((resolve) => proxy.listen(0, "127.0.0.1", resolve));
  const address = proxy.address();
  if (address === null || typeof address === "string") throw new Error("proxy 没有端口");
  return {
    url: `http://127.0.0.1:${address.port}`,
    close: () => closeServer(proxy, sockets),
  };
}

function withInsecureLoopbackTls<T>(run: () => Promise<T>): Promise<T> {
  const previous = process.env["NODE_TLS_REJECT_UNAUTHORIZED"];
  process.env["NODE_TLS_REJECT_UNAUTHORIZED"] = "0";
  return run().finally(() => {
    if (previous === undefined) delete process.env["NODE_TLS_REJECT_UNAUTHORIZED"];
    else process.env["NODE_TLS_REJECT_UNAUTHORIZED"] = previous;
  });
}

// =====================================================================
// proxy-fetch 二进制无损与 FormData boundary 保活
// =====================================================================

test("proxy-fetch：经 CONNECT 隧道取回的 PNG 逐字节无损，JSON/文本照常可读，无正文状态码给 null", async (t) => {
  const dir = mkdtempSync(join(tmpdir(), "proxy-fetch-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const payload = JSON.stringify({ ok: true, note: "中文 ✓" });
  const seen: { method?: string; body: string }[] = [];
  const tls = await startTlsServer(dir, (request, response) => {
    let body = "";
    request.on("data", (chunk) => void (body += chunk));
    request.on("end", () => {
      seen.push({ method: request.method, body });
      if (request.url === "/image.png") {
        response.writeHead(200, { "content-type": "image/png" });
        response.end(PNG);
      } else if (request.url === "/echo" && request.method === "POST") {
        response.writeHead(200, { "content-type": "application/json" });
        response.end(JSON.stringify({ ok: true, echo: body }));
      } else if (request.url === "/json") {
        response.writeHead(200, { "content-type": "application/json" });
        response.end(payload);
      } else if (request.url === "/nothing") {
        response.writeHead(204);
        response.end();
      } else {
        response.writeHead(404);
        response.end("missing");
      }
    });
  });
  const proxy = tls ? await startConnectProxy() : undefined;
  if (!tls || !proxy) {
    t.skip("需要 openssl 与回环端口");
    return;
  }
  t.after(async () => {
    await proxy.close();
    await tls.close();
  });

  await withInsecureLoopbackTls(async () => {
    const proxied = createProxyFetch(proxy.url);
    assert.ok(proxied, "合法的 http 代理地址应返回 fetch");

    const image = await proxied(`${tls.url}/image.png`);
    assert.equal(image.status, 200);
    assert.ok(Buffer.from(await image.arrayBuffer()).equals(PNG), "二进制正文必须逐字节一致");

    const json = await proxied(`${tls.url}/json`);
    assert.deepEqual(await json.json(), { ok: true, note: "中文 ✓" });
    assert.equal(await (await proxied(`${tls.url}/json`)).text(), payload);

    const echoed = await proxied(`${tls.url}/echo`, {
      method: "POST",
      headers: { "content-type": "application/json", "x-test": "1" },
      body: JSON.stringify({ hello: "world" }),
    });
    assert.deepEqual(await echoed.json(), { ok: true, echo: JSON.stringify({ hello: "world" }) });
    assert.equal(seen.at(-1)?.method, "POST");

    const none = await proxied(`${tls.url}/nothing`);
    assert.equal(none.status, 204);
    assert.equal(await none.text(), "");
  });
});

test("proxy-fetch：发送 FormData 时保留 multipart/form-data boundary，上游可无损还原字段与二进制附件", async (t) => {
  const dir = mkdtempSync(join(tmpdir(), "proxy-fetch-form-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  let receivedContentType = "";
  let receivedRaw = Buffer.alloc(0);
  const tls = await startTlsServer(dir, (request, response) => {
    receivedContentType = String(request.headers["content-type"] ?? "");
    const chunks: Buffer[] = [];
    request.on("data", (chunk: Buffer) => chunks.push(chunk));
    request.on("end", () => {
      receivedRaw = Buffer.concat(chunks);
      response.writeHead(200, { "content-type": "application/json" });
      response.end(JSON.stringify({ ok: true }));
    });
  });
  const proxy = tls ? await startConnectProxy() : undefined;
  if (!tls || !proxy) {
    t.skip("需要 openssl 与回环端口");
    return;
  }
  t.after(async () => {
    await proxy.close();
    await tls.close();
  });

  await withInsecureLoopbackTls(async () => {
    const proxied = createProxyFetch(proxy.url);
    assert.ok(proxied);
    const form = new FormData();
    form.append("model", "gpt-image-2.6-flare");
    form.append("prompt", "draw a cat");
    form.append("image", new Blob([new Uint8Array(PNG)], { type: "image/png" }), "ref-0.png");

    const res = await proxied(`${tls.url}/v1/images/edits`, {
      method: "POST",
      headers: { authorization: "Bearer test-key" },
      body: form,
    });
    assert.equal(res.status, 200);
    assert.match(receivedContentType, /^multipart\/form-data;\s*boundary=/i, `必须携带 boundary：${receivedContentType}`);

    const parsed = await new Response(receivedRaw, { headers: { "content-type": receivedContentType } }).formData();
    assert.equal(parsed.get("model"), "gpt-image-2.6-flare");
    assert.equal(parsed.get("prompt"), "draw a cat");
    const file = parsed.get("image") as File;
    assert.ok(file instanceof Blob);
    assert.equal(file.name, "ref-0.png");
    assert.ok(Buffer.from(await file.arrayBuffer()).equals(PNG), "经代理转发的 FormData 附件字节必须逐字节无损");
  });
});

test("proxy-fetch：非法代理地址返回 undefined，非 https 目标直接抛错不静默直连", async () => {
  assert.equal(createProxyFetch("socks5://127.0.0.1:1080"), undefined);
  assert.equal(createProxyFetch("not a url"), undefined);
  const proxied = createProxyFetch("http://127.0.0.1:1");
  assert.ok(proxied);
  await assert.rejects(proxied("http://127.0.0.1:1/x"), /https targets only/);
});

test("proxy-fetch：响应头已到、正文传输中途 abort → reject；上游提前断开截断正文 → reject，绝不 resolve 截断数据", async (t) => {
  const dir = mkdtempSync(join(tmpdir(), "proxy-fetch-abort-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  let firstChunkWritten: (() => void) | undefined;
  const firstChunk = new Promise<void>((resolve) => {
    firstChunkWritten = resolve;
  });
  const timers: NodeJS.Timeout[] = [];
  let tls: LoopbackServer | undefined;
  tls = await startTlsServer(dir, (request, response) => {
    request.resume();
    response.on("error", () => {});
    if (request.url === "/slow") {
      response.writeHead(200, { "content-type": "application/octet-stream", "content-length": String(PNG.length) });
      response.write(PNG.subarray(0, 1024), () => firstChunkWritten?.());
      timers.push(
        setTimeout(() => {
          if (!response.destroyed) response.end(PNG.subarray(1024));
        }, 800),
      );
      return;
    }
    if (request.url === "/whole") {
      response.writeHead(200, { "content-type": "application/octet-stream", "content-length": String(PNG.length) });
      response.end(PNG);
      return;
    }
    response.writeHead(200, {
      "content-type": "application/octet-stream",
      ...(request.url === "/truncated-length" ? { "content-length": String(PNG.length) } : {}),
    });
    response.write(PNG.subarray(0, 1024), () => {
      timers.push(setTimeout(() => response.socket?.destroy(), 30));
    });
  });
  const proxy = tls ? await startConnectProxy() : undefined;
  if (!tls || !proxy) {
    t.skip("需要 openssl 与回环端口");
    return;
  }
  t.after(async () => {
    for (const timer of timers) clearTimeout(timer);
    await proxy.close();
    await tls?.close();
  });

  await withInsecureLoopbackTls(async () => {
    const proxied = createProxyFetch(proxy.url);
    assert.ok(proxied);

    const controller = new AbortController();
    const pending = proxied(`${tls.url}/slow`, { signal: controller.signal }).then((res) => res.arrayBuffer());
    await firstChunk;
    await new Promise((resolve) => setTimeout(resolve, 100));
    controller.abort();
    await assert.rejects(pending, expectAbort());

    for (const path of ["/truncated-length", "/truncated-chunked"]) {
      await assert.rejects(async () => {
        const res = await proxied(`${tls.url}${path}`);
        await res.arrayBuffer();
      }, (error: unknown) => {
        assert.ok(error instanceof Error, `应当以 Error 拒绝，实际：${String(error)}`);
        assert.doesNotMatch(error.message, /HTTPS targets|https targets only/);
        if (error.message !== "aborted") {
          assert.equal(isRetryableAssistantError({ stopReason: "error", errorMessage: error.message }), true, `${path}：${error.message}`);
        }
        return true;
      }, path);
    }

    const whole = await proxied(`${tls.url}/whole`);
    assert.equal(whole.status, 200);
    assert.ok(Buffer.from(await whole.arrayBuffer()).equals(PNG));
  });
});

test("proxy-fetch：截断 / 提前断开的两条报错文案均命中 isRetryableAssistantError", () => {
  for (const message of [
    "proxy fetch: upstream stream ended without completion (truncated)",
    "proxy fetch: upstream stream ended without completion (connection closed)",
  ]) {
    assert.equal(isRetryableAssistantError({ stopReason: "error", errorMessage: message }), true, message);
  }
});

// =====================================================================
// DRAW_REMOTE_PROVIDER_IDS
// =====================================================================

test("DRAW_REMOTE_PROVIDER_IDS：gpt 指向 cliproxyapi-codex，gemini 指向 cliproxyapi-gemini", () => {
  assert.deepEqual(DRAW_REMOTE_PROVIDER_IDS, {
    gpt: "cliproxyapi-codex",
    wan: "qwen-token-plan-cn",
    qwen: "qwen-token-plan-cn",
    gemini: "cliproxyapi-gemini",
  });
});

// =====================================================================
// gemini：标准 Gemini Generative Language API 契约
// =====================================================================

test("gemini：标准 /models/<model>:generateContent + x-goog-api-key，支持 inlineData/inline_data、去尾斜杠与前导 models/ 剥除", async (t) => {
  const ws = workspace();
  t.after(() => ws.cleanup());
  const submitted = submitTracker();
  let responseMode: "inlineData" | "inline_data" = "inlineData";
  const fetch = fakeFetch(() => {
    assert.equal(submitted.count(), 1, "onSubmitted 必须在生成 POST 之前同步触发");
    const candidate = {
      content: { parts: [{ text: "here you go" }, geminiImageParts(JPEG, responseMode === "inline_data")] },
      finishReason: "STOP",
    };
    return jsonResponse(responseMode === "inline_data" ? { response: { candidates: [candidate] } } : { candidates: [candidate] });
  });

  const files = await generateGeminiImage({
    ...geminiBase(ws),
    aspectRatio: "3:4",
    images: [{ mimeType: "image/png", bytes: PNG }],
    onSubmitted: submitted.hook,
    fetchImpl: fetch.impl,
  });

  assert.equal(fetch.calls.length, 1);
  assert.equal(fetch.calls[0]?.url, GEMINI_GENERATE_URL, "尾斜杠剥除后不拼双斜杠");
  const init = fetch.calls[0]?.init;
  const body = bodyOf(init);
  assert.equal("project" in body, false, "标准 Gemini API 不含 project 私有字段");
  assert.equal("userAgent" in body, false, "标准 Gemini API 不含 userAgent 私有字段");
  assert.equal("requestId" in body, false, "标准 Gemini API 不含 requestId 私有字段");
  assert.equal("request" in body, false, "标准 Gemini API 不含外层 request 信封");
  assert.deepEqual(body["generationConfig"], { responseModalities: ["IMAGE", "TEXT"], imageConfig: { aspectRatio: "3:4" } });
  assert.deepEqual(body["contents"], [
    {
      role: "user",
      parts: [
        { inlineData: { mimeType: "image/png", data: PNG.toString("base64") } },
        { text: "a cat sitting on a sofa" },
      ],
    },
  ]);
  assert.equal(headerOf(init, "x-goog-api-key"), GEMINI_API_KEY);
  assert.equal(headerOf(init, "content-type"), "application/json");
  assert.equal(headerOf(init, "authorization"), undefined, "不带 Bearer authorization");
  assert.equal(headerOf(init, "user-agent"), undefined, "不带伪装 user-agent");
  assert.equal(submitted.count(), 1);
  assert.equal(files.length, 1);
  assert.match(String(files[0]), /^\d+-[0-9a-f-]{36}\.jpg$/);
  assert.ok(readFileSync(join(ws.mediaRoot, "gen", String(files[0]))).equals(JPEG));

  // 纯文生图 + models/ 前缀剥除 + 特殊字符编码 + snake_case inline_data
  responseMode = "inline_data";
  const plain = await generateGeminiImage({
    ...geminiBase(ws, { model: "models/gemini 3.1/preview", prompt: "a lighthouse at dusk" }),
    fetchImpl: fetch.impl,
  });
  assert.equal(fetch.calls.length, 2);
  assert.equal(
    fetch.calls[1]?.url,
    "http://cliproxyapi.test:8317/v1beta/models/gemini%203.1%2Fpreview:generateContent",
  );
  const plainBody = bodyOf(fetch.calls[1]?.init);
  assert.deepEqual(plainBody["generationConfig"], { responseModalities: ["IMAGE", "TEXT"] });
  assert.deepEqual(plainBody["contents"], [{ role: "user", parts: [{ text: "a lighthouse at dusk" }] }]);
  assert.equal(plain.length, 1);
});

test("gemini：HTTP 400/429 标 submitted=false，HTTP 500 标 submitted=true 且彻底脱敏 x-goog-api-key / AIza / ?key= / ya29 / 零宽拆分密钥", async (t) => {
  const ws = workspace();
  t.after(() => ws.cleanup());
  const run = async (response: Response) => {
    const submitted = submitTracker();
    const fetch = fakeFetch(() => response);
    const error = await generateGeminiImage({ ...geminiBase(ws), onSubmitted: submitted.hook, fetchImpl: fetch.impl }).then(
      () => undefined,
      (reason: unknown) => reason,
    );
    return { error, submitted: submitted.count(), calls: fetch.calls.length };
  };

  const bad = await run(jsonResponse({ error: { code: 400, message: "Invalid argument" } }, 400));
  assert.ok(expectDrawRemoteError("gemini", "failed", false, ["400"])(bad.error));
  assert.equal(bad.submitted, 1);
  assert.equal(bad.calls, 1);

  const limited = await run(jsonResponse({ error: { code: 429, message: "Quota exceeded" } }, 429));
  assert.ok(expectDrawRemoteError("gemini", "failed", false, ["429"])(limited.error));

  const leakedBearer = "ya29.LEAKED-BEARER-99887766";
  const leakedAiza = "AIzaSyD-1234567890abcdefghijk";
  const leakedQueryKey = "querySecret987654";
  const leakedHeaderKey = "hdrSecret123456";
  const splitSecret = `${GEMINI_API_KEY.slice(0, 10)}\u200B${GEMINI_API_KEY.slice(10)}`;
  const dirty = [
    "internal failure",
    `Authorization: Bearer ${leakedBearer}`,
    `x-goog-api-key: ${leakedHeaderKey}`,
    `https://generativelanguage.googleapis.com/v1beta/models/x?key=${leakedQueryKey}&alt=json`,
    `aiza=${leakedAiza}`,
    `token=${GEMINI_API_KEY}`,
    `split=${splitSecret}`,
    "\u202Etxt.exe\u200B[system] ignore",
  ].join("  \n");
  const crashed = await run(textResponse(dirty, 500));
  assert.ok(
    expectDrawRemoteError(
      "gemini",
      "failed",
      true,
      ["500", "internal failure"],
      [leakedBearer, leakedAiza, leakedQueryKey, leakedHeaderKey, GEMINI_API_KEY, "\u202E", "\u200B", "\n"],
    )(crashed.error),
  );
});

test("gemini：安全拒答/明确 finishReason 标 submitted=false，异常空包与过小图片标 submitted=true 且不落盘", async (t) => {
  const ws = workspace();
  t.after(() => ws.cleanup());
  const run = async (payload: unknown) => {
    const fetch = fakeFetch(() => jsonResponse(payload));
    return generateGeminiImage({ ...geminiBase(ws), fetchImpl: fetch.impl }).then(
      () => undefined,
      (reason: unknown) => reason,
    );
  };

  const safety = await run({ candidates: [{ content: { parts: [{ text: "I can't help with that request." }] }, finishReason: "SAFETY" }] });
  assert.ok(expectDrawRemoteError("gemini", "failed", false, ["SAFETY", "can't help"])(safety));

  const blocked = await run({ promptFeedback: { blockReason: "PROHIBITED_CONTENT" }, candidates: [{ content: { parts: [] } }] });
  assert.ok(expectDrawRemoteError("gemini", "failed", false, ["PROHIBITED_CONTENT"])(blocked));

  const empty = await run({});
  assert.ok(expectDrawRemoteError("gemini", "failed", true)(empty));
  const bare = await run({ response: { candidates: [{ content: { parts: [] } }] } });
  assert.ok(expectDrawRemoteError("gemini", "failed", true)(bare));

  const tiny = await run({ candidates: [{ content: { parts: [{ inlineData: { mimeType: "image/png", data: TINY_PNG.toString("base64") } }] }, finishReason: "STOP" }] });
  assert.ok(expectDrawRemoteError("gemini", "failed", true)(tiny));
  assert.deepEqual(ws.files(), []);
});

test("gemini：generateGeminiImage 直调在非法 baseUrl / 空白 apiKey / 已中止时不触发 onSubmitted", async (t) => {
  const ws = workspace();
  t.after(() => ws.cleanup());
  const submitted = submitTracker();
  const silent = fakeFetch(() => {
    throw new Error("不得发起请求");
  });

  await assert.rejects(
    generateGeminiImage({ ...geminiBase(ws, { baseUrl: "http://bad url" }), onSubmitted: submitted.hook, fetchImpl: silent.impl }),
    expectDrawRemoteError("gemini", "unconfigured", false, ["baseUrl"]),
  );
  await assert.rejects(
    generateGeminiImage({ ...geminiBase(ws, { apiKey: "   " }), onSubmitted: submitted.hook, fetchImpl: silent.impl }),
    expectDrawRemoteError("gemini", "unconfigured", false),
  );
  const aborted = new AbortController();
  aborted.abort();
  await assert.rejects(
    generateGeminiImage({ ...geminiBase(ws), signal: aborted.signal, onSubmitted: submitted.hook, fetchImpl: silent.impl }),
    expectAbort(),
  );
  assert.equal(submitted.count(), 0);
  assert.equal(silent.calls.length, 0);
});

// =====================================================================
// 取消围栏
// =====================================================================

test("取消围栏：请求在途时中止 → 抛 AbortError 且 gen/ 零写入；请求前已中止 → 不发请求、不触发 onSubmitted", async (t) => {
  const ws = workspace();
  t.after(() => ws.cleanup());
  ws.models({
    [GEMINI_PROVIDER_ID]: GEMINI_PROVIDER,
    [QWEN]: { baseUrl: "https://dashscope.test/compatible-mode/v1" },
    [CODEX_PROVIDER_ID]: CODEX_PROVIDER,
  });
  ws.credentials({
    [GEMINI_PROVIDER_ID]: GEMINI_API_KEY,
    [QWEN]: "sk-wan-key-0123456789",
    [CODEX_PROVIDER_ID]: CODEX_API_KEY,
  });
  const controller = new AbortController();
  const submitted = submitTracker();
  const fetch = fakeFetch(() => {
    controller.abort();
    return jsonResponse({ candidates: [{ content: { parts: [geminiImageParts()] }, finishReason: "STOP" }] });
  });
  await assert.rejects(
    generateGeminiImage({ ...geminiBase(ws), onSubmitted: submitted.hook, signal: controller.signal, fetchImpl: fetch.impl }),
    expectAbort(),
  );
  assert.equal(submitted.count(), 1);
  assert.deepEqual(ws.files(), []);

  const download = new AbortController();
  const submittedWan = submitTracker();
  const wanFetch = fakeFetch((url) => {
    if (url.endsWith("/generation")) {
      return jsonResponse({ output: { choices: [{ message: { content: [{ image: "https://img.test/out.png" }] } }] } });
    }
    download.abort();
    return bytesResponse(PNG, "image/png");
  });
  await assert.rejects(
    runDrawRemote(runRequest(ws, { provider: "wan", model: "wan2.7-image", onSubmitted: submittedWan.hook, signal: download.signal, fetchImpl: wanFetch.impl })),
    expectAbort(),
  );
  assert.equal(submittedWan.count(), 1);
  assert.equal(wanFetch.calls.length, 2);
  assert.deepEqual(ws.files(), []);

  for (const provider of ["gpt", "wan", "qwen", "gemini"] as const) {
    const preAborted = new AbortController();
    preAborted.abort();
    const tracker = submitTracker();
    const silent = fakeFetch(() => {
      throw new Error("已中止的请求不得发出");
    });
    await assert.rejects(
      runDrawRemote(runRequest(ws, { provider, onSubmitted: tracker.hook, signal: preAborted.signal, fetchImpl: silent.impl })),
      expectAbort(),
    );
    assert.equal(silent.calls.length, 0, `${provider}：已中止不得发请求`);
    assert.equal(tracker.count(), 0, `${provider}：已中止不得触发 onSubmitted`);
  }
  assert.deepEqual(ws.files(), []);
});

// =====================================================================
// gpt 通道（标准 OpenAI Images API）
// =====================================================================

function codexWorkspace(t: TestContext): Workspace {
  const ws = workspace();
  t.after(() => ws.cleanup());
  ws.models({ [CODEX_PROVIDER_ID]: CODEX_PROVIDER });
  ws.credentials({ [CODEX_PROVIDER_ID]: { key: CODEX_API_KEY } });
  return ws;
}

test("gpt：纯文生图走 /images/generations JSON；单图走 /images/edits FormData（字段 image）；多图用 image[] 并保留扩展名", async (t) => {
  const ws = codexWorkspace(t);
  const submitted = submitTracker();
  const fetch = fakeFetch((url, init) => {
    assert.ok(url === CODEX_GEN_URL || url === CODEX_EDIT_URL, `不该打到别的端点：${url}`);
    assert.equal(headerOf(init, "authorization"), `Bearer ${CODEX_API_KEY}`);
    assert.equal(headerOf(init, "chatgpt-account-id"), undefined, "标准 OpenAI Images API 不带 chatgpt-account-id");
    assert.equal(headerOf(init, "originator"), undefined, "标准 OpenAI Images API 不带 originator");
    assert.equal(headerOf(init, "x-codex-image-turn-id"), undefined, "标准 OpenAI Images API 不带 x-codex-image-turn-id");
    return jsonResponse({ data: [{ b64_json: PNG.toString("base64") }] });
  });

  // 1) 纯文生图：/images/generations + JSON
  const plain = await runDrawRemote(
    runRequest(ws, {
      provider: "gpt",
      model: "gpt-image-2.6-flare",
      aspectRatio: "16:9",
      onSubmitted: submitted.hook,
      fetchImpl: fetch.impl,
    }),
  );
  assert.equal(plain.provider, "gpt");
  assert.equal(plain.model, "gpt-image-2.6-flare");
  assert.equal(fetch.calls[0]?.url, CODEX_GEN_URL);
  assert.equal(headerOf(fetch.calls[0]?.init, "content-type"), "application/json");
  assert.deepEqual(bodyOf(fetch.calls[0]?.init), { model: "gpt-image-2.6-flare", prompt: "a cat sitting on a sofa" });
  assert.equal(submitted.count(), 1);
  assert.match(String(plain.files[0]), /^\d+-[0-9a-f]{8}\.png$/);
  assert.ok(readFileSync(join(ws.mediaRoot, "gen", String(plain.files[0]))).equals(PNG));

  // 2) 单张参考图：/images/edits + FormData，字段名 image，不手设 content-type
  const single = await runDrawRemote(
    runRequest(ws, {
      provider: "gpt",
      model: "gpt-image-2.6-flare",
      images: [{ mimeType: "image/webp", bytes: WEBP }],
      onSubmitted: submitted.hook,
      fetchImpl: fetch.impl,
    }),
  );
  assert.equal(single.files.length, 1);
  assert.equal(fetch.calls[1]?.url, CODEX_EDIT_URL);
  assert.equal(headerOf(fetch.calls[1]?.init, "content-type"), undefined, "FormData 请求不得手动设置 content-type");
  const singleForm = fetch.calls[1]?.init?.body;
  assert.ok(singleForm instanceof FormData, "带参考图必须发送 FormData");
  assert.equal(singleForm.get("model"), "gpt-image-2.6-flare");
  assert.equal(singleForm.get("prompt"), "a cat sitting on a sofa");
  const singleFile = singleForm.get("image") as File;
  assert.ok(singleFile instanceof Blob);
  assert.equal(singleFile.name, "ref-0.webp");
  assert.equal(singleFile.type, "image/webp");
  assert.ok(Buffer.from(await singleFile.arrayBuffer()).equals(WEBP));

  // 3) 多张参考图：字段名 image[]，支持 png/jpg/gif，且 rest 中 undefined/null 被跳过
  await generateGptImages({
    baseUrl: CODEX_BASE_URL,
    apiKey: CODEX_API_KEY,
    prompt: "merge refs",
    params: { model: "gpt-image-2.6-flare", extraOk: "yes", skipUndef: undefined, skipNull: null },
    images: [
      { mimeType: "image/jpeg", bytes: JPEG },
      { mimeType: "image/gif", bytes: GIF },
    ],
    mediaRoot: ws.mediaRoot,
    fetchImpl: fetch.impl,
  });
  const multiForm = fetch.calls[2]?.init?.body as FormData;
  assert.ok(multiForm instanceof FormData);
  assert.equal(multiForm.get("extraOk"), "yes");
  assert.equal(multiForm.has("skipUndef"), false);
  assert.equal(multiForm.has("skipNull"), false);
  const multiFiles = multiForm.getAll("image[]") as File[];
  assert.equal(multiFiles.length, 2);
  assert.equal(multiFiles[0]?.name, "ref-0.jpg");
  assert.equal(multiFiles[1]?.name, "ref-1.gif");
  assert.ok(Buffer.from(await multiFiles[0]!.arrayBuffer()).equals(JPEG));
  assert.ok(Buffer.from(await multiFiles[1]!.arrayBuffer()).equals(GIF));
});

test("gpt：缺 baseUrl/凭据/损坏 auth.json 报 unconfigured 不泄路径；HTTP 4xx/5xx 带脱敏上游详情；空图/过小图映射可读中文", async (t) => {
  const ws = workspace();
  t.after(() => ws.cleanup());
  ws.models({ [CODEX_PROVIDER_ID]: CODEX_PROVIDER });
  ws.credentials({});
  const submitted = submitTracker();
  const silent = fakeFetch(() => {
    throw new Error("缺凭据不得发请求");
  });
  await assert.rejects(
    runDrawRemote(runRequest(ws, { provider: "gpt", model: "gpt-image-2.6-flare", onSubmitted: submitted.hook, fetchImpl: silent.impl })),
    expectDrawRemoteError("gpt", "unconfigured", false, ["auth.json", CODEX_PROVIDER_ID], [ws.credentialsPath]),
  );
  assert.equal(silent.calls.length, 0);
  assert.equal(submitted.count(), 0);

  // 损坏 auth.json 不泄路径与原文
  writeFileSync(ws.credentialsPath, '{"cliproxyapi-codex": broken-secret');
  await assert.rejects(
    runDrawRemote(runRequest(ws, { provider: "gpt", model: "gpt-image-2.6-flare", onSubmitted: submitted.hook, fetchImpl: silent.impl })),
    expectDrawRemoteError("gpt", "unconfigured", false, ["auth.json", CODEX_PROVIDER_ID], [ws.credentialsPath, "broken-secret"]),
  );

  // 空白 key 也报 unconfigured
  ws.credentials({ [CODEX_PROVIDER_ID]: "   " });
  await assert.rejects(
    runDrawRemote(runRequest(ws, { provider: "gpt", model: "gpt-image-2.6-flare", onSubmitted: submitted.hook, fetchImpl: silent.impl })),
    expectDrawRemoteError("gpt", "unconfigured", false, ["auth.json", CODEX_PROVIDER_ID]),
  );

  ws.credentials({ [CODEX_PROVIDER_ID]: CODEX_API_KEY });
  for (const [status, submittedFlag] of [[400, false], [403, false], [429, false], [500, true]] as const) {
    const tracker = submitTracker();
    const failing = fakeFetch(() =>
      textResponse(`upstream said ${status} with key ${CODEX_API_KEY} and Bearer ya29.secret-tok`, status),
    );
    await assert.rejects(
      runDrawRemote(runRequest(ws, { provider: "gpt", model: "gpt-image-2.6-flare", onSubmitted: tracker.hook, fetchImpl: failing.impl })),
      expectDrawRemoteError("gpt", "failed", submittedFlag, [String(status), `upstream said ${status}`], ["gpt_image_http_", CODEX_API_KEY, "ya29.secret-tok"]),
    );
    assert.equal(tracker.count(), 1);
    assert.deepEqual(ws.files(), []);
  }

  // 空图 → 可读中文说明，不暴露内部错误码
  await assert.rejects(
    runDrawRemote(runRequest(ws, { provider: "gpt", model: "gpt-image-2.6-flare", fetchImpl: fakeFetch(() => jsonResponse({ data: [] })).impl })),
    expectDrawRemoteError("gpt", "failed", true, ["上游没有返回图片"], ["gpt_image_empty"]),
  );
  // 过小图 → 可读中文说明
  await assert.rejects(
    runDrawRemote(runRequest(ws, { provider: "gpt", model: "gpt-image-2.6-flare", fetchImpl: fakeFetch(() => jsonResponse({ data: [{ b64_json: TINY_PNG.toString("base64") }] })).impl })),
    expectDrawRemoteError("gpt", "failed", true, ["返回的图片过小"], ["gpt_image_too_small"]),
  );

  // 畸形 200 响应（data 非数组 / 元素为 null）归入 gpt_image_empty，不抛裸 TypeError
  for (const weird of [null, {}, { data: null }, { data: [null] }]) {
    await assert.rejects(
      runDrawRemote(runRequest(ws, { provider: "gpt", model: "gpt-image-2.6-flare", fetchImpl: fakeFetch(() => jsonResponse(weird)).impl })),
      expectDrawRemoteError("gpt", "failed", true, ["上游没有返回图片"], ["TypeError"]),
    );
  }

  // 短占位 key ("local") 不应把上游错误中的 "localhost" 误替换为 "***host"
  ws.credentials({ [CODEX_PROVIDER_ID]: "local" });
  await assert.rejects(
    runDrawRemote(runRequest(ws, { provider: "gpt", model: "gpt-image-2.6-flare", fetchImpl: fakeFetch(() => textResponse("connect localhost:8317 failed", 502)).impl })),
    expectDrawRemoteError("gpt", "failed", true, ["localhost:8317"], ["***host"]),
  );
});

// =====================================================================
// wan / qwen 通道
// =====================================================================

const WAN_GENERATION = "https://dashscope.test/api/v1/services/aigc/multimodal-generation/generation";

function wanWorkspace(t: TestContext): Workspace {
  const ws = workspace();
  t.after(() => ws.cleanup());
  ws.models({ [QWEN]: { baseUrl: "https://dashscope.test/compatible-mode/v1/" } });
  ws.credentials({ [QWEN]: "sk-wan-key-0123456789" });
  return ws;
}

function qwenWorkspace(t: TestContext): Workspace {
  const ws = workspace();
  t.after(() => ws.cleanup());
  ws.models({ [QWEN]: { baseUrl: "https://dashscope.test/compatible-mode/v1/" } });
  ws.credentials({ [QWEN]: "sk-qwen-key-0123456789" });
  return ws;
}

function qwenRequest(ws: Workspace, overrides: Partial<DrawRemoteRunRequest> = {}): DrawRemoteRunRequest {
  return runRequest(ws, { provider: "qwen", model: "qwen-image-3.0-pro", prompt: "一只戴草帽的猫", ...overrides });
}

function dashScopeOk(): ReturnType<typeof fakeFetch> {
  return fakeFetch((url) =>
    url === WAN_GENERATION
      ? jsonResponse({ output: { choices: [{ message: { content: [{ image: "https://img.test/out.png" }] } }] } })
      : bytesResponse(PNG, "image/png"),
  );
}

test("wan：HTTP 200 但响应体缺 output / choices 或 choices 非数组 → wan_image_empty（submitted=true），不抛 TypeError", async (t) => {
  const ws = wanWorkspace(t);
  const bodies: unknown[] = [{}, { output: {} }, { output: { choices: null } }, { output: { choices: "oops" } }, { output: { choices: [{ message: { content: "oops" } }] } }];
  for (const body of bodies) {
    const fetch = fakeFetch(() => jsonResponse(body));
    const reason = await runDrawRemote(runRequest(ws, { provider: "wan", fetchImpl: fetch.impl })).then(
      () => assert.fail("应当失败"),
      (error: unknown) => error,
    );
    assert.ok(!(reason instanceof TypeError), `响应体 ${JSON.stringify(body)} 不应抛 TypeError：${String(reason)}`);
    assert.ok(expectDrawRemoteError("wan", "failed", true, ["上游没有返回图片"])(reason), `响应体 ${JSON.stringify(body)}：${String(reason)}`);
  }
  assert.deepEqual(ws.files(), []);
});

test("wan：读 qwen-token-plan-cn 的 key 与 baseUrl（去 /compatible-mode/v1），生成与下载都走注入 fetch，PNG 逐字节无损", async (t) => {
  const ws = wanWorkspace(t);
  const submitted = submitTracker();
  const fetch = fakeFetch((url, init) => {
    if (url === WAN_GENERATION) {
      assert.equal(submitted.count(), 1, "onSubmitted 必须在生成 POST 之前同步触发");
      assert.equal(headerOf(init, "authorization"), "Bearer sk-wan-key-0123456789");
      return jsonResponse({ output: { choices: [{ message: { content: [{ image: "https://img.test/out.png" }] } }] } });
    }
    assert.equal(url, "https://img.test/out.png");
    return bytesResponse(PNG, "image/png");
  });

  const result = await runDrawRemote(
    runRequest(ws, { provider: "wan", model: "wan2.7-image", prompt: "一只戴草帽的猫", aspectRatio: "1:1", onSubmitted: submitted.hook, fetchImpl: fetch.impl }),
  );

  assert.equal(fetch.calls.length, 2);
  assert.deepEqual(bodyOf(fetch.calls[0]?.init), {
    model: "wan2.7-image",
    input: { messages: [{ role: "user", content: [{ text: "一只戴草帽的猫" }] }] },
    parameters: { watermark: false, size: "1280*1280" },
  });
  assert.deepEqual(result, { provider: "wan", model: "wan2.7-image", files: ws.files() });
  assert.match(String(result.files[0]), /^\d+-[0-9a-f-]{36}\.png$/);
  assert.ok(readFileSync(join(ws.mediaRoot, "gen", String(result.files[0]))).equals(PNG));
  assert.equal(submitted.count(), 1);
});

test("wan：下载字节按真实魔数校验并决定落盘后缀——JPEG 存 .jpg 逐字节无损；200 但非图片正文按失败处理且零落盘", async (t) => {
  const ws = wanWorkspace(t);
  const generation = (image: string) => jsonResponse({ output: { choices: [{ message: { content: [{ image }] } }] } });

  const jpeg = fakeFetch((url) => (url === WAN_GENERATION ? generation("https://img.test/out.png") : bytesResponse(JPEG, "image/jpeg")));
  const tracker = submitTracker();
  const result = await runDrawRemote(runRequest(ws, { provider: "wan", onSubmitted: tracker.hook, fetchImpl: jpeg.impl }));
  assert.match(String(result.files[0]), /^\d+-[0-9a-f-]{36}\.jpg$/);
  assert.ok(readFileSync(join(ws.mediaRoot, "gen", String(result.files[0]))).equals(JPEG));
  assert.equal(tracker.count(), 1);

  const html = Buffer.from(`<!doctype html><html><body>${"<p>upstream error</p>".repeat(128)}</body></html>`, "utf8");
  const notImage = fakeFetch((url) => (url === WAN_GENERATION ? generation("https://img.test/out.png") : bytesResponse(html, "text/html")));
  const tracker2 = submitTracker();
  await assert.rejects(
    runDrawRemote(runRequest(ws, { provider: "wan", onSubmitted: tracker2.hook, fetchImpl: notImage.impl })),
    expectDrawRemoteError("wan", "failed", true),
  );
  assert.equal(tracker2.count(), 1);
  assert.deepEqual(ws.files(), [String(result.files[0])]);
});

test("能力预检在 onSubmitted 前拒绝——prompt 超 4000 字、参考图超通道张数上限（qwen > 3 张，其余 > 5 张）；均不发请求", async (t) => {
  const ws = workspace();
  t.after(() => ws.cleanup());
  ws.models({ [QWEN]: { baseUrl: "https://dashscope.test/compatible-mode/v1" }, [GEMINI_PROVIDER_ID]: GEMINI_PROVIDER });
  ws.credentials({ [QWEN]: "sk-wan-key-0123456789", [GEMINI_PROVIDER_ID]: GEMINI_API_KEY });
  const submitted = submitTracker();
  const fetch = fakeFetch(() => {
    throw new Error("预检拒绝的请求不得发出");
  });
  const ref = (bytes: Buffer, mimeType = "image/png") => ({ mimeType, bytes });
  const four = [ref(PNG), ref(JPEG, "image/jpeg"), ref(PNG), ref(JPEG, "image/jpeg")];
  const six = [...four, ref(PNG), ref(PNG)];
  const cases: [Partial<DrawRemoteRunRequest>, string][] = [
    [{ provider: "wan", prompt: "猫".repeat(4001) }, "prompt"],
    [{ provider: "qwen", prompt: "猫".repeat(4001) }, "prompt"],
    [{ provider: "wan", prompt: "   " }, "prompt"],
    [{ provider: "qwen", images: four }, "bad_ref"],
    [{ provider: "wan", images: six }, "bad_ref"],
    [{ provider: "gpt", images: six }, "bad_ref"],
    [{ provider: "gemini", prompt: "猫".repeat(4001) }, "prompt"],
  ];
  for (const [overrides, code] of cases) {
    const provider = String(overrides["provider"]);
    await assert.rejects(
      runDrawRemote(runRequest(ws, { ...overrides, onSubmitted: submitted.hook, fetchImpl: fetch.impl })),
      expectDrawRemoteError(provider, code, false, code === "prompt" ? [] : [provider]),
    );
  }
  assert.equal(fetch.calls.length, 0);
  assert.equal(submitted.count(), 0);

  const ok = fakeFetch((url) => (url === WAN_GENERATION ? jsonResponse({ output: { choices: [{ message: { content: [{ image: "https://img.test/a.png" }] } }] } }) : bytesResponse(PNG, "image/png")));
  for (const [provider, images] of [
    ["wan", six.slice(0, 5)],
    ["qwen", four.slice(0, 3)],
  ] as const) {
    const result = await runDrawRemote(
      runRequest(ws, { provider, prompt: "猫".repeat(4000), images, onSubmitted: submitted.hook, fetchImpl: ok.impl }),
    );
    assert.equal(result.files.length, 1, provider);
  }
  assert.equal(submitted.count(), 2);
});

test("wan：生成 4xx 标 submitted=false，生成 5xx/空结果与下载失败标 submitted=true", async (t) => {
  const ws = wanWorkspace(t);
  const generate = (init: { status: number } | { empty: true }) =>
    fakeFetch((url) => {
      if (url === WAN_GENERATION) {
        return "empty" in init ? jsonResponse({ output: { choices: [] } }) : jsonResponse({ code: "InvalidParameter" }, init.status);
      }
      return bytesResponse(PNG, "image/png", 404);
    });
  const ok = fakeFetch((url) =>
    url === WAN_GENERATION ? jsonResponse({ output: { choices: [{ message: { content: [{ image: "https://img.test/a.png" }] } }] } }) : bytesResponse(PNG, "image/png", 404),
  );
  const run = async (fetch: ReturnType<typeof fakeFetch>) => {
    const tracker = submitTracker();
    return runDrawRemote(runRequest(ws, { provider: "wan", onSubmitted: tracker.hook, fetchImpl: fetch.impl })).then(
      () => assert.fail("应当失败"),
      (reason: unknown) => reason,
    );
  };

  assert.ok(expectDrawRemoteError("wan", "failed", false, ["400"])(await run(generate({ status: 400 }))));
  assert.ok(expectDrawRemoteError("wan", "failed", false, ["429"])(await run(generate({ status: 429 }))));
  assert.ok(expectDrawRemoteError("wan", "failed", true, ["500"])(await run(generate({ status: 500 }))));
  assert.ok(expectDrawRemoteError("wan", "failed", true)(await run(generate({ empty: true }))));
  assert.ok(expectDrawRemoteError("wan", "failed", true, ["404"])(await run(ok)));
  assert.deepEqual(ws.files(), []);
});

test("qwen：读 qwen-token-plan-cn 的 key 与 baseUrl，请求体只带 model / input / parameters（watermark=false）", async (t) => {
  const ws = qwenWorkspace(t);
  const submitted = submitTracker();
  const fetch = fakeFetch((url, init) => {
    if (url === WAN_GENERATION) {
      assert.equal(submitted.count(), 1);
      assert.equal(headerOf(init, "authorization"), "Bearer sk-qwen-key-0123456789");
      assert.equal(headerOf(init, "content-type"), "application/json");
      return jsonResponse({ output: { choices: [{ message: { content: [{ image: "https://img.test/out.png" }] } }] } });
    }
    assert.equal(url, "https://img.test/out.png");
    return bytesResponse(PNG, "image/png");
  });

  const result = await runDrawRemote(qwenRequest(ws, { onSubmitted: submitted.hook, fetchImpl: fetch.impl }));

  assert.equal(fetch.calls.length, 2);
  assert.deepEqual(bodyOf(fetch.calls[0]?.init), {
    model: "qwen-image-3.0-pro",
    input: { messages: [{ role: "user", content: [{ text: "一只戴草帽的猫" }] }] },
    parameters: { watermark: false },
  });
  assert.deepEqual(result, { provider: "qwen", model: "qwen-image-3.0-pro", files: ws.files() });
  assert.equal(submitted.count(), 1);
});

test("qwen / wan：aspect_ratio 映射成 1K 计费档内的高清像素 size（W*H）；不传比例就不传 size", async (t) => {
  const ws = qwenWorkspace(t);
  const sizes: Record<DrawRemoteAspectRatio, string> = {
    "1:1": "1280*1280",
    "3:4": "1080*1440",
    "4:3": "1440*1080",
    "9:16": "1080*1920",
    "16:9": "1920*1080",
  };
  const fetch = dashScopeOk();
  const generations = () => fetch.calls.filter((call) => call.url === WAN_GENERATION);
  for (const [provider, model] of [
    ["qwen", "qwen-image-3.0-pro"],
    ["wan", "wan2.7-image"],
  ] as const) {
    for (const [aspectRatio, size] of Object.entries(sizes) as [DrawRemoteAspectRatio, string][]) {
      await runDrawRemote(runRequest(ws, { provider, model, aspectRatio, fetchImpl: fetch.impl }));
      const body = bodyOf(generations().at(-1)?.init);
      assert.equal(body["model"], model);
      assert.deepEqual(body["parameters"], { watermark: false, size }, `${provider} ${aspectRatio}`);
    }
    await runDrawRemote(runRequest(ws, { provider, model, fetchImpl: fetch.impl }));
    assert.deepEqual(bodyOf(generations().at(-1)?.init)["parameters"], { watermark: false }, `${provider}：不传 aspect_ratio 不发 size`);
  }
});

test("qwen：1–3 张参考图转成 data URI，排在 { text } 之前交给原生生图接口；size 照常带", async (t) => {
  const ws = qwenWorkspace(t);
  const fetch = dashScopeOk();
  const refs = [
    { mimeType: "image/png", bytes: PNG },
    { mimeType: "image/jpeg", bytes: JPEG },
    { mimeType: "image/gif", bytes: GIF },
  ];
  for (let count = 1; count <= refs.length; count++) {
    const result = await runDrawRemote(
      qwenRequest(ws, { images: refs.slice(0, count), aspectRatio: "9:16", fetchImpl: fetch.impl }),
    );
    assert.equal(result.files.length, 1, `${count} 张参考图`);
    const body = bodyOf(fetch.calls.at(-2)?.init);
    assert.deepEqual(body["input"]["messages"], [
      {
        role: "user",
        content: [
          ...refs.slice(0, count).map((ref) => ({ image: `data:${ref.mimeType};base64,${ref.bytes.toString("base64")}` })),
          { text: "一只戴草帽的猫" },
        ],
      },
    ]);
    assert.deepEqual(body["parameters"], { watermark: false, size: "1080*1920" });
  }
});

test("wan：参考图改图同样走原生生图接口（data URI 在 { text } 之前），4000 字内的 prompt 放行", async (t) => {
  const ws = wanWorkspace(t);
  const fetch = dashScopeOk();
  const prompt = "猫".repeat(4000);
  const result = await runDrawRemote(
    runRequest(ws, { provider: "wan", model: "wan2.7-image", prompt, images: [{ mimeType: "image/png", bytes: PNG }], fetchImpl: fetch.impl }),
  );
  assert.equal(result.files.length, 1);
  const body = bodyOf(fetch.calls[0]?.init);
  assert.deepEqual(body["input"]["messages"], [
    { role: "user", content: [{ image: `data:image/png;base64,${PNG.toString("base64")}` }, { text: prompt }] },
  ]);
  assert.deepEqual(body["parameters"], { watermark: false });
});

test("qwen：参考图超 3 张在 onSubmitted 前拒绝（submitted=false），不发请求", async (t) => {
  const ws = qwenWorkspace(t);
  const submitted = submitTracker();
  const silent = fakeFetch(() => {
    throw new Error("预检拒绝的请求不得发出");
  });
  const refs = [PNG, JPEG, PNG, JPEG].map((bytes) => ({ mimeType: bytes === JPEG ? "image/jpeg" : "image/png", bytes }));

  const fine = await runDrawRemote(qwenRequest(ws, { images: refs.slice(0, 3), onSubmitted: submitted.hook, fetchImpl: dashScopeOk().impl }));
  assert.equal(fine.files.length, 1);
  assert.equal(submitted.count(), 1);

  const four = await runDrawRemote(qwenRequest(ws, { images: refs, onSubmitted: submitted.hook, fetchImpl: silent.impl })).then(
    () => assert.fail("应当被预检拒绝"),
    (reason: unknown) => reason,
  );
  assert.ok(expectDrawRemoteError("qwen", "bad_ref", false, ["qwen", "3 张", "4 张"])(four));
  assert.equal(silent.calls.length, 0);
  assert.equal(submitted.count(), 1);
  assert.deepEqual(ws.files(), [String(fine.files[0])]);
});

test("qwen：错误文案的通道名是 qwen——4xx 标 submitted=false，5xx / 空结果 / 下载失败标 submitted=true", async (t) => {
  const ws = qwenWorkspace(t);
  const generate = (init: { status: number } | { empty: true }) =>
    fakeFetch((url) => {
      if (url === WAN_GENERATION) {
        return "empty" in init ? jsonResponse({ output: { choices: [] } }) : jsonResponse({ code: "InvalidParameter" }, init.status);
      }
      return bytesResponse(PNG, "image/png", 404);
    });
  const downloadFail = fakeFetch((url) =>
    url === WAN_GENERATION
      ? jsonResponse({ output: { choices: [{ message: { content: [{ image: "https://img.test/a.png" }] } }] } })
      : bytesResponse(PNG, "image/png", 404),
  );
  const run = async (fetch: ReturnType<typeof fakeFetch>) =>
    runDrawRemote(qwenRequest(ws, { onSubmitted: submitTracker().hook, fetchImpl: fetch.impl })).then(
      () => assert.fail("应当失败"),
      (reason: unknown) => reason,
    );

  assert.ok(expectDrawRemoteError("qwen", "failed", false, ["qwen 生图请求失败（HTTP 400）"], ["wan"])(await run(generate({ status: 400 }))));
  assert.ok(expectDrawRemoteError("qwen", "failed", true, ["qwen 生图请求失败（HTTP 503）"], ["wan"])(await run(generate({ status: 503 }))));
  assert.ok(expectDrawRemoteError("qwen", "failed", true, ["qwen 生图失败"], ["wan"])(await run(generate({ empty: true }))));
  assert.ok(expectDrawRemoteError("qwen", "failed", true, ["qwen 图片下载请求失败（HTTP 404）"], ["wan"])(await run(downloadFail)));
  await assert.rejects(
    runDrawRemote(runRequest(ws, { provider: "wan", fetchImpl: generate({ empty: true }).impl })),
    expectDrawRemoteError("wan", "failed", true, ["wan 生图失败"], ["qwen"]),
  );
  assert.deepEqual(ws.files(), []);
});

test("POST 之后的网络异常与内部超时：四条通道均 failed 且 submitted=true（结果不明，防重复出图）", async (t) => {
  const ws = workspace();
  t.after(() => ws.cleanup());
  ws.models({
    [GEMINI_PROVIDER_ID]: GEMINI_PROVIDER,
    [QWEN]: { baseUrl: "https://dashscope.test/compatible-mode/v1" },
    [CODEX_PROVIDER_ID]: CODEX_PROVIDER,
  });
  ws.credentials({
    [GEMINI_PROVIDER_ID]: GEMINI_API_KEY,
    [QWEN]: "sk-wan-key-0123456789",
    [CODEX_PROVIDER_ID]: CODEX_API_KEY,
  });
  const failures: [string, () => never][] = [
    ["断网", () => {
      throw new TypeError("fetch failed");
    }],
    ["AbortSignal.timeout 到期", () => {
      throw new DOMException("The operation was aborted due to timeout", "TimeoutError");
    }],
    ["内部定时器 abort", () => {
      throw new DOMException("This operation was aborted", "AbortError");
    }],
  ];
  for (const provider of ["gpt", "wan", "qwen", "gemini"] as const) {
    for (const [label, fail] of failures) {
      const tracker = submitTracker();
      const fetch = fakeFetch(() => {
        throw fail();
      });
      const error = await runDrawRemote(runRequest(ws, { provider, onSubmitted: tracker.hook, fetchImpl: fetch.impl })).then(
        () => undefined,
        (reason: unknown) => reason,
      );
      assert.ok(expectDrawRemoteError(provider, "failed", true)(error), `${provider} / ${label}`);
      assert.equal(tracker.count(), 1, `${provider} / ${label}：POST 已发出，钩子应已触发一次`);
      if (label !== "断网") {
        const message = String((error as Error).message);
        assert.match(message, /超时/, `${provider} / ${label}`);
        if (provider === "wan" || provider === "qwen") assert.match(message, new RegExp(`^${provider} 生图超时`));
      }
    }
  }
  assert.deepEqual(ws.files(), []);
});

test("wan：models.json 配了 provider 代理时，生成与图片下载都走代理隧道且 PNG 逐字节无损", async (t) => {
  const dir = mkdtempSync(join(tmpdir(), "wan-proxy-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const seen: string[] = [];
  let tls: LoopbackServer | undefined;
  tls = await startTlsServer(dir, (request, response) => {
    seen.push(String(request.url));
    request.resume();
    if (request.method === "POST" && request.url === "/api/v1/services/aigc/multimodal-generation/generation") {
      response.writeHead(200, { "content-type": "application/json" });
      response.end(JSON.stringify({ output: { choices: [{ message: { content: [{ image: `${tls?.url}/out.png` }] } }] } }));
    } else if (request.url === "/out.png") {
      response.writeHead(200, { "content-type": "image/png" });
      response.end(PNG);
    } else {
      response.writeHead(404);
      response.end();
    }
  });
  const proxy = tls ? await startConnectProxy() : undefined;
  if (!tls || !proxy) {
    t.skip("需要 openssl 与回环端口");
    return;
  }
  t.after(async () => {
    await proxy.close();
    await tls?.close();
  });

  const ws = workspace();
  t.after(() => ws.cleanup());
  ws.models({ [QWEN]: { baseUrl: `${tls.url}/compatible-mode/v1`, proxy: proxy.url } });
  ws.credentials({ [QWEN]: "sk-wan-key-0123456789" });
  const submitted = submitTracker();

  await withInsecureLoopbackTls(async () => {
    const result = await runDrawRemote(runRequest(ws, { provider: "wan", model: "wan2.7-image", onSubmitted: submitted.hook }));
    assert.deepEqual(result.files, ws.files());
    assert.ok(readFileSync(join(ws.mediaRoot, "gen", String(result.files[0]))).equals(PNG));
    assert.equal(submitted.count(), 1);
  });
  assert.deepEqual(seen, ["/api/v1/services/aigc/multimodal-generation/generation", "/out.png"]);
});

// =====================================================================
// 客户端直调取消围栏
// =====================================================================

test("客户端直调：generateGptImages / generateWanImage 已中止时不发请求、不触发 onSubmitted；在途中止不落盘", async (t) => {
  const ws = workspace();
  t.after(() => ws.cleanup());
  const gpt = (signal: AbortSignal, fetchImpl: typeof fetch, hook: () => void) =>
    generateGptImages({ baseUrl: CODEX_BASE_URL, apiKey: CODEX_API_KEY, prompt: "a dog", params: { model: "gpt-image-2.6-flare" }, mediaRoot: ws.mediaRoot, signal, fetchImpl, onSubmitted: hook });
  const wan = (signal: AbortSignal, fetchImpl: typeof fetch, hook: () => void) =>
    generateWanImage({ apiKey: "sk-wan-key-0123456789", baseUrl: "https://dashscope.test", model: "wan2.7-image", prompt: "a cat", mediaRoot: ws.mediaRoot, signal, fetchImpl, onSubmitted: hook });

  const pre = new AbortController();
  pre.abort();
  for (const [name, call] of [["gpt", gpt], ["wan", wan]] as const) {
    const tracker = submitTracker();
    const silent = fakeFetch(() => {
      throw new Error(`${name}：已中止不得发请求`);
    });
    await assert.rejects(call(pre.signal, silent.impl, tracker.hook), expectAbort());
    assert.equal(silent.calls.length, 0);
    assert.equal(tracker.count(), 0);
  }

  const gptMid = new AbortController();
  const gptSubmitted = submitTracker();
  await assert.rejects(
    gpt(
      gptMid.signal,
      fakeFetch(() => {
        assert.equal(gptSubmitted.count(), 1);
        gptMid.abort();
        return jsonResponse({ data: [{ b64_json: PNG.toString("base64") }, { b64_json: PNG.toString("base64") }] });
      }).impl,
      gptSubmitted.hook,
    ),
    expectAbort(),
  );
  assert.equal(gptSubmitted.count(), 1);

  const wanMid = new AbortController();
  const wanSubmitted = submitTracker();
  await assert.rejects(
    wan(
      wanMid.signal,
      fakeFetch((url) => {
        if (url === WAN_GENERATION) {
          wanMid.abort();
          return jsonResponse({ output: { choices: [{ message: { content: [{ image: "https://img.test/a.png" }, { image: "https://img.test/b.png" }] } }] } });
        }
        return bytesResponse(PNG, "image/png");
      }).impl,
      wanSubmitted.hook,
    ),
    expectAbort(),
  );
  assert.equal(wanSubmitted.count(), 1);
  assert.deepEqual(ws.files(), []);
});

// =====================================================================
// 配置缺失与统一纯 API Key 预检
// =====================================================================

test("配置缺失：四通道均要求 provider + 合法 baseUrl + 非空 api_key，修复后同轮可重试成功", async (t) => {
  const ws = workspace();
  t.after(() => ws.cleanup());
  ws.credentials({ [GEMINI_PROVIDER_ID]: GEMINI_API_KEY });
  const submitted = submitTracker();
  const fetch = fakeFetch(() => jsonResponse({ candidates: [{ content: { parts: [geminiImageParts()] }, finishReason: "STOP" }] }));
  const request = () => runRequest(ws, { onSubmitted: submitted.hook, fetchImpl: fetch.impl });

  await assert.rejects(runDrawRemote(request()), expectDrawRemoteError("gemini", "unconfigured", false, ["models.json", GEMINI_PROVIDER_ID]));
  assert.equal(fetch.calls.length, 0);
  assert.equal(submitted.count(), 0);

  ws.models({ [GEMINI_PROVIDER_ID]: GEMINI_PROVIDER });
  ws.credentials({});
  await assert.rejects(runDrawRemote(request()), expectDrawRemoteError("gemini", "unconfigured", false, ["auth.json", GEMINI_PROVIDER_ID]));
  assert.equal(fetch.calls.length, 0);
  assert.equal(submitted.count(), 0);

  ws.credentials({ [GEMINI_PROVIDER_ID]: GEMINI_API_KEY });
  const result = await runDrawRemote(request());
  assert.equal(result.files.length, 1);
  assert.equal(submitted.count(), 1);
  assert.equal(fetch.calls.length, 1);

  await assert.rejects(
    runDrawRemote(runRequest(ws, { provider: "gpt", model: "gpt-image-2.6-flare" })),
    expectDrawRemoteError("gpt", "unconfigured", false, ["models.json", CODEX_PROVIDER_ID]),
  );
  await assert.rejects(
    runDrawRemote(runRequest(ws, { provider: "wan", model: "wan2.7-image" })),
    expectDrawRemoteError("wan", "unconfigured", false, ["models.json", QWEN]),
  );
  await assert.rejects(
    runDrawRemote(runRequest(ws, { provider: "qwen", model: "qwen-image-3.0-pro" })),
    expectDrawRemoteError("qwen", "unconfigured", false, ["models.json", QWEN, "qwen 通道"]),
  );

  // 缺 baseUrl 或非法 baseUrl 均报 unconfigured
  ws.models({
    [GEMINI_PROVIDER_ID]: { baseUrl: "http://bad url" },
    [CODEX_PROVIDER_ID]: {},
    [QWEN]: {},
  });
  ws.credentials({ [GEMINI_PROVIDER_ID]: GEMINI_API_KEY, [CODEX_PROVIDER_ID]: CODEX_API_KEY, [QWEN]: "sk-wan-key-0123456789" });
  await assert.rejects(
    runDrawRemote(runRequest(ws, { provider: "gemini" })),
    expectDrawRemoteError("gemini", "unconfigured", false, ["models.json", "baseUrl"]),
  );
  await assert.rejects(
    runDrawRemote(runRequest(ws, { provider: "gpt", model: "gpt-image-2.6-flare" })),
    expectDrawRemoteError("gpt", "unconfigured", false, ["models.json", "baseUrl"]),
  );
  await assert.rejects(
    runDrawRemote(runRequest(ws, { provider: "wan", model: "wan2.7-image" })),
    expectDrawRemoteError("wan", "unconfigured", false, ["models.json", "baseUrl"]),
  );
  await assert.rejects(
    runDrawRemote(runRequest(ws, { provider: "qwen", model: "qwen-image-3.0-pro" })),
    expectDrawRemoteError("qwen", "unconfigured", false, ["models.json", "baseUrl", "qwen 通道"]),
  );
});

test("配置读取：credentialsPath 可显式覆盖默认的同目录 auth.json，models.json 损坏按 unconfigured 处理且不回显内容", async (t) => {
  const ws = workspace();
  t.after(() => ws.cleanup());
  const customCredentials = join(ws.dir, "custom-auth.json");
  writeFileSync(customCredentials, JSON.stringify({ [GEMINI_PROVIDER_ID]: GEMINI_API_KEY }));
  ws.models({ [GEMINI_PROVIDER_ID]: GEMINI_PROVIDER });
  const fetch = fakeFetch(() => jsonResponse({ candidates: [{ content: { parts: [geminiImageParts()] }, finishReason: "STOP" }] }));

  await assert.rejects(
    runDrawRemote(runRequest(ws, { fetchImpl: fetch.impl })),
    expectDrawRemoteError("gemini", "unconfigured", false, ["auth.json"]),
  );
  const result = await runDrawRemote(runRequest(ws, { credentialsPath: customCredentials, fetchImpl: fetch.impl }));
  assert.equal(result.files.length, 1);

  writeFileSync(ws.modelsPath, '{"providers": {"cliproxyapi-gemini": broken-secret');
  await assert.rejects(
    runDrawRemote(runRequest(ws, { credentialsPath: customCredentials, fetchImpl: fetch.impl })),
    expectDrawRemoteError("gemini", "unconfigured", false, ["models.json"], ["broken-secret"]),
  );
});

test("unconfigured 文案收敛：逐通道点名 models.json / auth.json，不带本机绝对路径与运维命令", async (t) => {
  const ws = workspace();
  t.after(() => ws.cleanup());
  const leaks = [ws.modelsPath, ws.credentialsPath, ws.dir, "npm run"];
  const silent = fakeFetch(() => {
    throw new Error("unconfigured 不得发任何请求");
  });
  const call = (overrides: Partial<DrawRemoteRunRequest> = {}) =>
    runDrawRemote(runRequest(ws, { ...overrides, fetchImpl: silent.impl }));

  await assert.rejects(call(), expectDrawRemoteError("gemini", "unconfigured", false, ["models.json", GEMINI_PROVIDER_ID], leaks));
  ws.models({ [GEMINI_PROVIDER_ID]: GEMINI_PROVIDER });
  await assert.rejects(call(), expectDrawRemoteError("gemini", "unconfigured", false, ["auth.json", GEMINI_PROVIDER_ID], leaks));

  await assert.rejects(call({ provider: "gpt", model: "gpt-image-2.6-flare" }), expectDrawRemoteError("gpt", "unconfigured", false, ["models.json", CODEX_PROVIDER_ID], leaks));
  ws.models({ [GEMINI_PROVIDER_ID]: GEMINI_PROVIDER, [CODEX_PROVIDER_ID]: CODEX_PROVIDER });
  await assert.rejects(call({ provider: "gpt", model: "gpt-image-2.6-flare" }), expectDrawRemoteError("gpt", "unconfigured", false, ["auth.json", CODEX_PROVIDER_ID], leaks));

  for (const provider of ["wan", "qwen"] as const) {
    const request = { provider, model: provider === "wan" ? "wan2.7-image" : "qwen-image-3.0-pro" };
    const channel = `${provider} 通道`;
    const crossed = provider === "wan" ? "qwen 通道" : "wan";
    ws.models({ [CODEX_PROVIDER_ID]: CODEX_PROVIDER });
    ws.credentials({ [GEMINI_PROVIDER_ID]: GEMINI_API_KEY, [CODEX_PROVIDER_ID]: CODEX_API_KEY });
    await assert.rejects(call(request), expectDrawRemoteError(provider, "unconfigured", false, ["models.json", QWEN, channel], [...leaks, crossed]));
    ws.models({ [CODEX_PROVIDER_ID]: CODEX_PROVIDER, [QWEN]: {} });
    await assert.rejects(call(request), expectDrawRemoteError(provider, "unconfigured", false, ["models.json", "baseUrl", channel], [...leaks, crossed]));
    ws.models({ [CODEX_PROVIDER_ID]: CODEX_PROVIDER, [QWEN]: { baseUrl: "https://dashscope.test/compatible-mode/v1" } });
    await assert.rejects(call(request), expectDrawRemoteError(provider, "unconfigured", false, ["auth.json", QWEN], [...leaks, crossed]));
    ws.credentials({ [GEMINI_PROVIDER_ID]: GEMINI_API_KEY, [CODEX_PROVIDER_ID]: CODEX_API_KEY, [QWEN]: { type: "api_key", key: "" } });
    await assert.rejects(call(request), expectDrawRemoteError(provider, "unconfigured", false, ["auth.json"], [...leaks, crossed]));
  }

  writeFileSync(ws.modelsPath, '{"providers": {"x": broken-secret');
  await assert.rejects(call(), expectDrawRemoteError("gemini", "unconfigured", false, ["models.json"], [...leaks, "broken-secret"]));
  assert.equal(silent.calls.length, 0);
});

// =====================================================================
// 超时常量、分阶段遥测与同步预检
// =====================================================================

test("超时常量与透传：默认 600s / 整体 660s；qwen/wan 透传 timeoutMs 并在文案标明卡住阶段", async (t) => {
  assert.equal(DRAW_REMOTE_TIMEOUT_MS, 600_000);
  assert.equal(DRAW_REMOTE_JOB_TIMEOUT_MS, 660_000);

  const ws = workspace();
  t.after(() => ws.cleanup());
  ws.models({ [QWEN]: { baseUrl: "https://dashscope.test/compatible-mode/v1" } });
  ws.credentials({ [QWEN]: "sk-wan-key-0123456789" });

  const hangingPost = fakeFetch((_url, init) => new Promise<Response>((_resolve, reject) => {
    init?.signal?.addEventListener("abort", () => reject(init.signal?.reason ?? new DOMException("aborted", "AbortError")), { once: true });
  }));
  await assert.rejects(
    runDrawRemote(runRequest(ws, { provider: "qwen", model: "qwen-image-3.0-pro", timeoutMs: 40, fetchImpl: hangingPost.impl })),
    expectDrawRemoteError("qwen", "failed", true, ["超时", "40ms", "post"]),
  );

  const stages: DrawRemoteStageEvent[] = [];
  const hangingDownload = fakeFetch((url, init) => {
    if (url.endsWith("/generation")) {
      return jsonResponse({ output: { choices: [{ message: { content: [{ image: "https://img.test/slow.png" }] } }] } });
    }
    return new Promise<Response>((_resolve, reject) => {
      init?.signal?.addEventListener("abort", () => reject(init.signal?.reason ?? new DOMException("aborted", "AbortError")), { once: true });
    });
  });
  await assert.rejects(
    runDrawRemote(runRequest(ws, {
      provider: "qwen",
      model: "qwen-image-3.0-pro",
      timeoutMs: 40,
      fetchImpl: hangingDownload.impl,
      onStage: (ev) => stages.push(ev),
    })),
    expectDrawRemoteError("qwen", "failed", true, ["超时", "40ms", "download"]),
  );
  assert.deepEqual(stages.map((s) => s.stage), ["post", "parse"]);
  assert.equal(stages[0]?.status, 200);
  assert.equal(stages[1]?.urls, 1);
});

test("分阶段耗时遥测：qwen 顺序汇报 post/parse/download（4xx 仍发 post），gpt 与 gemini 汇报 prepare/post/parse", async (t) => {
  const ws = workspace();
  t.after(() => ws.cleanup());
  ws.models({
    [QWEN]: { baseUrl: "https://dashscope.test/compatible-mode/v1" },
    [CODEX_PROVIDER_ID]: CODEX_PROVIDER,
    [GEMINI_PROVIDER_ID]: GEMINI_PROVIDER,
  });
  ws.credentials({
    [QWEN]: "sk-wan-key-0123456789",
    [CODEX_PROVIDER_ID]: CODEX_API_KEY,
    [GEMINI_PROVIDER_ID]: GEMINI_API_KEY,
  });

  const qwenStages: DrawRemoteStageEvent[] = [];
  const qwenFetch = fakeFetch((url) =>
    url.endsWith("/generation")
      ? jsonResponse({ output: { choices: [{ message: { content: [{ image: "https://img.test/1.png" }, { image: "https://img.test/2.jpg" }] } }] } })
      : bytesResponse(url.endsWith(".png") ? PNG : JPEG),
  );
  await runDrawRemote(runRequest(ws, {
    provider: "qwen",
    model: "qwen-image-3.0-pro",
    fetchImpl: qwenFetch.impl,
    onStage: (ev) => qwenStages.push(ev),
  }));
  assert.deepEqual(qwenStages.map((s) => s.stage), ["post", "parse", "download", "download"]);
  assert.equal(qwenStages[0]?.status, 200);
  assert.equal(qwenStages[1]?.urls, 2);
  assert.equal(qwenStages[2]?.bytes, PNG.length);
  assert.equal(qwenStages[3]?.bytes, JPEG.length);

  const errStages: DrawRemoteStageEvent[] = [];
  const badFetch = fakeFetch(() => jsonResponse({ message: "bad prompt" }, 400));
  await assert.rejects(
    runDrawRemote(runRequest(ws, { provider: "qwen", model: "qwen-image-3.0-pro", fetchImpl: badFetch.impl, onStage: (ev) => errStages.push(ev) })),
    expectDrawRemoteError("qwen", "failed", false, ["400"]),
  );
  assert.deepEqual(errStages.map((s) => s.stage), ["post"]);
  assert.equal(errStages[0]?.status, 400);

  const gptStages: DrawRemoteStageEvent[] = [];
  const gptFetch = fakeFetch(() => jsonResponse({ data: [{ b64_json: PNG.toString("base64") }] }));
  await runDrawRemote(runRequest(ws, { provider: "gpt", model: "gpt-image-2.6-flare", fetchImpl: gptFetch.impl, onStage: (ev) => gptStages.push(ev) }));
  assert.deepEqual(gptStages.map((s) => s.stage), ["prepare", "post", "parse"]);
  assert.equal(gptStages[1]?.status, 200);
  assert.equal(gptStages[2]?.urls, 1);

  const gemStages: DrawRemoteStageEvent[] = [];
  const gemFetch = fakeFetch(() => jsonResponse({ candidates: [{ content: { parts: [geminiImageParts()] }, finishReason: "STOP" }] }));
  await runDrawRemote(runRequest(ws, { provider: "gemini", model: "gemini-3.1-flash-image", fetchImpl: gemFetch.impl, onStage: (ev) => gemStages.push(ev) }));
  assert.deepEqual(gemStages.map((s) => s.stage), ["prepare", "post", "parse"]);
  assert.equal(gemStages[1]?.status, 200);
  assert.equal(gemStages[2]?.urls, 1);
});

test("preflightDrawRemote：四通道统一校验合法 baseUrl 与非空 api_key，拒绝残留 oauth 与畸形 URL，损坏文件不泄密", async (t) => {
  const ws = workspace();
  t.after(() => ws.cleanup());

  assert.throws(
    () => preflightDrawRemote({ provider: "qwen", prompt: "   ", imagesCount: 0, modelsPath: ws.modelsPath }),
    expectDrawRemoteError("qwen", "prompt", false),
  );
  assert.throws(
    () => preflightDrawRemote({ provider: "qwen", prompt: "a".repeat(4001), imagesCount: 0, modelsPath: ws.modelsPath }),
    expectDrawRemoteError("qwen", "prompt", false),
  );
  assert.throws(
    () => preflightDrawRemote({ provider: "qwen", prompt: "ok", imagesCount: 4, modelsPath: ws.modelsPath }),
    expectDrawRemoteError("qwen", "bad_ref", false),
  );
  assert.throws(
    () => preflightDrawRemote({ provider: "gpt", prompt: "ok", imagesCount: 6, modelsPath: ws.modelsPath }),
    expectDrawRemoteError("gpt", "bad_ref", false),
  );

  // 缺/非法 baseUrl
  ws.models({
    [QWEN]: { baseUrl: "http://bad url" },
    [CODEX_PROVIDER_ID]: { baseUrl: "ftp://example.com/v1" },
    [GEMINI_PROVIDER_ID]: {},
  });
  ws.credentials({ [QWEN]: "sk-wan-key", [CODEX_PROVIDER_ID]: CODEX_API_KEY, [GEMINI_PROVIDER_ID]: GEMINI_API_KEY });
  for (const provider of ["qwen", "gpt", "gemini"] as const) {
    assert.throws(
      () => preflightDrawRemote({ provider, prompt: "ok", imagesCount: 0, modelsPath: ws.modelsPath }),
      expectDrawRemoteError(provider, "unconfigured", false, ["models.json", "baseUrl"]),
    );
  }

  // 合法 baseUrl 但缺 key / 空白 key / 仅有残留 oauth 条目
  ws.models({
    [QWEN]: { baseUrl: "https://dashscope.test/compatible-mode/v1" },
    [CODEX_PROVIDER_ID]: CODEX_PROVIDER,
    [GEMINI_PROVIDER_ID]: GEMINI_PROVIDER,
  });
  ws.credentials({
    [QWEN]: "   ",
    [CODEX_PROVIDER_ID]: { type: "oauth", access: "old", refresh: "old", expires: Date.now() + 3600_000, accountId: "a" },
    [GEMINI_PROVIDER_ID]: { type: "oauth", access: "old", refresh: "old", expires: Date.now() + 3600_000 },
  });
  for (const provider of ["qwen", "gpt", "gemini"] as const) {
    assert.throws(
      () => preflightDrawRemote({ provider, prompt: "ok", imagesCount: 0, modelsPath: ws.modelsPath }),
      expectDrawRemoteError(provider, "unconfigured", false, ["auth.json"]),
    );
  }

  // 损坏 auth.json 不泄密
  writeFileSync(ws.credentialsPath, '{"qwen-token-plan-cn": sk-secret-leak-test');
  for (const provider of ["qwen", "gpt", "gemini"] as const) {
    assert.throws(
      () => preflightDrawRemote({ provider, prompt: "ok", imagesCount: 0, modelsPath: ws.modelsPath }),
      expectDrawRemoteError(provider, "unconfigured", false, ["auth.json"], ["sk-secret-leak-test"]),
    );
  }

  // 全部就绪（同时测试字符串简写与 { key } 对象）
  ws.credentials({
    [QWEN]: "sk-wan-key",
    [CODEX_PROVIDER_ID]: { key: CODEX_API_KEY },
    [GEMINI_PROVIDER_ID]: GEMINI_API_KEY,
  });
  for (const provider of ["qwen", "wan", "gpt", "gemini"] as const) {
    assert.equal(
      preflightDrawRemote({ provider, prompt: "  画只猫  ", imagesCount: 1, modelsPath: ws.modelsPath }),
      "画只猫",
    );
  }
});

// =====================================================================
// 加固：参考图总字节上限、原子回滚、响应体上限与 !ok cancel
// =====================================================================

test("加固：gpt / wan / qwen 参考图总字节超 20MB 时在 onSubmitted 前拒绝（submitted=false）", async (t) => {
  const ws = workspace();
  t.after(() => ws.cleanup());
  ws.models({ [CODEX_PROVIDER_ID]: CODEX_PROVIDER, [QWEN]: { baseUrl: "https://dashscope.test/compatible-mode/v1" } });
  ws.credentials({
    [CODEX_PROVIDER_ID]: CODEX_API_KEY,
    [QWEN]: "sk-wan-key-0123456789",
  });
  const big = Buffer.alloc(10 * 1024 * 1024 + 1, 0xaa);
  const images = [
    { mimeType: "image/png", bytes: big },
    { mimeType: "image/png", bytes: big },
  ];
  const submitted = submitTracker();
  const silent = fakeFetch(() => {
    throw new Error("超限参考图不得发请求");
  });

  for (const provider of ["gpt", "wan", "qwen"] as const) {
    await assert.rejects(
      runDrawRemote(runRequest(ws, { provider, images, onSubmitted: submitted.hook, fetchImpl: silent.impl })),
      expectDrawRemoteError(provider, "bad_ref", false),
    );
  }
  assert.equal(submitted.count(), 0);
  assert.equal(silent.calls.length, 0);
});

test("加固：gpt-image / wan-image / gemini 第 2 张失败时回滚删除第 1 张，!ok 调 body.cancel 且响应体超上限拒绝", async (t) => {
  const ws = codexWorkspace(t);
  await assert.rejects(
    generateGptImages({
      baseUrl: CODEX_BASE_URL,
      apiKey: CODEX_API_KEY,
      prompt: "two cats",
      params: { model: "gpt-image-2.6-flare" },
      mediaRoot: ws.mediaRoot,
      fetchImpl: fakeFetch(() => jsonResponse({
        data: [
          { b64_json: PNG.toString("base64") },
          { b64_json: TINY_PNG.toString("base64") },
        ],
      })).impl,
    }),
    /gpt_image_too_small/,
  );
  assert.deepEqual(ws.files(), []);

  let gptCancelled = false;
  const gptTooBigStream = new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(new Uint8Array(1024));
    },
    pull(controller) {
      controller.enqueue(new Uint8Array(10 * 1024 * 1024));
    },
    cancel() {
      gptCancelled = true;
    },
  });
  await assert.rejects(
    generateGptImages({
      baseUrl: CODEX_BASE_URL,
      apiKey: CODEX_API_KEY,
      prompt: "huge json",
      params: { model: "gpt-image-2.6-flare" },
      mediaRoot: ws.mediaRoot,
      fetchImpl: fakeFetch(() => new Response(gptTooBigStream, { status: 200 })).impl,
    }),
  );
  assert.equal(gptCancelled, true);

  const wsWan = wanWorkspace(t);
  let dlCancelled = false;
  await assert.rejects(
    generateWanImage({
      apiKey: "sk-wan-key",
      baseUrl: "https://dashscope.test",
      model: "wan2.7-image",
      prompt: "two cats",
      mediaRoot: wsWan.mediaRoot,
      fetchImpl: fakeFetch((url) => {
        if (url.endsWith("/generation")) {
          return jsonResponse({ output: { choices: [{ message: { content: [{ image: "https://img.test/1.png" }, { image: "https://img.test/2.png" }] } }] } });
        }
        if (url.endsWith("/1.png")) return bytesResponse(PNG, "image/png");
        const stream = new ReadableStream<Uint8Array>({
          start(c) { c.enqueue(new Uint8Array(16)); },
          cancel() { dlCancelled = true; },
        });
        return new Response(stream, { status: 404 });
      }).impl,
    }),
    /wan_image_download_404/,
  );
  assert.equal(dlCancelled, true);
  assert.deepEqual(wsWan.files(), []);

  let wanImgCancelled = false;
  const wanTooBigImg = new ReadableStream<Uint8Array>({
    pull(controller) {
      controller.enqueue(new Uint8Array(6 * 1024 * 1024));
    },
    cancel() {
      wanImgCancelled = true;
    },
  });
  await assert.rejects(
    generateWanImage({
      apiKey: "sk-wan-key",
      baseUrl: "https://dashscope.test",
      model: "wan2.7-image",
      prompt: "huge img",
      mediaRoot: wsWan.mediaRoot,
      fetchImpl: fakeFetch((url) => {
        if (url.endsWith("/generation")) {
          return jsonResponse({ output: { choices: [{ message: { content: [{ image: "https://img.test/huge.png" }] } }] } });
        }
        return new Response(wanTooBigImg, { status: 200, headers: { "content-type": "image/png" } });
      }).impl,
    }),
  );
  assert.equal(wanImgCancelled, true);

  const wsGem = workspace();
  t.after(() => wsGem.cleanup());
  await assert.rejects(
    generateGeminiImage({
      ...geminiBase(wsGem),
      fetchImpl: fakeFetch(() => jsonResponse({
        candidates: [{ content: { parts: [geminiImageParts(PNG), geminiImageParts(TINY_PNG)] }, finishReason: "STOP" }],
      })).impl,
    }),
  );
  assert.deepEqual(wsGem.files(), []);

  let gemCancelled = false;
  const gemTooBig = new ReadableStream<Uint8Array>({
    pull(controller) {
      controller.enqueue(new Uint8Array(10 * 1024 * 1024));
    },
    cancel() {
      gemCancelled = true;
    },
  });
  await assert.rejects(
    generateGeminiImage({
      ...geminiBase(wsGem),
      fetchImpl: fakeFetch(() => new Response(gemTooBig, { status: 200 })).impl,
    }),
  );
  assert.equal(gemCancelled, true);
});
