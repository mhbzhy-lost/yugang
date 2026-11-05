/**
 * 可手动推进的假时钟（engage-next 的 tick 与各类节拍都用它）。
 *
 * 独立成模块供 scripts/ 下的自检脚本共用：`test/` 里已有两份同款实现（debounce 与
 * model-input-templates），这里不再让脚本内部再写第三份。
 */
export interface FakeClock {
  now: () => number;
  setTimer: (fn: () => void, ms: number) => ReturnType<typeof setTimeout>;
  clearTimer: (timer: ReturnType<typeof setTimeout>) => void;
  advance: (ms: number) => void;
}

export function fakeClock(base: number): FakeClock {
  let current = base;
  const timers = new Map<number, { at: number; fn: () => void }>();
  let seq = 0;
  return {
    now: () => current,
    setTimer: (fn, ms) => {
      seq += 1;
      timers.set(seq, { at: current + ms, fn });
      return seq as unknown as ReturnType<typeof setTimeout>;
    },
    clearTimer: (timer) => {
      timers.delete(timer as unknown as number);
    },
    advance(ms) {
      const target = current + ms;
      for (;;) {
        const due = [...timers.entries()].filter(([, entry]) => entry.at <= target).sort((a, b) => a[1].at - b[1].at)[0];
        if (!due) break;
        current = due[1].at;
        timers.delete(due[0]);
        due[1].fn();
      }
      current = target;
    },
  };
}

/** 本地时间的固定时刻（宵禁判定按本机时区的小时，用本地构造避免时区漂移）。 */
export function localAt(hour: number, minute = 0): number {
  return new Date(2026, 10, 5, hour, minute, 0, 0).getTime();
}
