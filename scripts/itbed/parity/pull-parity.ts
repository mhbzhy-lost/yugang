#!/usr/bin/env node
/**
 * pull-parity —— 从 macmini 只读拉取 parity 基准，落 parity-manifest.json（IT bed Task I0）。
 *
 * 拉取内容：
 *   1. macmini ~/yugang 的 git HEAD（期望 commit）
 *   2. macmini ~/yugang/fish.config.json 的快照（人名备注/音色名保留，IT 场景要用）
 *   3. macmini ~/yugang/.env 的键清单与值（token 类脱敏为长度占位；MASTER_QQ/GROUPS 等保留）
 *
 * 只读保证：全部远程命令只有 `echo $HOME`、`git rev-parse HEAD`、`cat <文件>`，
 * 统一走 home-mac-connect skill 的 connect.sh（禁止自行拼 ssh/scp）。
 * 脱敏约定（与任务口径一致）：
 *   - 真正脱敏的只有 token/密钥类：键名命中 /TOKEN|SECRET|PASSWORD|PASSWD|CREDENTIAL|KEY/i
 *     → 值替换为 `<redacted:len=N>`（长度占位，便于核对长度没有误伤）。
 *   - MASTER_QQ / GROUPS / PROTOCOL_QQ / ONEBOT_WS_URL 等保留：faux 注入要用主人身份与群号，非凭据。
 *   - fish.config.json 里的人名备注（watched/voices 音色名）保留；另对全部保留值做一层
 *     URL userinfo 守卫（scheme://user:pass@host → scheme://user:<redacted>@host），防代理地址夹带凭据。
 *   - .env 原文只在脚本进程内存活，任何失败/日志路径都不打印原文。
 *
 * 用法：node scripts/itbed/parity/pull-parity.ts [--out <manifest 路径>]
 * 失败：macmini 不可达时退出非 0、不写 manifest；按计划改用本地 var 副本手工构造 manifest
 * 并注明来源待补（人工步骤，本脚本不代做；手工构造时把 source.pullMode 标为 "manual-fallback"）。
 */
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const PARITY_DIR = dirname(fileURLToPath(import.meta.url));
const DEFAULT_OUT = join(PARITY_DIR, "parity-manifest.json");
const REMOTE_REPO = "$HOME/yugang";

/** token/密钥类键名判定：只脱这一类，其余值按任务口径保留。 */
const TOKEN_KEY_RE = /(TOKEN|SECRET|PASSWORD|PASSWD|CREDENTIAL|KEY)/i;
/** scheme://user:pass@ 守卫：防代理/WS 地址里内嵌凭据混进保留值。 */
const URL_USERINFO_RE = /([a-z][a-z0-9+.-]*:\/\/)([^\s/@]*):([^\s/@]*)@/gi;

interface Redaction {
  where: string;
  kind: "token" | "url-userinfo";
  note: string;
}

function fail(msg: string, code: number): never {
  console.error(`[pull-parity] ${msg}`);
  process.exit(code);
}

function connectShPath(): string {
  const p =
    process.env.ITBED_CONNECT_SH ??
    join(process.env.HOME ?? "", ".agents/skills/home-mac-connect/scripts/connect.sh");
  if (!existsSync(p)) {
    fail(`找不到 home-mac-connect 的 connect.sh（${p}）；可用环境变量 ITBED_CONNECT_SH 指定路径`, 2);
  }
  return p;
}

/** 经 connect.sh 执行一条只读远程命令，返回 stdout。绝不打印 .env 原文（cat 的 stdout 只在内存流转）。 */
function runRemote(args: string[], label: string): string {
  const r = spawnSync(connectShPath(), ["--", ...args], {
    encoding: "utf8",
    timeout: 60_000,
    maxBuffer: 10 * 1024 * 1024,
  });
  if (r.error) fail(`远程命令失败（${label}）：${r.error.message}`, 1);
  if (r.status !== 0) {
    // stderr 只会是 ssh 连接诊断（文件内容走 stdout），可以打印辅助排障
    if (r.stderr.trim()) console.error(r.stderr.trim());
    fail(`远程命令失败（${label}，exit=${r.status}）。macmini 拉取中断：按计划改用本地副本手工构造 manifest 并注明来源待补。`, 1);
  }
  return r.stdout;
}

/** 解析 .env 文本：保留文件键序；值去掉成对引号（与常见 dotenv 行为一致）。 */
function parseEnv(raw: string): { keys: string[]; values: Record<string, string> } {
  const keys: string[] = [];
  const values: Record<string, string> = {};
  for (const line of raw.split(/\r?\n/)) {
    const m = /^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=(.*)$/.exec(line);
    if (!m) continue;
    let value = m[2].trim();
    if (value.length >= 2 && ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'")))) {
      value = value.slice(1, -1);
    }
    keys.push(m[1]);
    values[m[1]] = value;
  }
  return { keys, values };
}

