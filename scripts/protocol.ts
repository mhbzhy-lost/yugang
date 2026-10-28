/**
 * 协议端（QQ 侧）的安装与检查。
 *
 *   npm run protocol install    # 下载 NapCat 到 var/protocol/napcat 并写好 OneBot 配置
 *   npm run protocol status     # 装了没、QQ 在不在、WS 通不通
 *   npm run protocol start      # QQ 没跑就无头拉起（-q 鱼号），然后等登录就绪
 *   npm run protocol stop       # 给 QQ 主进程发 SIGTERM，优雅退出
 *
 * macOS 的现实：NapCat 的 Mac 包只有框架（native 模块齐全），没有启动脚本，
 * 需要挂进已安装的 QQ。这一步是 GUI 操作 + 扫码，脚本只能把包准备好。
 */
import { execFileSync, spawn, spawnSync } from "node:child_process";
import { chmodSync, closeSync, existsSync, mkdirSync, openSync, readFileSync } from "node:fs";
import { discoverUin, napcatConfigDir, writeOneBotConfig as writeConfig } from "./lib/onebot-config.ts";
import { withAccessToken } from "../src/qq/onebot.ts";
import { homedir } from "node:os";
import { join } from "node:path";

const HOME = process.env.YUGANG_HOME ?? join(homedir(), "鱼缸", "var");
const QQ_BIN = "/Applications/QQ.app/Contents/MacOS/QQ";

/**
 * NapCat 实际读配置的位置随平台不同（目录解析在 onebot-config.ts）：
 *  macOS：QQ 容器的 Application Support/QQ/NapCat/config（per-uin，登录后才有）
 *  其它平台用我们解压出来的 Shell 包
 */
const PROTOCOL_DIR = join(HOME, "protocol", "napcat");
const CONFIG_DIR = napcatConfigDir(PROTOCOL_DIR);
const [command = "status"] = process.argv.slice(2);

const wsUrl = process.env.ONEBOT_WS_URL ?? "ws://127.0.0.1:3001";
const token = process.env.ONEBOT_TOKEN ?? "";
const port = Number(new URL(wsUrl).port || 3001);

if (command === "install") {
  if (process.platform === "darwin") {
    let file: string;
    try {
      file = writeOneBotConfig();
    } catch (err) {
      console.error(err instanceof Error ? err.message : err);
      process.exit(1);
    }
    printNextSteps(file);
    process.exit(0);
  }

  mkdirSync(PROTOCOL_DIR, { recursive: true });
  if (!existsSync(join(PROTOCOL_DIR, "napcat.mjs"))) {
    const tag = latestTag();
    const asset = "NapCat.Shell.zip";
    const url = `https://github.com/NapNeko/NapCatQQ/releases/download/${tag}/${asset}`;
    console.log(`下载 ${tag} / ${asset} …`);
    download(url, join(PROTOCOL_DIR, "shell.zip"));
    execFileSync("unzip", ["-oq", join(PROTOCOL_DIR, "shell.zip"), "-d", PROTOCOL_DIR], { stdio: "inherit" });
    console.log(`✓ 解压到 ${PROTOCOL_DIR}`);
  } else {
    console.log(`✓ 已经有 ${PROTOCOL_DIR}`);
  }

  printNextSteps(writeOneBotConfig());
} else if (command === "status") {
  const installed =
    process.platform === "darwin" ? existsSync(CONFIG_DIR) : existsSync(join(PROTOCOL_DIR, "napcat.mjs"));
  console.log(
    `协议端目录   ${installed ? CONFIG_DIR : "（未就绪，先登录一次 QQ 再跑 npm run protocol install）"}`,
  );
  if (process.platform === "darwin") {
    console.log(`QQ.app       ${existsSync("/Applications/QQ.app") ? "已安装" : "没装（brew install --cask qq）"}`);
  }
  const ws = await reachable(wsUrl);
  console.log(`WS ${wsUrl}  ${ws ? "可达（说明协议端已登录并在监听）" : "不可达"}`);
} else if (command === "start") {
  if (process.platform !== "darwin") {
    console.error("✗ protocol start 暂不支持 " + process.platform + "（只做了 macOS）");
    process.exit(1);
  }
  const uin = requireProtocolQq();
  if (!existsSync(QQ_BIN)) {
    console.error(`✗ 没找到 ${QQ_BIN}，先装 QQ（brew install --cask qq）`);
    process.exit(1);
  }
  if (spawnSync("pgrep", ["-x", "QQ"], { encoding: "utf8" }).status === 0) {
    console.log("QQ 已经在跑，直接等登录就绪…");
  } else {
    const logDir = join(HOME, "protocol");
    mkdirSync(logDir, { recursive: true });
    const logPath = join(logDir, "qq-console.log");
    // 等价于：nohup QQ --no-sandbox -q <uin> >> <HOME>/protocol/qq-console.log 2>&1 &
    const log = openSync(logPath, "a");
    spawn(QQ_BIN, ["--no-sandbox", "-q", uin], { detached: true, stdio: ["ignore", log, log] }).unref();
    closeSync(log);
    console.log(`已拉起 QQ（无头，-q ${uin}），日志 ${logPath}`);
  }
  await waitUntilOnline(uin);
} else if (command === "stop") {
  if (process.platform !== "darwin") {
    console.error("✗ protocol stop 暂不支持 " + process.platform + "（只做了 macOS）");
    process.exit(1);
  }
  const pids = qqPids();
  if (pids.length === 0) {
    console.log("QQ 本来就没在跑");
    process.exit(0);
  }
  const main = mainPid(pids);
  process.kill(main, "SIGTERM");
  console.log(`已向 QQ 主进程 ${main} 发 SIGTERM，等它退出…`);
  const deadline = Date.now() + 10_000;
  while (Date.now() < deadline) {
    if (qqPids().length === 0) {
      console.log("✓ QQ 已退出");
      process.exit(0);
    }
    await sleep(500);
  }
  console.error(`✗ 10 秒了还没退干净，手动处理：看 ps aux | grep QQ，必要时 pkill -x QQ`);
  process.exit(1);
} else {
  console.error(`不认识的命令：${command}`);
  process.exit(1);
}

