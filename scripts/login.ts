/**
 * 登录订阅制 provider（openai-codex / google-gemini / google-antigravity），把 oauth 凭据写进 config/auth.json。
 *
 *   npm run login -- openai-codex              # 设备码流程（无头，但 OpenAI 要求手机核验）
 *   npm run login -- openai-codex --browser    # 浏览器 PKCE：打印授权 URL 并暂存 state
 *   npm run login -- openai-codex --finish "<回调 URL 或 code#state>"
 *
 *   npm run login -- google-gemini             # 只有浏览器流程（Google 的 client 不支持设备码）
 *   npm run login -- google-gemini --browser   # 同上，显式写出
 *   npm run login -- google-gemini --finish "<授权码或整条地址>"
 *
 *   npm run login -- google-antigravity        # Antigravity 通道（AI Pro 订阅现通道），同样只有浏览器流程
 *   npm run login -- google-antigravity --finish "<整条回调 URL>"
 *
 * 浏览器流程是推荐路径：和 pi 本地登录一致，有登录态就不用再过手机验证。
 * openai-codex 的回调地址是 http://localhost:1455/auth/callback，鱼跑在无头机器上、不需要真的监听，
 * 把浏览器地址栏那条（哪怕打不开）整条复制回来即可。
 * google-gemini 的回调页是 https://codeassist.google.com/authcode，授权后页面直接把授权码显示出来。
 * google-antigravity 的回调地址是 http://localhost:51121/oauth-callback，无头机不监听、页面打不开
 * 是正常的，把地址栏整条 URL 复制回来即可（与 codex 浏览器流同款 UX）。
 */
