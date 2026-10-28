/**
 * bash 是鱼唯一的手，也是这个项目里唯一的 L3 权限。
 *
 * 这里不假装能沙箱化（要做真隔离请上容器/seatbelt/bwrap），只做三件有用的事：
 *  1. 不继承宿主环境变量——key、token、SSH agent 一律不进 shell
 *  2. 工作目录固定在这个群自己的 workspace
 *  3. 一组明显的自杀命令直接拒掉，失败信息回给模型
 */
import { createBashTool, createReadTool } from "@earendil-works/pi-durable/tools";
import type { BashExecution } from "@earendil-works/pi-durable/tools";

const DENY: readonly [RegExp, string][] = [
  [/\brm\s+(-[a-zA-Z]*\s+)*-[a-zA-Z]*[rf][a-zA-Z]*\s+\/(\s|$)/, "不准 rm -rf /"],
  [/\bsudo\b|\bdoas\b/, "这里不需要也不能提权"],
  [/\bmkfs(\.|\b)|\bdd\s+if=/, "不要动磁盘"],
  [/\b(shutdown|reboot|halt)\b/, "不要关机"],
  [/\bssh(-agent|d)?\s/, "不要往外连 ssh"],
  [/\bcrond?\b.*install|systemctl\s+enable/, "不要装常驻任务"],
  [/>\s*\/etc\//, "不要写 /etc"],
];

export interface SandboxOptions {
  /** 媒体目录，暴露给 skill 脚本，保证 say 的 media 能通过白名单校验。 */
  mediaRoot: string;
  /** skills 根目录，脚本里用 $YUGANG_SKILL_DIR 引用。 */
  skillsRoot: string;
}

export function createHands(options: SandboxOptions) {
  const bash = createBashTool({
    prepare: (execution: BashExecution) => {
      for (const [re, reason] of DENY) {
        if (re.test(execution.command)) throw new Error(`这条命令被拦下：${reason}`);
      }
      execution.inheritEnv = false;
      execution.env = {
        PATH: process.env.PATH ?? "/usr/local/bin:/usr/bin:/bin",
        HOME: execution.cwd,
        TMPDIR: execution.cwd,
        LANG: "zh_CN.UTF-8",
        YUGANG_MEDIA_ROOT: options.mediaRoot,
        YUGANG_SKILL_DIR: options.skillsRoot,
        YUGANG_WORKSPACE: execution.cwd,
      };
    },
  });

  return { bash, read: createReadTool() };
}
