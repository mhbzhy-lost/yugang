/**
 * 工具调用超时：每个工具的 execute 包一层，超过上限就报错返回给模型。
 *
 * 为什么不在「整轮」上设超时：一轮里可能连着画图、查词、看三张图，
 * 每步都正常但加起来超过一分钟——那不该被砍。卡死的通常是单个工具，
 * 所以把上限加在工具粒度上。
 */
import type { ToolRegistration } from "@earendil-works/pi-durable";
import { extractLinks, recordSeenLinks } from "../egress/seen-links.ts";

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

/**
 * 工具结果的「见过的链接」登记（2026-11-05）：出口侧只允许写本轮工具结果里出现过的 URL。
 *
 * 为什么套在工具包装层而不是各工具自己登记：这是出口约束，不是某个工具的知识；
 * 包装层是唯一能看见「所有工具结果」的地方，新工具自动被覆盖，也不会有人忘记登记。
 * 抽取失败/无链接时零副作用；登记失败不影响工具本身成功（返回值原样透传）。
 */
export function withSeenLinkHarvest<T extends ToolRegistration>(
  tool: T,
  roundOf: (api: unknown, context: unknown) => Promise<unknown>,
): T {
  const original = tool.execute as (...args: unknown[]) => Promise<unknown>;
  return {
    ...tool,
    execute: (async (...args: unknown[]) => {
      const result = await original.apply(tool, args);
      try {
        const text = resultTextOf(result);
        if (text.length > 0) {
          const links = extractLinks(text);
          if (links.length > 0) {
            const round = await roundOf(args[1], args[2]).catch(() => undefined);
            if (round !== undefined) recordSeenLinks(round, links);
          }
        }
      } catch {
        // 登记只是记账：任何异常都不影响工具结果
      }
      return result;
    }) as T["execute"],
  };
}

/** 工具返回值里对模型可见的文本（兼容 string / text block 数组与其他形状）。 */
function resultTextOf(result: unknown): string {
  const output = (result as { output?: unknown } | undefined)?.output;
  if (!Array.isArray(output)) return "";
  return output
    .filter((block): block is { type?: unknown; text?: unknown } => typeof block === "object" && block !== null)
    .filter((block) => block.type === "text" && typeof block.text === "string")
    .map((block) => block.text as string)
    .join("\n");
}
