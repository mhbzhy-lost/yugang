/**
 * bili_video —— 终选核实一条 B 站视频（外部计划 Task E3）。
 *
 * bili_hot 的三层漏斗给出候选后，提交入库（ammo_submit）前用这条把最后疑点核掉：
 *   1. 完整数据卡片：播放/弹幕/赞/币/收藏/分享、时长、发布时间、简介、分区（view 端点）；
 *   2. UP 评级：粉丝数/等级/官方认证（card 端点）——软筛信号一并展示，低级号与
 *      营销号在这里现形；
 *   3. 可选口碑信号：热评前 5（每条 ≤50 字，reply 端点）与高能弹幕前 10（dm 端点，
 *      XML 没有点赞数据，用「5 秒桶密度 + 复读次数」近似高能）。
 *
 * 弹幕分段：多 P 视频只取第一段——B 站 view 的 data.cid 即第一段（pages[0]）的 cid，
 * bili-client 映射的就是它，其余分段的弹幕不拉（终选核实不需要逐段）。
 *
 * 不可信数据边界：B 站返回的一切文本（标题/简介/UP 名/分区/认证描述/评论/弹幕）都是
 * 陌生人输入，出本工具前统一过 sanitizeExternalText（bidi/零宽剔除、控制字符收敛、
 * 按码点截断）；数字字段由 bili-client 映射成 number，原始 JSON 不出客户端。
 *
 * 全部 B 站请求经 bili-client 共享单例（频控/预算/熔断与 video、bili_hot 共用一份）。
 * 说明文字与参数 Schema 唯一来自 TOOL.md manifest（factory 只消费它，不再有第二份运行时定义）。
 */
import { defineTool, type ToolRegistration } from "@earendil-works/pi-durable";
import { getBiliClient, isValidBvid, type BiliClient } from "../../external/bili-client.ts";
import { sanitizeExternalText } from "../../external/sanitize.ts";
import { renderTemplate } from "../../prompts.ts";
import { manifestParameters, toolFullDescription } from "../manifest.ts";
import type { ToolManifest, ToolPackageDeps } from "../types.ts";

/** args 静态类型：与 TOOL.md 的参数 Schema 一一对应；运行时 Schema 只有 manifest 这一份。 */
interface BiliVideoArgs {
  bvid: string;
  withComments?: boolean;
  withDanmaku?: boolean;
}

/** 文本字段各自的清洗上限（字）：卡片紧凑可读，口碑信号按合同收窄。 */
const LIMITS = { title: 80, name: 30, tname: 20, desc: 200, officialDesc: 60, reply: 50, danmaku: 40 };
const HOT_REPLIES = 5;
const HIGH_ENERGY = 10;

function fmtDuration(seconds: number): string {
  const total = Math.max(0, Math.floor(seconds));
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = total % 60;
  const p = (n: number): string => String(n).padStart(2, "0");
  return h > 0 ? `${h}:${p(m)}:${p(s)}` : `${m}:${p(s)}`;
}

function fmtDate(unixSeconds: number): string {
  const d = new Date(unixSeconds * 1000);
  const p = (n: number): string => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
}

/** dm/list.so 的 XML 很浅，正则就够（与 video 工具同一套解析口径）；实体不展开，原样清洗。 */
function parseDanmakuXml(xml: string): { time: number; text: string }[] {
  const out: { time: number; text: string }[] = [];
  for (const m of xml.matchAll(/<d p="([^"]+)"[^>]*>([^<]*)<\/d>/g)) {
    const time = Number(m[1].split(",")[0]);
    const text = m[2].trim();
    if (Number.isFinite(time) && text.length > 0) out.push({ time, text });
  }
  return out;
}

/**
 * 高能弹幕挑选：dm/list.so 的 XML 没有点赞数据，「高能」用两个信号近似——
 *   密度：弹幕落进 5 秒桶的条数（刷屏时刻 ≈ 名场面）；
 *   复读：同文本出现次数（玩梗型高能，就是被顶得最多的那批）。
 * 复读加权优先、同权重再比密度；清洗后为空的条目丢弃，最多返回 limit 条。
 */
function pickHighEnergy(danmaku: { time: number; text: string }[], limit: number): string[] {
  const BUCKET_SECONDS = 5;
  const REPEAT_WEIGHT = 100;
  const buckets = new Map<number, number>();
  const repeats = new Map<string, number>();
  const firstSeen = new Map<string, number>();
  for (const d of danmaku) {
    const bucket = Math.floor(d.time / BUCKET_SECONDS);
    buckets.set(bucket, (buckets.get(bucket) ?? 0) + 1);
    repeats.set(d.text, (repeats.get(d.text) ?? 0) + 1);
    if (!firstSeen.has(d.text)) firstSeen.set(d.text, d.time);
  }
  const scored = [...repeats.entries()].map(([text, count]) => ({
    text,
    score: count * REPEAT_WEIGHT + (buckets.get(Math.floor((firstSeen.get(text) ?? 0) / BUCKET_SECONDS)) ?? 0),
  }));
  scored.sort((a, b) => b.score - a.score);
  const out: string[] = [];
  for (const entry of scored) {
    if (out.length >= limit) break;
    const cleaned = sanitizeExternalText(entry.text, { maxLen: LIMITS.danmaku });
    if (cleaned.length > 0) out.push(cleaned);
  }
  return out;
}

