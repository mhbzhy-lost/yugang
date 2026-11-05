/**
 * 内嵌 prompt 扫描：src/ 里不该出现大段中文/英文提示词，它们应该在 prompt/ 下。
 *
 * 这不是安全机制，是给审查用的护栏：阈值取「一条中文字面量里 >= 12 个汉字」，
 * 正常错误信息与日志远低于它，真正的 prompt 一定超过它。
 */
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";

export interface Violation {
  file: string;
  cjk: number;
  sample: string;
}

export function scanSource(text: string, file = ""): Violation[] {
  const source = text.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");
  const violations: Violation[] = [];
  const re = /"([^"\\\n]{8,})"|'([^'\\\n]{8,})'|`([^`\\]{8,}?)`/g;
  let match: RegExpExecArray | null;
  while ((match = re.exec(source))) {
    const literal = match[1] ?? match[2] ?? match[3] ?? "";
    const cjk = (literal.match(/[\u4e00-\u9fff]/g) ?? []).length;
    if (cjk >= 12) violations.push({ file, cjk, sample: literal.slice(0, 24) });
  }
  return violations;
}

export function scanDir(dir: string): Violation[] {
  const violations: Violation[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) violations.push(...scanDir(path));
    else if (entry.name.endsWith(".ts")) violations.push(...scanSource(readFileSync(path, "utf8"), path));
  }
  return violations;
}
