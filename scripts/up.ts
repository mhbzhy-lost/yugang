/**
 * 一条命令把需要的都拉起来：
 *   npm run up
 *
 * 顺序：体检 → （可选）拉起协议端 → 等 WS 可用（提示扫码）→ 起鱼。
 * Ctrl-C 会把本次拉起的进程一起收掉。
 *
 * 想让它顺手拉起协议端，就在 .env 里写：
 *   PROTOCOL_CMD=npm --prefix ~/napcat start     # 任何能起 OneBot v11 服务的命令
 */
import { REPO_ROOT } from "../src/paths.ts";
import { spawn, spawnSync } from "node:child_process";
import { existsSync, unlinkSync } from "node:fs";
import { join } from "node:path";
import { pidFilePath, recordFishPid } from "./lib/pidfile.ts";
import { ensureSixtyService, newsTargetGroup } from "./lib/deps.ts";

const wsUrl = process.env.ONEBOT_WS_URL ?? "ws://127.0.0.1:3001";
const PID_FILE = pidFilePath(); // 与 deploy 写同一个 var/up.pid；Ctrl-C / 鱼退出时清掉

const children: ReturnType<typeof spawn>[] = [];
let stopping = false;

if (!process.env.MASTER_QQ) {
  console.error("先填 MASTER_QQ（.env），否则私聊都会被当成陌生人");
  process.exit(1);
}

// 容器形态：协议端是兄弟容器、TTS 在宿主机，两者都不该由鱼拉。
const inContainer = process.env.YUGANG_CONTAINER === "1";

// 容器内直接拒绝（2026-11-14）：旧实现只「跳过」协议端与 TTS，却仍会再 spawn 一条
// `node src/index.ts`——`docker compose exec fish npm run up` 就能在同一个容器里凑出
// 两条鱼共享 /data/fish.db，pi-durable 的 id 计数器必然撞号。鱼的启动由 entrypoint 负责。
if (inContainer) {
  console.error("[up] ✗ 容器内不跑 up。鱼由 entrypoint 启动，重启用：");
  console.error("     docker compose restart fish        （在宿主机执行）");
  console.error("     看日志：docker compose logs -f fish");
  process.exit(1);
}

// 宿主机侧护栏：容器鱼在跑时绝不能再起一条宿主鱼。
// pi-durable 的 id 计数器是进程内存值，两条鱼写同一 SQLite 必然撞号（AGENTS.md 第 16 条）。
// 容器形态下 ./var 就是宿主 var，两边指的是同一个库。
if (!inContainer) {
  const dockerBin = ["/usr/local/bin/docker", "/opt/homebrew/bin/docker"].find((p) => existsSync(p));
  if (dockerBin) {
    const ps = spawnSync(dockerBin, ["ps", "--filter", "name=yugang-fish", "--format", "{{.Names}}"], { encoding: "utf8", timeout: 8000 });
    const names = (ps.stdout ?? "").trim();
    if (ps.status === 0 && names !== "") {
      console.error(`[up] ✗ 容器鱼在跑（${names}），拒绝在宿主机再起一条。`);
      console.error("     看日志：docker compose logs -f fish");
      console.error("     要回宿主形态：先 docker compose down，再跑本命令。");
      process.exit(1);
    }
  }
}

// 1. 协议端
if (!inContainer && process.env.PROTOCOL_CMD && !(await reachable(wsUrl))) {
  console.log(`[up] 拉起协议端：${process.env.PROTOCOL_CMD}`);
  const child = spawn(process.env.PROTOCOL_CMD, { shell: true, stdio: "inherit" });
  children.push(child);
}

// 2. 等 WS
if (!(await reachable(wsUrl))) {
  console.log(`[up] 等协议端在 ${wsUrl} 就绪…`);
  console.log("[up] 如果协议端还没登录，现在去扫码（NapCat WebUI 通常在 :5099）");
  const ok = await waitFor(wsUrl, 300_000);
  if (!ok) {
    console.error("[up] 等不到协议端。跑 npm run doctor 看差什么");
    await stop(1);
  }
  console.log("[up] 协议端就绪");
} else {
  console.log("[up] 协议端已经在线");
}

// 3. 新闻依赖：60s 只在配置了 news.targetGroup 时 ensure；失败告警不阻塞
if (newsTargetGroup().length > 0) {
  const sixty = await ensureSixtyService();
  if (!sixty) console.warn("[up] ⚠ 60s 新闻服务未就绪，新闻会按单源降级");
}

// 4. 起鱼
console.log("[up] 启动鱼缸");
const fish = spawn(process.execPath, ["--env-file-if-exists=.env", join(REPO_ROOT, "src", "index.ts")], { cwd: REPO_ROOT, stdio: "inherit" });
children.push(fish);
recordFishPid(fish.pid); // 与 deploy 写同一个 var/up.pid（单一事实源，down 读它收鱼）

// 5. 语音跟随：与起鱼并行拉起 TTS 实例（模型加载要 30-60s）；失败只告警，不阻塞鱼。
//    容器形态跳过：TTS 靠宿主机 launchd + MPS 加速，容器里没有 launchctl 也拿不到 Metal。
if (!inContainer) {
  const tts = spawn(process.execPath, [join(import.meta.dirname, "tts.ts"), "up"], { stdio: "inherit" });
  tts.on("exit", (code) => {
    if (code !== 0) console.warn(`[up] ⚠ 语音拉起未完全成功（tts up 退出码 ${code}），鱼不受影响`);
  });
}

process.on("SIGINT", () => void stop(0));
process.on("SIGTERM", () => void stop(0));
fish.on("exit", (code) => void stop(code ?? 0));

async function stop(code: number): Promise<void> {
  if (stopping) return;
  stopping = true;
  for (const child of children) {
    if (child.exitCode === null) child.kill("SIGTERM");
  }
  try {
    if (existsSync(PID_FILE)) unlinkSync(PID_FILE);
  } catch {}
  setTimeout(() => process.exit(code), 300).unref?.();
}

function waitFor(url: string, timeoutMs: number): Promise<boolean> {
  const started = Date.now();
  return new Promise((resolve) => {
    const tick = async () => {
      if (stopping) return resolve(false);
      if (await reachable(url)) return resolve(true);
      if (Date.now() - started > timeoutMs) return resolve(false);
      setTimeout(tick, 2000).unref?.();
    };
    void tick();
  });
}

function reachable(url: string): Promise<boolean> {
  return new Promise((resolve) => {
    const ws = new WebSocket(url);
    const done = (ok: boolean) => {
      try {
        ws.close();
      } catch {}
      resolve(ok);
    };
    ws.addEventListener("open", () => done(true), { once: true });
    ws.addEventListener("error", () => done(false), { once: true });
    setTimeout(() => done(false), 2500).unref?.();
  });
}
