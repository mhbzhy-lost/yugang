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
import { createHash } from "node:crypto";
import { inflateSync } from "node:zlib";
import { existsSync, readFileSync, rmSync, statSync, unlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve, sep, extname, relative } from "node:path";
import { LiveDoc, defineTool, type ToolRegistration } from "@earendil-works/pi-durable";
import { renderTemplate } from "../../prompt/index.ts";

import { describeImage, isDescribeFiltered } from "../../media/describe.ts";
import { lookShrinkViaWorker, readBoundedFile, sniffImageMagic, usesSips } from "../../media/image-ops.ts";
import { checkMemeSource } from "../../media/meme-store.ts";
import { DEFAULT_LIMITS } from "../../egress/policy.ts";
import type { OutboundPayload } from "../say-shared.ts";
import { OutboxDoc } from "../../store.ts";
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

/** 扩展名 → 魔数嗅探应有的真实格式（.jpg/.jpeg 同义）；魔数与扩展名对不上就拒。 */
const SNIFF_EXT: Record<string, string> = {
  ".png": "png",
  ".jpg": "jpg",
  ".jpeg": "jpg",
  ".gif": "gif",
  ".webp": "webp",
};

export function createLookTool(manifest: ToolManifest, deps: ToolPackageDeps): ToolRegistration {
  const root = resolve(deps.mediaRoot);
  const inboxDir = resolve(root, "meme-inbox");
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
        // 与普通 look 同一道读取前机械闸：realpath 围栏 + maxMediaBytes + 魔数（这里只认 PNG）。
        const { bytes } = readLookImage(root, full, ref, maxBytes, deps.prompts.messages, true);
        const text = formatPngMetadata(
          bytes,
          localRef,
          deps.prompts.messages["look_metadata_empty"] ?? "PNG 没有可读的文本元数据",
          deps.prompts.messages["look_metadata_invalid"] ?? "不是可解析的 PNG 文件",
        );
        const items = splitOutboundText(text);
        const hash = createHash("sha256").update(bytes).digest("hex");
        const ts = Date.now();
        // 幂等键不依赖 api.callId（每次调用/每代都换，重放会重复发）：
        // 会话 + 本轮轮标识（run.inputs[0]，跨 generation 不变）+ 内容 hash 稳定派生。
        const key = `${api.conversationId}:look-metadata:${roundId === undefined ? "-" : String(roundId)}:${hash.slice(0, 32)}`;
        const payload: OutboundPayload = {
          items,
          quote: true,
          ...(trigger?.messageId !== undefined ? { quoteId: trigger.messageId } : {}),
          ...(trigger ? { quoteForce: trigger.mentionsBot } : {}),
          at: ts,
          key,
        };
        // 机械直发（同宿主 fish.enqueue 语义，src/fish/output.ts）：只入 outbox，不写
        // fish.outbound transcript entry——正文不进 active context / compact / memory / 普通历史；
        // 不经 say_*、不占开口额度。发送仍走唯一出口 drain → emit（幂等表按 key 去重）。
        await api.commit(async (tx) => {
          const box = await tx.doc(OutboxDoc, api.conversationId);
          box.queue.push({ ...payload, status: "queued", attempts: 0 });
        }, context);
        // 机械审计摘要：只有 ref/条数/长度/hash/key，正文不落 transcript、也不进日志。
        console.log(`[鱼缸] look metadata ref=${localRef} items=${items.length} chars=${text.length} hash=${hash.slice(0, 32)} key=${key}`);
        return { output: [{ type: "text", text: deps.prompts.messages["look_metadata_sent"] ?? "metadata_sent" }] };
      }

      const importing = inInbox && roundId !== undefined && memeImportHas(roundId, localRef);
      // 导入轮：只认本轮 meme_import 清单里、且本轮触发是主人的 inbox 图，额度按清单张数（上限 50）；
      // 普通看图没有额度
      if (importing && roundId !== undefined) {
        // 看过的重复看不占额度（也不重复花视觉调用）：直接让它去 meme_add
        if (memeImportLooked(roundId, localRef)) {
          throw new Error(renderTemplate(deps.prompts.messages["look_import_seen"] ?? "{{ref}}", { ref: localRef }));
        }
        const importCap = Math.min(memeImportLookLimit(roundId) ?? MEME_IMPORT_MAX, MEME_IMPORT_MAX);
        if (memeImportLookedCount(roundId) >= importCap) {
          throw new Error(
            renderTemplate(deps.prompts.messages["look_import_used"] ?? "{{count}}", {
              count: String(importCap),
              limit: String(importCap),
              ref: localRef,
            }),
          );
        }
      }

      // 与 metadata 同一道读取前机械闸：realpath 围栏 + maxMediaBytes + 魔数核对扩展名。
      const read = readLookImage(root, full, ref, maxBytes, deps.prompts.messages, false);
      let data: string;
      let outMime = mime;
      // 大图压缩后再进上下文：进会话的内容一旦定下就不能变（动它会破坏前缀缓存），
      // 所以在读取时就压——GIF 取首帧、超尺寸缩到 1280px、一律 JPEG，单张控制在几十 KB。
      // 压缩件只用于观看，不回写原文件。
      if (read.bytes.length > 150_000) {
        const shrunk = shrink(read.real);
        if (shrunk) {
          data = shrunk.toString("base64");
          outMime = "image/jpeg";
        } else {
          data = read.bytes.toString("base64");
        }
      } else {
        data = read.bytes.toString("base64");
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
      // 真的看成了才打标（导入轮清单额度）：没描述成功不算「看过」（否则清单里的图永远 meme_add 不了）
      if (importing && roundId !== undefined) memeImportMarkLooked(roundId, localRef);
      return { output: [{ type: "text", text: described.text }] };
    },
  });
}

