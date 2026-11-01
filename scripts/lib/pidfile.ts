/**
 * 鱼进程 pid 的单一事实源：npm run up 与 npm run deploy 起鱼后都把 pid 写进同一个
 * var/up.pid，npm run down 读它收鱼（缺失/失效时 down 还有 pgrep 兑底）。
 * 三个脚本都从这一个模块取路径，避免各写各的产生第二事实源。
 *
 * 路径随数据目录：YUGANG_HOME 优先（.env 的值对三个脚本都可见），缺省 <仓库>/var/up.pid。
 * 内容就是一个十进制 pid；写失败只告警不阻断起鱼。
 */
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

/** up.pid 的唯一取径入口：YUGANG_HOME 优先，缺省仓库 var/。 */
export function pidFilePath(): string {
  const home = process.env.YUGANG_HOME ?? join(import.meta.dirname, "..", "..", "var");
  return join(home, "up.pid");
}

/** 起鱼后记 pid：目录不存在先建；写失败不抛（down 有 pgrep 兑底），返回是否写成功。 */
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
