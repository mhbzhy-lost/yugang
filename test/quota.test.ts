/**
 * provider 额度查询（src/model/quota.ts + scripts/quota.ts）的兜底测试：
 * DeepSeek / ZAI 两类 API key 渠道解析与格式化、订阅制与 CLIProxyAPI 渠道标 unsupported、
 * unconfigured（含残留 oauth 条目）、错误脱敏与不阻断、角色标注与过滤、JSON 不含敏感字段、CLI 退出码。
 */

import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  queryQuotas,
  formatQuotaReport,
  formatLocalTime,
  redactSecrets,
} from "../src/model/quota.ts";

const QUOTA_CLI = fileURLToPath(new URL("../scripts/quota.ts", import.meta.url));

function scratch(
  providers: Record<string, unknown>,
  roles: Record<string, { provider: string; model: string }> = {},
  credentials?: Record<string, unknown>,
) {
  const dir = mkdtempSync(join(tmpdir(), "fish-quota-"));
  const modelsPath = join(dir, "models.json");
  const credentialsPath = join(dir, "auth.json");
  writeFileSync(modelsPath, JSON.stringify({ models: roles, providers }));
  if (credentials) writeFileSync(credentialsPath, JSON.stringify(credentials), { mode: 0o600 });
  return { dir, modelsPath, credentialsPath };
}

function jsonRes(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
}

function fakeFetch(handler: (url: string, init?: RequestInit) => Response | Promise<Response>) {
  const calls: { url: string; init?: RequestInit }[] = [];
  const impl: typeof fetch = async (input, init) => {
    const url = String(input);
    calls.push({ url, init });
    return handler(url, init);
  };
  return { impl, calls };
}

function headerOf(init: RequestInit | undefined, name: string): string | undefined {
  const headers = (init?.headers ?? {}) as Record<string, string>;
  for (const [key, value] of Object.entries(headers)) {
    if (key.toLowerCase() === name) return value;
  }
  return undefined;
}

const ZAI_PAYLOAD = {
  code: 200,
  data: {
    limits: [
      { type: "CREDIT_LIMIT", unit: 3, number: 5, usage: 28000, currentValue: 623, remaining: 27376, percentage: 2, nextResetTime: 1795626148037 },
      { type: "CREDIT_LIMIT", unit: 6, number: 1, usage: 140000, currentValue: 38537, remaining: 101462, percentage: 27, nextResetTime: 1795897474984 },
    ],
    level: "max",
  },
  success: true,
};

// ---------- DeepSeek ----------

test("deepseek：/v1 剥离后查 user/balance，余额与可用性解析", async () => {
  const paths = scratch(
    { deepseek: { api: "openai-completions", baseUrl: "https://api.deepseek.com/v1", models: [] } },
    { vision_fallback: { provider: "deepseek", model: "deepseek-chat" } },
    { deepseek: { key: "sk-deepseek-secret-key-123" } },
  );
  const { impl, calls } = fakeFetch((url) => {
    assert.equal(url, "https://api.deepseek.com/user/balance");
    return jsonRes({
      is_available: true,
      balance_infos: [{ currency: "CNY", total_balance: "10.00", granted_balance: "0.00", topped_up_balance: "10.00" }],
    });
  });
  const report = await queryQuotas({ ...paths, fetchImpl: impl });
  const provider = report.providers[0]!;
  assert.equal(provider.status, "ok");
  assert.equal(provider.kind, "deepseek");
  assert.equal(provider.available, true);
  assert.deepEqual(provider.balances, [
    { currency: "CNY", totalBalance: "10.00", grantedBalance: "0.00", toppedUpBalance: "10.00" },
  ]);
  assert.deepEqual(provider.roles, [{ role: "vision_fallback", model: "deepseek-chat" }]);
  assert.equal(headerOf(calls[0]!.init, "authorization"), "Bearer sk-deepseek-secret-key-123");
  const text = formatQuotaReport(report);
  assert.ok(text.includes("余额可用：是"));
  assert.ok(text.includes("余额 CNY：总 10.00（充值 10.00 / 赠送 0.00）"));
  assert.ok(!JSON.stringify(report).includes("sk-deepseek-secret-key-123"));
});

