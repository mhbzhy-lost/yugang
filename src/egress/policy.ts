/**
 * 出口策略：结构校验 + 溯源校验。
 *
 * 设计前提（见 README）：agent 的正文、思考、tool 调用文本一律不出境，
 * 「发到群里」是一次显式的 say() 调用。因此这里唯一的职责是：
 * 判断一次 say() 的参数是否可以被放行。
 *
 * 校验只做两类事：
 *  1. 结构性 —— 长度、换行、markdown、路径、类型、文件真实性
 *  2. 溯源性 —— 待发文本是否是从本轮思考 / tool 结果里抄来的
 *
 * 两类都是机械判定，不做「看起来像不像 AI」的语义猜测。
 */
import { statSync, readFileSync } from "node:fs";
import { resolve, sep, extname } from "node:path";

export interface EgressLimits {
  /** 单条消息最大字数。思考 dump 通常是长文本，这条最有效。 */
  maxChars: number;
  /** 单条消息最大换行数。 */
  maxNewlines: number;
  /** 一轮里最多说几条。 */
  maxPerRun: number;
  /** 一个群每分钟最多几条。 */
  maxPerMinute: number;
  /** 媒体文件的合法根目录（绝对路径）。 */
  mediaRoot: string;
  maxMediaBytes: number;
}

export const DEFAULT_LIMITS: Omit<EgressLimits, "mediaRoot"> = {
  maxChars: 120,
  maxNewlines: 2,
  maxPerRun: 3,
  maxPerMinute: 6,
  maxMediaBytes: 8 * 1024 * 1024,
};

export interface EgressMessage {
  text: string;
  media?: string;
}

export interface RecentMessage {
  text: string;
  at: number;
}

export interface EgressContext {
  limits: EgressLimits;
  now: number;
  /** 该群最近的已发消息，用于去重与限速。 */
  recent: readonly RecentMessage[];
  /** 本轮已发条数。 */
  sentThisRun: number;
  /** 该对话最近若干轮的 secret 文本（思考 + tool 结果），用于溯源校验。 */
  secrets: readonly string[];
}

/** 返回 null 表示放行；返回字符串表示拒绝原因（会作为 tool 错误回给模型）。 */
export function validateOutbound(msg: EgressMessage, ctx: EgressContext): string | null {
  const text = msg.text ?? "";
  const trimmed = text.trim();

  if (trimmed.length === 0) return "空消息，没什么可说的";
  if (trimmed.length > ctx.limits.maxChars) {
    return `太长了（${trimmed.length} > ${ctx.limits.maxChars} 字），压成一句群里的话再说`;
  }
  if (countNewlines(trimmed) > ctx.limits.maxNewlines) {
    return "换行太多，群聊里就是一句话，不要排版";
  }

  const markup = findMarkup(trimmed);
  if (markup) return markup;

  const secret = findSecret(trimmed);
  if (secret) return secret;

  if (msg.media !== undefined) {
    const mediaError = validateMedia(msg.media, ctx.limits);
    if (mediaError) return mediaError;
  }

  if (ctx.sentThisRun >= ctx.limits.maxPerRun) {
    return `这一轮已经说了 ${ctx.sentThisRun} 条，够了，别刷屏`;
  }
  const minuteAgo = ctx.now - 60_000;
  const recentMinute = ctx.recent.filter((m) => m.at >= minuteAgo);
  if (recentMinute.length >= ctx.limits.maxPerMinute) {
    return "这个群一分钟内已经说得够多了，先闭嘴";
  }
  if (recentMinute.some((m) => sameText(m.text, trimmed))) {
    return "刚刚说过一模一样的话，换个说法或者不说";
  }

  const leak = findProvenanceLeak(trimmed, ctx.secrets);
  if (leak) return `这段是从思考或工具结果里抄的（连续 ${leak} 字重合），自己重新说一遍`;

  return null;
}

// ---------------------------------------------------------------- 结构校验

function countNewlines(text: string): number {
  let n = 0;
  for (const ch of text) if (ch === "\n") n++;
  return n;
}

const MARKUP_RULES: readonly [RegExp, string][] = [
  [/^#{1,6}\s/m, "不要用 markdown 标题"],
  [/```/, "不要用代码块"],
  [/^\s*([-*+]|\d+[.)])\s/m, "不要用列表，群聊就是说话"],
  [/^\s*\|.*\|\s*$/m, "不要用表格"],
  [/\*\*[^*\n]+\*\*/, "不要用加粗"],
  [/^>\s/m, "不要用引用块"],
];

function findMarkup(text: string): string | null {
  for (const [re, reason] of MARKUP_RULES) if (re.test(text)) return reason;
  return null;
}

const SECRET_RULES: readonly [RegExp, string][] = [
  [/sk-[A-Za-z0-9_-]{8,}/, "里面有疑似 API key"],
  [/\/Users\/[^\s，。]+/, "里面有本机绝对路径"],
  [/\/home\/[^\s，。]+/, "里面有本机绝对路径"],
  [/~\/[^\s，。]+/, "里面有本机路径"],
  [/\bey[A-Za-z0-9_-]{10,}\./, "里面有疑似 token"],
  [/\bBearer\s+[A-Za-z0-9._-]{10,}/, "里面有鉴权头"],
];

function findSecret(text: string): string | null {
  for (const [re, reason] of SECRET_RULES) if (re.test(text)) return reason;
  return null;
}

const IMAGE_EXT = new Set([".png", ".jpg", ".jpeg", ".gif", ".webp"]);
const MAGIC: readonly [Buffer, string][] = [
  [Buffer.from([0x89, 0x50, 0x4e, 0x47]), ".png"],
  [Buffer.from([0xff, 0xd8, 0xff]), ".jpg"],
  [Buffer.from("GIF8"), ".gif"],
];

function validateMedia(rawPath: string, limits: EgressLimits): string | null {
  const root = resolve(limits.mediaRoot);
  const full = resolve(root, rawPath);
  if (full !== root && !full.startsWith(root + sep)) return "图片路径不在媒体目录里";

  const ext = extname(full).toLowerCase();
  if (!IMAGE_EXT.has(ext)) return `不支持的图片格式：${ext || "(无)"}`;
  // .webp 用 RIFF....WEBP，单独判定
  try {
    const st = statSync(full);
    if (!st.isFile()) return "那不是个文件";
    if (st.size > limits.maxMediaBytes) return `图片太大了（${(st.size / 1048576).toFixed(1)}MB）`;
    const head = readFileSync(full).subarray(0, 16);
    const magicOk =
      MAGIC.some(([sig]) => head.subarray(0, sig.length).equals(sig)) ||
      (head.subarray(0, 4).toString("ascii") === "RIFF" && head.subarray(8, 12).toString("ascii") === "WEBP");
    if (!magicOk) return "文件头不是图片，拒绝发送";
  } catch {
    return "找不到这个图片文件";
  }
  return null;
}

// ---------------------------------------------------------------- 溯源校验

/** 待发文本与 secret 文本的最长连续重合长度，达到阈值即判为抄写。 */
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
