/**
 * buildFish：装配链的最后一步——把各 installer 产出的部分拼成 `Fish`
 * （2026-11-05 从 harness.ts 拆出）。只拼对象，不执行任何行为。
 */
import type { Harness } from "@earendil-works/pi-durable";
import type { Compactor } from "../compact.ts";
import type { FishBase } from "./base.ts";
import type { DrainParts } from "./drain.ts";
import type { ExtensionParts } from "./extensions.ts";
import type { GroupParts } from "./group.ts";
import type { MemoryAdminParts } from "./memory-admin.ts";
import type { ToolSurfaceParts } from "./tool-surface.ts";
import { DEFAULT_PERSONA, type Fish } from "./types.ts";

export type FishParts = FishBase
  & ToolSurfaceParts
  & ExtensionParts
  & { harness: Harness; compactor: Compactor | undefined }
  & DrainParts
  & MemoryAdminParts
  & GroupParts
  & Pick<Fish, "compact" | "enqueue" | "close">;

export function buildFish(state: FishParts): Fish {
  return {
    harness: state.harness,
    models: state.models,
    prompts: state.prompts,
    settings: state.settings,
    personas: [DEFAULT_PERSONA, ...Object.keys(state.prompts.personas)],
    openers: state.openers,
    toolNames: state.tools.map((tool) => tool.name),
    compact: state.compact,
    pendingMemories: state.pendingMemories,
    approveMemory: state.approveMemory,
    rejectMemory: state.rejectMemory,
    memoryCommandReply: state.memoryCommandReply,
    group: state.group,
    drain: state.drain,
    enqueue: state.enqueue,
    close: state.close,
  };
}
