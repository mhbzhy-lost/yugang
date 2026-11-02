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
import { mergeToolMessages } from "../src/tools/loader.ts";
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
    // 两处定义的 key 不许重复：合并视图条数 = 中心条数 + 各工具块条数
    const manifests = loadToolManifests(TOOL_ROOT, { memeTags: prompts.memeTags });
    const toolKeys = [...manifests.values()].flatMap((m) => Object.keys(m.messages));
    assert.equal(new Set(toolKeys).size, toolKeys.length, "不同工具的 tool-messages 里有重复 key");
    assert.equal(
      defined.size,
      Object.keys(prompts.messages).length + toolKeys.length,
      "合并视图条数与中心+工具块之和对不上",
    );

    // 工具包：每个 TOOL.md 都要对应一个真实注册的工具
    assert.deepEqual(
      [...manifests.keys()].filter((name) => !fish.toolNames.includes(name)),
      [],
      "src/tools/ 里有不对应任何工具的 TOOL.md",
    );
  } finally {
    await fish.close();
  }
});

/** 最小合法 TOOL.md 头（frontmatter + 空 schema 块），供第三块解析测试拼装。 */
function toolHead(name: string): string {
  return `---\nname: ${name}\ndescription: 摘要\n---\n---tool-schema\n{"parameters":{"type":"object","properties":{}}}\n---end-tool-schema\n`;
}

test("TOOL.md 第三块：tool-messages 逐行解析，块可选", () => {
  // 有块：文案逐行进 manifest.messages，指南不含块内容
  const withBlock = parseToolManifest(
    toolHead("demo") + "\n---tool-messages\ndemo_key: 一句文案，含 {{var}}\nanother: 另一句\n---end-tool-messages\n\n使用指南正文",
    "demo/TOOL.md",
  );
  assert.equal(withBlock.messages["demo_key"], "一句文案，含 {{var}}");
  assert.equal(withBlock.messages["another"], "另一句");
  assert.equal(withBlock.guide, "使用指南正文");
  assert.deepEqual(withBlock.description, "摘要");

  // 无块：messages 为空表，指南紧跟 schema 块
  const withoutBlock = parseToolManifest(toolHead("demo") + "\n使用指南正文", "demo/TOOL.md");
  assert.deepEqual(withoutBlock.messages, {});
  assert.equal(withoutBlock.guide, "使用指南正文");
});

test("TOOL.md 第三块：缺围栏对、非法 key 名、空块、块内重复 key 都直接报错", () => {
  // 缺 ---end-tool-messages
  assert.throws(
    () => parseToolManifest(toolHead("demo") + "\n---tool-messages\ndemo_key: 一句文案\n\n使用指南", "demo/TOOL.md"),
    /---end-tool-messages 未闭合/,
  );
  // 非法 key 名（大写/连字符/数字开头）
  assert.throws(
    () => parseToolManifest(toolHead("demo") + "\n---tool-messages\nBad-Key: 一句文案\n---end-tool-messages\n\n使用指南", "demo/TOOL.md"),
    /tool-messages 行必须是/,
  );
  assert.throws(
    () => parseToolManifest(toolHead("demo") + "\n---tool-messages\n9key: 一句文案\n---end-tool-messages\n\n使用指南", "demo/TOOL.md"),
    /tool-messages 行必须是/,
  );
  // 空块（围栏成对但内部没有合法行）
  assert.throws(
    () => parseToolManifest(toolHead("demo") + "\n---tool-messages\n---end-tool-messages\n\n使用指南", "demo/TOOL.md"),
    /至少要有一条文案/,
  );
  // 块内重复 key
  assert.throws(
    () => parseToolManifest(toolHead("demo") + "\n---tool-messages\ndemo_key: 一句\ndemo_key: 又一句\n---end-tool-messages\n\n使用指南", "demo/TOOL.md"),
    /重复的 tool-messages key/,
  );
  // 指南里又出现一份围栏：报错，不猜哪个算数
  assert.throws(
    () => parseToolManifest(toolHead("demo") + "\n---tool-messages\ndemo_key: 一句\n---end-tool-messages\n\n使用指南\n---tool-messages\n", "demo/TOOL.md"),
    /多余的 tool-messages 块围栏/,
  );
});

test("工具文案合并：key 撞车（工具↔工具、工具↔中心）直接报错并指出两个来源", () => {
  // 临时工具根：两个包定义同一个 key
  const tmpRoot = mkdtempSync(join(tmpdir(), "yg-tools-"));
  mkdirSync(join(tmpRoot, "alpha"), { recursive: true });
  mkdirSync(join(tmpRoot, "beta"), { recursive: true });
  writeFileSync(join(tmpRoot, "alpha", "TOOL.md"), toolHead("alpha") + "\n---tool-messages\ndup_key: 甲的文案\n---end-tool-messages\n\n指南A");
  writeFileSync(join(tmpRoot, "beta", "TOOL.md"), toolHead("beta") + "\n---tool-messages\ndup_key: 乙的文案\n---end-tool-messages\n\n指南B");
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
  writeFileSync(join(okRoot, "alpha", "TOOL.md"), toolHead("alpha") + "\n---tool-messages\nalpha_key: 甲的文案\n---end-tool-messages\n\n指南A");
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
