/**
 * Google 账户（AI Pro 订阅 / Gemini CLI 同款）OAuth：浏览器 PKCE 登录 + refresh + 请求凭据派生。
 *
 * 为什么只有浏览器流程：这个 client 是 Google 为 gemini-cli 注册的 Desktop 应用，设备码端点
 * 会拒它（Invalid client type），唯一可行的登录路径是浏览器 PKCE；gemini 通道的 redirect_uri
 * 用 gemini-cli 注册的 https://codeassist.google.com/authcode —— 授权完成后该页面直接把授权码显示
 * 出来，复制回来即可，不需要本地监听端口。antigravity 通道用 loopback 回调
 * http://localhost:51121/oauth-callback：无头机不监听该端口，授权后浏览器地址栏里那条打不开的
 * 回调 URL 整条复制回来即可（与 codex 浏览器流同款 UX）。两个 flavor 只差 redirect_uri 与
 * scopes（antigravity 多 cclog / experimentsandconfigs 两个），token 端点与刷新完全同一套。
 *
 * OAuth client 常量不放源码：id/secret 虽是 gemini-cli 的公开常量（gemini-cli 官方源码同样
 * 明文携带），但 GitHub push protection 会拦含明文 client 的提交，所以只放本机
 * config/models.json 的 providers.google-gemini.oauthClient，登录脚本读配置后传进来。
 * 登录成功时 client 随凭据落盘（config/auth.json，gcloud 同款惯例），之后 token 刷新从
 * 凭据自带的 clientId / clientSecret 读，不再依赖启动配置——refresh token 绑定签发它的 client。
 *
 * 凭据形状：{ type:"oauth", access, refresh, expires, clientId, clientSecret, projectId?, tier?, email? }
 *  - access 是 Code Assist API 的 bearer token；projectId 经私有头 x-yugang-ca-project
 *    交给适配器（见 toAuth），适配器会把它从出站头里摘掉、转进请求信封的 project 字段
 *  - refresh 换新 token。pi-ai 在请求路径上按 expires 判断并整体回写 config/auth.json，
 *    所以 refreshTokens 必须把 projectId / tier / email 这些额外字段原样带回去，否则一次
 *    刷新就把项目信息冲掉了
 */
import type { OAuthCredential } from "./credential-store.ts";

/** OAuth client（公开 installed-app id/secret），由登录脚本从本机 config/models.json 读出传入。
 * redirectUri / scopes 按 provider flavor 缺省：gemini-cli 用 codeassist 回调页，
 * antigravity 用 loopback 回调（见下方两组常量）；登录脚本只传 id/secret 时自动落到 gemini。 */
export interface GoogleOauthClient {
  id: string;
  secret: string;
  redirectUri?: string;
  scopes?: string[];
}

/** gemini-cli 通道：授权后 codeassist.google.com/authcode 页面直接显示授权码。 */
export const GEMINI_REDIRECT_URI = "https://codeassist.google.com/authcode";
export const GEMINI_SCOPES = [
  "https://www.googleapis.com/auth/cloud-platform",
  "https://www.googleapis.com/auth/userinfo.email",
  "https://www.googleapis.com/auth/userinfo.profile",
];

/** antigravity 通道：loopback 回调，无头机不监听，用户把地址栏整条 URL 复制回来。 */
export const ANTIGRAVITY_REDIRECT_URI = "http://localhost:51121/oauth-callback";
export const ANTIGRAVITY_SCOPES = [
  "https://www.googleapis.com/auth/cloud-platform",
  "https://www.googleapis.com/auth/userinfo.email",
  "https://www.googleapis.com/auth/userinfo.profile",
  "https://www.googleapis.com/auth/cclog",
  "https://www.googleapis.com/auth/experimentsandconfigs",
];

const AUTHORIZE_URL = "https://accounts.google.com/o/oauth2/v2/auth";
const TOKEN_URL = "https://oauth2.googleapis.com/token";

export interface BrowserLoginStart {
  url: string;
  verifier: string;
  state: string;
}

function base64url(bytes: Uint8Array): string {
  return Buffer.from(bytes).toString("base64url");
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

/** email 只是为了给人看，best-effort：从 id_token 的 payload 里解，解不出来就算了。 */
function emailOf(idToken: string | undefined): string | undefined {
  if (!idToken) return undefined;
  const email = decodeJwt(idToken)?.["email"];
  return typeof email === "string" && email.length > 0 ? email : undefined;
}

interface TokenResponse {
  access_token?: string;
  refresh_token?: string;
  expires_in?: number;
  id_token?: string;
}

async function readTokens(
  response: Response,
  operation: string,
): Promise<{ access: string; refresh: string; expires: number; email?: string }> {
  if (!response.ok) {
    const text = await response.text().catch(() => "");
    throw new Error(`Google token ${operation} 失败 (${response.status}): ${text.slice(0, 200)}`);
  }
  const json = (await response.json()) as TokenResponse;
  if (!json.access_token || !json.refresh_token || typeof json.expires_in !== "number") {
    throw new Error(`Google token ${operation} 响应缺字段`);
  }
  const email = emailOf(json.id_token);
  return {
    access: json.access_token,
    refresh: json.refresh_token,
    expires: Date.now() + json.expires_in * 1000,
    ...(email ? { email } : {}),
  };
}

/**
 * 浏览器 PKCE 授权：拿 URL 让用户在已登录 Google 的浏览器里授权。
 * access_type=offline + prompt=consent 保证 refresh_token 稳定返回（Google 只在
 * 首次授权或显式 consent 时发 refresh token，缺了这两个参数重登可能拿不到）。
 */
export async function startBrowserLogin(client: GoogleOauthClient): Promise<BrowserLoginStart> {
  const redirectUri = client.redirectUri ?? GEMINI_REDIRECT_URI;
  const scopes = client.scopes ?? GEMINI_SCOPES;
  const verifier = base64url(crypto.getRandomValues(new Uint8Array(32)));
  const challenge = base64url(new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(verifier))));
  const state = base64url(crypto.getRandomValues(new Uint8Array(16)));
  const url = new URL(AUTHORIZE_URL);
  url.searchParams.set("response_type", "code");
  url.searchParams.set("client_id", client.id);
  url.searchParams.set("redirect_uri", redirectUri);
  url.searchParams.set("scope", scopes.join(" "));
  url.searchParams.set("access_type", "offline");
  url.searchParams.set("prompt", "consent");
  url.searchParams.set("state", state);
  url.searchParams.set("code_challenge", challenge);
  url.searchParams.set("code_challenge_method", "S256");
  return { url: url.toString(), verifier, state };
}

