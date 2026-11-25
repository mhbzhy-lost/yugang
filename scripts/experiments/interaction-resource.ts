/**
 * interaction-resource.ts —— 鱼 drawEnabled 热开关租约（G0 关闭 / G1 恢复）
 *
 * 方案：docs/plans/2026-11-11-anima-interaction-study.md §1/§2 G0-G1、§9 F10、§10。
 * 机制（2026-11-11 主人改定，取代旧 COMFYUI_URL 空值重启法）：fish.config.json 的受控字段
 *   drawEnabled:boolean（缺省 true、effect=hot）；runtime 在每次 draw 执行与 onSubmitted 前经
 *   现有 fishConfig loader 现读（生产 hot getter 链由另一变更落地）。本 helper 只做该键的
 *   键级读改写 + 租约证据，**不重启鱼、不 spawn/kill、不轮询横幅、不读写 .env、不碰服务/deploy**。
 *
 * 安全边界：
 * - 仓库根只认 --repo-root（脚本可能 SCP 暂存到 run-root）；bootstrap 后校验 src/paths.ts::REPO_ROOT
 *   一致，配置路径取 paths.ts::FISH_CONFIG_PATH，PID 取 scripts/lib/pidfile.ts，字段/loader 取
 *   src/fish-config.ts（纯配置模块）；绝不 import runtime/index。
 * - preflight 保存原键（是否存在 + 布尔值）、当前 PID、部署版本(git HEAD)、配置 sha256 锚；原键
 *   非布尔（非法）即拒绝，不猜原状态。drawEnabled 未在 FISH_CONFIG_FIELDS 声明为 hot 即拒绝
 *   （hot getter 链未上线，写也是惰键，不能假称已禁用）。
 * - off 先持久化 state=disabling 再原子改 drawEnabled=false（保留其余字段），写前 TOCTOU 复核
 *   读入 hash，遇并发更改拒绝且不回滚整份旧配置；记录时间/PID/部署版本/前后 hash。
 * - status 输出 runner 机器可消费的 gate.gateIntact：要求 hot 版本已上线（field.effect=hot 且
 *   HEAD==部署版本[==--expected-commit]）、shared loader 值 false、同 repo 唯一鱼且 PID 未漂移、
 *   当前原始键 false、租约 disabled——不只看租约自报。
 * - restore 仅在校验新鲜已闭合证明（queueIdle/experimentJobsClosed/openJobIds=[]、attestedAt 晚于
 *   off 且 ≤120s、attestedBy 非空）后，按原键恢复（absent→删本次新增键、true/false→还原同布尔），
 *   保留其余配置、PID 不变；任何字段/进程/版本漂移或未知/在途作业 → fail closed，不盲恢复。
 * - 未知/进行中（disabling/restoring）租约不覆写；状态写配置前先持久化，中断后不会被当成从未禁用。
 */
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { closeSync, existsSync, mkdirSync, openSync, readFileSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const LEASE_VERSION = 1;
/** 已闭合证明新鲜度上限：attestedAt 距当前超过此值即视为陈旧（CLI 契约，runner 接口）。 */
const PROOF_MAX_AGE_MS = 120_000;
const DRAW_KEY = "drawEnabled";

const nowIso = (): string => new Date().toISOString();
const sha256 = (s: string): string => createHash("sha256").update(s).digest("hex");

class CliError extends Error {
  code: number;
  constructor(message: string, code: number = 2) {
    super(message);
    this.name = "CliError";
    this.code = code;
  }
}

// ---------------------------------------------------------------------------
// CLI 契约
// ---------------------------------------------------------------------------
type Action = "preflight" | "off" | "status" | "restore";
interface Args {
  action: Action;
  repoRoot: string;
  runRoot: string;
  confirmProduction: boolean;
  jobsClosed?: string;
  expectedCommit?: string;
  help: boolean;
}

const USAGE = `interaction-resource.ts —— 鱼 drawEnabled 热开关租约（方案 §2 G0/G1、§9 F10）

用法：
  node <本脚本路径> <action> --repo-root <abs> --run-root <abs> [options]
  脚本可被 SCP 暂存到 run-root；仓库根只认 --repo-root，绝不按脚本自身相对路径推导。
  纯配置键读改写：不重启鱼、不 spawn/kill、不读写 .env、不碰服务/deploy。

actions：
  preflight  只读核实 + 存原状态：drawEnabled 原键（存在?/布尔值）、当前唯一鱼 PID、部署版本
             (git HEAD)、配置 sha256 锚；校验 drawEnabled 已声明为 hot 字段。原键非布尔即拒绝。
  off        G0：先持久化 state=disabling，再原子改 drawEnabled=false（保留其余字段、PID 不变），
             写前 TOCTOU 复核 hash。需 --confirm-production。
  status     只读：输出 gate.gateIntact 供 runner 机械消费（不只看租约自报）。
  restore    G1：校验新鲜已闭合证明后按原键恢复（absent→删键、true/false→还原），PID 不变。
             需 --confirm-production。任何漂移/在途作业 → fail closed。

options：
  --repo-root <abs>       必填。生产仓库根（含 src/paths.ts、src/fish-config.ts、
                          scripts/lib/pidfile.ts、fish.config.json）。
  --run-root <abs>        必填。租约/锁/证据目录（resource-lease.json 写这里）。
  --confirm-production    off/restore 必填。确认在生产 Mac 上执行。
  --jobs-closed <path>    restore 的已闭合证明；缺省 <run-root>/jobs-closed.json。
  --expected-commit <sha> 可选。给定则 preflight/off/status/restore 校验 git HEAD 与之相符，
                          锚定「已上线 hot 版本」；不符即 fail closed。
  -h, --help              打印本帮助（不触碰仓库/配置/进程）。

已闭合证明契约（restore 必需，JSON；下游 runner 产出，本脚本不联网、不自造队列证明）：
  { "queueIdle": true, "experimentJobsClosed": true, "openJobIds": [],
    "attestedAt": "<ISO8601，须晚于本租约 off 且距当前 ≤120s>", "attestedBy": "<非空 runner 标识>" }

退出码：0 成功/幂等；2 用法或安全闸拒绝；3 生命周期/漂移失败（详见 stderr 与 resource-lease.json）。
`;

function parseArgs(argv: string[]): Args {
  const rest = argv.slice(2);
  if (rest.includes("--help") || rest.includes("-h")) return { action: "preflight", repoRoot: "", runRoot: "", confirmProduction: false, help: true };
  const action = rest[0];
  if (!action || action.startsWith("-")) throw new CliError(`缺少 action（preflight|off|status|restore）。\n\n${USAGE}`);
  if (!["preflight", "off", "status", "restore"].includes(action)) throw new CliError(`未知 action「${action}」。\n\n${USAGE}`);
  const opt = (name: string): string | undefined => {
    const i = rest.indexOf(name);
    if (i < 0) return undefined;
    const v = rest[i + 1];
    if (v === undefined || v.startsWith("--")) throw new CliError(`${name} 需要一个值`);
    return v;
  };
  const repoRoot = opt("--repo-root");
  const runRoot = opt("--run-root");
  if (!repoRoot) throw new CliError(`--repo-root 必填。\n\n${USAGE}`);
  if (!runRoot) throw new CliError(`--run-root 必填。\n\n${USAGE}`);
  return { action: action as Action, repoRoot: resolve(repoRoot), runRoot: resolve(runRoot), confirmProduction: rest.includes("--confirm-production"), jobsClosed: opt("--jobs-closed"), expectedCommit: opt("--expected-commit"), help: false };
}

// ---------------------------------------------------------------------------
// bootstrap：从显式 --repo-root 动态取事实源（paths/pidfile/fish-config 均纯模块），校验一致
// ---------------------------------------------------------------------------
interface Ctx {
  REPO_ROOT: string;
  configPath: string;
  pidFile: string;
  fields: ReadonlyArray<{ name: string; effect: string }>;
  loadFishConfig: (o: { path?: string }) => { config: Record<string, unknown> };
}
async function bootstrap(repoRoot: string): Promise<Ctx> {
  for (const rel of ["src/paths.ts", "src/fish-config.ts", "scripts/lib/pidfile.ts", "fish.config.json"]) {
    if (!existsSync(join(repoRoot, rel))) throw new CliError(`--repo-root「${repoRoot}」不像本仓库根：缺 ${rel}`);
  }
  const paths = (await import(pathToFileURL(join(repoRoot, "src", "paths.ts")).href)) as { REPO_ROOT: string; FISH_CONFIG_PATH: string };
  const pidmod = (await import(pathToFileURL(join(repoRoot, "scripts", "lib", "pidfile.ts")).href)) as { pidFilePath: () => string };
  const cfg = (await import(pathToFileURL(join(repoRoot, "src", "fish-config.ts")).href)) as {
    FISH_CONFIG_FIELDS: ReadonlyArray<{ name: string; effect: string }>;
    loadFishConfig: (o: { path?: string }) => { config: Record<string, unknown> };
  };
  if (resolve(paths.REPO_ROOT) !== resolve(repoRoot)) throw new CliError(`路径事实源不一致：paths.ts::REPO_ROOT=${paths.REPO_ROOT} 与 --repo-root=${repoRoot}（检查 YUGANG_ROOT）`);
  return { REPO_ROOT: paths.REPO_ROOT, configPath: paths.FISH_CONFIG_PATH, pidFile: pidmod.pidFilePath(), fields: cfg.FISH_CONFIG_FIELDS, loadFishConfig: cfg.loadFishConfig };
}

// ---------------------------------------------------------------------------
// 进程核验（只读；镜像 down.ts 的 isOurFish，唯一性用 pgrep 兜出同 repo 多条鱼）
// ---------------------------------------------------------------------------
function alive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}
function commandOf(pid: number): string {
  return (spawnSync("ps", ["-p", String(pid), "-o", "command="], { encoding: "utf8" }).stdout ?? "").trim();
}
function cwdOf(pid: number): string {
  const out = spawnSync("lsof", ["-a", "-p", String(pid), "-d", "cwd", "-Fn"], { encoding: "utf8" }).stdout ?? "";
  for (const line of out.split("\n")) if (line.startsWith("n")) return line.slice(1);
  return "";
}
function isOurFish(pid: number, repoRoot: string): boolean {
  const cmd = commandOf(pid);
  const head = cmd.split(" ")[0] ?? "";
  return cmd.endsWith("src/index.ts") && cmd.includes("--env-file-if-exists=.env") && head.endsWith("node") && cwdOf(pid) === repoRoot;
}
function findFishByPgrep(repoRoot: string): number[] {
  // 预筛兼容相对与绝对 src/index.ts（deploy 用绝对路径）；精确判定交给 isOurFish。
  const out = spawnSync("pgrep", ["-f", "--env-file-if-exists=\\.env.*src/index\\.ts"], { encoding: "utf8" }).stdout ?? "";
  return out
    .split("\n")
    .map((l) => Number(l.trim()))
    .filter((pid) => Number.isInteger(pid) && pid > 0 && pid !== process.pid)
    .filter((pid) => isOurFish(pid, repoRoot));
}
type Located = { pid: number; source: "pidfile" | "pgrep"; command: string };
type LocateResult = { ok: true; fish: Located } | { ok: false; reason: string };
function locateFish(pidFile: string, repoRoot: string): LocateResult {
  if (existsSync(pidFile)) {
    const pid = Number(readFileSync(pidFile, "utf8").trim());
    if (Number.isInteger(pid) && pid > 0) {
      if (!alive(pid)) return { ok: false, reason: `up.pid 的 pid ${pid} 已不在（陈旧）` };
      if (!isOurFish(pid, repoRoot)) return { ok: false, reason: `up.pid 的 pid ${pid} 不是本仓库鱼（命令「${commandOf(pid) || "读不到"}」/cwd「${cwdOf(pid) || "读不到"}」）——疑似 PID 重用/外部管理器` };
      const others = findFishByPgrep(repoRoot).filter((p) => p !== pid);
      if (others.length > 0) return { ok: false, reason: `up.pid=${pid} 有效但 pgrep 另发现同仓库鱼 ${others.join(" ")}——不唯一` };
      return { ok: true, fish: { pid, source: "pidfile", command: commandOf(pid) } };
    }
    return { ok: false, reason: "up.pid 内容异常" };
  }
  const pids = findFishByPgrep(repoRoot);
  if (pids.length === 0) return { ok: false, reason: "没有本仓库鱼进程（up.pid 缺失且 pgrep 无命中）" };
  if (pids.length > 1) return { ok: false, reason: `pgrep 命中多个本仓库鱼（${pids.join(" ")}）——不唯一` };
  return { ok: true, fish: { pid: pids[0]!, source: "pgrep", command: commandOf(pids[0]!) } };
}
function gitHead(repoRoot: string): string | null {
  const out = spawnSync("git", ["-C", repoRoot, "rev-parse", "HEAD"], { encoding: "utf8" });
  const h = (out.stdout ?? "").trim();
  return out.status === 0 && /^[0-9a-f]{40}$/.test(h) ? h : null;
}

