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
 */
import { lstatSync, readdirSync, type Dirent } from "node:fs";
import { join, resolve } from "node:path";
import { Type } from "@earendil-works/pi-ai";
import { LiveDoc, defineTool } from "@earendil-works/pi-durable";
import { DEFAULT_LIMITS } from "../egress/policy.ts";
import { checkMemeSource, type MemeSourceCode } from "../media/meme-store.ts";
import { renderTemplate, requireTool, type PromptSet } from "../prompts.ts";

export interface MemeImportManifest {
  roundId: string;
  refs: string[];
  /** 这一轮已经看过的 ref：逐张导入的机械凭据（没看过的不许 meme_add）。 */
  lookedRefs: string[];
  createdAt: number;
}

/** 单次登记与单轮 look 的硬上限。 */
export const MEME_IMPORT_MAX = 50;

/** 当前轮的导入清单：key 是 LiveDoc 的 round id（submission id），轮结束即删。 */
const manifests = new Map<string, MemeImportManifest>();

/** 登记（多批合并）：同一轮里继续拉下一批不会把上一批的授权作废，已经看过的记录也保留。 */
export function registerMemeImportRound(roundId: string, refs: readonly string[]): void {
  const existing = manifests.get(roundId);
  const merged = existing ? [...existing.refs] : [];
  for (const ref of refs) {
    if (!merged.includes(ref)) merged.push(ref);
  }
  manifests.set(roundId, {
    roundId,
    refs: merged,
    lookedRefs: existing ? [...existing.lookedRefs] : [],
    createdAt: existing?.createdAt ?? Date.now(),
  });
}

export function memeImportManifestOf(roundId: string): MemeImportManifest | undefined {
  return manifests.get(roundId);
}

export function memeImportRefs(roundId: string): readonly string[] {
  return manifests.get(roundId)?.refs ?? [];
}

/** 这张图是不是本轮清单里的（meme_add 的本地导入授权就靠它）。 */
export function memeImportHas(roundId: string, ref: string): boolean {
  return memeImportRefs(roundId).includes(ref);
}

/** 这张清单里的图这一轮看过没：只有看过的才允许 meme_add。 */
export function memeImportLooked(roundId: string, ref: string): boolean {
  return manifests.get(roundId)?.lookedRefs.includes(ref) ?? false;
}

/** 本轮已经看过几张清单里的图（重复看不重复计，不占额度）。 */
export function memeImportLookedCount(roundId: string): number {
  return manifests.get(roundId)?.lookedRefs.length ?? 0;
}

/** 记下「这张确实被 look 成功看过」；只在描述真的返回后才由 look 调用。 */
export function memeImportMarkLooked(roundId: string, ref: string): void {
  const manifest = manifests.get(roundId);
  if (!manifest) return;
  if (!manifest.refs.includes(ref)) return;
  if (!manifest.lookedRefs.includes(ref)) manifest.lookedRefs.push(ref);
}

/** 本轮 look 的额度：有清单就按清单张数（上限 50），没有清单返回 undefined（普通轮照旧 2 张）。 */
export function memeImportLookLimit(roundId: string): number | undefined {
  const manifest = manifests.get(roundId);
  if (!manifest) return undefined;
  return Math.min(manifest.refs.length, MEME_IMPORT_MAX);
}

/** round 结束 / 异常 / 中断都要清：清单（含已看记录）绝不跨轮、跨群存活。 */
export function clearMemeImportRound(roundId: string): void {
  manifests.delete(roundId);
}

export interface MemeImportDeps {
  prompts: PromptSet;
  mediaRoot: string;
  master: string;
  triggerOf?: (roundId: unknown) => { messageId?: number | string; mentionsBot: boolean; userId?: number } | undefined;
  /** 单张上限：与出口的媒体大小限制一致，缺省用同一份默认值。 */
  maxBytes?: number;
}

export function createMemeImportTool(deps: MemeImportDeps) {
  const prompt = requireTool(deps.prompts, "meme_import");
  const root = resolve(deps.mediaRoot);
  const inboxDir = join(root, "meme-inbox");
  const maxBytes = deps.maxBytes ?? DEFAULT_LIMITS.maxMediaBytes;

  return defineTool({
    name: "meme_import",
    description: prompt.description,
    callers: ["model"],
    parameters: Type.Object({
      cursor: Type.Optional(Type.String({ description: prompt.params["cursor"] ?? "" })),
    }),
    execute: async (args, api, context) => {
      const live = await api.snapshot(LiveDoc, api.conversationId, context);
      const round = live?.run?.inputs?.[0];
      const trigger = round !== undefined ? deps.triggerOf?.(round) : undefined;
      const byMaster = deps.master !== "" && String(trigger?.userId ?? "") === deps.master;
      // 身份闸在代码里判定：不认模型自述的「主人让我收的」
      if (!byMaster || round === undefined) {
        throw new Error(deps.prompts.messages["meme_import_master"] ?? "meme_import_master");
      }

      const scan = scanInbox(inboxDir, maxBytes);
      const { valid, skipped } = scan;
      const cursor = (args.cursor ?? "").trim();
      const rest = cursor.length > 0 ? valid.filter((name) => name > cursor) : valid;
      const batch = rest.slice(0, MEME_IMPORT_MAX);
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
        lines.push(
          renderTemplate(deps.prompts.messages["meme_import_list"] ?? "{{count}}", {
            count: String(refs.length),
          }),
        );
        // refs 是数据不是文案：一行一个，让模型能逐个拿来当 look/meme_add 的参数
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
      return { output: [{ type: "text", text }] };
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
