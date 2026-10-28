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
import { renderTemplate, type PromptSet } from "./prompts.ts";

/** 左边是判据，右边是 prompt/messages.md 里的文案 key。 */
const DENY: readonly [RegExp, string][] = [
  [/\brm\s+(-[a-zA-Z]*\s+)*-[a-zA-Z]*[rf][a-zA-Z]*\s+\/(\s|$)/, "deny_root"],
  [/\bsudo\b|\bdoas\b/, "deny_privilege"],
  [/\bmkfs(\.|\b)|\bdd\s+if=/, "deny_disk"],
  [/\b(shutdown|reboot|halt)\b/, "deny_power"],
  [/\bssh(-agent|d)?\s/, "deny_ssh"],
  [/\bcrond?\b.*install|systemctl\s+enable/, "deny_persist"],
  [/>\s*\/etc\//, "deny_etc"],
];

export interface SandboxOptions {
  /** 媒体目录，暴露给 skill 脚本，保证 say 的 media 能通过白名单校验。 */
  mediaRoot: string;
  /** skills 根目录，脚本里用 $YUGANG_SKILL_DIR 引用。 */
  skillsRoot: string;
  /** 工具的 description 也从 prompt/ 里读，覆盖库自带的说明。 */
  prompts: PromptSet;
}

export function createHands(options: SandboxOptions) {
  const bash = createBashTool({
    prepare: (execution: BashExecution) => {
      for (const [re, key] of DENY) {
        if (!re.test(execution.command)) continue;
        const reason = options.prompts.messages[key] ?? key;
        throw new Error(renderTemplate(options.prompts.messages["bash_denied"] ?? "{{reason}}", { reason }));
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

  // 覆盖库自带的工具说明：模型看到的所有文字都必须来自 prompt/
  return {
    bash: { ...bash, description: options.prompts.tools.bash.description },
    read: { ...createReadTool(), description: options.prompts.tools.read.description },
  };
}
