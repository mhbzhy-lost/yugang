/**
 * 模型配置与凭据是两件事：
 *  - config/models.json 是本机文件（gitignore）；进仓库的是模板 config/models.example.json
 *    （角色表 + provider 地址 + 模型清单 + 兼容值），下面的结构断言都读模板
 *  - 凭据在 config/auth.json（gitignore），loadFishModels 只读它，不依赖 ~/pi-config
 *  - 模型选择只认 models.main / models.vision / models.image，没有环境变量与启动参数
 *  - describeModel 永远不吐 key
 */
import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import http from "node:http";
import https from "node:https";
import net from "node:net";
import type { Duplex } from "node:stream";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describeModel, loadFishModels, loadProviderConfig, readCredentialFile } from "../src/model/config.ts";
import { assertModelExists, createFishModels, providerProxyHosts } from "../src/model/models.ts";
import { probeModelConfig } from "../src/model/probe.ts";

const EXAMPLE_MODELS = fileURLToPath(new URL("../config/models.example.json", import.meta.url));
const FAKE_KEY = "test-key-0123456789abcdef";

function scratch(): { modelsPath: string; credentialsPath: string } {
  const dir = mkdtempSync(join(tmpdir(), "fish-model-"));
  const modelsPath = join(dir, "models.json");
  writeFileSync(
    modelsPath,
    JSON.stringify({
      models: {
        main: { provider: "gw", model: "Fast" },
      },
      providers: {
        gw: {
          api: "openai-completions",
          baseUrl: "http://127.0.0.1:9/v1",
          compat: { maxTokensField: "max_tokens", supportsStore: false },
          models: [
            { id: "Fast", contextWindow: 1000, maxTokens: 100, compat: { maxTokensField: "max_completion_tokens" } },
            { id: "Slow", contextWindow: 2000, maxTokens: 200 },
          ],
        },
      },
    }),
  );
  const credentialsPath = join(dir, "credentials.json");
  writeFileSync(credentialsPath, JSON.stringify({ gw: { key: FAKE_KEY } }), { mode: 0o600 });
  return { modelsPath, credentialsPath };
}

test("config/models.example.json 模板能按角色解析", () => {
  const selection = loadFishModels({ modelsPath: EXAMPLE_MODELS, credentialsPath: "/nonexistent" });
  assert.ok(selection.main.providerId && selection.main.modelId, "models.main 必须能解析");
  assert.ok(selection.vision.providerId && selection.vision.modelId, "models.vision 必须能解析");
  assert.ok(selection.image, "models.image 必须能解析");
  const raw = JSON.parse(readFileSync(EXAMPLE_MODELS, "utf8")) as Record<string, unknown>;
  assert.equal("default" in raw, false, "models.json 不该再有 default：模型选择只走 models 角色表");

  const providerOnly = loadProviderConfig("qoder-pool", { modelsPath: EXAMPLE_MODELS, credentialsPath: "/nonexistent" });
  assert.equal(providerOnly.providerId, "qoder-pool");
  assert.equal(providerOnly.modelId, "DeepSeek-Flash");
  assert.match(providerOnly.baseUrl, /^http/);
  assert.deepEqual(providerOnly.models.map((m) => m.id), ["DeepSeek-Flash"]);
});

test("glm-5.3-flash：reasoning 保持 true，thinkingLevelMap 六档全 null（思考永久关闭）", () => {
  const config = JSON.parse(readFileSync(EXAMPLE_MODELS, "utf8")) as {
    providers: Record<string, { models: { id: string; reasoning?: boolean; thinkingLevelMap?: Record<string, string | null> }[] }>;
  };
  const entry = config.providers["zai-coding-cn"].models.find((m) => m.id === "glm-5.3-flash");
  assert.ok(entry, "模板里必须有 glm-5.3-flash");
  assert.equal(entry.reasoning, true, "reasoning 不能改 false：不发 thinking 参数，GLM 服务端会默认开思考");
  assert.deepEqual(
    Object.keys(entry.thinkingLevelMap ?? {}).sort(),
    ["high", "low", "max", "medium", "minimal", "off", "xhigh"],
    "thinkingLevelMap 必须六档齐全",
  );
  assert.deepEqual(
    Object.values(entry.thinkingLevelMap ?? {}).filter((v) => v !== null),
    [],
    "六档必须全 null：可用档位只剩 off，pi-ai 永远钳到 off，zai 发 thinking.type=disabled",
  );
});

