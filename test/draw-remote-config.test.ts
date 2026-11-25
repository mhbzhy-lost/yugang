/**
 * drawRemote 热配置（fish.config.json 受控字段）：校验、默认合并、热加载与 config 工具两层点路径。
 *
 * 覆盖（draw_remote 计划 Task 1 / Spec §4）：
 *  - 缺省值就是冻结的共享 DRAW_REMOTE_DEFAULTS；局部覆盖只动写到的字段，models 浅合并默认表；
 *  - 子字段错误文案字面带完整点路径（config 工具 targetProblem 靠「告警包含目标路径」子串匹配来拦错）；
 *  - 凭据红线：顶层或 models 下出现 apiKey / key / token / access / refresh / secret（不分大小写）整块拒绝；
 *  - 热加载：文件改了 drawRemote 并推进 mtime 后，下一次读取立刻是新值；
 *  - config 工具：顶层与两层点路径写盘成功、回执标热加载；非法子值与凭据键被拒绝且不落盘；
 *  - TOOL.md 字段表与 fish.config.example 同步登记。
 *
 * config 工具的写盘路径取自 src/paths.ts 的 FISH_CONFIG_PATH（模块加载时按环境变量求值），
 * 所以必须在首次 import 业务模块之前把它指到临时目录——绝不碰仓库根的 fish.config.json。
 */
import test, { after } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { LiveDoc } from "@earendil-works/pi-durable";

const ROOT = fileURLToPath(new URL("..", import.meta.url));
const WORK = mkdtempSync(join(tmpdir(), "yg-draw-remote-cfg-"));
const CONFIG_PATH = join(WORK, "fish.config.json");
process.env.YUGANG_FISH_CONFIG = CONFIG_PATH;

const { DRAW_REMOTE_DEFAULTS, FISH_CONFIG_FIELDS, createConfigLoader, loadFishConfig } = await import("../src/fish-config.ts");
const { FISH_CONFIG_PATH } = await import("../src/paths.ts");
const { loadPrompts } = await import("../src/prompt/index.ts");
const { loadToolManifests } = await import("../src/tools/manifest.ts");
const { mergeToolMessages } = await import("../src/tools/loader.ts");
const { createConfigTool } = await import("../src/tools/config/tool.ts");
// 路径常量在 import 时已经定下；环境变量不留到后面，避免影响同进程里后续加载的模块
delete process.env.YUGANG_FISH_CONFIG;

after(() => rmSync(WORK, { recursive: true, force: true }));

/** FieldCheck 取类型不取值：reasonOf 里显式收窄用。 */
type FieldCheck = import("../src/fish-config.ts").FieldCheck;

/** Spec §4 钉死的缺省值（测试里写字面量，不从生产常量反推）。 */
const DEFAULT_MODELS = { gpt: "gpt-image-2.6-flare", wan: "wan2.7-image", gemini: "gemini-3.1-flash-image" };
const DEFAULT_BLOCK = { enabled: true, provider: "gemini", models: DEFAULT_MODELS };

/** 受控字段表里的 drawRemote 规格：config 工具与 parseFile 共用的那一份校验。 */
function spec() {
  const found = FISH_CONFIG_FIELDS.find((field) => field.name === "drawRemote");
  assert.ok(found, "FISH_CONFIG_FIELDS 里没有 drawRemote");
  return found;
}

/** 整块合法的值 → 逐字段告警（非法子值回默认时才有）。 */
function problemsOf(raw: unknown): string[] {
  const result = spec().check(raw);
  assert.ok(result.ok, `应当整体合法：${JSON.stringify(raw)}`);
  return result.problems ?? [];
}

/** 整块被拒的值 → 拒绝文案（联合类型的收窄显式写出来，不依赖 tsc 标志）。 */
function reasonOf(raw: unknown): string {
  const result = spec().check(raw);
  assert.equal(result.ok, false, `应当整块拒绝：${JSON.stringify(raw)}`);
  return (result as Extract<FieldCheck, { ok: false }>).reason;
}

/** 断言 expected 每条都在 actual 里字面出现，且 actual 没有别的告警。 */
function assertSameProblems(actual: string[], expected: string[]): void {
  for (const wanted of expected) assert.ok(actual.includes(wanted), `缺少告警「${wanted}」，实际：${JSON.stringify(actual)}`);
  assert.equal(actual.length, expected.length, `告警条数对不上，实际：${JSON.stringify(actual)}`);
}