/**
 * metadata 与普通 look 共用的读取前机械闸（fail-closed，两种模式同一份实现）：
 * realpath 围栏（拒符号链接/越界）→ 普通文件 + maxMediaBytes 上限 → 有界读取 →
 * 魔数核对扩展名。任何一环不过都以 tool 错误拒绝，绝不把越界/超限/伪装文件读进来。
 * 返回的 real 是解算后的真实路径，调用方以它继续压图/读取。
 */
function readLookImage(
  root: string,
  full: string,
  ref: string,
  maxBytes: number,
  messages: Record<string, string>,
  pngOnly: boolean,
): { real: string; bytes: Buffer; mime: string } {
  const fence = fenceReadablePath(root, full);
  if (!fence.ok) {
    const key = fence.reason === "missing" ? "look_missing" : "look_outside";
    throw new Error(renderTemplate(messages[key] ?? "{{ref}}", { ref }));
  }
  const real = fence.real;
  let size: number;
  try {
    size = statSync(real).size;
  } catch {
    throw new Error(renderTemplate(messages["look_missing"] ?? "{{ref}}", { ref }));
  }
  if (size > maxBytes) {
    throw new Error(renderTemplate(messages["media_big"] ?? "{{size}}", { size: (size / 1048576).toFixed(1) }));
  }
  const bytes = readBoundedFile(real, maxBytes);
  if (!bytes) throw new Error(renderTemplate(messages["look_missing"] ?? "{{ref}}", { ref }));
  const ext = extname(real).toLowerCase();
  const mime = MIME[ext];
  const sniff = sniffImageMagic(bytes.subarray(0, 16));
  // 魔数必须与扩展名一致且是模型直收格式；metadata 只认 PNG。
  if (!mime || !sniff || sniff.convert || sniff.ext !== SNIFF_EXT[ext] || (pngOnly && sniff.ext !== "png")) {
    const key = pngOnly ? "look_metadata_invalid" : "look_type";
    throw new Error(renderTemplate(messages[key] ?? "{{ref}}", { ref }));
  }
  return { real, bytes, mime };
}

type PngTextEntry = { keyword: string; text: string };
const PNG_SIGNATURE = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);
/** 输出边界：总长约 12000 字、单条 ≤1800、最多 8 条；单块文本与解压展开各有上限。 */
const PNG_METADATA_TOTAL = 12_000;
const PNG_TEXT_LIMIT = 1_600;
const PNG_MAX_ENTRIES = 8;
const PNG_MAX_CHUNKS = 4096;
const OUTBOUND_ITEM_LIMIT = 1_800;
const OUTBOUND_MAX_ITEMS = 8;

/** 解压展开上限：zTXt/iTXt 的 inflate 带 maxOutputLength，zip bomb 撑不爆内存（超限抛错→跳过该块）。 */
function inflateBounded(data: Buffer): Buffer {
  return inflateSync(data, { maxOutputLength: PNG_TEXT_LIMIT });
}

