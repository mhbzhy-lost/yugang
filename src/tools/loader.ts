/**
 * 最终工具 loader：一次性发现并注册全部工具包。
 *
 * 一个工具包 = src/tools/<name>/ 下的 TOOL.md + tool.ts，两者缺一不可、目录名 = manifest
 * name = 注册名。这里做四层机械校验（任何一层不符都直接启动失败，不静默降级）：
 *   1. loadToolManifests：每个目录都有合法 TOOL.md，name 与目录名一致、不重复；
 *   2. factory 名单与 manifest 名单双向一一对应——多出的 manifest（没实现的文档）和
 *      名单里没有 manifest 的 factory（没文档的实现）都算孤儿，报错；
 *   3. 每个包目录里必须真的有 tool.ts（文档在、实现丢了同样起不来）；
 *   4. factory 产出的注册名必须等于 manifest name。
 *
 * Node 实现启动时全部静态 import、全部注册进内存——deferred 只延迟「向模型暴露声明」，
 * 不延迟加载实现（没有动态 import 懒加载）。依赖不满足时 factory 返回 undefined，
 * 该工具直接跳过：不进 agent.tools、不进 agent.deferred、不进 tool_catalog。
 *
 * eager/deferred 只在这里定：say / react / tool_search 初始可见，其余已启用工具统一
 * deferred: true（factory 本体不写 deferred）。deferred 标记加在注册对象上，后续
 * withToolTimeout 用展开拷贝包装，会原样保留 deferred / callers / parameters / description。
 */
import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { join } from "node:path";
import type { ToolRegistration } from "@earendil-works/pi-durable";
import { loadToolManifests } from "./manifest.ts";
import type { ToolPackageDeps, ToolPackageFactory, ToolManifest } from "./types.ts";
import { createDrawTool } from "./draw/tool.ts";
import { createGptImageTool } from "./gpt_image/tool.ts";
import { createGrepTool } from "./grep/tool.ts";
import { createLookTool } from "./look/tool.ts";
import { createMemeTool } from "./meme/tool.ts";
import { createMemeAddTool } from "./meme_add/tool.ts";
import { createMemeImportTool } from "./meme_import/tool.ts";
import { createModelTool } from "./model/tool.ts";
import { createReactTool } from "./react/tool.ts";
import { createReadTool } from "./read/tool.ts";
import { createRestartTool } from "./restart/tool.ts";
import { createSayTool } from "./say/tool.ts";
import { createSearchTool } from "./search/tool.ts";
import { createTagsTool } from "./tags/tool.ts";
import { createToolSearchTool } from "./tool_search/tool.ts";
import { createTreeTool } from "./tree/tool.ts";
import { createVideoTool } from "./video/tool.ts";
import { createWatchTool } from "./watch/tool.ts";
import { createWriteTool } from "./write/tool.ts";

/** 19 个工具包的 Node factory；与 src/tools/<name>/TOOL.md 一一对应，两边都不允许孤儿。 */
const FACTORIES: Readonly<Record<string, ToolPackageFactory>> = {
  draw: createDrawTool,
  gpt_image: createGptImageTool,
  grep: createGrepTool,
  look: createLookTool,
  meme: createMemeTool,
  meme_add: createMemeAddTool,
  meme_import: createMemeImportTool,
  model: createModelTool,
  react: createReactTool,
  read: createReadTool,
  restart: createRestartTool,
  say: createSayTool,
  search: createSearchTool,
  tags: createTagsTool,
  tool_search: createToolSearchTool,
  tree: createTreeTool,
  video: createVideoTool,
  watch: createWatchTool,
  write: createWriteTool,
};

/** 初始就提供给模型的工具：唯一出口 say、轻回应 react、按需加载的检索入口 tool_search。 */
const EAGER_TOOLS: ReadonlySet<string> = new Set(["say", "react", "tool_search"]);

/** loader 的产出：已启用工具的注册对象与 manifest（同序，按工具名排序）。 */
export interface ToolSurface {
  /** 全部已启用工具（eager + deferred），按 name 排序。 */
  readonly tools: readonly ToolRegistration[];
  /** 与 tools 同集合、同序的 manifest；tool_catalog section 只消费这份 trusted 数据。 */
  readonly manifests: readonly ToolManifest[];
}

/**
 * 扫描 src/tools 包根、校验一一对应、逐个调 factory 注册。
 * 动态词表（meme 的 mood enum）在 loadToolManifests 里按 deps.prompts.memeTags 解析。
 */
export async function loadToolSurface(deps: ToolPackageDeps): Promise<ToolSurface> {
  // manifest 与工具实现同住源码包根，按模块自身路径定位（不依赖 cwd 或 promptRoot）
  const root = fileURLToPath(new URL("./", import.meta.url));
  const manifests = loadToolManifests(root, { memeTags: deps.prompts.memeTags });

  for (const name of Object.keys(FACTORIES)) {
    if (!manifests.has(name)) throw new Error(`有 factory 但缺少工具 manifest：src/tools/${name}/TOOL.md`);
  }
  for (const name of manifests.keys()) {
    if (!(name in FACTORIES)) throw new Error(`有 manifest 但没有实现：src/tools/${name}/tool.ts`);
    if (!existsSync(join(root, name, "tool.ts"))) throw new Error(`工具包缺少实现文件：src/tools/${name}/tool.ts`);
  }

  const tools: ToolRegistration[] = [];
  for (const name of [...manifests.keys()].sort()) {
    const registration = await FACTORIES[name]!(manifests.get(name)!, deps);
    // 依赖闸：factory 返回 undefined = 这个能力当前不可用（如无 master 的主人工具），
    // 不进入任何模型面（agent.tools / agent.deferred / tool_catalog 都没有它）
    if (!registration) continue;
    if (registration.name !== name) throw new Error(`注册名与 manifest name 不一致：${registration.name} != ${name}`);
    tools.push(EAGER_TOOLS.has(name) ? registration : { ...registration, deferred: true });
  }
  if (tools.length === 0) throw new Error("没有可用的工具");

  const enabled = new Set(tools.map((tool) => tool.name));
  return { tools, manifests: [...manifests.values()].filter((manifest) => enabled.has(manifest.name)) };
}
