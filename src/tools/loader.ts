/**
 * 最终工具 loader：一次性发现并注册全部工具包。
 *
 * 一个工具包 = src/tools/<name>/ 下的 TOOL.md + tool.ts，两者缺一不可、目录名 = manifest
 * name = 注册名。这里做五层机械校验（任何一层不符都直接启动失败，不静默降级）：
 *   1. loadToolManifests：每个目录都有合法 TOOL.md（含可选的 tool-messages 第三块），
 *      name 与目录名一致、不重复；
 *   2. factory 名单与 manifest 名单双向一一对应——多出的 manifest（没实现的文档）和
 *      名单里没有 manifest 的 factory（没文档的实现）都算孤儿，报错；
 *   3. 每个包目录里必须真的有 tool.ts（文档在、实现丢了同样起不来）；
 *   4. factory 产出的注册名必须等于 manifest name；
 *   5. 工具专属文案合并进 deps.prompts.messages 时任何 key 撞车
 *      （工具 ↔ 工具、工具 ↔ 中心文件）直接报错，报出 key 与两个来源。
 *
 * Node 实现启动时全部静态 import、全部注册进内存——deferred 只延迟「向模型暴露声明」，
 * 不延迟加载实现（没有动态 import 懒加载）。依赖不满足时 factory 返回 undefined，
 * 该工具直接跳过：不进 agent.tools、不进 agent.deferred、不进 tool_catalog。
 *
 * 停用工具包（DISABLED_TOOL_PACKAGES，2026-11-04 模型输入计划 T3）：四件套完整性校验
 * 照旧全部执行（manifest 解析、manifest ↔ factory 双向一一对应、tool.ts 存在性、
 * messages.json 格式），但不进 active/deferred/catalog，factory 不调用，disabled 包的
 * tool-messages 也不并入 active messages 合并视图；目录与源码保留作兼容，不得删目录规避校验。
 *
 * eager/deferred 只在这里定：say_words / say_media / say_meme / say_voice / react /
 * tool_search 初始可见，其余已启用工具统一 deferred: true（factory 本体不写 deferred）。deferred 标记加在注册对象上，后续
 * withToolTimeout 用展开拷贝包装，会原样保留 deferred / callers / parameters / description。
 */
import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { join } from "node:path";
import type { ToolRegistration } from "@earendil-works/pi-durable";
import { loadToolManifests } from "./manifest.ts";
import type { ToolPackageDeps, ToolPackageFactory, ToolManifest } from "./types.ts";
import { createAmmoListTool } from "./ammo_list/tool.ts";
import { createAmmoSubmitTool } from "./ammo_submit/tool.ts";
import { createBiliHotTool } from "./bili_hot/tool.ts";
import { createBiliVideoTool } from "./bili_video/tool.ts";
import { createConfigTool } from "./config/tool.ts";
import { createDrawTool } from "./draw/tool.ts";
import { createGptImageTool } from "./gpt_image/tool.ts";
import { createGrepTool } from "./grep/tool.ts";
import { createLookTool } from "./look/tool.ts";
import { createMemeTool } from "./meme/tool.ts";
import { createMemeAddTool } from "./meme_add/tool.ts";
import { createMemeImportTool } from "./meme_import/tool.ts";
import { createReactTool } from "./react/tool.ts";
import { createReadTool } from "./read/tool.ts";
import { createRestartTool } from "./restart/tool.ts";
import { createSayMediaTool } from "./say_media/tool.ts";
import { createSayMemeTool } from "./say_meme/tool.ts";
import { createSayVoiceTool } from "./say_voice/tool.ts";
import { createSayWordsTool } from "./say_words/tool.ts";
import { createSearchTool } from "./search/tool.ts";
import { createTagsTool } from "./tags/tool.ts";
import { createToolSearchTool } from "./tool_search/tool.ts";
import { createTreeTool } from "./tree/tool.ts";
import { createVideoTool } from "./video/tool.ts";
import { createWatchTool } from "./watch/tool.ts";
import { createWriteTool } from "./write/tool.ts";

/** 25 个工具包的 Node factory；与 src/tools/<name>/TOOL.md 一一对应，两边都不允许孤儿。 */
const FACTORIES: Readonly<Record<string, ToolPackageFactory>> = {
  ammo_list: createAmmoListTool,
  ammo_submit: createAmmoSubmitTool,
  bili_hot: createBiliHotTool,
  bili_video: createBiliVideoTool,
  config: createConfigTool,
  draw: createDrawTool,
  gpt_image: createGptImageTool,
  grep: createGrepTool,
  look: createLookTool,
  meme: createMemeTool,
  meme_add: createMemeAddTool,
  meme_import: createMemeImportTool,
  react: createReactTool,
  read: createReadTool,
  restart: createRestartTool,
  say_media: createSayMediaTool,
  say_meme: createSayMemeTool,
  say_voice: createSayVoiceTool,
  say_words: createSayWordsTool,
  search: createSearchTool,
  tags: createTagsTool,
  tool_search: createToolSearchTool,
  tree: createTreeTool,
  video: createVideoTool,
  watch: createWatchTool,
  write: createWriteTool,
};

