/**
 * 模型配置与凭据是两件事：
 *  - config/models.json 在仓库里（角色表 + provider 地址 + 模型清单 + 兼容值），能 review
 *  - 凭据在 config/auth.json（gitignore），loadFishModels 只读它，不依赖 ~/pi-config
 *  - 模型选择只认 models.main / models.vision / models.image，没有环境变量与启动参数
 *  - describeModel 永远不吐 key
 */
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describeModel, loadFishModels, loadProviderConfig } from "../src/model-config.ts";
import { assertModelExists, createFishModels } from "../src/models.ts";

const REPO_MODELS = fileURLToPath(new URL("../config/models.json", import.meta.url));
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

test("仓库里的 config/models.json 能按角色解析", () => {
  const selection = loadFishModels({ modelsPath: REPO_MODELS, credentialsPath: "/nonexistent" });
  assert.ok(selection.main.providerId && selection.main.modelId, "models.main 必须能解析");
  assert.ok(selection.vision.providerId && selection.vision.modelId, "models.vision 必须能解析");
  assert.ok(selection.image, "models.image 必须能解析");
  const raw = JSON.parse(readFileSync(REPO_MODELS, "utf8")) as Record<string, unknown>;
  assert.equal("default" in raw, false, "models.json 不该再有 default：模型选择只走 models 角色表");

  const providerOnly = loadProviderConfig("qoder-pool", { modelsPath: REPO_MODELS, credentialsPath: "/nonexistent" });
  assert.equal(providerOnly.providerId, "qoder-pool");
  assert.equal(providerOnly.modelId, "DeepSeek-Flash");
  assert.match(providerOnly.baseUrl, /^http/);
  assert.deepEqual(providerOnly.models.map((m) => m.id), ["DeepSeek-Flash"]);
});

test("glm-5.3-flash：reasoning 保持 true，thinkingLevelMap 六档全 null（思考永久关闭）", () => {
  const config = JSON.parse(readFileSync(REPO_MODELS, "utf8")) as {
    providers: Record<string, { models: { id: string; reasoning?: boolean; thinkingLevelMap?: Record<string, string | null> }[] }>;
  };
  const entry = config.providers["zai-coding-cn"].models.find((m) => m.id === "glm-5.3-flash");
  assert.ok(entry, "仓库配置里必须有 glm-5.3-flash");
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

test("config/auth.json 必须在 gitignore 里", () => {
  const ignore = readFileSync(fileURLToPath(new URL("../.gitignore", import.meta.url)), "utf8");
  assert.match(ignore, /^config\/auth\.json$/m, "凭据文件没被忽略，一次 git add 就进仓库了");
});

test("仓库配置里不能有 key", () => {
  const raw = JSON.stringify(loadFishModels({ modelsPath: REPO_MODELS, credentialsPath: "/nonexistent" }));
  assert.ok(!/sk-|api_key|"key":\s*"[^"]{20,}/.test(raw), "config/models.json 里疑似写了凭据");
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
