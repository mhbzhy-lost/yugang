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
import { createImggenTool } from "./imggen.ts";
import { createDrawTool } from "./draw.ts";
import { createTagsTool } from "./tags.ts";

export interface ToolDeps {
  mediaRoot: string;
  prompts: PromptSet;
  /** 模型池：look 用独立请求把图描述成文字，图片不进主会话。 */
  models?: import("@earendil-works/pi-ai").Models;
  /** look 的视觉描述模型；缺省用主模型。 */
  visionModel?: { provider: string; modelId: string };
  /** DeepSeek Search API 的 key；有才具备联网搜索能力。 */
  searchKey?: string;
  /** 主人 QQ：fs/restart 自改工具的身份闸。缺省则这些工具不可用（永远拒绝）。 */
  master?: string;
  /** ModelScope API-KEY：生图凭据。缺省则 imggen 调用会以可读错误回应。 */
  imggenKey?: string;
  /** SD WebUI（Windows 宿主机）的 baseUrl；给了才有本地画图。 */
  sdUrl?: string;
  /** danbooru.csv 路径；给了才能查 tag 词表。 */
  tagsCsv?: string;
  /** submissionId → 本轮触发消息；与 say 的引用绑定同源。 */
  triggerOf?: (roundId: unknown) => { messageId?: number | string; mentionsBot: boolean; userId?: number } | undefined;
  /** submissionId → 本轮触发消息自带的 bypass 段；仅 draw 消费。 */
  bypassOf?: (roundId: unknown) => string | undefined;
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
  const restartTool = deps.master
    ? [createRestartTool({ prompts: deps.prompts, master: deps.master, triggerOf: deps.triggerOf })]
    : [];
  return [
    createLookTool(deps),
    createSearchTool({ prompts: deps.prompts, key: deps.searchKey }),
    createVideoTool({ prompts: deps.prompts }),
    createMemeTool({ prompts: deps.prompts, mediaRoot: deps.mediaRoot }),
    ...fsTools,
    createImggenTool({ prompts: deps.prompts, mediaRoot: deps.mediaRoot, key: deps.imggenKey }),
    createDrawTool({ prompts: deps.prompts, mediaRoot: deps.mediaRoot, baseUrl: deps.sdUrl, bypassOf: deps.bypassOf }),
    createTagsTool({ prompts: deps.prompts, csvPath: deps.tagsCsv }),
    ...treeTool,
    ...testTool,
    ...restartTool,
  ];
}
