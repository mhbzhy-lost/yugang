/**
 * 外部不可信文本的清洗（外部信息源计划全局约束 / P0-5）。
 *
 * B 站标题、简介、热评、弹幕、RSS 正文全是陌生人的输入：进鱼嘴之前统一在这里洗——
 * 双向排版符（bidi）与零宽字符剔除（不可见注入载体）、控制字符替换为空格并收敛空白、
 * 按码点长度截断。工具层（bili_hot / bili_video）与新闻客户端共用这两个入口，
 * 不许各处自写正则。
 */

/** 单段外部文本的缺省长度上限（字）：标题/摘要类足够，调用方可按场景收窄。 */
export const EXTERNAL_TEXT_MAX = 200;

/** URL 长度上限：正常链接远到不了，超长基本是垃圾或攻击载荷。 */
export const EXTERNAL_URL_MAX = 2048;

export interface SanitizeTextOptions {
  /** 截断上限（按 Unicode 码点数，不劈开代理对）；缺省 EXTERNAL_TEXT_MAX。 */
  maxLen?: number;
}

/** 双向排版控制符：LRM/RLM/嵌录与隔离符，能让「看到的顺序」和「逻辑顺序」不一致。 */
const BIDI_RE = /[\u061C\u200E\u200F\u202A-\u202E\u2066-\u2069]/g;

/** 零宽字符：零宽空格/连接符/非断字符/软连字符/BOM，肉眼不可见，常被用来夹带关键词。 */
const ZERO_WIDTH_RE = /[\u00AD\u200B\u200C\u200D\u2060\uFEFF]/g;

/** 控制字符：C0 全量（含 \t\n\r）与 C1/DEL，一律替换成空格再收敛。 */
const CONTROL_RE = /[\u0000-\u001F\u007F-\u009F]/g;

/**
 * 清洗一段外部文本：剔除 bidi 与零宽字符，控制字符换空格、空白收敛为单空格，
 * 超长按码点截断。非字符串输入（RSS/API 给出 null 之类）一律返回空串。
 */
export function sanitizeExternalText(text: string, options: SanitizeTextOptions = {}): string {
  if (typeof text !== "string" || text.length === 0) return "";
  const maxLen = options.maxLen ?? EXTERNAL_TEXT_MAX;
  const cleaned = text
    .replace(BIDI_RE, "")
    .replace(ZERO_WIDTH_RE, "")
    .replace(CONTROL_RE, " ")
    .split(/\s+/)
    .filter(Boolean)
    .join(" ")
    .trim();
  if (cleaned.length <= maxLen) return cleaned;
  return [...cleaned].slice(0, maxLen).join("");
}

/**
 * 清洗一个外部 URL：剔除不可见字符后必须是合法的 http(s) 绝对地址且不超长，
 * 通过则返回规整后的绝对 URL，否则返回 undefined（调用方丢弃即可，不必抛错）。
 * scheme 白名单是硬边界：javascript:/data:/file: 等在这里就死。
 */
export function sanitizeUrl(url: string): string | undefined {
  if (typeof url !== "string") return undefined;
  const candidate = url.replace(CONTROL_RE, "").replace(BIDI_RE, "").replace(ZERO_WIDTH_RE, "").trim();
  if (candidate.length === 0 || candidate.length > EXTERNAL_URL_MAX) return undefined;
  let parsed: URL;
  try {
    parsed = new URL(candidate);
  } catch {
    return undefined;
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") return undefined;
  return parsed.toString();
}
