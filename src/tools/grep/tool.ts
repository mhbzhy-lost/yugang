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
import { REPO_ROOT } from "../../paths.ts";

/** args 静态类型：与 TOOL.md 的参数 Schema 一一对应；运行时 Schema 只有 manifest 这一份。 */
interface GrepArgs {
  pattern: string;
  path?: string;
  glob?: string;
  ignoreCase?: boolean;
  limit?: number;
}

const MAX_GREP_FILES = 1000;
const MAX_GREP_BYTES = 20 * 1024 * 1024;
const MAX_PATTERN_LENGTH = 500;

/** 线性通配符匹配（支持 * 和 ?），避免多通配符正则回溯。 */
function matchGlob(pattern: string, text: string): boolean {
  let pi = 0;
  let ti = 0;
  let starIdx = -1;
  let matchIdx = 0;
  while (ti < text.length) {
    if (pi < pattern.length && (pattern[pi] === "?" || pattern[pi] === text[ti])) {
      pi++;
      ti++;
    } else if (pi < pattern.length && pattern[pi] === "*") {
      starIdx = pi;
      matchIdx = ti;
      pi++;
    } else if (starIdx !== -1) {
      pi = starIdx + 1;
      matchIdx++;
      ti = matchIdx;
    } else {
      return false;
    }
  }
  while (pi < pattern.length && pattern[pi] === "*") pi++;
  return pi === pattern.length;
}

/** 尽力检测高危嵌套量词（如 (a+)+、(a*)*、([a-z]+)+），拦截指数级 ReDoS。 */
function hasNestedQuantifier(pattern: string): boolean {
  const stack: Array<{ hasQuantifier: boolean }> = [];
  let inClass = false;
  for (let i = 0; i < pattern.length; i++) {
    const ch = pattern[i]!;
    if (ch === "\\") { i++; continue; }
    if (inClass) {
      if (ch === "]") inClass = false;
      continue;
    }
    if (ch === "[") { inClass = true; continue; }
    if (ch === "(") {
      stack.push({ hasQuantifier: false });
      if (pattern[i + 1] === "?") i++;
      continue;
    }
    if (ch === ")") {
      const frame = stack.pop();
      if (!frame) continue;
      const next = pattern[i + 1];
      if (next === "*" || next === "+" || next === "{") {
        if (frame.hasQuantifier) return true;
        if (stack.length > 0) stack[stack.length - 1]!.hasQuantifier = true;
      } else if (frame.hasQuantifier && stack.length > 0) {
        stack[stack.length - 1]!.hasQuantifier = true;
      }
      continue;
    }
    if (ch === "*" || ch === "+") {
      if (stack.length > 0) stack[stack.length - 1]!.hasQuantifier = true;
      continue;
    }
    if (ch === "?" && i > 0) {
      const prev = pattern[i - 1];
      if (prev !== "*" && prev !== "+" && prev !== "?" && prev !== "}") {
        if (stack.length > 0) stack[stack.length - 1]!.hasQuantifier = true;
      }
      continue;
    }
    if (ch === "{") {
      const rest = pattern.slice(i);
      const brace = /^\{\d+(?:,\d*)?\}/.exec(rest);
      if (brace) {
        if (stack.length > 0) stack[stack.length - 1]!.hasQuantifier = true;
        i += brace[0].length - 1;
      }
    }
  }
  return false;
}

/** 主人闸是硬前提：无主人配置时 factory 返回 undefined，由注册方跳过（不进工具面）。 */
export function createGrepTool(manifest: ToolManifest, deps: ToolPackageDeps): ToolRegistration | undefined {
  if (!deps.master) return undefined;
  const p = deps.prompts;
  ensureSandRoot();
  const root = REPO_ROOT;

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
      if (typeof args.pattern !== "string" || args.pattern.length > MAX_PATTERN_LENGTH || hasNestedQuantifier(args.pattern)) {
        throw new Error(p.messages["grep_bad_regex"] ?? "grep_bad_regex");
      }
      let re: RegExp;
      try {
        re = new RegExp(args.pattern, args.ignoreCase ? "i" : "");
      } catch {
        throw new Error(p.messages["grep_bad_regex"] ?? "grep_bad_regex");
      }
      const limit = Math.min(Math.max(1, Math.floor(args.limit ?? 60)), 200);
      const glob = args.glob;
      const label = (full: string): string => (full.startsWith(root + sep) ? full.slice(root.length + 1) : full);
      const varRoot = join(root, "var");
      const distRoot = join(root, "dist");
      const explicitVar = base === varRoot || base.startsWith(varRoot + sep);
      const explicitDist = base === distRoot || base.startsWith(distRoot + sep);

      const hits: string[] = [];
      let filesScanned = 0;
      let bytesScanned = 0;
      const scanFile = (full: string): void => {
        if (filesScanned >= MAX_GREP_FILES || bytesScanned >= MAX_GREP_BYTES) return;
        const rel = label(full);
        if (rel === ".env" || rel === join("config", "auth.json")) return;
        if (BIN_EXT.has(extname(full).toLowerCase())) return;
        if (glob && !matchGlob(glob, full.split(sep).pop() ?? "") && !matchGlob(glob, rel)) return;
        let stat;
        try {
          stat = statSync(full);
        } catch {
          return;
        }
        if (!stat.isFile() || stat.size > 2_000_000) return;
        if (filesScanned >= MAX_GREP_FILES || bytesScanned + stat.size > MAX_GREP_BYTES) return;
        filesScanned++;
        bytesScanned += stat.size;
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
        if (hits.length >= limit || filesScanned >= MAX_GREP_FILES || bytesScanned >= MAX_GREP_BYTES || depth > 6) return;
        let entries;
        try {
          entries = readdirSync(dir, { withFileTypes: true });
        } catch {
          return;
        }
        for (const entry of entries) {
          if (hits.length >= limit || filesScanned >= MAX_GREP_FILES || bytesScanned >= MAX_GREP_BYTES) return;
          const full = join(dir, entry.name);
          if (entry.isDirectory()) {
            if (entry.name === "node_modules" || entry.name === ".git" || entry.name === ".trash" || entry.name === ".pi") continue;
            if (!explicitVar && full === varRoot) continue;
            if (!explicitDist && full === distRoot) continue;
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
        : hits.join("\n") + "\n" + (p.messages["grep_done_hint"] ?? "");
      return { output: [{ type: "text", text }] };
    },
  });
}