/** 单值脱敏：token 类键 → 长度占位；其余值过一遍 URL userinfo 守卫。命中即记入 redactions。 */
function redactValue(where: string, key: string, value: string, log: Redaction[]): string {
  if (value !== "" && TOKEN_KEY_RE.test(key)) {
    log.push({ where, kind: "token", note: `长度占位（原值 ${value.length} 字符）` });
    return `<redacted:len=${value.length}>`;
  }
  return value.replace(URL_USERINFO_RE, (_all, scheme: string, user: string, _pass: string) => {
    log.push({ where, kind: "url-userinfo", note: `URL 内嵌凭据已脱敏（用户名 ${user || "<空>"} 保留）` });
    return `${scheme}${user}:<redacted>@`;
  });
}

/** fish.config 快照深遍历：只做 URL userinfo 守卫（人名/音色名/路径按口径保留）。 */
function guardDeep(node: unknown, where: string, log: Redaction[]): unknown {
  if (typeof node === "string") return redactValue(where, ".", node, log);
  if (Array.isArray(node)) return node.map((v, i) => guardDeep(v, `${where}[${i}]`, log));
  if (node && typeof node === "object") {
    return Object.fromEntries(Object.entries(node).map(([k, v]) => [k, guardDeep(v, `${where}.${k}`, log)]));
  }
  return node;
}

function main(): void {
  const outArgIdx = process.argv.indexOf("--out");
  const outPath = outArgIdx !== -1 && process.argv[outArgIdx + 1] ? resolve(process.argv[outArgIdx + 1]) : DEFAULT_OUT;

  console.log("[pull-parity] 经 home-mac-connect 只读拉取 macmini parity 基准…");

  // 1. 远端 HOME（用于 manifest 记录绝对路径；只读）
  const remoteHome = runRemote(["echo", "$HOME"], "echo $HOME").trim();
  if (!remoteHome.startsWith("/")) fail(`远端 HOME 异常：${remoteHome}`, 1);

  // 2. 远端 git HEAD（只读）
  const gitHead = runRemote(["git", "-C", `${REMOTE_REPO}`, "rev-parse", "HEAD"], "git rev-parse HEAD").trim();
  if (!/^[0-9a-f]{40}$/.test(gitHead)) fail(`远端 git HEAD 异常：${gitHead}`, 1);

  // 3. fish.config.json 快照（只读 cat；人名保留）
  const fishConfigRaw = runRemote(["cat", `${REMOTE_REPO}/fish.config.json`], "cat fish.config.json");
  let fishConfig: unknown;
  try {
    fishConfig = JSON.parse(fishConfigRaw);
  } catch (e) {
    fail(`远端 fish.config.json 不是合法 JSON：${e instanceof Error ? e.message : String(e)}`, 1);
  }

  // 4. .env 键值（只读 cat；原文只在内存，脱敏后才落盘）
  const envRaw = runRemote(["cat", `${REMOTE_REPO}/.env`], "cat .env");
  const env = parseEnv(envRaw);
  const redactions: Redaction[] = [];
  const envValues: Record<string, string> = {};
  for (const key of env.keys) {
    envValues[key] = redactValue(`env.${key}`, key, env.values[key], redactions);
  }
  const guardedConfig = guardDeep(fishConfig, "fishConfig", redactions);

  const manifest = {
    manifestVersion: 1,
    generatedAt: new Date().toISOString(),
    source: {
      host: "home-mac（zhanghaiyang-nas.local，经 home-mac-connect 中继）",
      fishConfigPath: `${remoteHome}/yugang/fish.config.json`,
      envPath: `${remoteHome}/yugang/.env`,
      transport: "connect.sh -- （ssh/scp 只读：echo $HOME / git rev-parse HEAD / cat ×2）",
      pullMode: "live" as const,
      note: "macmini 不可达时的人工兜底：本地副本手工构造，pullMode 标 manual-fallback 并注明来源待补",
    },
    gitHead,
    fishConfig: guardedConfig,
    env: {
      keyCount: env.keys.length,
      keys: env.keys,
      values: envValues,
    },
    redactions,
  };

  mkdirSync(dirname(outPath), { recursive: true });
  writeFileSync(outPath, `${JSON.stringify(manifest, null, 2)}\n`, { mode: 0o644 });

  console.log(`[pull-parity] manifest 已写入 ${outPath}`);
  console.log(`  gitHead     : ${gitHead}`);
  console.log(`  fish.config : ${Object.keys(fishConfig as object).length} 个顶层键（人名备注按口径保留）`);
  console.log(`  .env        : ${env.keys.length} 个键（token 类已脱敏）`);
  for (const r of redactions) console.log(`  [脱敏] ${r.where}（${r.kind}）${r.note}`);
  console.log("[pull-parity] 校验：node scripts/itbed/parity/check-parity.ts");
}

main();
