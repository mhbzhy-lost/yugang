/**
 * 鱼缸自改工具组：read / edit / write / delete。
 *
 * 围栏：路径解析后必须落在仓库工作区内；.env、config/auth.json（凭据）、
 * .git/、node_modules/、.trash/ 一律硬封禁——凭据不能进模型上下文，版本库不能被改写。
 * delete 不真删，移入 .trash/ 可恢复。所有操作打印审计行。
 */
import { existsSync, mkdirSync, readdirSync, readFileSync, renameSync, statSync, writeFileSync } from "node:fs";
import { extname, join, resolve, sep } from "node:path";
import { Type } from "@earendil-works/pi-ai";
import { LiveDoc, defineTool } from "@earendil-works/pi-durable";
import type { PromptSet } from "../prompts.ts";

export interface FsDeps {
  prompts: PromptSet;
  /** 可操作根，默认进程工作区（仓库根）。 */
  root?: string;
  /** 主人 QQ：只有主人触发的轮里才解锁，其余一律拒绝（机械判定，不信 prompt）。 */
  master: string;
  /** submissionId → 本轮触发消息；与 say 的引用绑定同源。 */
  triggerOf?: (roundId: unknown) => { messageId?: number | string; mentionsBot: boolean; userId?: number } | undefined;
}

const READ_CAP = 32_000;
const WRITE_CAP = 1_000_000;
const BIN_EXT = new Set([".png", ".jpg", ".jpeg", ".gif", ".webp", ".heic", ".db", ".db-wal", ".db-shm", ".zip", ".node", ".asar"]);

export function resolveInside(root: string, raw: string): string | null {
  const full = resolve(root, raw);
  if (full === root || !full.startsWith(root + sep)) return null;
  const rel = full.slice(root.length + 1);
  const first = rel.split(sep)[0];
  if (rel === ".env" || rel === join("config", "auth.json")) return null;
  if (first === ".git" || first === "node_modules" || first === ".trash" || first === ".pi") return null;
  return full;
}

