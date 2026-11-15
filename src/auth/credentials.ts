/**
 * 文件版凭据存储：config/auth.json（仓库外、权限 600）就是 pi-ai 的 CredentialStore。
 *
 * 一个 provider 一条凭据：
 *   { "deepseek": { "type": "api_key", "key": "..." } }
 *   { "openai-codex": { "type": "oauth", "refresh": "...", "access": "...", "expires": 1234567890 } }
 *
 * oauth 的刷新由 pi-ai 在请求路径上驱动，刷新结果经 modify() 回写到这里，
 * 所以 token 换了也会落盘，重启后还是有效的。
 *
 * 并发：modify / delete 的**整段**「读 → 回调（可能就是 OAuth 刷新）→ 写」都在跨进程文件锁里跑
 * （`<凭据文件>.lock`，O_EXCL 创建，里面记 pid/host/token 身份），同一进程内再按文件排队。
 * 鱼、`npm run login`、`npm run creds` 用的是同一把锁，所以两个进程不会同时刷新同一份会轮换的
 * refresh token，也不会拿旧快照覆盖别人刚写的凭据。锁超时或异常一律抛错（fail closed），
 * 绝不降级成无锁写。
 *
 * 落盘：唯一命名的临时文件（0600）→ fsync → 原子 rename，读路径永远看不到半截文件。
 * JSON 损坏时写路径直接抛错，不会把 `{}` 覆盖掉原凭据。
 *
 * 类型是结构性的本地定义：pi-ai 的 auth 子路径没有对外开放，不在运行时依赖它。
 */
import {
  closeSync,
  existsSync,
  fchmodSync,
  fsyncSync,
  linkSync,
  mkdirSync,
  openSync,
  readFileSync,
  realpathSync,
  renameSync,
  rmSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { randomBytes } from "node:crypto";
import { hostname } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";

export type ApiKeyCredential = { type: "api_key"; key?: string; env?: Record<string, string> };
export type OAuthCredential = { type: "oauth"; refresh: string; access: string; expires: number; [key: string]: unknown };
export type Credential = ApiKeyCredential | OAuthCredential;

/** 写操作的可选取消：只取消「等锁」；回调一旦开始就跑完（刷新中的 token 不能半途丢弃）。 */
export interface CredentialWriteOptions {
  signal?: AbortSignal;
}

export interface CredentialStoreLike {
  read(providerId: string): Promise<Credential | undefined>;
  list(): Promise<readonly { providerId: string; type: Credential["type"] }[]>;
  /** 回调返回 undefined = 这条不动（pi-ai 契约：别的进程/请求已经刷新过），不是删除。 */
  modify(
    providerId: string,
    fn: (current: Credential | undefined) => Promise<Credential | undefined>,
    options?: CredentialWriteOptions,
  ): Promise<Credential | undefined>;
  delete(providerId: string, options?: CredentialWriteOptions): Promise<void>;
}

type Store = Record<string, Credential>;

/** 等锁上限：pi-ai 的 OAuth 刷新自带 15s 超时，这里留一倍余量；超时抛错，不写盘。 */
const LOCK_WAIT_MS = 30_000;
const LOCK_POLL_MIN_MS = 20;
const LOCK_POLL_MAX_MS = 250;
/** 身份记录读不出来的锁（崩溃残留）旧到这个程度才回收；正常持有 = 一次刷新 + 写盘，远小于它。 */
const LOCK_STALE_MS = 120_000;

function errnoOf(error: unknown): string | undefined {
  return (error as NodeJS.ErrnoException | undefined)?.code;
}

/** 锁与进程内队列的键：目录取 realpath，免得相对路径 / 软链各拿一把锁。 */
function canonicalFile(path: string): string {
  const abs = resolve(path);
  try {
    return join(realpathSync(dirname(abs)), basename(abs));
  } catch {
    return abs;
  }
}

/** 读路径：文件缺失或损坏都按「没有凭据」处理（旧行为），只读不写，不会毁数据。 */
function load(path: string): Store {
  if (!existsSync(path)) return {};
  try {
    const parsed = JSON.parse(readFileSync(path, "utf8")) as unknown;
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? (parsed as Store) : {};
  } catch {
    return {};
  }
}

/**
 * 写路径：只有「文件不存在」才起空底。读不动 / JSON 损坏 / 不是对象一律抛错，
 * 绝不让 `{}` 顺着读改写覆盖掉原凭据。错误文案只带路径，不回显文件内容（里面是 key）。
 */
function loadForWrite(path: string): Store {
  let raw: string;
  try {
    raw = readFileSync(path, "utf8");
  } catch (error) {
    if (errnoOf(error) === "ENOENT") return {};
    throw new Error(`凭据文件读不出来（${path}），拒绝写入：${errnoOf(error) ?? "unknown"}`);
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new Error(`凭据文件 JSON 损坏（${path}），拒绝写入以免覆盖原凭据；先人工修好或重新登录`);
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error(`凭据文件不是 JSON 对象（${path}），拒绝写入以免覆盖原凭据`);
  }
  return parsed as Store;
}

/**
 * 原子落盘：唯一 tmp（同目录才能 rename）→ 0600 → fsync → rename → 目录 fsync（尽力）。
 * 调用方必须已经持有这把文件的跨进程锁；临时文件无论成败都清掉。
 */
export function writeCredentialFileSync(path: string, value: unknown): void {
  const tmp = `${path}.${process.pid}.${randomBytes(6).toString("hex")}.tmp`;
  let fd: number | undefined;
  try {
    fd = openSync(tmp, "wx", 0o600);
    writeFileSync(fd, `${JSON.stringify(value, null, 2)}\n`);
    fchmodSync(fd, 0o600); // umask 可能吃掉权限位，显式钉死 600
    fsyncSync(fd);
    closeSync(fd);
    fd = undefined;
    renameSync(tmp, path);
  } finally {
    if (fd !== undefined) {
      try {
        closeSync(fd);
      } catch {
        // 关不掉也不能挡住清理
      }
    }
    rmSync(tmp, { force: true });
  }
  try {
    const dir = openSync(dirname(path), "r");
    try {
      fsyncSync(dir);
    } finally {
      closeSync(dir);
    }
  } catch {
    // 平台不支持目录 fsync：文件本身已 fsync，rename 的原子性不受影响
  }
}

type LockOwner = { pid: number; host: string; token: string; at: number };

function lockPathOf(file: string): string {
  return `${file}.lock`;
}

function readLockOwner(lockPath: string): LockOwner | undefined {
  try {
    const raw = JSON.parse(readFileSync(lockPath, "utf8")) as Partial<LockOwner>;
    if (typeof raw?.token !== "string" || typeof raw.pid !== "number" || typeof raw.host !== "string") return undefined;
    return raw as LockOwner;
  } catch {
    return undefined;
  }
}

/** pid 还活着吗（0 号/负数会打到进程组，先挡掉）。EPERM = 进程在、只是不属于我们。 */
function processAlive(pid: number): boolean {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return errnoOf(error) === "EPERM";
  }
}