// ---------- ZAI Coding Plan ----------

test("zai-coding-cn：5小时/1周额度、剩余百分比与重置时间、level", async () => {
  const paths = scratch(
    { "zai-coding-cn": { api: "openai-completions", baseUrl: "https://open.bigmodel.cn/api/coding/paas/v4", models: [] } },
    { vision: { provider: "zai-coding-cn", model: "glm-5.4" } },
    { "zai-coding-cn": { key: "zai-key-secret-abc" } },
  );
  const { impl, calls } = fakeFetch((url) => {
    assert.equal(url, "https://open.bigmodel.cn/api/monitor/usage/quota/limit");
    return jsonRes(ZAI_PAYLOAD);
  });
  const report = await queryQuotas({ ...paths, fetchImpl: impl });
  const provider = report.providers[0]!;
  assert.equal(provider.status, "ok");
  assert.equal(provider.kind, "zai");
  assert.equal(provider.plan, "max");
  const [hourly, weekly] = provider.buckets!;
  assert.equal(hourly!.label, "5小时窗口");
  assert.equal(hourly!.remaining, 27376);
  assert.equal(hourly!.total, 28000);
  assert.equal(hourly!.remainingPercent, 97.8);
  assert.equal(hourly!.usedPercent, 2);
  assert.equal(hourly!.resetAt, 1795626148037);
  assert.equal(weekly!.label, "1周窗口");
  assert.equal(weekly!.remainingPercent, 72.5);
  assert.equal(weekly!.usedPercent, 27);
  assert.equal(calls.length, 1);
  const text = formatQuotaReport(report);
  assert.ok(text.includes("5小时窗口：剩余 97.8% · 已用 2% · 剩余量 27376/28000"));
  assert.ok(text.includes(`重置 ${formatLocalTime(1795626148037)}`));
});

test("zai：未知 unit 显示 unit=N×M；code 非 200 报 error", async () => {
  const paths = scratch(
    { "zai-coding-cn": { baseUrl: "https://open.bigmodel.cn/api/coding/paas/v4", models: [] } },
    {},
    { "zai-coding-cn": "zai-key-secret-abc" },
  );
  const odd = await queryQuotas({
    ...paths,
    fetchImpl: fakeFetch(() =>
      jsonRes({ code: 200, success: true, data: { limits: [{ unit: 9, number: 2, usage: 100, remaining: 40, percentage: 60 }] } }),
    ).impl,
  });
  assert.equal(odd.providers[0]!.buckets![0]!.label, "unit=9×2");
  assert.equal(odd.providers[0]!.buckets![0]!.remainingPercent, 40);
  const bad = await queryQuotas({
    ...paths,
    fetchImpl: fakeFetch(() => jsonRes({ code: 401, msg: "invalid key" })).impl,
  });
  assert.equal(bad.providers[0]!.status, "error");
  assert.ok(bad.providers[0]!.message!.includes("code=401"));
});

// ---------- unsupported / unconfigured / 过滤 / 代理 ----------

