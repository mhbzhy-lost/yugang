/**
 * 体检：把启动需要的东西挨个查一遍，缺什么直接说怎么补。
 *   npm run doctor
 */
import { DATA_HOME as HOME, REPO_ROOT } from "../src/paths.ts";
import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { Socket } from "node:net";
import { join, resolve } from "node:path";
import { newsTargetGroup, sixtyHealth } from "./lib/deps.ts";


const rows: [boolean, string, string][] = [];

function check(ok: boolean, label: string, fix: string): void {
  rows.push([ok, label, ok ? "" : fix]);
}

check(Number(process.versions.node.split(".")[0]) >= 22, `Node ${process.versions.node}`, "需要 Node 22+");
check(existsSync("node_modules"), "Node 依赖", "npm install");
const inContainer = process.env.YUGANG_CONTAINER === "1";
// 容器形态：env 由 compose env_file 注入，容器内**不存在 .env 文件**——那不是缺配置。
check(inContainer || existsSync(".env"), inContainer ? "env 已注入（compose env_file）" : ".env 存在", "cp .env.example .env");

const required = ["ONEBOT_WS_URL", "MASTER_QQ", "GROUPS"] as const;
for (const name of required) {
  check(Boolean(process.env[name]), `env ${name}`, "在 .env 里填上");
}
check(Boolean(process.env.ONEBOT_TOKEN), "env ONEBOT_TOKEN", "没设 token 也能跑，但本机其它进程能连进来");

const models = resolve("config/models.json");
check(existsSync(models), "config/models.json", "cp config/models.example.json config/models.json（本机配置，gitignore）");
check(existsSync(resolve("config/auth.json")), "config/auth.json", "npm run creds import");

// 容器形态：协议端是兄弟容器，本地没有 napcat 包；下面的 WS 可达性已覆盖它。
if (!inContainer) {
  const protocol = join(HOME, "protocol", "napcat");
  check(existsSync(join(protocol, "napcat.mjs")) || Boolean(process.env.PROTOCOL_CMD), "协议端安装", "npm run protocol install");
}

if (process.platform === "darwin") {
  check(existsSync("/Applications/QQ.app"), "QQ.app", "brew install --cask qq");
}

const ws = process.env.ONEBOT_WS_URL ?? "ws://127.0.0.1:3001";
const wsOk = await reachable(ws);
check(wsOk, `协议端 ${ws} 可达`, "先把协议端起起来并扫码登录");

// 新闻：只有配置了 targetGroup 才查 60s（开发机不需要）
if (newsTargetGroup().length > 0) {
  const base = process.env.SIXTY_BASE_URL ?? "http://127.0.0.1:4399";
  check(await sixtyHealth(base), `60s 新闻服务 ${base} 可达`, "npm run deps，或按 runbook 起 60s 容器");
}

// 视频抽帧依赖（可缺省：缺了只是没有画面描述，元信息仍可用）
check(spawnSync("ffmpeg", ["-version"]).status === 0, "ffmpeg（视频抽帧）", inContainer ? "镜像里装 ffmpeg" : "brew install ffmpeg");
const videoPython = process.env.VIDEO_PYTHON ?? join(process.env.HOME ?? "", "tts", ".venv-video", "bin", "python");
check(existsSync(videoPython), "video python（PyAV）", `装 venv 或设 VIDEO_PYTHON（当前 ${videoPython}）`);

// 图像后端：macOS 用系统 sips，其它平台（含容器）用 sharp worker。
// 缺了会**静默丢图**——模型看不到任何图片且不报错，所以必须体检。
if (process.platform === "darwin") {
  check(spawnSync("sips", ["--help"]).status === 0, "sips（图像压缩）", "macOS 自带，异常请检查系统");
} else {
  const sharpOk = spawnSync(process.execPath, ["-e", "require('sharp')"], { cwd: REPO_ROOT }).status === 0;
  check(sharpOk, "sharp（图像压缩）", "npm install sharp");
}

if (inContainer) {
  // comfy 端点只认 loopback（防 SSRF 的安全不变量），容器内靠 socat 转发到宿主机隧道。
  check(spawnSync("socat", ["-V"]).status === 0, "socat（ComfyUI 转发）", "镜像里装 socat");
  // HEIC 解码：sharp 预编译包没有 libde265，必须靠系统 heif-convert。
  // 缺了只会丢 iPhone 原图（HEIC），其它格式正常——正是需要体检才能发现的那类缺口。
  check(spawnSync("sh", ["-c", "command -v heif-convert"]).status === 0, "heif-convert（HEIC 解码）", "镜像里装 libheif-examples + libheif-plugin-libde265");
  check(await tcpReachable("127.0.0.1", 18190), "ComfyUI 127.0.0.1:18190（socat→宿主隧道）", "查 entrypoint 的 socat 与宿主机 SSH 隧道");
}

for (const [ok, label, fix] of rows) {
  console.log(`${ok ? "✓" : "✗"} ${label}${ok ? "" : `  ← ${fix}`}`);
}

const failed = rows.filter(([ok, , fix]) => !ok && fix).length;
console.log(failed === 0 ? "\n全都齐了，npm start" : `\n还有 ${failed} 项要补`);

async function tcpReachable(host: string, port: number): Promise<boolean> {
  return new Promise((done) => {
    const s = new Socket();
    const finish = (ok: boolean) => {
      s.destroy();
      done(ok);
    };
    s.setTimeout(2000);
    s.once("connect", () => finish(true));
    s.once("error", () => finish(false));
    s.once("timeout", () => finish(false));
    s.connect(port, host);
  });
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
    setTimeout(() => done(false), 2500).unref?.();
  });
}
