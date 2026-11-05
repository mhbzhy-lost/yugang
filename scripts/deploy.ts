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
import { recordFishPid } from "./lib/pidfile.ts";
import { DATA_HOME, REPO_ROOT } from "../src/paths.ts";

const LOG = join(DATA_HOME, "fish-console.log");

// 1. 拉代码；失败就停手，线上继续跑旧代码
console.log("[deploy] git pull origin main");
const pull = spawnSync("git", ["pull", "origin", "main"], { stdio: "inherit" });
if (pull.status !== 0) {
  console.error("[deploy] ✗ git pull 失败，不动线上");
  process.exit(1);
}

// 2. 前置依赖：Node 依赖（package-lock 变了才装）与 60s 新闻服务自愈。
//    用新起进程跑 scripts/deps.ts：deploy 自己是 pull 之前加载的旧代码，只有新进程
//    才能读到刚拉下来的前置逻辑。放在收旧鱼之前：依赖失败时线上继续跑旧代码。
console.log("[deploy] 前置依赖检查（Node 依赖 + 60s）");
const preflight = spawnSync(process.execPath, ["--env-file-if-exists=.env", join(import.meta.dirname, "deps.ts")], {
  stdio: "inherit",
});
if (preflight.status === 1) {
  console.error("[deploy] ✗ Node 依赖安装失败，不动线上");
  process.exit(1);
}
if (preflight.status === 2) {
  console.warn("[deploy] ⚠ 60s 新闻服务未就绪，新闻会按单源降级（不影响鱼启动）");
}

// 3. 收旧鱼：先 SIGTERM 让它优雅退出（drain 完 outbox 再关），最多等 16s，超时强杀
spawnSync("pkill", ["-f", "src/index.ts"]);
for (let i = 0; i < 32; i++) {
  if (spawnSync("pgrep", ["-f", "src/index.ts"]).status !== 0) break;
  await new Promise((r) => setTimeout(r, 500));
}
spawnSync("pkill", ["-9", "-f", "src/index.ts"]);
await new Promise((r) => setTimeout(r, 3000));

// 4. 起新鱼：日志追加到 var/fish-console.log，脱离本进程生命周期
const log = openSync(LOG, "a");
const fish = spawn(process.execPath, ["--env-file-if-exists=.env", join(REPO_ROOT, "src", "index.ts")], {
  cwd: REPO_ROOT,
  detached: true,
  stdio: ["ignore", log, log],
});
fish.unref();
closeSync(log);
recordFishPid(fish.pid); // 与 up 写同一个 var/up.pid（单一事实源）：否则 npm run down 认不得 deploy 起的鱼
console.log(`[deploy] 新鱼 pid ${fish.pid}，日志 ${LOG}`);

// 5. 语音跟随：与横幅验证并行拉起 TTS 实例；失败只告警，不影响部署结论
const tts = spawn(process.execPath, [join(import.meta.dirname, "tts.ts"), "up"], { stdio: "inherit" });
const ttsExit = new Promise<number | null>((resolve) => tts.once("exit", (code) => resolve(code)));

// 6. 验证：活过 8 秒且打出「已连接」横幅
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
const ttsCode = await Promise.race([
  ttsExit,
  new Promise<null>((r) => setTimeout(() => r(null), 120_000).unref?.()),
]);
if (ttsCode === 0) console.log("[deploy] ✓ 语音实例就绪");
else console.warn(`[deploy] ⚠ 语音拉起未完全成功（tts up 退出码 ${ttsCode}），鱼不受影响；稍后 npm run tts status 复查`);
