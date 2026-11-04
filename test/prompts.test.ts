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
import { loadToolManifests, parseToolManifest, toolFullDescription } from "../src/tools/manifest.ts";
import { mergeToolMessages, DISABLED_TOOL_PACKAGES } from "../src/tools/loader.ts";
import { scanDir, scanSource } from "../src/prompt-lint.ts";
import { REJECTION_CODES } from "../src/egress/policy.ts";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";

const ROOT = fileURLToPath(new URL("..", import.meta.url));
const PROMPTS = join(ROOT, "prompt");
const TOOL_ROOT = fileURLToPath(new URL("../src/tools/", import.meta.url));
const ctx = BACKGROUND_CONTEXT;

test("每个 prompt 文件都存在且非空", () => {
  const files = auditPrompts(PROMPTS);
  assert.ok(files.length >= 4);
  for (const file of files) assert.ok(file.bytes > 0, `${file.file} 是空的`);
});

test("工具说明逐字来自 src/tools/<name>/TOOL.md", async () => {
  const prompts = loadPrompts(PROMPTS);
  const manifests = loadToolManifests(TOOL_ROOT, { memeTags: prompts.memeTags });
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
    react: () => {},
    master: "1",
  });

  try {
    const root = await fish.harness.root(ctx);
    const agent = await root.agent(ctx);
    const tools = [...agent.tools, ...agent.deferred];
    for (const name of ["say_words", "say_media", "say_meme", "say_voice", "look", "react"] as const) {
      const tool = tools.find((t) => t.name === name);
      assert.ok(tool, `缺少工具 ${name}`);
      const manifest = manifests.get(name);
      assert.ok(manifest, `src/tools/${name}/TOOL.md 不存在`);
      assert.equal(tool.description, toolFullDescription(manifest), `${name} 的说明不是文件里的原文`);
    }
  } finally {
    await fish.close();
  }
});

test("人物档作为常驻 section 出现", async () => {
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
    react: () => {},
  });
  try {
    const root = await fish.harness.root(ctx);
    const sections = (await root.agent(ctx)).sections.map((s) => s.key);
    assert.ok(sections.includes("people"), "人物档没进 system prompt");
    assert.ok(sections.includes("persona"));
    // 表情包库存已改为检索引导（src/tools/meme/TOOL.md），动态库存数不得再进 system：
    // meme_tags section 必须不存在，否则表情库一有增减就打穿 openai-completions 前缀缓存
    assert.ok(!sections.includes("meme_tags"), "meme_tags section 应已移除，动态库存不进 system");
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
    react: () => {},
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
    react: () => {},
    master: "1",
  });

  try {
    // 文案 key：= 出口策略会返回的错误码 ∪ 工具代码里显式引用的 key。
    // 作用于合并后的视图（中心 prompt/messages.md + 各工具 TOOL.md 的 tool-messages 块，
    // loader 已把它们就地并入 fish.prompts.messages）
    const referenced = new Set<string>([...REJECTION_CODES, "say_sent"]);
    for (const source of sourceLiterals(join(ROOT, "src"))) {
      for (const match of source.matchAll(/messages\["([a-z0-9_]+)"\]/g)) referenced.add(match[1]);
    }
    const defined = new Set(Object.keys(fish.prompts.messages));
    assert.deepEqual([...defined].filter((k) => !referenced.has(k)), [], "合并视图里有没人用的文案（中心或工具块）");
    // 两处定义的 key 不许重复：合并视图条数 = 中心条数 + 各 active 工具块条数
    //（disabled 包（DISABLED_TOOL_PACKAGES，2026-11-04 T3）的 tool-messages 不并入合并视图，
    // 完整性校验照旧但不计入 active 断言）
    const manifests = loadToolManifests(TOOL_ROOT, { memeTags: prompts.memeTags });
    const activeManifests = new Map([...manifests].filter(([name]) => !DISABLED_TOOL_PACKAGES.has(name)));
    const toolKeys = [...activeManifests.values()].flatMap((m) => Object.keys(m.messages));
    assert.equal(new Set(toolKeys).size, toolKeys.length, "不同工具的 tool-messages 里有重复 key");
    assert.equal(
      defined.size,
      Object.keys(prompts.messages).length + toolKeys.length,
      "合并视图条数与中心+active 工具块之和对不上",
    );

    // 工具包：每个 active TOOL.md 都要对应一个真实注册的工具（disabled 包不进工具面）
    assert.deepEqual(
      [...activeManifests.keys()].filter((name) => !fish.toolNames.includes(name)),
      [],
      "src/tools/ 里有不对应任何工具的 TOOL.md",
    );
  } finally {
    await fish.close();
  }
});

/** 最小合法工具包三件套（frontmatter + 空 schema + 指南），供解析测试拼装。 */
function toolSource(name: string, messages: string | null = null, guide = "使用指南正文"): {
  source: { md: string; schema: string; messages: string | null };
  mdPath: string;
  schemaPath: string;
  messagesPath: string;
} {
  return {
    source: {
      md: `---\nname: ${name}\ndescription: 摘要\n---\n\n${guide}`,
      schema: `{"parameters":{"type":"object","properties":{}}}`,
      messages,
    },
    mdPath: `${name}/TOOL.md`,
    schemaPath: `${name}/schema.json`,
    messagesPath: `${name}/messages.json`,
  };
}

function parseSource(files: ReturnType<typeof toolSource>) {
  return parseToolManifest(files.source, files.mdPath, files.schemaPath, files.messagesPath);
}

