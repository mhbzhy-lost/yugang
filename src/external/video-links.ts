/**
 * B 站 canonical 链接的唯一定义（2026-11-05）。
 *
 * 为什么单独一份：链接既由 video 工具渲染给模型（它看过的视频必须能直接抄这条发出去），
 * 又由 say_words 的出口白名单按 BV 认（链接写法可能带 query / 尾斜杠，按字符串比会漏）。
 * 两处必须是同一套 URL 形与同一个 BV 提取规则，否则又会出现「看过了却发不出来」。
 *
 * 只认 bilibili.com 域（含子域）下的 /video/<BV>，其它域即使带 BV 字样也不算——
 * 白名单不能变成「任意站点 + 一个 BV」就能过。
 */

const VIDEO_URL_PREFIX = "https://www.bilibili.com/video/";
const OPUS_URL_PREFIX = "https://www.bilibili.com/opus/";

/** 视频 canonical 链接：`https://www.bilibili.com/video/<BV>`。 */
export function biliVideoUrl(bvid: string): string {
  return `${VIDEO_URL_PREFIX}${bvid}`;
}

/** 图文动态 canonical 链接：`https://www.bilibili.com/opus/<id>`。 */
export function biliOpusUrl(opusId: string): string {
  return `${OPUS_URL_PREFIX}${opusId}`;
}

/** 从 URL 里认 BV 号：只认 bilibili.com 域（含子域）+ `/video/` 路径，其它一律 undefined。 */
export function bvidOfUrl(url: string): string | undefined {
  if (!/^https?:\/\/(?:[a-z0-9-]+\.)*bilibili\.com\//i.test(url)) return undefined;
  return url.match(/BV[0-9A-Za-z]{10}/)?.[0];
}