/** 初始就提供给模型的工具：四个出口 say_*、轻回应 react、按需加载的检索入口 tool_search。 */
const EAGER_TOOLS: ReadonlySet<string> = new Set(["say_words", "say_media", "say_meme", "say_voice", "react", "tool_search"]);

/**
 * 停用工具包（2026-11-04 模型输入计划 T3，弹药管线停用）：完整性校验照旧（孤儿 manifest /
 * 孤儿 factory / 缺 tool.ts / messages.json 非法都仍报错），但不进 active/deferred/catalog，
 * factory 不调用，tool-messages 不并入 active messages 合并视图。目录与源码保留作兼容，
 * 不得删目录规避校验。
 */
export const DISABLED_TOOL_PACKAGES: ReadonlySet<string> = new Set(["ammo_list", "ammo_submit"]);

/** loader 的产出：已启用工具的注册对象与 manifest（同序，按工具名排序）。 */
export interface ToolSurface {
  /** 全部已启用工具（eager + deferred），按 name 排序。 */
  readonly tools: readonly ToolRegistration[];
  /** 与 tools 同集合、同序的 manifest；tool_catalog section 只消费这份 trusted 数据。 */
  readonly manifests: readonly ToolManifest[];
}

/**
 * 扫描 src/tools 包根、校验一一对应、逐个调 factory 注册。
 * 动态词表（meme 的 mood enum）在 loadToolManifests 里按 deps.prompts.memeTags 解析；
 * 各工具的 tool-messages 在注册前合并进 deps.prompts.messages（全局合并视图，
 * 消费侧零改动）。
 */
export async function loadToolSurface(deps: ToolPackageDeps): Promise<ToolSurface> {
  // manifest 与工具实现同住源码包根，按模块自身路径定位（不依赖 cwd 或 promptRoot）
  const root = fileURLToPath(new URL("./", import.meta.url));
  const manifests = loadToolManifests(root, { memeTags: deps.prompts.memeTags });
  // 合并视图：active 工具包的专属文案就地并入 deps.prompts.messages，工具执行代码、宿主 section
  // 与 scripts 都只认这一个 map。撞车（工具 ↔ 工具、工具 ↔ 中心）在 mergeToolMessages 里
  // 直接抛错，绝不静默覆盖。disabled 包的 tool-messages 不并入（T3：停用包不进 active
  // messages 合并视图，其文案不再是模型可见面）。
  const activeManifests = new Map([...manifests].filter(([name]) => !DISABLED_TOOL_PACKAGES.has(name)));
  mergeToolMessages(activeManifests, deps.prompts.messages);

  // 完整性校验对全部包（含 disabled）照旧：双向一一对应 + tool.ts 存在性
  for (const name of Object.keys(FACTORIES)) {
    if (!manifests.has(name)) throw new Error(`有 factory 但缺少工具 manifest：src/tools/${name}/TOOL.md`);
  }
  for (const name of manifests.keys()) {
    if (!(name in FACTORIES)) throw new Error(`有 manifest 但没有实现：src/tools/${name}/tool.ts`);
    if (!existsSync(join(root, name, "tool.ts"))) throw new Error(`工具包缺少实现文件：src/tools/${name}/tool.ts`);
  }

  const tools: ToolRegistration[] = [];
  for (const name of [...manifests.keys()].sort()) {
    // disabled 包：校验已做完，不调 factory、不进任何模型面（active/deferred/catalog）
    if (DISABLED_TOOL_PACKAGES.has(name)) continue;
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

/**
 * 把全部工具的 tool-messages 合并进全局 messages map（与 loadPrompts 读出的中心层合并）。
 * key 撞车（工具 ↔ 工具、工具 ↔ 中心文件 prompt/messages.md）直接抛错，报出 key 与
 * 两个来源——同一句文案有两份定义就是事故，绝不静默择一。
 */
export function mergeToolMessages(manifests: ReadonlyMap<string, ToolManifest>, target: Record<string, string>): void {
  const owner = new Map<string, string>(Object.keys(target).map((key) => [key, "prompt/messages.md"]));
  for (const manifest of manifests.values()) {
    for (const key of Object.keys(manifest.messages)) {
      const from = owner.get(key);
      if (from !== undefined) {
        throw new Error(`文案 key 冲突：${key}（${from} 与 src/tools/${manifest.name}/TOOL.md）`);
      }
      owner.set(key, `src/tools/${manifest.name}/TOOL.md`);
      target[key] = manifest.messages[key];
    }
  }
}
