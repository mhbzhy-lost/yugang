/**
 * IT bed 场景驱动器（Task I3）—— scenario JSON → 起 launch serve → 注入 → 断言 → 收摊。
 *
 * 与 launch.ts / faux NapCat 的契约（2026-11-03 逐行核对现场代码）：
 *   - launch --serve：等鱼连上 faux NapCat 后打印一行 `[itbed-ready] {JSON}`（含 sandbox、
 *     napcat/60s/bili 端口、outbound/log 路径、注入 URL、测试群号）并写 <sandbox>/itbed-ready.json，
 *     然后挂住等 SIGTERM；收到信号按原有 teardown 顺序（鱼→napcat→sixty→bili）收摊。
 *   - 注入：POST http://127.0.0.1:<napcat 端口>/inject，body 原样透传 scenario step 的 inject
 *     对象（快捷字段契约见 faux/napcat.ts 头注释：kind/text/at/quote/image/gif/card/forward/…）。
 *   - 观测：outbound.jsonl 每行 JSON（{at, action, params, echo, messageId?}，at 为 ISO 时间，
 *     断言窗口用它精确归属）；fish.log 行无时间戳，以 ~250ms 轮询归属（近似，±250ms）。
 *
 * scenario 格式：
 *   { name, configOverride?, steps:[{atMs?, inject?, awaitMs?}], expects:[…] }
 *   - steps 按列表顺序执行；atMs 为相对 ready(t0) 的绝对锚点，缺省顺延（上一条之后的游标）；
 *     awaitMs 为该步之后的等待；inject 原样 POST 到 /inject。
 *   - expects 交给 assert.ts 评测（kind outbound|log|none + match/withinMs/count/minIntervalMs）。
 *   - configOverride 原样作为 --config-patch JSON 传给 launch（只落 sandbox 覆盖层，不碰生产
 *     fish.config）。断言窗口要覆盖的时间也会被等待（场景时长 = max(步骤游标, expect 边界)）。
 *
 * 资源与安全：
 *   - 单场景总预算 --timeout-ms（缺省 180000，硬上限 180000）做看门狗；launch 另有
 *     --serve-max-ms 自保上限（驱动器传「剩余预算-15s」），两层限时。
 *   - 结束一律 SIGTERM launch（25s 宽限）→ SIGKILL 兜底（5s），并对 napcat 端口做残留探测告警。
 *   - sandbox 落 var/itbed/scenarios/<slug>（launch 每次整目录重建）；通过后默认 rm 掉
 *     （--keep-sandbox 保留），失败保留现场路径；归档 outbound 到 <slug>.outbound.archive.jsonl。
 *     绝不触碰仓库 var/ 真数据（只 rm 自己刚声明的 sandbox 子目录）。
 *
 * 用法：
 *   node scripts/itbed/driver.ts <scenario.json>     单场景（"-" 读 stdin）
 *   node scripts/itbed/driver.ts --all [目录]         顺序跑目录下全部 *.json（缺省 scripts/itbed/scenarios）
 *   node scripts/itbed/driver.ts --self-test          纯逻辑自测（不联网、不起进程）
 *   选项：--port-base N --sandbox-root <dir> --keep-sandbox --timeout-ms N
 */

import { spawn, type ChildProcess } from "node:child_process";
import { appendFileSync, existsSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync } from "node:fs";
import { createServer, type AddressInfo } from "node:net";
import { basename, join, resolve } from "node:path";
import {
  clip,
  evaluateExpects,
  formatReport,
  normalizeExpect,
  redact,
  type AttributedEntry,
  type ExpectSpec,
} from "./assert.ts";

// ── 常量 ─────────────────────────────────────────────────────────────────────

const REPO_ROOT = resolve(import.meta.dirname, "..", "..");
const LAUNCH_TS = join(REPO_ROOT, "scripts", "itbed", "launch.ts");
const DEFAULT_SCENARIO_DIR = join(REPO_ROOT, "scripts", "itbed", "scenarios");
const DEFAULT_SANDBOX_ROOT = join(REPO_ROOT, "var", "itbed", "scenarios");
const BUDGET_CAP_MS = 180_000; // 合同上限：单场景总预算不超过 180s
const READY_TIMEOUT_MS = 120_000; // 等 ready 的上限（launch 内部 connect 等待 90s + health）
const INJECT_TIMEOUT_MS = 10_000; // 单次 /inject 请求上限
const SIGTERM_GRACE_MS = 25_000; // launch teardown 最坏链路（鱼 10s+2s、faux 3s+2s×2）留 25s
const SIGKILL_GRACE_MS = 5_000;
const POLL_INTERVAL_MS = 250; // fish.log 时间归属的轮询分辨率

// ── scenario 解析 ────────────────────────────────────────────────────────────

export interface ScenarioStep {
  atMs?: number;
  awaitMs?: number;
  inject?: Record<string, unknown>;
}

