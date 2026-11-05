/**
 * 入口壳子（2026-11-05）：只借 `app.use(...)` 的形式，不引任何框架依赖。
 *
 * 目标：src/index.ts 最终只剩「建 runtime → 一串 app.use / onFlush / onStart / onStop
 * → start」，不写任何实际逻辑。这个文件本身也不认识鱼缸的任何业务类型——它只知道
 * 「一条中间件链 + 一个 flush 钩子 + 启动/退出钩子」，上下文的形状由调用方决定。
 *
 * 语义照抄 Express 的最小集：
 *  - `use` 按注册顺序执行；
 *  - 中间件调 `next()` 继续，直接 return 就是终点；
 *  - 中间件抛错会中止整条链，由调用方（onMessage 的最外层 catch）统一记日志；
 *  - `onFlush` 是第二条入口（debounce 攒满后的整组提交），不参与消息链；
 *  - `onStart` 正序、`onStop` 逆序；`start()` 幂等，重复调用不会重复起定时器。
 *
 * 刻意不做的事：
 *  - 不做 `app.locals` 之类的杂物袋：上下文由调用方显式构造并传入 `dispatch(ctx)`；
 *  - 不做通配路径 / 路由匹配：这里没有 HTTP，也没有「按路径找 handler」的需求；
 *  - 不做中间件热插拔：注册顺序就是行为契约，必须在入口一眼看全。
 */

/** 消息链中间件：调 next() 继续，直接返回即终止。 */
export type Middleware<T> = (ctx: T, next: () => Promise<void>) => Promise<void> | void;

/** debounce 后的整组提交处理器（第二条入口，不参与消息链）。 */
export type FlushHandler<F> = (payload: F) => Promise<void> | void;

/** 启动/退出钩子；start 正序、stop 逆序。 */
export type LifecycleHook = () => Promise<void> | void;

export interface App<T, F> {
  /** 追加一段消息中间件（顺序即行为）。 */
  use(middleware: Middleware<T>): App<T, F>;
  /** 注册 debounce flush 处理器；重复注册以后一次为准。 */
  onFlush(handler: FlushHandler<F>): App<T, F>;
  /** 注册启动钩子（正序执行）。 */
  onStart(hook: LifecycleHook): App<T, F>;
  /** 注册退出钩子（逆序执行）。 */
  onStop(hook: LifecycleHook): App<T, F>;
  /** 把一条消息送进链；没有中间件时是空操作。 */
  dispatch(ctx: T): Promise<void>;
  /** 把一批攒好的消息送给 flush 处理器；没注册就报错，不静默吞掉。 */
  flush(payload: F): Promise<void>;
  /** 执行全部启动钩子；幂等。 */
  start(): Promise<void>;
  /** 执行全部退出钩子（逆序）；未 start 时是空操作。 */
  stop(): Promise<void>;
}

export function createApp<T, F = void>(): App<T, F> {
  const middlewares: Middleware<T>[] = [];
  const starts: LifecycleHook[] = [];
  const stops: LifecycleHook[] = [];
  let flushHandler: FlushHandler<F> | undefined;
  let started = false;

  const app: App<T, F> = {
    use(middleware) {
      middlewares.push(middleware);
      return app;
    },
    onFlush(handler) {
      flushHandler = handler;
      return app;
    },
    onStart(hook) {
      starts.push(hook);
      return app;
    },
    onStop(hook) {
      stops.push(hook);
      return app;
    },
    async dispatch(ctx) {
      let cursor = -1;
      const next = async (): Promise<void> => {
        cursor += 1;
        const middleware = middlewares[cursor];
        if (middleware === undefined) return;
        await middleware(ctx, next);
      };
      await next();
    },
    async flush(payload) {
      if (flushHandler === undefined) throw new Error("flush handler 未注册");
      await flushHandler(payload);
    },
    async start() {
      if (started) return;
      started = true;
      // 某个钩子抛错时保持 started=true：调用方可以继续 stop() 收掉已注册的定时器/连接；
      // 钩子自己的半启动由各自的模块负责（壳子不替它重跑启动逻辑）。
      for (const hook of starts) await hook();
    },
    async stop() {
      if (!started) return;
      for (const hook of [...stops].reverse()) await hook();
      started = false;
    },
  };
  return app;
}
