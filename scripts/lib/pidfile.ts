/**
 * 鱼进程 pid 的单一事实源：npm run up 与 npm run deploy 起鱼后都把 pid 写进同一个
 * var/up.pid，npm run down 读它收鱼（缺失/失效时 down 还有进程扫描兜底）。
 * 三个脚本都从这一个模块取路径，避免各写各的产生第二事实源。
 *
 * 路径随数据目录：YUGANG_HOME 优先（.env 的值对三个脚本都可见），缺省 <仓库>/var/up.pid。
 * 内容就是一个十进制 pid；写失败只告警不阻断起鱼。
 */
import { spawnSync } from "node:child_process";
import { mkdirSync, realpathSync, writeFileSync } from "node:fs";
import { isAbsolute, join, resolve } from "node:path";
import { DATA_HOME, REPO_ROOT } from "../../src/paths.ts";

/** up.pid 的唯一取径入口：YUGANG_HOME 优先，缺省仓库 var/。 */
export function pidFilePath(): string {
  return join(DATA_HOME, "up.pid");
}

/** 起鱼后记 pid：目录不存在先建；写失败不抛（down 有进程扫描兜底），返回是否写成功。 */
export function recordFishPid(pid: number | undefined): boolean {
  const file = pidFilePath();
  try {
    mkdirSync(join(file, ".."), { recursive: true });
    writeFileSync(file, `${pid ?? ""}\n`);
    return true;
  } catch (error) {
    console.error(`[pid] 写 ${file} 失败：${error instanceof Error ? error.message : error}`);
    return false;
  }
}

export interface FishProcessIdentity {
  pid: number;
  command: string;
  cwd: string;
  executable: string;
  entry: string;
  args: readonly string[];
}

const EXECUTABLE = resolve(process.execPath);
const ENTRY = resolve(REPO_ROOT, "src", "index.ts");
const ARGS = ["--env-file-if-exists=.env", ENTRY] as const;
const COMMAND = [EXECUTABLE, ...ARGS].join(" ");

function commandOf(pid: number): string {
  const out = spawnSync("ps", ["-p", String(pid), "-o", "command="], { encoding: "utf8" });
  return (out.stdout ?? "").trim();
}

function cwdOf(pid: number): string {
  const out = spawnSync("lsof", ["-a", "-p", String(pid), "-d", "cwd", "-Fn"], { encoding: "utf8" });
  for (const line of (out.stdout ?? "").split("\n")) {
    if (line.startsWith("n")) return line.slice(1);
  }
  return "";
}

function realpath(path: string): string | undefined {
  try {
    return realpathSync(path);
  } catch {
    return undefined;
  }
}

/**
 * 严格确认一个 pid 是本项目启动的鱼：命令行必须逐字匹配绝对 execPath、绝对入口和完整参数，
 * cwd 的 realpath 必须等于仓库根的 realpath。调用方在每次发信号前都必须重新调用本函数。
 */
export function fishProcessIdentity(pid: number): FishProcessIdentity | undefined {
  if (!Number.isInteger(pid) || pid <= 0 || pid === process.pid || !isAbsolute(EXECUTABLE) || !isAbsolute(ENTRY)) {
    return undefined;
  }
  const repo = realpath(REPO_ROOT);
  if (!repo) return undefined;
  const command = commandOf(pid);
  if (command !== COMMAND) return undefined;
  const cwd = cwdOf(pid);
  if (!cwd || realpath(cwd) !== repo) return undefined;
  return { pid, command, cwd, executable: EXECUTABLE, entry: ENTRY, args: ARGS };
}

/** 扫描所有进程后再用同一严格身份校验收窄；不使用宽泛的 pkill/pgrep。 */
export function findFishProcesses(): FishProcessIdentity[] {
  const out = spawnSync("ps", ["-axo", "pid=,command="], { encoding: "utf8" });
  const candidates: number[] = [];
  for (const line of (out.stdout ?? "").split("\n")) {
    const match = line.trim().match(/^(\d+)\s+(.+)$/);
    if (match && match[2] === COMMAND) candidates.push(Number(match[1]));
  }
  return candidates.flatMap((pid) => {
    const identity = fishProcessIdentity(pid);
    return identity ? [identity] : [];
  });
}
