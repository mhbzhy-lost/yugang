/**
 * 部署：只在 macmini 上跑（本地开发机的 var/ 是迁移前旧现场，别在本地起鱼）。
 *
 *   npm run deploy    # git pull → 平滑重启鱼 → 验证存活与横幅
 *
 * 标准流程见 AGENTS.md「部署」：本地开发 + npm test → commit/push →
 * 连上 macmini → cd ~/yugang && npm run deploy。
 *
 * node 用 process.execPath 拿全路径：非交互 shell（ssh/nohup）的 PATH
 * 里没有 brew 的 node，直接 spawn("node") 会 No such file or directory。
 */
import { spawn, spawnSync } from "node:child_process";
import { closeSync, existsSync, fstatSync, mkdirSync, openSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { DATA_HOME, REPO_ROOT } from "../src/paths.ts";
import { findFishProcesses, fishProcessIdentity, pidFilePath, recordFishPid } from "./lib/pidfile.ts";

const LOG = join(DATA_HOME, "fish-console.log");
const FISH_ENTRY = join(REPO_ROOT, "src", "index.ts");
const GRACE_MS = 16_000;
const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

function alive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

// ── 容器形态护栏（两条，都是防「第二条鱼」）──────────────────────
if (process.env.YUGANG_CONTAINER === "1") {
  console.error("[deploy] ✗ 容器内不跑 deploy。部署 = 在宿主机重建镜像与容器：");
  console.error("           docker compose build fish && docker compose up -d fish");
  process.exit(1);
}
const dockerBin = ["/usr/local/bin/docker", "/opt/homebrew/bin/docker"].find((p) => existsSync(p));
if (dockerBin) {
  const ps = spawnSync(dockerBin, ["ps", "--filter", "name=yugang-fish", "--format", "{{.Names}}"], { encoding: "utf8", timeout: 8000 });
  const names = (ps.stdout ?? "").trim();
  if (ps.status === 0 && names !== "") {
    console.error(`[deploy] ✗ 检测到容器鱼在跑（${names}），拒绝在宿主机再起一条。`);
    console.error("           容器形态部署：docker compose build fish && docker compose up -d fish");
    console.error("           要回宿主机形态：先 docker compose down，再跑本命令。");
    process.exit(1);
  }
}

// 1. 拉代码；失败就停手，线上继续跑旧代码
console.log("[deploy] git fetch origin main");
const fetch = spawnSync("git", ["fetch", "origin", "main"], { stdio: "inherit", cwd: REPO_ROOT });
if (fetch.status !== 0) {
  console.error("[deploy] ✗ git fetch 失败，不动线上");
  process.exit(1);
}
const dirty = spawnSync("git", ["status", "--porcelain"], { encoding: "utf8", cwd: REPO_ROOT });
if (dirty.status !== 0 || (dirty.stdout ?? "").trim() !== "") {
  console.error("[deploy] ✗ 生产工作区有未提交改动，不自动覆盖");
  process.exit(1);
}
console.log("[deploy] git reset --hard FETCH_HEAD");
const reset = spawnSync("git", ["reset", "--hard", "FETCH_HEAD"], { stdio: "inherit", cwd: REPO_ROOT });
if (reset.status !== 0) {
  console.error("[deploy] ✗ git reset 失败，不动线上");
  process.exit(1);
}

// 2. 前置依赖：新进程读刚拉下来的代码；失败时线上继续跑旧代码。
console.log("[deploy] 前置依赖检查（Node 依赖 + 60s）");
const preflight = spawnSync(process.execPath, ["--env-file-if-exists=.env", join(REPO_ROOT, "scripts", "deps.ts")], {
  stdio: "inherit",
  cwd: REPO_ROOT,
});
if (preflight.status === 1) {
  console.error("[deploy] ✗ Node 依赖安装失败，不动线上");
  process.exit(1);
}
if (preflight.status === 2) {
  console.warn("[deploy] ⚠ 60s 新闻服务未就绪，新闻会按单源降级（不影响鱼启动）");
}

/** 读取并严格校验 up.pid；pid 文件存在但不可信时绝不猜测。 */
function pidFromFile(): number | undefined {
  const file = pidFilePath();
  if (!existsSync(file)) return undefined;
  let raw: string;
  try {
    raw = readFileSync(file, "utf8").trim();
  } catch {
    console.error(`[deploy] ✗ ${file} 读不出来，拒绝部署`);
    return undefined;
  }
  if (!/^\d+$/.test(raw)) {
    console.error(`[deploy] ✗ ${file} 内容不是可信 PID，拒绝部署`);
    return undefined;
  }
  const pid = Number(raw);
  if (!Number.isSafeInteger(pid) || pid <= 0 || !fishProcessIdentity(pid)) {
    console.error(`[deploy] ✗ ${file} 指向的 PID 不是本仓库的鱼，拒绝部署`);
    return undefined;
  }
  return pid;
}

/** TERM → 限时等 → KILL；每个信号前都重新核对严格身份。 */
async function stopFish(pid: number): Promise<boolean> {
  if (!fishProcessIdentity(pid)) {
    console.error(`[deploy] ✗ 旧鱼 pid ${pid} 身份不可信，拒绝发信号`);
    return false;
  }
  console.log(`[deploy] TERM 旧鱼 pid ${pid}（最多等 ${Math.round(GRACE_MS / 1000)}s 优雅退）`);
  try {
    if (!fishProcessIdentity(pid)) {
      console.error(`[deploy] ✗ pid ${pid} TERM 前身份已变化，拒绝发信号`);
      return false;
    }
    process.kill(pid, "SIGTERM");
  } catch {
    return !alive(pid);
  }
  const deadline = Date.now() + GRACE_MS;
  while (Date.now() < deadline) {
    if (!alive(pid)) return true;
    if (!fishProcessIdentity(pid)) {
      console.error(`[deploy] ✗ pid ${pid} 等待期间身份已变化，拒绝继续发信号`);
      return false;
    }
    await sleep(250);
  }
  console.warn(`[deploy] 旧鱼 pid ${pid} ${Math.round(GRACE_MS / 1000)}s 没退，KILL`);
  try {
    if (!fishProcessIdentity(pid)) {
      console.error(`[deploy] ✗ pid ${pid} KILL 前身份已变化，拒绝发信号`);
      return false;
    }
    process.kill(pid, "SIGKILL");
  } catch {
    return !alive(pid);
  }
  for (let i = 0; i < 20; i++) {
    if (!alive(pid)) return true;
    await sleep(100);
  }
  console.error(`[deploy] ✗ pid ${pid} KILL 后还在，拒绝启动新鱼`);
  return false;
}

// 3. 必须恰好有一个可信旧鱼；不可信 PID、多候选、无目标都拒绝部署。
const pidFilePid = pidFromFile();
const candidates = findFishProcesses();
if (pidFilePid === undefined || candidates.length !== 1 || candidates[0]?.pid !== pidFilePid) {
  console.error(`[deploy] ✗ 旧鱼目标不唯一或不可信（up.pid=${pidFilePid ?? "无效"}，可信候选=${candidates.map((p) => p.pid).join(",") || "无"}），拒绝部署`);
  process.exit(1);
}
if (!(await stopFish(pidFilePid))) {
  console.error("[deploy] ✗ 未能安全收掉旧鱼，拒绝启动新鱼");
  process.exit(1);
}
if (findFishProcesses().length !== 0) {
  console.error("[deploy] ✗ 收鱼后仍有可信候选，拒绝启动新鱼");
  process.exit(1);
}
await sleep(3000);

// 4. 起新鱼：日志追加到 var/fish-console.log，脱离本进程生命周期。
mkdirSync(DATA_HOME, { recursive: true });
const log = openSync(LOG, "a");
const logOffset = fstatSync(log).size;
const fish = spawn(process.execPath, ["--env-file-if-exists=.env", FISH_ENTRY], {
  cwd: REPO_ROOT,
  detached: true,
  stdio: ["ignore", log, log],
});
fish.unref();
closeSync(log);
if (!fish.pid) {
  console.error("[deploy] ✗ 新鱼没有有效 PID");
  process.exit(1);
}
recordFishPid(fish.pid); // 与 up 写同一个 var/up.pid（单一事实源）：否则 npm run down 认不得 deploy 起的鱼
console.log(`[deploy] 新鱼 pid ${fish.pid}，日志 ${LOG}`);

// 5. 语音跟随：与横幅验证并行拉起 TTS 实例；失败只告警，不影响部署结论
const tts = spawn(process.execPath, [join(import.meta.dirname, "tts.ts"), "up"], { stdio: "inherit" });
const ttsExit = new Promise<number | null>((resolve) => tts.once("exit", (code) => resolve(code)));

// 6. 验证：只看启动前日志偏移之后的内容，避免误读旧鱼的「已连接」横幅。
await sleep(8000);
const alive = fishProcessIdentity(fish.pid) !== undefined;
let tail = "";
try {
  const logBytes = readFileSync(LOG);
  tail = logBytes.subarray(Math.min(logOffset, logBytes.length)).toString("utf8");
} catch {
  tail = "";
}
if (!alive || !tail.includes("已连接")) {
  console.error("[deploy] ✗ 新鱼没起来或没有「已连接」横幅，启动后的日志：");
  console.error(tail.trim());
  process.exit(1);
}
console.log("[deploy] ✓ 存活，横幅：");
for (const line of tail.trim().split("\n").reverse()) {
  if (line.includes("已连接") || line.includes("凭据")) console.log(`  ${line}`);
}
const ttsCode = await Promise.race([
  ttsExit,
  new Promise<null>((r) => setTimeout(() => r(null), 120_000).unref?.()),
]);
if (ttsCode === 0) console.log("[deploy] ✓ 语音实例就绪");
else console.warn(`[deploy] ⚠ 语音拉起未完全成功（tts up 退出码 ${ttsCode}），鱼不受影响；稍后 npm run tts status 复查`);
