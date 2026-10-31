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
 */
import { spawnSync } from "node:child_process";
import { existsSync, readFileSync, rmSync, unlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve, sep, extname, relative } from "node:path";
import { Type, type Models } from "@earendil-works/pi-ai";
import { LiveDoc, defineTool } from "@earendil-works/pi-durable";
import { renderTemplate, requireTool, type PromptSet } from "../prompts.ts";
import { ledgerOf, recordLook } from "../egress/ledger.ts";
import { describeImage } from "../media/describe.ts";
import { MEME_IMPORT_MAX, memeImportHas, memeImportLookLimit, memeImportLooked, memeImportLookedCount, memeImportMarkLooked } from "./meme-import.ts";
import { checkMemeSource } from "../media/meme-store.ts";
import { DEFAULT_LIMITS } from "../egress/policy.ts";

export interface LookDeps {
  mediaRoot: string;
  prompts: PromptSet;
  /** 模型池：用独立请求把图描述成文字，图片从一开始就不进主会话。 */
  models?: Models;
  /** 视觉描述用的模型：config/models.json 的 models.vision；省略时与 main 相同。 */
  visionModel?: { provider: string; modelId: string };
  maxPerRun?: number;
  /** 主人 QQ：meme-inbox 的读取闸靠它判定身份；缺失时 inbox 一律不可读。 */
  master?: string;
  /** submissionId → 本轮触发消息；与 meme_add / say 同一个来源。 */
  triggerOf?: (roundId: unknown) => { messageId?: number | string; mentionsBot: boolean; userId?: number } | undefined;
  /** 单张上限：inbox 读取复核用，与出口的 maxMediaBytes 同一个数。 */
  maxBytes?: number;
}

/** 看图快捷开关：主人 /关看图 后置位（var/look-off.marker），重启保持；网关视觉管线不稳时止损用。 */
const LOOK_OFF_MARKER = join(process.cwd(), "var", "look-off.marker");
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

export function createLookTool(deps: LookDeps) {
  const root = resolve(deps.mediaRoot);
  const inboxDir = resolve(root, "meme-inbox");
  const limit = deps.maxPerRun ?? 2;
  const maxBytes = deps.maxBytes ?? DEFAULT_LIMITS.maxMediaBytes;
  const prompt = requireTool(deps.prompts, "look");

  return defineTool({
    name: "look",
    description: prompt.description,
    callers: ["model"],
    parameters: Type.Object({
      ref: Type.String({ description: prompt.params["ref"] ?? "" }),
    }),
    execute: async (args, api, context) => {
      if (lookDisabled) {
        return { output: [{ type: "text", text: deps.prompts.messages["look_cmd_off"] ?? "看图已关" }] };
      }
      const ref = args.ref.trim().replace(/^\[|\]$/g, "");
      const full = resolve(root, ref);
      const outside = full !== root && !full.startsWith(root + sep);
      if (outside) throw new Error(renderTemplate(deps.prompts.messages["look_outside"] ?? "{{ref}}", { ref }));

      const mime = MIME[extname(full).toLowerCase()];
      if (!mime) throw new Error(renderTemplate(deps.prompts.messages["look_type"] ?? "{{ref}}", { ref }));

      // 导入轮：只认本轮 meme_import 清单里、且本轮触发是主人的 inbox 图，额度按清单张数（上限 50）；
      // 其余一律按普通轮 2 张。inbox 不是普通媒体，那两张额度不能拿来授权读它。
      const localRef = relative(root, full).split(sep).join("/");
      const inInbox = full === inboxDir || full.startsWith(inboxDir + sep);
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
      const importing = inInbox && roundId !== undefined && memeImportHas(roundId, localRef);
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
      if (!described) {
        return { output: [{ type: "text", text: deps.prompts.messages["look_unstable"] ?? "看不了" }] };
      }
      // 真的看成了才记帐：没描述成功不占额度，也不算「看过」（否则清单里的图永远 meme_add 不了）
      recordLook(api.conversationId);
      if (importing && roundId !== undefined) memeImportMarkLooked(roundId, localRef);
      return { output: [{ type: "text", text: described }] };
    },
  });
}

/** 用一次性请求把图描述成文字：图片只在这里过一次视觉管线。 */

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
