/**
 * IT bed sandbox 启动器 —— 一键拉起「faux NapCat + faux 60s + faux B 站 + 鱼」（Task I2）。
 *
 * 结构（docs/plans/2026-11-03-itbed.md）：
 *   1. 独立 sandbox：缺省 <repo>/var/itbed/sandbox（--sandbox-dir 可换），每次启动整目录
 *      重建——fresh db/media/workspace，绝不触碰仓库 var/ 的真数据；
 *   2. fish.config 覆盖层：从 parity manifest 的 fishConfig 快照生成，--config-patch 叠加，
 *      写进 sandbox/fish.config.json（鱼读 cwd/fish.config.json；npm run 会把 cwd 切回仓库根，
 *      见下——所以覆盖层的值同时镜像进 fish-config 认识的环境变量，行为面真正生效）；
 *   3. 环境注入（spawn env，优先级高于 npm start 的 --env-file 加载——Node 语义：已存在的
 *      环境变量胜出 env-file，2026-11-03 本机实测）：
 *        ONEBOT_WS_URL/ONEBOT_TOKEN → faux NapCat；GROUPS=424242、MASTER_QQ=1000002（faux 值）；
 *        PROTOCOL_QQ 沿用 parity 非凭据值并与 napcat --self 对齐；GROUPS/master 不用生产值；
 *        SIXTY_BASE_URL/BILI_BASE_URL → faux 60s / faux B 站；
 *        AMBIENT_CHANCE/COOLDOWN_MS/DAILY_QUOTA/QUIET_HOURS/THINKING_LEVEL 等沿用 parity 脱敏值；
 *        YUGANG_HOME/MEDIA_ROOT/WORKSPACE_ROOT → sandbox 内路径；
 *        token 类（MODELSCOPE_KEY 等）parity 里是占位符，不注入、不落 sandbox——不把真实
 *        token 复制进 sandbox。
 *   4. 启动顺序：先三个 faux 服务（等 /health 全绿）再 spawn `npm start`；npm 显式
 *      cwd=仓库根——npm run 会向上找 package.json 并把 cwd 切回仓库根（2026-11-03 实测：
 *      从无 package.json 的目录起跑直接 ENOENT），不能依赖 spawn cwd，sandbox 靠 env 接线。
 *   5. 冒烟闭环（本脚本内置）：等鱼连上 faux NapCat（≤90s）→ POST /inject 注入一条 @鱼 →
 *      等 faux outbound.jsonl 出现记录（≤60s）→ SIGTERM 透传给鱼（进程组）→ 收掉全部
 *      faux → 打印 sandbox/outbound 路径与证据汇总。全程限时，无无限等待。
 *
 * 用法：
 *   node scripts/itbed/launch.ts [--sandbox-dir <dir>] [--port-base 4400]
 *                                [--config-patch '{"compact":{"maxChars":20000}}' | @file.json]
 *                                [--serve | --no-smoke] [--serve-max-ms 600000]
 *   端口分配：napcat=base、60s=base+1、bili=base+2（缺省 4400/4401/4402）。
 *   缺省（无 --serve）：冒烟闭环自动跑完并限时退出。
 *   --serve/--no-smoke（Task I3，驱动器 driver.ts 消费）：等鱼连上 faux NapCat 后打印一行
 *   `[itbed-ready] {JSON}`（含 sandbox、三 faux 端口、outbound/log 路径、注入 URL、测试群号），
 *   并写 <sandbox>/itbed-ready.json；然后挂住等待——不注入冒烟消息、不自行退出；
 *   SIGTERM/SIGINT（或鱼退出 / --serve-max-ms 上限）触发后按原有 teardown 顺序收摊。
 *   默认无参冒烟行为保持不变。
 *
 * 已知边界（不改 src 的前提下）：
 *   - bili-client 已支持 BILI_BASE_URL 覆盖（未设置默认 https://api.bilibili.com），launch 注入
 *     后 IT bed 会真正指向 faux B 站；
 *   - fish.config 的 voices/memeCooldown/ammo/news 只认文件，sandbox 生效面以环境变量可表达
 *     的字段为限（parity .env 值已覆盖其中行为参数）；
 *   - 少量工具（draw/look/restart/config）读写 cwd=仓库根 的 var/ 路径，sandbox 隔离以
 *     YUGANG_HOME（db/media/workspace/chatlog/usage）为准。
 */