// ---------------------------------------------------------------------------
// 配置键级读改写（只动 drawEnabled，保留其余字段；TOCTOU 复核 hash）
// ---------------------------------------------------------------------------
type KeyState = "absent" | "true" | "false" | "invalid";
function drawEnabledState(parsed: Record<string, unknown>): KeyState {
  if (!(DRAW_KEY in parsed)) return "absent";
  const v = parsed[DRAW_KEY];
  return v === true ? "true" : v === false ? "false" : "invalid";
}
type ConfigFacts = { ok: true; sha256: string; parsed: Record<string, unknown>; key: KeyState } | { ok: false; reason: string };
function readConfigFacts(path: string): ConfigFacts {
  const text = existsSync(path) ? readFileSync(path, "utf8") : "";
  const sum = sha256(text);
  if (text.trim() === "") return { ok: true, sha256: sum, parsed: {}, key: "absent" };
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch (e) {
    return { ok: false, reason: `fish.config.json 解析失败：${e instanceof Error ? e.message : String(e)}` };
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return { ok: false, reason: "fish.config.json 不是对象" };
  const obj = parsed as Record<string, unknown>;
  return { ok: true, sha256: sum, parsed: obj, key: drawEnabledState(obj) };
}
/** 原子写：仅改 drawEnabled（target=false 禁用；"restore" 按 originalKey 还原），保留其余字段。
 *  写前重读 hash 与 expected 不符 → 并发更改，拒绝且不回滚整份旧配置。 */
function writeDrawEnabled(path: string, parsed: Record<string, unknown>, target: false | "restore", originalKey: KeyState, expectedHash: string): { ok: true; newHash: string } | { ok: false; reason: string } {
  const curText = existsSync(path) ? readFileSync(path, "utf8") : "";
  if (sha256(curText) !== expectedHash) return { ok: false, reason: "并发配置更改（写前 hash 与读入不符），拒绝写入，不回滚旧配置" };
  const obj: Record<string, unknown> = { ...parsed };
  if (target === false) obj[DRAW_KEY] = false;
  else if (originalKey === "absent") delete obj[DRAW_KEY];
  else obj[DRAW_KEY] = originalKey === "true";
  const newText = JSON.stringify(obj, null, 2) + "\n";
  const tmp = `${path}.tmp`;
  writeFileSync(tmp, newText);
  renameSync(tmp, path);
  return { ok: true, newHash: sha256(newText) };
}
function fieldEffect(ctx: Ctx): string | undefined {
  return ctx.fields.find((f) => f.name === DRAW_KEY)?.effect;
}
function loaderValue(ctx: Ctx): unknown {
  try {
    return ctx.loadFishConfig({ path: ctx.configPath }).config[DRAW_KEY];
  } catch {
    return undefined;
  }
}

// ---------------------------------------------------------------------------
// 并发锁 + 租约 IO
// ---------------------------------------------------------------------------
function acquireLock(runRoot: string, action: Action): (() => void) | null {
  mkdirSync(runRoot, { recursive: true });
  const lockPath = join(runRoot, ".interaction-resource.lock");
  const payload = JSON.stringify({ pid: process.pid, action, at: nowIso() });
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const fd = openSync(lockPath, "wx");
      writeFileSync(fd, payload);
      closeSync(fd);
      let released = false;
      return () => {
        if (released) return;
        released = true;
        try {
          unlinkSync(lockPath);
        } catch {}
      };
    } catch (e) {
      if ((e as { code?: string }).code !== "EEXIST") throw e;
      let ownerPid = -1;
      try {
        ownerPid = Number(JSON.parse(readFileSync(lockPath, "utf8")).pid);
      } catch {}
      if (Number.isInteger(ownerPid) && ownerPid > 0 && ownerPid !== process.pid && !alive(ownerPid)) {
        try {
          unlinkSync(lockPath);
        } catch {}
        continue;
      }
      return null;
    }
  }
  return null;
}
interface Lease {
  version: number;
  repoRoot: string;
  runRoot: string;
  configPath: string;
  createdAt: string;
  state: "preflighted" | "disabling" | "disabled" | "restoring" | "restored" | "failed";
  closed: boolean;
  originalKey: KeyState; // off 前 drawEnabled 的原状态（absent/true/false）
  deployCommit: string; // off 时 git HEAD（部署版本锚）
  preflight?: { pid: number; configSha256: string; deployCommit: string; at: string };
  off?: { pid: number; configSha256Before: string; configSha256After: string; at: string };
  restore?: { pid: number; configSha256After: string; restoredKey: KeyState; at: string; jobsClosedProofSha256?: string };
  controllable: boolean;
  blockedReason?: string;
  notes?: string[];
  __unknown?: boolean;
}
const leasePath = (runRoot: string): string => join(runRoot, "resource-lease.json");
function readLease(runRoot: string): Lease | null {
  const p = leasePath(runRoot);
  if (!existsSync(p)) return null;
  try {
    const doc = JSON.parse(readFileSync(p, "utf8")) as Lease;
    if (doc && doc.version === LEASE_VERSION) return doc;
  } catch {}
  return { version: 0, repoRoot: "", runRoot: "", configPath: "", createdAt: "", state: "failed", closed: false, originalKey: "invalid", deployCommit: "", controllable: false, __unknown: true };
}
function writeLease(runRoot: string, lease: Lease): void {
  mkdirSync(runRoot, { recursive: true });
  const p = leasePath(runRoot);
  const tmp = `${p}.tmp`;
  writeFileSync(tmp, JSON.stringify(lease, null, 2));
  renameSync(tmp, p);
}
function archiveClosedLease(runRoot: string, lease: Lease): string {
  const dest = join(runRoot, `resource-lease.closed-${(lease.createdAt || nowIso()).replace(/[:.]/g, "-")}.json`);
  writeFileSync(dest, JSON.stringify(lease, null, 2));
  return dest;
}

