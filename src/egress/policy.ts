/**
 * 出口策略：结构校验 + 溯源校验。
 *
 * 出口是「一条消息序列」而不是一段文本：模型一次可以连说几句，每句都要单独过检。
 * 这里只做机械判定，返回错误码；给模型看的文案在 prompt/messages.md 里。
 */
import { statSync, readFileSync } from "node:fs";
import { resolve, sep, extname } from "node:path";

export interface EgressLimits {
  maxChars: number;
  maxNewlines: number;
  /** 一次调用最多几条。 */
  maxMessages: number;
  /** 一轮里最多几条。 */
  maxPerRun: number;
  /** 一个群每分钟最多几条。 */
  maxPerMinute: number;
  mediaRoot: string;
  maxMediaBytes: number;
}

export const DEFAULT_LIMITS: Omit<EgressLimits, "mediaRoot"> = {
  maxChars: Infinity, // 字数上限已按主人要求移除；换行限制仍在
  maxNewlines: Infinity, // 换行限制已按主人要求移除
  maxMessages: 3,
  maxPerRun: 3,
  maxPerMinute: Infinity, // 每分钟条数限制已按主人要求移除
  // media 只转发文件不进模型上下文，QQ 端容量大：媒体大小限制放宽到 32MB
  maxMediaBytes: 32 * 1024 * 1024,
};

export interface EgressIntent {
  messages: readonly string[];
  media?: string;
}

export interface RecentMessage {
  text: string;
  at: number;
}

export interface EgressContext {
  limits: EgressLimits;
  now: number;
  recent: readonly RecentMessage[];
  sentThisRun: number;
  secrets: readonly string[];
}

export interface Rejection {
  code: RejectionCode;
  vars?: Record<string, string>;
  /** 第几条出的问题，从 0 开始。 */
  index?: number;
}

export const REJECTION_CODES = [
  "empty",
  "too_many_messages",
  "too_long",
  "markdown",
  "secret",
  "duplicate",
  "quota_run",
  "provenance",
  "media_outside",
  "media_missing",
  "media_type",
  "media_big",
  "media_magic",
] as const;

export type RejectionCode = (typeof REJECTION_CODES)[number];

/** null 表示放行。 */
export function validateOutbound(intent: EgressIntent, ctx: EgressContext): Rejection | null {
  const messages = (intent.messages ?? []).map((m) => (m ?? "").trim());

  if (messages.length === 0) return { code: "empty" };
  if (messages.length > ctx.limits.maxMessages) return { code: "too_many_messages" };

  // 带 media 的发送（画完的图/表情）是画图链路的必要出口，不占每轮额度；
  // 纯文字照旧防话痨。
  if (!intent.media && ctx.sentThisRun + messages.length > ctx.limits.maxPerRun) {
    return { code: "quota_run", vars: { count: String(ctx.sentThisRun) } };
  }

  for (const [index, text] of messages.entries()) {
    const single = validateOne(text, ctx);
    if (single) return { ...single, index };
    if (ctx.recent.some((m) => sameText(m.text, text))) return { code: "duplicate", index };
  }

  if (intent.media !== undefined) {
    const media = validateMedia(intent.media, ctx.limits);
    if (media) return media;
  }

  return null;
}

function validateOne(text: string, ctx: EgressContext): Rejection | null {
  if (text.length === 0) return { code: "empty" };
  if (text.length > ctx.limits.maxChars) {
    return { code: "too_long", vars: { length: String(text.length), limit: String(ctx.limits.maxChars) } };
  }

  const markup = findMarkup(text);
  if (markup) return { code: "markdown", vars: { what: markup } };

  const secret = findSecret(text);
  if (secret) return { code: "secret", vars: { what: secret } };

  const overlap = findProvenanceLeak(text, ctx.secrets);
  if (overlap) return { code: "provenance", vars: { overlap: String(overlap) } };

  return null;
}


