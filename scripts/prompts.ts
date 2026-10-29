/**
 * 审查用：把项目里所有会进入模型上下文的文字列出来。
 *
 *   npm run prompts
 */
import { join } from "node:path";
import { auditPrompts, loadPrompts } from "../src/prompts.ts";
import { scanDir } from "../src/prompt-lint.ts";

const root = process.env.PROMPT_ROOT ?? join(process.cwd(), "prompt");
const prompts = loadPrompts(root);

console.log("== prompt 文件\n");
for (const file of auditPrompts(root)) {
  console.log(`  ${file.file.padEnd(20)} ${String(file.bytes).padStart(5)}B  sha256:${file.sha256}`);
}

console.log("\n== 工具说明（模型可见）\n");
for (const [name, tool] of Object.entries(prompts.tools)) {
  const params = Object.keys(tool.params);
  console.log(`  ${name}: ${tool.description.split("\n")[0]}${params.length ? `  [params: ${params.join(", ")}]` : ""}`);
}

console.log(`\n== 工具文案 ${Object.keys(prompts.messages).length} 条（拒绝理由 + 回执）\n`);
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
console.log("  system prompt: 只有 persona 一个 section，库不添加其它 section");

// 顺手扫一遍源码，确认没有内嵌的 prompt 字面量
const violations = scanDir(join(process.cwd(), "src"));
console.log(`\n== 源码内嵌扫描：${violations.length === 0 ? "干净" : `${violations.length} 处可疑`}`);
for (const v of violations) console.log(`  ${v.file}: 中文 ${v.cjk} 字「${v.sample}…」`);