test("CLIProxyAPI 与历史订阅制 provider 均标 unsupported 且不发请求", async () => {
  const paths = scratch(
    {
      "cliproxyapi-codex": { api: "openai-responses", baseUrl: "http://cliproxyapi:8317/v1", models: [] },
      "cliproxyapi-gemini": { api: "google-generative-ai", baseUrl: "http://cliproxyapi:8317/v1beta", models: [] },
      "google-antigravity": { api: "antigravity-code-assist", models: [] },
      "openai-codex": { api: "openai-codex-responses", models: [] },
    },
    { main: { provider: "cliproxyapi-codex", model: "gpt-5.4" } },
    {
      "cliproxyapi-codex": "local",
      "google-antigravity": { type: "oauth", access: "ag-access", refresh: "ag-refresh", expires: Date.now() + 3600_000 },
      "openai-codex": { type: "oauth", access: "cx-access", refresh: "cx-refresh", expires: Date.now() + 3600_000 },
    },
  );
  const { impl, calls } = fakeFetch(() => {
    throw new Error("不应发起请求");
  });
  const report = await queryQuotas({ ...paths, fetchImpl: impl });
  assert.equal(calls.length, 0);
  for (const provider of report.providers) {
    assert.equal(provider.status, "unsupported");
    assert.ok(provider.message?.includes("CLIProxyAPI"));
  }
  const codex = report.providers.find((provider) => provider.providerId === "cliproxyapi-codex")!;
  assert.deepEqual(codex.roles, [{ role: "main", model: "gpt-5.4" }]);
});

test("unsupported 与 unconfigured 不发请求；残留 oauth 条目统一报缺 API key；provider 过滤精确匹配", async () => {
  const paths = scratch(
    {
      "qwen-token-plan-cn": { api: "openai-completions", baseUrl: "https://example.com/v1", models: [] },
      deepseek: { api: "openai-completions", baseUrl: "https://api.deepseek.com", models: [] },
      "zai-coding-cn": { api: "openai-completions", baseUrl: "https://open.bigmodel.cn/api/coding/paas/v4", models: [] },
    },
    { main: { provider: "qwen-token-plan-cn", model: "qwen-audio-3.0-tts-plus" } },
    {
      "qwen-token-plan-cn": { key: "qwen-key" },
      "zai-coding-cn": { type: "oauth", access: "legacy-oauth-access", refresh: "legacy-oauth-refresh", expires: Date.now() + 3600_000 },
    },
  );
  const { impl, calls } = fakeFetch(() => {
    throw new Error("不应发起请求");
  });
  const report = await queryQuotas({ ...paths, fetchImpl: impl });
  assert.equal(calls.length, 0);
  const qwen = report.providers.find((provider) => provider.providerId === "qwen-token-plan-cn")!;
  const deepseek = report.providers.find((provider) => provider.providerId === "deepseek")!;
  const zai = report.providers.find((provider) => provider.providerId === "zai-coding-cn")!;
  assert.equal(qwen.status, "unsupported");
  assert.ok(qwen.message!.includes("暂无公开额度查询接口"));
  assert.deepEqual(qwen.roles, [{ role: "main", model: "qwen-audio-3.0-tts-plus" }]);
  assert.equal(deepseek.status, "unconfigured");
  assert.equal(deepseek.message, "未配置 API key（config/auth.json 缺该 provider 的有效 key）");
  assert.equal(zai.status, "unconfigured");
  assert.equal(zai.message, "未配置 API key（config/auth.json 缺该 provider 的有效 key）");

  const filtered = await queryQuotas({ ...paths, fetchImpl: impl, providerFilter: "qwen-token-plan-cn" });
  assert.deepEqual(filtered.providers.map((provider) => provider.providerId), ["qwen-token-plan-cn"]);

  const missing = await queryQuotas({ ...paths, fetchImpl: impl, providerFilter: "nope" });
  assert.deepEqual(missing.providers, []);
  assert.deepEqual(missing.filterError, { filter: "nope", available: ["qwen-token-plan-cn", "deepseek", "zai-coding-cn"] });
  assert.ok(formatQuotaReport(missing).includes("未找到 provider「nope」"));
});