const MARKUP_RULES: readonly [RegExp, string][] = [
  [/^#{1,6}\s/m, "markdown 标题"],
  [/```/, "代码块"],
  [/^\s*([-*+]|\d+[.)])\s/m, "列表"],
  [/^\s*\|.*\|\s*$/m, "表格"],
  [/\*\*[^*\n]+\*\*/, "加粗"],
  [/^>\s/m, "引用块"],
];

function findMarkup(text: string): string | null {
  for (const [re, what] of MARKUP_RULES) if (re.test(text)) return what;
  return null;
}

const SECRET_RULES: readonly [RegExp, string][] = [
  [/sk-[A-Za-z0-9_-]{8,}/, "里面有疑似 API key"],
  [/\/(Users|home)\/[^\s，。]+/, "里面有本机绝对路径"],
  [/~\/[^\s，。]+/, "里面有本机路径"],
  [/\bey[A-Za-z0-9_-]{10,}\./, "里面有疑似 token"],
  [/\bBearer\s+[A-Za-z0-9._-]{10,}/, "里面有鉴权头"],
];

function findSecret(text: string): string | null {
  for (const [re, what] of SECRET_RULES) if (re.test(text)) return what;
  return null;
}

const IMAGE_EXT = new Set([".png", ".jpg", ".jpeg", ".gif", ".webp"]);
const MAGIC: readonly Buffer[] = [
  Buffer.from([0x89, 0x50, 0x4e, 0x47]),
  Buffer.from([0xff, 0xd8, 0xff]),
  Buffer.from("GIF8"),
];

/** 判断一个媒体路径能否发出去；look 工具也复用它。 */
export function validateMedia(rawPath: string, limits: EgressLimits): Rejection | null {
  const root = resolve(limits.mediaRoot);
  const full = resolve(root, rawPath);
  if (full !== root && !full.startsWith(root + sep)) return { code: "media_outside" };

  const ext = extname(full).toLowerCase();
  if (!IMAGE_EXT.has(ext)) return { code: "media_type", vars: { ext: ext || "(无)" } };

  try {
    const st = statSync(full);
    if (!st.isFile()) return { code: "media_missing" };
    if (st.size > limits.maxMediaBytes) {
      return { code: "media_big", vars: { size: (st.size / 1048576).toFixed(1) } };
    }
    const head = readFileSync(full).subarray(0, 16);
    const isImage =
      MAGIC.some((sig) => head.subarray(0, sig.length).equals(sig)) ||
      (head.subarray(0, 4).toString("ascii") === "RIFF" && head.subarray(8, 12).toString("ascii") === "WEBP");
    if (!isImage) return { code: "media_magic" };
  } catch {
    return { code: "media_missing" };
  }
  return null;
}

/** 待发文本与 secret 的最长连续重合长度，达到阈值即判为抄写。 */
export function findProvenanceLeak(text: string, secrets: readonly string[], minOverlap = 24): number | null {
  if (text.length < minOverlap) return null;
  for (const secret of secrets) {
    if (!secret || secret.length < minOverlap) continue;
    const n = longestCommonSubstring(text, secret);
    if (n >= minOverlap) return n;
  }
  return null;
}

/** 经典 DP，带长度上限早退；文本都很短，够用。 */
export function longestCommonSubstring(a: string, b: string): number {
  if (a.length === 0 || b.length === 0) return 0;
  let prev = new Uint16Array(b.length + 1);
  let cur = new Uint16Array(b.length + 1);
  let best = 0;
  for (let i = 1; i <= a.length; i++) {
    for (let j = 1; j <= b.length; j++) {
      if (a.charCodeAt(i - 1) === b.charCodeAt(j - 1)) {
        const v = prev[j - 1] + 1;
        cur[j] = v;
        if (v > best) best = v;
      } else {
        cur[j] = 0;
      }
    }
    const tmp = prev;
    prev = cur;
    cur = tmp;
  }
  return best;
}

function sameText(a: string, b: string): boolean {
  return normalize(a) === normalize(b);
}

function normalize(text: string): string {
  return text.replace(/[\s，。！？、,.!?~～…]/g, "").toLowerCase();
}
