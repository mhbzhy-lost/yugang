/**
 * 模型配置与凭据是两件事：
 *  - config/models.json 是本机文件（gitignore）；进仓库的是模板 config/models.example.json
 *    （角色表 + provider 地址 + 模型清单 + 兼容值），下面的结构断言都读模板
 *  - 凭据在 config/auth.json（gitignore），loadFishModels 只读它，不依赖 ~/pi-config
 *  - 四大标准协议（openai-completions / openai-responses / anthropic-messages / google-generative-ai）
 *    均由 @earendil-works/pi-ai 原生承载，纯 API Key，拒绝已退役的 auth: "oauth" 与旧私有 api
 *  - describeModel 永远不吐 key
 */
import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import http from "node:http";
import https from "node:https";
import net from "node:net";
import type { Duplex } from "node:stream";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  DEFAULT_BASE_URLS,
  describeModel,
  loadFishModels,
  loadProviderConfig,
  readCredentialFile,
  thinkingOffWarning,
  type SupportedProviderApi,
} from "../src/model/config.ts";
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

test("config/models.example.json 模板能按角色解析且包含三大 CLIProxyAPI 标准协议 provider", () => {
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

  const codex = loadProviderConfig("cliproxyapi-codex", { modelsPath: EXAMPLE_MODELS, credentialsPath: "/nonexistent" });
  assert.equal(codex.api, "openai-responses");
  assert.equal(codex.baseUrl, "http://cliproxyapi:8317/v1");

  const claude = loadProviderConfig("cliproxyapi-claude", { modelsPath: EXAMPLE_MODELS, credentialsPath: "/nonexistent" });
  assert.equal(claude.api, "anthropic-messages");
  assert.equal(claude.baseUrl, "http://cliproxyapi:8317");

  const gemini = loadProviderConfig("cliproxyapi-gemini", { modelsPath: EXAMPLE_MODELS, credentialsPath: "/nonexistent" });
  assert.equal(gemini.api, "google-generative-ai");
  assert.equal(gemini.baseUrl, "http://cliproxyapi:8317/v1beta");
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
  assert.equal(selection.vision.providerId, selection.main.providerId);
  assert.equal(selection.vision.modelId, selection.main.modelId);
  assert.equal(loadFishModels({ modelsPath, credentialsPath: "/nonexistent" }).main.key, "");
});