export interface Scenario {
  name: string;
  configOverride: Record<string, unknown>;
  steps: ScenarioStep[];
  expects: ExpectSpec[];
  /** 场景自身需要的时间跨度（步骤游标与 expect 窗口边界的最大值，ms）。 */
  spanMs: number;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function intField(obj: Record<string, unknown>, key: string, min: number, where: string): number | undefined {
  const value = obj[key];
  if (value === undefined) return undefined;
  if (typeof value !== "number" || !Number.isInteger(value) || value < min) {
    throw new Error(`${where}：${key} 须为 ≥${min} 的整数（收到 ${JSON.stringify(value)}）`);
  }
  return value;
}

/** 校验并归一 scenario JSON；不合法抛错（消息带 name 定位）。 */
export function parseScenario(raw: unknown, source: string): Scenario {
  const where = `场景 ${source}`;
  if (!isPlainObject(raw)) throw new Error(`${where}：顶层须为对象`);
  const name = raw["name"];
  if (typeof name !== "string" || name.trim().length === 0) throw new Error(`${where}：name 须为非空字符串`);

  let configOverride: Record<string, unknown> = {};
  if (raw["configOverride"] !== undefined) {
    if (!isPlainObject(raw["configOverride"])) throw new Error(`${where}：configOverride 须为对象`);
    configOverride = raw["configOverride"];
  }

  const stepsRaw = raw["steps"] ?? [];
  if (!Array.isArray(stepsRaw)) throw new Error(`${where}：steps 须为数组`);
  const steps: ScenarioStep[] = stepsRaw.map((stepRaw, i) => {
    const stepWhere = `${where}.steps[${i}]`;
    if (!isPlainObject(stepRaw)) throw new Error(`${stepWhere}：须为对象`);
    const step: ScenarioStep = {};
    const atMs = intField(stepRaw, "atMs", 0, stepWhere);
    if (atMs !== undefined) step.atMs = atMs;
    const awaitMs = intField(stepRaw, "awaitMs", 0, stepWhere);
    if (awaitMs !== undefined) step.awaitMs = awaitMs;
    if (stepRaw["inject"] !== undefined) {
      if (!isPlainObject(stepRaw["inject"])) throw new Error(`${stepWhere}：inject 须为对象（原样 POST 到 /inject）`);
      step.inject = stepRaw["inject"];
    }
    if (step.inject === undefined && step.awaitMs === undefined) {
      throw new Error(`${stepWhere}：空步骤（须给 inject 或 awaitMs 至少其一）`);
    }
    return step;
  });

  const expectsRaw = raw["expects"] ?? [];
  if (!Array.isArray(expectsRaw)) throw new Error(`${where}：expects 须为数组`);
  const expects = expectsRaw.map((expectRaw, i) => normalizeExpect(expectRaw, `${where}.expects[${i}]`));

  // 场景时长：步骤游标（atMs 绝对锚点 + awaitMs 顺延）与 expect 窗口边界的最大值
  let cursor = 0;
  for (const step of steps) {
    const start = step.atMs ?? cursor;
    cursor = Math.max(cursor, start) + (step.awaitMs ?? 0);
  }
  for (const [i, expect] of expects.entries()) {
    cursor = Math.max(cursor, expect.afterMs ?? 0, expect.withinMs ?? 0);
    if (expect.kind !== "none" && expect.count === undefined && expect.match === undefined) {
      throw new Error(`${where}.expects[${i}]：须给 match 或 count 至少其一`);
    }
  }
  return { name, configOverride, steps, expects, spanMs: cursor };
}

// ── 小工具 ───────────────────────────────────────────────────────────────────

function sleep(ms: number): Promise<void> {
  return new Promise((resolveSleep) => setTimeout(resolveSleep, ms));
}

function slugify(source: string): string {
  const base = basename(source).replace(/\.json$/i, "");
  const slug = base.replace(/[^A-Za-z0-9._-]/g, "_").replace(/\.\./g, "_").replace(/^\.+/, "");
  return slug.length > 0 ? slug.slice(0, 60) : "scenario";
}

function isPortFree(port: number): Promise<boolean> {
  return new Promise((resolveFree) => {
    const server = createServer();
    server.once("error", () => resolveFree(false));
    server.listen(port, "127.0.0.1", () => {
      const address = server.address() as AddressInfo;
      void address;
      server.close(() => resolveFree(true));
    });
  });
}

/** 找一个「连续三端口全空闲」的基址；给了 preferred 就只验证它（占用即报错）。 */
async function findFreePortBase(preferred: number | undefined): Promise<number> {
  if (preferred !== undefined) {
    for (const port of [preferred, preferred + 1, preferred + 2]) {
      if (!(await isPortFree(port))) throw new Error(`端口 ${port} 被占用（--port-base ${preferred} 不可用）`);
    }
    return preferred;
  }
  const start = 4400 + 3 * Math.floor(Math.random() * 500);
  for (let attempt = 0; attempt < 60; attempt++) {
    const base = start + 3 * attempt;
    if ((await isPortFree(base)) && (await isPortFree(base + 1)) && (await isPortFree(base + 2))) return base;
  }
  throw new Error("找不到连续三个空闲端口（4400-6200 段耗尽？）");
}

function readJsonFile(path: string): unknown {
  return JSON.parse(readFileSync(path, "utf8"));
}

// ── launch serve 进程的观测（stdout 行 → ready JSON；全量落 launch.log）──────

interface ReadyInfo {
  readyAt: string;
  pid: number;
  sandbox: string;
  ports: { napcat: number; sixty: number; bili: number };
  outbound: string;
  log: string;
  groupId: number;
  injectUrl: string;
}

class LaunchHandle {
  readonly proc: ChildProcess;
  readonly logPath: string;
  private readonly tail: string[] = [];
  private rest = "";
  ready: ReadyInfo | null = null;
  private readyResolve: ((info: ReadyInfo) => void) | null = null;
  private readyReject: ((reason: Error) => void) | null = null;