export function createFsTools(deps: FsDeps) {
  const root = resolve(deps.root ?? process.cwd());
  const p = deps.prompts;

  function audited(op: string, rel: string, extra = ""): void {
    console.log(`[鱼缸] fs ${op} ${rel}${extra ? ` ${extra}` : ""}`);
  }

  // 主人身份闸：本轮触发消息的 userId 必须是主人，机械判定，群友注入文本造不出别人的触发身份
  async function assertUnlocked(api: { conversationId: string; snapshot: any }, context: unknown): Promise<void> {
    const live = await api.snapshot(LiveDoc, api.conversationId, context);
    const round = live?.run?.inputs?.[0];
    const trigger = round !== undefined ? deps.triggerOf?.(round) : undefined;
    if (!trigger || String(trigger.userId) !== deps.master) throw new Error(p.messages["fs_locked"] ?? "fs_locked");
  }

  const read = defineTool({
    name: "read",
    description: p.tools["read"].description,
    callers: ["model"],
    parameters: Type.Object({
      path: Type.String({ description: p.tools["read"].params["path"] ?? "" }),
      startLine: Type.Optional(Type.Number({ description: p.tools["read"].params["startLine"] ?? "" })),
      endLine: Type.Optional(Type.Number({ description: p.tools["read"].params["endLine"] ?? "" })),
    }),
    execute: async (args, api, context) => {
      await assertUnlocked(api as never, context);
      const full = resolveInside(root, args.path);
      if (!full) throw new Error(p.messages["fs_outside"] ?? "fs_outside");
      let st;
      try {
        st = statSync(full);
      } catch {
        throw new Error(p.messages["fs_missing"] ?? "fs_missing");
      }
      if (!st.isFile()) throw new Error(p.messages["fs_missing"] ?? "fs_missing");
      if (BIN_EXT.has(extname(full).toLowerCase())) throw new Error(p.messages["fs_binary"] ?? "fs_binary");

      const from = args.startLine !== undefined ? Math.max(1, Math.floor(args.startLine)) : undefined;
      const to = args.endLine !== undefined ? Math.max(1, Math.floor(args.endLine)) : undefined;

      // 不带行号：整文件，受大小上限保护；带行号：按行切片，大文件也能分段读
      if (from === undefined && to === undefined) {
        if (st.size > READ_CAP) throw new Error(p.messages["fs_too_big"] ?? "fs_too_big");
        audited("read", full.slice(root.length + 1), `${st.size}B`);
        return { output: [{ type: "text", text: readFileSync(full, "utf8") }] };
      }

      const lines = readFileSync(full, "utf8").split("\n");
      const start = (from ?? 1) - 1;
      const end = Math.min(lines.length, to ?? lines.length);
      if (start >= lines.length) throw new Error(p.messages["fs_missing"] ?? "fs_missing");
      const slice = lines.slice(start, Math.max(start + 1, end));
      const text = slice.map((line, i) => `${start + i + 1}\t${line}`).join("\n");
      audited("read", full.slice(root.length + 1), `${start + 1}-${start + slice.length}行`);
      return { output: [{ type: "text", text }] };
    },
  });

  // grep：只搜仓库内文本文件，返回「文件:行:内容」。大文件不整读，结果也有条数上限
  const grep = defineTool({
    name: "grep",
    description: p.tools["grep"].description,
    callers: ["model"],
    parameters: Type.Object({
      pattern: Type.String({ description: p.tools["grep"].params["pattern"] ?? "" }),
      path: Type.Optional(Type.String({ description: p.tools["grep"].params["path"] ?? "" })),
      glob: Type.Optional(Type.String({ description: p.tools["grep"].params["glob"] ?? "" })),
      ignoreCase: Type.Optional(Type.Boolean({ description: p.tools["grep"].params["ignoreCase"] ?? "" })),
      limit: Type.Optional(Type.Number({ description: p.tools["grep"].params["limit"] ?? "" })),
    }),
    execute: async (args, api, context) => {
      await assertUnlocked(api as never, context);
      const wanted = args.path ?? ".";
      const base = wanted === "." || wanted === "" ? root : resolveInside(root, wanted);
      if (!base) throw new Error(p.messages["fs_outside"] ?? "fs_outside");
      let re: RegExp;
      try {
        re = new RegExp(args.pattern, args.ignoreCase ? "i" : "");
      } catch {
        throw new Error(p.messages["grep_bad_regex"] ?? "grep_bad_regex");
      }
      const limit = Math.min(Math.max(1, Math.floor(args.limit ?? 60)), 200);
      const globRe = args.glob ? new RegExp(`^${args.glob.replace(/[.+^${}()|[\]\\]/g, "\\$&").replace(/\*/g, ".*").replace(/\?/g, ".")}$`) : undefined;

      const hits: string[] = [];
      const scanFile = (full: string): void => {
        const rel = full.slice(root.length + 1);
        if (rel === ".env" || rel === join("config", "auth.json")) return;
        if (BIN_EXT.has(extname(full).toLowerCase())) return;
        if (globRe && !globRe.test(full.split(sep).pop() ?? "") && !globRe.test(rel)) return;
        let stat;
        try {
          stat = statSync(full);
        } catch {
          return;
        }
        if (!stat.isFile() || stat.size > 2_000_000) return;
        let content: string;
        try {
          content = readFileSync(full, "utf8");
        } catch {
          return;
        }
        const lines = content.split("\n");
        for (let i = 0; i < lines.length && hits.length < limit; i++) {
          const line = lines[i] ?? "";
          if (line.length > 300) continue;
          if (re.test(line)) hits.push(`${rel}:${i + 1}:${line.trim().slice(0, 200)}`);
        }
      };

      const walk = (dir: string, depth: number): void => {
        if (hits.length >= limit || depth > 6) return;
        let entries;
        try {
          entries = readdirSync(dir, { withFileTypes: true });
        } catch {
          return;
        }
        for (const entry of entries) {
          if (hits.length >= limit) return;
          const full = join(dir, entry.name);
          const rel = full.slice(root.length + 1);
          if (entry.isDirectory()) {
            if (entry.name === "node_modules" || entry.name === ".git" || entry.name === ".trash" || entry.name === ".pi") continue;
            walk(full, depth + 1);
            continue;
          }
          if (!entry.isFile()) continue;
          scanFile(full);
        }
      };
      try {
        if (statSync(base).isFile()) scanFile(base);
        else walk(base, 0);
      } catch {
        throw new Error(p.messages["fs_missing"] ?? "fs_missing");
      }

      audited("grep", `${args.pattern} @ ${base.slice(root.length + 1) || "."}`, `${hits.length}命中`);
      const text = hits.length === 0
        ? (p.messages["grep_none"] ?? "grep_none")
        : hits.join("\n");
      return { output: [{ type: "text", text }] };
    },
  });

  const edit = defineTool({
    name: "edit",
    description: p.tools["edit"].description,
    callers: ["model"],
    parameters: Type.Object({
      path: Type.String({ description: p.tools["edit"].params["path"] ?? "" }),
      oldText: Type.String({ description: p.tools["edit"].params["oldText"] ?? "" }),
      newText: Type.String({ description: p.tools["edit"].params["newText"] ?? "" }),
    }),
    execute: async (args, api, context) => {
      await assertUnlocked(api as never, context);
      const full = resolveInside(root, args.path);
      if (!full) throw new Error(p.messages["fs_outside"] ?? "fs_outside");
      let before: string;
      try {
        before = readFileSync(full, "utf8");
      } catch {
        throw new Error(p.messages["fs_missing"] ?? "fs_missing");
      }
      const count = before.split(args.oldText).length - 1;
      if (count === 0) throw new Error(p.messages["fs_not_found_text"] ?? "fs_not_found_text");
      if (count > 1) throw new Error(p.messages["fs_ambiguous_text"] ?? "fs_ambiguous_text");
      const after = before.replace(args.oldText, args.newText);
      if (after.length > WRITE_CAP) throw new Error(p.messages["fs_too_big"] ?? "fs_too_big");
      writeFileSync(full, after);
      audited("edit", full.slice(root.length + 1), `${before.length}→${after.length}`);
      return { output: [{ type: "text", text: "ok" }] };
    },
  });

  const write = defineTool({
    name: "write",
    description: p.tools["write"].description,
    callers: ["model"],
    parameters: Type.Object({
      path: Type.String({ description: p.tools["write"].params["path"] ?? "" }),
      content: Type.String({ description: p.tools["write"].params["content"] ?? "" }),
    }),
    execute: async (args, api, context) => {
      await assertUnlocked(api as never, context);
      const full = resolveInside(root, args.path);
      if (!full) throw new Error(p.messages["fs_outside"] ?? "fs_outside");
      if (args.content.length > WRITE_CAP) throw new Error(p.messages["fs_too_big"] ?? "fs_too_big");
      const existed = existsSync(full);
      mkdirSync(join(full, ".."), { recursive: true });
      writeFileSync(full, args.content);
      audited("write", full.slice(root.length + 1), `${existed ? "overwrite" : "create"} ${args.content.length}c`);
      return { output: [{ type: "text", text: "ok" }] };
    },
  });

  const del = defineTool({
    name: "delete",
    description: p.tools["delete"].description,
    callers: ["model"],
    parameters: Type.Object({ path: Type.String({ description: p.tools["delete"].params["path"] ?? "" }) }),
    execute: async (args, api, context) => {
      await assertUnlocked(api as never, context);
      const full = resolveInside(root, args.path);
      if (!full) throw new Error(p.messages["fs_outside"] ?? "fs_outside");
      if (!existsSync(full)) throw new Error(p.messages["fs_missing"] ?? "fs_missing");
      const trash = join(root, ".trash");
      mkdirSync(trash, { recursive: true });
      const dest = join(trash, `${Date.now()}-${full.split(sep).pop()}`);
      renameSync(full, dest);
      audited("delete", full.slice(root.length + 1), "to .trash/");
      return { output: [{ type: "text", text: "ok: moved to .trash/" }] };
    },
  });

  return { read, grep, edit, write, del };
}
