/**
 * 每个群的出口账本：最近说了什么、本轮说了几条、最近有哪些「秘密」文本。
 *
 * v0 放在内存里。durable 化的做法是把 recent 与 sentThisRun 存成 conversation doc，
 * secrets 只放内存（它只服务当轮溯源校验，重启后丢一次不致命）。
 */

export interface LedgerEntry {
  text: string;
  at: number;
}

export interface Ledger {
  recent: LedgerEntry[];
  secrets: string[];
  /** 本轮已经发出去的条数（不是调用次数）。 */
  sentThisRun: number;
  lastReact?: { emoji: string; at: number };
  /** 本轮看过几张图。 */
  lookedThisRun: number;
  /** 本轮发过几张图（表情/画作），用来卡「一轮一张」。 */
  mediaThisRun: number;
  /** 上一次发表情包的时间：跨轮共用的冷却，防止每句话都配图。 */
  lastMemeAt?: number;
  /** 上一次发语音的时间：语音更打扰，另设一道更长的冷却。 */
  lastVoiceAt?: number;
}

const ledgers = new Map<string, Ledger>();

export function ledgerOf(conversationId: string): Ledger {
  let l = ledgers.get(conversationId);
  if (!l) {
    l = { recent: [], secrets: [], sentThisRun: 0, lookedThisRun: 0, mediaThisRun: 0 };
    ledgers.set(conversationId, l);
  }
  return l;
}

export function resetRun(conversationId: string): void {
  const l = ledgerOf(conversationId);
  l.sentThisRun = 0;
  l.mediaThisRun = 0;
}

export function recordVoice(conversationId: string, now: number): void {
  const l = ledgerOf(conversationId);
  l.mediaThisRun++;
  l.lastVoiceAt = now;
}

export function recordMedia(conversationId: string, now: number, meme = false): void {
  const l = ledgerOf(conversationId);
  l.mediaThisRun++;
  if (meme) l.lastMemeAt = now;
}

export function recordSent(conversationId: string, texts: readonly string[], now: number): void {
  const l = ledgerOf(conversationId);
  for (const text of texts) l.recent.push({ text, at: now });
  if (l.recent.length > 200) l.recent.splice(0, l.recent.length - 200);
  l.sentThisRun += texts.length;
}

export function recordReact(conversationId: string, emoji: string, now: number): void {
  ledgerOf(conversationId).lastReact = { emoji, at: now };
}

export function recordLook(conversationId: string): void {
  ledgerOf(conversationId).lookedThisRun++;
}

export function resetLook(conversationId: string): void {
  ledgerOf(conversationId).lookedThisRun = 0;
}

/** 把本轮的思考 / 工具结果记进 secrets。只保留最近若干段，避免无界增长。 */
export function rememberSecrets(conversationId: string, texts: readonly string[], keep = 40): void {
  const l = ledgerOf(conversationId);
  for (const t of texts) {
    if (typeof t === "string" && t.trim().length > 0) l.secrets.push(t);
  }
  if (l.secrets.length > keep) l.secrets.splice(0, l.secrets.length - keep);
}

export function clearSecrets(conversationId: string): void {
  ledgerOf(conversationId).secrets.length = 0;
}
