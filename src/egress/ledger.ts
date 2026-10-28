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
  sentThisRun: number;
}

const ledgers = new Map<string, Ledger>();

export function ledgerOf(conversationId: string): Ledger {
  let l = ledgers.get(conversationId);
  if (!l) {
    l = { recent: [], secrets: [], sentThisRun: 0 };
    ledgers.set(conversationId, l);
  }
  return l;
}

export function resetRun(conversationId: string): void {
  ledgerOf(conversationId).sentThisRun = 0;
}

export function recordSent(conversationId: string, text: string, now: number): void {
  const l = ledgerOf(conversationId);
  l.recent.push({ text, at: now });
  if (l.recent.length > 200) l.recent.splice(0, l.recent.length - 200);
  l.sentThisRun++;
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