test("config/auth.json 与 config/models.json 必须在 gitignore 里", () => {
  const ignore = readFileSync(fileURLToPath(new URL("../.gitignore", import.meta.url)), "utf8");
  assert.match(ignore, /^config\/auth\.json$/m, "凭据文件没被忽略，一次 git add 就进仓库了");
  assert.match(ignore, /^config\/models\.json$/m, "模型配置是本机文件，没被忽略就会把机器专属配置带进仓库");
});

test("模板里不能有 key", () => {
  const raw = JSON.stringify(loadFishModels({ modelsPath: EXAMPLE_MODELS, credentialsPath: "/nonexistent" }));
  assert.ok(!/sk-|api_key|"key":\s*"[^"]{20,}/.test(raw), "config/models.example.json 里疑似写了凭据");
});

test("凭据默认和 models.json 同目录（config/auth.json），缺了就报缺失而不是崩", () => {
  const { modelsPath, credentialsPath } = scratch();
  const selection = loadFishModels({ modelsPath, credentialsPath });
  assert.equal(selection.main.key, FAKE_KEY);
  // vision 省略 = 与 main 完全相同
  assert.equal(selection.vision.providerId, selection.main.providerId);
  assert.equal(selection.vision.modelId, selection.main.modelId);
  assert.equal(loadFishModels({ modelsPath, credentialsPath: "/nonexistent" }).main.key, "");
});

test("provider 级 compat 兜底，模型自带的覆盖它", () => {
  const { modelsPath, credentialsPath } = scratch();
  const selection = loadFishModels({ modelsPath, credentialsPath });
  const fast = selection.main.models.find((m) => m.id === "Fast")!;
  const slow = loadProviderConfig("gw", { modelsPath, credentialsPath, modelId: "Slow" }).models.find((m) => m.id === "Slow")!;
  assert.equal((fast.compat as Record<string, unknown>)["maxTokensField"], "max_completion_tokens");
  assert.equal((slow.compat as Record<string, unknown>)["maxTokensField"], "max_tokens");
  assert.equal((slow.compat as Record<string, unknown>)["supportsStore"], false);
});

test("describeModel 里不会出现 key 内容", () => {
  const { modelsPath, credentialsPath } = scratch();
  const shown = JSON.stringify(describeModel(loadFishModels({ modelsPath, credentialsPath }).main));
  assert.ok(!shown.includes(FAKE_KEY), "key 泄漏进 describeModel 了");
  assert.match(shown, /已加载/);
});

test("没有 key 就不许建 Models", () => {
  const { modelsPath } = scratch();
  const selection = loadFishModels({ modelsPath, credentialsPath: "/nonexistent" });
  assert.throws(() => createFishModels(selection.main), /没有拿到/);
});

test("build 出来的 Models 能找到配置里的模型，找不到时报可用清单", () => {
  const { modelsPath, credentialsPath } = scratch();
  const selection = loadFishModels({ modelsPath, credentialsPath });
  const models = createFishModels(selection.main);
  assert.doesNotThrow(() => assertModelExists(models, "gw", "Fast"));
  assert.throws(() => assertModelExists(models, "gw", "不存在"), /Fast, Slow/);
});

test("providerProxyHosts 包含 daily-cloudcode-pa.googleapis.com 与 chatgpt.com", () => {
  const agHosts = providerProxyHosts({
    providerId: "google-antigravity",
    modelId: "gemini-4",
    baseUrl: "",
    api: "antigravity-code-assist",
    authMode: "oauth",
    models: [],
    key: "",
    keySource: "",
    configSource: "",
    credentialsPath: "",
  });
  assert.ok(agHosts.includes("daily-cloudcode-pa.googleapis.com"));
  assert.ok(agHosts.includes("oauth2.googleapis.com"));

  const codexHosts = providerProxyHosts({
    providerId: "openai-codex",
    modelId: "gpt-5",
    baseUrl: "",
    api: "openai-codex-responses",
    authMode: "oauth",
    models: [],
    key: "",
    keySource: "",
    configSource: "",
    credentialsPath: "",
  });
  assert.ok(codexHosts.includes("chatgpt.com"));
  assert.ok(codexHosts.includes("auth.openai.com"));
});

