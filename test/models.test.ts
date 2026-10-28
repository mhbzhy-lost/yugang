/**
 * 模型配置与凭据是两件事：
 *  - config/models.json 在仓库里（地址、模型清单、兼容值），能 review
 *  - 凭据在 var/credentials.json（gitignore），loadModelConfig 只读它，不依赖 ~/pi-config
 *  - describeModel 永远不吐 key
 */
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describeModel, loadModelConfig } from "../src/model-config.ts";
import { assertModelExists, createFishModels } from "../src/models.ts";

const REPO_MODELS = fileURLToPath(new URL("../config/models.json", import.meta.url));
const FAKE_KEY = "test-key-0123456789abcdef";

function scratch(): { modelsPath: string; credentialsPath: string } {
  const dir = mkdtempSync(join(tmpdir(), "fish-model-"));
  const modelsPath = join(dir, "models.json");
  writeFileSync(
    modelsPath,
    JSON.stringify({
      default: { provider: "gw", model: "Fast" },
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

test("仓库里的 config/models.json 能直接解析", () => {
  const config = loadModelConfig({ modelsPath: REPO_MODELS, credentialsPath: "/nonexistent", providerId: "qoder-pool", modelId: "DeepSeek-Flash" });
  assert.equal(config.providerId, "qoder-pool");
  assert.equal(config.modelId, "DeepSeek-Flash");
  assert.match(config.baseUrl, /^http/);
  assert.ok(config.models.length > 1);
});

test("仓库配置里不能有 key", () => {
  const raw = JSON.stringify(loadModelConfig({ modelsPath: REPO_MODELS, credentialsPath: "/nonexistent" }));
  assert.ok(!/sk-|api_key|"key":\s*"[^"]{20,}/.test(raw), "config/models.json 里疑似写了凭据");
});

test("凭据从 var/credentials.json 读，缺了就报缺失而不是崩", () => {
  const { modelsPath, credentialsPath } = scratch();
  assert.equal(loadModelConfig({ modelsPath, credentialsPath }).key, FAKE_KEY);
  assert.equal(loadModelConfig({ modelsPath, credentialsPath: "/nonexistent" }).key, "");
});

test("provider 级 compat 兜底，模型自带的覆盖它", () => {
  const { modelsPath, credentialsPath } = scratch();
  const config = loadModelConfig({ modelsPath, credentialsPath });
  const fast = config.models.find((m) => m.id === "Fast")!;
  const slow = config.models.find((m) => m.id === "Slow")!;
  assert.equal((fast.compat as Record<string, unknown>)["maxTokensField"], "max_completion_tokens");
  assert.equal((slow.compat as Record<string, unknown>)["maxTokensField"], "max_tokens");
  assert.equal((slow.compat as Record<string, unknown>)["supportsStore"], false);
});

test("describeModel 里不会出现 key 内容", () => {
  const { modelsPath, credentialsPath } = scratch();
  const shown = JSON.stringify(describeModel(loadModelConfig({ modelsPath, credentialsPath })));
  assert.ok(!shown.includes(FAKE_KEY), "key 泄漏进 describeModel 了");
  assert.match(shown, /已加载/);
});

test("没有 key 就不许建 Models", () => {
  const { modelsPath } = scratch();
  const config = loadModelConfig({ modelsPath, credentialsPath: "/nonexistent" });
  assert.throws(() => createFishModels(config), /没有拿到/);
});

test("build 出来的 Models 能找到配置里的模型，找不到时报可用清单", () => {
  const { modelsPath, credentialsPath } = scratch();
  const config = loadModelConfig({ modelsPath, credentialsPath });
  const models = createFishModels(config);
  assert.doesNotThrow(() => assertModelExists(models, "gw", "Fast"));
  assert.throws(() => assertModelExists(models, "gw", "不存在"), /Fast, Slow/);
});
