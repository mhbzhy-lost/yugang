/**
 * draw_remote 的独立秘密脱敏。
 *
 * 上游错误正文、安全拒答文本在回给模型之前必须先过这里，再过 sanitizeExternalText
 * （硬约束 17：外部文本一律清洗后才见模型）。
 *
 * 有意不复用 src/model/quota.ts 的 redactSecrets：那是额度查询模块的实现细节，生图链路
 * 反向依赖它等于把两件事绑死。两边规则保持一致——已知秘密字面量 + 通用凭证形态。
 */
import { sanitizeExternalText } from "../../external/sanitize.ts";

/** 秘密的可能来源：凭据对象里的 key / access / refresh / clientSecret 字段（保留纵深防御）。 */
export type SecretSource = Record<string, unknown> | null | undefined;

const SECRET_FIELDS = ["access", "refresh", "key", "clientSecret"] as const;

/** 收集已知秘密字面量；短于 6 个字符的不收，免得把短值到处替换成星号。 */
export function collectSecrets(...sources: SecretSource[]): string[] {
  const secrets: string[] = [];
  for (const source of sources) {
    if (!source) continue;
    for (const field of SECRET_FIELDS) {
      const value = source[field];
      if (typeof value === "string" && value.length >= 6) secrets.push(value);
    }
  }
  return secrets;
}

/** 抹除已知秘密字面量 + 通用 Bearer / sk- / x-goog-api-key / AIza / ?key= / ya29 形态。 */
export function redactSecrets(text: string, secrets: readonly string[]): string {
  let out = text;
  // 长的先换：一个秘密是另一个的前缀时不会留下尾巴
  for (const secret of [...secrets].filter((value) => value.length >= 4).sort((a, b) => b.length - a.length)) {
    out = out.split(secret).join("***");
  }
  out = out.replace(/Bearer\s+[A-Za-z0-9._~+/=-]+/gi, "Bearer ***");
  out = out.replace(
    /(\\"|")((?:x-goog-api-key|api[_-]?key|access[_-]?token|refresh[_-]?token|client[_-]?secret))\1\s*:\s*\1(?:\\.|[^"\\])*\1/gi,
    "$1$2$1: $1***$1",
  );
  out = out.replace(/((?:x-goog-api-key|api[_-]?key)\s*[:=]\s*)[^\s,;"]+/gi, "$1***");
  out = out.replace(/([?&](?:api_)?key=)[^\s&"']+/gi, "$1***");
  out = out.replace(/\bAIza[A-Za-z0-9_-]{20,}/g, "***");
  out = out.replace(/\bya29\.[A-Za-z0-9._-]{10,}/g, "***");
  out = out.replace(/\bsk-[A-Za-z0-9_-]{6,}/g, "***");
  return out;
}

/**
 * 上游文本出境前的唯一通道：脱敏 → 清洗（bidi / 零宽 / 控制字符、空白收敛、按码点截断）→ 再脱敏一次。
 * 第二次不是多余：夹在秘密中间的零宽字符被清洗掉之后字面量才复原，只做第一遍会漏。
 */
export function cleanUpstreamText(text: string, secrets: readonly string[], maxLen = 300): string {
  const cleaned = sanitizeExternalText(redactSecrets(text, secrets), { maxLen });
  return redactSecrets(cleaned, secrets);
}
