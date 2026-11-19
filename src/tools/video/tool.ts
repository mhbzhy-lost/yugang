/**
 * video —— QQ 群视频与 B 站内容共用关键帧视觉描述。
 *
 * 模型看不了视频流，所以这里做三件事，产出**纯文本**：
 *   1. 元数据：标题 / UP 主 / 时长 / 简介 / 热评
 *   2. 弹幕：按密度取高光时刻，顺带摘几条有梗的
 *   3. 关键帧：下最省的视频轨（360p），按「弹幕峰值 + 均匀」抽 6 帧，
 *      每帧交给视觉模型描述成文字（图不进主会话，理由同 look）
 *
 * 不做全量转写（费时且与「聊天里随口一句」不匹配）；没有台词，
 * 所以 prompt 里要求鱼别说成看完整个视频。
 *
 * 时长上限 30 分钟：超了只取前 30 分钟，并明确告诉鱼这是截断的。
 *
 * 请求层：view / 弹幕 / 热评三类 B 站请求统一走 bili-client 共享单例
 * （频控/预算/熔断与 bili_hot、bili_video 共用一份，Task E3）；短链展开与图文
 * 动态（opus）端点不在白名单内，仍用直接 fetch。对外行为与返回格式零变化。
 * 外部不可信文本边界（终验 #9 修复）：标题/简介/UP 名/弹幕/热评/opus 作者与正文
 * 一律先过 sanitizeExternalText 才返回给模型，与 bili_hot 同一清洗边界。
 *
 * 轮类型授权不在这里（2026-11-05 去工具内授权）：能不能逛、要不要看视频由宿主与
 * prompt 的 `[本轮要求]` 决定。工具只保留两个机械闸——每轮成功观看数上限
 * video.browseMaxViewsPerRound（缺省 5，每轮热读），以及「只有实际成功观看才
 * recordViewedVideo 绑定当前轮」（宿主 settle 清理），作为「这轮真的看过」的机械记录。
 *
 * 说明文字与参数 Schema 唯一来自 TOOL.md manifest（factory 只消费它，不再有第二份运行时定义）。
 */
import { mkdtempSync, readdirSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { LiveDoc, defineTool, type ToolRegistration } from "@earendil-works/pi-durable";
import { getBiliClient, type BiliClient } from "../../external/bili-client.ts";
import { sanitizeExternalText } from "../../external/sanitize.ts";
import { recordViewedVideo, recordVideoResource, viewedResourceCount } from "../../external/video-browse.ts";
import { biliOpusUrl, biliVideoUrl } from "../../external/video-links.ts";
import { rememberViewedVideoTitle } from "../../external/video-pool.ts";
import { loadFishConfig } from "../../fish-config.ts";
import { renderTemplate } from "../../prompt/index.ts";
import { describeImage } from "../../media/describe.ts";
import { extractVideoFrames, describeVideoFrames, pickVideoTimestamps, videoTime } from "../../media/video.ts";
import { manifestParameters, toolFullDescription } from "../manifest.ts";
import type { ToolManifest, ToolPackageDeps } from "../types.ts";

/** args 静态类型：与 TOOL.md 的参数 Schema 一一对应；运行时 Schema 只有 manifest 这一份。 */
interface VideoArgs {
  url?: string;
  ref?: string;
}

const activeVideoTemps = new Set<string>();
const HEADERS = { "user-agent": "Mozilla/5.0", referer: "https://www.bilibili.com/" };

/**
 * 清理上次崩溃/重启留下的抽帧临时目录。
 * 正常的临时目录在 finally 里就删了，但进程被 SIGKILL/部署重启打断时会残留。
 */
export function cleanupStaleVideoTemps(): void {
  try {
    for (const name of readdirSync(tmpdir())) {
      if (!name.startsWith("yg-video-")) continue;
      const path = join(tmpdir(), name);
      try {
        const age = Date.now() - statSync(path).mtimeMs;
        if (age > 60 * 60_000 && !activeVideoTemps.has(path)) rmSync(path, { recursive: true, force: true });
      } catch {
        // 单个目录删不掉不影响启动
      }
    }
  } catch {
    // 临时目录读不了就算了
  }
}

/**
 * 失败分诊：把异常翻成模型能理解的一句话。
 * 预算用尽 / 触发风控 / 其它 B 站客户端错误都不能被吞成「视频没打开：<url>」——
 * 那会让模型误判成链接坏了，对群友编出「你换个链接」的假话（2026-11-05 线上事故）。
 */
export function videoErrorText(raw: string, error: unknown, messages: Record<string, string>): string {
  const reason = (error instanceof Error ? error.message : String(error ?? ""))
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 120);
  if (/日预算已用尽/.test(reason)) {
    return renderTemplate(messages["video_budget_exhausted"] ?? "今天看视频的额度用完了：{{reason}}", { reason });
  }
  if (/触发风控|熔断/.test(reason)) {
    return renderTemplate(messages["video_risk_control"] ?? "B 站今天限流了：{{reason}}", { reason });
  }
  if (/^B站/.test(reason)) {
    return renderTemplate(messages["video_unavailable"] ?? "这次没能打开视频：{{reason}}", { reason });
  }
  return renderTemplate(messages["video_failed"] ?? "视频没打开：{{url}}", { url: raw });
}

