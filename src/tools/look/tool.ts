/**
 * look —— 看群里的一张图。
 *
 * 没有通用 read：只能看媒体目录里的图片，而且一轮最多两张。
 * 图是被 QQ 适配器落到 <mediaRoot>/inbound/ 的，进站文本里会带 inbound/xxx.png 这个引用。
 *
 * meme-inbox/（主人本地待收目录）不是普通媒体：只有「本轮触发是主人」且「这张在本轮
 * meme_import 清单里」才允许读。普通那两张额度不能拿来授权读 inbox——额度是看群图用的，
 * 不是读本地目录用的。
 *
 * 导入轮：额度 = 本轮清单张数（上限 50），逐张一次，看过的记进清单供 meme_add 核对；
 * 没登记的一律不看。这仍不是任意文件读取：目录固定、身份固定、清单只活一轮。
 *
 * 图不进主会话：look 内部用独立请求让视觉模型把图描述成文字，只把描述返回给主会话，
 * 主会话 transcript 从头到尾都是纯文本（缓存前缀稳定，也不反复撞网关的视觉管线）。
 *
 * 导入轮的清单状态只有 meme_import/shared.ts 一份，这里只读取与回写「已看过」。
 * 说明文字与参数 Schema 唯一来自 TOOL.md manifest（factory 只消费它，不再有第二份运行时定义）。
 */
import { spawnSync } from "node:child_process";
import { inflateSync } from "node:zlib";
import { existsSync, readFileSync, rmSync, unlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve, sep, extname, relative } from "node:path";
import { LiveDoc, defineTool, type ToolRegistration } from "@earendil-works/pi-durable";
import { renderTemplate } from "../../prompt/index.ts";
import { ledgerOf, recordLook } from "../../egress/ledger.ts";
import { describeImage, isDescribeFiltered } from "../../media/describe.ts";
import { checkMemeSource } from "../../media/meme-store.ts";
import { DEFAULT_LIMITS } from "../../egress/policy.ts";
import { enqueueOutbound, type OutboundPayload } from "../say-shared.ts";
import { manifestParameters, toolFullDescription } from "../manifest.ts";
import type { ToolManifest, ToolPackageDeps } from "../types.ts";
import { fenceReadablePath } from "../fs-shared.ts";
import { DATA_HOME } from "../../paths.ts";
import { MEME_IMPORT_MAX, memeImportHas, memeImportLookLimit, memeImportLooked, memeImportLookedCount, memeImportMarkLooked } from "../meme_import/shared.ts";

/** args 静态类型：与 TOOL.md 的参数 Schema 一一对应；运行时 Schema 只有 manifest 这一份。 */
interface LookArgs {
  ref: string;
  mode?: "view" | "metadata";
}

/** 看图快捷开关：主人 /关看图 后置位（var/look-off.marker），重启保持；网关视觉管线不稳时止损用。 */
const LOOK_OFF_MARKER = join(DATA_HOME, "look-off.marker");
let lookDisabled = existsSync(LOOK_OFF_MARKER);
export function isLookDisabled(): boolean {
  return lookDisabled;
}
export function setLookDisabled(off: boolean): void {
  lookDisabled = off;
  try {
    if (off) writeFileSync(LOOK_OFF_MARKER, String(Date.now()));
    else rmSync(LOOK_OFF_MARKER, { force: true });
  } catch {
    /* 标记写不进去也不影响内存开关 */
  }
}

const MIME: Record<string, string> = {
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".gif": "image/gif",
  ".webp": "image/webp",
};