test("messages.json 解析：文件可选，文案逐 key 进 manifest.messages", () => {
  // 有文件：文案逐 key 进 manifest.messages，指南不含结构块内容
  const withFile = parseSource({
    source: {
      md: "---\nname: demo\ndescription: 摘要\n---\n\n使用指南正文",
      schema: `{"parameters":{"type":"object","properties":{}}}`,
      messages: `{"demo_key":"一句文案，含 {{var}}","another":"另一句"}`,
    },
    mdPath: "demo/TOOL.md",
    schemaPath: "demo/schema.json",
    messagesPath: "demo/messages.json",
  });
  assert.equal(withFile.messages["demo_key"], "一句文案，含 {{var}}");
  assert.equal(withFile.messages["another"], "另一句");
  assert.equal(withFile.guide, "使用指南正文");
  assert.deepEqual(withFile.description, "摘要");

  // 无文件：messages 为空表
  const withoutFile = parseSource(toolSource("demo"));
  assert.deepEqual(withoutFile.messages, {});
  assert.equal(withoutFile.guide, "使用指南正文");
});

test("messages.json：非法 key 名、空文案、空对象、TOOL.md 里的旧块围栏都直接报错", () => {
  // 非法 key 名（大写/数字开头）
  assert.throws(
    () => parseSource({ source: { md: toolSource("demo").source.md, schema: toolSource("demo").source.schema, messages: `{"Bad-Key":"一句"}` }, mdPath: "demo/TOOL.md", schemaPath: "demo/schema.json", messagesPath: "demo/messages.json" }),
    /tool-messages key 名非法/,
  );
  assert.throws(
    () => parseSource({ source: { md: toolSource("demo").source.md, schema: toolSource("demo").source.schema, messages: `{"9key":"一句"}` }, mdPath: "demo/TOOL.md", schemaPath: "demo/schema.json", messagesPath: "demo/messages.json" }),
    /tool-messages key 名非法/,
  );
  // 空文案
  assert.throws(
    () => parseSource({ source: { md: toolSource("demo").source.md, schema: toolSource("demo").source.schema, messages: `{"demo_key":""}` }, mdPath: "demo/TOOL.md", schemaPath: "demo/schema.json", messagesPath: "demo/messages.json" }),
    /tool-messages 文案必须是非空字符串/,
  );
  // 空对象（至少要有一条）
  assert.throws(
    () => parseSource({ source: { md: toolSource("demo").source.md, schema: toolSource("demo").source.schema, messages: `{}` }, mdPath: "demo/TOOL.md", schemaPath: "demo/schema.json", messagesPath: "demo/messages.json" }),
    /至少要有一条文案/,
  );
  // TOOL.md 正文里又出现旧块围栏：报错，不猜哪个算数
  assert.throws(
    () => parseSource(toolSource("demo", null, "使用指南\n---tool-messages\n")),
    /多余的 tool-messages 块围栏/,
  );
  assert.throws(
    () => parseSource(toolSource("demo", null, "使用指南\n---tool-schema\n")),
    /多余的 schema 块围栏/,
  );
});

test("工具文案合并：key 撞车（工具↔工具、工具↔中心）直接报错并指出两个来源", () => {
  // 临时工具根：两个包定义同一个 key
  const tmpRoot = mkdtempSync(join(tmpdir(), "yg-tools-"));
  mkdirSync(join(tmpRoot, "alpha"), { recursive: true });
  mkdirSync(join(tmpRoot, "beta"), { recursive: true });
  writeFileSync(join(tmpRoot, "alpha", "TOOL.md"), "---\nname: alpha\ndescription: 摘要\n---\n\n指南A");
  writeFileSync(join(tmpRoot, "alpha", "schema.json"), `{"parameters":{"type":"object","properties":{}}}`);
  writeFileSync(join(tmpRoot, "alpha", "messages.json"), `{"dup_key":"甲的文案"}`);
  writeFileSync(join(tmpRoot, "beta", "TOOL.md"), "---\nname: beta\ndescription: 摘要\n---\n\n指南B");
  writeFileSync(join(tmpRoot, "beta", "schema.json"), `{"parameters":{"type":"object","properties":{}}}`);
  writeFileSync(join(tmpRoot, "beta", "messages.json"), `{"dup_key":"乙的文案"}`);
  const manifests = loadToolManifests(tmpRoot, { memeTags: [] });
  assert.throws(() => mergeToolMessages(manifests, {}), /dup_key.*alpha.*beta/);

  // 工具 ↔ 中心文件
  const single = new Map([["alpha", manifests.get("alpha")!]]);
  assert.throws(
    () => mergeToolMessages(single, { dup_key: "中心文案" }),
    /dup_key.*messages\.md.*alpha/,
  );

  // 不撞车时合并进同一个 map（合并视图语义）
  const okRoot = mkdtempSync(join(tmpdir(), "yg-tools-"));
  mkdirSync(join(okRoot, "alpha"), { recursive: true });
  writeFileSync(join(okRoot, "alpha", "TOOL.md"), "---\nname: alpha\ndescription: 摘要\n---\n\n指南A");
  writeFileSync(join(okRoot, "alpha", "schema.json"), `{"parameters":{"type":"object","properties":{}}}`);
  writeFileSync(join(okRoot, "alpha", "messages.json"), `{"alpha_key":"甲的文案"}`);
  const target: Record<string, string> = { center_key: "中心文案" };
  mergeToolMessages(loadToolManifests(okRoot, { memeTags: [] }), target);
  assert.deepEqual(target, { center_key: "中心文案", alpha_key: "甲的文案" });
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