// ---------------------------------------------------------------------------
// 已闭合证明校验（runner 接口；不联网、不自造队列结果）
// ---------------------------------------------------------------------------
function validateJobsClosed(path: string, offAt?: string): { ok: boolean; reason?: string; sha256?: string } {
  if (!existsSync(path)) return { ok: false, reason: `缺少已闭合证明：${path}（下游 runner 须先产出，见 --help 契约）` };
  let raw: string;
  try {
    raw = readFileSync(path, "utf8");
  } catch {
    return { ok: false, reason: `证明文件不可读：${path}` };
  }
  const sum = sha256(raw);
  let d: Record<string, unknown>;
  try {
    d = JSON.parse(raw) as Record<string, unknown>;
  } catch {
    return { ok: false, reason: "证明文件不是合法 JSON", sha256: sum };
  }
  if (d["queueIdle"] !== true) return { ok: false, reason: "queueIdle != true", sha256: sum };
  if (d["experimentJobsClosed"] !== true) return { ok: false, reason: "experimentJobsClosed != true", sha256: sum };
  const open = d["openJobIds"];
  if (!Array.isArray(open) || open.length > 0) return { ok: false, reason: `openJobIds 非空（${Array.isArray(open) ? open.length : "非数组"} 个在途/未知作业）`, sha256: sum };
  const by = d["attestedBy"];
  if (typeof by !== "string" || by.trim() === "") return { ok: false, reason: "attestedBy 缺失或为空", sha256: sum };
  const atMs = typeof d["attestedAt"] === "string" ? Date.parse(d["attestedAt"]) : NaN;
  if (!Number.isFinite(atMs)) return { ok: false, reason: "attestedAt 缺失或不是可解析时间", sha256: sum };
  if (offAt) {
    const offMs = Date.parse(offAt);
    if (Number.isFinite(offMs) && atMs <= offMs) return { ok: false, reason: `attestedAt(${d["attestedAt"]}) 不晚于本租约 off(${offAt})——疑似旧证明`, sha256: sum };
  }
  const age = Date.now() - atMs;
  if (age < 0) return { ok: false, reason: "attestedAt 在未来，拒绝", sha256: sum };
  if (age > PROOF_MAX_AGE_MS) return { ok: false, reason: `attestedAt 距当前 ${(age / 1000).toFixed(0)}s > ${PROOF_MAX_AGE_MS / 1000}s（陈旧），拒绝当当前证明`, sha256: sum };
  return { ok: true, sha256: sum };
}

