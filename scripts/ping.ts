/**
 * 验模型：读 config/models.json 的角色表 → 跑一次最小补全 → 打印模型、耗时、用量。
 *
 *   npm run ping
 *
 * 模型选择只认 config/models.json 的 models.main / models.vision / models.image，
 * 没有环境变量、没有启动参数。凭据只在进程内存里，输出里只有"已加载 / N 字符"和来源路径。
 */
import { createFishModels, assertModelExists } from "../src/models.ts";
import { describeModel, loadFishModels } from "../src/model-config.ts";

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

const started = Date.now();
const stream = models.streamSimple(model, {
  messages: [{ role: "user", content: "只回复两个字：在的" }],
});
const message = await stream.result();
const text = message.content
  .filter((block): block is { type: "text"; text: string } => block.type === "text")
  .map((block) => block.text)
  .join("")
  .trim();

console.log("耗时     :", `${Date.now() - started}ms`);
console.log("回复     :", JSON.stringify(text.slice(0, 60)));
console.log("用量     :", `in ${message.usage.input} / out ${message.usage.output} / 计费 ${message.usage.cost.total}`);
if (!text) {
  console.error("✗ 没有拿到文本，可能模型或网关不匹配");
  process.exit(1);
}
console.log("✓ 通了");