/**
 * 接受整条回调 URL、`code#state` 或裸授权码。
 * Google 的授权码形如 `4/0AeaYy...`（自带斜杠），裸码不是 URL、也不含 # 与 code=，
 * 会安全落到最后一段；含 state 且对不上时直接报错，防止串场。
 */
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

/** 授权码换 token。fetchImpl 由登录脚本传代理版 fetch；运行时刷新走全局 fetch（scoped proxy 接管）。 */
export async function finishBrowserLogin(
  client: GoogleOauthClient,
  start: { verifier: string; state: string },
  input: string,
  signal?: AbortSignal,
  fetchImpl: typeof fetch = fetch,
): Promise<OAuthCredential> {
  const parsed = parseAuthorizationInput(input);
  if (parsed.state && parsed.state !== start.state) throw new Error("state mismatch: login interrupted or url incomplete");
  if (!parsed.code) throw new Error("没拿到授权码");
  const response = await fetchImpl(TOKEN_URL, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    // 用字符串 body：代理版 fetch（proxy-fetch.ts）只支持 string/ArrayBuffer
    body: new URLSearchParams({
      grant_type: "authorization_code",
      code: parsed.code,
      code_verifier: start.verifier,
      client_id: client.id,
      client_secret: client.secret,
      // token 交换的 redirect_uri 必须与授权请求一致（Google 严格校验），按 client flavor 缺省
      redirect_uri: client.redirectUri ?? GEMINI_REDIRECT_URI,
    }).toString(),
    ...(signal ? { signal } : {}),
  });
  const tokens = await readTokens(response, "exchange");
  // client 嵌进凭据：之后刷新只依赖凭据自带字段（refresh token 绑定签发它的 client）
  return { type: "oauth", ...tokens, clientId: client.id, clientSecret: client.secret };
}

/**
 * refresh 换新 access。client 从凭据自带的 clientId / clientSecret 读（登录时嵌入），
 * 缺了直接报错让用户重登，不做静默兜底；Google 可能在响应里轮换 refresh_token，
 * 没有就保留旧的；projectId / tier / email 等额外字段原样带回（见文件头注释）。
 */
export async function refreshTokens(
  credential: OAuthCredential,
  signal?: AbortSignal,
  fetchImpl: typeof fetch = fetch,
): Promise<OAuthCredential> {
  const { clientId, clientSecret } = credential;
  if (typeof clientId !== "string" || !clientId || typeof clientSecret !== "string" || !clientSecret) {
    throw new Error("凭据缺 OAuth client 信息，请重新登录");
  }
  const response = await fetchImpl(TOKEN_URL, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    // 同上：字符串 body，兼容代理版 fetch
    body: new URLSearchParams({
      grant_type: "refresh_token",
      refresh_token: credential.refresh,
      client_id: clientId,
      client_secret: clientSecret,
    }).toString(),
    ...(signal ? { signal } : {}),
  });
  if (!response.ok) {
    const text = await response.text().catch(() => "");
    throw new Error(`Google token refresh 失败 (${response.status}): ${text.slice(0, 200)}`);
  }
  const json = (await response.json()) as TokenResponse;
  if (!json.access_token || typeof json.expires_in !== "number") {
    throw new Error("Google token refresh 响应缺字段");
  }
  return {
    ...credential,
    access: json.access_token,
    refresh: json.refresh_token ?? credential.refresh,
    expires: Date.now() + json.expires_in * 1000,
  };
}

/** pi-ai 需要的 OAuthAuth 形状：登录（这个 client 不支持设备码）、刷新、请求凭据。 */
export const googleGeminiOAuth = {
  name: "Google (Gemini Pro)",
  isSubscription: true,
  async login(): Promise<OAuthCredential> {
    throw new Error("Google 设备码不可用：npm run login -- google-gemini --browser");
  },
  async refresh(credential: OAuthCredential, signal: AbortSignal): Promise<OAuthCredential> {
    return refreshTokens(credential, signal);
  },
  async toAuth(credential: OAuthCredential): Promise<{ apiKey: string; headers?: Record<string, string> }> {
    const projectId = typeof credential.projectId === "string" && credential.projectId ? credential.projectId : undefined;
    return {
      apiKey: credential.access,
      ...(projectId ? { headers: { "x-yugang-ca-project": projectId } } : {}),
    };
  },
};
