/**
 * OpenAI ChatGPT（Codex）OAuth：设备码登录 + refresh + 请求凭据派生。
 *
 * 为什么自己写：pi-ai 的 OAuth 实现只以 bundle 形式存在于 pi 自身，包导出表里
 * 没有 auth/oauth 子路径，鱼不能依赖它；协议本身很小（三个端点），写在这里可审查。
 *
 * 凭据形状：{ type:"oauth", access, refresh, expires, accountId }
 *  - access 就是请求用的 bearer token，accountId 只是给人看，请求头由 API 层从 JWT 里取
 *  - refresh 换新 token，pi-ai 在请求路径上按 expires 判断并回写 config/auth.json
 */
import type { OAuthCredential } from "../credential-store.ts";

const CLIENT_ID = "app_EMoamEEZ73f0CkXaXp7hrann";
const AUTH_BASE = "https://auth.openai.com";
const TOKEN_URL = `${AUTH_BASE}/oauth/token`;
const DEVICE_USER_CODE_URL = `${AUTH_BASE}/api/accounts/deviceauth/usercode`;
const DEVICE_TOKEN_URL = `${AUTH_BASE}/api/accounts/deviceauth/token`;
const DEVICE_REDIRECT_URI = `${AUTH_BASE}/deviceauth/callback`;
const DEVICE_VERIFICATION_URI = `${AUTH_BASE}/codex/device`;
const DEVICE_TIMEOUT_MS = 15 * 60 * 1000;
const JWT_CLAIM_PATH = "https://api.openai.com/auth";

/** 登录交互：只用到 notify（把设备码/链接给用户）。 */
export interface LoginInteraction {
  signal?: AbortSignal;
  prompt(prompt: { type: "text" | "secret" | "select" | "manual_code"; message: string; options?: readonly { id: string; label: string }[] }): Promise<string>;
  notify(event: { type: string; [key: string]: unknown }): void;
}

function decodeJwt(token: string): Record<string, unknown> | null {
  try {
    const parts = token.split(".");
    if (parts.length !== 3) return null;
    return JSON.parse(Buffer.from(parts[1] ?? "", "base64url").toString("utf8")) as Record<string, unknown>;
  } catch {
    return null;
  }
}

function accountIdOf(access: string): string | undefined {
  const claims = decodeJwt(access)?.[JWT_CLAIM_PATH] as Record<string, unknown> | undefined;
  const id = claims?.["chatgpt_account_id"];
  return typeof id === "string" && id.length > 0 ? id : undefined;
}

interface TokenResponse {
  access_token?: string;
  refresh_token?: string;
  expires_in?: number;
}

async function readTokens(response: Response, operation: string): Promise<{ access: string; refresh: string; expires: number }> {
  if (!response.ok) {
    const text = await response.text().catch(() => "");
    throw new Error(`OpenAI token ${operation} 失败 (${response.status}): ${text.slice(0, 200)}`);
  }
  const json = (await response.json()) as TokenResponse;
  if (!json.access_token || !json.refresh_token || typeof json.expires_in !== "number") {
    throw new Error(`OpenAI token ${operation} 响应缺字段`);
  }
  return { access: json.access_token, refresh: json.refresh_token, expires: Date.now() + json.expires_in * 1000 };
}

function toCredential(tokens: { access: string; refresh: string; expires: number }): OAuthCredential {
  const accountId = accountIdOf(tokens.access);
  return { type: "oauth", access: tokens.access, refresh: tokens.refresh, expires: tokens.expires, ...(accountId ? { accountId } : {}) };
}

/** 设备码登录（无头可用）：先 notify 设备码，再轮询到授权完成。 */
export async function loginWithDeviceCode(interaction: LoginInteraction): Promise<OAuthCredential> {
  const signal = interaction.signal ?? new AbortController().signal;
  const started = await fetch(DEVICE_USER_CODE_URL, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ client_id: CLIENT_ID }),
    signal,
  });
  if (!started.ok) throw new Error(`申请设备码失败 (${started.status})`);
  const device = (await started.json()) as { device_auth_id?: string; user_code?: string; interval?: number | string };
  const deviceAuthId = device.device_auth_id;
  const userCode = device.user_code;
  if (!deviceAuthId || !userCode) throw new Error("设备码响应缺字段");
  const intervalSeconds = typeof device.interval === "number" ? device.interval : Number(device.interval ?? 5) || 5;

  interaction.notify({
    type: "device_code",
    userCode,
    verificationUri: DEVICE_VERIFICATION_URI,
    intervalSeconds,
    expiresInSeconds: Math.floor(DEVICE_TIMEOUT_MS / 1000),
  });

  const deadline = Date.now() + DEVICE_TIMEOUT_MS;
  let waitMs = Math.max(1000, intervalSeconds * 1000);
  for (;;) {
    if (signal.aborted) throw new Error("登录已取消");
    if (Date.now() > deadline) throw new Error("设备码登录超时");
    await new Promise((r) => setTimeout(r, waitMs));
    const poll = await fetch(DEVICE_TOKEN_URL, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ device_auth_id: deviceAuthId, user_code: userCode }),
      signal,
    });
    if (poll.ok) {
      const done = (await poll.json()) as { authorization_code?: string; code_verifier?: string };
      if (!done.authorization_code || !done.code_verifier) throw new Error("设备码授权响应缺字段");
      const exchanged = await fetch(TOKEN_URL, {
        method: "POST",
        headers: { "content-type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({
          grant_type: "authorization_code",
          client_id: CLIENT_ID,
          code: done.authorization_code,
          code_verifier: done.code_verifier,
          redirect_uri: DEVICE_REDIRECT_URI,
        }),
        signal,
      });
      return toCredential(await readTokens(exchanged, "exchange"));
    }
    const body = (await poll.text().catch(() => "")).slice(0, 300);
    if (body.includes("slow_down")) waitMs = Math.max(1000, waitMs + 5000);
  }
}

