export const DEFAULT_DRAW_BACKEND = "anima3.8b";

export const DRAW_BACKEND_IDS = ["anima3.8b"] as const;

export type DrawBackendId = (typeof DRAW_BACKEND_IDS)[number];
