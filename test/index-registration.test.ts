/**
 * 入口注册契约（2026-11-05）：src/index.ts 只许注册，不许写逻辑。
 *
 * 为什么要这条测试：index.ts 不是被测试 import 的模块，行为回归只能靠启动级检查；
 * 一旦有人把「先判断一下」「顺手 await 个东西」加回来，入口会重新长成 2400 行。
 * 这里用源码级断言把三条意图钉死：
 *   - 没有函数定义、没有 if/for/while/try/switch；
 *   - 消息链的 use 顺序与契约一致（顺序就是行为）；
 *   - 入口保持在一个屏幕能看完的长度内。
 */
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const source = readFileSync(fileURLToPath(new URL("../src/index.ts", import.meta.url)), "utf8");

test("index.ts 只有注册：没有函数定义与控制流", () => {
  assert.doesNotMatch(source, /\bfunction\b/, "入口里出现了函数定义");
  assert.doesNotMatch(source, /\bif\s*\(|\bfor\s*\(|\bwhile\s*\(|\bswitch\s*\(|\btry\s*\{/, "入口里出现了控制流");
  assert.doesNotMatch(source, /\bnew Map<|\bnew Set</, "入口里出现了运行时状态");
});

test("index.ts 的消息链顺序就是契约", () => {
  const stages = [...source.matchAll(/^app\.use\((\w+)\);/gm)].map((match) => match[1]);
  assert.deepEqual(stages, [
    "normalizeInbound",
    "commandsStage",
    "gateStage",
    "groupWindowStage",
    "privateChatStage",
  ]);
});

test("index.ts 保持一眼能看完", () => {
  const lines = source.split("\n").length;
  assert.ok(lines <= 120, `入口已经 ${lines} 行，逻辑又在往回长`);
});