export async function refreshTokens(credential: OAuthCredential, signal?: AbortSignal): Promise<OAuthCredential> {
  const response = await fetch(TOKEN_URL, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: "refresh_token",
      refresh_token: credential.refresh,
      client_id: CLIENT_ID,
    }),
    ...(signal ? { signal } : {}),
  });
  return toCredential(await readTokens(response, "refresh"));
}

/**
 * 浏览器 PKCE 授权（pi 本地登录走的就是这条路）：拿 URL 让用户在已登录的浏览器里授权，
 * 回调地址是 http://localhost:1455/auth/callback —— 鱼跑在无头机器上，所以回调由用户
 * 复制回来的整条 URL（或 code#state）完成，不需要本地监听端口。
 */
const AUTHORIZE_URL = `${AUTH_BASE}/oauth/authorize`;
const REDIRECT_URI = "http://localhost:1455/auth/callback";
const SCOPE = "openid profile email offline_access";

export interface BrowserLoginStart {
  url: string;
  verifier: string;
  state: string;
}

function base64url(bytes: Uint8Array): string {
  return Buffer.from(bytes).toString("base64url");
}

export async function startBrowserLogin(originator = "yugang"): Promise<BrowserLoginStart> {
  const verifier = base64url(crypto.getRandomValues(new Uint8Array(32)));
  const challenge = base64url(new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(verifier))));
  const state = base64url(crypto.getRandomValues(new Uint8Array(16)));
  const url = new URL(AUTHORIZE_URL);
  url.searchParams.set("response_type", "code");
  url.searchParams.set("client_id", CLIENT_ID);
  url.searchParams.set("redirect_uri", REDIRECT_URI);
  url.searchParams.set("scope", SCOPE);
  url.searchParams.set("code_challenge", challenge);
  url.searchParams.set("code_challenge_method", "S256");
  url.searchParams.set("state", state);
  url.searchParams.set("id_token_add_organizations", "true");
  url.searchParams.set("codex_cli_simplified_flow", "true");
  url.searchParams.set("originator", originator);
  return { url: url.toString(), verifier, state };
}

/** 接受整条回调 URL、`code#state` 或裸 code。 */
export function parseAuthorizationInput(input: string): { code?: string; state?: string } {
  const value = input.trim();
  if (!value) return {};
  try {
    const url = new URL(value);
    return { code: url.searchParams.get("code") ?? undefined, state: url.searchParams.get("state") ?? undefined };
  } catch {
    /* 不是 URL，继续按文本解析 */
  }
  if (value.includes("#")) {
    const [code, state] = value.split("#", 2);
    return { code, state };
  }
  if (value.includes("code=")) {
    const params = new URLSearchParams(value);
    return { code: params.get("code") ?? undefined, state: params.get("state") ?? undefined };
  }
  return { code: value };
}

export async function finishBrowserLogin(
  start: { verifier: string; state: string },
  input: string,
  signal?: AbortSignal,
): Promise<OAuthCredential> {
  const parsed = parseAuthorizationInput(input);
  if (parsed.state && parsed.state !== start.state) throw new Error("state mismatch: login interrupted or url incomplete");
  if (!parsed.code) throw new Error("没拿到授权码");
  const response = await fetch(TOKEN_URL, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: "authorization_code",
      client_id: CLIENT_ID,
      code: parsed.code,
      code_verifier: start.verifier,
      redirect_uri: REDIRECT_URI,
    }),
    ...(signal ? { signal } : {}),
  });
  return toCredential(await readTokens(response, "exchange"));
}

/** pi-ai 需要的 OAuthAuth 形状：登录、刷新、请求凭据。 */
export const openaiCodexOAuth = {
  name: "OpenAI (ChatGPT Plus/Pro)",
  isSubscription: true,
  async login(interaction: LoginInteraction): Promise<OAuthCredential> {
    return loginWithDeviceCode(interaction);
  },
  async refresh(credential: OAuthCredential, signal: AbortSignal): Promise<OAuthCredential> {
    return refreshTokens(credential, signal);
  },
  async toAuth(credential: OAuthCredential): Promise<{ apiKey: string }> {
    return { apiKey: credential.access };
  },
};