test("非法 proxy 回落直连（注入 fetch 仍被使用）", async () => {
  const paths = scratch(
    { deepseek: { baseUrl: "https://api.deepseek.com", proxy: "socks5://127.0.0.1:1080", models: [] } },
    {},
    { deepseek: { key: "sk-deepseek-secret-key-123" } },
  );
  const { impl, calls } = fakeFetch(() => jsonRes({ is_available: true, balance_infos: [] }));
  const report = await queryQuotas({ ...paths, fetchImpl: impl });
  assert.equal(report.providers[0]!.status, "ok");
  assert.equal(calls.length, 1);
});

// ---------- 错误脱敏与不阻断 ----------

test("HTTP 500 与网络异常：脱敏后标 error，不阻断其它 provider", async () => {
  const paths = scratch(
    {
      deepseek: { baseUrl: "https://api.deepseek.com", models: [] },
      "zai-coding-cn": { baseUrl: "https://open.bigmodel.cn/api/coding/paas/v4", models: [] },
    },
    {},
    { deepseek: { key: "sk-deepseek-secret-key-123" }, "zai-coding-cn": { key: "zai-key-secret-abc" } },
  );
  const { impl } = fakeFetch((url) => {
    if (url.includes("deepseek")) {
      return new Response("upstream rejected key sk-deepseek-secret-key-123 via Bearer abc.def.ghi", { status: 500 });
    }
    return jsonRes(ZAI_PAYLOAD);
  });
  const report = await queryQuotas({ ...paths, fetchImpl: impl });
  const deepseek = report.providers.find((provider) => provider.providerId === "deepseek")!;
  const zai = report.providers.find((provider) => provider.providerId === "zai-coding-cn")!;
  assert.equal(deepseek.status, "error");
  assert.ok(!deepseek.message!.includes("sk-deepseek-secret-key-123"));
  assert.ok(!deepseek.message!.includes("abc.def.ghi"));
  assert.ok(deepseek.message!.includes("***"));
  assert.equal(zai.status, "ok");

  const netPaths = scratch(
    { deepseek: { baseUrl: "https://api.deepseek.com", models: [] } },
    {},
    { deepseek: { key: "sk-deepseek-secret-key-123" } },
  );
  const net = await queryQuotas({
    ...netPaths,
    fetchImpl: async () => {
      throw new Error("connect failed with key sk-deepseek-secret-key-123");
    },
  });
  assert.equal(net.providers[0]!.status, "error");
  assert.ok(!net.providers[0]!.message!.includes("sk-deepseek-secret-key-123"));
});

test("redactSecrets：已知字面量 + Bearer/sk-/JSON 引号键值形态", () => {
  const text = 'token=abc123456 Bearer ya29.a0AfB_x sk-liveabcdef123456 {"refresh_token": "rt-secret-999", "client_secret":"cs-888"}';
  const out = redactSecrets(text, ["abc123456"]);
  assert.ok(!out.includes("abc123456"));
  assert.ok(!out.includes("ya29.a0AfB_x"));
  assert.ok(!out.includes("sk-liveabcdef123456"));
  assert.ok(!out.includes("rt-secret-999"));
  assert.ok(!out.includes("cs-888"));
});

// ---------- CLI 退出码 ----------

function cliScratch(providers: Record<string, unknown>, credentials?: Record<string, unknown>) {
  const dir = mkdtempSync(join(tmpdir(), "fish-quota-cli-"));
  mkdirSync(join(dir, "config"));
  writeFileSync(join(dir, "config", "models.json"), JSON.stringify({ models: {}, providers }));
  if (credentials) writeFileSync(join(dir, "config", "auth.json"), JSON.stringify(credentials), { mode: 0o600 });
  return dir;
}

function runCli(root: string, args: string[]) {
  return spawnSync(process.execPath, [QUOTA_CLI, ...args], {
    env: { ...process.env, YUGANG_ROOT: root },
    encoding: "utf8",
    timeout: 30_000,
  });
}

