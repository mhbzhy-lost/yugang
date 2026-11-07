/**
 * 验模型：读 config/models.json 的角色表 → 跑一次最小补全 → 打印模型、耗时、用量。
 *
 *   npm run ping
 *
 * 模型选择只认 config/models.json 的 models.main / models.vision / models.vision_fallback / models.image，
 * 没有环境变量、没有启动参数。凭据只在进程内存里，输出里只有"已加载 / N 字符"和来源路径。
 */
import { createFishModels, assertModelExists } from "../src/model/models.ts";
import { describeModel, loadFishModels } from "../src/model/config.ts";
import { probeModelConfig } from "../src/model/probe.ts";

const selection = loadFishModels();
const main = selection.main;
const shown = describeModel(main);

console.log("main     :", `${shown.provider}/${shown.model}`);
console.log("vision   :", `${selection.vision.providerId}/${selection.vision.modelId}`);
console.log("image    :", selection.image ? `${selection.image.provider}/${selection.image.modelId}` : "(未配置)");
console.log("baseUrl  :", shown.baseUrl);
console.log("key      :", shown.key, "←", shown.keySource);
console.log("transport:", selection.transport ?? "默认");

const models = createFishModels(main);
assertModelExists(models, main.providerId, main.modelId);

const model = models.getModel(main.providerId, main.modelId)!;
console.log("context  :", model.contextWindow, "| maxTokens:", model.maxTokens, "| input:", model.input.join("+"));

try {
  const result = await probeModelConfig(main);
  console.log("耗时     :", `${result.elapsedMs}ms`);
  console.log("回复     :", JSON.stringify(result.text));
  console.log("用量     :", `in ${result.usage.input} / out ${result.usage.output} / 计费 ${result.usage.cost}`);
  console.log("✓ 通了");
} catch (error) {
  console.error("✗ 模型探测失败：", error instanceof Error ? error.message : String(error));
  process.exit(1);
}
