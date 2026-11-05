/**
 * 搭话模式的纯判定（不 import runtime / pi-durable / memory）：
 *
 * - `freeGroupsSafe` 是安全域交集的唯一实现（fish-config 里也用它）：自由活动白名单
 *   只认 `.env GROUPS` 之内的群号，域外的静默失效；
 * - `engageModeOf` 把 chatKey 判成三种搭话模式，宿主（runtime 的 engagementOf）与自检
 *   脚本共用这一份——避免「纯函数验过、接线没接」。
 *
 * chatKey 形如 `qq:group:NNN`（含 `#人格` 后缀也认前缀）；私聊 / worker 会话恒 legacy。
 */
import { freeGroupsSafe, type EngagementMode } from "../fish-config.ts";

/** 群号是否命中自由活动白名单（域外群号在这里被滤掉）。 */
export function freeGroupOf(freeGroups: readonly string[], groups: readonly string[], groupId: string): boolean {
  return freeGroupsSafe(groups, freeGroups).includes(String(groupId));
}

/** chatKey → 搭话模式：群外会话 legacy；GROUPS 内按自由活动白名单分 free / next。 */
export function engageModeOf(chatKey: string, freeGroups: readonly string[], groups: readonly string[]): EngagementMode {
  const matched = /^qq:group:(\d+)/.exec(chatKey);
  if (matched === null) return "legacy";
  const groupId = matched[1] ?? "";
  if (!groups.includes(groupId)) return "legacy";
  return freeGroupOf(freeGroups, groups, groupId) ? "free" : "next";
}
