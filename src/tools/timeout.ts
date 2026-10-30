/**
 * 工具调用超时：每个工具的 execute 包一层，超过上限就报错返回给模型。
 *
 * 为什么不在「整轮」上设超时：一轮里可能连着画图、查词、看三张图，
 * 每步都正常但加起来超过一分钟——那不该被砍。卡死的通常是单个工具，
 * 所以把上限加在工具粒度上。
 */
import type { ToolRegistration } from "@earendil-works/pi-durable";

export function withToolTimeout<T extends ToolRegistration>(tool: T, timeoutMs: number, message: string): T {
  const original = tool.execute as (...args: unknown[]) => Promise<unknown>;
  return {
    ...tool,
    execute: (async (...args: unknown[]) => {
      let timer: ReturnType<typeof setTimeout> | undefined;
      const timeout = new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error(message)), timeoutMs);
      });
      try {
        return await Promise.race([original.apply(tool, args), timeout]);
      } finally {
        if (timer) clearTimeout(timer);
      }
    }) as T["execute"],
  };
}
