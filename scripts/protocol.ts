/**
 * 协议端（QQ 侧）的安装与检查。
 *
 *   npm run protocol install    # 下载 NapCat 到 var/protocol/napcat 并写好 OneBot 配置
 *   npm run protocol status     # 装了没、QQ 在不在、WS 通不通
 *
 * macOS 的现实：NapCat 的 Mac 包只有框架（native 模块齐全），没有启动脚本，
 * 需要挂进已安装的 QQ。这一步是 GUI 操作 + 扫码，脚本只能把包准备好。
 */
import { execFileSync, spawnSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

const HOME = process.env.YUGANG_HOME ?? join(homedir(), "鱼缸", "var");
const PROTOCOL_DIR = join(HOME, "protocol", "napcat");
const [command = "status"] = process.argv.slice(2);

const wsUrl = process.env.ONEBOT_WS_URL ?? "ws://127.0.0.1:3001";
const token = process.env.ONEBOT_TOKEN ?? "";
const port = Number(new URL(wsUrl).port || 3001);

if (command === "install") {
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

  writeOneBotConfig();
  printNextSteps();
} else if (command === "status") {
  const installed = existsSync(join(PROTOCOL_DIR, "napcat.mjs"));
  console.log(`协议端目录   ${installed ? PROTOCOL_DIR : "（未安装，跑 npm run protocol install）"}`);
  if (process.platform === "darwin") {
    console.log(`QQ.app       ${existsSync("/Applications/QQ.app") ? "已安装" : "没装（brew install --cask qq）"}`);
  }
  const ws = await reachable(wsUrl);
  console.log(`WS ${wsUrl}  ${ws ? "可达（说明协议端已登录并在监听）" : "不可达"}`);
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

function download(url: string, dest: string): void {
  const res = spawnSync("curl", ["-L", "--fail", "--max-time", "600", "-o", dest, url], { stdio: "inherit" });
  if (res.status !== 0) throw new Error(`下载失败：${url}`);
}

function writeOneBotConfig(): void {
  const file = join(PROTOCOL_DIR, "config", "onebot.json");
  mkdirSync(join(PROTOCOL_DIR, "config"), { recursive: true });
  const config = {
    network: {
      websocketServers: [
        {
          name: "yugang",
          enable: true,
          host: "127.0.0.1",
          port,
          messagePostFormat: "array",
          token,
          reportSelfMessage: false,
          heartInterval: 30000,
          debug: false,
          enableForcePushEvent: false,
        },
      ],
    },
    musicSignUrl: "",
    enableLocalFile2Url: false,
    parseMultMsg: true,
  };
  writeFileSync(file, `${JSON.stringify(config, null, 2)}\n`);
  console.log(`✓ 已写 ${file}`);
  console.log(`  host 127.0.0.1:${port} · token ${token ? "已设置" : "空"} · reportSelfMessage false`);
}

function printNextSteps(): void {
  console.log("\n下一步：");
  if (process.platform === "darwin") {
    console.log("  1. 安装 Mac 版 QQ：brew install --cask qq");
    console.log("  2. 装 LiteLoaderQQNT：");
    console.log('     curl -L "https://github.com/Mzdyl/LiteLoaderQQNT_Install/releases/latest/download/install_mac.sh" -o /tmp/ll.sh && bash /tmp/ll.sh');
    console.log(`  3. 把 ${PROTOCOL_DIR} 作为插件目录放进 LiteLoader 的 plugins/`);
    console.log("  4. 启动 QQ，扫码登录鱼号，NapCat 会在 5099 起 WebUI");
  } else {
    console.log("  启动 NapCat 后用鱼号扫码登录");
  }
  console.log(`  5. 回来跑 npm run probe，通了再 npm start`);
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