export function createLookTool(manifest: ToolManifest, deps: ToolPackageDeps): ToolRegistration {
  const root = resolve(deps.mediaRoot);
  const inboxDir = resolve(root, "meme-inbox");
  // 普通轮每轮两张（历史默认，从不被调用方覆盖）；导入轮的额度按清单张数另算
  const limit = 2;
  const maxBytes = deps.limits?.maxMediaBytes ?? DEFAULT_LIMITS.maxMediaBytes;

  return defineTool({
    name: manifest.name,
    description: toolFullDescription(manifest),
    callers: ["model"],
    parameters: manifestParameters<LookArgs>(manifest),
    execute: async (args, api, context) => {
      const metadata = args.mode === "metadata";
      // 机械锁（2026-11-06 主人裁定）：主模型直读模式下普通看图由 inline 附上，
      // 但 metadata 是纯本地 PNG 头解析，不经过视觉模型，因此不受此锁影响。
      if (!metadata && deps.inlineVisionOn?.()) {
        throw new Error(deps.prompts.messages["look_inline_locked"] ?? "look_inline_locked");
      }
      if (!metadata && lookDisabled) {
        return { output: [{ type: "text", text: deps.prompts.messages["look_cmd_off"] ?? "看图已关" }] };
      }
      const ref = args.ref.trim().replace(/^\[|\]$/g, "");
      const full = resolve(root, ref);
      const outside = full !== root && !full.startsWith(root + sep);
      if (outside) throw new Error(renderTemplate(deps.prompts.messages["look_outside"] ?? "{{ref}}", { ref }));

      const localRef = relative(root, full).split(sep).join("/");
      const inInbox = full === inboxDir || full.startsWith(inboxDir + sep);
      // 符号链接围栏：最终分量是链接或 realpath 越界都拒。inbox 图不在这查——下面的
      // checkMemeSource（lstat/realpath）已按同一语义 fail-closed，拒绝文案走 look_missing。
      if (!inInbox) {
        const fence = fenceReadablePath(root, full);
        if (!fence.ok && fence.reason !== "missing") {
          throw new Error(renderTemplate(deps.prompts.messages["look_outside"] ?? "{{ref}}", { ref }));
        }
      }

      const mime = MIME[extname(full).toLowerCase()];
      if (!mime) throw new Error(renderTemplate(deps.prompts.messages["look_type"] ?? "{{ref}}", { ref }));
      if (metadata && mime !== "image/png") {
        throw new Error(renderTemplate(deps.prompts.messages["look_metadata_invalid"] ?? "{{ref}}", { ref }));
      }

      // 导入轮：只认本轮 meme_import 清单里、且本轮触发是主人的 inbox 图，额度按清单张数（上限 50）；
      // 其余一律按普通轮 2 张。inbox 不是普通媒体，那两张额度不能拿来授权读它。
      const live = await api.snapshot(LiveDoc, api.conversationId, context);
      const round = live?.run?.inputs?.[0];
      const roundId = round === undefined ? undefined : String(round);
      const trigger = round === undefined ? undefined : deps.triggerOf?.(round);
      const byMaster = deps.master !== undefined && deps.master !== "" && String(trigger?.userId ?? "") === deps.master;

      if (inInbox) {
        // 两道闸都是机械判定：主人与否看本轮触发，清单看当前 LiveDoc 的 round
        if (!byMaster) throw new Error(renderTemplate(deps.prompts.messages["look_inbox_master"] ?? "{{ref}}", { ref }));
        if (roundId === undefined || !memeImportHas(roundId, localRef)) {
          throw new Error(renderTemplate(deps.prompts.messages["look_inbox_outside"] ?? "{{ref}}", { ref }));
        }
        // 读之前再把来源验一遍（lstat/realpath/大小/文件头）：登记后被换成链接也读不到
        if (!checkMemeSource(root, localRef, maxBytes).ok) {
          throw new Error(renderTemplate(deps.prompts.messages["look_missing"] ?? "{{ref}}", { ref }));
        }
      }

      if (metadata) {
        let bytes: Buffer;
        try {
          bytes = readFileSync(full);
        } catch {
          throw new Error(renderTemplate(deps.prompts.messages["look_missing"] ?? "{{ref}}", { ref }));
        }
        const text = formatPngMetadata(
          bytes,
          localRef,
          deps.prompts.messages["look_metadata_empty"] ?? "PNG 没有可读的文本元数据",
          deps.prompts.messages["look_metadata_invalid"] ?? "不是可解析的 PNG 文件",
        );
        const items = splitOutboundText(text);
        const ts = Date.now();
        const payload: OutboundPayload = {
          items,
          quote: true,
          ...(trigger?.messageId !== undefined ? { quoteId: trigger.messageId } : {}),
          ...(trigger ? { quoteForce: trigger.mentionsBot } : {}),
          at: ts,
          key: `${api.conversationId}:look-metadata:${api.callId}`,
        };
        await enqueueOutbound(api, payload, context);
        return { output: [{ type: "text", text: deps.prompts.messages["look_metadata_sent"] ?? "metadata_sent" }] };
      }

      const importing = inInbox && roundId !== undefined && memeImportHas(roundId, localRef);
      // 导入轮：只认本轮 meme_import 清单里、且本轮触发是主人的 inbox 图，额度按清单张数（上限 50）；
      const importLimit = roundId === undefined ? undefined : memeImportLookLimit(roundId);
      // 额度＝清单张数（上限 50）：清单只有一张时就只看得了一张，不被普通轮的 2 张抬上去
      const effectiveLimit = importing && importLimit !== undefined ? Math.min(importLimit, MEME_IMPORT_MAX) : limit;
      const ledger = ledgerOf(api.conversationId);
      if (importing && roundId !== undefined) {
        // 看过的重复看不占额度（也不重复花视觉调用）：直接让它去 meme_add
        if (memeImportLooked(roundId, localRef)) {
          throw new Error(renderTemplate(deps.prompts.messages["look_import_seen"] ?? "{{ref}}", { ref: localRef }));
        }
        if (memeImportLookedCount(roundId) >= effectiveLimit) {
          throw new Error(
            renderTemplate(deps.prompts.messages["look_import_used"] ?? "{{count}}", {
              count: String(effectiveLimit),
              limit: String(effectiveLimit),
              ref: localRef,
            }),
          );
        }
      } else if (ledger.lookedThisRun >= effectiveLimit) {
        throw new Error(
          renderTemplate(deps.prompts.messages["look_used"] ?? "{{limit}}", {
            limit: String(effectiveLimit),
            count: String(effectiveLimit),
            ref: localRef,
          }),
        );
      }

      let data: string;
      let outMime = mime;
      try {
        const bytes = readFileSync(full);
        // 大图压缩后再进上下文：进会话的内容一旦定下就不能变（动它会破坏前缀缓存），
        // 所以在读取时就压——GIF 取首帧、超尺寸缩到 1280px、一律 JPEG，单张控制在几十 KB。
        // 压缩件只用于观看，不回写原文件。
        if (bytes.length > 150_000) {
          const shrunk = shrink(full);
          if (shrunk) {
            data = shrunk.toString("base64");
            outMime = "image/jpeg";
          } else {
            data = bytes.toString("base64");
          }
        } else {
          data = bytes.toString("base64");
        }
      } catch {
        throw new Error(renderTemplate(deps.prompts.messages["look_missing"] ?? "{{ref}}", { ref }));
      }

      // 图不进主会话：独立请求让模型把图描述成文字，只返回描述。
      // 描述失败（网关视觉管线间歇不稳）也不退回原图块——那会让图永久留在 transcript，
      // 拖垮之后每一轮；宁可这次看不了，让模型告诉用户稍后再看。
      const described = await describeImage(deps, data, outMime);
      if (isDescribeFiltered(described)) {
        // 内容审核拒（主模型或兜底）：确定性失败，明确说这张看不了、可换一张，别让人等重试
        throw new Error(deps.prompts.messages["look_filtered"] ?? "这张图被内容审核拦下了");
      }
      if (!described.ok) {
        return { output: [{ type: "text", text: deps.prompts.messages["look_unstable"] ?? "看不了" }] };
      }
      // 真的看成了才记帐：没描述成功不占额度，也不算「看过」（否则清单里的图永远 meme_add 不了）
      recordLook(api.conversationId);
      if (importing && roundId !== undefined) memeImportMarkLooked(roundId, localRef);
      return { output: [{ type: "text", text: described.text }] };
    },
  });
}

