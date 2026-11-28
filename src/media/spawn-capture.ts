/**
 * 异步子进程捕获：spawnSync 的取消友好替代（工具超时围栏专用）。
 *
 * 为什么需要：spawnSync 阻塞事件循环，工具超时的 watchdog 在它返回前根本没机会
 * 触发，取消信号也送不进子进程。这里用 spawn + 显式 SIGTERM→SIGKILL 升级 + close
 * 回收，失败形状与 spawnSync 对齐：
 * status null = 没跑成（启动失败 / 被超时或取消杀掉 / 输出超上限）。
 */
import { spawn } from "node:child_process";

export interface CaptureResult {
  status: number | null;
  stdout: Buffer;
  stderr: Buffer;
}

const SIGKILL_GRACE_MS = 1500;
const CLOSE_GRACE_MS = 2000;

export function spawnCapture(
  command: string,
  args: readonly string[],
  options: { timeoutMs: number; signal?: AbortSignal; maxBytes?: number },
): Promise<CaptureResult> {
  if (options.signal?.aborted) {
    return Promise.resolve({ status: null, stdout: Buffer.alloc(0), stderr: Buffer.alloc(0) });
  }
  const maxBytes = options.maxBytes ?? 8 * 1024 * 1024;
  return new Promise((resolve) => {
    const child = spawn(command, args, { stdio: ["ignore", "pipe", "pipe"] });
    const out: Buffer[] = [];
    const err: Buffer[] = [];
    let outSize = 0;
    let errSize = 0;
    let overflow = false;
    let failed = false;
    let terminating = false;
    let exited = false;
    let exitCode: number | null = null;
    let settled = false;
    let timeoutTimer: ReturnType<typeof setTimeout> | undefined;
    let killTimer: ReturnType<typeof setTimeout> | undefined;
    let closeGraceTimer: ReturnType<typeof setTimeout> | undefined;

    const cleanup = () => {
      if (timeoutTimer !== undefined) clearTimeout(timeoutTimer);
      if (killTimer !== undefined) clearTimeout(killTimer);
      if (closeGraceTimer !== undefined) clearTimeout(closeGraceTimer);
      options.signal?.removeEventListener("abort", onAbort);
    };

    const finish = (status: number | null) => {
      if (settled) return;
      settled = true;
      cleanup();
      resolve({
        status: overflow || failed ? null : status,
        stdout: Buffer.concat(out),
        stderr: Buffer.concat(err),
      });
    };

    const terminate = () => {
      if (terminating || settled) return;
      terminating = true;
      if (!exited) failed = true;
      try {
        child.kill("SIGTERM");
      } catch {
        /* 进程可能已退出 */
      }
      killTimer = setTimeout(() => {
        if (!exited && !settled) {
          try {
            child.kill("SIGKILL");
          } catch {
            /* 忽略 */
          }
        }
      }, SIGKILL_GRACE_MS);
      killTimer.unref?.();
    };

    const onAbort = () => {
      failed = true;
      terminate();
    };

    if (options.signal) {
      options.signal.addEventListener("abort", onAbort, { once: true });
    }
    if (Number.isFinite(options.timeoutMs) && options.timeoutMs > 0) {
      timeoutTimer = setTimeout(terminate, options.timeoutMs);
      timeoutTimer.unref?.();
    }

    child.stdout.on("data", (chunk: Buffer) => {
      outSize += chunk.length;
      if (outSize > maxBytes) {
        overflow = true;
        terminate();
        return;
      }
      out.push(chunk);
    });

    child.stderr.on("data", (chunk: Buffer) => {
      errSize += chunk.length;
      if (errSize > maxBytes) {
        overflow = true;
        terminate();
        return;
      }
      err.push(chunk);
    });

    // 仅当 spawn 本身未拉起进程（!child.pid）时立即 settle；已拉起进程一律等 exit/close 收口
    child.on("error", () => {
      if (!child.pid) finish(null);
      else failed = true;
    });

    child.on("exit", (code) => {
      exited = true;
      exitCode = code;
      if (killTimer !== undefined) {
        clearTimeout(killTimer);
        killTimer = undefined;
      }
      if (!settled) {
        closeGraceTimer = setTimeout(() => {
          child.stdout.destroy();
          child.stderr.destroy();
          finish(exitCode);
        }, CLOSE_GRACE_MS);
        closeGraceTimer.unref?.();
      }
    });

    child.on("close", (code) => {
      finish(code ?? exitCode);
    });
  });
}
