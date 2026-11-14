/**
 * 图像预处理的跨平台门面（同步契约）。
 *
 * 背景：原实现只用 macOS 自带 `sips`（见 shrink-image.ts 头注释「deploy 不装依赖」）。
 * 容器化到 Linux 后该前提消失，而 sips 不存在 → 压图/转码全线静默失败：
 * 图落盘成功但模型一张也看不到。故引入本模块。
 *
 * 分工：**模型负责「看懂」，本模块只负责「把图压成能发出去的字节」**。
 *
 * 后端选择：
 *   - darwin  → 原样走 sips，参数逐字保留（生产路径零行为变化，回滚无害）
 *   - 其它    → 一个 node + sharp 的 worker 子进程
 *
 * 为什么 Linux 侧用子进程而不是直接 await sharp：
 * 全部调用点都是同步契约（`spawnSync` + 同步返回 `Buffer | null`），且现有测试注入
 * 同步 shrink 桩。sharp 只有异步 API，直接异步化会波及 round-images / runtime / 测试桩。
 * 而**现状本来就是每步 spawn 一个 sips 子进程**（阶梯下探最多 17 次），
 * 所以「一个 worker 干完整件事」在成本上比现状更省，且保住所有同步契约。
 *
 * 输出字节不可能与 sips 逐字节相同（编码器不同），保证的是语义等价：
 * 格式正确、尺寸边界正确、质量档位正确、失败形状正确。
 */
import { spawnSync } from "node:child_process";
import { join } from "node:path";

/** 与 shrink-image.ts 共用同一套规格常量，两个后端不许各写一份。 */
export const IMAGE_SPEC = {
  maxLongSide: 1280,
  targetBytes: 50 * 1024,
  quality: 80,
  ladderFloor: 400,
  ladderStep: 50,
  lookQuality: 70,
  initMaxSide: 1216,
  initPixelBudget: 832 * 1216,
} as const;

export type WorkerResult =
  | { ok: true; b64: string; floor?: true }
  | { ok: false; reason: string };

const WORKER = join(import.meta.dirname, "image-worker.ts");

/** 是否走 sips 后端。容器判定不用平台（见 YUGANG_CONTAINER），但图像后端确实按平台选实现。 */
export function usesSips(): boolean {
  return process.platform === "darwin";
}

/**
 * 调 worker 完成一次图像操作。失败一律返回 null（与 sips 路径的失败形状一致），
 * 但**打一行告警**——原实现的纯静默降级是这次容器化最容易假通过的地方。
 */
function runWorker(op: string, args: Record<string, unknown>): WorkerResult {
  try {
    const res = spawnSync(process.execPath, [WORKER, op, JSON.stringify(args)], {
      timeout: 60_000,
      encoding: "utf8",
      maxBuffer: 64 * 1024 * 1024,
    });
    if (res.status !== 0) {
      console.error(`[鱼缸] 图像处理失败 op=${op} rc=${res.status} ${String(res.stderr ?? "").slice(0, 200)}`);
      return { ok: false, reason: "worker" };
    }
    const parsed = JSON.parse(res.stdout) as WorkerResult;
    if (!parsed.ok) console.error(`[鱼缸] 图像处理未产出 op=${op} reason=${parsed.reason}`);
    return parsed;
  } catch (err) {
    console.error(`[鱼缸] 图像处理异常 op=${op} ${err instanceof Error ? err.message : "unknown"}`);
    return { ok: false, reason: "worker" };
  }
}

/** inline 附图压图（≤50KB，含阶梯下探）。darwin 侧由 shrink-image.ts 自己走 sips。 */
export function shrinkViaWorker(file: string): WorkerResult {
  return runWorker("shrink", { file });
}

/** look 转述前压图：长边 ≤1280、JPEG q70。 */
export function lookShrinkViaWorker(file: string): Buffer | null {
  const r = runWorker("look", { file });
  return r.ok ? Buffer.from(r.b64, "base64") : null;
}

/** draw 的 ref 初图归一化：受限像素预算 + 16 对齐 + PNG。 */
export function normalizeInitViaWorker(file: string): Buffer | null {
  const r = runWorker("init", { file });
  return r.ok ? Buffer.from(r.b64, "base64") : null;
}

/** 入站 HEIC/HEIF/BMP/TIFF → JPEG（不缩放，默认质量）。 */
export function toJpegViaWorker(file: string): Buffer | null {
  const r = runWorker("jpeg", { file });
  return r.ok ? Buffer.from(r.b64, "base64") : null;
}