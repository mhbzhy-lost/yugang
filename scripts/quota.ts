/**
 * provider 额度/余额查询 CLI（运维用，不进鱼的工具面）。
 *
 * 用法：
 *   npm run quota                          # 查全部已配置 provider
 *   npm run quota -- deepseek              # 只查一个 provider（精确匹配）
 *   npm run quota -- --json                # 结构化 JSON（不含任何密钥/token）
 *
 * 退出码：全部 ok/unsupported/unconfigured → 0；任一 error 或 provider 不存在 → 1。
 */

import { queryQuotas, formatQuotaReport } from "../src/model/quota.ts";

const args = process.argv.slice(2);

if (args.includes("--help") || args.includes("-h")) {
  console.log(`用法：npm run quota -- [provider] [--json]

  provider      可选，精确匹配 config/models.json 的 provider id
  --json        输出结构化 JSON（不含任何密钥/token）

支持真实查询：deepseek / zai-coding-cn；
订阅制渠道（含 CLIProxyAPI）及无公开额度接口的 provider 标 unsupported，缺凭据标 unconfigured。`);
  process.exit(0);
}

const json = args.includes("--json");
const providerFilter = args.find((arg) => !arg.startsWith("--"));

try {
  const report = await queryQuotas({
    ...(providerFilter ? { providerFilter } : {}),
  });
  if (report.filterError) {
    console.error(`未找到 provider「${report.filterError.filter}」，已配置：${report.filterError.available.join(", ")}`);
    process.exit(1);
  }
  console.log(json ? JSON.stringify(report, null, 2) : formatQuotaReport(report));
  process.exit(report.providers.some((provider) => provider.status === "error") ? 1 : 0);
} catch (error) {
  console.error(`额度查询失败：${error instanceof Error ? error.message : String(error)}`);
  process.exit(1);
}
