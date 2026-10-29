/**
 * 登录订阅制 provider（目前只有 openai-codex），把 oauth 凭据写进 config/auth.json。
 *
 *   npm run login -- openai-codex              # 设备码流程（无头，但 OpenAI 要求手机核验）
 *   npm run login -- openai-codex --browser    # 浏览器 PKCE：打印授权 URL 并暂存 state
 *   npm run login -- openai-codex --finish "<回调 URL 或 code#state>"
 *
 * 浏览器流程是推荐路径：和 pi 本地登录一致，有登录态就不用再过手机验证。
 * 回调地址是 http://localhost:1455/auth/callback，鱼跑在无头机器上、不需要真的监听，
 * 把浏览器地址栏那条（哪怕打不开）整条复制回来即可。
 */
import { existsSync, readFileSync, rmSync, writeFileSync, mkdirSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { loadModelConfig } from "../src/model-config.ts";
import { createFishModels } from "../src/models.ts";
import { finishBrowserLogin, startBrowserLogin } from "../src/oauth-openai.ts";

const args = process.argv.slice(2);
const target = args.find((a) => !a.startsWith("--")) ?? process.env.MODEL_PROVIDER ?? "";
const mode = args.includes("--browser") ? "browser" : args.includes("--finish") ? "finish" : "device";
const finishIndex = args.indexOf("--finish");
const finishInput = finishIndex >= 0 ? args[finishIndex + 1] : undefined;

if (!target) {
  console.error("用法：npm run login -- <provider> [--browser | --finish <回调URL>]");
  process.exit(1);
}
if (target !== "openai-codex") {
  console.error(`${target} 不需要登录流程（API key）；用 npm run creds import`);
  process.exit(1);
}

const config = loadModelConfig({ providerId: target, modelsPath: resolve(join(process.cwd(), "config", "models.json")) });
const models = createFishModels(config);
const statePath = join(dirname(config.credentialsPath), ".login-state.json");

if (mode === "browser") {
  const start = await startBrowserLogin();
  mkdirSync(dirname(statePath), { recursive: true });
  writeFileSync(statePath, JSON.stringify({ verifier: start.verifier, state: start.state }), { mode: 0o600 });
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
  if (!existsSync(statePath)) {
    console.error(`找不到登录状态（${statePath}），先跑 --browser`);
    process.exit(1);
  }
  const saved = JSON.parse(readFileSync(statePath, "utf8")) as { verifier: string; state: string };
  const credential = await finishBrowserLogin(saved, finishInput);
  await import("../src/credential-store.ts").then(async ({ fileCredentialStore }) => {
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