/**
 * 回收「持有者已经没了」的残留锁（kill -9 / 掉电）：
 *   • 同机 + 身份记录里的 pid 确认不在 → 立刻回收（不等 stale 门槛，重启后第一次刷新就能写）
 *   • 身份记录读不出来（创建到写入之间的崩溃残留）→ 只有足够旧才当残留
 *   • 跨机 / 跨容器（host 不同，pid 不可比）或 pid 还活着 → 一律不抢，等超时 fail closed
 * 摘锁用 rename（同一时刻只有一个进程能成功），摘完再核对 ino/mtime，
 * 万一摘掉的是别人刚建的新锁就原样 link 回去，本次写入放弃。
 */
function reclaimStaleLock(lockPath: string): boolean {
  let before: ReturnType<typeof statSync>;
  try {
    before = statSync(lockPath);
  } catch {
    return true; // 锁已经没了，直接重试创建
  }
  const owner = readLockOwner(lockPath);
  if (owner) {
    if (owner.host !== hostname()) return false;
    if (processAlive(owner.pid)) return false;
  } else if (Date.now() - before.mtimeMs < LOCK_STALE_MS) {
    return false;
  }

  const quarantine = `${lockPath}.stale.${randomBytes(6).toString("hex")}`;
  try {
    renameSync(lockPath, quarantine);
  } catch {
    return false; // 别人先摘了 / 已经释放，回去重排队
  }
  let same = false;
  try {
    const after = statSync(quarantine);
    same = after.ino === before.ino && after.mtimeMs === before.mtimeMs;
  } catch {
    same = false;
  }
  if (!same) {
    // 摘到的不是刚才那把（有人在我们判断期间新建了锁）：还回去，别抢活人的锁
    try {
      linkSync(quarantine, lockPath);
    } catch {
      // 已经有新锁占位：不再插手，本次写入按等锁超时处理
    }
    rmSync(quarantine, { force: true });
    return false;
  }
  rmSync(quarantine, { force: true });
  return true;
}

