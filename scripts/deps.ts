/**
 * 手动执行部署前置依赖（deploy / up 内部也会调同一份 lib）：
 *   npm run deps
 *
 * 退出码：Node 依赖失败 = 1；60s 未就绪 = 2（deploy 只告警，不阻塞鱼启动）。
 */
import { ensureDeployDeps } from "./lib/deps.ts";

const result = await ensureDeployDeps();
if (!result.nodeDeps) {
  console.error("[deps] ✗ Node 依赖未就绪");
  process.exit(1);
}
if (!result.sixty) {
  console.warn("[deps] ⚠ 60s 未就绪，新闻会按单源降级");
  process.exit(2);
}
