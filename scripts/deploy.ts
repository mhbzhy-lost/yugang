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
import { closeSync, openSync } from "node:fs";
import { join } from "node:path";

const LOG = join(process.cwd(), "var", "fish-console.log");

// 1. 拉代码；失败就停手，线上继续跑旧代码
console.log("[deploy] git pull origin main");
const pull = spawnSync("git", ["pull", "origin", "main"], { stdio: "inherit" });
if (pull.status !== 0) {
  console.error("[deploy] ✗ git pull 失败，不动线上");
  process.exit(1);
}

// 2. 收旧鱼：先 SIGTERM 让它优雅退出（drain 完 outbox 再关），最多等 16s，超时强杀
spawnSync("pkill", ["-f", "src/index.ts"]);
for (let i = 0; i < 32; i++) {
  if (spawnSync("pgrep", ["-f", "src/index.ts"]).status !== 0) break;
  await new Promise((r) => setTimeout(r, 500));
}
spawnSync("pkill", ["-9", "-f", "src/index.ts"]);
await new Promise((r) => setTimeout(r, 3000));

// 3. 起新鱼：日志追加到 var/fish-console.log，脱离本进程生命周期
const log = openSync(LOG, "a");
const fish = spawn(process.execPath, ["--use-env-proxy", "--env-file-if-exists=.env", "src/index.ts"], {
  detached: true,
  stdio: ["ignore", log, log],
});
fish.unref();
closeSync(log);
console.log(`[deploy] 新鱼 pid ${fish.pid}，日志 ${LOG}`);

// 4. 验证：活过 8 秒且打出「已连接」横幅
await new Promise((r) => setTimeout(r, 8000));
const alive = spawnSync("ps", ["-p", String(fish.pid)], { encoding: "utf8" });
const tail = spawnSync("tail", ["-30", LOG], { encoding: "utf8" }).stdout ?? "";
if (alive.status !== 0 || !tail.includes("已连接")) {
  console.error("[deploy] ✗ 新鱼没起来或没有「已连接」横幅，最近日志：");
  console.error(tail.trim());
  process.exit(1);
}
console.log("[deploy] ✓ 存活，横幅：");
for (const line of tail.trim().split("\n").reverse()) {
  if (line.includes("已连接") || line.includes("凭据")) console.log(`  ${line}`);
}
