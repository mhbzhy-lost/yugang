/**
 * 记忆的轮内作用域：提交一轮前把「在场人物 + 本轮正文」压进队列，
 * memory section 渲染时按 conversationId 取出（只读），轮结束弹出。
 *
 * 队列只活在内存里，最多 8 个待执行 scope：塞满时 pushScope 返回 undefined，
 * 该轮不注入记忆（宁可少注入，不能挤掉仍会执行的旧 scope）。
 */

/** 一轮的在场人物与正文：speakers 顺序就是注入优先级。 */
export interface RoundScope {
  speakers: { subject: string; name: string }[];
  text: string;
}

/** 每个会话最多保留多少个待执行 scope；超过就不再受理新的。 */
const MAX_PENDING_SCOPES = 8;

const scopes = new Map<string, { token: string; scope: RoundScope }[]>();

/** 原始 chatKey（可能带 `#人格` 后缀）→ 记忆 key：人格不参与记忆隔离，同群人格共享一份。 */
export function memoryKeyOf(chatKey: string): string {
  const at = chatKey.lastIndexOf("#");
  return at > 0 ? chatKey.slice(0, at) : chatKey;
}

/** 压入一轮的 scope；队列满时返回 undefined，该轮不注入记忆。 */
export function pushScope(conversationId: string, scope: RoundScope): string | undefined {
  const queue = scopes.get(conversationId) ?? [];
  if (queue.length >= MAX_PENDING_SCOPES) return undefined;
  const token = `s-${Math.random().toString(36).slice(2, 10)}${Date.now().toString(36)}`;
  queue.push({ token, scope });
  scopes.set(conversationId, queue);
  return token;
}

/** 取队首 scope（最老的那轮正在跑）；没有就 undefined。 */
export function peekScope(conversationId: string): RoundScope | undefined {
  return scopes.get(conversationId)?.[0]?.scope;
}

/** 弹出 scope：优先按 token 删除，无 token 时删队首；队列空了就删 key。 */
export function shiftScope(conversationId: string, token?: string): void {
  const queue = scopes.get(conversationId);
  if (!queue) return;
  const index = token === undefined ? 0 : queue.findIndex((item) => item.token === token);
  if (index >= 0) queue.splice(index, 1);
  if (queue.length === 0) scopes.delete(conversationId);
  else scopes.set(conversationId, queue);
}
