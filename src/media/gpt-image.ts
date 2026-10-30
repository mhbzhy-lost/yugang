/**
 * GPT Image 生图：走 ChatGPT/Codex 订阅的图片后端。
 *
 * 端点与前缀都和 chat 请求不同，不是 api.openai.com/v1/images：
 *   POST https://chatgpt.com/backend-api/codex/images/generations
 * 需要的三个额外头（少一个就 4xx）：chatgpt-account-id、originator、x-codex-image-turn-id。
 *
 * 凭据复用 config/auth.json 里 `openai-codex` 那条 OAuth（和主模型同一个登录），
 * 快过期时就地刷新并写回，不引入新的 key、不进 env、不进日志。
 */
import { mkdirSync, writeFileSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { join } from "node:path";
import { fileCredentialStore, type OAuthCredential } from "../credential-store.ts";
import { refreshTokens } from "../oauth-openai.ts";

const ENDPOINT = "https://chatgpt.com/backend-api/codex/images/generations";
/** Codex 客户端自称；后端按这个值决定放不放行。 */
const ORIGINATOR = "codex_cli_rs";

export interface GptImageOptions {
  /** config/auth.json 路径；里面必须有 openai-codex 的 OAuth 凭据。 */
  authPath: string;
  prompt: string;
  mediaRoot: string;
  /**
   * 超时，默认 180 秒（生图常见 15–30 秒，透明背景那次 26 秒）。
   *
   * 不提供 size / quality 参数：实测 Codex 后端不吃这两个字段。
   * 同一段 prompt 换 size（1024x1536 / 1536x1024 / 1024x1024）回来都是 1254×1254；
   * quality 换 low / high 的 image_tokens 都是 515。画幅由 prompt 的构图描述决定
   * （例如「竖版构图」），不同 prompt 实测回来过 1536×1024、1312×1199、1374×1145。
   */
  timeoutMs?: number;
  fetchImpl?: typeof fetch;
}

/** 出图成功返回相对 mediaRoot 的引用（gen/xxx.png）；失败抛错，错误里不带凭据。 */
export async function generateWithGptImage(options: GptImageOptions): Promise<string> {
  const store = fileCredentialStore(options.authPath);
  const raw = await store.read("openai-codex");
  if (!raw || raw.type !== "oauth") throw new Error("gpt_image_no_auth");
  let credential = raw as OAuthCredential;
  if (typeof credential.access !== "string" || typeof credential.accountId !== "string") {
    throw new Error("gpt_image_bad_auth");
  }

  // 提前一分钟刷新：生图一次几十秒，别让 token 在请求途中过期
  if (Number(credential.expires) - Date.now() < 60_000) {
    const refreshed = await refreshTokens(credential);
    await store.modify("openai-codex", async () => refreshed);
    credential = refreshed;
  }

  const doFetch = options.fetchImpl ?? fetch;
  const response = await doFetch(ENDPOINT, {
    method: "POST",
    headers: {
      authorization: `Bearer ${credential.access}`,
      "chatgpt-account-id": credential.accountId,
      originator: ORIGINATOR,
      "x-codex-image-turn-id": randomUUID(),
      "content-type": "application/json",
      accept: "application/json",
    },
    body: JSON.stringify({
      model: "gpt-image-2",
      prompt: options.prompt,
      // 输出容器显式钉死 png：下面固定按 .png 落盘，别让后端某天换默认格式
      output_format: "png",
      // auto：让模型自己决定透明/不透明；显式 transparent 实测可用（返回 RGBA），
      // 但目前没有需要抠图的功能，先不暴露
      background: "auto",
    }),
    signal: AbortSignal.timeout(options.timeoutMs ?? 180_000),
  });

  if (!response.ok) throw new Error(`gpt_image_http_${response.status}`);
  const body = (await response.json()) as { data?: { b64_json?: string }[] };
  const encoded = body.data?.[0]?.b64_json;
  if (!encoded) throw new Error("gpt_image_empty");
  const bytes = Buffer.from(encoded, "base64");
  if (bytes.length < 1024) throw new Error("gpt_image_too_small");

  const outDir = join(options.mediaRoot, "gen");
  mkdirSync(outDir, { recursive: true });
  const file = `${Date.now()}-${randomUUID().slice(0, 8)}.png`;
  writeFileSync(join(outDir, file), bytes);
  return file;
}