function decodePngText(bytes: Buffer): PngTextEntry[] | null {
  if (bytes.length < PNG_SIGNATURE.length || !bytes.subarray(0, PNG_SIGNATURE.length).equals(PNG_SIGNATURE)) return null;
  const entries: PngTextEntry[] = [];
  let offset = PNG_SIGNATURE.length;
  let total = 0;
  let chunks = 0;
  while (offset + 12 <= bytes.length && chunks < PNG_MAX_CHUNKS && entries.length < PNG_MAX_ENTRIES) {
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
        const keyword = sanitizeMetadataText(data.subarray(0, split).toString("latin1")).slice(0, 79);
        const text = sanitizeMetadataText(data.subarray(split + 1).toString("utf8")).slice(0, PNG_TEXT_LIMIT);
        entries.push({ keyword, text });
        total += text.length;
      }
    } else if (type === "zTXt") {
      const split = data.indexOf(0);
      if (split > 0 && data[split + 1] === 0) {
        try {
          const keyword = sanitizeMetadataText(data.subarray(0, split).toString("latin1")).slice(0, 79);
          const text = sanitizeMetadataText(inflateBounded(data.subarray(split + 2)).toString("utf8")).slice(0, PNG_TEXT_LIMIT);
          entries.push({ keyword, text });
          total += text.length;
        } catch {
          /* 损坏/展开超限的单个压缩文本块不影响其它元数据。 */
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
          const raw = compressed ? inflateBounded(data.subarray(cursor)) : data.subarray(cursor);
          const keyword = sanitizeMetadataText(fields[0].toString("latin1")).slice(0, 79);
          const text = sanitizeMetadataText(raw.toString("utf8")).slice(0, PNG_TEXT_LIMIT);
          entries.push({ keyword, text });
          total += text.length;
        } catch {
          /* 损坏/展开超限的单个压缩文本块不影响其它元数据。 */
        }
      }
    }
    if (total > PNG_METADATA_TOTAL || type === "IEND") break;
  }
  return entries;
}

/** 不可见/控制字符（C0/C1、bidi、零宽、BOM、软连字符、不可见运算符、tag 字符）；
 *  保留 \n（可读换行），\r 与 \t 在 sanitize 里先归一。 */
const INVISIBLE_RE = /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F-\u009F\u00AD\u200B-\u200F\u202A-\u202E\u2060-\u2064\u2066-\u206F\uFEFF\uFFF9-\uFFFB\u{E0000}-\u{E007F}]/gu;

function sanitizeMetadataText(text: string): string {
  return text
    .replace(/\r\n?/g, "\n")
    .replace(/\t/g, " ")
    .replace(INVISIBLE_RE, "");
}

/** 敏感字段名（token/key/secret/password/cookie/authorization/access/refresh）：
 *  camelCase 先拆成 snake_case 再按词边界判定；PNG 文本块的 keyword/keywords 不是凭据。 */
function isSensitiveKey(key: string): boolean {
  const k = key.replace(/([a-z0-9])([A-Z])/g, "$1_$2").toLowerCase();
  if (k === "keyword" || k === "keywords") return false;
  return /(?:^|[^a-z0-9])(?:token|key|secret|password|passwd|cookie|authorization|access|refresh)s?(?:[^a-z0-9]|$)/.test(k)
    || /(?:api_?key|access_?token|refresh_?token|secret_?key|private_?key|client_?secret)/.test(k);
}

/** 赋值形态（name=value / name: value，含 JSON 渲染形态）：字段名是否敏感交给 isSensitiveKey
 *  同一套判定（keyword 等非凭据字段不误伤），只遮蔽值，保留字段名与可读换行。 */