/**
 * 渲染一份完整的核实卡片（纯函数接 client，方便注入 mock 做内联验证）。
 * view 失败向上抛（没卡片就没核实）；热评/弹幕/UP 评级任一拉不到只略过对应段落，
 * 不炸整卡。
 */
export async function buildBiliVideoReport(
  client: BiliClient,
  args: { bvid: string; withComments?: boolean; withDanmaku?: boolean },
): Promise<string> {
  const card = await client.view(args.bvid);
  const lines: string[] = [];

  lines.push(`《${sanitizeExternalText(card.title, { maxLen: LIMITS.title })}》`);
  const meta = [
    `UP：${sanitizeExternalText(card.owner.name, { maxLen: LIMITS.name })}`,
    ...(card.tname ? [`分区：${sanitizeExternalText(card.tname, { maxLen: LIMITS.tname })}`] : []),
    `时长：${fmtDuration(card.durationSeconds)}`,
    `发布：${fmtDate(card.pubdate)}`,
  ];
  lines.push(meta.join(" · "));
  const stat = card.stat;
  const count = (n: number): string => n.toLocaleString();
  lines.push(
    `播放 ${count(stat.view)} · 弹幕 ${count(stat.danmaku)} · 赞 ${count(stat.like)}` +
      ` · 币 ${count(stat.coin)} · 收藏 ${count(stat.favorite)} · 分享 ${count(stat.share)}`,
  );
  const desc = sanitizeExternalText(card.desc, { maxLen: LIMITS.desc });
  if (desc) lines.push(`简介：${desc}`);

  // UP 评级（card 端点）：软筛信号，评级段落拉不到不影响主卡片
  if (card.owner.mid > 0) {
    try {
      const up = await client.upCard(card.owner.mid);
      const kind = up.officialType === 0 ? "个人认证" : up.officialType === 1 ? "机构认证" : "";
      const auth = kind
        ? `${kind}${up.officialDesc ? `（${sanitizeExternalText(up.officialDesc, { maxLen: LIMITS.officialDesc })}）` : ""}`
        : "无认证";
      lines.push(
        `UP 评级（软筛参考）：${sanitizeExternalText(up.name, { maxLen: LIMITS.name })}` +
          ` · 粉丝 ${count(up.fans)} · 等级 ${up.level} · ${auth}`,
      );
    } catch {
      // 评级拉不到就略过
    }
  }

  // 可选热评前 5（reply 端点，type=1 视频评论区，mode=3 热评序）
  if (args.withComments === true && card.aid > 0) {
    try {
      const messages = (await client.hotReplies(card.aid, 1))
        .slice(0, HOT_REPLIES)
        .map((r) => sanitizeExternalText(r.message, { maxLen: LIMITS.reply }))
        .filter((m) => m.length > 0);
      if (messages.length > 0) {
        lines.push("热评：");
        messages.forEach((m, i) => lines.push(`${i + 1}. ${m}`));
      }
    } catch {
      // 评论区拉不到不影响
    }
  }

  // 可选高能弹幕 top 10（dm 端点；多 P 视频只取第一段，cid 即 view 映射的第一段 cid）
  if (args.withDanmaku === true && card.cid !== undefined && card.cid > 0) {
    try {
      const picks = pickHighEnergy(parseDanmakuXml(await client.danmakuXml(String(card.cid))), HIGH_ENERGY);
      if (picks.length > 0) {
        lines.push("高能弹幕：");
        for (const text of picks) lines.push(`· ${text}`);
      }
    } catch {
      // 弹幕拉不到不影响
    }
  }

  return lines.join("\n");
}

export function createBiliVideoTool(manifest: ToolManifest, deps: ToolPackageDeps): ToolRegistration {
  return defineTool({
    name: manifest.name,
    description: toolFullDescription(manifest),
    callers: ["model"],
    parameters: manifestParameters<BiliVideoArgs>(manifest),
    execute: async (args) => {
      const bvid = args.bvid.trim();
      if (!isValidBvid(bvid)) {
        throw new Error(deps.prompts.messages["bili_video_invalid"] ?? "这不是合法的 BV 号");
      }
      let text: string;
      try {
        text = await buildBiliVideoReport(getBiliClient(), {
          bvid,
          withComments: args.withComments === true,
          withDanmaku: args.withDanmaku === true,
        });
      } catch (error) {
        const detail = error instanceof Error ? error.message : String(error);
        throw new Error(
          renderTemplate(deps.prompts.messages["bili_video_failed"] ?? "视频卡片没取到", { bvid, detail }),
        );
      }
      return { output: [{ type: "text", text }] };
    },
  });
}
