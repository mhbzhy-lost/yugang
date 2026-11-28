/**
 * 凭据管理。key 只在本地文件里，命令行只报「有没有、多长、从哪来」。
 *
 * 凭据落在 config/auth.json（和 models.json 同目录，已被 gitignore，权限 600）。
 *
 *   npm run creds import            # 从 ~/pi-config/pi/auth.json 导一次（之后不再依赖它）
 *   npm run creds import -- --from /path/to/auth.json --force
 *   npm run creds show              # 看看每个 provider 有没有 key
 *   npm run creds clear             # 删掉本地凭据文件
 */
import { MODELS_CONFIG_PATH } from "../src/paths.ts";
import { randomBytes } from "node:crypto";
import { chmodSync, existsSync, mkdirSync, readFileSync, renameSync, statSync, unlinkSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";

const MODELS = MODELS_CONFIG_PATH;
const TARGET = join(dirname(MODELS), "auth.json");

const [command = "show", ...rest] = process.argv.slice(2);
const flags = parseFlags(rest);

function readJsonStrict(path: string, label: string): unknown {
  try {
    return JSON.parse(readFileSync(path, "utf8"));
  } catch {
    // 严禁打印 JSON.parse 原始异常：V8 SyntaxError 可能携带明文 key 片段
    console.error(`${label} JSON 损坏或无法读取（${path}）`);
    process.exit(1);
  }
}

function extractKey(entry: unknown): string | undefined {
  if (typeof entry === "string") return entry.trim() ? entry : undefined;
  if (!entry || typeof entry !== "object" || Array.isArray(entry)) return undefined;
  const key = (entry as { key?: unknown }).key;
  return typeof key === "string" && key.trim() ? key : undefined;
}

function writeAuthAtomic(path: string, data: Record<string, unknown>): void {
  const dir = dirname(path);
  mkdirSync(dir, { recursive: true });
  const tmp = join(dir, `.auth.${process.pid}.${randomBytes(6).toString("hex")}.tmp`);
  writeFileSync(tmp, `${JSON.stringify(data, null, 2)}\n`, { mode: 0o600 });
  chmodSync(tmp, 0o600);
  renameSync(tmp, path);
}

if (command === "import") {
  const from = resolve(flags["from"] ?? join(homedir(), "pi-config", "pi", "auth.json"));
  if (!existsSync(from)) {
    console.error(`找不到来源：${from}`);
    console.error("用法：npm run creds import -- --from /path/to/auth.json");
    process.exit(1);
  }
  if (existsSync(TARGET) && flags["force"] !== "true") {
    console.error(`已经存在 ${TARGET}；要覆盖请加 --force`);
    process.exit(1);
  }

  const rawModels = readJsonStrict(MODELS, "模型配置") as { providers?: unknown };
  if (!rawModels || typeof rawModels !== "object" || !rawModels.providers || typeof rawModels.providers !== "object") {
    console.error(`模型配置缺少 providers（${MODELS}）`);
    process.exit(1);
  }
  const wanted = Object.keys(rawModels.providers);
  const rawSource = readJsonStrict(from, "来源凭据文件");
  const source = rawSource && typeof rawSource === "object" && !Array.isArray(rawSource)
    ? (rawSource as Record<string, unknown>)
    : {};
  const out: Record<string, { type: "api_key"; key: string }> = {};
  for (const provider of wanted) {
    const key = extractKey(source[provider]);
    if (key) out[provider] = { type: "api_key", key };
  }

  if (Object.keys(out).length === 0) {
    console.error(`来源里没有 ${wanted.join(" / ")} 的 key`);
    process.exit(1);
  }

  writeAuthAtomic(TARGET, out);
  console.log(`✓ 写入 ${TARGET}（权限 600）`);
  for (const [provider, entry] of Object.entries(out)) {
    console.log(`  ${provider}: 已导入 / ${entry.key.length} 字符`);
  }
  const missing = wanted.filter((p) => !out[p]);
  if (missing.length > 0) console.log(`  ${missing.join(", ")}: 来源里没有，跳过`);
} else if (command === "show") {
  if (!existsSync(TARGET)) {
    console.log(`没有凭据文件：${TARGET}`);
    console.log("先跑一次：npm run creds import");
    process.exit(0);
  }
  const stat = statSync(TARGET);
  const parsed = readJsonStrict(TARGET, "凭据文件");
  console.log(`${TARGET}  ${(stat.mode & 0o777).toString(8)}  ${stat.size}B`);
  const entries = parsed && typeof parsed === "object" && !Array.isArray(parsed)
    ? Object.entries(parsed as Record<string, unknown>)
    : [];
  for (const [provider, entry] of entries) {
    const key = extractKey(entry);
    console.log(`  ${provider}: ${key ? `已加载 / ${key.length} 字符` : "空"}`);
  }
} else if (command === "clear") {
  if (!existsSync(TARGET)) {
    console.log("本来就没有");
    process.exit(0);
  }
  unlinkSync(TARGET);
  console.log(`✓ 已删除 ${TARGET}`);
} else {
  console.error(`不认识的命令：${command}`);
  process.exit(1);
}

function parseFlags(argv: string[]): Record<string, string> {
  const out: Record<string, string> = {};
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (!arg.startsWith("--")) continue;
    const name = arg.slice(2);
    const next = argv[i + 1];
    if (next && !next.startsWith("--")) {
      out[name] = next;
      i++;
    } else {
      out[name] = "true";
    }
  }
  return out;
}
