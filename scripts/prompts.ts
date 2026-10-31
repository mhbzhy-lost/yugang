/**
 * 审查用：把项目里所有会进入模型上下文的文字列出来。
 *
 *   npm run prompts
 *
 * 说明文字现在分两处：prompt/ 下的 system/persona/message 文件，以及每个工具包的
 * src/tools/<name>/TOOL.md（摘要 + Schema + 使用指南，唯一模型侧来源）。本脚本两处都列，
 * 并按 loader 的真实注册结果标出 eager/deferred，最后照常扫描 src/ 的内嵌 prompt。
 * 只读仓库文件，不读 .env、不读凭据。
 */
import { mkdtempSync, readFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { auditPrompts, loadPrompts } from "../src/prompts.ts";
import { scanDir } from "../src/prompt-lint.ts";
import { DEFAULT_LIMITS } from "../src/egress/policy.ts";
import { loadToolSurface } from "../src/tools/index.ts";
import { renderToolCatalog } from "../src/tools/catalog.ts";

const repoRoot = process.cwd();
const root = process.env.PROMPT_ROOT ?? join(repoRoot, "prompt");
const prompts = loadPrompts(root);

console.log("== prompt 文件（system / persona / message）\n");
for (const file of auditPrompts(root)) {
  console.log(`  ${file.file.padEnd(20)} ${String(file.bytes).padStart(5)}B  sha256:${file.sha256}`);
}

// 用一份「依赖全配」的 deps 跑真实 loader：主人工具也会注册（本脚本只读不写，不连 QQ）。
// 生产上没配 MASTER_QQ 时，主人专属工具不进 agent.tools / agent.deferred / tool_catalog。
const mediaRoot = mkdtempSync(join(tmpdir(), "yg-prompts-"));
const surface = await loadToolSurface({
  prompts,
  mediaRoot,
  limits: { ...DEFAULT_LIMITS, mediaRoot },
  react: () => {},
  master: "0",
});

console.log(`\n== 工具包 ${surface.manifests.length} 个（src/tools/<name>/TOOL.md + tool.ts，loader 实际注册结果）\n`);
for (const manifest of surface.manifests) {
  const registration = surface.tools.find((tool) => tool.name === manifest.name);
  const status = registration?.deferred === true ? "deferred" : "eager";
  const sha256 = createHash("sha256").update(readFileSync(manifest.path, "utf8")).digest("hex").slice(0, 12);
  const properties = Object.keys(manifest.parameters.properties ?? {});
  const required = manifest.parameters.required ?? [];
  const params = properties.length === 0
    ? "（无参数）"
    : `[${properties.map((p) => (required.includes(p) ? p : `${p}?`)).join(", ")}]`;
  const guideLines = manifest.guide.split("\n").length;
  console.log(`  ${manifest.name}  ${status.padEnd(8)} sha256:${sha256}  指南 ${guideLines} 行`);
  console.log(`    路径：${relative(repoRoot, manifest.path)}`);
  console.log(`    摘要：${manifest.description}`);
  console.log(`    参数：${params}`);
}
const deferredNames = surface.tools.filter((t) => t.deferred === true).map((t) => t.name);
console.log(`\n  eager：${surface.tools.filter((t) => t.deferred !== true).map((t) => t.name).join(", ")}`);
console.log(`  deferred（${deferredNames.length} 个，先 tool_search 加载、下一次请求起可调用）：${deferredNames.join(", ")}`);
console.log("  注：生产未配 MASTER_QQ 时，主人专属工具不进任何工具面。");

console.log("\n== runtime section（prompt/runtime.md，人格无关的运行时协议）\n");
for (const paragraph of prompts.runtime.split("\n\n")) console.log(`  ${paragraph.replaceAll("\n", "\n  ")}\n`);

console.log("== tool_catalog section（每次请求注入的已启用工具目录）\n");
for (const line of renderToolCatalog(surface.manifests, prompts.messages).split("\n")) console.log(`  ${line}`);

console.log(`\n== 工具文案 ${Object.keys(prompts.messages).length} 条（拒绝理由 + 回执，prompt/messages.md）\n`);
for (const [code, text] of Object.entries(prompts.messages).slice(0, 6)) {
  console.log(`  ${code.padEnd(16)} ${text}`);
}
console.log("  …（其余见 prompt/messages.md）");

console.log(`\n== 人格 ${prompts.persona.length} 字，来自 prompt/persona.md\n`);
console.log(`${prompts.persona.split("\n").slice(0, 3).join("\n")}\n…`);

console.log(`\n== 人格书 ${Object.keys(prompts.personas).length} 本（prompt/personas/*.md）\n`);
for (const [name, book] of Object.entries(prompts.personas)) {
  const opener = book.opener ? "，[开场白 ✓]" : "";
  console.log(`  ${name}: ${book.body.length} 字${opener}，首行「${book.body.split("\n")[0]}」`);
}

console.log("\n== pi-durable 注入的 prompt\n");
console.log("  compaction: 已禁用（默认会注入一段库自带的总结提示词）");
console.log("  system prompt: 全部 section 来自本项目扩展（runtime / persona / tool_catalog / ops / people / watched / meme_tags）");

// 顺手扫一遍源码，确认没有内嵌的 prompt 字面量
const violations = scanDir(join(repoRoot, "src"));
console.log(`\n== 源码内嵌扫描：${violations.length === 0 ? "干净" : `${violations.length} 处可疑`}`);
for (const v of violations) console.log(`  ${v.file}: 中文 ${v.cjk} 字「${v.sample}…」`);