test("CLI：--help 退出 0（无 --no-refresh）；unsupported/unconfigured 退出 0；--json 可解析且无敏感字段", () => {
  const root = cliScratch(
    { "qwen-token-plan-cn": { api: "openai-completions", baseUrl: "https://example.com/v1", models: [] } },
    { "qwen-token-plan-cn": { key: "qwen-secret-key-xyz" } },
  );
  const help = runCli(root, ["--help"]);
  assert.equal(help.status, 0);
  assert.ok(help.stdout.includes("用法"));
  assert.ok(!help.stdout.includes("--no-refresh"));
  assert.ok(help.stdout.includes("deepseek / zai-coding-cn"));

  const plain = runCli(root, []);
  assert.equal(plain.status, 0);
  assert.ok(plain.stdout.includes("unsupported"));

  const json = runCli(root, ["--json"]);
  assert.equal(json.status, 0);
  const report = JSON.parse(json.stdout);
  assert.equal(report.providers[0].providerId, "qwen-token-plan-cn");
  assert.ok(!json.stdout.includes("qwen-secret-key-xyz"));
});

test("CLI：不存在的 provider 退出 1 且 stderr 带已配置列表；查询 error 退出 1 仍输出完整报告", () => {
  const root = cliScratch(
    { deepseek: { api: "openai-completions", baseUrl: "http://127.0.0.1:9", models: [] } },
    { deepseek: { key: "sk-deepseek-secret-key-123" } },
  );
  const missing = runCli(root, ["nope"]);
  assert.equal(missing.status, 1);
  assert.ok(missing.stderr.includes("nope"));
  assert.ok(missing.stderr.includes("deepseek"));

  const failed = runCli(root, ["--json"]);
  assert.equal(failed.status, 1);
  const report = JSON.parse(failed.stdout);
  assert.equal(report.providers[0].status, "error");
  assert.ok(!failed.stdout.includes("sk-deepseek-secret-key-123"));
});

test("凭据文件缺失时全部标 unconfigured，不崩溃", async () => {
  const paths = scratch({ deepseek: { baseUrl: "https://api.deepseek.com", models: [] } });
  assert.ok(!existsSync(paths.credentialsPath));
  const report = await queryQuotas({
    ...paths,
    fetchImpl: async () => {
      throw new Error("不应发起请求");
    },
  });
  assert.equal(report.providers[0]!.status, "unconfigured");
});

test("queryQuotas：所有 fetchImpl 调用均附带超时 AbortSignal", async () => {
  const paths = scratch(
    { deepseek: { baseUrl: "https://api.deepseek.com", models: [] } },
    {},
    { deepseek: { key: "sk-deepseek-secret-key-123" } },
  );
  let sawSignal: AbortSignal | undefined;
  await queryQuotas({
    ...paths,
    fetchImpl: async (_input, init) => {
      sawSignal = init?.signal ?? undefined;
      return jsonRes({ is_available: true, balance_infos: [] });
    },
  });
  assert.ok(sawSignal instanceof AbortSignal, "quota fetchImpl 必须注入超时 AbortSignal");
});

test("auth.json 损坏时仅将该 provider 标为 error 而不打崩整批 queryQuotas", async () => {
  const paths = scratch({
    deepseek: { baseUrl: "https://api.deepseek.com", models: [] },
    "qwen-token-plan-cn": { api: "openai-completions", baseUrl: "https://example.com/v1", models: [] },
  });
  writeFileSync(paths.credentialsPath, '{"deepseek": sk-secret-corrupt-value', { mode: 0o600 });
  const report = await queryQuotas({
    ...paths,
    fetchImpl: async () => {
      throw new Error("不应发起请求");
    },
  });
  const deepseek = report.providers.find((p) => p.providerId === "deepseek")!;
  const qwen = report.providers.find((p) => p.providerId === "qwen-token-plan-cn")!;
  assert.equal(deepseek.status, "error");
  assert.ok(!deepseek.message?.includes("sk-secret-corrupt-value"), "损坏凭据报错不得泄露原文");
  assert.equal(qwen.status, "unsupported");
});