  constructor(proc: ChildProcess, logPath: string) {
    this.proc = proc;
    this.logPath = logPath;
    proc.stdout?.on("data", (chunk: Buffer) => this.onChunk(chunk, "stdout"));
    proc.stderr?.on("data", (chunk: Buffer) => this.onChunk(chunk, "stderr"));
  }

  private onChunk(chunk: Buffer, stream: "stdout" | "stderr"): void {
    const text = chunk.toString("utf8");
    try {
      appendFileSync(this.logPath, text);
    } catch {
      // launch.log 写不进去不致命（只影响事后审计）
    }
    for (const line of text.split("\n")) {
      this.pushTail(`${stream === "stderr" ? "[err] " : ""}${line}`);
    }
    this.rest += text;
    const lines = this.rest.split("\n");
    this.rest = lines.pop() ?? "";
    for (const line of lines) this.inspectLine(line);
  }

  private pushTail(line: string): void {
    if (line.trim().length === 0) return;
    this.tail.push(line);
    if (this.tail.length > 80) this.tail.shift();
  }

  private inspectLine(line: string): void {
    const match = /^\[itbed-ready\] (.+)$/.exec(line);
    if (match === null) return;
    try {
      const info = JSON.parse(match[1]) as ReadyInfo;
      if (typeof info.sandbox !== "string" || typeof info.ports?.napcat !== "number" || typeof info.injectUrl !== "string") {
        throw new Error("ready JSON 缺关键字段（sandbox/ports.napcat/injectUrl）");
      }
      this.ready = info;
      this.readyResolve?.(info);
    } catch (error) {
      this.readyReject?.(new Error(`ready 行解析失败：${error instanceof Error ? error.message : String(error)}`));
    }
  }

  /** 等待 ready 行；launch 提前退出（exitBeforeReady）或超时则以 Error 结束。 */
  waitReady(exitBeforeReady: Promise<number | null>, timeoutMs: number): Promise<ReadyInfo> {
    if (this.ready !== null) return Promise.resolve(this.ready);
    return new Promise<ReadyInfo>((resolveReady, rejectReady) => {
      this.readyResolve = resolveReady;
      this.readyReject = rejectReady;
      const timer = setTimeout(() => rejectReady(new Error(`launch ${Math.round(timeoutMs / 1000)}s 内未输出 ready 行`)), timeoutMs);
      timer.unref();
      void exitBeforeReady.then(async () => {
        if (this.ready !== null) return;
        clearTimeout(timer);
        rejectReady(new Error(`launch 提前退出，无 ready 行`));
      });
    });
  }

  tailLines(count = 30): string[] {
    return this.tail.slice(-count);
  }
}

function waitProcessExit(proc: ChildProcess, timeoutMs: number): Promise<boolean> {
  if (proc.exitCode !== null || proc.signalCode !== null) return Promise.resolve(true);
  return new Promise((resolveExit) => {
    const timer = setTimeout(() => resolveExit(false), timeoutMs);
    proc.once("exit", () => {
      clearTimeout(timer);
      resolveExit(true);
    });
  });
}

/** SIGTERM → 宽限等待 → SIGKILL 兜底；返回是否动用了 SIGKILL。 */
async function stopLaunch(proc: ChildProcess): Promise<boolean> {
  if (proc.exitCode !== null || proc.signalCode !== null) return false;
  proc.kill("SIGTERM"); // launch 的 serve 处理器会按原 teardown 顺序收掉鱼与三个 faux
  if (await waitProcessExit(proc, SIGTERM_GRACE_MS)) return false;
  console.log("[itbed-driver] launch 25s 未退，SIGKILL 兜底（fish/faux 可能残留，见端口探测告警）");
  proc.kill("SIGKILL");
  await waitProcessExit(proc, SIGKILL_GRACE_MS);
  return true;
}

/** 残留探测：收摊后 napcat 端口还应答说明有 faux 漏收（只告警，不自动补刀）。 */
async function probeLeftover(napcatPort: number): Promise<string | null> {
  try {
    const res = await fetch(`http://127.0.0.1:${napcatPort}/health`, { signal: AbortSignal.timeout(2000) });
    if (res.ok) return `napcat 端口 ${napcatPort} 收摊后仍应答 /health —— 有子进程残留，请手工检查`;
  } catch {
    return null; // 连不上 = 已收干净
  }
  return null;
}

// ── 运行期上下文：看门狗 + 日志采样 ──────────────────────────────────────────

interface RunContext {
  t0: number;
  deadline: number;
  aborted: boolean;
  abortReason: string;
  controller: AbortController;
}

function checkBudget(ctx: RunContext, what: string): void {
  if (ctx.aborted) throw new Error(`运行中止：${ctx.abortReason}`);
  if (Date.now() > ctx.deadline) throw new Error(`${what}：超出场景时间预算（${Math.round((ctx.deadline - ctx.t0) / 1000)}s）`);
}

async function sleepUntil(ctx: RunContext, targetMs: number): Promise<void> {
  for (;;) {
    checkBudget(ctx, `等待到 t+${targetMs}ms`);
    const remainMs = targetMs - (Date.now() - ctx.t0);
    if (remainMs <= 0) return;
    const toDeadline = ctx.deadline - Date.now();
    if (toDeadline <= 0) {
      checkBudget(ctx, `等待到 t+${targetMs}ms`);
      return;
    }
    await sleep(Math.min(POLL_INTERVAL_MS, remainMs, toDeadline));
  }
}

/** fish.log 增量采样：整文件重读 + 已消费长度切片，行按轮询时刻归属（±250ms）。 */
class LogSampler {
  private processed = 0;
  private pending = "";
  readonly entries: AttributedEntry[] = [];
  private timer: NodeJS.Timeout | null = null;
  private readonly source = "log" as const;

