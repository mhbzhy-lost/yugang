/**
 * 生成 OneBot token 并同步到 .env 与 NapCat 配置。
 *
 *   npm run token
 *
 * 32 字节随机（base64url，43 字符），只打印长度不打印内容——它和 key 一样是凭据。
 */
import { randomBytes } from "node:crypto";
import { chmodSync, existsSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { writeOneBotConfig } from "./lib/onebot-config.ts";

const token = randomBytes(32).toString("base64url");

const envPath = ".env";
if (!existsSync(envPath)) {
  console.error("没有 .env；先 cp .env.example .env");
  process.exit(1);
}

const env = readFileSync(envPath, "utf8");
const next = /^ONEBOT_TOKEN=.*$/m.test(env)
  ? env.replace(/^ONEBOT_TOKEN=.*$/m, `ONEBOT_TOKEN=${token}`)
  : `${env.trimEnd()}\nONEBOT_TOKEN=${token}\n`;
writeFileSync(envPath, next, { mode: 0o600 });
chmodSync(envPath, 0o600); // 已有文件不会被 mode 改到，显式来一下
console.log(`✓ 已写入 .env（${token.length} 字符，未打印内容）`);

const protocolDir =
  process.platform === "darwin"
    ? join(homedir(), "Library", "Containers", "com.tencent.qq", "Data", "Documents", "napcat")
    : join(process.env.YUGANG_HOME ?? join(homedir(), "鱼缸", "var"), "protocol", "napcat");
if (existsSync(protocolDir)) {
  const wsUrl = process.env.ONEBOT_WS_URL ?? "ws://127.0.0.1:3001";
  const port = Number(new URL(wsUrl).port || 3001);
  const file = writeOneBotConfig({ dir: protocolDir, port, token });
  console.log(`✓ 已同步到 ${file}`);
  console.log("  协议端要重启才会读新配置");
} else {
  console.log("  协议端目录还没建，之后跑 npm run protocol install 会带上这个 token");
}
