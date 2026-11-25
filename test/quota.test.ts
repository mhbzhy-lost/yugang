/**
 * provider 额度查询（src/model/quota.ts + scripts/quota.ts）的兜底测试：
 * 四类 provider 解析与格式化、桶折叠、baseUrl/userAgent 透传、unsupported/unconfigured、
 * 错误脱敏与不阻断、OAuth 锁内刷新/并发防重刷/refresh_token 轮换回写、--no-refresh 不写盘、
 * 角色标注与过滤、JSON 不含敏感字段、CLI 退出码。
 */

import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
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

const AG_LOAD = {
  currentTier: { id: "free-tier", name: "Free" },
  paidTier: { id: "g1-pro-tier", name: "Google AI Pro" },
  cloudaicompanionProject: { id: "proj-42" },
};

const AG_MODELS = {
  models: {
    "claude-sonnet-5-5-medium": { quotaInfo: { remainingFraction: 0.875, resetTime: "2026-11-25T18:00:00Z" } },
    "claude-opus-4-6": { quotaInfo: { remainingFraction: 0.875, resetTime: "2026-11-25T18:00:00Z" } },
    "gemini-4-pro-high": { quotaInfo: { remainingFraction: 0.5, resetTime: "2026-11-26T00:00:00Z" } },
    "gemini-4-flash": { quotaInfo: { remainingFraction: 0.5, resetTime: "2026-11-26T00:00:00Z" } },
    "no-quota-model": {},
  },
};

