/**
 * 把 pi-durable 装配成「鱼」——装配表入口（2026-11-05 重构）。
 *
 * 一只鱼身上只有：
 *   一张嘴  say_*             唯一出口族（say_words / say_media / say_meme / say_voice），硬校验
 *   手写的工具（src/tools/）  能力扩展的唯一方式——没有 shell、没有文件读取、没有 MCP
 *
 * 一个 Conversation = 一个 QQ 群，自带 cwd，互不串。
 *
 * `openFish` 只做注册：一排 `.install(...)` 按依赖顺序跑，最后 `buildFish` 拼返回对象。
 * 每个 installer 一个文件（src/fish/），装配链本身在 src/fish/assembly.ts。
 * 外部 importer 继续从 `./harness.ts` 取 `openFish` / `Fish` / `GroupProfile` / `SentmapDoc`，
 * 导入面不变。
 */
import { createFishAssembly } from "./fish/assembly.ts";
import { createFishBase } from "./fish/base.ts";
import { buildFish } from "./fish/build.ts";
import { installCompactor } from "./fish/compactor.ts";
import { installDrain } from "./fish/drain.ts";
import { installExtensions } from "./fish/extensions.ts";
import { installGroup } from "./fish/group.ts";
import { installHarness } from "./fish/harness.ts";
import { installMemoryAdmin } from "./fish/memory-admin.ts";
import { installClose, installCompact, installEnqueue } from "./fish/output.ts";
import { installStartupMigrations } from "./fish/startup.ts";
import { installToolSurface } from "./fish/tool-surface.ts";
import type { Fish, FishOptions } from "./fish/types.ts";

export { DEFAULT_PERSONA, type Fish, type FishOptions, type GroupProfile, type ModelRef, type SentMessageIds } from "./fish/types.ts";
export { GroupProfileEntry, SentmapDoc, type SentmapEntry, type SentmapState } from "./fish/docs.ts";

export async function openFish(options: FishOptions): Promise<Fish> {
  const state = await createFishAssembly(createFishBase(options))
    .install(installToolSurface)
    .install(installExtensions)
    .install(installHarness)
    .install(installStartupMigrations)
    .install(installCompactor)
    .install(installDrain)
    .install(installMemoryAdmin)
    .install(installGroup)
    .install(installCompact)
    .install(installEnqueue)
    .install(installClose)
    .build();

  return buildFish(state);
}
