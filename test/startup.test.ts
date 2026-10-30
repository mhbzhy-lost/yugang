/**
 * 启动级错误的门禁：用 tsc 做一次「不使用未声明变量 / 不重复声明 / 不提前使用」的检查。
 *
 * 为什么需要它：src/index.ts 是入口脚本，`npm test` 不会加载它，所以
 *   - 重复声明（TS2451）
 *   - 用了没声明的变量（TS2304，今晚 silentRounds 就栽在这）
 *   - 块级变量在声明前使用（TS2448/TS2454，watchedByChat 栽在这）
 * 这些错误测试全绿、部署才炸。
 *
 * 只拦这几类：仓库历史遗留的类型错误有上百条（pi-durable 的泛型推断），
 * 不在本次治理范围，别的诊断码一律忽略。
 */
import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { join } from "node:path";

const FATAL = new Set(["TS2304", "TS2448", "TS2454", "TS2451", "TS2552"]);

test("入口脚本能通过「未声明/重复声明/提前使用」检查", () => {
  const tsc = join(process.cwd(), "node_modules", ".bin", "tsc");
  const result = spawnSync(
    tsc,
    [
      "--noEmit",
      "--skipLibCheck",
      "--module",
      "nodenext",
      "--moduleResolution",
      "nodenext",
      "--target",
      "es2022",
      "--allowImportingTsExtensions",
      "--noImplicitAny",
      "false",
      "src/index.ts",
    ],
    { encoding: "utf8", timeout: 120_000 },
  );

  const output = `${result.stdout ?? ""}${result.stderr ?? ""}`;
  const fatal = output
    .split("\n")
    .filter((line) => /error TS\d+/.test(line))
    .filter((line) => {
      const code = /error (TS\d+)/.exec(line)?.[1];
      return code !== undefined && FATAL.has(code);
    });

  assert.deepEqual(fatal, [], `入口脚本有启动级错误：\n${fatal.join("\n")}`);
});