function agCredential(extra: Record<string, unknown> = {}) {
  return {
    type: "oauth",
    access: "ag-access-token-secret",
    refresh: "ag-refresh-token-secret",
    expires: Date.now() + 3600_000,
    clientId: "ag-client-id-123456",
    clientSecret: "ag-client-secret-123456",
    projectId: "proj-1",
    ...extra,
  };
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

const CODEX_PAYLOAD = {
  plan_type: "plus",
  rate_limit: {
    primary_window: { used_percent: 20, limit_window_seconds: 18000, resets_at: 1795626148 },
    secondary_window: { used_percent: 45, limit_window_seconds: 604800, resets_at: 1795897474 },
  },
  additional_rate_limits: [{ used_percent: 10, limit_window_seconds: 3600, resets_at: 1795626200 }],
  credits: { balance: "12.5" },
};

// ---------- Antigravity ----------

test("antigravity：自定义 baseUrl/userAgent 透传、paidTier 保留、配额按桶折叠、角色标注", async () => {
  const paths = scratch(
    {
      "google-antigravity": {
        api: "antigravity-code-assist",
        baseUrl: "https://daily-cloudcode-pa.sandbox.googleapis.com/",
        userAgent: "custom-ua/1.0",
        models: [],
      },
    },
    { main: { provider: "google-antigravity", model: "claude-sonnet-5-5-medium" } },
    { "google-antigravity": agCredential() },
  );
  const { impl, calls } = fakeFetch((url, init) => {
    if (url.endsWith("/v1internal:loadCodeAssist")) return jsonRes(AG_LOAD);
    if (url.endsWith("/v1internal:fetchAvailableModels")) {
      assert.equal(JSON.parse(String(init?.body)).project, "proj-42");
      return jsonRes(AG_MODELS);
    }
    throw new Error(`意外请求 ${url}`);
  });
  const report = await queryQuotas({ ...paths, fetchImpl: impl });
  const provider = report.providers[0]!;
  assert.equal(provider.status, "ok");
  assert.equal(provider.kind, "antigravity");
  assert.deepEqual(provider.roles, [{ role: "main", model: "claude-sonnet-5-5-medium" }]);
  assert.deepEqual(provider.paidTier, { id: "g1-pro-tier", name: "Google AI Pro" });
  assert.deepEqual(provider.currentTier, { id: "free-tier", name: "Free" });
  assert.equal(provider.projectId, "proj-42");
  // 严格用配置的 baseUrl（去尾斜杠），不落到默认 daily 非 sandbox 桶
  assert.equal(calls.length, 2);
  for (const call of calls) {
    assert.ok(call.url.startsWith("https://daily-cloudcode-pa.sandbox.googleapis.com/v1internal:"));
    assert.equal(headerOf(call.init, "user-agent"), "custom-ua/1.0");
    assert.equal(headerOf(call.init, "authorization"), "Bearer ag-access-token-secret");
  }
  // 4 个带 quotaInfo 的模型折叠成 2 桶；无 quotaInfo 的不进桶
  assert.equal(provider.buckets!.length, 2);
  const claude = provider.buckets!.find((bucket) => bucket.family === "Claude")!;
  const gemini = provider.buckets!.find((bucket) => bucket.family === "Gemini")!;
  assert.deepEqual(claude.models, ["claude-sonnet-5-5-medium", "claude-opus-4-6"]);
  assert.equal(claude.remainingPercent, 87.5);
  assert.equal(claude.resetAt, Date.parse("2026-11-25T18:00:00Z"));
  assert.equal(gemini.remainingPercent, 50);
  assert.deepEqual(gemini.models, ["gemini-4-pro-high", "gemini-4-flash"]);
  // 格式化：中文、剩余百分比、本地时区重置时间
  const text = formatQuotaReport(report);
  assert.ok(text.includes("[google-antigravity] ok"));
  assert.ok(text.includes("main: claude-sonnet-5-5-medium"));
  assert.ok(text.includes("Claude 配额：剩余 87.5%"));
  assert.ok(text.includes(`重置 ${formatLocalTime(Date.parse("2026-11-25T18:00:00Z"))}`));
  assert.ok(text.includes("paid=Google AI Pro(g1-pro-tier)"));
  // JSON 不含任何凭据字段
  const json = JSON.stringify(report);
  for (const secret of ["ag-access-token-secret", "ag-refresh-token-secret", "ag-client-secret-123456"]) {
    assert.ok(!json.includes(secret), `JSON 泄漏 ${secret}`);
  }
});

test("antigravity：未配 baseUrl 时用默认 daily 端点；缺 project 走 discoverProject 兜底", async () => {
  const paths = scratch(
    { "google-antigravity": { api: "antigravity-code-assist", models: [] } },
    {},
    { "google-antigravity": agCredential({ projectId: undefined }) },
  );
  const { impl, calls } = fakeFetch((url) => {
    if (url.endsWith("/v1internal:loadCodeAssist")) return jsonRes({ currentTier: { id: "free-tier" } });
    if (url.endsWith("/v1internal:onboardUser")) return jsonRes({ done: true });
    if (url.endsWith("/v1internal:fetchAvailableModels")) return jsonRes(AG_MODELS);
    throw new Error(`意外请求 ${url}`);
  });
  const report = await queryQuotas({ ...paths, fetchImpl: impl });
  // loadCodeAssist 无 project → discoverProject 再 load 一次仍无 → onboardUser(done) → load
  assert.ok(calls.every((call) => call.url.startsWith("https://daily-cloudcode-pa.googleapis.com/")));
  // onboard 后仍拿不到 project → 明确 error，不静默
  assert.equal(report.providers[0]!.status, "error");
  assert.ok(report.providers[0]!.message!.includes("project"));
});

// ---------- OpenAI Codex ----------

test("codex：wham/usage 窗口解析、accountId 头、plan 与 credits", async () => {
  const paths = scratch(
    { "openai-codex": { api: "openai-codex-responses", baseUrl: "https://chatgpt.com/backend-api/codex/", models: [] } },
    {},
    {
      "openai-codex": {
        type: "oauth",
        access: "cx-access-secret",
        refresh: "cx-refresh-secret",
        expires: Date.now() + 3600_000,
        accountId: "acct-123",
      },
    },
  );
  const { impl, calls } = fakeFetch((url) => {
    assert.equal(url, "https://chatgpt.com/backend-api/wham/usage");
    return jsonRes(CODEX_PAYLOAD);
  });
  const report = await queryQuotas({ ...paths, fetchImpl: impl });
  const provider = report.providers[0]!;
  assert.equal(provider.status, "ok");
  assert.equal(provider.plan, "plus");
  assert.equal(provider.accountId, "acct-123");
  assert.equal(provider.credits, "12.5");
  assert.equal(headerOf(calls[0]!.init, "chatgpt-account-id"), "acct-123");
  assert.equal(headerOf(calls[0]!.init, "user-agent"), "codex-cli");
  assert.equal(headerOf(calls[0]!.init, "authorization"), "Bearer cx-access-secret");
  const [primary, secondary, extra] = provider.buckets!;
  assert.equal(primary!.label, "5h 窗口");
  assert.equal(primary!.remainingPercent, 80);
  assert.equal(primary!.usedPercent, 20);
  assert.equal(primary!.windowSeconds, 18000);
  assert.equal(primary!.resetAt, 1795626148000);
  assert.equal(secondary!.label, "7d 窗口");
  assert.equal(secondary!.remainingPercent, 55);
  assert.equal(extra!.label, "附加 1h 窗口");
  const text = formatQuotaReport(report);
  assert.ok(text.includes("5h 窗口：剩余 80% · 已用 20%"));
  assert.ok(text.includes("套餐：plus"));
});

test("codex：凭据缺 accountId 时从 access JWT 的 auth claim 解", async () => {
  const payload = Buffer.from(
    JSON.stringify({ "https://api.openai.com/auth": { chatgpt_account_id: "acct-jwt" } }),
  ).toString("base64url");
  const paths = scratch(
    { "openai-codex": { api: "openai-codex-responses", models: [] } },
    {},
    {
      "openai-codex": {
        type: "oauth",
        access: `eyJhbGciOiJSUzI1NiJ9.${payload}.sig`,
        refresh: "cx-refresh",
        expires: Date.now() + 3600_000,
      },
    },
  );
  const { impl, calls } = fakeFetch(() => jsonRes(CODEX_PAYLOAD));
  const report = await queryQuotas({ ...paths, fetchImpl: impl });
  assert.equal(report.providers[0]!.accountId, "acct-jwt");
  assert.equal(headerOf(calls[0]!.init, "chatgpt-account-id"), "acct-jwt");
});

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
  assert.equal(provider.available, true);
  assert.deepEqual(provider.balances, [
    { currency: "CNY", totalBalance: "10.00", grantedBalance: "0.00", toppedUpBalance: "10.00" },
  ]);
  assert.deepEqual(provider.roles, [{ role: "vision_fallback", model: "deepseek-chat" }]);
  assert.equal(headerOf(calls[0]!.init, "authorization"), "Bearer sk-deepseek-secret-key-123");
  const text = formatQuotaReport(report);
  assert.ok(text.includes("余额可用：是"));
  assert.ok(text.includes("余额 CNY：总 10.00（充值 10.00 / 赠送 0.00）"));
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

test("unsupported 与 unconfigured 不发请求；provider 过滤精确匹配，不存在给列表", async () => {
  const paths = scratch(
    {
      "qwen-token-plan-cn": { api: "openai-completions", baseUrl: "https://example.com/v1", models: [] },
      deepseek: { api: "openai-completions", baseUrl: "https://api.deepseek.com", models: [] },
    },
    { main: { provider: "qwen-token-plan-cn", model: "qwen-audio-3.0-tts-plus" } },
    { "qwen-token-plan-cn": { key: "qwen-key" } },
  );
  const { impl, calls } = fakeFetch(() => {
    throw new Error("不应发起请求");
  });
  const report = await queryQuotas({ ...paths, fetchImpl: impl });
  assert.equal(calls.length, 0);
  const qwen = report.providers.find((provider) => provider.providerId === "qwen-token-plan-cn")!;
  const deepseek = report.providers.find((provider) => provider.providerId === "deepseek")!;
  assert.equal(qwen.status, "unsupported");
  assert.ok(qwen.message!.includes("暂无公开额度查询接口"));
  assert.deepEqual(qwen.roles, [{ role: "main", model: "qwen-audio-3.0-tts-plus" }]);
  assert.equal(deepseek.status, "unconfigured");

  const filtered = await queryQuotas({ ...paths, fetchImpl: impl, providerFilter: "qwen-token-plan-cn" });
  assert.deepEqual(filtered.providers.map((provider) => provider.providerId), ["qwen-token-plan-cn"]);

  const missing = await queryQuotas({ ...paths, fetchImpl: impl, providerFilter: "nope" });
  assert.deepEqual(missing.providers, []);
  assert.deepEqual(missing.filterError, { filter: "nope", available: ["qwen-token-plan-cn", "deepseek"] });
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

test("redactSecrets：已知字面量 + Bearer/sk- 通用形态", () => {
  const text = "token=abc123456 Bearer ya29.a0AfB_x sk-liveabcdef123456";
  const out = redactSecrets(text, ["abc123456"]);
  assert.ok(!out.includes("abc123456"));
  assert.ok(!out.includes("ya29.a0AfB_x"));
  assert.ok(!out.includes("sk-liveabcdef123456"));
});

// ---------- OAuth 刷新 ----------

test("google OAuth 过期：锁内刷新并原子回写，保留 projectId 与 refresh", async () => {
  const paths = scratch(
    { "google-antigravity": { api: "antigravity-code-assist", models: [] } },
    {},
    { "google-antigravity": agCredential({ expires: Date.now() - 1000 }) },
  );
  let tokenCalls = 0;
  const { impl } = fakeFetch((url, init) => {
    if (url === "https://oauth2.googleapis.com/token") {
      tokenCalls++;
      assert.equal(init?.method, "POST");
      assert.ok(String(init?.body).includes("grant_type=refresh_token"));
      assert.ok(String(init?.body).includes("refresh_token=ag-refresh-token-secret"));
      return jsonRes({ access_token: "new-ag-access-token", expires_in: 3600, token_type: "Bearer" });
    }
    if (url.endsWith("/v1internal:loadCodeAssist")) {
      assert.equal(headerOf(init, "authorization"), "Bearer new-ag-access-token");
      return jsonRes(AG_LOAD);
    }
    if (url.endsWith("/v1internal:fetchAvailableModels")) return jsonRes(AG_MODELS);
    throw new Error(`意外请求 ${url}`);
  });
  const report = await queryQuotas({ ...paths, fetchImpl: impl });
  assert.equal(tokenCalls, 1);
  const provider = report.providers[0]!;
  assert.equal(provider.status, "ok");
  assert.equal(provider.refreshed, true);
  const stored = JSON.parse(readFileSync(paths.credentialsPath, "utf8"))["google-antigravity"];
  assert.equal(stored.access, "new-ag-access-token");
  assert.equal(stored.refresh, "ag-refresh-token-secret");
  assert.equal(stored.projectId, "proj-1");
  assert.ok(stored.expires > Date.now());
  const json = JSON.stringify(report);
  for (const secret of ["ag-access-token-secret", "new-ag-access-token", "ag-refresh-token-secret", "ag-client-secret-123456"]) {
    assert.ok(!json.includes(secret), `JSON 泄漏 ${secret}`);
  }
});

test("并发查询同一过期凭据：文件锁内复查，只刷新一次", async () => {
  const paths = scratch(
    { "google-antigravity": { api: "antigravity-code-assist", models: [] } },
    {},
    { "google-antigravity": agCredential({ expires: Date.now() - 1000 }) },
  );
  let tokenCalls = 0;
  const { impl } = fakeFetch((url) => {
    if (url === "https://oauth2.googleapis.com/token") {
      tokenCalls++;
      return jsonRes({ access_token: "new-ag-access-token", expires_in: 3600 });
    }
    if (url.endsWith("/v1internal:loadCodeAssist")) return jsonRes(AG_LOAD);
    if (url.endsWith("/v1internal:fetchAvailableModels")) return jsonRes(AG_MODELS);
    throw new Error(`意外请求 ${url}`);
  });
  const [first, second] = await Promise.all([
    queryQuotas({ ...paths, fetchImpl: impl }),
    queryQuotas({ ...paths, fetchImpl: impl }),
  ]);
  assert.equal(tokenCalls, 1);
  assert.equal(first.providers[0]!.status, "ok");
  assert.equal(second.providers[0]!.status, "ok");
});

test("openai refresh_token 轮换：锁内回写新 refresh，不丢 token", async () => {
  const paths = scratch(
    { "openai-codex": { api: "openai-codex-responses", models: [] } },
    {},
    {
      "openai-codex": {
        type: "oauth",
        access: "old-cx-access-token",
        refresh: "old-cx-refresh-token",
        expires: Date.now() - 1000,
      },
    },
  );
  const { impl } = fakeFetch((url, init) => {
    if (url === "https://auth.openai.com/oauth/token") {
      assert.ok(String(init?.body).includes("refresh_token=old-cx-refresh-token"));
      return jsonRes({ access_token: "new-cx-access-token", refresh_token: "rotated-cx-refresh-token", expires_in: 3600 });
    }
    if (url.endsWith("/wham/usage")) {
      assert.equal(headerOf(init, "authorization"), "Bearer new-cx-access-token");
      return jsonRes(CODEX_PAYLOAD);
    }
    throw new Error(`意外请求 ${url}`);
  });
  const report = await queryQuotas({ ...paths, fetchImpl: impl });
  assert.equal(report.providers[0]!.status, "ok");
  assert.equal(report.providers[0]!.refreshed, true);
  const stored = JSON.parse(readFileSync(paths.credentialsPath, "utf8"))["openai-codex"];
  assert.equal(stored.access, "new-cx-access-token");
  assert.equal(stored.refresh, "rotated-cx-refresh-token");
});

test("--no-refresh：过期凭据不刷新不写盘，报明确过期状态", async () => {
  const paths = scratch(
    { "google-antigravity": { api: "antigravity-code-assist", models: [] } },
    {},
    { "google-antigravity": agCredential({ expires: Date.now() - 1000 }) },
  );
  const before = readFileSync(paths.credentialsPath, "utf8");
  const { impl, calls } = fakeFetch(() => {
    throw new Error("no-refresh 不应发起任何请求");
  });
  const report = await queryQuotas({ ...paths, fetchImpl: impl, noRefresh: true });
  assert.equal(calls.length, 0);
  assert.equal(report.providers[0]!.status, "expired");
  assert.ok(report.providers[0]!.message!.includes("--no-refresh"));
  assert.equal(readFileSync(paths.credentialsPath, "utf8"), before);
});

test("401：允许刷新时锁内强刷一次并重试成功", async () => {
  const paths = scratch(
    { "google-antigravity": { api: "antigravity-code-assist", models: [] } },
    {},
    { "google-antigravity": agCredential() },
  );
  let tokenCalls = 0;
  const { impl } = fakeFetch((url, init) => {
    if (url === "https://oauth2.googleapis.com/token") {
      tokenCalls++;
      return jsonRes({ access_token: "new-ag-access-token", expires_in: 3600 });
    }
    if (url.endsWith("/v1internal:loadCodeAssist")) {
      if (headerOf(init, "authorization") === "Bearer ag-access-token-secret") {
        return new Response("Unauthorized", { status: 401 });
      }
      return jsonRes(AG_LOAD);
    }
    if (url.endsWith("/v1internal:fetchAvailableModels")) return jsonRes(AG_MODELS);
    throw new Error(`意外请求 ${url}`);
  });
  const report = await queryQuotas({ ...paths, fetchImpl: impl });
  assert.equal(tokenCalls, 1);
  assert.equal(report.providers[0]!.status, "ok");
  assert.equal(report.providers[0]!.refreshed, true);
});

test("401 + --no-refresh：不刷新，报过期并提示 --no-refresh", async () => {
  const paths = scratch(
    { "google-antigravity": { api: "antigravity-code-assist", models: [] } },
    {},
    { "google-antigravity": agCredential() },
  );
  const { impl, calls } = fakeFetch((url) => {
    if (url.endsWith("/v1internal:loadCodeAssist")) return new Response("Unauthorized", { status: 401 });
    throw new Error(`no-refresh 不应请求 ${url}`);
  });
  const report = await queryQuotas({ ...paths, fetchImpl: impl, noRefresh: true });
  assert.equal(calls.length, 1);
  assert.equal(report.providers[0]!.status, "expired");
  assert.ok(report.providers[0]!.message!.includes("401"));
  assert.ok(report.providers[0]!.message!.includes("--no-refresh"));
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

test("CLI：--help 退出 0；unsupported/unconfigured 退出 0；--json 可解析且无敏感字段", () => {
  const root = cliScratch(
    { "qwen-token-plan-cn": { api: "openai-completions", baseUrl: "https://example.com/v1", models: [] } },
    { "qwen-token-plan-cn": { key: "qwen-secret-key-xyz" } },
  );
  const help = runCli(root, ["--help"]);
  assert.equal(help.status, 0);
  assert.ok(help.stdout.includes("用法"));

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