/**
 * now —— 查当前时间（无参数，只读）。
 *
 * 模型的训练数据里没有「现在」，让它凭直觉判断当前时间必然出错（常差好几年）。
 * 处理时间相关事务的标准姿势是：先调 now 拿真实时间，再换算/回答；定时任务
 * （remind）的当前时间由宿主在工具内部注入，模型侧没有传时间的入口。
 */
import { defineTool, type ToolRegistration } from "@earendil-works/pi-durable";
import { manifestParameters, toolFullDescription } from "../manifest.ts";
import type { ToolManifest, ToolPackageDeps } from "../types.ts";

const WEEKDAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"] as const;

export function createNowTool(manifest: ToolManifest, deps: ToolPackageDeps): ToolRegistration {
  return defineTool({
    name: manifest.name,
    description: toolFullDescription(manifest),
    callers: ["model"],
    parameters: manifestParameters<Record<string, never>>(manifest),
    execute: async () => {
      const at = new Date((deps.now ?? Date.now)());
      const pad = (n: number) => String(n).padStart(2, "0");
      const ymd = `${at.getFullYear()}-${pad(at.getMonth() + 1)}-${pad(at.getDate())}`;
      const hms = `${pad(at.getHours())}:${pad(at.getMinutes())}:${pad(at.getSeconds())}`;
      const weekday = WEEKDAYS[at.getDay()];
      return {
        output: [{
          type: "text",
          text: `${ymd} ${hms} (${weekday}) unix=${Math.floor(at.getTime() / 1000)} tz=${Intl.DateTimeFormat().resolvedOptions().timeZone}`,
        }],
      };
    },
  });
}