function writeConfig(json: unknown): void {
  writeFileSync(CONFIG_PATH, `${JSON.stringify(json, null, 2)}\n`);
}

function fileConfig(): Record<string, unknown> {
  return JSON.parse(readFileSync(CONFIG_PATH, "utf8")) as Record<string, unknown>;
}

/** 把 mtime 推到确定的未来时刻：热加载只看 mtime 变没变，不能赌两次写入的时间戳一定不同。 */
function bumpMtime(): void {
  const later = (Date.now() + 60_000) / 1000;
  utimesSync(CONFIG_PATH, later, later);
}

test("缺省：loadFishConfig() 的 drawRemote 就是冻结的共享默认（gemini + 三通道默认模型）", () => {
  assert.equal(FISH_CONFIG_PATH, CONFIG_PATH, "config 工具的写盘路径必须已被指到临时目录");
  rmSync(CONFIG_PATH, { force: true });
  const { config, source, problems } = loadFishConfig();
  assert.equal(source, "default");
  assert.deepEqual(problems, []);
  assert.deepEqual(config.drawRemote, DEFAULT_BLOCK);
  assert.equal(config.drawRemote, DRAW_REMOTE_DEFAULTS, "没写 drawRemote 时直接给共享默认对象，不另抄一份");
  assert.equal(config.drawRemote.models, DRAW_REMOTE_DEFAULTS.models);
  assert.equal(spec().effect, "hot");

  // 共享默认不可变：外层与 models 都冻结，改它会抛错
  assert.ok(DRAW_REMOTE_DEFAULTS, "缺少 DRAW_REMOTE_DEFAULTS");
  assert.equal(Object.isFrozen(DRAW_REMOTE_DEFAULTS), true);
  assert.equal(Object.isFrozen(DRAW_REMOTE_DEFAULTS.models), true);
  assert.throws(() => {
    (DRAW_REMOTE_DEFAULTS as { enabled: boolean }).enabled = false;
  }, TypeError);
  assert.throws(() => {
    (DRAW_REMOTE_DEFAULTS.models as Record<string, string>).gemini = "x";
  }, TypeError);
  assert.deepEqual(DRAW_REMOTE_DEFAULTS, DEFAULT_BLOCK);
});

test("局部覆盖：只写到的字段生效，其余回落默认；models 浅合并默认表", () => {
  writeConfig({ drawRemote: { provider: "gpt", models: { gpt: "gpt-image-2.6-sunburst" } } });
  const loaded = loadFishConfig();
  assert.deepEqual(loaded.problems, []);
  assert.deepEqual(loaded.config.drawRemote, {
    enabled: true,
    provider: "gpt",
    models: { gpt: "gpt-image-2.6-sunburst", wan: "wan2.7-image", gemini: "gemini-3.1-flash-image" },
  });
  // 局部覆盖不得改写共享默认
  assert.deepEqual(DRAW_REMOTE_DEFAULTS, DEFAULT_BLOCK);

  writeConfig({ drawRemote: { enabled: false } });
  const off = loadFishConfig().config.drawRemote;
  assert.equal(off.enabled, false);
  assert.equal(off.provider, "gemini");
  assert.deepEqual(off.models, DEFAULT_MODELS);

  writeConfig({ drawRemote: { models: { wan: "wan2.7-t2i" } } });
  const onlyModel = loadFishConfig().config.drawRemote;
  assert.equal(onlyModel.provider, "gemini", "换当前通道的模型名不等于切通道");
  assert.deepEqual(onlyModel.models, { ...DEFAULT_MODELS, wan: "wan2.7-t2i" });

  writeConfig({ drawRemote: { enabled: true, provider: "wan", models: { gpt: "a", wan: "b", gemini: "c" } } });
  assert.deepEqual(loadFishConfig().config.drawRemote, { enabled: true, provider: "wan", models: { gpt: "a", wan: "b", gemini: "c" } });
});

