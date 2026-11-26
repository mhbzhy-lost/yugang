/**
 * drawBackend 热配置（fish.config.json 受控字段）：校验、缺省、热加载、config 工具写入与文档同步。
 *
 * 参照 test/draw-remote-config.test.ts，在首次 import 业务模块前将 YUGANG_FISH_CONFIG 指到临时目录，
 * 绝不碰仓库根的 fish.config.json。
 */
import test, { after } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { LiveDoc } from "@earendil-works/pi-durable";

const ROOT = fileURLToPath(new URL("..", import.meta.url));
const WORK = mkdtempSync(join(tmpdir(), "yg-draw-backend-cfg-"));
const CONFIG_PATH = join(WORK, "fish.config.json");
process.env.YUGANG_FISH_CONFIG = CONFIG_PATH;

const { FISH_CONFIG_FIELDS, createConfigLoader, loadFishConfig } = await import("../src/fish-config.ts");
const { FISH_CONFIG_PATH } = await import("../src/paths.ts");
const { loadPrompts } = await import("../src/prompt/index.ts");
const { loadToolManifests } = await import("../src/tools/manifest.ts");
const { mergeToolMessages } = await import("../src/tools/loader.ts");
const { createConfigTool } = await import("../src/tools/config/tool.ts");
delete process.env.YUGANG_FISH_CONFIG;

after(() => rmSync(WORK, { recursive: true, force: true }));

type FieldCheck = import("../src/fish-config.ts").FieldCheck;

function spec() {
  const found = FISH_CONFIG_FIELDS.find((field) => field.name === "drawBackend");
  assert.ok(found, "FISH_CONFIG_FIELDS 里没有 drawBackend");
  return found;
}

function reasonOf(raw: unknown): string {
  const result = spec().check(raw);
  assert.equal(result.ok, false, `应当拒绝：${JSON.stringify(raw)}`);
  return (result as Extract<FieldCheck, { ok: false }>).reason;
}

function writeConfig(json: unknown): void {
  writeFileSync(CONFIG_PATH, `${JSON.stringify(json, null, 2)}\n`);
}

function fileConfig(): Record<string, unknown> {
  return JSON.parse(readFileSync(CONFIG_PATH, "utf8")) as Record<string, unknown>;
}

function bumpMtime(): void {
  const later = (Date.now() + 60_000) / 1000;
  utimesSync(CONFIG_PATH, later, later);
}

const MASTER = "1";
const PRIVATE_CONVERSATION = "conv-private-master";

const api = {
  conversationId: PRIVATE_CONVERSATION,
  callId: "call_test",
  snapshot: async (doc: unknown) => (doc === LiveDoc ? { run: { inputs: ["round-1"] } } : undefined),
} as never;

type ConfigTool = NonNullable<ReturnType<typeof createConfigTool>>;

function makeConfigTool(): ConfigTool {
  const prompts = loadPrompts(join(ROOT, "prompt"));
  const manifests = loadToolManifests(join(ROOT, "src", "tools"), { memeTags: prompts.memeTags });
  mergeToolMessages(manifests, prompts.messages);
  const tool = createConfigTool(manifests.get("config")!, {
    prompts,
    mediaRoot: WORK,
    master: MASTER,
    chatKeyOf: (conversationId) => (conversationId === PRIVATE_CONVERSATION ? `qq:private:${MASTER}` : "qq:group:42"),
    triggerOf: () => ({ mentionsBot: false, userId: Number(MASTER) }),
    modelsPath: join(WORK, "models.json"),
  });
  assert.ok(tool, "配了 master 才有 config 工具");
  return tool;
}

async function runSet(tool: ConfigTool, field: string, value: unknown): Promise<string> {
  const result = (await tool.execute({ action: "set", field, value } as never, api, {} as never)) as {
    output: { type: string; text: string }[];
  };
  return result.output.map((item) => item.text).join("\n");
}

async function setRejection(tool: ConfigTool, field: string, value: unknown): Promise<string> {
  try {
    await runSet(tool, field, value);
  } catch (error) {
    return error instanceof Error ? error.message : String(error);
  }
  return assert.fail(`config set ${field} 应当被拒绝`);
}

test("缺省与合法值：loadFishConfig() 默认 drawBackend 为 anima3.8b，drawEnabled 保持 true", () => {
  assert.equal(FISH_CONFIG_PATH, CONFIG_PATH, "config 工具写盘路径必须已指到临时目录");
  rmSync(CONFIG_PATH, { force: true });
  const def = loadFishConfig();
  assert.equal(def.source, "default");
  assert.deepEqual(def.problems, []);
  assert.equal(def.config.drawBackend, "anima3.8b");
  assert.equal(def.config.drawEnabled, true);
  assert.equal(spec().effect, "hot");

  writeConfig({ drawBackend: "anima3.8b" });
  const valid = loadFishConfig();
  assert.equal(valid.source, "file");
  assert.deepEqual(valid.problems, []);
  assert.equal(valid.config.drawBackend, "anima3.8b");
  assert.equal(valid.config.drawEnabled, true);
});

