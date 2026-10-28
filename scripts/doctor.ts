/**
 * 体检：把启动需要的东西挨个查一遍，缺什么直接说怎么补。
 *   npm run doctor
 */
import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";

const HOME = process.env.YUGANG_HOME ?? join(homedir(), "鱼缸", "var");
const rows: [boolean, string, string][] = [];

function check(ok: boolean, label: string, fix: string): void {
  rows.push([ok, label, ok ? "" : fix]);
}

check(Number(process.versions.node.split(".")[0]) >= 22, `Node ${process.versions.node}`, "需要 Node 22+");
check(existsSync(".env"), ".env 存在", "cp .env.example .env");

const required = ["ONEBOT_WS_URL", "MASTER_QQ", "GROUPS"] as const;
for (const name of required) {
  check(Boolean(process.env[name]), `env ${name}`, "在 .env 里填上");
}
check(Boolean(process.env.ONEBOT_TOKEN), "env ONEBOT_TOKEN", "没设 token 也能跑，但本机其它进程能连进来");

const models = resolve(process.env.YUGANG_MODELS ?? "config/models.json");
check(existsSync(models), "config/models.json", "仓库里应该有；是不是在别的目录跑的？");
check(existsSync(resolve("config/auth.json")), "config/auth.json", "npm run creds import");

const protocol = join(HOME, "protocol", "napcat");
check(existsSync(join(protocol, "napcat.mjs")) || Boolean(process.env.PROTOCOL_CMD), "协议端安装", "npm run protocol install");

if (process.platform === "darwin") {
  check(existsSync("/Applications/QQ.app"), "QQ.app", "brew install --cask qq");
}

const ws = process.env.ONEBOT_WS_URL ?? "ws://127.0.0.1:3001";
const wsOk = await reachable(ws);
check(wsOk, `协议端 ${ws} 可达`, "先把协议端起起来并扫码登录");

for (const [ok, label, fix] of rows) {
  console.log(`${ok ? "✓" : "✗"} ${label}${ok ? "" : `  ← ${fix}`}`);
}

const failed = rows.filter(([ok, , fix]) => !ok && fix).length;
console.log(failed === 0 ? "\n全都齐了，npm start" : `\n还有 ${failed} 项要补`);

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