// ---------------------------------------------------------------------------
// 共用核验：hot 字段已上线 + --expected-commit + 定位唯一鱼
// ---------------------------------------------------------------------------
function verifyHotAndCommit(args: Args, ctx: Ctx): { commit: string | null } {
  if (fieldEffect(ctx) !== "hot") throw new CliError(`${DRAW_KEY} 未在 FISH_CONFIG_FIELDS 声明为 hot（当前 effect=${fieldEffect(ctx) ?? "未声明"}）——生产 hot getter 链未上线，写也是惰键，拒绝（不能假称已禁用）`, 2);
  const commit = gitHead(ctx.REPO_ROOT);
  if (args.expectedCommit) {
    if (!commit) throw new CliError(`无法读取 git HEAD（--expected-commit=${args.expectedCommit} 无法核验），fail closed`, 2);
    if (commit !== args.expectedCommit) throw new CliError(`部署版本漂移：git HEAD=${commit} != --expected-commit=${args.expectedCommit}，fail closed`, 2);
  }
  return { commit };
}

// ---------------------------------------------------------------------------
// actions
// ---------------------------------------------------------------------------
function baseLease(ctx: Ctx, args: Args, originalKey: KeyState, commit: string | null): Lease {
  return { version: LEASE_VERSION, repoRoot: ctx.REPO_ROOT, runRoot: args.runRoot, configPath: ctx.configPath, createdAt: nowIso(), state: "preflighted", closed: false, originalKey, deployCommit: commit ?? "unknown", controllable: true, notes: [] };
}