test("provider 级 compat 兜底（仅 openai-completions 注入默认 maxTokensField）", (t) => {
  const { modelsPath, credentialsPath } = scratch();
  const selection = loadFishModels({ modelsPath, credentialsPath });
  const fast = selection.main.models.find((m) => m.id === "Fast")!;
  const slow = loadProviderConfig("gw", { modelsPath, credentialsPath, modelId: "Slow" }).models.find((m) => m.id === "Slow")!;
  assert.equal((fast.compat as Record<string, unknown>)["maxTokensField"], "max_completion_tokens");
  assert.equal((slow.compat as Record<string, unknown>)["maxTokensField"], "max_tokens");
  assert.equal((slow.compat as Record<string, unknown>)["supportsStore"], false);

  const dir = mkdtempSync(join(tmpdir(), "fish-compat-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const mp = join(dir, "models.json");
  writeFileSync(mp, JSON.stringify({
    models: { main: { provider: "cl", model: "claude-sonnet" } },
    providers: {
      cl: {
        api: "anthropic-messages",
        baseUrl: "http://cliproxyapi:8317",
        models: [{ id: "claude-sonnet", contextWindow: 200000, maxTokens: 8192 }],
      },
    },
  }));
  const loaded = loadFishModels({ modelsPath: mp, credentialsPath: "/nonexistent" });
  assert.equal(loaded.main.models[0]?.compat, undefined, "非 openai-completions 不应注入 maxTokensField");
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

test("四大标准协议均可经 createFishModels 装配，省略 baseUrl 时补齐非空官方默认串", () => {
  const cases: Array<{ api: SupportedProviderApi; expectedBaseUrl: string; expectedHost: string }> = [
    { api: "openai-completions", expectedBaseUrl: "https://api.openai.com/v1", expectedHost: "api.openai.com" },
    { api: "openai-responses", expectedBaseUrl: "https://api.openai.com/v1", expectedHost: "api.openai.com" },
    { api: "anthropic-messages", expectedBaseUrl: "https://api.anthropic.com", expectedHost: "api.anthropic.com" },
    { api: "google-generative-ai", expectedBaseUrl: "https://generativelanguage.googleapis.com/v1beta", expectedHost: "generativelanguage.googleapis.com" },
  ];

  for (const { api, expectedBaseUrl, expectedHost } of cases) {
    assert.equal(DEFAULT_BASE_URLS[api], expectedBaseUrl);
    const config = {
      providerId: `p-${api}`,
      modelId: "m-1",
      baseUrl: "",
      api,
      models: [{ id: "m-1", contextWindow: 100000, maxTokens: 4096 }],
      key: FAKE_KEY,
      keySource: "/tmp/auth.json",
      configSource: "/tmp/models.json",
      credentialsPath: "/tmp/auth.json",
    };
    const models = createFishModels(config);
    const registered = models.getModel(`p-${api}`, "m-1");
    assert.ok(registered, `${api} 应注册模型`);
    assert.equal(registered.api, api);
    assert.equal(registered.baseUrl, expectedBaseUrl, `${api} 缺省 baseUrl 必须非空`);
    assert.deepEqual(providerProxyHosts(config), [expectedHost]);
  }

  assert.deepEqual(
    providerProxyHosts({
      providerId: "cp",
      modelId: "m-1",
      baseUrl: "http://cliproxyapi:8317/v1",
      api: "openai-responses",
      models: [],
      key: FAKE_KEY,
      keySource: "",
      configSource: "",
      credentialsPath: "",
    }),
    ["cliproxyapi"],
  );
});

test("auth: oauth 与退役/未知 api 在加载与构模期均先于缺 key 报错并给出迁移提示", (t) => {
  const dir = mkdtempSync(join(tmpdir(), "fish-retire-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));

  // 1) auth: "oauth"（无 key 时也优先报迁移错）
  const oauthPath = join(dir, "oauth.json");
  writeFileSync(oauthPath, JSON.stringify({
    models: { main: { provider: "old-codex", model: "gpt-5" } },
    providers: {
      "old-codex": { api: "openai-responses", auth: "oauth", models: [{ id: "gpt-5" }] },
    },
  }));
  assert.throws(
    () => loadFishModels({ modelsPath: oauthPath, credentialsPath: "/nonexistent" }),
    /auth.*oauth.*已退役.*CLIProxyAPI/,
  );

  // 2) 退役 api（无 key 时也在 buildConfig 优先报不支持 api）
  for (const retiredApi of ["antigravity-code-assist", "google-code-assist", "openai-codex-responses", "unknown-api"]) {
    const retiredPath = join(dir, `${retiredApi}.json`);
    writeFileSync(retiredPath, JSON.stringify({
      models: { main: { provider: "legacy", model: "m1" } },
      providers: {
        legacy: { api: retiredApi, models: [{ id: "m1" }] },
      },
    }));
    assert.throws(
      () => loadFishModels({ modelsPath: retiredPath, credentialsPath: "/nonexistent" }),
      /不支持.*CLIProxyAPI/,
      `${retiredApi} 应被 loadFishModels 拒绝`,
    );

    // 直接调 createFishModels（缺 key）也先报不支持 api 而非模糊缺 key
    assert.throws(
      () => createFishModels({
        providerId: "legacy",
        modelId: "m1",
        baseUrl: "",
        api: retiredApi as never,
        models: [{ id: "m1" }],
        key: "",
        keySource: "/nonexistent",
        configSource: retiredPath,
        credentialsPath: "/nonexistent",
      }),
      /不支持.*CLIProxyAPI/,
      `${retiredApi} 在 createFishModels 缺 key 时也应优先报迁移错`,
    );
  }
});

test("google-generative-ai 在 registerGlobalProxy=false 且带 proxy 时不注入自定义 opts.fetch（不触发 pi-ai 拒绝）", async () => {
  const models = createFishModels(
    {
      providerId: "cp-gemini",
      modelId: "gemini-3-flash",
      baseUrl: "http://127.0.0.1:9/v1beta",
      api: "google-generative-ai",
      models: [
        {
          id: "gemini-3-flash",
          reasoning: false,
          input: ["text"],
          cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
          contextWindow: 100000,
          maxTokens: 4096,
        },
      ],
      key: FAKE_KEY,
      keySource: "/tmp/auth.json",
      configSource: "/tmp/models.json",
      credentialsPath: "/tmp/auth.json",
      proxy: "http://127.0.0.1:7897",
    },
    { registerGlobalProxy: false },
  );
  const model = models.getModel("cp-gemini", "gemini-3-flash")!;
  const controller = new AbortController();
  controller.abort();
  const msg = await models.streamSimple(model, { messages: [{ role: "user", content: "hi" }] }, { signal: controller.signal }).result();
  assert.doesNotMatch(
    String(msg.errorMessage ?? ""),
    /Custom fetch is not supported/i,
    "google-generative-ai 绝不得触发 pi-ai 自定义 fetch 拒绝错误",
  );
});

test("readCredentialFile / loadProviderConfig：忽略残留 oauth 条目、损坏 JSON 不泄原文、缺 models 报语义错", (t) => {
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

  const mixedAuth = join(dir, "mixed-auth.json");
  writeFileSync(
    mixedAuth,
    JSON.stringify({
      legacyOauth: { type: "oauth", access: "a", refresh: "r", expires: Date.now() + 3600_000 },
      strKey: "local",
      objKey: { type: "api_key", key: "sk-123" },
      blankKey: "   ",
    }),
    { mode: 0o600 },
  );
  assert.equal(readCredentialFile(mixedAuth, "legacyOauth"), undefined, "残留 oauth 条目必须忽略返回 undefined");
  assert.deepEqual(readCredentialFile(mixedAuth, "strKey"), { type: "api_key", key: "local" });
  assert.deepEqual(readCredentialFile(mixedAuth, "objKey"), { type: "api_key", key: "sk-123" });
  assert.equal(readCredentialFile(mixedAuth, "blankKey"), undefined, "纯空白 key 视作未配置");

  const badModels = join(dir, "bad-models.json");
  writeFileSync(badModels, JSON.stringify({ providers: { broken: { api: "openai-completions" } } }));
  assert.throws(
    () => loadProviderConfig("broken", { modelsPath: badModels, credentialsPath: "/nonexistent" }),
    /models/,
  );
});

test("thinkingOffWarning：非 openai-completions reasoning 模型显式 off=null 时仍返回告警", () => {
  const warn = thinkingOffWarning({
    providerId: "cp-gemini",
    modelId: "gemini-3.8-flash-tiered",
    baseUrl: "http://cliproxyapi:8317/v1beta",
    api: "google-generative-ai",
    models: [
      {
        id: "gemini-3.8-flash-tiered",
        reasoning: true,
        thinkingLevelMap: { off: null, low: "low" },
      },
    ],
    key: FAKE_KEY,
    keySource: "",
    configSource: "",
    credentialsPath: "",
  });
  assert.ok(warn && warn.includes("off=null"), `期望返回关不掉思考告警，实际：${String(warn)}`);

  const ok = thinkingOffWarning({
    providerId: "cp-claude",
    modelId: "claude-sonnet-4-5",
    baseUrl: "http://cliproxyapi:8317",
    api: "anthropic-messages",
    models: [{ id: "claude-sonnet-4-5", reasoning: true }],
    key: FAKE_KEY,
    keySource: "",
    configSource: "",
    credentialsPath: "",
  });
  assert.equal(ok, undefined);
});

test("probeModelConfig：不覆写全局 scopedProxies、通过局部代理发请求且 safeError 抹除 api key 与引号密钥", async (t) => {
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
  let directHits = 0;
  const tlsServer = https.createServer({ key: readFileSync(keyPath), cert: readFileSync(certPath) }, (req, res) => {
    req.resume();
    if (req.headers["x-via-proxy-check"] === "direct") directHits += 1;
    res.writeHead(500, { "content-type": "application/json" });
    res.end(
      JSON.stringify({
        error: `failed with ${FAKE_KEY} and "api_key": "quoted-secret-777"`,
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

  const err = await probeModelConfig({
    providerId: "probe-isolated",
    modelId: "gpt-test",
    baseUrl: `https://127.0.0.1:${tlsAddr.port}/v1`,
    api: "openai-completions",
    models: [
      {
        id: "gpt-test",
        reasoning: false,
        input: ["text"],
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
        contextWindow: 100000,
        maxTokens: 8192,
      },
    ],
    key: FAKE_KEY,
    keySource: "/tmp/auth.json",
    configSource: "",
    credentialsPath: "/tmp/auth.json",
    proxy: `http://127.0.0.1:${proxyAddr.port}`,
  }).catch((e) => e as Error);

  assert.ok(err instanceof Error);
  assert.ok(proxyHits >= 1, "probeModelConfig 应经局部 proxyFetch 发送模型请求");
  assert.ok(!err.message.includes(FAKE_KEY), "safeError 必须抹除 config.key");
  assert.ok(!err.message.includes("quoted-secret-777"), "safeError 必须抹除 JSON 引号形式 api_key");

  // 验证全局 globalThis.fetch 未被 probeModelConfig 注入 127.0.0.1 的 scopedProxies 污染
  const hitsBefore = proxyHits;
  const directRes = await fetch(`https://127.0.0.1:${tlsAddr.port}/direct`, {
    headers: { "x-via-proxy-check": "direct" },
  });
  assert.equal(directRes.status, 500);
  assert.equal(directHits, 1);
  assert.equal(proxyHits, hitsBefore, "probeModelConfig 不得覆写全局 scopedProxies");
});

test("compose.yaml 与 config/cliproxyapi.example.yaml 结构兜底：sidecar 固定 digest、内网直连、NO_PROXY 与标准协议模板一致", () => {
  const composePath = fileURLToPath(new URL("../compose.yaml", import.meta.url));
  const cliproxyExamplePath = fileURLToPath(new URL("../config/cliproxyapi.example.yaml", import.meta.url));
  const compose = readFileSync(composePath, "utf8");

  assert.match(compose, /^\s{2}cliproxyapi:/m, "compose.yaml 必须声明 cliproxyapi sidecar 服务");
  assert.match(
    compose,
    /image:\s*eceasy\/cli-proxy-api@sha256:[0-9a-f]{64}/,
    "cliproxyapi 镜像必须固定 @sha256: digest，不得使用浮动 tag",
  );
  assert.match(compose, /\.\/var\/cliproxyapi:\/data/, "cliproxyapi 必须 bind mount ./var/cliproxyapi:/data");
  assert.doesNotMatch(compose, /8317:8317/, "cliproxyapi 不得向宿主机发布 8317 端口（避免冲突）");
  assert.match(compose, /depends_on:\s*(?:\n\s+-\s+\S+)*\n\s+-\s+cliproxyapi/, "fish.depends_on 必须包含 cliproxyapi");
  const noProxyLine = compose.split("\n").find((line) => line.includes("NO_PROXY:")) ?? "";
  assert.ok(noProxyLine.includes("cliproxyapi"), `fish 的 NO_PROXY 必须包含 cliproxyapi：${noProxyLine}`);

  const exampleYaml = readFileSync(cliproxyExamplePath, "utf8");
  assert.match(exampleYaml, /^config-version:\s*8\b/m);
  assert.match(exampleYaml, /^\s*host:\s*"0\.0\.0\.0"/m);
  assert.match(exampleYaml, /^\s*port:\s*8317\b/m);
  assert.match(exampleYaml, /^\s*auth-dir:\s*"\/data\/auth"/m);
  assert.ok(!/sk-[A-Za-z0-9_-]{16,}|AIza[A-Za-z0-9_-]{20,}|ya29\./.test(exampleYaml), "cliproxyapi 模板不得含真实密钥");

  const rawModels = JSON.parse(readFileSync(EXAMPLE_MODELS, "utf8")) as {
    providers: Record<string, Record<string, unknown>>;
  };
  const codex = rawModels.providers["cliproxyapi-codex"];
  const claude = rawModels.providers["cliproxyapi-claude"];
  const gemini = rawModels.providers["cliproxyapi-gemini"];
  assert.equal(codex?.["api"], "openai-responses");
  assert.equal(codex?.["baseUrl"], "http://cliproxyapi:8317/v1");
  assert.equal(claude?.["api"], "anthropic-messages");
  assert.equal(claude?.["baseUrl"], "http://cliproxyapi:8317");
  assert.equal(gemini?.["api"], "google-generative-ai");
  assert.equal(gemini?.["baseUrl"], "http://cliproxyapi:8317/v1beta");
  for (const [id, provider] of Object.entries(rawModels.providers)) {
    assert.equal(provider["auth"], undefined, `${id} 不得再含 auth`);
    assert.equal(provider["oauthClient"], undefined, `${id} 不得再含 oauthClient`);
    assert.equal(provider["userAgent"], undefined, `${id} 不得再含 userAgent`);
    assert.equal(provider["transport"], undefined, `${id} 不得再含 transport`);
  }
});

test("scripts/creds.ts：损坏的 auth.json 不得在 stderr 回显明文 key 片段", (t) => {
  const dir = mkdtempSync(join(tmpdir(), "fish-creds-cli-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const configDir = join(dir, "config");
  const credsCli = fileURLToPath(new URL("../scripts/creds.ts", import.meta.url));
  writeFileSync(join(dir, "keep"), "");
  spawnSync("mkdir", ["-p", configDir]);
  writeFileSync(
    join(configDir, "auth.json"),
    '{"deepseek": {"type": "api_key", "key": "sk-SECRET-LEAK-CHECK-9999"}, "broken": oops}',
    { mode: 0o600 },
  );
  const res = spawnSync(process.execPath, [credsCli, "show"], {
    env: { ...process.env, YUGANG_ROOT: dir },
    encoding: "utf8",
  });
  assert.equal(res.status, 1);
  assert.ok(!res.stderr.includes("sk-SECRET-LEAK-CHECK-9999"), `stderr 不得泄露密钥：${res.stderr}`);
  assert.ok(!res.stdout.includes("sk-SECRET-LEAK-CHECK-9999"), `stdout 不得泄露密钥：${res.stdout}`);
  assert.match(res.stderr, /JSON 损坏/);
});