test("子字段错误文案带完整点路径：非法子值告警回默认，全部非法才整块拒绝", () => {
  // 非法子值：只告警、该子值回默认，同块合法字段照用
  assertSameProblems(problemsOf({ provider: "gpt", enabled: "yes" }), ["drawRemote.enabled 必须是 true/false"]);
  assertSameProblems(problemsOf({ enabled: true, provider: "dalle" }), ["drawRemote.provider 仅支持 gpt / wan / gemini"]);
  assertSameProblems(problemsOf({ provider: "gpt", models: { gemini: "" } }), ["drawRemote.models.gemini 必须是非空字符串"]);
  assertSameProblems(problemsOf({ provider: "gpt", models: { gemini: "   ", gpt: 42 } }), [
    "drawRemote.models.gemini 必须是非空字符串",
    "drawRemote.models.gpt 必须是非空字符串",
  ]);
  assertSameProblems(problemsOf({ provider: "gpt", models: "gemini-3.1-flash-image" }), ["drawRemote.models 必须是对象"]);
  assertSameProblems(problemsOf({ provider: "gpt", models: ["gpt"] }), ["drawRemote.models 必须是对象"]);
  assertSameProblems(problemsOf({ provider: "gpt", models: { unknown: "x" } }), ["drawRemote.models.unknown 不是受控通道，已忽略"]);
  assertSameProblems(problemsOf({ provider: "gpt", extra: 1 }), ["drawRemote.extra 不是受控字段，已忽略"]);

  // 混在一起：合法的照用（模型名去首尾空白），非法的回默认，告警逐条带路径
  const mixed = spec().check({
    enabled: false,
    provider: "dalle",
    models: { gpt: 42, unknown: "x", wan: " wan2.7-t2i " },
    extra: 1,
  });
  assert.ok(mixed.ok);
  assert.deepEqual(mixed.value, { enabled: false, provider: "gemini", models: { ...DEFAULT_MODELS, wan: "wan2.7-t2i" } });
  assertSameProblems(mixed.problems ?? [], [
    "drawRemote.provider 仅支持 gpt / wan / gemini",
    "drawRemote.models.gpt 必须是非空字符串",
    "drawRemote.models.unknown 不是受控通道，已忽略",
    "drawRemote.extra 不是受控字段，已忽略",
  ]);

  // 一个合法字段都没有：整块拒绝
  for (const raw of [{ enabled: "yes" }, { enabled: "yes", provider: "dalle", models: "gemini" }, { extra: 1 }, {}, [], null, "gemini", 42]) {
    assert.match(reasonOf(raw), /^drawRemote/, `应当整块拒绝：${JSON.stringify(raw)}`);
  }

  // 文件里整块全非法：告警并回落默认；部分非法：合法字段照用
  writeConfig({ drawRemote: { provider: "dalle", enabled: "yes" } });
  const bad = loadFishConfig();
  assert.deepEqual(bad.config.drawRemote, DEFAULT_BLOCK);
  assert.equal(bad.problems.length, 1);
  assert.match(bad.problems[0] ?? "", /drawRemote\.provider 仅支持 gpt \/ wan \/ gemini/);
  assert.match(bad.problems[0] ?? "", /已忽略/);

  writeConfig({ drawRemote: { provider: "gpt", enabled: "yes", models: { unknown: "x" } } });
  const partial = loadFishConfig();
  assert.equal(partial.config.drawRemote.provider, "gpt");
  assert.equal(partial.config.drawRemote.enabled, true, "非法的 enabled 回默认 true");
  assert.deepEqual(partial.config.drawRemote.models, DEFAULT_MODELS);
  assertSameProblems(partial.problems, ["drawRemote.enabled 必须是 true/false", "drawRemote.models.unknown 不是受控通道，已忽略"]);
});

test("凭据红线：顶层或 models 下出现 apiKey/key/token/access/refresh/secret（不分大小写）整块拒绝", () => {
  for (const word of ["apiKey", "API_KEY", "ApiKey", "key", "token", "access_token", "access", "refresh", "refreshToken", "secret", "clientSecret"]) {
    // 顶层：哪怕其余字段全部合法，也整块拒绝，不当「未知键」放过
    assert.equal(
      reasonOf({ ...DEFAULT_BLOCK, provider: "gpt", [word]: "sk-leak" }),
      `drawRemote.${word} 不得写入 fish.config.json，凭据放 config/auth.json`,
    );
    // models 子层
    assert.equal(
      reasonOf({ provider: "gpt", models: { [word]: "sk-leak" } }),
      `drawRemote.models.${word} 不得写入 fish.config.json，凭据放 config/auth.json`,
    );
  }
  // 更深的嵌套同样拦（递归扫，不局限于一层）
  assert.equal(
    reasonOf({ provider: "gpt", models: { gpt: { key: "sk-leak" } } }),
    "drawRemote.models.gpt.key 不得写入 fish.config.json，凭据放 config/auth.json",
  );

  // 文件级：整块忽略并告警，回落默认
  writeConfig({ drawRemote: { enabled: false, provider: "gpt", models: { ...DEFAULT_MODELS, API_KEY: "sk-leak" } } });
  const leak = loadFishConfig();
  assert.deepEqual(leak.config.drawRemote, DEFAULT_BLOCK);
  assert.equal(leak.problems.length, 1);
  assert.equal(leak.problems[0], "drawRemote.models.API_KEY 不得写入 fish.config.json，凭据放 config/auth.json，已忽略");
});