import { spawn, type ChildProcess, type StdioOptions } from "node:child_process";
import { appendFileSync, existsSync, mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";

// ── 常量：faux 世界观（与 faux NapCat 的固定名单/测试群对齐；一律不用生产值）──

const REPO_ROOT = resolve(import.meta.dirname, "..", "..");
const SCRIPTS_ITBED = resolve(import.meta.dirname);
const PARITY_MANIFEST = join(SCRIPTS_ITBED, "parity", "parity-manifest.json");
const DEFAULT_SANDBOX = join(REPO_ROOT, "var", "itbed", "sandbox");
const FAUX_WS_TOKEN = "itbed-faux-token"; // 测试 token：napcat --token 与 ONEBOT_TOKEN 同值
const TEST_GROUP_ID = 424242; // faux 测试群（napcat --groups 同值）
const FAUX_MASTER_QQ = 1000002; // faux 名单里的「主人」（napcat ROSTER owner）
const FISH_CONNECT_TIMEOUT_MS = 90_000; // 合同上限：启动鱼最多 90 秒
const OUTBOUND_TIMEOUT_MS = 60_000;
const HEALTH_TIMEOUT_MS = 10_000;
const WATCHDOG_MS = 180_000; // 总兜底：任何卡死路径最终都会走到这里（serve 模式改用 SERVE_MAX_MS）

// serve/no-smoke 模式（向后兼容分支：不影响默认冒烟路径）
const SERVE = hasFlag("serve") || hasFlag("no-smoke");
const SERVE_MAX_MS = num(argValue("serve-max-ms"), 600_000); // serve 生命周期上限（驱动器会传更紧的值）

// ── CLI（CLI > 环境变量 > 缺省，同 faux 系风格）──────────────────────────────

function argValue(name: string): string | undefined {
  const at = process.argv.indexOf(`--${name}`);
  return at >= 0 && at + 1 < process.argv.length ? process.argv[at + 1] : undefined;
}
function hasFlag(name: string): boolean {
  return process.argv.includes(`--${name}`);
}
function num(value: string | undefined, fallback: number): number {
  const n = Number(value);
  return Number.isFinite(n) && n > 0 && Number.isInteger(n) ? n : fallback;
}

if (hasFlag("help")) {
  console.log(
    "IT bed sandbox 启动器\n" +
      "用法：node scripts/itbed/launch.ts [--sandbox-dir <dir>] [--port-base 4400]\n" +
      "                    [--config-patch '{\"compact\":{\"maxChars\":20000}}' | @file.json]\n" +
      "                    [--serve | --no-smoke] [--serve-max-ms 600000]\n" +
      "端口：napcat=base、60s=base+1、bili=base+2。\n" +
      "缺省：冒烟闭环（注入 @鱼 → 等出站 → 收摊退出）。\n" +
      "--serve/--no-smoke：等鱼连上后打印 [itbed-ready] {JSON} 行并写 <sandbox>/itbed-ready.json，\n" +
      "挂住等 SIGTERM/SIGINT（鱼退出/上限也触发）；结束按原有顺序收摊。供驱动器（driver.ts）使用。",
  );
  process.exit(0);
}

const SANDBOX_DIR = resolve(argValue("sandbox-dir") ?? DEFAULT_SANDBOX);
const PORT_BASE = num(argValue("port-base"), 4400);
const NAPCAT_PORT = PORT_BASE;
const SIXTY_PORT = PORT_BASE + 1;
const BILI_PORT = PORT_BASE + 2;

/** --config-patch：内联 JSON 或 @文件路径。 */
function loadConfigPatch(): Record<string, unknown> {
  const raw = argValue("config-patch");
  if (raw === undefined) return {};
  const text = raw.startsWith("@") ? readFileSync(resolve(raw.slice(1)), "utf8") : raw;
  const parsed: unknown = JSON.parse(text);
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error("--config-patch 须是 JSON 对象");
  }
  return parsed as Record<string, unknown>;
}

