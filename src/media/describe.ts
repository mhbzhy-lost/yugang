/**
 * 把一张图交给视觉模型，换回一段文字描述。
 *
 * 什么时候走这一层：主模型与视觉模型不是同一个、或主模型不在 inline 白名单时，
 * 看图一律「图 → 文字」，主会话只有文本（路由开关在 src/index.ts 的 inlineImages）。
 *
 * 历史教训：图片 inline 进主会话曾在旧网关（zai/glm 链路）把网关撞挂，当时全面回退到本层。
 * 如今条件式 inline 已重新上线（仅限已验证的 Gemini 订阅通道；压图 1280px/50KB/q80、
 * 换页丢弃、适配器剥图降级，见 docs/plans/2026-11-01-inline-vision.md），本层继续服务其余全部场景。
 *
 * 失败分类（线上实锤：zai 视觉通道两类错误曾被同一策略盲目重试）：
 *   - 429 / code 1302 速率限制：瞬态，但重试太急必然再 429 → 秒级真退避（2.5s、6s），总尝试 ≤3
 *   - 400 / code 1301 内容安全：确定性，同一张图永远被拒 → 立即 filtered，不重试
 *   - 其它错误 / 空结果：维持原来的 3 次小退避
 * 配了兜底视觉模型（models.vision_fallback）时，主模型 failed/filtered 后用它再试一轮；
 * 兜底沿用同一套分类与退避，自身不再套兜底。
 */
import type { Models } from "@earendil-works/pi-ai";
import type { PromptSet } from "../prompts.ts";

export interface DescribeDeps {
  models?: Models;
  /** 视觉描述用的模型；缺省不描述（返回 failed）。 */
  visionModel?: { provider: string; modelId: string };
  /** 兜底视觉模型；缺省 = 无兜底（不隐式兜底）。 */
  visionFallbackModel?: { provider: string; modelId: string };
  prompts: PromptSet;
}

/** 看图结果可判别；失败标注走了哪条链：filtered/failed 是主模型，fallback_* 是兜底也倒下。 */
export type DescribeResult =
  | { ok: true; text: string }
  | { ok: false; reason: "filtered" | "failed" | "fallback_filtered" | "fallback_failed" };

/** 内容审核拒（主模型或兜底）：确定性失败，这张图看不了，调用方该说的是「换一张」。 */
export function isDescribeFiltered(result: DescribeResult): boolean {
  return !result.ok && (result.reason === "filtered" || result.reason === "fallback_filtered");
}

type ChatModel = NonNullable<ReturnType<Models["getModel"]>>;

/** 单次请求的结局：ok 拿文本；失败带原因标签（打日志用）与细节（不含图片内容与凭据）。 */
type AttemptOutcome =
  | { ok: true; text: string }
  | { ok: false; kind: "rate_limited" | "content_filtered" | "empty" | "error"; detail: string };

/** 限流真退避的两档间隔；第 3 次仍限流就放弃。 */
const RATE_LIMIT_WAITS_MS = [2_500, 6_000] as const;
const MAX_ATTEMPTS = 3;

export async function describeImage(deps: DescribeDeps, base64: string, mimeType: string): Promise<DescribeResult> {
  if (!deps.models || !deps.visionModel) return { ok: false, reason: "failed" };
  // streamSimple 只接受完整 model 对象：传 {provider, modelId} 引用会让
  // pi-ai 内部 model.input 取不到而抛错（describe 永远失败 → 退回原图 → 卡死）
  const model = deps.models.getModel(deps.visionModel.provider, deps.visionModel.modelId);
  if (!model) return { ok: false, reason: "failed" };
  const promptText = deps.prompts.messages["look_describe"] ?? "描述这张图";

  const first = await describeWithModel(deps.models, model, promptText, base64, mimeType);
  if (first.ok) return first;

  // 兜底：没配就是无兜底（行为与原来一致）；配成和主模型同一个也不值得再试
  const ref = deps.visionFallbackModel;
  if (!ref || (ref.provider === deps.visionModel.provider && ref.modelId === deps.visionModel.modelId)) return first;
  const fallback = deps.models.getModel(ref.provider, ref.modelId);
  if (!fallback) {
    console.warn("[鱼缸] 看图兜底模型未挂载");
    return first;
  }
  console.warn(`[鱼缸] 主看图倒下（${first.reason}），走兜底`);
  const second = await describeWithModel(deps.models, fallback, promptText, base64, mimeType);
  if (second.ok) {
    console.log("[鱼缸] 看图走兜底 ok");
    return second;
  }
  // 兜底也败/也拒：reason 标注最终走了哪条链
  return { ok: false, reason: second.reason === "filtered" ? "fallback_filtered" : "fallback_failed" };
}

