/**
 * meme_import —— 把「本地待收目录」里的一批图片登记进本轮导入清单。
 *
 * 为什么要有这一步：主人把一批图放进 <mediaRoot>/meme-inbox/，鱼要逐张看、逐张打标，
 * 但 look 只认群里来的图、一轮最多两张。于是把「这一轮允许看哪些图」做成一份清单：
 * 先登记（本工具），再逐张 look，再由主模型结合当前群聊决定 caption/tags，最后逐张
 * meme_add。清单只属于当前 LiveDoc 的这一轮，round 结束由宿主清掉。
 *
 * 边界：目录是固定的 meme-inbox（不接受任何路径参数），只认图片直系子文件，
 * 拒绝目录、符号链接、非图片和超限文件；不开放任意读取，也不跑 shell。
 *
 * 轮清单状态只有 meme_import/shared.ts 一份；本工具只负责登记与扫描目录。
 * 说明文字与参数 Schema 唯一来自 TOOL.md manifest（factory 只消费它，不再有第二份运行时定义）。
 */
import { lstatSync, readdirSync, type Dirent } from "node:fs";
import { join, resolve } from "node:path";
import { LiveDoc, defineTool, type ToolRegistration } from "@earendil-works/pi-durable";
import { DEFAULT_LIMITS } from "../../egress/policy.ts";
import { checkMemeSource, type MemeSourceCode } from "../../media/meme-store.ts";
import { extractGifFrames } from "../../media/gif-frames.ts";
import { inlineImageOf } from "../../media/shrink-image.ts";
import { renderTemplate } from "../../prompt/index.ts";
import { manifestParameters, toolFullDescription } from "../manifest.ts";
import type { ToolManifest, ToolPackageDeps } from "../types.ts";
import { MEME_IMPORT_MAX, memeImportMarkLooked, registerMemeImportRound } from "./shared.ts";

/** inline 模式每批登记（= 附图）张数：50 张一口气塞一轮太重，12 张一批 cursor 续。 */
const INLINE_IMPORT_BATCH = 12;

/** args 静态类型：与 TOOL.md 的参数 Schema 一一对应；运行时 Schema 只有 manifest 这一份。 */
interface MemeImportArgs {
  cursor?: string;
}

/** 主人闸是硬前提：无主人配置时 factory 返回 undefined，由注册方跳过（不进工具面）。 */
export function createMemeImportTool(manifest: ToolManifest, deps: ToolPackageDeps): ToolRegistration | undefined {
  if (!deps.master) return undefined;
  const root = resolve(deps.mediaRoot);
  const inboxDir = join(root, "meme-inbox");
  const maxBytes = deps.limits?.maxMediaBytes ?? DEFAULT_LIMITS.maxMediaBytes;

  return defineTool({
    name: manifest.name,
    description: toolFullDescription(manifest),
    callers: ["model"],
    parameters: manifestParameters<MemeImportArgs>(manifest),
    execute: async (args, api, context) => {
      const live = await api.snapshot(LiveDoc, api.conversationId, context);
      const round = live?.run?.inputs?.[0];
      const trigger = round !== undefined ? deps.triggerOf?.(round) : undefined;
      const byMaster = deps.master !== "" && String(trigger?.userId ?? "") === deps.master;
      // 身份闸在代码里判定：不认模型自述的「主人让我收的」
      if (!byMaster || round === undefined) {
        throw new Error(deps.prompts.messages["meme_import_master"] ?? "meme_import_master");
      }
      // 宿主机械提示：登记时立即说一句「新表情到货」（working_meme_import）；
      // 放在身份闸之后，被拒的调用不广播；与 working_meme_add 各发一次，同轮各自只发一次
      deps.onLongWork?.("meme_import", round);

      const scan = scanInbox(inboxDir, maxBytes);
      const { valid, skipped } = scan;
      const cursor = (args.cursor ?? "").trim();
      const rest = cursor.length > 0 ? valid.filter((name) => name > cursor) : valid;
      // inline 模式所见即所登记：每批只登记工具结果附得下的张数，cursor 续批
      // （50 张 × 每张 ≤50KB 一口气塞进一轮太重）。fallback 模式维持 50/批 + 逐张 look。
      const inline = deps.inlineVisionOn?.() ?? false;
      const batchSize = inline ? INLINE_IMPORT_BATCH : MEME_IMPORT_MAX;
      const batch = rest.slice(0, batchSize);
      const nextCursor = rest.length > batch.length ? batch[batch.length - 1] : undefined;
      const refs = batch.map((name) => `meme-inbox/${name}`);
      if (refs.length > 0) registerMemeImportRound(String(round), refs);

      const lines: string[] = [];
      // 目录本身的状态要先说清楚：不存在 / 打不开 / 是符号链接与「目录是空的」不是一回事
      if (scan.status === "nodir") {
        lines.push(deps.prompts.messages["meme_import_nodir"] ?? "meme_import_nodir");
      } else if (scan.status === "denied") {
        lines.push(deps.prompts.messages["meme_import_denied"] ?? "meme_import_denied");
      } else if (scan.status === "linkdir") {
        lines.push(deps.prompts.messages["meme_import_linkdir"] ?? "meme_import_linkdir");
      } else if (refs.length === 0) {
        lines.push(deps.prompts.messages["meme_import_empty"] ?? "meme_import_empty");
      } else {
        // 两模式的清单头文案分开（inline：图已附上；fallback：引导逐张 look）
        const listLine = inline
          ? deps.prompts.messages["meme_import_list_inline"]
          : deps.prompts.messages["meme_import_list"];
        lines.push(renderTemplate(listLine ?? "{{count}}", {
          count: String(refs.length),
        }));
        // refs 是数据不是文案：一行一个，让模型能逐个拿来当 meme_add 的参数
        lines.push(refs.join("\n"));
      }
      if (nextCursor !== undefined) {
        lines.push(
          renderTemplate(deps.prompts.messages["meme_import_more"] ?? "{{rest}} {{cursor}}", {
            rest: String(rest.length - refs.length),
            cursor: nextCursor,
          }),
        );
      }
      if (skipped.length > 0) {
        lines.push(
          renderTemplate(deps.prompts.messages["meme_import_skipped"] ?? "{{count}} {{items}}", {
            count: String(skipped.length),
            items: skipped.join("、"),
          }),
        );
      }
      const text = lines.join("\n");
      console.log(`[鱼缸] meme_import round=${String(round)} 登记 ${refs.length} 张，跳过 ${skipped.length} 个`);
      // inline 模式：清单图直接作为本工具结果的 image blocks 附上（模型当场看完），
      // 全部记「已看过」——meme_add 的机械校验零改动（语义从「look 过」扩为「直接见过」）。
      // 读不了的图（压缩失败）不附也不记，meme_add 会拒——模型只给见过的打标。
      // GIF 抽 2 帧（打标判断够用、控批量；格式声明见 meme_import_inline_note）。
      if (!inline || refs.length === 0) return { output: [{ type: "text", text }] };
      const textFirst = [text, deps.prompts.messages["meme_import_inline_note"] ?? ""]
        .filter((s) => s.length > 0)
        .join("\n");
      const images: Array<{ type: "image"; data: string; mimeType: string }> = [];
      for (const ref of refs) {
        const full = join(inboxDir, ref.slice("meme-inbox/".length));
        if (ref.toLowerCase().endsWith(".gif")) {
          const frames = extractGifFrames(full, 2);
          for (const frame of frames.frames) images.push({ type: "image", data: frame, mimeType: "image/jpeg" });
          if (frames.frames.length > 0) memeImportMarkLooked(String(round), ref);
          continue;
        }
        const image = inlineImageOf(full);
        if (image.ok) {
          images.push({ type: "image", data: image.buffer.toString("base64"), mimeType: image.mimeType });
          memeImportMarkLooked(String(round), ref);
        }
      }
      return { output: [{ type: "text", text: textFirst }, ...images] };
    },
  });
}

