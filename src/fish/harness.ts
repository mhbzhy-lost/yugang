/**
 * installHarness：把扩展 registry + settings 交给 pi-durable，拿到 Harness 实例
 * （2026-11-05 从 harness.ts 拆出）。
 */
import { Harness } from "@earendil-works/pi-durable";
import type { FishBase } from "./base.ts";
import type { ExtensionParts } from "./extensions.ts";

export async function installHarness(state: FishBase & ExtensionParts): Promise<{ harness: Harness }> {
  const harness = await Harness.open(
    state.options.storage,
    {
      models: state.models,
      registry: state.registry,
      now: state.now,
      settings: state.settings,
    },
    state.ctx,
  );
  return { harness };
}
