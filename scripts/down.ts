/**
 * 收掉 npm run up 起的东西（用 pid 文件；协议端如果是外部起的不会动它）。
 *   npm run down
 */
import { existsSync, readFileSync, unlinkSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

const HOME = process.env.YUGANG_HOME ?? join(homedir(), "鱼缸", "var");
const pidFile = join(HOME, "up.pid");

if (!existsSync(pidFile)) {
  console.log("没有 up.pid，可能还没用 npm run up 起过");
  process.exit(0);
}

const pid = Number(readFileSync(pidFile, "utf8").trim());
if (!Number.isFinite(pid)) {
  console.error("up.pid 内容不对");
  process.exit(1);
}

try {
  process.kill(pid, "SIGTERM");
  console.log(`✓ 已停止 pid ${pid}`);
} catch {
  console.log(`pid ${pid} 已经不在了`);
}
unlinkSync(pidFile);
