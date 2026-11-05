/**
 * 部署前置依赖（2026-11-05）：确保「代码之外的运行件」也在位。
 *
 * 目前两类：
 *   1. Node 依赖：package-lock 变了、或 node_modules 缺失时跑一次
 *      `npm install --omit=dev`（deploy 以前只 pull 不 install，新增依赖会
 *      在启动时才炸 ERR_MODULE_NOT_FOUND）。
 *   2. 60s 新闻服务：自建 Docker，loopback 4399。健康检查失败时按
 *      「容器在 → start/restart；容器不在 → 有镜像就 run，没镜像先 pull」自愈。
 *      60s 挂了不会阻塞鱼启动（新闻按单源降级），但必须大声告警。
 *
 * 所有外部动作都可注入，测试用假的 exec/health/sleep 跑分支。
 */
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

export interface ExecResult {
  status: number | null;
  stdout: string;
  stderr: string;
}

export type Exec = (command: string, args: string[]) => ExecResult;

export const defaultExec: Exec = (command, args) =>
  spawnSync(command, args, { encoding: "utf8" });

/** docker 命令单独加超时：镜像拉不动时不能让部署无限挂住。 */
const DOCKER_TIMEOUT_MS = 120_000;
const dockerExec: Exec = (command, args) =>
  spawnSync(command, args, { encoding: "utf8", timeout: DOCKER_TIMEOUT_MS, killSignal: "SIGTERM" });

/** 读 fish.config.json 的 news.targetGroup；读不到/为空 = 新闻未启用。 */
export function newsTargetGroup(): string {
  try {
    const config = JSON.parse(readFileSync("fish.config.json", "utf8")) as {
      news?: { targetGroup?: unknown };
    };
    return typeof config.news?.targetGroup === "string" ? config.news.targetGroup.trim() : "";
  } catch {
    return "";
  }
}

/** 60s 容器 run 参数：只绑 loopback，restart always，宿主端口与容器 4399 对齐。 */
export function sixtyRunArgs(container: string, image: string, hostPort: number): string[] {
  return [
    "run",
    "-d",
    "--name",
    container,
    "--restart",
    "always",
    "-p",
    `127.0.0.1:${hostPort}:4399`,
    image,
  ];
}

/** 找一个可用的 docker：优先显式 DOCKER_BIN，其次 mac 上两个常见绝对路径，最后 PATH。 */
export function findDocker(exec: Exec = defaultExec, env: NodeJS.ProcessEnv = process.env): string | undefined {
  const candidates = [env["DOCKER_BIN"], "/usr/local/bin/docker", "/opt/homebrew/bin/docker", "docker"].filter(
    (candidate): candidate is string => typeof candidate === "string" && candidate.length > 0,
  );
  for (const candidate of candidates) {
    if (candidate.includes("/")) {
      if (existsSync(candidate)) return candidate;
      continue;
    }
    if (exec(candidate, ["--version"]).status === 0) return candidate;
  }
  return undefined;
}

/** 健康检查：GET /health，2s 超时；任何异常都算不可用。 */
export async function sixtyHealth(baseUrl: string): Promise<boolean> {
  const base = baseUrl.replace(/\/+$/, "");
  // 自建 60s 有 /health；官方公共实例没有 /health，退到数据面 /v2/60s。
  for (const path of ["/health", "/v2/60s"]) {
    try {
      const response = await fetch(`${base}${path}`, { signal: AbortSignal.timeout(2_000) });
      if (response.ok) return true;
    } catch {
      // 试下一个端点
    }
  }
  return false;
}

export interface SixtyOptions {
  baseUrl?: string;
  container?: string;
  image?: string;
  exec?: Exec;
  health?: (url: string) => Promise<boolean>;
  sleep?: (ms: number) => Promise<void>;
  log?: (message: string) => void;
  /** 显式指定 docker 路径；null = 明确没有 docker（测试用）；缺省自动探测。 */
  docker?: string | null;
  /** 健康检查最多等多久（毫秒）。 */
  waitMs?: number;
}

/**
 * 确保 60s 可用。返回 true = 现在健康；false = 没拉起来（调用方告警，不阻塞鱼）。
 * 顺序：健康 → 容器 running 就 restart，stopped 就 start；容器不存在 → 镜像存在就直接 run，
 * 镜像不存在先 pull。所有 docker 命令失败都返回 false，不抛。
 */
