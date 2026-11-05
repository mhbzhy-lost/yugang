/**
 * 装配器（2026-11-05）：借鉴 `app.use` 的“一排注册”形式，但语义完全不同。
 *
 * `app.use` 是请求链：每条消息都跑，有 ctx/next/终止。
 * `FishAssembly.install` 是装配链：进程启动跑一次，`build()` 时按注册顺序执行，
 * 每步返回它产出的那部分状态，下一步在累计状态上继续。没有 next，也没有终止语义。
 *
 * 用法：
 *   const state = await createFishAssembly(base)
 *     .install(installToolSurface)
 *     .install(installExtensions)
 *     .install(installHarness)
 *     .install(installCompactor)
 *     .build();
 *
 * 类型：`install` 把每步的返回值并进累计 state（`S & A`），所以每个 installer
 * 只声明它需要的那部分，链式调用仍然是类型安全的。运行时为了存异质步骤数组，
 * 内部擦成 `object`，只在 `install` 一处做受控断言。
 *
 * 不做的事：不引入第三方 runner、不做字符串路由、不做热插拔。注册顺序就是依赖
 * 顺序，必须在 `openFish` 里一眼看全。
 */

export type Installer<S extends object, A extends object> = (state: S) => A | Promise<A>;

export class FishAssembly<S extends object> {
  readonly #base: S;
  readonly #steps: Array<(state: object) => object | Promise<object>>;

  constructor(base: S, steps: Array<(state: object) => object | Promise<object>> = []) {
    this.#base = base;
    this.#steps = steps;
  }

  /** 登记一个装配步骤；只记录，不执行。 */
  install<A extends object>(installer: Installer<S, A>): FishAssembly<S & A> {
    const step = installer as unknown as (state: object) => object | Promise<object>;
    // base 只承载初始状态，新增部分由 steps 返回；这里断言成累计类型是为了让链式
    // 调用拿到 S & A 的静态视图，运行时仍是同一份 base 引用。
    return new FishAssembly<S & A>(this.#base as S & A, [...this.#steps, step]);
  }

  /** 按注册顺序执行全部步骤；返回值逐步浅合并。 */
  async build(): Promise<S> {
    // 浅拷贝 base：installer 返回 partial 是约定，但不让误写直接污染调用方传入的 base
    let state: object = { ...this.#base };
    for (const step of this.#steps) {
      const added = await step(state);
      state = { ...state, ...added };
    }
    return state as S;
  }
}

/** 从 base 状态开一张装配表。 */
export function createFishAssembly<S extends object>(base: S): FishAssembly<S> {
  return new FishAssembly(base);
}
