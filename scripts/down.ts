/**
 * 收掉 up / deploy 起的鱼：var/up.pid 是单一事实源（两个启动方都写它，见 scripts/lib/pidfile.ts）。
 * 协议端如果是外部起的不会动它。
 *   npm run down
 *
 * 顺序：读 up.pid → 严格核对进程身份 → TERM 优雅退（最多 16s，留时间 drain 完 outbox）→ 超时 KILL。
 * pid 文件缺失 / 陈旧 / 内容不对时扫描全部进程，但仍只认严格匹配的本仓库鱼。
 */
import { existsSync, readFileSync, unlinkSync } from "node:fs";
import { pidFilePath, findFishProcesses, fishProcessIdentity } from "./lib/pidfile.ts";

// 容器形态：收鱼由 docker compose stop 负责。本脚本依赖 lsof 取 cwd（macOS 无 /proc 的产物），
// slim 镜像里没有 lsof，跑下去只会得到误导性的「没找到鱼」。
if (process.env.YUGANG_CONTAINER === "1") {
  console.error("[down] ✗ 容器内不用本命令。在宿主机执行：docker compose stop fish");
  process.exit(1);
}

const PID_FILE = pidFilePath();
/** TERM 后给它多久优雅退（与 deploy 收旧鱼的 16s 一致），超时才 KILL */
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

/** TERM/KILL 前都重新核对，避免等待期间发生 PID 复用。 */
async function stopFish(pid: number): Promise<boolean> {
  if (!fishProcessIdentity(pid)) {
    if (!alive(pid)) {
      console.log(`[down] pid ${pid} 已经不在了`);
      return true;
    }
    console.error(`[down] ✗ pid ${pid} 身份已变化，拒绝发信号`);
    return false;
  }
  console.log(`[down] TERM pid ${pid}（最多等 ${Math.round(GRACE_MS / 1000)}s 优雅退）`);
  try {
    // 发 TERM 的瞬间再次核对（不要把上面的检查当作授权）。
    if (!fishProcessIdentity(pid)) {
      console.error(`[down] ✗ pid ${pid} TERM 前身份已变化，拒绝发信号`);
      return false;
    }
    process.kill(pid, "SIGTERM");
  } catch {
    if (!alive(pid)) {
      console.log(`[down] pid ${pid} 已经不在了`);
      return true;
    }
    console.error(`[down] ✗ pid ${pid} TERM 失败且进程仍在，拒绝继续`);
    return false;
  }
  const deadline = Date.now() + GRACE_MS;
  while (Date.now() < deadline) {
    if (!alive(pid)) {
      console.log(`[down] ✓ pid ${pid} 已退出`);
      return true;
    }
    if (!fishProcessIdentity(pid)) {
      console.error(`[down] ✗ pid ${pid} 等待期间身份已变化，拒绝继续发信号`);
      return false;
    }
    await sleep(250);
  }
  console.warn(`[down] pid ${pid} ${Math.round(GRACE_MS / 1000)}s 没退，KILL`);
  try {
    // KILL 前最后一次严格核对，防止 PID 已被别的进程复用。
    if (!fishProcessIdentity(pid)) {
      console.error(`[down] ✗ pid ${pid} KILL 前身份已变化，拒绝发信号`);
      return false;
    }
    process.kill(pid, "SIGKILL");
  } catch {
    if (!alive(pid)) return true; // KILL 前刚好自己退了
    console.error(`[down] ✗ pid ${pid} KILL 失败且进程仍在`);
    return false;
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
  // 与 deploy 同一套可信规则：只认十进制安全整数，0x10 / 1e3 / 超大数一律当无效。
  const pid = /^\d+$/.test(raw) ? Number(raw) : NaN;
  if (Number.isSafeInteger(pid) && pid > 0) {
    if (!alive(pid)) {
      console.log(`[down] up.pid 里的 pid ${pid} 已经不在了，清掉陈旧文件`);
      unlinkSync(PID_FILE);
    } else if (!fishProcessIdentity(pid)) {
      console.log(`[down] up.pid 里的 pid ${pid} 不是本仓库的鱼，清掉失效文件`);
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
  console.log(`[down] 没有 ${PID_FILE}，扫描严格匹配的鱼进程`);
}

// 2) 兜底：兜住 pid 文件缺失 / 失效 / 没死透的漏网鱼
const leftovers = findFishProcesses();
if (leftovers.length === 0) {
  console.log(handled ? "[down] 本仓库的鱼已全部停止" : "[down] 没有在跑的本仓库鱼进程");
  process.exit(0);
}
for (const fish of leftovers) {
  await stopFish(fish.pid);
}