export async function ensureSixtyService(options: SixtyOptions = {}): Promise<boolean> {
  const baseUrl = options.baseUrl ?? process.env["SIXTY_BASE_URL"] ?? "http://127.0.0.1:4399";
  const container = options.container ?? process.env["SIXTY_CONTAINER"] ?? "60s";
  const image = options.image ?? process.env["SIXTY_IMAGE"] ?? "vikiboss/60s";
  const exec = options.exec ?? dockerExec;
  const health = options.health ?? sixtyHealth;
  const sleep = options.sleep ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
  const log = options.log ?? ((message: string) => console.log(`[deps] ${message}`));
  const waitMs = options.waitMs ?? 30_000;

  if (await health(baseUrl)) {
    log(`60s 已就绪：${baseUrl}`);
    return true;
  }

  // 外部 60s（例如公共实例）不由本机 Docker 管：不可达就告警，不去 pull/run。
  const host = (() => {
    try {
      return new URL(baseUrl).hostname;
    } catch {
      return "";
    }
  })();
  const local = host === "127.0.0.1" || host === "localhost" || host === "::1";
  if (!local) {
    log(`外部 60s 不可达，跳过本地容器：${baseUrl}`);
    return false;
  }

  const docker = options.docker === null ? undefined : options.docker ?? findDocker(exec);
  if (docker === undefined) {
    log("60s 不可用，且找不到 docker；新闻会按单源降级");
    return false;
  }

  const run = (args: string[]): ExecResult => exec(docker, args);
  const inspect = run(["inspect", "-f", "{{.State.Running}}", container]);
  if (inspect.status === 0) {
    const running = inspect.stdout.trim() === "true";
    log(`60s 容器存在但${running ? "健康检查失败，重启" : "未运行，启动"}：${container}`);
    const action = run([running ? "restart" : "start", container]);
    if (action.status !== 0) {
      log(`60s 容器启动失败：${action.stderr.trim() || action.stdout.trim()}`);
      return false;
    }
  } else {
    if (run(["image", "inspect", image]).status !== 0) {
      log(`60s 镜像不存在，拉取：${image}`);
      const pull = run(["pull", image]);
      if (pull.status !== 0) {
        log(`60s 镜像拉取失败：${pull.stderr.trim() || pull.stdout.trim()}`);
        return false;
      }
    }
    const port = Number(new URL(baseUrl).port || "4399");
    const hostPort = Number.isInteger(port) && port > 0 ? port : 4399;
    log(`创建 60s 容器：${container} ← ${image}`);
    const created = run(sixtyRunArgs(container, image, hostPort));
    if (created.status !== 0) {
      log(`60s 容器创建失败：${created.stderr.trim() || created.stdout.trim()}`);
      return false;
    }
  }

  for (let waited = 0; waited < waitMs; waited += 1_000) {
    await sleep(1_000);
    if (await health(baseUrl)) {
      log(`60s 已就绪：${baseUrl}`);
      return true;
    }
  }
  log(`60s 等待 ${Math.round(waitMs / 1000)}s 仍未健康：${baseUrl}`);
  return false;
}

/** package-lock 摘要（写进 var/.deps-lock，锁文件没变就不重复 npm install）。 */
function lockHash(): string {
  return createHash("sha256").update(readFileSync("package-lock.json", "utf8")).digest("hex");
}

/**
 * 确保 Node 依赖与 package-lock 对齐。
 * 返回 false = npm install 失败，部署应中止（旧鱼还在跑）。
 */
export function ensureNodeDeps(options: { exec?: Exec; log?: (message: string) => void } = {}): boolean {
  const exec = options.exec ?? defaultExec;
  const log = options.log ?? ((message: string) => console.log(`[deps] ${message}`));
  const marker = join("var", ".deps-lock");
  const hash = lockHash();
  try {
    if (existsSync("node_modules") && existsSync(marker) && readFileSync(marker, "utf8").trim() === hash) {
      log("Node 依赖已是最新（package-lock 未变）");
      return true;
    }
  } catch {
    // marker 读失败就当没有，继续 install
  }

  log("安装 Node 依赖：npm install --omit=dev");
  const installed = exec("npm", ["install", "--omit=dev", "--no-audit", "--no-fund"]);
  if (installed.status !== 0) {
    log(`Node 依赖安装失败：${installed.stderr.trim() || installed.stdout.trim()}`);
    return false;
  }
  try {
    mkdirSync("var", { recursive: true });
    writeFileSync(marker, hash);
  } catch {
    // marker 写不进去只影响下次跳过，不影响本次
  }
  return true;
}

/** 部署前置：Node 依赖失败即中止；60s 失败只告警。 */
export async function ensureDeployDeps(): Promise<{ nodeDeps: boolean; sixty: boolean }> {
  const nodeDeps = ensureNodeDeps();
  if (!nodeDeps) return { nodeDeps, sixty: false };
  if (newsTargetGroup().length === 0) {
    console.log("[deps] 新闻未配置 targetGroup，跳过 60s");
    return { nodeDeps, sixty: true };
  }
  const sixty = await ensureSixtyService();
  return { nodeDeps, sixty };
}
