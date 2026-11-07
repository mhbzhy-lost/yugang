/**
 * 审查用：把项目里所有会进入模型上下文的文字列出来。
 *
 *   npm run prompts
 *
 * 说明文字分两处：prompt/ 下的 system/persona/message 文件，以及每个工具包的
 * src/tools/<name>/（TOOL.md 摘要与使用指南 + schema.json + messages.json 工具专属文案，
 * 唯一模型侧来源）。本脚本两处都列，并按 loader 的真实注册结果标出 eager/deferred；工具文案
 * 按归属分别列出（中心 prompt/messages.md 与各工具的 messages.json，后者已由 loader 合并
 * 进全局 messages 视图），最后照常扫描 src/ 的内嵌 prompt。
 * 只读仓库文件，不读 .env、不读凭据。
 */
import { PROMPT_ROOT, REPO_ROOT } from "../src/paths.ts";
import { mkdtempSync, readFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { auditPrompts, loadPrompts } from "../src/prompt/index.ts";
import { scanDir } from "../src/prompt/lint.ts";
import { DEFAULT_LIMITS } from "../src/egress/policy.ts";
import { loadToolSurface } from "../src/tools/index.ts";
import { makeReminderTask } from "../src/tools/remind/task.ts";
import { renderToolCatalog } from "../src/tools/catalog.ts";

const repoRoot = REPO_ROOT;
const root = PROMPT_ROOT;
const prompts = loadPrompts(root);
// 中心层条数：loadToolSurface 会把各工具的 tool-messages 就地合并进 prompts.messages，
// 合并后再数就分不出归属了，先记下
const centerMessageCount = Object.keys(prompts.messages).length;

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
  newsPrepare: async () => ({ status: "rejected", reason: "audit_only" }),
  // remind 工具的底座任务（宿主没传就不注册；审查视图要看到它）
  reminderTask: makeReminderTask({ messages: () => ({}), drain: async () => {}, log: () => {} }),
});

console.log(`\n== 工具包 ${surface.manifests.length} 个（src/tools/<name>/ 的 TOOL.md + schema.json + messages.json + tool.ts，loader 实际注册结果）\n`);
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
  const messageKeys = Object.keys(manifest.messages);
  console.log(`  ${manifest.name}  ${status.padEnd(8)} sha256:${sha256}  指南 ${guideLines} 行  文案 ${messageKeys.length} key`);
  console.log(`    路径：${relative(repoRoot, manifest.path)}`);
  console.log(`    摘要：${manifest.description}`);
  console.log(`    参数：${params}`);
  console.log(
    messageKeys.length === 0
      ? "    文案：（无 messages.json，文案走中心 prompt/messages.md）"
      : `    文案（messages.json）：${messageKeys.join(", ")}`,
  );
}
const deferredNames = surface.tools.filter((t) => t.deferred === true).map((t) => t.name);
console.log(`\n  eager：${surface.tools.filter((t) => t.deferred !== true).map((t) => t.name).join(", ")}`);
console.log(`  deferred（${deferredNames.length} 个，先 tool_search 加载、下一次请求起可调用）：${deferredNames.join(", ")}`);
console.log("  注：生产未配 MASTER_QQ 时，主人专属工具不进任何工具面。");

console.log("\n== runtime section（prompt/runtime.md，人格无关的运行时协议）\n");
for (const paragraph of prompts.runtime.split("\n\n")) console.log(`  ${paragraph.replaceAll("\n", "\n  ")}\n`);

console.log("== tool_catalog section（每次请求注入的已启用工具目录）\n");
for (const line of renderToolCatalog(surface.manifests, prompts.messages).split("\n")) console.log(`  ${line}`);

const totalMessages = Object.keys(prompts.messages).length;
console.log(
  `\n== 工具文案：中心 ${centerMessageCount} 条（prompt/messages.md）+ 工具块 ${totalMessages - centerMessageCount} 条 = 合并视图 ${totalMessages} 条\n`,
);
console.log("  中心（宿主/共享层，prompt/messages.md）前 6 条：");
for (const [code, text] of Object.entries(prompts.messages).slice(0, 6)) {
  console.log(`    ${code.padEnd(16)} ${text}`);
}
console.log("  …（其余见 prompt/messages.md）");
console.log("  工具专属（各自 messages.json，loader 合并时撞车会报错）：");
for (const manifest of surface.manifests) {
  const keys = Object.keys(manifest.messages);
  if (keys.length === 0) continue;
  console.log(`    ${manifest.name.padEnd(12)} ${keys.length} key`);
}

console.log(`\n== 人格 ${prompts.persona.length} 字，来自 prompt/persona.md\n`);
console.log(`${prompts.persona.split("\n").slice(0, 3).join("\n")}\n…`);

console.log(`\n== 人格书 ${Object.keys(prompts.personas).length} 本（prompt/personas/*.md）\n`);
for (const [name, book] of Object.entries(prompts.personas)) {
  const opener = book.opener ? "，[开场白 ✓]" : "";
  console.log(`  ${name}: ${book.body.length} 字${opener}，首行「${book.body.split("\n")[0]}」`);
}

console.log("\n== pi-durable 注入的 prompt\n");
console.log("  compaction: 已禁用（默认会注入一段库自带的总结提示词）");
console.log("  system prompt: 全部 section 来自本项目扩展（runtime / persona / tool_catalog / ops / people / watched）");

// 顺手扫一遍源码，确认没有内嵌的 prompt 字面量
const violations = scanDir(join(repoRoot, "src"));
console.log(`\n== 源码内嵌扫描：${violations.length === 0 ? "干净" : `${violations.length} 处可疑`}`);
for (const v of violations) console.log(`  ${v.file}: 中文 ${v.cjk} 字「${v.sample}…」`);
