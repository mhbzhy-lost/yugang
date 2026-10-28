/**
 * 把 .env 里的 WS 设置写进 NapCat 的 onebot11_<uin>.json。
 * protocol.ts 和 token.ts 都用这一份，避免两处配置漂移。
 *
 * NapCat 实际读的配置目录（实测 NapCat 4.18.41）：
 *   macOS: ~/Library/Containers/com.tencent.qq/Data/Library/Application Support/QQ/NapCat/config/
 *   其它（我们解压的 Shell 包）: <协议端目录>/config/
 * 配置文件按 uin 一份（napcat_<uin>.json / onebot11_<uin>.json），
 * uin 只有登录过才有，所以从目录里现场发现；发现不了就报可操作的错误，不猜。
 */
import { existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

export interface OneBotConfigInput {
  /** 协议端根目录；仅非 macOS 用（macOS 一律写 QQ 容器里的真实配置目录） */
  dir?: string;
  port: number;
  token: string;
}

const NAPCAT_FILE = /^napcat_(\d+)\.json$/;
const ONEBOT_FILE = /^onebot11_(\d+)\.json$/;

/** NapCat 真实配置目录（darwin 是 QQ 容器里的 Application Support，其余是 Shell 包目录下的 config/） */
export function napcatConfigDir(protocolDir = ""): string {
  if (process.platform === "darwin") {
    return join(
      homedir(),
      "Library",
      "Containers",
      "com.tencent.qq",
      "Data",
      "Library",
      "Application Support",
      "QQ",
      "NapCat",
      "config",
    );
  }
  return join(protocolDir, "config");
}

/** 从配置目录发现已登录过的 uin（napcat_<uin>.json 优先，多个取最近动过的那个） */
export function discoverUin(configDir: string): string {
  let names: string[];
  try {
    names = readdirSync(configDir);
  } catch {
    throw new Error(
      `NapCat 配置目录不存在：${configDir}\n` +
        "先启动 QQ 并用鱼号登录一次，让 NapCat 生成 per-uin 配置文件，然后再跑一次本命令。",
    );
  }
  const seen = new Map<string, number>(); // uin → 配置文件最近修改时间
  for (const name of names) {
    const uin = NAPCAT_FILE.exec(name)?.[1] ?? ONEBOT_FILE.exec(name)?.[1];
    if (uin) seen.set(uin, statSync(join(configDir, name)).mtimeMs);
  }
  if (seen.size === 0) {
    throw new Error(
      `${configDir}\n里没有 napcat_<uin>.json / onebot11_<uin>.json。\n` +
        "先启动 QQ 并用鱼号登录一次，让 NapCat 生成 per-uin 配置文件，然后再跑一次本命令。",
    );
  }
  return [...seen.entries()].sort((a, b) => b[1] - a[1])[0][0];
}

/** 文件不存在时按 NapCat 生成的默认骨架兜底（字段照抄实测默认值） */
function napcatSkeleton(): Record<string, unknown> {
  return {
    network: {
      httpServers: [],
      httpSseServers: [],
      httpClients: [],
      websocketServers: [],
      websocketClients: [],
      plugins: [],
    },
    musicSignUrl: "",
    enableLocalFile2Url: false,
    parseMultMsg: false,
    imageDownloadProxy: "",
    timeout: { baseTimeout: 10000, uploadSpeedKBps: 256, downloadSpeedKBps: 256, maxTimeout: 1800000 },
  };
}

function websocketServerEntry(port: number, token: string): Record<string, unknown> {
  return {
    name: "yugang",
    enable: true,
    host: "127.0.0.1",
    port,
    messagePostFormat: "array",
    token,
    reportSelfMessage: false,
    heartInterval: 30000,
    debug: false,
  };
}

/**
 * 写 onebot11_<uin>.json：只替换 network.websocketServers 为我们这条服务端，
 * 其余键（NapCat 自己管理的都算）原样保留；文件不存在才用默认骨架。
 * 返回写过的文件路径。
 */
export function writeOneBotConfig({ dir = "", port, token }: OneBotConfigInput): string {
  const configDir = napcatConfigDir(dir);
  const uin = discoverUin(configDir);
  const file = join(configDir, `onebot11_${uin}.json`);

  const config: Record<string, unknown> = existsSync(file)
    ? (JSON.parse(readFileSync(file, "utf8")) as Record<string, unknown>)
    : napcatSkeleton();
  const network = (config.network ?? {}) as Record<string, unknown>;
  config.network = { ...network, websocketServers: [websocketServerEntry(port, token)] };

  mkdirSync(configDir, { recursive: true });
  writeFileSync(file, `${JSON.stringify(config, null, 2)}\n`);
  return file;
}
