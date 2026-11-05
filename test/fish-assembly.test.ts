/**
 * 装配器（src/fish/assembly.ts）的机械测试。
 *
 * 语义与 `app.use` 不同：install 只记录，build 才按注册顺序执行，每步返回值浅合并
 * 进累计状态。这里咬住顺序、合并、异步、抛错四件事。
 */
import test from "node:test";
import assert from "node:assert/strict";
import { createFishAssembly } from "../src/fish/assembly.ts";

test("install 只登记，build 才按顺序执行并合并返回值", async () => {
  const log: string[] = [];
  const state = await createFishAssembly({ seed: 1 })
    .install((s) => {
      log.push("a");
      assert.equal(s.seed, 1);
      return { a: "A" };
    })
    .install(async (s) => {
      log.push("b");
      assert.equal(s.a, "A");
      return { b: "B" };
    })
    .install((s) => {
      log.push("c");
      assert.equal(s.b, "B");
      return { c: "C" };
    })
    .build();

  assert.deepEqual(log, ["a", "b", "c"], "install 阶段不该执行，build 也没按顺序跑");
  assert.deepEqual(state, { seed: 1, a: "A", b: "B", c: "C" });
});

test("后一步可以覆盖前一步的同名字段（工具包装这类替换）", async () => {
  const state = await createFishAssembly({ tools: ["raw"] })
    .install(() => ({ tools: ["wrapped"] }))
    .build();
  assert.deepEqual(state.tools, ["wrapped"]);
});

test("某一步抛错会中止后续步骤并原样上抛", async () => {
  const log: string[] = [];
  await assert.rejects(
    () => createFishAssembly({})
      .install(() => {
        log.push("a");
        return { a: 1 };
      })
      .install(() => {
        log.push("b");
        throw new Error("boom");
      })
      .install(() => {
        log.push("never");
        return { c: 3 };
      })
      .build(),
    /boom/,
  );
  assert.deepEqual(log, ["a", "b"]);
});

test("base 不会被 installer 原地改写", async () => {
  const base = { seed: 1 };
  const state = await createFishAssembly(base)
    .install((s) => {
      (s as { seed: number }).seed = 99;
      return { added: true };
    })
    .build();
  assert.equal(base.seed, 1, "base 被原地改写了");
  assert.equal(state.seed, 99);
  assert.equal(state.added, true);
});