function doPreflight(args: Args, ctx: Ctx): number {
  const release = acquireLock(args.runRoot, "preflight");
  if (!release) throw new CliError("run-root 已有活跃并发锁，另一个 interaction-resource 在跑，拒绝");
  try {
    const existing = readLease(args.runRoot);
    const cfg = readConfigFacts(ctx.configPath);
    if (!cfg.ok) throw new CliError(`读取配置失败：${cfg.reason}`, 2);
    if (cfg.key === "invalid") throw new CliError(`原 ${DRAW_KEY} 键存在但不是布尔——拒绝，不猜原状态（请人工核查 fish.config.json）`, 2);
    const { commit } = verifyHotAndCommit(args, ctx);
    const located = locateFish(ctx.pidFile, ctx.REPO_ROOT);
    if (!located.ok) {
      if (!existing) writeLease(args.runRoot, { ...baseLease(ctx, args, cfg.key, commit), controllable: false, blockedReason: located.reason });
      console.error(`[preflight] ✗ 无法定位唯一本仓库鱼：${located.reason}`);
      return 2;
    }
    console.log(`[preflight] 仓库根 ${ctx.REPO_ROOT}（paths.ts 校验一致）；配置 ${ctx.configPath}`);
    console.log(`[preflight] ${DRAW_KEY} 原键=${cfg.key}（缺省视为 true）；effect=hot 已声明；部署版本 ${commit ?? "unknown"}`);
    console.log(`[preflight] 当前鱼 pid ${located.fish.pid}（来源 ${located.fish.source}）；配置 sha256 ${cfg.sha256}`);
    if (existing && existing.__unknown) {
      console.error("[preflight] ✗ resource-lease.json 无法识别（版本/解析），拒绝覆盖未知租约");
      return 2;
    }
    if (existing && !existing.closed) {
      console.log(`[preflight] 已有活跃租约 state=${existing.state}，只读报告、不覆盖（如需继续请先 status/restore）`);
      return 0;
    }
    if (existing && existing.closed) console.log(`[preflight] 归档上一轮闭合租约 → ${archiveClosedLease(args.runRoot, existing)}`);
    const lease = baseLease(ctx, args, cfg.key, commit);
    lease.preflight = { pid: located.fish.pid, configSha256: cfg.sha256, deployCommit: commit ?? "unknown", at: nowIso() };
    writeLease(args.runRoot, lease);
    console.log(`[preflight] ✓ 写入初始租约 ${leasePath(args.runRoot)}（state=preflighted）`);
    return 0;
  } finally {
    release();
  }
}

