/**
 * prompt 只能是磁盘上的 markdown：
 *  - 模型看到的每一段文字都能追溯到 prompt/ 下的某个文件
 *  - src/ 里没有内嵌的 prompt
 *  - pi-durable 自带的注入（compaction）已关闭
 */
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { createModels } from "@earendil-works/pi-ai/models";
import { fauxProvider } from "@earendil-works/pi-ai/providers/faux";
import { MemoryStorage } from "@earendil-works/pi-durable";
import { openFish } from "../src/harness.ts";
import { auditPrompts, loadPrompts, parseMessageTable, renderTemplate } from "../src/prompts.ts";
import { scanDir, scanSource } from "../src/prompt-lint.ts";
import { REJECTION_CODES } from "../src/egress/policy.ts";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";

const ROOT = fileURLToPath(new URL("..", import.meta.url));
const PROMPTS = join(ROOT, "prompt");
const ctx = BACKGROUND_CONTEXT;

test("每个 prompt 文件都存在且非空", () => {
  const files = auditPrompts(PROMPTS);
  assert.ok(files.length >= 4);
  for (const file of files) assert.ok(file.bytes > 0, `${file.file} 是空的`);
});

test("工具说明逐字来自 prompt/tools/*.md", async () => {
  const prompts = loadPrompts(PROMPTS);
  const fish = await openFish({
    storage: new MemoryStorage(),
    models: (() => {
      const m = createModels();
      m.setProvider(fauxProvider().provider);
      return m;
    })(),
    model: { provider: "faux", modelId: "faux-1" },
    promptRoot: PROMPTS,
    mediaRoot: mkdtempSync(join(tmpdir(), "yg-m-")),
    workspaceRoot: mkdtempSync(join(tmpdir(), "yg-w-")),
    emit: () => {},
  });

  try {
    const root = await fish.harness.root(ctx);
    const tools = (await root.agent(ctx)).tools;
    for (const name of ["say", "draw"] as const) {
      const tool = tools.find((t) => t.name === name);
      assert.ok(tool, `缺少工具 ${name}`);
      assert.equal(tool.description, readFileSync(join(PROMPTS, "tools", `${name}.md`), "utf8")
        .replace(/^---\r?\n[\s\S]*?\r?\n---\r?\n?/, "")
        .trim(), `${name} 的说明不是文件里的原文`);
    }
  } finally {
    await fish.close();
  }
});

test("pi-durable 的 compaction 已关掉", async () => {
  const fish = await openFish({
    storage: new MemoryStorage(),
    models: (() => {
      const m = createModels();
      m.setProvider(fauxProvider().provider);
      return m;
    })(),
    model: { provider: "faux", modelId: "faux-1" },
    promptRoot: PROMPTS,
    mediaRoot: mkdtempSync(join(tmpdir(), "yg-m-")),
    workspaceRoot: mkdtempSync(join(tmpdir(), "yg-w-")),
    emit: () => {},
  });
  try {
    assert.equal(fish.settings.compaction.enabled, false);
  } finally {
    await fish.close();
  }
});

test("src/ 里没有内嵌 prompt", () => {
  const violations = scanDir(join(ROOT, "src"));
  assert.deepEqual(
    violations.map((v) => `${v.file}: 中文 ${v.cjk} 字`),
    [],
    "有 prompt 字面量留在代码里，应该挪到 prompt/",
  );
});

test("扫描器本身能抓到内嵌 prompt", () => {
  const planted = 'const p = "你是一条鱼，要像群员一样说话，不要暴露自己是模型，也不要解释架构";';
  const hits = scanSource(planted, "planted.ts");
  assert.equal(hits.length, 1);
});

test("模板缺变量直接报错，不留半渲染的 prompt", () => {
  assert.throws(() => renderTemplate("a {{missing}} b", {}), /缺少变量/);
  assert.equal(renderTemplate("{{what}}", { what: "x" }), "x");
});

test("messages.md 格式错误会报出行号", () => {
  assert.throws(() => parseMessageTable("ok: fine\n这不是 key value", "m.md"), /m\.md:2/);
});

test("messages.md 里没有死文案，tools/ 里没有死文件", async () => {
  const prompts = loadPrompts(PROMPTS);
  const fish = await openFish({
    storage: new MemoryStorage(),
    models: (() => {
      const m = createModels();
      m.setProvider(fauxProvider().provider);
      return m;
    })(),
    model: { provider: "faux", modelId: "faux-1" },
    promptRoot: PROMPTS,
    mediaRoot: mkdtempSync(join(tmpdir(), "yg-m-")),
    workspaceRoot: mkdtempSync(join(tmpdir(), "yg-w-")),
    emit: () => {},
  });

  try {
    // 文案 key：= 出口策略会返回的错误码 ∪ 工具代码里显式引用的 key
    const referenced = new Set<string>([...REJECTION_CODES, "say_sent"]);
    for (const source of sourceLiterals(join(ROOT, "src"))) {
      for (const match of source.matchAll(/messages\["([a-z0-9_]+)"\]/g)) referenced.add(match[1]);
    }
    const defined = new Set(Object.keys(prompts.messages));
    assert.deepEqual([...defined].filter((k) => !referenced.has(k)), [], "messages.md 里有没人用的文案");

    // 工具 prompt：每个文件都要对应一个真实注册的工具
    assert.deepEqual(
      Object.keys(prompts.tools).filter((name) => !fish.toolNames.includes(name)),
      [],
      "prompt/tools/ 里有不对应任何工具的文件",
    );
  } finally {
    await fish.close();
  }
});

function sourceLiterals(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) out.push(...sourceLiterals(path));
    else if (entry.name.endsWith(".ts")) out.push(readFileSync(path, "utf8"));
  }
  return out;
}
