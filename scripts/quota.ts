/**
 * provider 额度/余额查询 CLI（运维用，不进鱼的工具面）。
 *
 * 用法：
 *   npm run quota                          # 查全部已配置 provider
 *   npm run quota -- google-antigravity    # 只查一个 provider（精确匹配）
 *   npm run quota -- --json                # 结构化 JSON（不含任何密钥/token）
 *   npm run quota -- --no-refresh          # OAuth 过期不刷新不写盘，只报过期状态
 *
 * 退出码：全部 ok/unsupported/unconfigured/expired → 0；任一 error 或 provider 不存在 → 1。
 */

import { queryQuotas, formatQuotaReport } from "../src/model/quota.ts";

const args = process.argv.slice(2);

if (args.includes("--help") || args.includes("-h")) {
  console.log(`用法：npm run quota -- [provider] [--json] [--no-refresh]

  provider      可选，精确匹配 config/models.json 的 provider id
  --json        输出结构化 JSON（不含任何密钥/token）
  --no-refresh  OAuth 凭据过期时不刷新不写盘，只报过期状态

支持真实查询：google-antigravity / openai-codex / deepseek / zai-coding-cn；
其余 provider 标 unsupported，缺凭据标 unconfigured。`);
  process.exit(0);
}

const json = args.includes("--json");
const noRefresh = args.includes("--no-refresh");
const providerFilter = args.find((arg) => !arg.startsWith("--"));

try {
  const report = await queryQuotas({
    ...(providerFilter ? { providerFilter } : {}),
    noRefresh,
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