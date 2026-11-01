/**
 * 收掉 up / deploy 起的鱼：var/up.pid 是单一事实源（两个启动方都写它，见 scripts/lib/pidfile.ts）；
 * 协议端如果是外部起的不会动它。
 *   npm run down
 *
 * 顺序：读 up.pid → 核对（进程还在，且确实是本仓库的鱼）→ TERM 优雅退（最多 16s，
 * 留时间 drain 完 outbox）→ 超时 KILL。pid 文件缺失 / 陈旧 / 内容不对时用 pgrep 兑底：
 * 只认「node --env-file-if-exists=.env src/index.ts 且 cwd 在本仓库」的进程，别的 node 一律不碰。
 * 每一步都打日志。
 */
import { spawnSync } from "node:child_process";
import { existsSync, readFileSync, unlinkSync } from "node:fs";
import { resolve } from "node:path";
import { pidFilePath } from "./lib/pidfile.ts";

const REPO = resolve(import.meta.dirname, "..");
const PID_FILE = pidFilePath();
/** TERM 后给它多久优雅退（与 deploy 收旧鱼的 16s 一致），超时才 KILL */
const GRACE_MS = 16_000;
const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

/** 进程还在吗（kill 0 只探活，不发信号） */
function alive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

/** 进程命令行；读不到返回空串 */
function commandOf(pid: number): string {
  const out = spawnSync("ps", ["-p", String(pid), "-o", "command="], { encoding: "utf8" });
  return (out.stdout ?? "").trim();
}

/** 进程 cwd（macOS 没有 /proc，用 lsof）；读不到返回空串 */
function cwdOf(pid: number): string {
  const out = spawnSync("lsof", ["-a", "-p", String(pid), "-d", "cwd", "-Fn"], { encoding: "utf8" });
  for (const line of (out.stdout ?? "").split("\n")) {
    if (line.startsWith("n")) return line.slice(1);
  }
  return "";
}

/** 是不是本仓库的鱼：启动命令行必须是「node --env-file-if-exists=.env src/index.ts」且 cwd 在本仓库。
 *  三个特征都对上才动，宁慢勿误杀（up 与 deploy 起鱼都是这一条命令，见两处 spawn）。 */
function isOurFish(pid: number): boolean {
  const cmd = commandOf(pid);
  const head = cmd.split(" ")[0] ?? "";
  return cmd.endsWith("src/index.ts") && cmd.includes("--env-file-if-exists=.env") && head.endsWith("node") && cwdOf(pid) === REPO;
}

/** 兑底定位：pgrep 预筛「node … --env-file-if-exists=.env src/index.ts」，再由 isOurFish 三特征收窄，避免误杀 */
function findFishByPgrep(): number[] {
  const out = spawnSync("pgrep", ["-f", "node.*--env-file-if-exists=\\.env src/index\\.ts"], { encoding: "utf8" });
  const pids = (out.stdout ?? "")
    .split("\n")
    .map((line) => Number(line.trim()))
    .filter((pid) => Number.isInteger(pid) && pid > 0 && pid !== process.pid);
  const ours = pids.filter(isOurFish);
  const skipped = pids.filter((pid) => !ours.includes(pid));
  if (skipped.length > 0) console.log(`[down] pgrep 另命中 ${skipped.length} 个非本仓库进程，不碰：${skipped.join(" ")}`);
  return ours;
}

/** TERM → 限时等 → KILL；每步打日志。返回是否确认退场。 */
async function stopFish(pid: number): Promise<boolean> {
  console.log(`[down] TERM pid ${pid}（最多等 ${Math.round(GRACE_MS / 1000)}s 优雅退）`);
  try {
    process.kill(pid, "SIGTERM");
  } catch {
    console.log(`[down] pid ${pid} 已经不在了`);
    return true;
  }
  const deadline = Date.now() + GRACE_MS;
  while (Date.now() < deadline) {
    if (!alive(pid)) {
      console.log(`[down] ✓ pid ${pid} 已退出`);
      return true;
    }
    await sleep(250);
  }
  console.warn(`[down] pid ${pid} ${Math.round(GRACE_MS / 1000)}s 没退，KILL`);
  try {
    process.kill(pid, "SIGKILL");
  } catch {
    return true; // KILL 前刚好自己退了
  }
  for (let i = 0; i < 20; i++) {
    if (!alive(pid)) {
      console.log(`[down] ✓ pid ${pid} 已强杀`);
      return true;
    }
    await sleep(100);
  }
  console.error(`[down] ✗ pid ${pid} KILL 后还在，手动看看：ps -p ${pid}`);
  return false;
}

// 1) 单一事实源：up.pid（up 与 deploy 起鱼都写它）
let handled = false;
if (existsSync(PID_FILE)) {
  const raw = readFileSync(PID_FILE, "utf8").trim();
  const pid = Number(raw);
  if (Number.isInteger(pid) && pid > 0) {
    if (!alive(pid)) {
      console.log(`[down] up.pid 里的 pid ${pid} 已经不在了，清掉陈旧文件`);
      unlinkSync(PID_FILE);
    } else if (!isOurFish(pid)) {
      console.log(
        `[down] up.pid 里的 pid ${pid} 不是本仓库的鱼（命令行 ${commandOf(pid) || "读不到"} / cwd ${cwdOf(pid) || "读不到"}），当失效处理`,
      );
      unlinkSync(PID_FILE);
    } else {
      if (await stopFish(pid)) {
        try {
          unlinkSync(PID_FILE);
        } catch {}
      }
      handled = true;
    }
  } else {
    console.log(`[down] up.pid 内容不对（「${raw.slice(0, 40)}」），清掉`);
    unlinkSync(PID_FILE);
  }
} else {
  console.log(`[down] 没有 ${PID_FILE}，走 pgrep 兑底`);
}

// 2) 兑底：pgrep 兜住 pid 文件缺失 / 失效 / 没死透的漏网鱼
const leftovers = findFishByPgrep();
if (leftovers.length === 0) {
  console.log(handled ? "[down] 本仓库的鱼已全部停止" : "[down] 没有在跑的本仓库鱼进程");
  process.exit(0);
}
for (const pid of leftovers) {
  await stopFish(pid);
}
