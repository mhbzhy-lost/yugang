/**
 * 把一张图交给视觉模型，换回一段文字描述。
 *
 * 为什么要有这一层：图片一旦作为 image block 进主会话，就会永久留在 transcript 里，
 * 每一轮都要重新上传、缓存前缀也不稳（历史上就是这么把网关撞挂的）。
 * 所以看图一律「图 → 文字」，主会话从头到尾只有文本。
 */
import type { Models } from "@earendil-works/pi-ai";
import type { PromptSet } from "../prompts.ts";

export interface DescribeDeps {
  models?: Models;
  /** 视觉描述用的模型；缺省不描述（返回 null）。 */
  visionModel?: { provider: string; modelId: string };
  prompts: PromptSet;
}

export async function describeImage(deps: DescribeDeps, base64: string, mimeType: string): Promise<string | null> {
  if (!deps.models || !deps.visionModel) return null;
  // streamSimple 只接受完整 model 对象：传 {provider, modelId} 引用会让
  // pi-ai 内部 model.input 取不到而抛错（describe 永远失败 → 退回原图 → 卡死）
  const model = deps.models.getModel(deps.visionModel.provider, deps.visionModel.modelId);
  if (!model) return null;
  // 显式 maxTokens：不传时服务端用一个很小的默认额度，推理模型的思考内容会把额度吃光，
  // 正文变空——表现就是「识图时好时坏」。空结果再重试，最多三次。
  for (let attempt = 1; attempt <= 3; attempt++) {
    try {
      const stream = deps.models.streamSimple(model, {
        messages: [
          {
            role: "user",
            content: [
              { type: "image", data: base64, mimeType },
              { type: "text", text: deps.prompts.messages["look_describe"] ?? "描述这张图" },
            ],
          },
        ],
        maxTokens: 1500,
      });
      const message = await stream.result();
      const text = message.content
        .filter((b): b is { type: "text"; text: string } => b.type === "text")
        .map((b) => b.text)
        .join("")
        .trim();
      if (text) return text;
      console.warn(`[鱼缸] 看图描述为空 第${attempt}次 stop=${message.stopReason} ${message.errorMessage ?? ""}`.trim());
    } catch (error) {
      // 不静默：描述失败的原因要能在日志里看到（不含图片内容与凭据）
      console.warn(`[鱼缸] 看图描述失败 第${attempt}次:`, error instanceof Error ? error.message : String(error));
    }
    await new Promise((r) => setTimeout(r, 400 * attempt));
  }
  return null;
}
