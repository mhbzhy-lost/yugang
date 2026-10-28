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
import { spawn } from "node:child_process";
import { writeFileSync, existsSync, unlinkSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

const HOME = process.env.YUGANG_HOME ?? join(homedir(), "鱼缸", "var");
const PID_FILE = join(HOME, "up.pid");
const wsUrl = process.env.ONEBOT_WS_URL ?? "ws://127.0.0.1:3001";

const children: ReturnType<typeof spawn>[] = [];
let stopping = false;

if (!process.env.MASTER_QQ) {
  console.error("先填 MASTER_QQ（.env），否则私聊都会被当成陌生人");
  process.exit(1);
}

// 1. 协议端
if (process.env.PROTOCOL_CMD && !(await reachable(wsUrl))) {
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

// 3. 起鱼
console.log("[up] 启动鱼缸");
const fish = spawn(process.execPath, ["--env-file-if-exists=.env", "src/index.ts"], { stdio: "inherit" });
children.push(fish);
writeFileSync(PID_FILE, String(fish.pid ?? ""));

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
