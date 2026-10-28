/**
 * 模型与凭据：
 *  - 从 pi 的 models.json + auth.json 抄配置，不用把网关地址写进仓库
 *  - 网关兼容默认值（max_tokens）会补上
 *  - describeModel 永远不吐 key
 */
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describeModel, loadModelConfig } from "../src/model-config.ts";
import { assertModelExists, createFishModels } from "../src/models.ts";

const FAKE_KEY = "test-key-0123456789abcdef";

function piConfig(): string {
  const dir = mkdtempSync(join(tmpdir(), "pi-config-"));
  writeFileSync(
    join(dir, "models.json"),
    JSON.stringify({
      providers: {
        gateway: {
          baseUrl: "http://127.0.0.1:9/v1",
          api: "openai-completions",
          models: [
            { id: "Fast", name: "Fast", contextWindow: 1000, maxTokens: 100 },
            { id: "Slow", name: "Slow", contextWindow: 2000, maxTokens: 200 },
          ],
        },
      },
    }),
  );
  writeFileSync(join(dir, "auth.json"), JSON.stringify({ gateway: { type: "api_key", key: FAKE_KEY } }));
  return dir;
}

test("从 pi 配置里抄 provider 与 key", () => {
  const config = loadModelConfig({ piConfigDir: piConfig(), providerId: "gateway", modelId: "Fast" });
  assert.equal(config.providerId, "gateway");
  assert.equal(config.modelId, "Fast");
});

test("网关注入 max_tokens 兼容值，模型自带的 compat 会覆盖", () => {
  const config = loadModelConfig({ piConfigDir: piConfig(), providerId: "gateway", modelId: "Fast" });
  assert.equal(config.baseUrl, "http://127.0.0.1:9/v1");
  for (const model of config.models) {
    assert.equal((model.compat as Record<string, unknown>)["maxTokensField"], "max_tokens");
  }
  assert.equal(config.key, FAKE_KEY);
  assert.equal(config.models.length, 2);
});

test("describeModel 里不会出现 key 内容", () => {
  const config = loadModelConfig({ piConfigDir: piConfig(), providerId: "gateway", modelId: "Fast" });
  const shown = JSON.stringify(describeModel(config));
  assert.ok(!shown.includes(FAKE_KEY), "key 泄漏进 describeModel 了");
  assert.match(shown, /已加载/);
});

test("没有 key 就不许建 Models", () => {
  const dir = mkdtempSync(join(tmpdir(), "pi-config-"));
  writeFileSync(join(dir, "models.json"), JSON.stringify({ providers: { gateway: { models: [{ id: "Fast" }] } } }));
  writeFileSync(join(dir, "auth.json"), JSON.stringify({}));
  const config = loadModelConfig({ piConfigDir: dir, providerId: "gateway", modelId: "Fast" });
  assert.throws(() => createFishModels(config), /没有拿到/);
});

test("build 出来的 Models 能找到配置里的模型，找不到时报可用清单", () => {
  const config = loadModelConfig({ piConfigDir: piConfig(), providerId: "gateway", modelId: "Fast" });
  const models = createFishModels(config);
  assert.doesNotThrow(() => assertModelExists(models, "gateway", "Fast"));
  assert.throws(() => assertModelExists(models, "gateway", "不存在"), /Fast, Slow/);
});