type PngTextEntry = { keyword: string; text: string };
const PNG_SIGNATURE = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);
const PNG_METADATA_LIMIT = 120_000;
const PNG_TEXT_LIMIT = 24_000;

function decodePngText(bytes: Buffer): PngTextEntry[] | null {
  if (bytes.length < PNG_SIGNATURE.length || !bytes.subarray(0, PNG_SIGNATURE.length).equals(PNG_SIGNATURE)) return null;
  const entries: PngTextEntry[] = [];
  let offset = PNG_SIGNATURE.length;
  let total = 0;
  let chunks = 0;
  while (offset + 12 <= bytes.length && chunks < 4096) {
    const length = bytes.readUInt32BE(offset);
    const type = bytes.subarray(offset + 4, offset + 8).toString("ascii");
    const start = offset + 8;
    const end = start + length;
    if (end + 4 > bytes.length) return null;
    const data = bytes.subarray(start, end);
    offset = end + 4;
    chunks++;
    if (type === "tEXt") {
      const split = data.indexOf(0);
      if (split > 0) {
        const keyword = data.subarray(0, split).toString("latin1").slice(0, 79);
        const text = data.subarray(split + 1).toString("utf8").slice(0, PNG_TEXT_LIMIT);
        entries.push({ keyword, text });
        total += text.length;
      }
    } else if (type === "zTXt") {
      const split = data.indexOf(0);
      if (split > 0 && data[split + 1] === 0) {
        try {
          const keyword = data.subarray(0, split).toString("latin1").slice(0, 79);
          const text = inflateSync(data.subarray(split + 2)).toString("utf8").slice(0, PNG_TEXT_LIMIT);
          entries.push({ keyword, text });
          total += text.length;
        } catch {
          /* 损坏的单个压缩文本块不影响其它元数据。 */
        }
      }
    } else if (type === "iTXt") {
      const fields: Buffer[] = [];
      let cursor = 0;
      for (let i = 0; i < 5; i++) {
        const split = data.indexOf(0, cursor);
        if (split < 0) { cursor = -1; break; }
        fields.push(data.subarray(cursor, split));
        cursor = split + 1;
      }
      if (cursor >= 0 && fields.length === 5 && cursor <= data.length) {
        try {
          const compressed = fields[1][0] === 1;
          const raw = compressed ? inflateSync(data.subarray(cursor)) : data.subarray(cursor);
          const keyword = fields[0].toString("latin1").slice(0, 79);
          const text = raw.toString("utf8").slice(0, PNG_TEXT_LIMIT);
          entries.push({ keyword, text });
          total += text.length;
        } catch {
          /* 损坏的单个压缩文本块不影响其它元数据。 */
        }
      }
    }
    if (total > PNG_METADATA_LIMIT || type === "IEND") break;
  }
  return entries;
}