import { existsSync, readFileSync, rmSync, writeFileSync, mkdirSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { loadProviderConfig } from "../src/model/config.ts";
import { createFishModels } from "../src/model/models.ts";
import { finishBrowserLogin as finishOpenAIBrowserLogin, startBrowserLogin as startOpenAIBrowserLogin } from "../src/auth/openai.ts";
import {
  finishBrowserLogin as finishGoogleBrowserLogin,
  startBrowserLogin as startGoogleBrowserLogin,
  GEMINI_REDIRECT_URI,
  GEMINI_SCOPES,
  ANTIGRAVITY_REDIRECT_URI,
  ANTIGRAVITY_SCOPES,
} from "../src/auth/google.ts";
import { discoverProject, fetchAvailableModels, type CodeAssistFlavor } from "../src/model/google-code-assist.ts";
import { fileCredentialStore } from "../src/auth/credentials.ts";
import { createProxyFetch } from "../src/media/proxy-fetch.ts";

const args = process.argv.slice(2);
const target = args.find((a) => !a.startsWith("--")) ?? "";
const mode = args.includes("--browser") ? "browser" : args.includes("--finish") ? "finish" : "device";
const finishIndex = args.indexOf("--finish");
const finishInput = finishIndex >= 0 ? args[finishIndex + 1] : undefined;

const OAUTH_TARGETS = new Set(["openai-codex", "google-gemini", "google-antigravity"]);

if (!target) {
  console.error("用法：npm run login -- <openai-codex|google-gemini|google-antigravity> [--browser | --finish <授权码/回调URL>]");
  process.exit(1);
}
if (!OAUTH_TARGETS.has(target)) {
  console.error(`${target} 不需要登录流程（API key）；用 npm run creds import`);
  console.error("支持登录的 provider：openai-codex、google-gemini、google-antigravity");
  process.exit(1);
}

const config = loadProviderConfig(target, { modelsPath: resolve(join(process.cwd(), "config", "models.json")) });
const models = createFishModels(config);
const statePath = join(dirname(config.credentialsPath), ".login-state.json");

// 登录过程的网络请求（token 交换 + 项目发现）在配了 provider 代理时必须走代理：
// 这些 Google / OpenAI 域名在无代理环境可能不可达。代理非法时回落直连并告警。
const proxyFetch = config.proxy ? createProxyFetch(config.proxy) : undefined;
if (config.proxy && !proxyFetch) {
  console.warn(`[login] provider 代理配置无效（${config.proxy}），token 交换将直连`);
}

type LoginState = { verifier: string; state: string; provider?: string };

function readState(targetProvider: string): LoginState {
  if (!existsSync(statePath)) {
    console.error(`找不到登录状态（${statePath}），先跑 --browser`);
    process.exit(1);
  }
  const saved = JSON.parse(readFileSync(statePath, "utf8")) as LoginState;
  // 旧文件没有 provider 字段，按 openai-codex 兼容
  const savedProvider = saved.provider ?? "openai-codex";
  if (savedProvider !== targetProvider) {
    console.error(`登录状态是 ${savedProvider} 的，不是 ${targetProvider}；先跑 npm run login -- ${targetProvider} --browser`);
    process.exit(1);
  }
  return saved;
}

// 两个 Google 订阅通道共用同一套浏览器 PKCE 登录，只差 redirect_uri 与 scopes（按 flavor 选）
const GOOGLE_FLAVORS: Record<string, CodeAssistFlavor> = {
  "google-gemini": "gemini",
  "google-antigravity": "antigravity",
};
const googleFlavor = GOOGLE_FLAVORS[target];

if (googleFlavor) {
  // Google 的 client 是 Desktop 类型，设备码端点会拒（Invalid client type），只有浏览器流程。
  // client 来自本机 config/models.json（源码与模板都不放真值，避免 push protection 拦推送）；
  // redirect_uri / scopes 按通道缺省（gemini-cli 回调页 / antigravity loopback 回调）
  const client = config.oauthClient
    ? {
        ...config.oauthClient,
        redirectUri: googleFlavor === "antigravity" ? ANTIGRAVITY_REDIRECT_URI : GEMINI_REDIRECT_URI,
        scopes: googleFlavor === "antigravity" ? ANTIGRAVITY_SCOPES : GEMINI_SCOPES,
      }
    : undefined;
  if (!client) {
    console.error(
      `${target} 缺 OAuth client：去 config/models.json 的 providers.${target}.oauthClient 填公开 client（模板留了空占位，说明见 AGENTS.md 第 6 节）`,
    );
    process.exit(1);
  }
  if (mode === "finish") {
    if (!finishInput) {
      console.error(`用法：npm run login -- ${target} --finish '<授权码或整条地址>'`);
      process.exit(1);
    }
    const saved = readState(target);
    let credential;
    try {
      credential = await finishGoogleBrowserLogin(client, saved, finishInput, undefined, proxyFetch ?? fetch);
    } catch (error) {
      console.error(`授权码交换失败：${error instanceof Error ? error.message : error}`);
      console.error("授权码是一次性的、约 5 分钟失效；报 invalid_grant / 连接失败就重新 --browser 再授权一次。");
      process.exit(1);
    }
    // 项目发现 best-effort：失败只告警不阻塞登录，缺 project 时请求体省略该字段
    let enriched = credential;
    try {
      const discovered = await discoverProject(credential.access, googleFlavor, proxyFetch ?? fetch);
      enriched = {
        ...credential,
        ...(discovered.projectId ? { projectId: discovered.projectId } : {}),
        ...(discovered.tier ? { tier: discovered.tier } : {}),
      };
      if (discovered.projectId) console.log(`  ${googleFlavor === "antigravity" ? "Antigravity" : "Code Assist"} 项目：${discovered.projectId}${discovered.tier ? `（${discovered.tier}）` : ""}`);
      else console.warn("  [login] 没发现 cloudaicompanionProject，请求将不带 project 字段");
      // antigravity 登录时顺手列出账户可用模型（best-effort，失败不阻塞）
      if (googleFlavor === "antigravity" && discovered.projectId) {
        try {
          const available = await fetchAvailableModels(credential.access, discovered.projectId, proxyFetch ?? fetch);
          const entries = Object.entries(available);
          if (entries.length > 0) {
            console.log("  本账户可用模型：");
            for (const [id, info] of entries) console.log(`    ${id}${info.displayName ? `（${info.displayName}）` : ""}`);
          }
        } catch (error) {
          console.warn(`  [login] 拉取可用模型失败（不影响登录）：${error instanceof Error ? error.message : error}`);
        }
      }
    } catch (error) {
      console.warn(`  [login] 项目发现失败（不影响登录）：${error instanceof Error ? error.message : error}`);
    }
    const store = fileCredentialStore(config.credentialsPath);
    await store.modify(target, async () => enriched);
    rmSync(statePath, { force: true });
    console.log(`✓ ${target} 已登录（有效期至 ${new Date(enriched.expires).toISOString()}）`);
    console.log(`  凭据写入 ${config.credentialsPath}（600，已 gitignore）`);
    process.exit(0);
  }

  // 默认与 --browser 都是浏览器流程
  const start = await startGoogleBrowserLogin(client);
  mkdirSync(dirname(statePath), { recursive: true });
  writeFileSync(statePath, JSON.stringify({ verifier: start.verifier, state: start.state, provider: target }), { mode: 0o600 });
  console.log("在已登录 Google 账户的浏览器里打开这个地址并授权：");
  console.log("");
  console.log(start.url);
  console.log("");
  if (googleFlavor === "antigravity") {
    console.log("授权后浏览器会跳到 http://localhost:51121/oauth-callback?code=...（页面打不开是正常的，无头机不监听这个端口，地址栏里还有）。");
    console.log("把地址栏里整条 URL 复制回来，执行：");
    console.log(`  npm run login -- ${target} --finish '<粘贴这里>'`);
  } else {
    console.log("授权后浏览器会跳到 https://codeassist.google.com/authcode 页面，页面上直接显示授权码。");
    console.log("把授权码（或整条地址）复制回来，执行：");
    console.log(`  npm run login -- ${target} --finish '<粘贴这里>'`);
  }
  console.log("注意：授权码是一次性的、约 5 分钟失效；--finish 报 invalid_grant 就重新 --browser 再授权一次。");
  process.exit(0);
}

if (mode === "browser") {
  const start = await startOpenAIBrowserLogin();
  mkdirSync(dirname(statePath), { recursive: true });
  writeFileSync(statePath, JSON.stringify({ verifier: start.verifier, state: start.state, provider: target }), { mode: 0o600 });
  console.log("在已登录 ChatGPT 的浏览器里打开这个地址并授权：");
  console.log("");
  console.log(start.url);
  console.log("");
  console.log("授权后浏览器会跳到 http://localhost:1455/auth/callback?code=...（打不开是正常的，地址栏还有）。");
  console.log("把整条地址（或 code#state）复制回来，执行：");
  console.log("  npm run login -- openai-codex --finish '<粘贴这里>'");
  process.exit(0);
}

if (mode === "finish") {
  if (!finishInput) {
    console.error("用法：npm run login -- openai-codex --finish '<回调 URL 或 code#state>'");
    process.exit(1);
  }
  const saved = readState(target);
  const credential = await finishOpenAIBrowserLogin(saved, finishInput);
  await import("../src/auth/credentials.ts").then(async ({ fileCredentialStore }) => {
    const store = fileCredentialStore(config.credentialsPath);
    await store.modify(target, async () => credential);
  });
  rmSync(statePath, { force: true });
  console.log(`✓ ${target} 已登录（有效期至 ${new Date(credential.expires).toISOString()}）`);
  console.log(`  凭据写入 ${config.credentialsPath}（600，已 gitignore）`);
  process.exit(0);
}

const controller = new AbortController();
process.on("SIGINT", () => controller.abort());

const credential = await models.login(target, "oauth", {
  signal: controller.signal,
  notify: (event) => {
    if (event.type === "device_code") {
      const e = event as unknown as { userCode: string; verificationUri: string; expiresInSeconds?: number };
      console.log("");
      console.log(`  验证地址：${e.verificationUri}`);
      console.log(`  设备码：  ${e.userCode}`);
      console.log(`  ${e.expiresInSeconds ? `${Math.round(e.expiresInSeconds / 60)} 分钟内有效` : ""}`);
      console.log("");
      console.log("浏览器打开上面的地址、输入设备码，完成后会自动继续…");
      return;
    }
    if (event.type === "info") console.log((event as unknown as { message: string }).message);
  },
  async prompt(prompt) {
    if (prompt.type === "select" && prompt.options?.length) return prompt.options[0]!.id;
    throw new Error(`不支持交互式输入：${prompt.message}`);
  },
});

console.log(`✓ ${target} 已登录（有效期至 ${new Date((credential as { expires: number }).expires).toISOString()}）`);
console.log(`  凭据写入 ${config.credentialsPath}（600，已 gitignore）`);
process.exit(0);
