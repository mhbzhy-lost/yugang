import { DRAW_BACKEND_IDS } from "./ids.ts";
import type { DrawBackend } from "./types.ts";
import { anima38bBackend } from "./anima3.8b/index.ts";

export const DRAW_BACKENDS: ReadonlyMap<string, DrawBackend> = new Map<string, DrawBackend>([
  [anima38bBackend.id, anima38bBackend],
]);

const expectedIds = new Set<string>(DRAW_BACKEND_IDS);
const actualIds = new Set<string>(DRAW_BACKENDS.keys());
if (expectedIds.size !== actualIds.size || [...expectedIds].some((id) => !actualIds.has(id))) {
  throw new Error("DRAW_BACKENDS registry mismatch with DRAW_BACKEND_IDS");
}

export function getDrawBackend(id: string, overrides?: ReadonlyMap<string, DrawBackend>): DrawBackend | undefined {
  return (overrides ?? DRAW_BACKENDS).get(id);
}

export function validateAllDrawBackends(backends: ReadonlyMap<string, DrawBackend> = DRAW_BACKENDS): void {
  for (const backend of backends.values()) {
    backend.validateStartup();
  }
}