/** 单模型一轮完整尝试：按失败分类走不同退避；终局只有 filtered / failed 两种。 */
async function describeWithModel(
  models: Models,
  model: ChatModel,
  promptText: string,
  base64: string,
  mimeType: string,
): Promise<{ ok: true; text: string } | { ok: false; reason: "filtered" | "failed" }> {
  let rateLimitStrikes = 0;
  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
    const outcome = await attemptOnce(models, model, promptText, base64, mimeType);
    if (outcome.ok) return outcome;
    if (outcome.kind === "content_filtered") {
      // 内容审核是确定性拒绝：重试纯浪费还拖慢轮次，立即放弃
      console.warn(`[鱼缸] 看图被滤 content_filtered ${outcome.detail}`.trim());
      return { ok: false, reason: "filtered" };
    }
    if (attempt === MAX_ATTEMPTS) {
      console.warn(`[鱼缸] 看图放弃 ${outcome.kind} 第${attempt}次 ${outcome.detail}`.trim());
      break;
    }
    // 429 重试太急必然再 429：限流走秒级真退避；空结果/其它错误沿用原来的小退避
    const waitMs = outcome.kind === "rate_limited"
      ? RATE_LIMIT_WAITS_MS[Math.min(rateLimitStrikes++, RATE_LIMIT_WAITS_MS.length - 1)]
      : 400 * attempt;
    const what = outcome.kind === "empty" ? "描述为空" : "失败";
    console.warn(`[鱼缸] 看图${what} ${outcome.kind} 第${attempt}次 ${waitMs}ms ${outcome.detail}`.trim());
    await new Promise((r) => setTimeout(r, waitMs));
  }
  return { ok: false, reason: "failed" };
}

/** 发一次描述请求并归一结局：错误 stop 视同失败分类，普通空正文按 empty。 */
async function attemptOnce(
  models: Models,
  model: ChatModel,
  promptText: string,
  base64: string,
  mimeType: string,
): Promise<AttemptOutcome> {
  try {
    // 显式 maxTokens：不传时服务端用一个很小的默认额度，推理模型的思考内容会把额度吃光，
    // 正文变空——表现就是「识图时好时坏」。
    const stream = models.streamSimple(model, {
      messages: [
        {
          role: "user",
          content: [
            { type: "image", data: base64, mimeType },
            { type: "text", text: promptText },
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
    if (text) return { ok: true, text };
    const detail = `stop=${message.stopReason} ${message.errorMessage ?? ""}`.trim();
    if (message.stopReason === "error") return { ...classifyFailure(detail), detail };
    return { ok: false, kind: "empty", detail };
  } catch (error) {
    // 不静默：描述失败的原因要能在日志里看到（不含图片内容与凭据）
    const detail = error instanceof Error ? error.message : String(error);
    return { ...classifyFailure(detail, statusOf(error)), detail };
  }
}

/** 从错误消息/HTTP 状态识别 zai 网关的两类已知失败：429/1302 限流、400/1301 内容审核。 */
function classifyFailure(detail: string, status?: number): { ok: false; kind: "rate_limited" | "content_filtered" | "error" } {
  const code = detail.match(/"code"\s*:\s*"?(1301|1302)"?/)?.[1];
  if (code === "1302") return { ok: false, kind: "rate_limited" };
  if (code === "1301") return { ok: false, kind: "content_filtered" };
  const http = status ?? Number(detail.match(/(?:^|\s)(\d{3})\s*:/)?.[1] ?? 0);
  if (http === 429) return { ok: false, kind: "rate_limited" };
  if (http === 400) return { ok: false, kind: "content_filtered" };
  return { ok: false, kind: "error" };
}

function statusOf(error: unknown): number | undefined {
  const status = (error as { status?: unknown } | null)?.status;
  return typeof status === "number" ? status : undefined;
}