function releaseLock(lockPath: string, token: string): void {
  if (!existsSync(lockPath)) return; // 已经不在了（被回收 / 被手工删）：没什么可释放
  try {
    const owner = readLockOwner(lockPath);
    if (owner?.token !== token) {
      // 不是我们那把（被回收/被接管）：不删别人的锁，只告警
      console.warn(`[creds] 凭据锁身份不符，保留原锁：${lockPath}`);
      return;
    }
    unlinkSync(lockPath);
  } catch (error) {
    if (errnoOf(error) !== "ENOENT") console.warn(`[creds] 凭据锁释放失败（${lockPath}）：${errnoOf(error) ?? "unknown"}`);
  }
}

/** 拿跨进程锁：O_EXCL 创建 + 退避轮询；超时/异常/取消一律抛错，调用方不得无锁写。 */
async function acquireLock(file: string, signal?: AbortSignal): Promise<() => void> {
  const lockPath = lockPathOf(file);
  const token = randomBytes(12).toString("hex");
  const owner: LockOwner = { pid: process.pid, host: hostname(), token, at: Date.now() };
  const deadline = Date.now() + LOCK_WAIT_MS;
  let poll = LOCK_POLL_MIN_MS;
  for (;;) {
    signal?.throwIfAborted();
    let fd: number;
    try {
      fd = openSync(lockPath, "wx", 0o600); // O_CREAT|O_EXCL：跨进程原子，只有一个能建成
    } catch (error) {
      if (errnoOf(error) !== "EEXIST") {
        throw new Error(`凭据锁创建失败（${lockPath}），拒绝无锁写入：${errnoOf(error) ?? "unknown"}`);
      }
      if (reclaimStaleLock(lockPath)) continue;
      const left = deadline - Date.now();
      if (left <= 0) {
        throw new Error(
          `等凭据锁超时（${LOCK_WAIT_MS}ms，${lockPath}），拒绝无锁写入；确认没有卡死的 login/creds 进程后删掉该锁文件再试`,
        );
      }
      await sleep(Math.min(poll, left), undefined, { signal });
      poll = Math.min(poll * 2, LOCK_POLL_MAX_MS);
      continue;
    }
    try {
      writeFileSync(fd, `${JSON.stringify(owner)}\n`);
      fsyncSync(fd);
    } catch (error) {
      rmSync(lockPath, { force: true }); // 自己刚建的空锁，别留成死锁
      throw new Error(`凭据锁写入失败（${lockPath}），拒绝无锁写入：${errnoOf(error) ?? "unknown"}`);
    } finally {
      closeSync(fd);
    }
    return () => releaseLock(lockPath, token);
  }
}

/** 进程内写队列：同一份文件的读改写排成一队，后来的写入一定看得到前一次的落盘结果。 */
const queues = new Map<string, Promise<unknown>>();

function enqueue<T>(key: string, task: () => Promise<T>): Promise<T> {
  const previous = queues.get(key) ?? Promise.resolve();
  const run = previous.then(task);
  const tail = run.then(
    () => undefined,
    () => undefined,
  );
  queues.set(key, tail);
  void tail.then(() => {
    if (queues.get(key) === tail) queues.delete(key);
  });
  return run;
}

/**
 * 独占一份凭据文件：进程内排队 → 跨进程文件锁 → task（读改写的全部，含 OAuth 刷新）→ 释放锁。
 * 鱼、login、CLI（npm run creds）共用它。拿不到锁就抛错，task 不会被执行。
 */
export function withCredentialFileLock<T>(
  path: string,
  task: () => T | Promise<T>,
  options?: CredentialWriteOptions,
): Promise<T> {
  const file = canonicalFile(path);
  return enqueue(file, async () => {
    mkdirSync(dirname(file), { recursive: true });
    const release = await acquireLock(file, options?.signal);
    try {
      return await task();
    } finally {
      release();
    }
  });
}

export function fileCredentialStore(path: string): CredentialStoreLike {
  return {
    async read(providerId) {
      return load(path)[providerId];
    },
    async list() {
      const store = load(path);
      return Object.entries(store).map(([providerId, credential]) => ({
        providerId,
        type: credential.type,
      }));
    },
    async modify(providerId, fn, options) {
      return withCredentialFileLock(
        path,
        async () => {
          const store = loadForWrite(path);
          const current = Object.hasOwn(store, providerId) ? store[providerId] : undefined;
          const next = await fn(current);
          // pi-ai 契约：undefined = 这条不动（并发下别人刚刷新过），删除只走 delete()
          if (next === undefined) return current;
          store[providerId] = next;
          writeCredentialFileSync(path, store);
          return next;
        },
        options,
      );
    },
    async delete(providerId, options) {
      await withCredentialFileLock(
        path,
        () => {
          const store = loadForWrite(path);
          if (!Object.hasOwn(store, providerId)) return; // 本来就没有：不写盘，也不凭空建文件
          delete store[providerId];
          writeCredentialFileSync(path, store);
        },
        options,
      );
    },
  };
}