// ── parity manifest（脱敏快照；token 类是占位符，绝不注入）─────────────────

interface ParityManifest {
  fishConfig: Record<string, unknown>;
  envValues: Record<string, string>;
}

function loadParity(): ParityManifest {
  if (!existsSync(PARITY_MANIFEST)) {
    throw new Error(`找不到 parity manifest：${PARITY_MANIFEST}（先跑 scripts/itbed/parity/pull-parity.ts）`);
  }
  const raw: unknown = JSON.parse(readFileSync(PARITY_MANIFEST, "utf8"));
  if (raw === null || typeof raw !== "object") throw new Error("parity manifest 不是对象");
  const root = raw as Record<string, unknown>;
  const fishConfig = (root["fishConfig"] ?? {}) as Record<string, unknown>;
  const envRaw = (root["env"] ?? {}) as Record<string, unknown>;
  const envValues = (envRaw["values"] ?? {}) as Record<string, string>;
  return { fishConfig, envValues };
}

/** 深合并（对象递归，数组/标量整体替换）——parity fishConfig < config-patch。 */
function deepMerge(base: Record<string, unknown>, patch: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = { ...base };
  for (const [key, value] of Object.entries(patch)) {
    const prev = out[key];
    out[key] =
      value !== null && typeof value === "object" && !Array.isArray(value) &&
      prev !== null && typeof prev === "object" && !Array.isArray(prev)
        ? deepMerge(prev as Record<string, unknown>, value as Record<string, unknown>)
        : value;
  }
  return out;
}