function doOff(args: Args, ctx: Ctx): number {
  if (!args.confirmProduction) throw new CliError("off 会改生产 fish.config.json（禁用 draw），必须显式加 --confirm-production");
  const release = acquireLock(args.runRoot, "off");
  if (!release) throw new CliError("run-root 已有活跃并发锁，另一个 interaction-resource 在跑，拒绝");
  try {
    let lease = readLease(args.runRoot);
    if (lease && lease.__unknown) throw new CliError("resource-lease.json 无法识别，拒绝覆盖未知租约");
    if (lease && lease.state === "failed") throw new CliError("上次租约 failed，请先人工核查（status/restore），拒绝在其上 off");
    if (lease && (lease.state === "disabling" || lease.state === "restoring")) throw new CliError(`租约进行中 state=${lease.state}（上次未完成/崩溃），drawEnabled 状态未定，拒绝覆盖；请先 status 核查`, 2);
    if (lease && lease.state === "disabled" && !lease.closed) {
      const cfg = readConfigFacts(ctx.configPath);
      const located = locateFish(ctx.pidFile, ctx.REPO_ROOT);
      if (cfg.ok && cfg.key === "false" && located.ok && lease.off && located.fish.pid === lease.off.pid) {
        console.log(`[off] 已禁用（${DRAW_KEY}=false，鱼 pid ${lease.off.pid} 未变），幂等无操作`);
        return 0;
      }
      throw new CliError(`租约 disabled 但当前状态不符（key=${cfg.ok ? cfg.key : "?"}，pid=${located.ok ? located.fish.pid : "?"}，租约 pid=${lease.off?.pid}）——漂移，拒绝盲目再 off`, 2);
    }
    if (lease && lease.closed) {
      console.log(`[off] 归档上一轮闭合租约 → ${archiveClosedLease(args.runRoot, lease)}`);
      lease = null;
    }

    const cfg = readConfigFacts(ctx.configPath);
    if (!cfg.ok) throw new CliError(`读取配置失败：${cfg.reason}`, 3);
    if (cfg.key === "invalid") throw new CliError(`原 ${DRAW_KEY} 键非布尔，拒绝不猜原状态`, 2);
    const { commit } = verifyHotAndCommit(args, ctx);
    const located = locateFish(ctx.pidFile, ctx.REPO_ROOT);
    if (!located.ok) throw new CliError(`无法定位唯一本仓库鱼：${located.reason}`, 2);

    // 与 preflight 锚一致核验（字段/进程/版本漂移 → fail closed，不盲禁用）
    if (lease && lease.state === "preflighted" && lease.preflight) {
      const p = lease.preflight;
      if (cfg.sha256 !== p.configSha256) throw new CliError(`配置自 preflight 后被改动（sha256 ${p.configSha256}→${cfg.sha256}），拒绝；请重跑 preflight`, 2);
      if (located.fish.pid !== p.pid) throw new CliError(`鱼 PID 自 preflight 后漂移（${p.pid}→${located.fish.pid}），拒绝；请重跑 preflight`, 2);
      if ((commit ?? "unknown") !== p.deployCommit) throw new CliError(`部署版本自 preflight 后漂移（${p.deployCommit}→${commit ?? "unknown"}），拒绝；请重跑 preflight`, 2);
    }
    if (!lease) lease = baseLease(ctx, args, cfg.key, commit);
    lease.originalKey = cfg.key;
    lease.deployCommit = commit ?? "unknown";
    lease.controllable = true;
    delete lease.blockedReason;

    // ★ 写配置前先持久化进行中状态（中断后不会被当成从未禁用）
    lease.state = "disabling";
    lease.preflight = { pid: located.fish.pid, configSha256: cfg.sha256, deployCommit: commit ?? "unknown", at: nowIso() };
    writeLease(args.runRoot, lease);

    const before = cfg.sha256;
    const w = writeDrawEnabled(ctx.configPath, cfg.parsed, false, cfg.key, before);
    if (!w.ok) {
      lease.state = "failed";
      lease.notes = [...(lease.notes ?? []), `off 写入被拒：${w.reason}（配置未改，仍为原状态）`];
      writeLease(args.runRoot, lease);
      throw new CliError(`${w.reason}；配置未改，租约记 failed，请重跑 preflight+off`, 3);
    }
    lease.state = "disabled";
    lease.closed = false;
    lease.off = { pid: located.fish.pid, configSha256Before: before, configSha256After: w.newHash, at: nowIso() };
    writeLease(args.runRoot, lease);
    console.log(`[off] ✓ ${DRAW_KEY}=false 已原子写入（鱼 pid ${located.fish.pid} 不变，热生效）；原键=${cfg.key}，配置 sha256 ${before}→${w.newHash}`);
    console.log("[off] 下一步：runner 核实 ComfyUI 队列空闲 + 实验作业闭合后产出 jobs-closed 证明，再 restore（本脚本不联网、不声称队列独占）");
    return 0;
  } finally {
    release();
  }
}

