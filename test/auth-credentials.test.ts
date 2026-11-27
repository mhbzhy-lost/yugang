import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { hostname, tmpdir } from "node:os";
import { join } from "node:path";
import {
  BOOT_ID,
  fileCredentialStore,
  withCredentialFileLock,
  type OAuthCredential,
} from "../src/auth/credentials.ts";
import { refreshTokens as refreshGoogleTokens } from "../src/auth/google.ts";
import { refreshTokens as refreshOpenAiTokens } from "../src/auth/openai.ts";

function makeTempDir(prefix: string): string {
  return mkdtempSync(join(tmpdir(), prefix));
}

test("fileCredentialStore：将 { key } 与裸字符串归一化为 { type: 'api_key', key }", async (t) => {
  const dir = makeTempDir("auth-cred-norm-");
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const authPath = join(dir, "auth.json");
  writeFileSync(
    authPath,
    JSON.stringify({
      deepseek: { key: "sk-ds-123" },
      zai: "sk-zai-456",
      emptyStr: "",
      emptyObj: {},
      codex: { type: "oauth", access: "a", refresh: "r", expires: Date.now() + 1000 },
    }),
    { mode: 0o600 },
  );

  const store = fileCredentialStore(authPath);
  assert.deepEqual(await store.read("deepseek"), { type: "api_key", key: "sk-ds-123" });
  assert.deepEqual(await store.read("zai"), { type: "api_key", key: "sk-zai-456" });
  assert.equal(await store.read("emptyStr"), undefined);
  assert.equal(await store.read("emptyObj"), undefined);

  const list = await store.list();
  assert.deepEqual(list, [
    { providerId: "deepseek", type: "api_key" },
    { providerId: "zai", type: "api_key" },
    { providerId: "codex", type: "oauth" },
  ]);
});

test("reclaimStaleLock：同 host + 同 pid 不同 bootId 立即回收；异机过期锁自动回收；未过期活锁等待", async (t) => {
  const dir = makeTempDir("auth-cred-lock-");
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const authPath = join(dir, "auth.json");
  const lockPath = `${authPath}.lock`;
  writeFileSync(authPath, "{}", { mode: 0o600 });

  // 1) 同 host + 同 process.pid 但不同 bootId（容器重启 PID 复用）→ 立即回收
  writeFileSync(
    lockPath,
    JSON.stringify({
      pid: process.pid,
      host: hostname(),
      token: "old-boot-token",
      at: Date.now(),
      bootId: `${BOOT_ID}-previous-boot`,
    }),
  );
  const t0 = Date.now();
  const ran1 = await withCredentialFileLock(authPath, () => "ok-reclaimed-pid");
  assert.equal(ran1, "ok-reclaimed-pid");
  assert.ok(Date.now() - t0 < 500, "同 PID 不同 bootId 的锁应立即回收");

  // 2) 异机 owner.host 且 at 与 mtimeMs 均已超过 LOCK_STALE_MS（120s）→ 自动回收
  const staleAt = Date.now() - 180_000;
  writeFileSync(
    lockPath,
    JSON.stringify({
      pid: 42,
      host: "crashed-container-xyz",
      token: "old-host-token",
      at: staleAt,
      bootId: "other-boot",
    }),
  );
  const staleSec = staleAt / 1000;
  utimesSync(lockPath, staleSec, staleSec);
  const t1 = Date.now();
  const ran2 = await withCredentialFileLock(authPath, () => "ok-reclaimed-stale");
  assert.equal(ran2, "ok-reclaimed-stale");
  assert.ok(Date.now() - t1 < 500, "异机过期锁应自动回收");

  // 3) 异机未过期活锁 → 不抢锁，按 signal 取消退出
  writeFileSync(
    lockPath,
    JSON.stringify({
      pid: 42,
      host: "live-other-container",
      token: "live-token",
      at: Date.now(),
      bootId: "live-boot",
    }),
  );
  const ac = new AbortController();
  setTimeout(() => ac.abort(new Error("stop-wait")), 80);
  await assert.rejects(
    withCredentialFileLock(authPath, () => "should-not-run", { signal: ac.signal }),
    (err: unknown) => {
      assert.ok(err instanceof Error);
      assert.equal(err.name, "AbortError");
      assert.match(String((err as { cause?: unknown }).cause ?? err.message), /stop-wait/);
      return true;
    },
  );
  assert.match(readFileSync(lockPath, "utf8"), /live-token/);
});

test("google / openai refreshTokens：拒绝非对象 JSON 与非法 expires_in，未传 signal 时绑定默认超时", async () => {
  const googleCred: OAuthCredential = {
    type: "oauth",
    access: "old-a",
    refresh: "old-r",
    expires: Date.now() - 1000,
    clientId: "cid",
    clientSecret: "csec",
  };
  const openaiCred: OAuthCredential = {
    type: "oauth",
    access: "old-a",
    refresh: "old-r",
    expires: Date.now() - 1000,
  };

  for (const badBody of [[], "string-body", null, { access_token: "a", expires_in: NaN }, { access_token: "a", expires_in: 0 }, { access_token: "a", expires_in: -5 }]) {
    const fakeJsonFetch: typeof fetch = async () =>
      new Response(JSON.stringify(badBody), { status: 200, headers: { "content-type": "application/json" } });
    await assert.rejects(refreshGoogleTokens(googleCred, undefined, fakeJsonFetch));
    await assert.rejects(
      refreshOpenAiTokens(openaiCred, undefined, async () =>
        new Response(JSON.stringify({ refresh_token: "r2", ...(typeof badBody === "object" && badBody && !Array.isArray(badBody) ? badBody : {}) }), {
          status: 200,
          headers: { "content-type": "application/json" },
        }),
      ),
    );
  }

  // 非对象 JSON 也必须被 openai refreshTokens 拒绝
  await assert.rejects(
    refreshOpenAiTokens(openaiCred, undefined, async () =>
      new Response(JSON.stringify(["not", "an", "object"]), { status: 200, headers: { "content-type": "application/json" } }),
    ),
  );

  // 未传 signal 时，fetchImpl 仍收到带超时的 AbortSignal，并按超时中止
  for (const fn of [
    (fetchImpl: typeof fetch, timeoutMs?: number) => refreshGoogleTokens(googleCred, undefined, fetchImpl, timeoutMs),
    (fetchImpl: typeof fetch, timeoutMs?: number) => refreshOpenAiTokens(openaiCred, undefined, fetchImpl, timeoutMs),
  ]) {
    let sawSignal: AbortSignal | undefined;
    const hangingFetch: typeof fetch = (_input, init) => {
      sawSignal = init?.signal ?? undefined;
      return new Promise((_resolve, reject) => {
        init?.signal?.addEventListener("abort", () => reject(init.signal?.reason ?? new Error("aborted")), { once: true });
      });
    };
    const t0 = Date.now();
    await assert.rejects(fn(hangingFetch, 50));
    assert.ok(sawSignal instanceof AbortSignal, "未传 signal 时也必须注入超时信号");
    assert.ok(Date.now() - t0 < 1000, "默认超时信号应及时中止挂起刷新");
  }
});
