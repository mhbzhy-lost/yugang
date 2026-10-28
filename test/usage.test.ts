/**
 * 用量：从 pi.usage 的累计值里取差，按天落盘。
 *  - 首次见到会话时把历史累计也记一笔（重启前花的钱不丢）
 *  - 没增长就不写空行
 */
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createUsageLedger, diffUsage, sumUsage, type UsageSnapshot } from "../src/usage.ts";

function state(models: Record<string, unknown>, tools: Record<string, unknown> = {}) {
  return { models, tools } as never;
}

const usage = (input: number, output: number, cacheRead = 0, cost = 0) => ({
  input,
  output,
  cacheRead,
  cacheWrite: 0,
  totalTokens: input + output,
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: cost },
});

test("把 models 和 tools 两个桶加起来", () => {
  const total = sumUsage(
    state({ "gw/Fast": usage(100, 20, 30, 0.1) }, { look: usage(5, 0) }),
  );
  assert.deepEqual(total, { input: 105, output: 20, cacheRead: 30, cacheWrite: 0, total: 125, cost: 0.1 });
});

test("空状态是零，不炸", () => {
  assert.deepEqual(sumUsage(undefined), { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0, cost: 0 });
});

test("增量不会为负", () => {
  const prev: UsageSnapshot = { input: 100, output: 20, cacheRead: 0, cacheWrite: 0, total: 120, cost: 0.2 };
  const next: UsageSnapshot = { input: 50, output: 10, cacheRead: 0, cacheWrite: 0, total: 60, cost: 0.1 };
  assert.deepEqual(diffUsage(next, prev), { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0, cost: 0 });
});

test("只有增长才写一行，首次把历史算上", () => {
  const dir = mkdtempSync(join(tmpdir(), "yg-usage-"));
  const ledger = createUsageLedger(dir);
  const at = new Date(2026, 4, 1, 10, 0).getTime();

  const first = ledger.append("qq:group:1", { input: 100, output: 20, cacheRead: 0, cacheWrite: 0, total: 120, cost: 0.2 }, at);
  assert.equal(first?.total, 120, "首次应该把历史累计记上");

  assert.equal(ledger.append("qq:group:1", { input: 100, output: 20, cacheRead: 0, cacheWrite: 0, total: 120, cost: 0.2 }, at), null, "没增长不该写");

  const third = ledger.append("qq:group:1", { input: 160, output: 30, cacheRead: 0, cacheWrite: 0, total: 190, cost: 0.35 }, at);
  assert.equal(third?.total, 70, "应该是增量 190-120");
  assert.equal(third?.input, 60);

  const lines = readFileSync(join(dir, "2026-05-01", "usage.jsonl"), "utf8").trim().split("\n");
  assert.equal(lines.length, 2);
  assert.equal(JSON.parse(lines[1]).total, 70);
});

test("按天分文件", () => {
  const dir = mkdtempSync(join(tmpdir(), "yg-usage-"));
  const ledger = createUsageLedger(dir);
  ledger.append("a", { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, total: 2, cost: 0 }, new Date(2026, 4, 1, 23, 0).getTime());
  ledger.append("a", { input: 2, output: 2, cacheRead: 0, cacheWrite: 0, total: 4, cost: 0 }, new Date(2026, 4, 2, 1, 0).getTime());
  assert.ok(readFileSync(join(dir, "2026-05-01", "usage.jsonl"), "utf8").length > 0);
  assert.ok(readFileSync(join(dir, "2026-05-02", "usage.jsonl"), "utf8").length > 0);
});