function doStatus(args: Args, ctx: Ctx): number {
  const lease = readLease(args.runRoot);
  const cfg = readConfigFacts(ctx.configPath);
  const located = locateFish(ctx.pidFile, ctx.REPO_ROOT);
  const fish = located.ok ? located.fish : null;
  const commit = gitHead(ctx.REPO_ROOT);
  const effect = fieldEffect(ctx);
  const loader = loaderValue(ctx);
  const disabledActive = !!lease && !lease.__unknown && lease.state === "disabled" && !lease.closed && lease.off !== undefined;
  const inProgress = !!lease && !lease.__unknown && (lease.state === "disabling" || lease.state === "restoring");

  const checks = {
    leaseDisabled: disabledActive,
    fieldEffectHot: effect === "hot",
    loaderValueFalse: loader === false,
    rawKeyFalse: cfg.ok && cfg.key === "false",
    fishUnique: located.ok,
    pidNoDrift: !!(fish && lease?.off && fish.pid === lease.off.pid),
    commitNoDrift: !!(lease && (commit ?? "unknown") === lease.deployCommit),
    expectedCommitOk: args.expectedCommit ? commit === args.expectedCommit : true,
    configNoDrift: !!(cfg.ok && lease?.off && cfg.sha256 === lease.off.configSha256After),
  };
  const issues: string[] = [];
  if (!lease) issues.push("尚无租约（未 preflight/off）");
  else if (lease.__unknown) issues.push("resource-lease.json 无法识别（版本/解析）");
  else if (lease.state === "failed") issues.push(`租约 failed（${(lease.notes ?? []).join("; ")}）`);
  else if (inProgress) issues.push(`租约 ${lease.state}（进行中/上次中断）——drawEnabled 状态未定，不得当成安全，需人工核查`);
  if (!checks.fieldEffectHot) issues.push(`${DRAW_KEY} 未声明为 hot（effect=${effect ?? "未声明"}）——hot getter 链未上线`);
  if (disabledActive && !checks.loaderValueFalse) issues.push(`shared loader ${DRAW_KEY}=${String(loader)}（非 false）`);
  if (disabledActive && !checks.rawKeyFalse) issues.push(`当前原始键 ${DRAW_KEY}=${cfg.ok ? cfg.key : "读取失败"}（非 false）`);
  if (!located.ok) issues.push(`无法定位唯一本仓库鱼：${located.reason}`);
  if (disabledActive && !checks.pidNoDrift) issues.push(`鱼 PID 漂移（当前 ${fish?.pid ?? "?"} != 租约 ${lease?.off?.pid}）——可能被重启/deploy`);
  if (disabledActive && !checks.commitNoDrift) issues.push(`部署版本漂移（HEAD ${commit ?? "?"} != 租约 ${lease?.deployCommit}）——可能已 deploy`);
  if (disabledActive && !checks.configNoDrift) issues.push("配置自 off 后被改动（sha256 不符）");
  if (!checks.expectedCommitOk) issues.push(`git HEAD ${commit ?? "?"} != --expected-commit ${args.expectedCommit}`);

  const gateIntact = disabledActive && checks.fieldEffectHot && checks.loaderValueFalse && checks.rawKeyFalse && checks.fishUnique && checks.pidNoDrift && checks.commitNoDrift && checks.expectedCommitOk && checks.configNoDrift;
  console.log(
    JSON.stringify(
      {
        repoRoot: ctx.REPO_ROOT,
        configPath: ctx.configPath,
        pidFile: ctx.pidFile,
        deployCommit: commit,
        drawEnabledFieldEffect: effect ?? null,
        loaderDrawEnabled: loader === undefined ? null : loader,
        rawDrawEnabledKey: cfg.ok ? cfg.key : "read-error",
        configSha256: cfg.ok ? cfg.sha256 : null,
        currentFish: fish ? { pid: fish.pid, source: fish.source } : { pid: null, reason: located.ok ? undefined : (located as { reason: string }).reason },
        lease: lease && !lease.__unknown ? { state: lease.state, closed: lease.closed, originalKey: lease.originalKey, deployCommit: lease.deployCommit, off: lease.off ?? null, restore: lease.restore ?? null, blockedReason: lease.blockedReason ?? null } : lease ? { unknown: true } : null,
        gate: { gateIntact, checks, issues },
      },
      null,
      2,
    ),
  );
  return 0;
}