test("热加载：文件改了 drawRemote 并推进 mtime，下一次读取立刻是新值", () => {
  writeConfig({ drawRemote: { provider: "gpt" } });
  const load = createConfigLoader({ path: CONFIG_PATH });
  assert.equal(load().config.drawRemote.provider, "gpt");
  assert.equal(load().config.drawRemote.enabled, true);
  assert.deepEqual(load().config.drawRemote.models, DEFAULT_MODELS);

  writeConfig({ drawRemote: { provider: "wan", enabled: false, models: { gemini: "gemini-3.1-pro-image" } } });
  bumpMtime();
  const next = load();
  assert.equal(next.config.drawRemote.provider, "wan");
  assert.equal(next.config.drawRemote.enabled, false);
  assert.deepEqual(next.config.drawRemote.models, { ...DEFAULT_MODELS, gemini: "gemini-3.1-pro-image" });
});

const MASTER = "1";
const PRIVATE_CONVERSATION = "conv-private-master";

/** 假 api：只回 LiveDoc 的 run.inputs[0]（主人触发的私聊轮），其余文档当不存在。 */
const api = {
  conversationId: PRIVATE_CONVERSATION,
  callId: "call_test",
  snapshot: async (doc: unknown) => (doc === LiveDoc ? { run: { inputs: ["round-1"] } } : undefined),
} as never;

type ConfigTool = NonNullable<ReturnType<typeof createConfigTool>>;

