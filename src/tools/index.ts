/**
 * 工具注册表：能力扩展的唯一入口。
 *
 * 加一项能力 = 在这里加一个 createXxxTool()，再补一份 prompt/tools/xxx.md。
 * 没有 shell、没有文件读取、没有 MCP —— 模型只能调这里列出的函数。
 */
import type { ToolRegistration } from "@earendil-works/pi-durable";
import type { PromptSet } from "../prompts.ts";
import { createLookTool } from "./look.ts";
import { createSearchTool } from "./search.ts";
import { createVideoTool } from "./video.ts";
import { createMemeTool } from "./meme.ts";
import { createFsTools } from "./fs.ts";
import { createRestartTool } from "./restart.ts";
import { createTreeTool } from "./tree.ts";
import { createTestTool } from "./test.ts";
import { createAlarmTool } from "./alarm.ts";

export interface ToolDeps {
  mediaRoot: string;
  prompts: PromptSet;
  /** DeepSeek Search API 的 key；有才具备联网搜索能力。 */
  searchKey?: string;
  /** 主人 QQ：fs/restart 自改工具的身份闸。缺省则这些工具不可用（永远拒绝）。 */
  master?: string;
  /** submissionId → 本轮触发消息；与 say 的引用绑定同源。 */
  triggerOf?: (roundId: unknown) => { messageId?: number | string; mentionsBot: boolean; userId?: number } | undefined;
}

export function createTools(deps: ToolDeps): ToolRegistration[] {
  const fsTools = deps.master
    ? (() => {
        const { read, edit, write, del } = createFsTools({ prompts: deps.prompts, master: deps.master, triggerOf: deps.triggerOf });
        return [read, edit, write, del];
      })()
    : [];
  const treeTool = deps.master ? [createTreeTool({ prompts: deps.prompts, master: deps.master, triggerOf: deps.triggerOf })] : [];
  const testTool = deps.master ? [createTestTool({ prompts: deps.prompts, master: deps.master, triggerOf: deps.triggerOf })] : [];
  const alarmTool = deps.master && deps.alarmsPath
    ? [createAlarmTool({ prompts: deps.prompts, alarmsPath: deps.alarmsPath, master: deps.master, triggerOf: deps.triggerOf })]
    : [];
  const restartTool = deps.master
    ? [createRestartTool({ prompts: deps.prompts, master: deps.master, triggerOf: deps.triggerOf })]
    : [];
  return [
    createLookTool(deps),
    createSearchTool({ prompts: deps.prompts, key: deps.searchKey }),
    createVideoTool({ prompts: deps.prompts }),
    createMemeTool({ prompts: deps.prompts, mediaRoot: deps.mediaRoot }),
    ...fsTools,
    ...treeTool,
    ...testTool,
    ...alarmTool,
    ...restartTool,
  ];
}