test("readCredentialFile / describeModel / loadProviderConfig：损坏 JSON 不泄原文、非有限 expires 不抛 RangeError、缺 models 报语义错", (t) => {
  const dir = mkdtempSync(join(tmpdir(), "fish-model-cfg-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const badAuth = join(dir, "bad-auth.json");
  writeFileSync(badAuth, '{"gw": "sk-top-secret-raw-text', { mode: 0o600 });

  assert.throws(
    () => readCredentialFile(badAuth, "gw"),
    (err: unknown) => {
      assert.ok(err instanceof Error);
      assert.ok(!err.message.includes("sk-top-secret-raw-text"), "不得泄露损坏 auth.json 原文");
      return true;
    },
  );

  // 非有限 expires 不得令 readCredentialFile 放行，也不得令 describeModel 抛 RangeError
  const nullExpAuth = join(dir, "null-exp-auth.json");
  writeFileSync(
    nullExpAuth,
    JSON.stringify({ codex: { type: "oauth", access: "a", refresh: "r", expires: null } }),
    { mode: 0o600 },
  );
  assert.equal(readCredentialFile(nullExpAuth, "codex"), undefined);

  const described = describeModel({
    providerId: "codex",
    modelId: "gpt-5",
    baseUrl: "",
    api: "openai-codex-responses",
    authMode: "oauth",
    models: [],
    key: "",
    oauth: { access: "a", refresh: "r", expires: Number.NaN },
    keySource: nullExpAuth,
    configSource: "",
    credentialsPath: nullExpAuth,
  });
  assert.match(String(described.key), /未知/);

  const badModels = join(dir, "bad-models.json");
  writeFileSync(badModels, JSON.stringify({ providers: { broken: { api: "openai-completions" } } }));
  assert.throws(
    () => loadProviderConfig("broken", { modelsPath: badModels, credentialsPath: "/nonexistent" }),
    /models/,
  );
});

test("probeModelConfig：不覆写全局 scopedProxies、通过局部代理发请求且 safeError 抹除 oauthClient.secret 与引号 refresh_token", async (t) => {
  const dir = mkdtempSync(join(tmpdir(), "fish-probe-proxy-"));
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

  let proxyHits = 0;
  let proxyTokenHits = 0;
  let directHits = 0;
  const tlsServer = https.createServer({ key: readFileSync(keyPath), cert: readFileSync(certPath) }, (req, res) => {
    req.resume();
    if (req.headers["x-via-proxy-check"] === "direct") directHits += 1;
    if (req.url === "/token") {
      proxyTokenHits += 1;
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ access_token: "refreshed-acc", expires_in: 3600 }));
      return;
    }
    res.writeHead(500, { "content-type": "application/json" });
    res.end(
      JSON.stringify({
        error: 'failed with clientSecret=my-oauth-client-secret and "refresh_token": "rt-quoted-secret-777"',
      }),
    );
  });
  await new Promise<void>((r) => tlsServer.listen(0, "127.0.0.1", r));
  const tlsAddr = tlsServer.address();
  assert.ok(tlsAddr && typeof tlsAddr !== "string");

  const proxySockets = new Set<Duplex>();
  const proxyServer = http.createServer();
  proxyServer.on("connect", (req, clientSocket, head) => {
    proxyHits += 1;
    const [rawHost, rawPort] = String(req.url).split(":");
    const targetHost = rawHost === "oauth2.googleapis.com" ? "127.0.0.1" : rawHost;
    const targetPort = rawHost === "oauth2.googleapis.com" ? tlsAddr.port : Number(rawPort);
    const upstream = net.connect(targetPort, targetHost, () => {
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
    for (const s of proxySockets) s.destroy();
    proxyServer.closeAllConnections();
    tlsServer.closeAllConnections();
    await new Promise<void>((r) => proxyServer.close(() => r()));
    await new Promise<void>((r) => tlsServer.close(() => r()));
  });

  const authPath = join(dir, "auth.json");
  writeFileSync(
    authPath,
    JSON.stringify({
      "probe-ag-isolated": {
        type: "oauth",
        access: "acc-123456",
        refresh: "ref-123456",
        expires: Date.now() - 1000,
        clientId: "cid-1",
        clientSecret: "my-oauth-client-secret",
      },
    }),
    { mode: 0o600 },
  );

  const err = await probeModelConfig({
    providerId: "probe-ag-isolated",
    modelId: "gemini-4-flash",
    baseUrl: `https://127.0.0.1:${tlsAddr.port}`,
    api: "antigravity-code-assist",
    authMode: "oauth",
    models: [
      {
        id: "gemini-4-flash",
        reasoning: false,
        input: ["text"],
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
        contextWindow: 100000,
        maxTokens: 8192,
      },
    ],
    key: "",
    oauth: { access: "acc-123456", refresh: "ref-123456", expires: Date.now() - 1000 },
    keySource: authPath,
    configSource: "",
    credentialsPath: authPath,
    proxy: `http://127.0.0.1:${proxyAddr.port}`,
    oauthClient: { id: "cid-1", secret: "my-oauth-client-secret" },
  }).catch((e) => e as Error);

  assert.ok(err instanceof Error);
  assert.ok(proxyTokenHits >= 1, "probeModelConfig 的 OAuth refresh 应经局部 proxyFetch 发送");
  assert.ok(proxyHits >= 2, "probeModelConfig 应经局部 proxyFetch 发送 OAuth 与模型请求");
  assert.ok(!err.message.includes("my-oauth-client-secret"), "safeError 必须抹除 oauthClient.secret");
  assert.ok(!err.message.includes("rt-quoted-secret-777"), "safeError 必须抹除 JSON 引号形式 refresh_token");

  // 验证全局 globalThis.fetch 未被 probeModelConfig 注入 127.0.0.1 的 scopedProxies 污染
  const hitsBefore = proxyHits;
  const directRes = await fetch(`https://127.0.0.1:${tlsAddr.port}/direct`, {
    headers: { "x-via-proxy-check": "direct" },
  });
  assert.equal(directRes.status, 500);
  assert.equal(directHits, 1);
  assert.equal(proxyHits, hitsBefore, "probeModelConfig 不得覆写全局 scopedProxies");
});

test("buildProvider：配置 transport 时为未显式传 transport 的调用自动注入默认 transport", async (t) => {
  const dir = mkdtempSync(join(tmpdir(), "fish-transport-"));
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

  let httpHits = 0;
  const tlsServer = https.createServer({ key: readFileSync(keyPath), cert: readFileSync(certPath) }, (req, res) => {
    req.resume();
    httpHits += 1;
    res.writeHead(200, { "content-type": "text/event-stream" });
    res.end(
      'data: {"type":"response.completed","response":{"id":"r1","status":"completed","output":[{"type":"message","id":"m1","status":"completed","role":"assistant","content":[{"type":"output_text","text":"在的"}]}],"usage":{"input_tokens":1,"output_tokens":1,"total_tokens":2}}}\n\n',
    );
  });
  await new Promise<void>((r) => tlsServer.listen(0, "127.0.0.1", r));
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
  await new Promise<void>((r) => proxyServer.listen(0, "127.0.0.1", r));
  const proxyAddr = proxyServer.address();
  assert.ok(proxyAddr && typeof proxyAddr !== "string");

  const prevTls = process.env["NODE_TLS_REJECT_UNAUTHORIZED"];
  process.env["NODE_TLS_REJECT_UNAUTHORIZED"] = "0";
  t.after(async () => {
    if (prevTls === undefined) delete process.env["NODE_TLS_REJECT_UNAUTHORIZED"];
    else process.env["NODE_TLS_REJECT_UNAUTHORIZED"] = prevTls;
    for (const s of proxySockets) s.destroy();
    proxyServer.closeAllConnections();
    tlsServer.closeAllConnections();
    await new Promise<void>((r) => proxyServer.close(() => r()));
    await new Promise<void>((r) => tlsServer.close(() => r()));
  });

  const payload = Buffer.from(
    JSON.stringify({ "https://api.openai.com/auth": { chatgpt_account_id: "acct-test" } }),
  ).toString("base64url");
  const authPath = join(dir, "auth.json");
  writeFileSync(
    authPath,
    JSON.stringify({
      "codex-sse-test": {
        type: "oauth",
        access: `hdr.${payload}.sig`,
        refresh: "ref-1",
        expires: Date.now() + 3600_000,
      },
    }),
    { mode: 0o600 },
  );

  const models = createFishModels(
    {
      providerId: "codex-sse-test",
      modelId: "gpt-5",
      baseUrl: `https://127.0.0.1:${tlsAddr.port}/codex`,
      api: "openai-codex-responses",
      authMode: "oauth",
      models: [
        {
          id: "gpt-5",
          reasoning: false,
          input: ["text"],
          cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
          contextWindow: 100000,
          maxTokens: 4096,
        },
      ],
      key: "",
      keySource: authPath,
      configSource: "",
      credentialsPath: authPath,
      proxy: `http://127.0.0.1:${proxyAddr.port}`,
      transport: "sse",
    },
    { registerGlobalProxy: false },
  );
  const model = models.getModel("codex-sse-test", "gpt-5")!;
  // 不显式传 transport：若未注入 "sse"，codex 默认走 "auto" 会先尝试 WebSocket 建连失败再降级；
  // 注入 "sse" 后直接走 local proxyFetch 的 HTTPS SSE 路径。
  const msg = await models.streamSimple(model, { messages: [{ role: "user", content: "hi" }] }).result();
  assert.equal(msg.stopReason, "stop");
  assert.equal(httpHits, 1);
});
