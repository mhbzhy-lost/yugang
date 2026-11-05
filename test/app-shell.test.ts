/**
 * 入口壳子（src/app/app.ts）的机械测试。
 *
 * 这里不测任何鱼缸业务：只咬住 index.ts 将依赖的四条语义——
 *  - `use` 按注册顺序执行，调 next() 才继续，直接 return 就是终点；
 *  - `onFlush` 是第二条入口，没注册就报错（不静默吞批次）；
 *  - `onStart` 正序、`onStop` 逆序，start 幂等；
 *  - 中间件抛错会中止整条链并原样上抛。
 */
import test from "node:test";
import assert from "node:assert/strict";
import { createApp } from "../src/app/app.ts";

test("use 按注册顺序执行，next() 才继续", async () => {
  const app = createApp<{ log: string[] }>();
  app.use((ctx, next) => {
    ctx.log.push("a:before");
    return next().then(() => ctx.log.push("a:after"));
  });
  app.use((ctx) => {
    ctx.log.push("b");
  });
  app.use(() => {
    throw new Error("不该执行到这里");
  });
  const ctx = { log: [] as string[] };
  await app.dispatch(ctx);
  assert.deepEqual(ctx.log, ["a:before", "b", "a:after"], "中间件没有按 use 顺序执行，或终点没有止住链");
});

test("中间件直接 return 就是终点，后面的不再执行", async () => {
  const app = createApp<{ hits: string[] }>();
  app.use((ctx) => {
    ctx.hits.push("first");
  });
  app.use((ctx) => {
    ctx.hits.push("never");
  });
  const ctx = { hits: [] as string[] };
  await app.dispatch(ctx);
  assert.deepEqual(ctx.hits, ["first"]);
});

test("异步中间件：await next() 后面的代码在后续链跑完后才执行", async () => {
  const app = createApp<{ log: string[] }>();
  app.use(async (ctx, next) => {
    ctx.log.push("start");
    await new Promise((resolve) => setTimeout(resolve, 1));
    await next();
    ctx.log.push("end");
  });
  app.use(async (ctx) => {
    await new Promise((resolve) => setTimeout(resolve, 1));
    ctx.log.push("inner");
  });
  const ctx = { log: [] as string[] };
  await app.dispatch(ctx);
  assert.deepEqual(ctx.log, ["start", "inner", "end"]);
});

test("中间件抛错会中止整条链并原样上抛", async () => {
  const app = createApp<{ hits: string[] }>();
  app.use((ctx) => {
    ctx.hits.push("before");
    throw new Error("boom");
  });
  app.use((ctx) => {
    ctx.hits.push("never");
  });
  const ctx = { hits: [] as string[] };
  await assert.rejects(() => app.dispatch(ctx), /boom/);
  assert.deepEqual(ctx.hits, ["before"]);
});

test("onFlush 是第二条入口；没注册就报错", async () => {
  const app = createApp<unknown, { items: string[] }>();
  await assert.rejects(() => app.flush({ items: [] }), /flush handler 未注册/);
  const seen: string[][] = [];
  app.onFlush((burst) => {
    seen.push(burst.items);
  });
  await app.flush({ items: ["a", "b"] });
  assert.deepEqual(seen, [["a", "b"]]);
});

test("start 正序、stop 逆序；未 start 时 stop 是空操作；start 幂等", async () => {
  const app = createApp<unknown>();
  const order: string[] = [];
  app.onStart(() => {
    order.push("start-1");
  });
  app.onStart(() => {
    order.push("start-2");
  });
  app.onStop(() => {
    order.push("stop-1");
  });
  app.onStop(() => {
    order.push("stop-2");
  });

  await app.stop();
  assert.deepEqual(order, [], "未 start 时 stop 不该执行");

  await app.start();
  await app.start();
  assert.deepEqual(order, ["start-1", "start-2"], "start 不幂等或顺序不对");

  await app.stop();
  await app.stop();
  assert.deepEqual(order, ["start-1", "start-2", "stop-2", "stop-1"], "stop 不是逆序或重复执行");
});

test("没有中间件时 dispatch 是空操作", async () => {
  const app = createApp<{ hits: string[] }>();
  const ctx = { hits: [] as string[] };
  await app.dispatch(ctx);
  assert.deepEqual(ctx.hits, []);
});
