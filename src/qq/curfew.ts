/**
 * 宵禁（本地 00:00–08:00，2026-11-05 由 02:00–09:00 调整）：夜间纯搭话，不逛 B 站、不分享素材。
 *
 * 单一实现，两个消费面都读这里：
 * - `src/engage-next.ts` 的开窗视频浏览门：宵禁内门恒关 → 不起「主动交流机会」轮，
 *   `bili_hot` / `video` / `say_words(videoBvid)` 的浏览授权随之全部失效（fail closed，
 *   不靠模型自觉）；
 * - 旧弹药链（`src/tools/say-shared.ts` 的 `ammoCurfewAt` 别名，现仅 disabled 的
 *   `ammo_list` 与已停用的 ammoId 分支引用）。
 *
 * 阈值与 `ctx_engage_footer_night` 的文案二态同阈，改时段只改这里，不要去改调用点。
 */

export const CURFEW_START_HOUR = 0;
export const CURFEW_END_HOUR = 8;

/** 该时刻是否落在宵禁内（按本机时区的小时判定，与 localDay 同基准）。 */
export function isCurfewAt(nowMs: number): boolean {
  const hour = new Date(nowMs).getHours();
  return hour >= CURFEW_START_HOUR && hour < CURFEW_END_HOUR;
}