const ASSIGN_RE = /(["']?)([A-Za-z0-9_.-]+)\1([ \t]*[:=][ \t]*)("[^"]*"|'[^']*'|[^\s,;]+)/g;

/** 本机绝对路径遮蔽：引号内整条（含空格）优先，再裸 POSIX / Windows 盘符 / UNC；
 *  lookbehind 避开 URL（https://…）与相对路径（inbound/…），ref 行保持可读。 */
function maskSensitiveText(text: string): string {
  return text
    .replace(ASSIGN_RE, (match, q: string, name: string, sep: string) =>
      isSensitiveKey(name) ? `${q}${name}${q}${sep}[masked]` : match)
    .replace(/\bBearer[ \t]+[A-Za-z0-9._~+/=-]+/gi, "Bearer [masked]")
    .replace(/\bsk-[A-Za-z0-9_-]{16,}/g, "[masked]")
    .replace(/(["'])(\/[^\n"']*|[A-Za-z]:\\[^\n"']*|\\\\[^\n"']*)\1/g, (_m, q: string) => `${q}[path]${q}`)
    .replace(/(?<![\w:/])\/[^\s"'<>|]*/g, "[path]")
    .replace(/\b[A-Za-z]:\\[^\s"'<>|]*/g, "[path]")
    .replace(/\\\\[^\s"'<>|]*/g, "[path]");
}

function safeMetadataValue(value: unknown, depth = 0): unknown {
  if (depth > 6) return "[depth omitted]";
  if (typeof value === "string") {
    const masked = maskSensitiveText(value);
    return masked.length > 1200 ? `${masked.slice(0, 1200)}…[truncated]` : masked;
  }
  if (typeof value === "number" || typeof value === "boolean" || value === null) return value;
  if (Array.isArray(value)) {
    if (value.length > 80) return [...value.slice(0, 80).map((item) => safeMetadataValue(item, depth + 1)), "…[items truncated]"];
    return value.map((item) => safeMetadataValue(item, depth + 1));
  }
  if (typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const [key, child] of Object.entries(value as Record<string, unknown>)) {
      if (isSensitiveKey(key)) {
        out[key] = "[masked]";
      } else if (["data", "mask", "character_masks"].includes(key) && typeof child === "string" && child.length > 200) {
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
    return text;
  }
}

/** 单个文本块渲染成一条可读元数据：清洗 + 遮蔽后按块上限截断（保留换行）。 */
function renderMetadataEntry(keyword: string, text: string): string {
  const value = maskSensitiveText(sanitizeMetadataText(summarizeMetadataValue(text)));
  const head = `${keyword || "(unnamed)"}:\n`;
  const room = Math.max(0, PNG_TEXT_LIMIT - head.length);
  const body = value.length > room ? `${value.slice(0, room)}…[truncated]` : value;
  return `${head}${body}`;
}

/** 拆成出站条目：单条 ≤1800、最多 8 条；优先在换行处切，保留可读换行。
 *  总长已在 formatPngMetadata 把住（≤12000），8×1800 足够容纳，不会丢尾。 */
function splitOutboundText(text: string): string[] {
  const chunks: string[] = [];
  let rest = text;
  while (rest.length > 0 && chunks.length < OUTBOUND_MAX_ITEMS) {
    if (rest.length <= OUTBOUND_ITEM_LIMIT) {
      chunks.push(rest);
      rest = "";
      break;
    }
    let cut = rest.lastIndexOf("\n", OUTBOUND_ITEM_LIMIT);
    if (cut < OUTBOUND_ITEM_LIMIT / 2) cut = OUTBOUND_ITEM_LIMIT;
    chunks.push(rest.slice(0, cut));
    rest = rest.slice(cut).replace(/^\n+/, "");
  }
  if (rest.length > 0 && chunks.length > 0) {
    const last = chunks[chunks.length - 1]!;
    const mark = "…[已截断]";
    chunks[chunks.length - 1] = last.length + mark.length <= OUTBOUND_ITEM_LIMIT ? last + mark : last.slice(0, OUTBOUND_ITEM_LIMIT - mark.length) + mark;
  }
  return chunks.length > 0 ? chunks : [text];
}

function formatPngMetadata(bytes: Buffer, ref: string, emptyText: string, invalidText: string): string {
  const entries = decodePngText(bytes);
  const safeRef = sanitizeMetadataText(ref);
  if (entries === null) return `${invalidText}\nref: ${safeRef}`;
  if (entries.length === 0) return `${emptyText}\nref: ${safeRef}`;
  const parts: string[] = [`PNG 元数据（机械提取）\nref: ${safeRef}`];
  let used = parts[0]!.length;
  let dropped = 0;
  for (const { keyword, text } of entries) {
    const body = renderMetadataEntry(keyword, text);
    if (used + body.length + 2 > PNG_METADATA_TOTAL) {
      dropped++;
      continue;
    }
    parts.push(body);
    used += body.length + 2;
  }
  if (dropped > 0) parts.push(`…[还有 ${dropped} 块元数据超出长度上限，已省略]`);
  return parts.join("\n\n").slice(0, PNG_METADATA_TOTAL);
}

/** 转述前压图：GIF 取首帧、长边归 1280px，输出 JPEG；失败返回 null。
 *  macOS 走 sips（参数逐字保留），其它平台走 sharp worker。 */
function shrink(file: string): Buffer | null {
  if (!usesSips()) return lookShrinkViaWorker(file);
  const out = `${tmpdir()}/look-shrink-${Date.now()}-${Math.random().toString(16).slice(2, 6)}.jpg`;
  try {
    const res = spawnSync("sips", ["-s", "format", "jpeg", "-s", "formatOptions", "70", "-Z", "1280", file, "--out", out], { timeout: 20_000 });
    if (res.status !== 0) return null;
    const buf = readFileSync(out);
    return buf.length > 0 ? buf : null;
  } catch {
    return null;
  } finally {
    // 临时件无论成败都清掉：转换失败/部分写入不在 tmpdir 留残文件。
    try {
      unlinkSync(out);
    } catch {
      /* 没产出就不用清 */
    }
  }
}