/**
 * 只扫固定目录的直接子文件。返回稳定的文件名序（按名字排序，游标才靠得住）
 * 与被跳过的项（给模型看的逐项原因，同样排序后才输出）。
 *
 * 「目录不在 / 打不开 / 本身是链接」单独报，不能和「目录是空的」搅成一个空清单：
 * 否则主人放完图被告知「没有能收的」时，根本分不出是路径不对还是图不对。
 */
const SKIP_REASON: Record<Exclude<MemeSourceCode, "type">, string> = {
  missing: "读不到",
  outside: "越界",
  link: "符号链接",
  big: "太大",
  magic: "文件头不是图片",
};

type ScanStatus = "ok" | "nodir" | "denied" | "linkdir";

function scanInbox(dir: string, maxBytes: number): { status: ScanStatus; valid: string[]; skipped: string[] } {
  // 固定目录自身是符号链接就整个拒掉：否则「固定目录」可以被指到任意位置
  try {
    const self = lstatSync(dir);
    if (self.isSymbolicLink()) return { status: "linkdir", valid: [], skipped: [] };
  } catch {
    return { status: "nodir", valid: [], skipped: [] };
  }

  let entries: Dirent[];
  try {
    entries = readdirSync(dir, { withFileTypes: true });
  } catch {
    // 存在但读不了（权限 / 不是目录）与「不存在」分开报
    return { status: "denied", valid: [], skipped: [] };
  }

  const valid: string[] = [];
  const skipped: string[] = [];
  for (const entry of entries) {
    const name = String(entry.name);
    // 符号链接 / 目录先按 Dirent 判，给人话；剩下的交给统一的来源校验（lstat/realpath/大小/文件头）
    if (entry.isSymbolicLink()) {
      skipped.push(`${name}（${SKIP_REASON.link}）`);
      continue;
    }
    if (!entry.isFile()) {
      skipped.push(`${name}（不是文件）`);
      continue;
    }
    const check = checkMemeSource(dir, name, maxBytes);
    if (!check.ok) {
      // 扩展名不对在 checkMemeSource 里报 type，这里给一句人话
      skipped.push(`${name}（${check.code === "type" ? "不是图片" : SKIP_REASON[check.code]}）`);
      continue;
    }
    valid.push(name);
  }
  // 不依赖 locale：按码位排序，游标比较才与目录里的稳定顺序一致；skip 也排序，输出才稳定
  const order = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0);
  valid.sort(order);
  skipped.sort(order);
  return { status: "ok", valid, skipped };
}