function latestTag(): string {
  const out = spawnSync(
    "curl",
    ["-sIL", "--max-time", "20", "-o", "/dev/null", "-w", "%{url_effective}", "https://github.com/NapNeko/NapCatQQ/releases/latest"],
    { encoding: "utf8" },
  ).stdout;
  const tag = out.trim().split("/tag/").pop();
  if (!tag) throw new Error("拿不到 NapCat 最新版本号（网络？）");
  return tag;
}

function requireProtocolQq(): string {
  const uin = process.env.PROTOCOL_QQ?.trim();
  if (!uin) {
    console.error("✗ 缺少 PROTOCOL_QQ（鱼号）。在 .env 里加一行：PROTOCOL_QQ=<鱼号的QQ号>");
    process.exit(1);
  }
  return uin;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms).unref?.());
}

function qqPids(): number[] {
  const out = spawnSync("pgrep", ["-x", "QQ"], { encoding: "utf8" });
  if (out.status !== 0) return [];
  return out.stdout.split("\n").filter(Boolean).map(Number);
}

/** 主进程 = 父进程不在 QQ 进程堆里的那个（其余是它拉起的辅助进程）；认不出来就取最小的 pid。 */
function mainPid(pids: number[]): number {
  const set = new Set(pids);
  for (const pid of pids) {
    const ppid = Number(spawnSync("ps", ["-o", "ppid=", "-p", String(pid)], { encoding: "utf8" }).stdout.trim());
    if (!set.has(ppid)) return pid;
  }
  return Math.min(...pids);
}

/** 轮询最多 90s：WS（query 鉴权）拿到 get_login_info 且 uin 对上就算就绪；日志里出现验证提示则提前报错。 */
async function waitUntilOnline(uin: string): Promise<void> {
  const logPath = join(HOME, "protocol", "qq-console.log");
  const deadline = Date.now() + 90_000;
  while (Date.now() < deadline) {
    if (await loginIs(uin)) {
      console.log(`✓ 鱼号 ${uin} 已在线`);
      return;
    }
    if (logTail(logPath).includes("登录需要手Q验证")) {
      console.error(`✗ 登录需要手Q验证：打开 ${logPath}，用鱼号扫里面的二维码，完了再跑一次本命令`);
      process.exit(1);
    }
    await sleep(2000);
  }
  console.error(`✗ 90 秒内未就绪，查看日志：${logPath}`);
  process.exit(1);
}

/** 一次 get_login_info：登录的是不是这个 uin。连不上 / 超时 / 3 秒没回都算否。 */
async function loginIs(uin: string): Promise<boolean> {
  return new Promise((resolve) => {
    const ws = new WebSocket(token ? withAccessToken(wsUrl, token) : wsUrl);
    let done = false;
    const finish = (ok: boolean) => {
      if (done) return;
      done = true;
      try {
        ws.close();
      } catch {}
      resolve(ok);
    };
    ws.addEventListener("open", () => ws.send(JSON.stringify({ action: "get_login_info", params: {}, echo: "s" })));
    ws.addEventListener("message", (event) => {
      const frame = JSON.parse(String(event.data)) as { echo?: string; data?: { user_id?: number } };
      if (frame.echo === "s") finish(String(frame.data?.user_id ?? "") === uin);
    });
    ws.addEventListener("error", () => finish(false), { once: true });
    setTimeout(() => finish(false), 3000).unref?.();
  });
}

function logTail(path: string): string {
  return spawnSync("tail", ["-c", "4096", path], { encoding: "utf8" }).stdout ?? "";
}

function download(url: string, dest: string): void {
  const res = spawnSync("curl", ["-L", "--fail", "--max-time", "600", "-o", dest, url], { stdio: "inherit" });
  if (res.status !== 0) throw new Error(`下载失败：${url}`);
}

function writeOneBotConfig(): string {
  const file = writeConfig({ dir: PROTOCOL_DIR, port, token });
  const uin = discoverUin(CONFIG_DIR);
  console.log(`✓ 已写 ${file}（uin ${uin}）`);
  console.log(`  host 127.0.0.1:${port} · token ${token ? "已设置" : "空"} · reportSelfMessage false`);
  return file;
}

function printNextSteps(file: string): void {
  console.log("\n下一步：");
  if (process.platform === "darwin") {
    console.log("  1. QQ 已登录的话，重启 QQ 让 NapCat 读新配置（重启由主会话安排）");
    console.log("     还没装 NapCat 时：打开 ~/Downloads/NapCatInstaller/NapCatInstaller.app");
    console.log("     选版本 → 安装 → 切换程序入口 NapCat → 用鱼号扫码登录");
    console.log("     （被系统拒绝时，去 系统设置 → 隐私与安全性 → App 管理 里放行）");
    console.log(`  配置就位：${file}`);
    console.log("  2. 回来跑 npm run probe，通了再 npm run up");
  } else {
    console.log("  启动 NapCat 后用鱼号扫码登录");
    console.log("  回来跑 npm run probe，通了再 npm run up");
  }
}

async function reachable(url: string): Promise<boolean> {
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
    setTimeout(() => done(false), 3000).unref?.();
  });
}

void readFileSync;
void chmodSync;