test("非法值：非受控模型名、非字符串与空串均记告警（含可用值列表）并回落默认 anima3.8b", () => {
  for (const badRaw of ["unknown_model", 123, ""]) {
    const reason = reasonOf(badRaw);
    assert.match(reason, /drawBackend 仅支持/);
    assert.match(reason, /anima3\.8b/);

    writeConfig({ drawBackend: badRaw });
    const loaded = loadFishConfig();
    assert.equal(loaded.config.drawBackend, "anima3.8b");
    assert.equal(loaded.problems.length, 1);
    assert.match(loaded.problems[0] ?? "", /drawBackend 仅支持.*anima3\.8b/);
    assert.match(loaded.problems[0] ?? "", /已忽略/);
  }
});

test("热加载：createConfigLoader 修改 drawBackend 并推进 mtime 后立即生效", () => {
  writeConfig({ drawBackend: "anima3.8b" });
  const load = createConfigLoader({ path: CONFIG_PATH });
  assert.equal(load().config.drawBackend, "anima3.8b");
  assert.deepEqual(load().problems, []);

  // 先写非法值推进 mtime，会告警并回落默认；再改回合法值推进 mtime，告警清空
  writeConfig({ drawBackend: "sdxl-missing" });
  bumpMtime();
  const bad = load();
  assert.equal(bad.config.drawBackend, "anima3.8b");
  assert.equal(bad.problems.length, 1);

  writeConfig({ drawBackend: "anima3.8b", drawEnabled: false });
  const later = (Date.now() + 120_000) / 1000;
  utimesSync(CONFIG_PATH, later, later);
  const next = load();
  assert.deepEqual(next.problems, []);
  assert.equal(next.config.drawBackend, "anima3.8b");
  assert.equal(next.config.drawEnabled, false);
});

test("config set drawBackend：合法值写盘成功标热加载；非法值拒绝写盘且磁盘逐字节不变", async () => {
  const tool = makeConfigTool();

  writeConfig({ memeCooldownMinutes: 8 });
  const okMsg = await runSet(tool, "drawBackend", "anima3.8b");
  assert.match(okMsg, /已把 drawBackend 改成/);
  assert.match(okMsg, /热加载/);
  assert.doesNotMatch(okMsg, /需重启/);
  assert.deepEqual(fileConfig(), { memeCooldownMinutes: 8, drawBackend: "anima3.8b" });

  const before = readFileSync(CONFIG_PATH, "utf8");
  const errMsg = await setRejection(tool, "drawBackend", "sdxl-missing");
  assert.match(errMsg, /drawBackend 的值不合法/);
  assert.match(errMsg, /anima3\.8b/);
  assert.equal(readFileSync(CONFIG_PATH, "utf8"), before);
  assert.equal(existsSync(`${CONFIG_PATH}.tmp`), false);
});

test("文档、模板与分层约束：TOOL.md 与 fish.config.example 同步登记 drawBackend，fish-config 只导入零 IO ids.ts", () => {
  const toolMd = readFileSync(join(ROOT, "src", "tools", "config", "TOOL.md"), "utf8");
  const row = toolMd.split("\n").find((line) => line.startsWith("| drawBackend |"));
  assert.ok(row, "config 的 TOOL.md 字段表缺 drawBackend 行");
  for (const word of ["字符串", "热加载", "anima3.8b", "显存驻留", "it/s"]) {
    assert.ok(row.includes(word), `drawBackend 行缺「${word}」：${row}`);
  }

  const example = JSON.parse(readFileSync(join(ROOT, "fish.config.example"), "utf8")) as {
    drawBackend?: unknown;
    _drawBackend?: unknown;
  };
  assert.equal(example.drawBackend, "anima3.8b");
  assert.ok(typeof example._drawBackend === "string" && example._drawBackend.includes("anima3.8b"), "fish.config.example 缺 _drawBackend 注释");
  const checkRes = spec().check(example.drawBackend);
  assert.ok(checkRes.ok);

  const fishConfigSrc = readFileSync(join(ROOT, "src", "fish-config.ts"), "utf8");
  assert.match(fishConfigSrc, /draw\/backends\/ids\.ts/);
  assert.doesNotMatch(fishConfigSrc, /draw\/backends\/registry\.ts/);
  assert.doesNotMatch(fishConfigSrc, /draw\/engine\.ts/);
});