function makeConfigTool(): ConfigTool {
  const prompts = loadPrompts(join(ROOT, "prompt"));
  // 与 loader 同款合并：把各工具 TOOL.md 的 tool-messages 并进全局 messages 视图
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

/** 应当被拒的 set：返回 tool 错误文案。 */
async function setRejection(tool: ConfigTool, field: string, value: unknown): Promise<string> {
  try {
    await runSet(tool, field, value);
  } catch (error) {
    return error instanceof Error ? error.message : String(error);
  }
  return assert.fail(`config set ${field} 应当被拒绝`);
}

test("config set drawRemote：顶层与两层点路径写盘成功，回执标热加载，读回即生效", async () => {
  const tool = makeConfigTool();

  // 文件不存在：首次 set 建档
  rmSync(CONFIG_PATH, { force: true });
  const first = await runSet(tool, "drawRemote.enabled", "false");
  assert.match(first, /已把 drawRemote 改成/);
  assert.match(first, /热加载/);
  assert.doesNotMatch(first, /需重启/);
  assert.deepEqual(fileConfig().drawRemote, { enabled: false, provider: "gemini", models: DEFAULT_MODELS });
  assert.equal(loadFishConfig().config.drawRemote.enabled, false);

  // 原文件里的其它字段不动；顶层点路径改通道，没写的键保持默认
  writeConfig({ memeCooldownMinutes: 8 });
  await runSet(tool, "drawRemote.provider", "gpt");
  assert.deepEqual(fileConfig(), { memeCooldownMinutes: 8, drawRemote: { ...DEFAULT_BLOCK, provider: "gpt" } });
  assert.equal(loadFishConfig().config.drawRemote.provider, "gpt");

  // 两层点路径：只改目标通道，同块其余配置保留
  const second = await runSet(tool, "drawRemote.models.gemini", "gemini-3.1-pro-image");
  assert.match(second, /热加载/);
  assert.deepEqual(fileConfig(), {
    memeCooldownMinutes: 8,
    drawRemote: { enabled: true, provider: "gpt", models: { ...DEFAULT_MODELS, gemini: "gemini-3.1-pro-image" } },
  });
  assert.equal(loadFishConfig().config.drawRemote.models.gemini, "gemini-3.1-pro-image");

  // 改开关不动通道与模型表
  await runSet(tool, "drawRemote.enabled", "false");
  const toggled = fileConfig().drawRemote as Record<string, unknown>;
  assert.equal(toggled.enabled, false);
  assert.equal(toggled.provider, "gpt");
  assert.deepEqual(toggled.models, { ...DEFAULT_MODELS, gemini: "gemini-3.1-pro-image" });

  // 整块给 JSON 字符串：按整块语义替换并规整
  await runSet(tool, "drawRemote", JSON.stringify({ provider: "wan" }));
  assert.deepEqual(fileConfig(), { memeCooldownMinutes: 8, drawRemote: { ...DEFAULT_BLOCK, provider: "wan" } });

  // 块里有无关的历史垃圾键：不拦合法目标，照常写盘（落盘的是规整后的块），垃圾键告警进回执
  writeConfig({ drawRemote: { extra: 1 } });
  const tidied = await runSet(tool, "drawRemote.provider", "wan");
  assert.match(tidied, /drawRemote\.extra 不是受控字段，已忽略/);
  assert.deepEqual(fileConfig().drawRemote, { ...DEFAULT_BLOCK, provider: "wan" });
});

test("config set drawRemote：非法子值被 targetProblem 拦截、凭据键整块拒绝，都不落盘", async () => {
  writeConfig({
    memeCooldownMinutes: 8,
    drawRemote: { provider: "gpt", models: { ...DEFAULT_MODELS, gemini: "gemini-3.1-pro-image" } },
  });
  const tool = makeConfigTool();
  const before = readFileSync(CONFIG_PATH, "utf8");

  // 两层点路径写空串：告警文案带目标路径 → targetProblem 命中 → 拒绝
  assert.equal(
    await setRejection(tool, "drawRemote.models.gemini", ""),
    "drawRemote.models.gemini 的值不合法：drawRemote.models.gemini 必须是非空字符串",
  );
  // 通道枚举外 / 布尔写错 / 非受控通道 / 非受控字段
  assert.match(await setRejection(tool, "drawRemote.provider", "dalle"), /drawRemote\.provider 仅支持 gpt \/ wan \/ gemini/);
  assert.match(await setRejection(tool, "drawRemote.enabled", "yes"), /drawRemote\.enabled 必须是 true\/false/);
  assert.match(await setRejection(tool, "drawRemote.models", "gpt"), /drawRemote\.models 必须是对象/);
  assert.match(await setRejection(tool, "drawRemote.models.unknown", "x"), /drawRemote\.models\.unknown 不是受控通道，已忽略/);
  assert.match(await setRejection(tool, "drawRemote.extra", "1"), /drawRemote\.extra 不是受控字段，已忽略/);
  // 凭据红线：点路径与整块（JSON 字符串）都拒
  assert.match(await setRejection(tool, "drawRemote.apiKey", "sk-x"), /^drawRemote\.apiKey 的值不合法：drawRemote\.apiKey 不得写入 fish\.config\.json，凭据放 config\/auth\.json$/);
  assert.match(await setRejection(tool, "drawRemote.models.token", "sk-x"), /drawRemote\.models\.token 不得写入 fish\.config\.json/);
  assert.match(await setRejection(tool, "drawRemote", JSON.stringify({ provider: "wan", apiKey: "sk-x" })), /drawRemote\.apiKey 不得写入 fish\.config\.json/);
  // 整块一个合法字段都没有
  assert.match(await setRejection(tool, "drawRemote", JSON.stringify({ provider: "dalle" })), /drawRemote 的值不合法：drawRemote 至少要有一个合法字段/);

  // 全程零写盘：文件逐字节不变，没有残留 tmp，生效值也没被动过
  assert.equal(readFileSync(CONFIG_PATH, "utf8"), before);
  assert.equal(existsSync(`${CONFIG_PATH}.tmp`), false);
  assert.equal(loadFishConfig().config.drawRemote.models.gemini, "gemini-3.1-pro-image");
});

test("TOOL.md 字段表与 fish.config.example 同步登记 drawRemote", () => {
  const toolMd = readFileSync(join(ROOT, "src", "tools", "config", "TOOL.md"), "utf8");
  const row = toolMd.split("\n").find((line) => line.startsWith("| drawRemote |"));
  assert.ok(row, "config 的 TOOL.md 字段表缺 drawRemote 行");
  for (const word of ["对象", "热加载", "enabled", "provider", "gpt / wan / gemini", "models", "drawRemote.models", "apiKey", "整块拒绝"]) {
    assert.ok(row.includes(word), `drawRemote 行缺「${word}」：${row}`);
  }
  // models_switch 的说明要点明：远程生图的通道/模型改由 drawRemote 控制，不靠角色表的 image
  const lines = toolMd.split("\n");
  const start = lines.findIndex((line) => line.includes("`models_switch`"));
  assert.ok(start >= 0, "config 的 TOOL.md 缺 models_switch 说明");
  let end = start;
  while (end < lines.length && lines[end].trim() !== "") end++;
  const switchGuide = lines.slice(start, end).join("\n");
  assert.match(switchGuide, /image/);
  assert.match(switchGuide, /drawRemote/);

  const example = JSON.parse(readFileSync(join(ROOT, "fish.config.example"), "utf8")) as { drawRemote?: unknown };
  assert.deepEqual(example.drawRemote, DEFAULT_BLOCK);
  const result = spec().check(example.drawRemote);
  assert.ok(result.ok, `fish.config.example 的 drawRemote 不合法：${JSON.stringify(result)}`);
  assert.deepEqual(result.problems ?? [], []);
});

test("config set drawRemote：嵌套凭据对象与更深的点路径都被拒绝，fish.config.json 逐字节不变", async () => {
  writeConfig({
    memeCooldownMinutes: 8,
    drawRemote: { enabled: true, provider: "gpt", models: { ...DEFAULT_MODELS } },
  });
  const tool = makeConfigTool();
  const before = readFileSync(CONFIG_PATH);

  // 两层点路径写入「凭据对象」：模型把值写成 JSON 字符串或原生对象都一样，凭据红线整块拒绝
  for (const value of [JSON.stringify({ apiKey: "sk-x" }), { apiKey: "sk-x" }]) {
    assert.match(
      await setRejection(tool, "drawRemote.models.gemini", value),
      /^drawRemote\.models\.gemini 的值不合法：drawRemote\.models\.gemini\.apiKey 不得写入 fish\.config\.json，凭据放 config\/auth\.json$/,
    );
    assert.ok(readFileSync(CONFIG_PATH).equals(before), "拒绝后文件逐字节不变");
    assert.equal(existsSync(`${CONFIG_PATH}.tmp`), false, "没有残留 tmp");
  }
  // models 整块塞进带凭据键的对象：同样被凭据红线拦下
  assert.match(
    await setRejection(tool, "drawRemote.models", JSON.stringify({ gemini: { access: "ya29.leaked" } })),
    /drawRemote\.models\.gemini\.access 不得写入 fish\.config\.json/,
  );
  // 三层点路径直指凭据键：目标父级现在是模型名字符串 → 父级不是对象，拒绝且不建中间对象
  for (const [field, value] of [
    ["drawRemote.models.gemini.apiKey", "sk-x"],
    ["drawRemote.models.gpt.refresh", "1//refresh-token"],
    ["drawRemote.models.gpt", JSON.stringify({ token: "x" })],
  ] as const) {
    const rejected = await setRejection(tool, field, value);
    assert.match(rejected, /^drawRemote\.models\./);
    assert.match(rejected, /父级不是对象|不得写入 fish\.config\.json/);
    assert.ok(readFileSync(CONFIG_PATH).equals(before), `${field}：拒绝后文件逐字节不变`);
    assert.equal(existsSync(`${CONFIG_PATH}.tmp`), false);
  }
  // 生效值也没被动过
  assert.equal(loadFishConfig().config.drawRemote.models.gemini, DEFAULT_MODELS.gemini);
  assert.equal(loadFishConfig().config.drawRemote.provider, "gpt");

  // 文件里还没有 drawRemote（首次建档前）：三层点路径要在内存里现搭中间对象，凭据键照样拦住，不建档
  rmSync(CONFIG_PATH, { force: true });
  assert.match(await setRejection(tool, "drawRemote.models.gemini.apiKey", "sk-x"), /drawRemote\.models\.gemini\.apiKey 不得写入 fish\.config\.json/);
  assert.equal(existsSync(CONFIG_PATH), false, "被拒绝的 set 不得凭空建档");
  assert.equal(existsSync(`${CONFIG_PATH}.tmp`), false);
});