function doRestore(args: Args, ctx: Ctx): number {
  if (!args.confirmProduction) throw new CliError("restore 会改生产 fish.config.json（恢复 draw），必须显式加 --confirm-production");
  const release = acquireLock(args.runRoot, "restore");
  if (!release) throw new CliError("run-root 已有活跃并发锁，另一个 interaction-resource 在跑，拒绝");
  try {
    const lease = readLease(args.runRoot);
    if (!lease) throw new CliError(`没有租约（${leasePath(args.runRoot)}）——原状态未知，拒绝凭空 restore（应先 off）`, 2);
    if (lease.__unknown) throw new CliError("resource-lease.json 无法识别，拒绝在未知租约上 restore", 2);
    if (lease.state === "restored" && lease.closed) {
      console.log("[restore] 租约已 restored/closed，幂等无操作");
      return 0;
    }
    if (lease.state === "failed") throw new CliError("租约 failed，需人工核查（status），拒绝自动 restore", 2);
    if (lease.state === "disabling" || lease.state === "restoring") throw new CliError(`租约进行中 state=${lease.state}（上次未完成/崩溃），拒绝当成「从未禁用」直接闭合；请先 status 核查鱼 PID 与配置`, 2);

    const proofPath = args.jobsClosed ? resolve(args.jobsClosed) : join(args.runRoot, "jobs-closed.json");
    const proof = validateJobsClosed(proofPath, lease.off?.at);
    if (!proof.ok) {
      console.error(`[restore] ✗ 拒绝贸然恢复：${proof.reason}`);
      console.error(`[restore] 鱼仍处于禁用态（${DRAW_KEY}=false）。下一步：runner 核实队列空闲+作业闭合，产出新鲜（attestedAt 晚于 off 且 ≤${PROOF_MAX_AGE_MS / 1000}s）的 ${proofPath} 后重跑 restore。`);
      throw new CliError("已闭合证明未通过校验", 2);
    }

    if (lease.state === "preflighted") {
      // off 从未写配置 → drawEnabled 仍是原状态，无需改写；核验未被并发改动后闭合租约
      const cfg = readConfigFacts(ctx.configPath);
      if (cfg.ok && lease.preflight && cfg.sha256 === lease.preflight.configSha256) {
        lease.state = "restored";
        lease.closed = true;
        lease.restore = { pid: lease.preflight.pid, configSha256After: cfg.sha256, restoredKey: lease.originalKey, at: nowIso(), jobsClosedProofSha256: proof.sha256 };
        writeLease(args.runRoot, lease);
        console.log("[restore] 租约 preflighted（off 未写配置），drawEnabled 仍为原状态，无变更，闭合租约");
        return 0;
      }
      throw new CliError("preflighted 租约但配置已变动/读取失败，拒绝盲闭合；请 status 核查", 3);
    }

    // state === "disabled"：恢复前核验无任何漂移（字段/进程/版本/配置），否则 fail closed 不盲恢复
    const cfg = readConfigFacts(ctx.configPath);
    if (!cfg.ok) throw new CliError(`读取配置失败：${cfg.reason}`, 3);
    const { commit } = verifyHotAndCommit(args, ctx);
    const located = locateFish(ctx.pidFile, ctx.REPO_ROOT);
    if (!located.ok) throw new CliError(`无法定位唯一本仓库鱼：${located.reason}`, 3);
    const off = lease.off;
    if (!off) throw new CliError("租约 state=disabled 但缺 off 记录（租约损坏），拒绝盲恢复", 3);
    const drifts: string[] = [];
    if (cfg.sha256 !== off.configSha256After) drifts.push(`配置 sha256 自 off 后变动（${off.configSha256After}→${cfg.sha256}）`);
    if (cfg.key !== "false") drifts.push(`当前原始键 ${DRAW_KEY}=${cfg.key}（off 后应为 false）`);
    if (located.fish.pid !== off.pid) drifts.push(`鱼 PID 漂移（off=${off.pid}，当前=${located.fish.pid}）`);
    if ((commit ?? "unknown") !== lease.deployCommit) drifts.push(`部署版本漂移（off=${lease.deployCommit}，当前 HEAD=${commit ?? "unknown"}）`);
    if (drifts.length > 0) {
      lease.notes = [...(lease.notes ?? []), `restore 拒绝（漂移）：${drifts.join("；")}`];
      writeLease(args.runRoot, lease); // state 仍 disabled，不 closed
      throw new CliError(`检测到漂移，拒绝盲恢复：${drifts.join("；")}。鱼保持现状，请人工核查后重跑 restore`, 3);
    }

    // ★ 写配置前先持久化 restoring（中断后不会被当成从未禁用/已恢复）
    lease.state = "restoring";
    writeLease(args.runRoot, lease);
    const w = writeDrawEnabled(ctx.configPath, cfg.parsed, "restore", lease.originalKey, cfg.sha256);
    if (!w.ok) {
      lease.state = "failed";
      lease.notes = [...(lease.notes ?? []), `restore 写入被拒：${w.reason}`];
      writeLease(args.runRoot, lease);
      throw new CliError(`${w.reason}；配置未改，租约记 failed`, 3);
    }
    lease.state = "restored";
    lease.closed = true;
    lease.restore = { pid: located.fish.pid, configSha256After: w.newHash, restoredKey: lease.originalKey, at: nowIso(), jobsClosedProofSha256: proof.sha256 };
    writeLease(args.runRoot, lease);
    console.log(`[restore] ✓ ${DRAW_KEY} 已按原键还原为 ${lease.originalKey}（鱼 pid ${located.fish.pid} 不变，热生效）；配置 sha256 →${w.newHash}；证据含证明 sha256=${proof.sha256}`);
    return 0;
  } finally {
    release();
  }
}

// ---------------------------------------------------------------------------
// main
// ---------------------------------------------------------------------------
async function main(): Promise<void> {
  let args: Args;
  try {
    args = parseArgs(process.argv);
  } catch (e) {
    if (e instanceof CliError) {
      console.error(e.message);
      process.exit(e.code);
    }
    throw e;
  }
  if (args.help) {
    console.log(USAGE);
    process.exit(0);
  }
  let ctx: Ctx;
  try {
    ctx = await bootstrap(args.repoRoot);
  } catch (e) {
    if (e instanceof CliError) {
      console.error(`[bootstrap] ✗ ${e.message}`);
      process.exit(e.code);
    }
    throw e;
  }
  try {
    const code = args.action === "preflight" ? doPreflight(args, ctx) : args.action === "off" ? doOff(args, ctx) : args.action === "status" ? doStatus(args, ctx) : doRestore(args, ctx);
    process.exit(code);
  } catch (e) {
    if (e instanceof CliError) {
      console.error(`[${args.action}] ✗ ${e.message}`);
      process.exit(e.code);
    }
    console.error(`[${args.action}] ✗ 未预期错误：${e instanceof Error ? (e.stack ?? e.message) : String(e)}`);
    process.exit(3);
  }
}

if (process.argv[1] && resolve(process.argv[1]) === resolve(fileURLToPath(import.meta.url))) await main();
