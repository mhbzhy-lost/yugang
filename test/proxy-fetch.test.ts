import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import http from "node:http";
import https from "node:https";
import net from "node:net";
import type { Duplex } from "node:stream";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createProxyFetch } from "../src/media/proxy-fetch.ts";

function makeCertificate(dir: string): { key: Buffer; cert: Buffer } | undefined {
  const key = join(dir, "tls-key.pem");
  const cert = join(dir, "tls-cert.pem");
  const result = spawnSync(
    "openssl",
    ["req", "-x509", "-newkey", "rsa:2048", "-nodes", "-days", "1", "-subj", "/CN=127.0.0.1", "-keyout", key, "-out", cert],
    { encoding: "utf8" },
  );
  if (result.status !== 0 || !existsSync(key) || !existsSync(cert)) return undefined;
  return { key: readFileSync(key), cert: readFileSync(cert) };
}

async function startProxyAndTls(
  t: test.TestContext,
  handler: http.RequestListener,
): Promise<{ proxyUrl: string; tlsUrl: string; getConnectCount: () => number } | undefined> {
  const dir = mkdtempSync(join(tmpdir(), "proxy-stream-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const pem = makeCertificate(dir);
  if (!pem) {
    t.skip("需要 openssl");
    return undefined;
  }

  const tlsSockets = new Set<Duplex>();
  const tlsServer = https.createServer({ key: pem.key, cert: pem.cert }, handler);
  tlsServer.on("connection", (s) => {
    tlsSockets.add(s);
    s.on("close", () => tlsSockets.delete(s));
  });
  await new Promise<void>((r) => tlsServer.listen(0, "127.0.0.1", r));
  const tlsAddr = tlsServer.address();
  assert.ok(tlsAddr && typeof tlsAddr !== "string");

  let connectCount = 0;
  const proxySockets = new Set<Duplex>();
  const proxyServer = http.createServer();
  proxyServer.on("connect", (req, clientSocket, head) => {
    connectCount += 1;
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
  await new Promise<void>((r) => proxyServer.listen(0, "127.0.0.1", r));
  const proxyAddr = proxyServer.address();
  assert.ok(proxyAddr && typeof proxyAddr !== "string");

  const prevTls = process.env["NODE_TLS_REJECT_UNAUTHORIZED"];
  process.env["NODE_TLS_REJECT_UNAUTHORIZED"] = "0";
  t.after(async () => {
    if (prevTls === undefined) delete process.env["NODE_TLS_REJECT_UNAUTHORIZED"];
    else process.env["NODE_TLS_REJECT_UNAUTHORIZED"] = prevTls;
    for (const s of [...proxySockets, ...tlsSockets]) s.destroy();
    proxyServer.closeAllConnections();
    tlsServer.closeAllConnections();
    await new Promise<void>((r) => proxyServer.close(() => r()));
    await new Promise<void>((r) => tlsServer.close(() => r()));
  });

  return {
    proxyUrl: `http://127.0.0.1:${proxyAddr.port}`,
    tlsUrl: `https://127.0.0.1:${tlsAddr.port}`,
    getConnectCount: () => connectCount,
  };
}

test("createProxyFetch：收到响应头即流式吐出 SSE chunk、透传关键头并去 content-encoding、复用 keepAlive Agent", async (t) => {
  let sendSecond: (() => void) | undefined;
  let seenAcceptEncoding: string | undefined;
  const timers: NodeJS.Timeout[] = [];
  t.after(() => timers.forEach(clearTimeout));

  const env = await startProxyAndTls(t, (req, res) => {
    req.resume();
    if (req.url === "/sse") {
      seenAcceptEncoding = typeof req.headers["accept-encoding"] === "string" ? req.headers["accept-encoding"] : undefined;
      res.writeHead(200, {
        "content-type": "text/event-stream",
        "content-encoding": "gzip",
        "x-should-retry": "true",
        "retry-after-ms": "250",
        "retry-after": "3",
      });
      res.write("data: first\n\n");
      sendSecond = () => {
        res.write("data: second\n\n");
        res.end();
      };
      return;
    }
    if (req.url === "/ping") {
      res.writeHead(200, { "content-type": "text/plain" });
      res.end("pong");
      return;
    }
    res.writeHead(404);
    res.end();
  });
  if (!env) return;

  const proxied = createProxyFetch(env.proxyUrl);
  assert.ok(proxied);

  const response = await proxied(`${env.tlsUrl}/sse`);
  assert.equal(seenAcceptEncoding, "identity");
  assert.equal(response.headers.get("content-type"), "text/event-stream");
  assert.equal(response.headers.get("x-should-retry"), "true");
  assert.equal(response.headers.get("retry-after-ms"), "250");
  assert.equal(response.headers.get("retry-after"), "3");
  assert.equal(response.headers.get("content-encoding"), null);

  const reader = response.body!.getReader();
  const decoder = new TextDecoder();
  const first = await reader.read();
  assert.equal(first.done, false);
  assert.equal(decoder.decode(first.value), "data: first\n\n");

  // 服务端尚未关闭连接，此时必须已经读到第一块；再触发第二块并结束
  sendSecond?.();
  let rest = "";
  for (;;) {
    const chunk = await reader.read();
    if (chunk.done) break;
    rest += decoder.decode(chunk.value, { stream: true });
  }
  assert.equal(rest, "data: second\n\n");

  // 同一 proxyUrl 复用 keepAlive: true 的 HttpsProxyAgent，不再新建 CONNECT 隧道
  const beforeConnects = env.getConnectCount();
  const proxiedAgain = createProxyFetch(env.proxyUrl);
  assert.ok(proxiedAgain);
  const ping = await proxiedAgain(`${env.tlsUrl}/ping`);
  assert.equal(await ping.text(), "pong");
  assert.equal(env.getConnectCount(), beforeConnects, "同 proxyUrl 应复用 keepAlive Agent");
});

test("createProxyFetch：body 阶段 idleTimeoutMs 续期与超时中断，maxResponseBytes 超限销毁", async (t) => {
  const timers: NodeJS.Timeout[] = [];
  t.after(() => timers.forEach(clearTimeout));

  const env = await startProxyAndTls(t, (req, res) => {
    req.resume();
    res.on("error", () => {});
    if (req.url === "/stalled-body") {
      res.writeHead(200, { "content-type": "text/event-stream" });
      res.write("data: hello\n\n");
      // 故意不继续写也不 end，触发 body 空闲超时
      return;
    }
    if (req.url === "/trickle") {
      res.writeHead(200, { "content-type": "text/plain" });
      let count = 0;
      const tick = () => {
        count += 1;
        if (res.destroyed) return;
        res.write(`c${count}`);
        if (count >= 5) res.end();
        else timers.push(setTimeout(tick, 45));
      };
      tick();
      return;
    }
    if (req.url === "/too-big") {
      res.writeHead(200, { "content-type": "application/octet-stream" });
      res.write(Buffer.alloc(1024, 0x41));
      timers.push(setTimeout(() => {
        if (!res.destroyed) res.end(Buffer.alloc(1024, 0x42));
      }, 20));
      return;
    }
    res.writeHead(404);
    res.end();
  });
  if (!env) return;

  // 1) body 空闲超时
  const proxiedShort = createProxyFetch(env.proxyUrl, { idleTimeoutMs: 100 });
  assert.ok(proxiedShort);
  const stalledRes = await proxiedShort(`${env.tlsUrl}/stalled-body`);
  await assert.rejects(stalledRes.text(), /timed out/);

  // 2) 收到新 chunk 自动续期（5 次 × 45ms = 180ms > 100ms，仍正常完成）
  const trickleRes = await proxiedShort(`${env.tlsUrl}/trickle`);
  assert.equal(await trickleRes.text(), "c1c2c3c4c5");

  // 3) maxResponseBytes 超限拒绝并销毁流
  const proxiedBounded = createProxyFetch(env.proxyUrl, { maxResponseBytes: 512 });
  assert.ok(proxiedBounded);
  const bigRes = await proxiedBounded(`${env.tlsUrl}/too-big`);
  await assert.rejects(bigRes.arrayBuffer(), /exceeded|limit|512/i);
});
