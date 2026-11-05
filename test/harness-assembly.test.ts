/**
 * 装配入口契约（2026-11-05）：src/harness.ts 只许是一排 `.install(...)`。
 *
 * 与 index-registration 同款：harness.ts 不是被测试 import 的业务模块，逻辑回归只能靠
 * 启动级检查；这条测试把「注册表形式」钉死——新增能力必须是 src/fish/ 下的一个
 * installer，再在 openFish 里加一行，而不是把逻辑塞回装配入口。
 */
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const source = readFileSync(fileURLToPath(new URL("../src/harness.ts", import.meta.url)), "utf8");

test("harness.ts 的 install 顺序就是装配依赖顺序", () => {
  const installs = [...source.matchAll(/\.install\((\w+)\)/g)].map((match) => match[1]);
  assert.deepEqual(installs, [
    "installToolSurface",
    "installExtensions",
    "installHarness",
    "installStartupMigrations",
    "installCompactor",
    "installDrain",
    "installMemoryAdmin",
    "installGroup",
    "installCompact",
    "installEnqueue",
    "installClose",
  ]);
});

test("harness.ts 只有 openFish 一个函数，没有业务控制流", () => {
  const functions = [...source.matchAll(/\bfunction\s+(\w+)/g)].map((match) => match[1]);
  assert.deepEqual(functions, ["openFish"], "装配入口里出现了第二个函数");
  assert.doesNotMatch(source, /\bif\s*\(|\bfor\s*\(|\bwhile\s*\(|\bswitch\s*\(|\btry\s*\{/, "装配入口里出现了控制流");
  assert.ok(source.split("\n").length <= 100, "harness.ts 又长回去了");
});
