/**
 * 异步子进程捕获：spawnSync 的取消友好替代（工具超时围栏专用）。
 *
 * 为什么需要：spawnSync 阻塞事件循环，工具超时的 watchdog 在它返回前根本没机会
 * 触发，取消信号也送不进子进程。这里用 spawn + AbortSignal（超时与调用方取消
 * 经 AbortSignal.any 合并后交给底层 kill），失败形状与 spawnSync 对齐：
 * status null = 没跑成（启动失败 / 被超时或取消杀掉 / 输出超上限）。
 *
 * 只服务工具 execute 链路里的耗时子进程（draw 的 sips 初图归一、video 的抽帧）；
 * image-ops / shrink-image / gif-frames 的同步契约（测试注入同步桩）不动，
 * 它们继续用 spawnSync 自带的底层 timeout。
 */
import { spawn } from "node:child_process";

export interface CaptureResult {
  status: number | null;
  stdout: Buffer;
  stderr: Buffer;
}

export function spawnCapture(
  command: string,
  args: readonly string[],
  options: { timeoutMs: number; signal?: AbortSignal; maxBytes?: number },
): Promise<CaptureResult> {
  const maxBytes = options.maxBytes ?? 8 * 1024 * 1024;
  const timeout = AbortSignal.timeout(options.timeoutMs);
  const signal = options.signal ? AbortSignal.any([timeout, options.signal]) : timeout;
  return new Promise((resolve) => {
    const child = spawn(command, args, { signal, stdio: ["ignore", "pipe", "pipe"] });
    const out: Buffer[] = [];
    const err: Buffer[] = [];
    let outSize = 0;
    let errSize = 0;
    let overflow = false;
    let settled = false;
    const finish = (status: number | null) => {
      if (settled) return;
      settled = true;
      resolve({ status: overflow ? null : status, stdout: Buffer.concat(out), stderr: Buffer.concat(err) });
    };
    child.stdout.on("data", (chunk: Buffer) => {
      outSize += chunk.length;
      // 对齐 spawnSync 的 maxBuffer：超限按失败处理，杀掉子进程
      if (outSize > maxBytes) {
        overflow = true;
        child.kill();
        return;
      }
      out.push(chunk);
    });
    child.stderr.on("data", (chunk: Buffer) => {
      errSize += chunk.length;
      if (errSize <= maxBytes) err.push(chunk);
    });
    // 启动失败 / 被 signal 杀掉都会走 error；close 随后也可能到，finish 只认第一次
    child.on("error", () => finish(null));
    child.on("close", (code) => finish(code));
  });
}