function numOf(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

// ── 进程编排 ─────────────────────────────────────────────────────────────────

interface ManagedProcess {
  name: string;
  proc: ChildProcess;
  logPath: string;
  flushTagger: () => void;
  exit: { code: number | null; signal: string | null } | null;
}

const managed = new Map<string, ManagedProcess>();
/** 已退出的进程记录（收摊后汇总用；managed 里的条目退出即被移除）。 */
const exitRecords = new Map<string, { code: number | null; signal: string | null }>();
let tearingDown = false;

/** 行缓冲打标：完整行带 [名字] 前缀上屏，原始字节全量落 log 文件。 */
function makeTagger(name: string, logPath: string): { write: (chunk: Buffer) => void; flush: () => void } {
  let rest = "";
  return {
    write: (chunk: Buffer) => {
      appendFileSync(logPath, chunk);
      rest += chunk.toString("utf8");
      const lines = rest.split("\n");
      rest = lines.pop() ?? "";
      for (const line of lines) {
        if (line.trim().length > 0) console.log(`  [${name}] ${line}`);
      }
    },
    flush: () => {
      if (rest.trim().length > 0) console.log(`  [${name}] ${rest}`);
      rest = "";
    },
  };
}

function spawnManaged(name: string, command: string, args: string[], cwd: string, env: NodeJS.ProcessEnv, logPath: string): ChildProcess {
  mkdirSync(cwd, { recursive: true });
  const stdio: StdioOptions = ["ignore", "pipe", "pipe"];
  // detached：POSIX 下自成进程组，SIGTERM 透传按组打（npm→sh→node 全链路一起收）
  const proc = spawn(command, args, { cwd, env, stdio, ...(process.platform !== "win32" ? { detached: true } : {}) });
  const tagger = makeTagger(name, logPath);
  proc.stdout?.on("data", (chunk: Buffer) => tagger.write(chunk));
  proc.stderr?.on("data", (chunk: Buffer) => tagger.write(chunk));
  const entry: ManagedProcess = { name, proc, logPath, flushTagger: tagger.flush, exit: null };
  proc.on("exit", (code, signal) => {
    entry.exit = { code, signal };
    exitRecords.set(name, { code, signal });
    tagger.flush();
    managed.delete(name);
    console.log(`  [itbed] ${name} 退出（pid=${String(proc.pid ?? "?")} code=${code}${signal ? ` signal=${signal}` : ""}）`);
  });
  proc.on("error", (error) => {
    console.log(`  [itbed] ${name} 起进程失败：${error.message}`);
  });
  managed.set(name, entry);
  return proc;
}

/** 按进程组透传信号；组投递失败（组头已退）退回单进程投递。 */
function signalProcess(name: string, signal: NodeJS.Signals): void {
  const entry = managed.get(name);
  if (entry === undefined || entry.exit !== null) return;
  const pid = entry.proc.pid;
  if (pid === undefined) return;
  const { proc } = entry;
  try {
    if (process.platform !== "win32") {
      process.kill(-pid, signal);
    } else {
      proc.kill(signal);
    }
  } catch {
    try {
      proc.kill(signal);
    } catch {
      // 进程已不在：无残留，视为成功
    }
  }
}

function waitExit(name: string, timeoutMs: number): Promise<void> {
  const entry = managed.get(name);
  if (entry === undefined || entry.exit !== null) return Promise.resolve();
  return new Promise((resolveWait) => {
    const timer = setTimeout(() => resolveWait(), timeoutMs);
    entry.proc.once("exit", () => {
      clearTimeout(timer);
      resolveWait();
    });
  });
}

/** SIGTERM → 等退 → SIGKILL 兜底，先鱼后 faux（鱼有 drain 补发逻辑，给它礼让窗口）。 */
async function teardown(reason: string): Promise<void> {
  if (tearingDown) return;
  tearingDown = true;
  console.log(`\n[itbed] 收摊（${reason}）：SIGTERM → 鱼（进程组）…`);
  signalProcess("fish", "SIGTERM");
  await waitExit("fish", 10_000);
  if (managed.has("fish")) {
    console.log("  [itbed] 鱼 10s 未退，SIGKILL 进程组");
    signalProcess("fish", "SIGKILL");
    await waitExit("fish", 2_000);
  }
  for (const name of ["napcat", "sixty", "bili"]) {
    signalProcess(name, "SIGTERM");
  }
  await Promise.all(["napcat", "sixty", "bili"].map((name) => waitExit(name, 3_000)));
  for (const name of ["napcat", "sixty", "bili"]) {
    if (managed.has(name)) {
      signalProcess(name, "SIGKILL");
      await waitExit(name, 2_000);
    }
  }
}

/** 收摊后的退出态一行表（冒烟与 serve 共用）。 */
function exitSummary(): string {
  return ["fish", "napcat", "sixty", "bili"]
    .map((name) => {
      const record = exitRecords.get(name);
      return `${name}: ${record !== undefined ? `code=${record.code}${record.signal !== null ? ` signal=${record.signal}` : ""}` : "仍在运行"}`;
    })
    .join("；");
}

// ── serve 模式停止闸门：信号/鱼退出/watchdog → main 内收摊后正常退出 ─────────

let serveGateResolve: ((reason: string) => void) | null = null;
let serveGateSettled = false;

/** 打开停止闸门；返回的 Promise 在第一个停止请求到达时以原因结算。 */
function openServeGate(): Promise<string> {
  return new Promise<string>((resolveGate) => {
    serveGateResolve = (reason) => {
      if (serveGateSettled) return;
      serveGateSettled = true;
      resolveGate(reason);
    };
  });
}

function requestServeStop(reason: string): void {
  serveGateResolve?.(reason);
}

async function main(): Promise<number> {
  const startedAt = Date.now();
  console.log(`[itbed] sandbox 启动器开跑：port-base=${PORT_BASE}（napcat=${NAPCAT_PORT} 60s=${SIXTY_PORT} bili=${BILI_PORT}）`);

  // —— 0. parity 与 sandbox 目录 ——
  const parity = loadParity();
  const protocolQQ = parity.envValues["PROTOCOL_QQ"] ?? "1000001";
  for (const forbidden of [REPO_ROOT, SCRIPTS_ITBED]) {
    if (SANDBOX_DIR === forbidden || forbidden.startsWith(SANDBOX_DIR + "/")) {
      throw new Error(`--sandbox-dir 不能覆盖 ${forbidden}`);
    }
  }
  if (existsSync(SANDBOX_DIR)) {
    rmSync(SANDBOX_DIR, { recursive: true, force: true });
    console.log(`[itbed] 已清空旧 sandbox：${SANDBOX_DIR}`);
  }
  const sbVar = join(SANDBOX_DIR, "var");
  for (const dir of [sbVar, join(sbVar, "media"), join(sbVar, "workspace"), join(SANDBOX_DIR, "logs")]) {
    mkdirSync(dir, { recursive: true });
  }
  const outboundPath = join(SANDBOX_DIR, "outbound.jsonl");
  const fishLogPath = join(SANDBOX_DIR, "logs", "fish.log");
  console.log(`[itbed] sandbox：${SANDBOX_DIR}`);
  console.log(`[itbed] 出站记录：${outboundPath}（faux NapCat 落盘）`);

  // —— 1. fish.config 覆盖层：parity fishConfig < --config-patch，落盘 + 环境镜像 ——
  const configPatch = loadConfigPatch();
  const fishConfig = deepMerge(parity.fishConfig, configPatch);
  const overlayPath = join(SANDBOX_DIR, "fish.config.json");
  writeFileSync(overlayPath, `${JSON.stringify(fishConfig, null, 2)}\n`);
  console.log(`[itbed] fish.config 覆盖层：${overlayPath}${Object.keys(configPatch).length > 0 ? "（含 --config-patch）" : ""}`);

  // —— 2. 注入 env（spawn env 优先级高于 npm start 的 env-file；真实 token 一律不进 sandbox）——
  const compact = (fishConfig["compact"] ?? {}) as Record<string, unknown>;
  const fishEnv: NodeJS.ProcessEnv = {
    // faux 身份（GROUPS/master 用 faux 值，不用生产群/生产主人）
    ONEBOT_WS_URL: `ws://127.0.0.1:${NAPCAT_PORT}`,
    ONEBOT_TOKEN: FAUX_WS_TOKEN,
    GROUPS: String(TEST_GROUP_ID),
    MASTER_QQ: String(FAUX_MASTER_QQ),
    PROTOCOL_QQ: protocolQQ,
    WEEKLY_GROUP_ID: String(TEST_GROUP_ID),
    BYPASS_GROUPS: "",
    AMBIENT_CHANCE_BY_GROUP: "",
    // faux 上游
    SIXTY_BASE_URL: `http://127.0.0.1:${SIXTY_PORT}`,
    BILI_BASE_URL: `http://127.0.0.1:${BILI_PORT}`,
    // 独立 sandbox
    YUGANG_HOME: sbVar,
    MEDIA_ROOT: join(sbVar, "media"),
    WORKSPACE_ROOT: join(sbVar, "workspace"),
    // parity 脱敏行为参数（沿用）
    ...(parity.envValues["AMBIENT_CHANCE"] !== undefined ? { AMBIENT_CHANCE: parity.envValues["AMBIENT_CHANCE"] } : {}),
    ...(parity.envValues["COOLDOWN_MS"] !== undefined ? { COOLDOWN_MS: parity.envValues["COOLDOWN_MS"] } : {}),
    ...(parity.envValues["DAILY_QUOTA"] !== undefined ? { DAILY_QUOTA: parity.envValues["DAILY_QUOTA"] } : {}),
    ...(parity.envValues["QUIET_HOURS"] !== undefined ? { QUIET_HOURS: parity.envValues["QUIET_HOURS"] } : {}),
    ...(parity.envValues["THINKING_LEVEL"] !== undefined ? { THINKING_LEVEL: parity.envValues["THINKING_LEVEL"] } : {}),
    // fish.config 覆盖层 → 环境镜像（鱼读 cwd 的 fish.config.json，npm 把 cwd 切回仓库根，
    // 覆盖层的值靠这组镜像真正生效；parity .env 值与快照一致，两路同源不冲突）
    ...(numOf(fishConfig["watchAmbientChance"]) !== undefined ? { WATCH_AMBIENT_CHANCE: String(numOf(fishConfig["watchAmbientChance"])) } : {}),
    ...(numOf(fishConfig["ambientMinIntervalSeconds"]) !== undefined ? { AMBIENT_MIN_INTERVAL_SECONDS: String(numOf(fishConfig["ambientMinIntervalSeconds"])) } : {}),
    ...(numOf(fishConfig["toolTimeoutSeconds"]) !== undefined ? { TOOL_TIMEOUT_SECONDS: String(numOf(fishConfig["toolTimeoutSeconds"])) } : {}),
    ...(typeof fishConfig["thinkingLevel"] === "string" ? { THINKING_LEVEL: fishConfig["thinkingLevel"] } : {}),
    ...(numOf(compact["maxEntries"]) !== undefined ? { COMPACT_MAX_ENTRIES: String(numOf(compact["maxEntries"])) } : {}),
    ...(numOf(compact["maxChars"]) !== undefined ? { COMPACT_MAX_CHARS: String(numOf(compact["maxChars"])) } : {}),
  };
  console.log("[itbed] 注入 env：");
  for (const [key, value] of Object.entries(fishEnv)) {
    console.log(`    ${key}=${value}`);
  }

  // —— 3. 起 faux 服务（等 /health 全绿再起鱼）——
  const nodeBin = process.execPath;
  spawnManaged("napcat", nodeBin, [
    join(SCRIPTS_ITBED, "faux", "napcat.ts"),
    "--port", String(NAPCAT_PORT),
    "--out", outboundPath,
    "--token", FAUX_WS_TOKEN,
    "--groups", String(TEST_GROUP_ID),
    "--self", protocolQQ,
    "--heartbeat-ms", "5000",
  ], REPO_ROOT, process.env, join(SANDBOX_DIR, "logs", "napcat.log"));
  spawnManaged("sixty", nodeBin, [join(SCRIPTS_ITBED, "faux", "sixty.ts"), "--port", String(SIXTY_PORT)], REPO_ROOT, process.env, join(SANDBOX_DIR, "logs", "sixty.log"));
  spawnManaged("bili", nodeBin, [join(SCRIPTS_ITBED, "faux", "bili.ts"), "--port", String(BILI_PORT)], REPO_ROOT, process.env, join(SANDBOX_DIR, "logs", "bili.log"));

  async function waitHealth(name: "napcat" | "sixty" | "bili", port: number): Promise<void> {
    const deadline = Date.now() + HEALTH_TIMEOUT_MS;
    for (;;) {
      if (Date.now() > deadline) throw new Error(`${name} ${HEALTH_TIMEOUT_MS}ms 内未就绪（/health 不绿）`);
      try {
        const res = await fetch(`http://127.0.0.1:${port}/health`);
        if (res.ok) {
          const body = (await res.json()) as Record<string, unknown>;
          if (body["ok"] === true) {
            console.log(`  [itbed] ${name} 就绪（127.0.0.1:${port}）`);
            return;
          }
        }
      } catch {
        // 还没起好：继续轮
      }
      await new Promise((r) => setTimeout(r, 300));
    }
  }
  await waitHealth("napcat", NAPCAT_PORT);
  await waitHealth("sixty", SIXTY_PORT);
  await waitHealth("bili", BILI_PORT);

  // —— 4. spawn npm start（显式 cwd=仓库根：npm run 会向上找 package.json 并切回仓库根，
  //       sandbox 全靠 env 接线；spawn env 胜出 env-file，实测语义）——
  spawnManaged("fish", "npm", ["start"], REPO_ROOT, { ...process.env, ...fishEnv }, fishLogPath);
  console.log(`  [itbed] npm start 已拉起（fish cwd=仓库根，pid=${managed.get("fish")?.proc.pid ?? "?"}）`);

  // fish 提前退场（起失败/端口占用等）→ 直接收摊报错
  const fishEntry = managed.get("fish");
  const earlyExit = new Promise<never>((_, reject) => {
    fishEntry?.proc.once("exit", (code) => reject(new Error(`鱼提前退出（code=${code}），详见 ${fishLogPath}`)));
  });
  // 冒烟成功后的正常收摊也会触发这个 reject；race 已结算，补一个空 catch 防 unhandledRejection
  earlyExit.catch(() => undefined);

  // —— 5. 等鱼连上 faux NapCat（≤90s）——
  const connectDeadline = Date.now() + FISH_CONNECT_TIMEOUT_MS;
  console.log("[itbed] 等鱼连上 faux NapCat…");
  await Promise.race([
    (async () => {
      for (;;) {
        if (Date.now() > connectDeadline) throw new Error(`鱼 ${FISH_CONNECT_TIMEOUT_MS / 1000}s 内未连上 faux NapCat（检查 ONEBOT_WS_URL 注入与 napcat 日志）`);
        try {
          const res = await fetch(`http://127.0.0.1:${NAPCAT_PORT}/health`);
          const body = (await res.json()) as { clients?: number };
          if ((body["clients"] ?? 0) >= 1) return;
        } catch {
          // napcat 自身异常时上面 earlyExit / watchdog 兜底
        }
        await new Promise((r) => setTimeout(r, 400));
      }
    })(),
    earlyExit,
  ]);
  console.log(`  [itbed] 鱼已连上 faux NapCat（耗时 ${((Date.now() - startedAt) / 1000).toFixed(1)}s）`);

  // —— 5.5 serve 模式：打印 ready → 挂住等停止信号（不注入、不自行退出）——
  // 驱动器（driver.ts）读 [itbed-ready] 行或 itbed-ready.json 拿端口/路径；
  // SIGTERM/SIGINT 由入口的 onStopSignal 转成闸门结算，鱼退出 / serve 上限同样触发。
  if (SERVE) {
    const ready = {
      readyAt: new Date().toISOString(),
      pid: process.pid,
      sandbox: SANDBOX_DIR,
      ports: { napcat: NAPCAT_PORT, sixty: SIXTY_PORT, bili: BILI_PORT },
      outbound: outboundPath,
      log: fishLogPath,
      groupId: TEST_GROUP_ID,
      injectUrl: `http://127.0.0.1:${NAPCAT_PORT}/inject`,
    };
    const readyPath = join(SANDBOX_DIR, "itbed-ready.json");
    writeFileSync(readyPath, `${JSON.stringify(ready, null, 2)}\n`);
    console.log(`[itbed-ready] ${JSON.stringify(ready)}`);
    console.log(`[itbed] serve 模式：不注入冒烟消息；等 SIGTERM/SIGINT（上限 ${Math.round(SERVE_MAX_MS / 1000)}s）；ready 落盘 ${readyPath}`);
    const gate = openServeGate(); // 先开闸门再挂鱼退出监听，避免极早退出丢信号
    fishEntry?.proc.once("exit", () => requestServeStop("fish-exit"));
    const stopReason = await gate;
    const serveFailed = stopReason === "fish-exit" || stopReason === "serve-watchdog";
    await teardown(`serve 结束（${stopReason}）`);
    console.log(`\n[itbed] serve 结束（${stopReason}）\n  退出态：${exitSummary()}`);
    return serveFailed ? 1 : 0;
  }

  // —— 6. 注入一条 @鱼 ——
  const injectBody = JSON.stringify({ kind: "group", groupId: TEST_GROUP_ID, at: ["bot"], text: "鱼鱼在吗？IT bed 冒烟报到" });
  const injectRes = await fetch(`http://127.0.0.1:${NAPCAT_PORT}/inject`, { method: "POST", body: injectBody });
  if (!injectRes.ok) throw new Error(`注入失败：HTTP ${injectRes.status}`);
  const injected = (await injectRes.json()) as { ok?: boolean; messageId?: number | string };
  if (injected["ok"] !== true) throw new Error(`注入被拒：${JSON.stringify(injected)}`);
  console.log(`  [itbed] 已注入 @鱼（messageId=${injected["messageId"]}，群 ${TEST_GROUP_ID}）`);

  // —— 7. 等 faux outbound.jsonl 出现记录（≤60s）——
  console.log("[itbed] 等出站记录（outbound.jsonl）…");
  const outboundDeadline = Date.now() + OUTBOUND_TIMEOUT_MS;
  for (;;) {
    if (Date.now() > outboundDeadline) throw new Error(`${OUTBOUND_TIMEOUT_MS / 1000}s 内 outbound.jsonl 仍无记录（鱼没回话：查 ${fishLogPath}）`);
    if (existsSync(outboundPath)) {
      const size = statSync(outboundPath).size;
      if (size > 0) break;
    }
    await new Promise((r) => setTimeout(r, 500));
  }
  const outboundLines = readFileSync(outboundPath, "utf8").split("\n").filter((line) => line.trim().length > 0);
  console.log(`  [itbed] 出站记录已落盘：${outboundLines.length} 条`);
  for (const line of outboundLines.slice(0, 3)) {
    console.log(`    ${line.length > 300 ? `${line.slice(0, 300)}…` : line}`);
  }

  // —— 8. SIGTERM 收摊：鱼（进程组）→ faux 全家 ——
  await teardown("冒烟闭环完成");
  const elapsed = ((Date.now() - startedAt) / 1000).toFixed(1);
  console.log(
    `\n[itbed] 冒烟闭环通过 ✓\n` +
      `  总耗时 ${elapsed}s；sandbox=${SANDBOX_DIR}\n` +
      `  outbound=${outboundPath}（${outboundLines.length} 条）\n` +
      `  退出态：${exitSummary()}`,
  );
  return 0;
}

// ── 入口：信号透传 + 看门狗兜底，任何路径都限时退出 ─────────────────────────

let exitCode = 1;
try {
  const watchdogMs = SERVE ? SERVE_MAX_MS : WATCHDOG_MS;
  const watchdog = setTimeout(() => {
    console.error(`\n[itbed] 看门狗触发（${watchdogMs / 1000}s 总上限），强制收摊`);
    if (SERVE && serveGateResolve !== null && !serveGateSettled) {
      requestServeStop("serve-watchdog"); // main 收摊后以非 0 退出
      return;
    }
    void teardown("watchdog").then(() => process.exit(1));
  }, watchdogMs);
  watchdog.unref();

  // serve 模式下首个 SIGTERM/SIGINT 只结算闸门（main 负责收摊并正常退出）；
  // 非 serve 模式、或闸门已结算后的重复信号：立即收摊强退。
  const onStopSignal = (signal: "SIGINT" | "SIGTERM"): void => {
    if (SERVE && serveGateResolve !== null && !serveGateSettled) {
      requestServeStop(signal);
      return;
    }
    void teardown(signal).then(() => process.exit(signal === "SIGINT" ? 130 : 143));
  };
  process.on("SIGINT", () => onStopSignal("SIGINT"));
  process.on("SIGTERM", () => onStopSignal("SIGTERM"));

  exitCode = await main();
} catch (error) {
  console.error(`\n[itbed] 失败：${error instanceof Error ? error.message : String(error)}`);
  await teardown("失败收摊");
} finally {
  process.exit(exitCode);
}
