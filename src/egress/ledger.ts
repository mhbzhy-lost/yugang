/**
 * 每个群的出口账本：最近说了什么、最近有哪些「秘密」文本。
 *
 * v0 放在内存里。durable 化的做法是把 recent 存成 conversation doc，
 * secrets 只放内存（它只服务当轮溯源校验，重启后丢一次不致命）。
 * 每轮开口次数的门禁不在账本里（sentThisRun 已删），由 say-shared 的轮闸统一管。
 */

export interface LedgerEntry {
  text: string;
  at: number;
}

export interface Ledger {
  recent: LedgerEntry[];
  secrets: string[];
  lastReact?: { emoji: string; at: number };
  /** 上一次发表情包的时间：跨轮共用的冷却，防止每句话都配图。 */
  lastMemeAt?: number;
}

const ledgers = new Map<string, Ledger>();

export function ledgerOf(conversationId: string): Ledger {
  let l = ledgers.get(conversationId);
  if (!l) {
    l = { recent: [], secrets: [] };
    ledgers.set(conversationId, l);
  }
  return l;
}

export function recordSent(conversationId: string, texts: readonly string[], now: number): void {
  const l = ledgerOf(conversationId);
  for (const text of texts) l.recent.push({ text, at: now });
  if (l.recent.length > 200) l.recent.splice(0, l.recent.length - 200);
}

export function recordReact(conversationId: string, emoji: string, now: number): void {
  ledgerOf(conversationId).lastReact = { emoji, at: now };
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