function safeMetadataValue(value: unknown, depth = 0): unknown {
  if (depth > 6) return "[depth omitted]";
  if (typeof value === "string") return value.length > 1200 ? `${value.slice(0, 1200)}…[truncated]` : value;
  if (typeof value === "number" || typeof value === "boolean" || value === null) return value;
  if (Array.isArray(value)) {
    if (value.length > 80) return [...value.slice(0, 80).map((item) => safeMetadataValue(item, depth + 1)), "…[items truncated]"];
    return value.map((item) => safeMetadataValue(item, depth + 1));
  }
  if (typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const [key, child] of Object.entries(value as Record<string, unknown>)) {
      if (["data", "mask", "character_masks"].includes(key) && typeof child === "string" && child.length > 200) {
        out[key] = `[${child.length} chars omitted]`;
      } else if (key === "character_masks" && Array.isArray(child)) {
        out[key] = `[${child.length} masks omitted]`;
      } else {
        out[key] = safeMetadataValue(child, depth + 1);
      }
    }
    return out;
  }
  return String(value);
}

function summarizeMetadataValue(text: string): string {
  try {
    const parsed = JSON.parse(text) as unknown;
    return JSON.stringify(safeMetadataValue(parsed), null, 2);
  } catch {
    return text.length > 1200 ? `${text.slice(0, 1200)}…[truncated]` : text;
  }
}

function splitOutboundText(text: string): string[] {
  const limit = 1800;
  const chunks: string[] = [];
  for (let offset = 0; offset < text.length; offset += limit) chunks.push(text.slice(offset, offset + limit));
  return chunks.length > 0 ? chunks : [text];
}

function formatPngMetadata(bytes: Buffer, ref: string, emptyText: string, invalidText: string): string {
  const entries = decodePngText(bytes);
  if (entries === null) return `${invalidText}\nref: ${ref}`;
  if (entries.length === 0) return `${emptyText}\nref: ${ref}`;
  const body = entries.map(({ keyword, text }) => `${keyword}:\n${summarizeMetadataValue(text)}`).join("\n\n");
  return `PNG 元数据（机械提取）\nref: ${ref}\n\n${body}`.slice(0, PNG_METADATA_LIMIT);
}

/** macOS sips 压缩：GIF 取首帧、超尺寸缩到 1280px，输出 JPEG；失败返回 null。 */
function shrink(file: string): Buffer | null {
  try {
    const out = `${tmpdir()}/look-shrink-${Date.now()}-${Math.random().toString(16).slice(2, 6)}.jpg`;
    const res = spawnSync("sips", ["-s", "format", "jpeg", "-s", "formatOptions", "70", "-Z", "1280", file, "--out", out], { timeout: 20_000 });
    if (res.status !== 0) return null;
    const buf = readFileSync(out);
    unlinkSync(out);
    return buf.length > 0 ? buf : null;
  } catch {
    return null;
  }
}