  private readonly logPath: string;
  private readonly ctx: RunContext;

  constructor(logPath: string, ctx: RunContext) {
    this.logPath = logPath;
    this.ctx = ctx;
  }

  start(): void {
    this.timer = setInterval(() => this.tick(), POLL_INTERVAL_MS);
    this.timer.unref();
    this.tick();
  }

  private tick(): void {
    if (this.ctx.aborted) return;
    let text: string;
    try {
      text = existsSync(this.logPath) ? readFileSync(this.logPath, "utf8") : "";
    } catch {
      return; // 读的时刻恰逢截断/重命名：下轮再试
    }
    if (text.length <= this.processed) return;
    const chunk = text.slice(this.processed);
    this.processed = text.length;
    this.pending += chunk;
    const lines = this.pending.split("\n");
    this.pending = lines.pop() ?? "";
    const atMs = Date.now() - this.ctx.t0;
    for (const line of lines) {
      if (line.length > 0) this.entries.push({ atMs, text: line, source: this.source });
    }
  }

  /** 停表并把残留半行按停表时刻归属。 */
  stop(): void {
    if (this.timer !== null) clearInterval(this.timer);
    this.timer = null;
    if (this.pending.length > 0) {
      this.entries.push({ atMs: Date.now() - this.ctx.t0, text: this.pending, source: this.source });
      this.pending = "";
    }
  }
}

/** outbound.jsonl → 断言条目（at 字段精确归属；解析失败的行 json 缺省、文本仍可匹配）。 */
function parseOutbound(path: string, ctx: RunContext): AttributedEntry[] {
  if (!existsSync(path)) return [];
  const raw = statSync(path).size > 0 ? readFileSync(path, "utf8") : "";
  const entries: AttributedEntry[] = [];
  for (const line of raw.split("\n")) {
    if (line.trim().length === 0) continue;
    let json: unknown;
    let atMs: number | null = null;
    try {
      json = JSON.parse(line) as Record<string, unknown>;
      const at = (json as Record<string, unknown>)["at"];
      if (typeof at === "string") {
        const parsed = Date.parse(at);
        if (Number.isFinite(parsed)) atMs = parsed - ctx.t0;
      }
    } catch {
      json = undefined;
    }
    entries.push({ atMs, text: line, json, source: "outbound" });
  }
  return entries;
}

async function postInject(url: string, body: Record<string, unknown>, ctx: RunContext): Promise<{ ok: boolean; detail: string }> {
  const timeout = AbortSignal.timeout(INJECT_TIMEOUT_MS);
  const signal = AbortSignal.any([ctx.controller.signal, timeout]);
  let response: Response;
  try {
    response = await fetch(url, { method: "POST", body: JSON.stringify(body), headers: { "content-type": "application/json" }, signal });
  } catch (error) {
    return { ok: false, detail: `请求失败：${redact(clip(error instanceof Error ? error.message : String(error), 160))}` };
  }
  const text = await response.text();
  let parsed: { ok?: unknown; messageId?: unknown } | null = null;
  try {
    parsed = JSON.parse(text) as { ok?: unknown; messageId?: unknown };
  } catch {
    // 非 JSON 应答按失败处理
  }
  if (!response.ok || parsed?.ok !== true) {
    return { ok: false, detail: `HTTP ${response.status} ${redact(clip(text, 160))}` };
  }
  return { ok: true, detail: `messageId=${String(parsed.messageId)}` };
}

// ── 单场景执行 ───────────────────────────────────────────────────────────────

interface ScenarioRunOptions {
  scenario: Scenario;
  source: string;
  portBase?: number;
  sandboxRoot: string;
  keepSandbox: boolean;
  budgetMs: number;
}

interface ScenarioRunResult {
  slug: string;
  pass: boolean;
  timeout: boolean;
  durationMs: number;
  total: number;
  failed: number;
  stepErrors: string[];
  sandboxDir: string;
  keptSandbox: boolean;
  sigkill: boolean;
}

async function runScenario(options: ScenarioRunOptions): Promise<ScenarioRunResult> {
  const { scenario, source, sandboxRoot, keepSandbox } = options;
  const slug = slugify(source);
  const sandboxDir = join(sandboxRoot, slug);
  const budgetMs = options.budgetMs;
  const startedAt = Date.now();

  const result: ScenarioRunResult = {
    slug,
    pass: false,
    timeout: false,
    durationMs: 0,
    total: scenario.expects.length,
    failed: scenario.expects.length,
    stepErrors: [],
    sandboxDir,
    keptSandbox: true,
    sigkill: false,
  };

  // 预检：场景自身时间跨度 + 收摊余量必须装得进预算
  if (scenario.spanMs + 25_000 > budgetMs) {
    throw new Error(`场景时长 t+${scenario.spanMs}ms 加收摊余量超出预算 ${budgetMs}ms（压缩 steps/expects 或调小 withinMs）`);
  }

  const ctx: RunContext = {
    t0: startedAt,
    deadline: startedAt + budgetMs,
    aborted: false,
    abortReason: "",
    controller: new AbortController(),
  };
  const watchdog = setTimeout(() => {
    ctx.aborted = true;
    ctx.abortReason = `watchdog ${budgetMs}ms 超时`;
    ctx.controller.abort();
  }, budgetMs);
  watchdog.unref();

  let sampler: LogSampler | null = null;
  let launch: LaunchHandle | null = null;
  let reportPrinted = false;

  try {
    mkdirSync(sandboxRoot, { recursive: true });
    const launchLogPath = join(sandboxRoot, `${slug}.launch.log`);
    const portBase = await findFreePortBase(options.portBase);
    checkBudget(ctx, "起 launch 前");

    const launchArgs = [
      LAUNCH_TS,
      "--serve",
      "--port-base",
      String(portBase),
      "--sandbox-dir",
      sandboxDir,
      // launch 自保上限：比驱动器看门狗早 15s 触发，保证 SIGTERM 链路走它自己的 teardown
      "--serve-max-ms",
      String(Math.max(30_000, budgetMs - (Date.now() - startedAt) - 15_000)),
    ];
    if (Object.keys(scenario.configOverride).length > 0) {
      launchArgs.push("--config-patch", JSON.stringify(scenario.configOverride));
    }
    console.log(`[itbed-driver] 场景「${scenario.name}」（${source}）：起 launch --serve（port-base=${portBase}，sandbox=${sandboxDir}）`);
    const launchProc = spawn(process.execPath, launchArgs, { cwd: REPO_ROOT, stdio: ["ignore", "pipe", "pipe"] });
    launch = new LaunchHandle(launchProc, launchLogPath);
    const exitCodePromise = new Promise<number | null>((resolveExit) => {
      launchProc.once("exit", (code) => resolveExit(code));
    });

    // —— 等 ready（launch 连 faux /health、起鱼、等鱼连上）——
    let ready: ReadyInfo;
    try {
      ready = await launch.waitReady(exitCodePromise, Math.min(READY_TIMEOUT_MS, ctx.deadline - Date.now() - 5_000));
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      throw new Error(`${message}\n${launch.tailLines(20).map((line) => `    | ${clip(redact(line), 200)}`).join("\n")}`);
    }
    ctx.t0 = Date.now(); // t0 = ready 时刻：atMs/窗口全部相对它
    console.log(`[itbed-driver] ready（${((ctx.t0 - startedAt) / 1000).toFixed(1)}s）：napcat=${ready.ports.napcat} sixty=${ready.ports.sixty} bili=${ready.ports.bili} outbound=${ready.outbound}`);

    sampler = new LogSampler(ready.log, ctx);
    sampler.start();

    // —— 执行步骤（inject 原样 POST /inject；atMs 绝对锚点 / awaitMs 顺延）——
    let cursor = 0;
    for (const [i, step] of scenario.steps.entries()) {
      checkBudget(ctx, `步骤 #${i + 1}`);
      const start = step.atMs ?? cursor;
      await sleepUntil(ctx, start);
      if (step.inject !== undefined) {
        const outcome = await postInject(ready.injectUrl, step.inject, ctx);
        const label = `#${i + 1} @t+${start}ms`;
        if (outcome.ok) {
          console.log(`[itbed-step] 注入 ${label} ok（${outcome.detail}）`);
        } else {
          console.log(`[itbed-step] 注入 ${label} 失败：${outcome.detail}`);
          result.stepErrors.push(`步骤 #${i + 1} 注入失败：${outcome.detail}`);
        }
      }
      cursor = Math.max(cursor, start) + (step.awaitMs ?? 0);
      if ((step.awaitMs ?? 0) > 0) {
        console.log(`[itbed-step] #${i + 1} 等待 ${step.awaitMs}ms（至 t+${cursor}ms）`);
        await sleepUntil(ctx, cursor);
      }
    }

    // —— 等满断言窗口（场景时长 = max(步骤游标, expect 边界)）——
    if (scenario.spanMs > Date.now() - ctx.t0) {
      await sleepUntil(ctx, scenario.spanMs);
    }
    checkBudget(ctx, "断言评测前");
    sampler.stop();

    const view = { outbound: parseOutbound(ready.outbound, ctx), log: sampler.entries };
    console.log(`[itbed-driver] 断言：outbound=${view.outbound.length} 条，log=${view.log.length} 行，expects=${scenario.expects.length} 项`);
    const { results, pass } = evaluateExpects(scenario.expects, view);
    console.log(formatReport(results));
    result.pass = pass && result.stepErrors.length === 0;
    result.failed = results.filter((r) => !r.pass).length;
    reportPrinted = true;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (ctx.aborted) result.timeout = true;
    console.error(`[itbed-driver] 场景「${scenario.name}」失败：${redact(message)}`);
    if (!reportPrinted && launch?.ready !== null && launch !== null) {
      console.error(`[itbed-driver] launch 输出末尾：\n${launch.tailLines(20).map((line) => `    | ${clip(redact(line), 200)}`).join("\n")}`);
    }
  } finally {
    clearTimeout(watchdog);
    sampler?.stop();

    // —— 收摊：SIGTERM → 宽限 → SIGKILL；残留探测 ——
    if (launch !== null) {
      result.sigkill = await stopLaunch(launch.proc);
      if (launch.ready !== null) {
        const leftover = await probeLeftover(launch.ready.ports.napcat);
        if (leftover !== null) console.error(`[itbed-driver] 残留告警：${leftover}`);
      }
    }

    // —— 归档 + 清理：通过默认删 sandbox（--keep-sandbox 保留）；失败保留现场 ——
    result.durationMs = Date.now() - startedAt;
    result.keptSandbox = keepSandbox || !result.pass;
    const outboundReady = launch?.ready !== null ? launch.ready : null;
    const outboundPath = outboundReady?.outbound ?? join(sandboxDir, "outbound.jsonl");
    if (result.pass && !keepSandbox) {
      try {
        if (existsSync(outboundPath)) {
          appendFileSync(join(sandboxRoot, `${slug}.outbound.archive.jsonl`), readFileSync(outboundPath));
        }
      } catch (error) {
        console.error(`[itbed-driver] outbound 归档失败（不影响判定）：${error instanceof Error ? error.message : String(error)}`);
      }
      try {
        rmSync(sandboxDir, { recursive: true, force: true });
        console.log(`[itbed-driver] sandbox 已清理：${sandboxDir}（--keep-sandbox 可保留；outbound 已归档 ${slug}.outbound.archive.jsonl）`);
        result.keptSandbox = false;
      } catch (error) {
        console.error(`[itbed-driver] sandbox 清理失败，保留现场：${error instanceof Error ? error.message : String(error)}`);
      }
    } else {
      console.log(`[itbed-driver] sandbox 保留现场：${sandboxDir}`);
    }

    console.log(
      `[itbed-result] ${JSON.stringify({
        scenario: scenario.name,
        pass: result.pass,
        timeout: result.timeout,
        expects: result.total,
        failed: result.failed,
        stepErrors: result.stepErrors.length,
        durationMs: result.durationMs,
        sandbox: result.keptSandbox ? sandboxDir : null,
        sigkill: result.sigkill,
      })}`,
    );
  }
  return result;
}

// ── CLI ──────────────────────────────────────────────────────────────────────

function argValue(name: string): string | undefined {
  const at = process.argv.indexOf(`--${name}`);
  return at >= 0 && at + 1 < process.argv.length ? process.argv[at + 1] : undefined;
}
function hasFlag(name: string): boolean {
  return process.argv.includes(`--${name}`);
}
function positionalArgs(): string[] {
  const out: string[] = [];
  for (let i = 2; i < process.argv.length; i++) {
    const arg = process.argv[i];
    if (arg.startsWith("--")) {
      if (["--port-base", "--sandbox-root", "--timeout-ms"].includes(arg)) i++; // 带值 flag 跳过值
      continue;
    }
    out.push(arg);
  }
  return out;
}

function printHelp(): void {
  console.log(
    "IT bed 场景驱动器（Task I3）\n" +
      "用法：\n" +
      "  node scripts/itbed/driver.ts <scenario.json>   跑单个场景（\"-\" 读 stdin）\n" +
      "  node scripts/itbed/driver.ts --all [目录]       顺序跑目录下全部 *.json（缺省 scripts/itbed/scenarios）\n" +
      "  node scripts/itbed/driver.ts --self-test        纯逻辑自测（不联网、不起进程）\n" +
      "选项：\n" +
      "  --port-base N      指定 launch 端口基（缺省自动找连续 3 个空闲端口）\n" +
      "  --sandbox-root D   sandbox 根目录（缺省 var/itbed/scenarios；同一场景并发跑请各自指定）\n" +
      "  --keep-sandbox     通过也保留 sandbox 目录（缺省仅失败保留现场）\n" +
      "  --timeout-ms N     单场景总预算（缺省 180000，硬上限 180000）\n" +
      "流程：起 launch --serve → 等 [itbed-ready] 行 → 按步骤注入/等待 → 断言 outbound.jsonl 与 fish.log →\n" +
      "SIGTERM 收摊（25s 宽限 + SIGKILL 兜底）→ PASS/FAIL 报告；失败时 sandbox 保留现场路径。",
  );
}

function parseTimeoutMs(): number {
  const raw = argValue("timeout-ms");
  if (raw === undefined) return BUDGET_CAP_MS;
  const n = Number(raw);
  if (!Number.isFinite(n) || n <= 0) throw new Error(`--timeout-ms 须为正数（收到 ${raw}）`);
  return Math.min(Math.floor(n), BUDGET_CAP_MS);
}

/** --self-test：parseScenario + assert 纯逻辑自测，不联网、不起进程。 */
function runSelfTest(): number {
  let failed = 0;
  const check = (name: string, fn: () => void): void => {
    try {
      fn();
      console.log(`[self-test] PASS ${name}`);
    } catch (error) {
      failed += 1;
      console.log(`[self-test] FAIL ${name}：${error instanceof Error ? error.message : String(error)}`);
    }
  };
  const eq = (actual: unknown, expected: unknown, label: string): void => {
    const a = JSON.stringify(actual);
    const b = JSON.stringify(expected);
    if (a !== b) throw new Error(`${label}：期望 ${b}，实际 ${a}`);
  };
  const throws = (fn: () => unknown, needle: string, label: string): void => {
    try {
      fn();
    } catch (error) {
      if (!String(error).includes(needle)) throw new Error(`${label}：错误信息不含「${needle}」（实际：${String(error)}）`);
      return;
    }
    throw new Error(`${label}：未抛错`);
  };
  const entry = (atMs: number | null, text: string, json?: unknown, source: "outbound" | "log" = "outbound"): AttributedEntry => ({ atMs, text, json, source });
  const run = (expectRaw: unknown, view: { outbound?: AttributedEntry[]; log?: AttributedEntry[] }) =>
    evaluateExpects([normalizeExpect(expectRaw)], { outbound: view.outbound ?? [], log: view.log ?? [] });

  // —— scenario 解析 ——
  check("parse: 最小合法场景", () => {
    const s = parseScenario({ name: "x", steps: [{ awaitMs: 100 }], expects: [{ kind: "none", withinMs: 200 }] }, "a.json");
    eq(s.name, "x", "name");
    eq(s.spanMs, 200, "spanMs 取 expect 边界");
    eq(s.configOverride, {}, "configOverride 缺省");
  });
  check("parse: configOverride 与 inject 原样保留", () => {
    const inject = { kind: "group", at: ["bot"], text: "你好" };
    const s = parseScenario(
      { name: "x", configOverride: { compact: { maxTokens: 100000 } }, steps: [{ atMs: 1000, inject }, { awaitMs: 500 }], expects: [] },
      "a.json",
    );
    eq(s.configOverride, { compact: { maxTokens: 100000 } }, "configOverride");
    eq(s.steps[0]?.inject, inject, "inject 原样");
    eq(s.spanMs, 1500, "spanMs 步骤游标");
  });
  check("parse: 拒绝非对象/缺 name/坏 steps", () => {
    throws(() => parseScenario(42, "a"), "顶层须为对象", "非对象");
    throws(() => parseScenario({ steps: [] }, "a"), "name", "缺 name");
    throws(() => parseScenario({ name: "x", steps: "no" }, "a"), "steps 须为数组", "steps 非数组");
    throws(() => parseScenario({ name: "x", steps: [{}] }, "a"), "空步骤", "空步骤");
    throws(() => parseScenario({ name: "x", steps: [{ atMs: -1, inject: {} }] }, "a"), "atMs", "负 atMs");
  });
  check("parse: 拒绝坏 expect（kind/count 组合/缺 match 与 count）", () => {
    throws(() => parseScenario({ name: "x", expects: [{ kind: "bogus" }] }, "a"), "kind", "坏 kind");
    throws(() => parseScenario({ name: "x", expects: [{ kind: "none", count: 0 }] }, "a"), "count", "none+count");
    throws(() => parseScenario({ name: "x", expects: [{ kind: "outbound" }] }, "a"), "match 或 count", "outbound 缺参");
    throws(() => parseScenario({ name: "x", expects: [{ kind: "log", match: "a", minIntervalMs: 0 }] }, "a"), "minIntervalMs", "间隔非正");
  });

  // —— match 引擎 ——
  check("match: 文本子串/正则 flags", () => {
    eq(run({ kind: "outbound", match: "你好" }, { outbound: [entry(10, '{"action":"send_group_msg"} 你好呀')] }).pass, true, "子串命中");
    eq(run({ kind: "outbound", match: { regex: "早安", flags: "i" } }, { outbound: [entry(10, "zao An 早安")] }).pass, true, "正则命中");
    eq(run({ kind: "outbound", match: { regex: "^\\{" } }, { outbound: [entry(10, "not-json")] }).pass, false, "正则不命中");
  });
  check("match: field 点路径与 fields AND", () => {
    const rec = entry(10, '{"action":"send_group_msg","params":{"group_id":424242,"quota":3}}', {
      action: "send_group_msg",
      params: { group_id: 424242, quota: 3 },
    });
    eq(run({ kind: "outbound", match: { field: "action", equals: "send_group_msg" } }, { outbound: [rec] }).pass, true, "field equals");
    eq(run({ kind: "outbound", match: { fields: { "params.group_id": 424242, "params.quota": { min: 2, max: 5 } } } }, { outbound: [rec] }).pass, true, "fields AND");
    eq(run({ kind: "outbound", match: { fields: { "params.group_id": { exists: false } } } }, { outbound: [rec] }).pass, false, "exists 不满足");
    eq(run({ kind: "outbound", match: { field: "action", equals: "send_group_msg" } }, { outbound: [entry(10, "not-json")] }).pass, false, "非 JSON 行 field 不命中");
  });
  check("match: contains/regex 字段条件", () => {
    const rec = entry(10, "x", { params: { message: "晚安玛卡巴卡" } });
    eq(run({ kind: "outbound", match: { field: "params.message", contains: "玛卡" } }, { outbound: [rec] }).pass, true, "contains");
    eq(run({ kind: "outbound", match: { field: "params.message", regex: "^晚安" } }, { outbound: [rec] }).pass, true, "regex 字段");
  });

  // —— 窗口与数量 ——
  check("window: withinMs/afterMs 边界", () => {
    const entries = [entry(50, "早"), entry(150, "晚")];
    eq(run({ kind: "outbound", match: "晚", withinMs: 100 }, { outbound: entries }).pass, false, "withinMs 截掉 150ms");
    eq(run({ kind: "outbound", match: "早", withinMs: 100 }, { outbound: entries }).pass, true, "withinMs 含 50ms");
    eq(run({ kind: "outbound", match: "早", afterMs: 100 }, { outbound: entries }).pass, false, "afterMs 截掉 50ms");
    eq(run({ kind: "outbound", match: "无" }, { outbound: entries }).pass, false, "无界窗口全量参与");
  });
  check("window: 无时间戳条目只参与无界窗口", () => {
    eq(run({ kind: "outbound", match: "x", withinMs: 100 }, { outbound: [entry(null, "x")] }).pass, false, "有界窗口排除 null");
    eq(run({ kind: "outbound", match: "x" }, { outbound: [entry(null, "x")] }).pass, true, "无界窗口包含 null");
  });
  check("count: 精确计数", () => {
    const entries = [entry(10, "a"), entry(20, "b"), entry(30, "c")];
    eq(run({ kind: "outbound", match: { regex: "." }, count: 3 }, { outbound: entries }).pass, true, "count=3 命中");
    eq(run({ kind: "outbound", match: { regex: "." }, count: 2 }, { outbound: entries }).pass, false, "count=2 不命中");
    eq(run({ kind: "outbound", count: 3 }, { outbound: entries }).pass, true, "无 match 按全量计数");
  });
  check("minIntervalMs: 配速判定", () => {
    eq(run({ kind: "outbound", match: { regex: "." }, minIntervalMs: 6000 }, { outbound: [entry(0, "a"), entry(6000, "b")] }).pass, true, "间隔恰 6s 通过");
    const bad = run({ kind: "outbound", match: { regex: "." }, minIntervalMs: 6000 }, { outbound: [entry(0, "a"), entry(2000, "b")] });
    eq(bad.pass, false, "间隔 2s 判负");
    if (!bad.results[0]?.detail.includes("2000ms < minIntervalMs=6000ms")) throw new Error("失败详情缺间隔证据");
  });
  check("log: 日志断言与 none 双源", () => {
    eq(run({ kind: "log", match: "gate" }, { log: [entry(10, "[fish] gate=free_pass", undefined, "log")] }).pass, true, "log 命中");
    eq(run({ kind: "none", withinMs: 100 }, { outbound: [entry(50, "出站")] }).pass, false, "none 出站违例");
    eq(run({ kind: "none", withinMs: 100 }, { log: [entry(50, "日志行", undefined, "log")] }).pass, false, "none 日志违例");
    eq(run({ kind: "none", withinMs: 100 }, { outbound: [entry(150, "出站")] }).pass, true, "none 窗口外不算违例");
    eq(run({ kind: "none", match: "禁词" }, { outbound: [entry(50, "别的出站")] }).pass, true, "none 带 match 只看匹配");
  });

  // —— 证据卫生 ——
  check("redact: token 掩码", () => {
    const masked = redact('{"token":"abc123","x":1} ONEBOT_TOKEN=itbed-faux-token authorization: Bearer q');
    if (masked.includes("abc123") || masked.includes("itbed-faux-token") || masked.includes("Bearer q")) {
      throw new Error(`掩码失败：${masked}`);
    }
    eq(clip("a\nb", 10), "a\\nb", "clip 压行");
  });
  check("report: 汇总行格式", () => {
    const { results } = evaluateExpects([normalizeExpect({ kind: "outbound", match: "a" }), normalizeExpect({ kind: "log", match: "b" })], {
      outbound: [entry(10, "a")],
      log: [],
    });
    const text = formatReport(results);
    if (!text.includes("[itbed-expect] PASS #1 outbound") || !text.includes("[itbed-expect] FAIL #2 log") || !text.includes("[itbed-expects] 1/2 PASS")) {
      throw new Error(`报告格式不符：\n${text}`);
    }
  });

  console.log(`[self-test] ${failed === 0 ? "全部通过" : `${failed} 项失败`}`);
  return failed === 0 ? 0 : 1;
}

// ── 入口 ─────────────────────────────────────────────────────────────────────

async function main(): Promise<number> {
  if (hasFlag("help")) {
    printHelp();
    return 0;
  }
  if (hasFlag("self-test")) return runSelfTest();

  const sandboxRoot = resolve(argValue("sandbox-root") ?? DEFAULT_SANDBOX_ROOT);
  const budgetMs = parseTimeoutMs();
  const keepSandbox = hasFlag("keep-sandbox");
  const portBaseRaw = argValue("port-base");
  const portBase = portBaseRaw !== undefined ? Number(portBaseRaw) : undefined;
  if (portBase !== undefined && (!Number.isInteger(portBase) || portBase <= 0 || portBase > 65533)) {
    throw new Error(`--port-base 须为 1-65533 的整数（收到 ${portBaseRaw}）`);
  }

  const positionals = positionalArgs();
  const runOptions = { portBase, sandboxRoot, keepSandbox, budgetMs };

  if (hasFlag("all")) {
    const dir = resolve(positionals[0] ?? DEFAULT_SCENARIO_DIR);
    if (!existsSync(dir)) throw new Error(`场景目录不存在：${dir}`);
    const files = readdirSync(dir).filter((file) => file.toLowerCase().endsWith(".json")).sort();
    if (files.length === 0) throw new Error(`场景目录没有 *.json：${dir}`);
    console.log(`[itbed-all] 共 ${files.length} 个场景（目录 ${dir}，预算 ${budgetMs / 1000}s/场景）`);
    let passed = 0;
    for (const [i, file] of files.entries()) {
      const path = join(dir, file);
      console.log(`\n[itbed-all] (${i + 1}/${files.length}) ${file}`);
      const scenario = parseScenario(readJsonFile(path), path);
      const result = await runScenario({ ...runOptions, scenario, source: path });
      if (result.pass) passed += 1;
    }
    console.log(`\n[itbed-all] ${passed}/${files.length} PASS`);
    return passed === files.length ? 0 : 1;
  }

  const source = positionals[0];
  if (source === undefined) {
    printHelp();
    return 1;
  }
  const raw = source === "-" ? (JSON.parse(readFileSync(0, "utf8")) as unknown) : readJsonFile(resolve(source));
  const scenario = parseScenario(raw, source === "-" ? "stdin" : source);
  const result = await runScenario({ ...runOptions, scenario, source: source === "-" ? "stdin-scenario" : source });
  return result.pass ? 0 : 1;
}

let exitCode = 1;
try {
  exitCode = await main();
} catch (error) {
  console.error(`[itbed-driver] 失败：${redact(error instanceof Error ? error.message : String(error))}`);
} finally {
  process.exit(exitCode);
}
