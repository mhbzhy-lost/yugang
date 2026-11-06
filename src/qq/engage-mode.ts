/**
 * 搭话模式的纯判定（不 import runtime / pi-durable / memory）：
 *
 * 2026-11-06 合并后只有两种模式：GROUPS 群全部 free（自由活动模式），
 * 私聊 / worker / 群外会话 legacy（裁掉群搭话协议段）。开窗两态（next）已退役。
 *
 * chatKey 形如 `qq:group:NNN`（含 `#人格` 后缀也认前缀）。
 */

/** chatKey → 搭话模式：GROUPS 内的群 free；其余（私聊 / worker / 群外）legacy。 */
export function engageModeOf(chatKey: string, groups: readonly string[]): "legacy" | "free" {
  const matched = /^qq:group:(\d+)/.exec(chatKey);
  if (matched === null) return "legacy";
  return groups.includes(matched[1]!) ? "free" : "legacy";
}