export function createVideoTool(manifest: ToolManifest, deps: ToolPackageDeps): ToolRegistration {
  const doFetch = fetch;
  const timeoutMs = 20_000;
  const maxMinutes = 30;
  const qqErrors: Record<string, string> = {
    video_ref_denied: deps.prompts.messages["video_ref_denied"],
    video_ref_expired: deps.prompts.messages["video_ref_expired"],
    video_source_invalid: deps.prompts.messages["video_source_invalid"],
    video_too_large: deps.prompts.messages["video_too_large"],
    video_decoder_missing: deps.prompts.messages["video_decoder_missing"],
    video_decode_failed: deps.prompts.messages["video_decode_failed"],
    video_vision_missing: deps.prompts.messages["video_vision_missing"],
    video_no_frames: deps.prompts.messages["video_no_frames"],
  };

  /** 每请求超时与调用方取消（工具超时/宿主取消）合并；底层 fetch 消费同一个 signal。 */
  const mergedSignal = (signal?: AbortSignal): AbortSignal => {
    const timeout = AbortSignal.timeout(timeoutMs);
    return signal ? AbortSignal.any([timeout, signal]) : timeout;
  };

  async function getJson(url: string, signal?: AbortSignal): Promise<any> {
    const res = await doFetch(url, { headers: HEADERS, signal: mergedSignal(signal) });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return await res.json();
  }

  /** 弹幕 XML → {time, text}[]；拿不到返回空数组（不影响主流程）。XML 经 bili-client 取。 */
  async function fetchDanmaku(client: BiliClient, cid: string): Promise<{ time: number; text: string }[]> {
    try {
      const xml = await client.danmakuXml(cid);
      const out: { time: number; text: string }[] = [];
      for (const m of xml.matchAll(/<d p="([^"]+)"[^>]*>([^<]*)<\/d>/g)) {
        const time = Number(m[1].split(",")[0]);
        const text = m[2].trim();
        if (Number.isFinite(time) && text.length > 0) out.push({ time, text });
      }
      return out;
    } catch {
      return [];
    }
  }

  return defineTool({
    name: manifest.name,
    description: toolFullDescription(manifest),
    callers: ["model"],
    parameters: manifestParameters<VideoArgs>(manifest),
    execute: async (input, api, context) => {
      const args = input as VideoArgs;
      // 宿主机械提示：本轮第一次调用先说一句「在做了」（working_video），再开始耗时工作；
      // 拿不到轮标识（live.run.inputs[0]）就不发，不影响后续行为
      const live = await api.snapshot(LiveDoc, api.conversationId, context);
      const round = live?.run?.inputs?.[0];
      deps.onLongWork?.("video", round);
      // 合并后的取消信号：本工具内的直连 fetch / 抽帧子进程 / 视觉描述都消费它
      const signal = context.abortSignal;

      // 策略在调用侧，工具不做轮类型授权：能不能看由 prompt 的 `[本轮要求]` 与宿主给的
      // 工具面决定。这里只留纯资源闸——每轮成功观看数上限（video.browseMaxViewsPerRound，
      // 缺省 5，每轮热读），计数口径 = 本轮已登记的 viewed BV（轮末宿主清理，跨轮不残留）。
      const maxViews = Math.max(1, loadFishConfig().config.video.browseMaxViewsPerRound);
      if (round !== undefined && viewedResourceCount(round) >= maxViews) {
        throw new Error(deps.prompts.messages["video_browse_limit"] ?? "video_browse_limit");
      }

      if ((typeof args.url === "string") === (typeof args.ref === "string")) throw new Error(deps.prompts.messages["video_source_choice"]);
      const raw = (args.url ?? args.ref ?? "").trim();
      if (!raw || raw.length > 4096) {
        throw new Error(deps.prompts.messages["video_invalid"] ?? "链接不对");
      }

      const startedAt = Date.now();
      const client = getBiliClient();
      const tmp = mkdtempSync(join(tmpdir(), "yg-video-"));
      activeVideoTemps.add(tmp);
      try {
        if (args.ref !== undefined) {
          if (!deps.downloadVideo || round === undefined) throw new Error("video_ref_denied");
          if (!deps.models || !deps.visionModel) throw new Error("video_vision_missing");
          const source = await deps.downloadVideo(String(api.conversationId), String(round), raw, tmp, signal);
          const data = await extractVideoFrames({ kind: "local", file: source.file }, tmp, signal);
          const described = await describeVideoFrames(deps, data, signal);
          if (!described.lines.length) throw new Error("video_no_frames");
          const head = renderTemplate(deps.prompts.messages["video_qq_header"], { name: source.name, duration: videoTime(data.durationSeconds), covered: videoTime(data.coveredSeconds) });
          const text = [head, deps.prompts.messages["video_frames_header"], ...described.lines,
            ...(described.failed ? [deps.prompts.messages["video_partial"]] : []),
            ...(data.durationSeconds > data.coveredSeconds ? [renderTemplate(deps.prompts.messages["video_truncated"], { minutes: String(maxMinutes) })] : []),
          ].join("\n");
          signal?.throwIfAborted();
          recordVideoResource(round, `qq:${raw}`);
          return { output: [{ type: "text", text }] };
        }
        // 短链先展开
        let target = raw;
        if (/^https?:\/\/b23\.tv\//.test(raw)) {
          const res = await doFetch(raw, { headers: HEADERS, redirect: "follow", signal: mergedSignal(signal) });
          target = res.url;
        }
        const bv = target.match(/BV[0-9A-Za-z]{10}/)?.[0];
        if (!bv) {
          // 不是视频：图文动态（/opus/<id>）也支持——B 站分享卡片经常指向这里
          const opusId = target.match(/\/opus\/(\d+)/)?.[1];
          if (opusId) {
            const opus = await getJson(
              `https://api.bilibili.com/x/polymer/web-dynamic/v1/opus/detail?timezone_offset=-480&id=${opusId}`,
              signal,
            );
            const item = opus?.data?.item;
            if (opus?.code !== 0 || !item) throw new Error("opus failed");
            const modules = (item.modules ?? []) as any[];
            const author = sanitizeExternalText(modules.find((m) => m?.module_type === "MODULE_TYPE_AUTHOR")?.module_author?.name ?? "?", { maxLen: 60 }) || "?";
            const published = sanitizeExternalText(modules.find((m) => m?.module_type === "MODULE_TYPE_AUTHOR")?.module_author?.pub_time ?? "", { maxLen: 30 });
            const paragraphs = modules.find((m) => m?.module_type === "MODULE_TYPE_CONTENT")?.module_content?.paragraphs ?? [];
            let body = "";
            const pics: string[] = [];
            for (const para of paragraphs as any[]) {
              for (const node of para?.text?.nodes ?? []) {
                if (node?.type === "TEXT_NODE_TYPE_WORD") body += node?.word?.words ?? "";
              }
              for (const pic of para?.pic?.pics ?? []) {
                if (pics.length < 2 && pic?.url) pics.push(String(pic.url));
              }
            }
            const head = [
              `${author}${published ? ` · ${published}` : ""} 的图文动态`,
              sanitizeExternalText(body, { maxLen: 600 }),
            ].filter((s) => s.length > 0);
            // canonical 链接由宿主渲染（模型不写 URL）：模型分享这条动态时直接抄它
            head.push(
              renderTemplate(deps.prompts.messages["video_canonical_url"] ?? "", { url: biliOpusUrl(opusId) }),
            );

            let picText = "";
            if (deps.models && deps.visionModel && pics.length > 0) {
              const described = await Promise.all(
                pics.map(async (url, index) => {
                  try {
                    const res = await doFetch(url, { headers: HEADERS, signal: mergedSignal(signal) });
                    if (!res.ok) return null;
                    const bytes = Buffer.from(await res.arrayBuffer());
                    // 被内容审核拒/描述失败的单张图直接跳过，不影响其它图
                    const described = await describeImage(deps, bytes.toString("base64"), res.headers.get("content-type")?.split(";")[0] ?? "image/jpeg", signal);
                    return described.ok ? `[图${index + 1}] ${described.text.replace(/\s+/g, " ").slice(0, 200)}` : null;
                  } catch {
                    return null;
                  }
                }),
              );
              const lines = described.filter((x): x is string => x !== null);
              if (lines.length > 0) {
                picText = "\n" + (deps.prompts.messages["video_frames_header"] ?? "") + "\n" + lines.join("\n");
              }
            }

            console.log("[鱼缸] video opus", opusId, "总用时", Date.now() - startedAt, "ms");
            return { output: [{ type: "text", text: head.join("\n") + picText }] };
          }
          throw new Error("no bv");
        }

        // view / 弹幕 / 热评三类请求经 bili-client（频控共享）；信封检查与错误映射在客户端内完成
        const d = await client.view(bv);
        const duration = d.durationSeconds;
        const cid = d.cid !== undefined ? String(d.cid) : "";
        const capSeconds = Math.min(duration, maxMinutes * 60);
        const truncated = duration > capSeconds + 5;

        const head = [
          `《${sanitizeExternalText(d.title, { maxLen: 60 })}》`,
          `UP主 ${sanitizeExternalText(d.owner.name, { maxLen: 60 }) || "?"} · ${Math.round(duration / 60)} 分钟 · 播放 ${d.stat.view.toLocaleString()}`,
          // canonical 链接由宿主渲染（模型不写 URL）：分享这条视频时直接抄它，
          // say_words 的出口白名单也会按它登记（2026-11-05：以前这里没链接，
          // 模型拼的 URL 一律被白名单拒，看过的视频发不出去）
          renderTemplate(deps.prompts.messages["video_canonical_url"] ?? "", { url: biliVideoUrl(bv) }),
        ];
        if (truncated) {
          head.push(
            renderTemplate(deps.prompts.messages["video_truncated"] ?? "", { minutes: String(maxMinutes) }),
          );
        }
        const desc = sanitizeExternalText(d.desc, { maxLen: 200 });
        if (desc) head.push(desc);

        // 弹幕
        const danmaku = await fetchDanmaku(client, cid);
        let danmakuText = "";
        if (danmaku.length > 0) {
          const hot = [...danmaku].sort((a, b) => b.time - a.time).slice(0, 4);
          const uniq = [...new Set(danmaku.map((x) => x.text))].slice(0, 8);
          const picked = uniq.length >= 4 ? uniq.slice(0, 6) : hot.map((x) => x.text);
          danmakuText =
            "\n" +
            (deps.prompts.messages["video_danmaku_header"] ?? "") +
            "\n" +
            picked.map((t) => `· ${sanitizeExternalText(t, { maxLen: 40 })}`).join("\n");
        }

        // 两个来源共用抽帧和视觉描述；B 站失败仍可返回元信息。
        let framesText = "";
        if (deps.models && deps.visionModel && cid) {
          try {
            const data = await extractVideoFrames({ kind: "bilibili", bvid: bv, cid, timestamps: pickVideoTimestamps(danmaku, capSeconds) }, tmp, signal);
            const described = await describeVideoFrames(deps, data, signal);
            if (described.lines.length > 0) framesText = "\n" + deps.prompts.messages["video_frames_header"] + "\n" + described.lines.join("\n");
          } catch { signal?.throwIfAborted(); console.warn("[鱼缸] B站视频抽帧或描述失败"); }
        }

        // 热评（拿不到就略过）；经 bili-client 的 reply 端点（type=1，mode=3 热评序）
        let comments = "";
        try {
          const replies = (await client.hotReplies(d.aid, 1)).slice(0, 3);
          if (replies.length > 0) {
            comments =
              "\n" +
              (deps.prompts.messages["video_comments_header"] ?? "") +
              "\n" +
              replies.map((c, i) => `${i + 1}. ${sanitizeExternalText(c.message, { maxLen: 100 })}`).join("\n");
          }
        } catch {
          // 评论区拿不到不影响
        }

        const text = [head.join("\n"), danmakuText, framesText, comments].filter((s) => s.length > 0).join("\n");
        // 实际成功观看后才登记：viewed 绑定当前轮（宿主 settle 时整份清掉），
        // 清洗后的标题进轮内缓存供 say_words 分享事务写池；失败路径（上面 catch）不登记，
        // opus 图文动态没有 BV 同样不登记
        signal?.throwIfAborted();
        if (round !== undefined) {
          recordViewedVideo(round, bv);
          rememberViewedVideoTitle(round, bv, sanitizeExternalText(d.title, { maxLen: 60 }));
        }
        console.log("[鱼缸] video", bv, "总用时", Date.now() - startedAt, "ms");
        return { output: [{ type: "text", text }] };
      } catch (error) {
        if (args.ref !== undefined) {
          const key = error instanceof Error && /^video_[a-z_]+$/.test(error.message) ? error.message : "video_download_failed";
          throw new Error(qqErrors[key] ?? deps.prompts.messages["video_download_failed"]);
        }
        throw new Error(videoErrorText(raw, error, deps.prompts.messages));
      } finally {
        activeVideoTemps.delete(tmp);
        try {
          rmSync(tmp, { recursive: true, force: true });
        } catch {
          // 清理失败无所谓
        }
      }
    },
  });
}
