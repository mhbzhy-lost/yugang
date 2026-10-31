/**
 * grep —— 在仓库或 /tmp/yugang 草稿区里搜文本，返回「路径:行号:内容」（仅主人）。
 *
 * 只搜文本文件：.env、config/auth.json、.git、node_modules、.trash、.pi 与二进制一律跳过，
 * 单文件超 2MB 跳过，目录最深 6 层。相对路径搜仓库，绝对路径只认 /tmp/yugang。
 * 路径围栏、封禁、审计与主人身份闸集中在 ../fs-shared.ts，这里不恢复任何 shell / MCP 能力。
 *
 * 说明文字与参数 Schema 唯一来自 TOOL.md manifest（factory 只消费它，不再有第二份运行时定义）。
 */
import { readdirSync, readFileSync, statSync } from "node:fs";
import { extname, isAbsolute, join, resolve, sep } from "node:path";
import { defineTool, type ToolRegistration } from "@earendil-works/pi-durable";
import { manifestParameters, toolFullDescription } from "../manifest.ts";
import type { ToolManifest, ToolPackageDeps } from "../types.ts";
import { assertTriggeredByMaster, audited, BIN_EXT, ensureSandRoot, fenceReadablePath, resolveInside, SAND_ROOT, withinSand } from "../fs-shared.ts";

/** args 静态类型：与 TOOL.md 的参数 Schema 一一对应；运行时 Schema 只有 manifest 这一份。 */
interface GrepArgs {
  pattern: string;
  path?: string;
  glob?: string;
  ignoreCase?: boolean;
  limit?: number;
}

/** 主人闸是硬前提：无主人配置时 factory 返回 undefined，由注册方跳过（不进工具面）。 */
export function createGrepTool(manifest: ToolManifest, deps: ToolPackageDeps): ToolRegistration | undefined {
  if (!deps.master) return undefined;
  const p = deps.prompts;
  ensureSandRoot();
  const root = resolve(process.cwd());

  return defineTool({
    name: manifest.name,
    description: toolFullDescription(manifest),
    callers: ["model"],
    parameters: manifestParameters<GrepArgs>(manifest),
    execute: async (args, api, context) => {
      await assertTriggeredByMaster(deps, api as never, context, p.messages["fs_locked"] ?? "fs_locked");
      const wanted = args.path ?? ".";
      const base = isAbsolute(wanted) ? withinSand(wanted) : wanted === "." || wanted === "" ? root : resolveInside(root, wanted);
      if (!base) throw new Error(p.messages["fs_outside"] ?? "fs_outside");
      // 起点本身过符号链接围栏：目录链接逃逸会让整个 walk 落到允许范围外（walk 内部本就跳过链接项）
      const fence = fenceReadablePath(isAbsolute(wanted) ? SAND_ROOT : root, base);
      if (!fence.ok) {
        if (fence.reason === "missing") throw new Error(p.messages["fs_missing"] ?? "fs_missing");
        if (fence.reason === "link") throw new Error(p.messages["fs_link"] ?? "fs_link");
        throw new Error(p.messages["fs_outside"] ?? "fs_outside");
      }
      let re: RegExp;
      try {
        re = new RegExp(args.pattern, args.ignoreCase ? "i" : "");
      } catch {
        throw new Error(p.messages["grep_bad_regex"] ?? "grep_bad_regex");
      }
      const limit = Math.min(Math.max(1, Math.floor(args.limit ?? 60)), 200);
      const globRe = args.glob ? new RegExp(`^${args.glob.replace(/[.+^${}()|[\]\\]/g, "\\$&").replace(/\*/g, ".*").replace(/\?/g, ".")}$`) : undefined;
      const label = (full: string): string => (full.startsWith(root + sep) ? full.slice(root.length + 1) : full);

      const hits: string[] = [];
      const scanFile = (full: string): void => {
        const rel = label(full);
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

      audited("grep", `${args.pattern} @ ${label(base) || "."}`, `${hits.length}命中`);
      const text = hits.length === 0
        ? (p.messages["grep_none"] ?? "grep_none")
        : hits.join("\n");
      return { output: [{ type: "text", text }] };
    },
  });
}
