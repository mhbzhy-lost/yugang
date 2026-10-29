/**
 * 登录订阅制 provider（目前只有 openai-codex）：走设备码流程，把 oauth 凭据写进 config/auth.json。
 *
 *   npm run login -- openai-codex
 *
 * 会把设备码和验证地址打出来，用手机/浏览器打开完成授权；token 只落文件，不打印。
 * 登录成功后 fish 直接用这份凭据，过期时 pi-ai 会在请求路径上自动 refresh 并回写同一个文件。
 */
import { join, dirname, resolve } from "node:path";
import { loadModelConfig } from "../src/model-config.ts";
import { createFishModels } from "../src/models.ts";

const target = process.argv[2] ?? process.env.MODEL_PROVIDER ?? "";
if (!target) {
  console.error("用法：npm run login -- <provider>，例如 openai-codex");
  process.exit(1);
}

if (target !== "openai-codex") {
  console.error(`provider ${target} 不需要登录流程（它用 API key）；用 npm run creds import 或直接写 config/auth.json`);
  process.exit(1);
}

const config = loadModelConfig({ providerId: target, modelsPath: resolve(join(process.cwd(), "config", "models.json")) });
const models = createFishModels({
  ...config,
  // 登录前可能还没有凭据；createFishModels 对 oauth 不校验 key
  oauth: config.oauth,
});

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
    if (event.type === "auth_url") {
      const e = event as unknown as { url: string };
      console.log(`请打开：${e.url}`);
      return;
    }
    if (event.type === "info") {
      const e = event as unknown as { message: string };
      console.log(e.message);
    }
  },
  async prompt(prompt) {
    if (prompt.type === "select" && prompt.options?.length) {
      // 非交互环境默认第一项（设备码流程不需要额外选择）
      return prompt.options[0]!.id;
    }
    throw new Error(`不支持交互式输入：${prompt.message}`);
  },
});

const expiry = new Date((credential as { expires: number }).expires).toISOString();
console.log(`✓ ${target} 已登录（有效期至 ${expiry}），凭据写入 ${config.credentialsPath}`);
console.log("  换机器/上线：把 config/auth.json 复制过去即可（权限 600，已 gitignore）");
process.exit(0);
