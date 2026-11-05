/**
 * 部署前置依赖（scripts/lib/deps.ts）的机械测试：
 * 60s 自愈的分支（已健康 / 容器停止 / 容器缺失 / 无 docker）与 run 参数。
 * 只测纯决策，不真的碰 docker。
 */
import test from "node:test";
import assert from "node:assert/strict";
import { ensureSixtyService, findDocker, sixtyRunArgs, type Exec, type ExecResult } from "../scripts/lib/deps.ts";

const ok = (stdout = ""): ExecResult => ({ status: 0, stdout, stderr: "" });
const fail = (stderr = "no"): ExecResult => ({ status: 1, stdout: "", stderr });

test("60s run 参数：只绑 loopback、restart always、宿主端口映射到 4399", () => {
  assert.deepEqual(sixtyRunArgs("60s", "vikiboss/60s", 4399), [
    "run", "-d", "--name", "60s", "--restart", "always", "-p", "127.0.0.1:4399:4399", "vikiboss/60s",
  ]);
});

test("findDocker：能找到 docker（绝对路径或 PATH）", () => {
  const exec: Exec = (command, args) => (command === "docker" && args[0] === "--version" ? ok() : fail());
  const found = findDocker(exec, { DOCKER_BIN: "/nonexistent/docker" });
  assert.ok(found !== undefined && found.endsWith("docker"), `没找到 docker：${found}`);
});

test("已健康：不再碰 docker", async () => {
  const calls: string[] = [];
  const exec: Exec = (command, args) => {
    calls.push([command, ...args].join(" "));
    return fail();
  };
  const healthy = await ensureSixtyService({ exec, docker: "docker", health: async () => true, log: () => {} });
  assert.equal(healthy, true);
  assert.deepEqual(calls, []);
});

test("容器停止：start 容器后健康轮询通过", async () => {
  const calls: string[] = [];
  let healthy = false;
  const exec: Exec = (command, args) => {
    calls.push([command, ...args].join(" "));
    if (args[0] === "inspect") return ok("false\n");
    if (args[0] === "start") {
      healthy = true;
      return ok();
    }
    return fail();
  };
  const okNow = await ensureSixtyService({
    exec,
    docker: "docker",
    health: async () => healthy,
    sleep: async () => {},
    waitMs: 2_000,
    log: () => {},
  });
  assert.equal(okNow, true);
  assert.ok(calls.some((line) => line === "docker start 60s"), calls.join("\n"));
  assert.ok(!calls.some((line) => line.includes(" docker run")), "已有容器时不该重新 run");
});

test("容器缺失 + 镜像缺失：先 pull 再 run", async () => {
  const calls: string[] = [];
  let healthy = false;
  const exec: Exec = (command, args) => {
    calls.push([command, ...args].join(" "));
    if (args[0] === "inspect") return fail();
    if (args[0] === "image" && args[1] === "inspect") return fail();
    if (args[0] === "pull") return ok();
    if (args[0] === "run") {
      healthy = true;
      return ok();
    }
    return fail();
  };
  const okNow = await ensureSixtyService({
    exec,
    docker: "docker",
    health: async () => healthy,
    sleep: async () => {},
    waitMs: 2_000,
    log: () => {},
  });
  assert.equal(okNow, true);
  const joined = calls.join("\n");
  assert.ok(joined.includes("docker pull vikiboss/60s"), joined);
  assert.ok(joined.includes("docker run -d --name 60s --restart always -p 127.0.0.1:4399:4399 vikiboss/60s"), joined);
});

test("没有 docker：返回 false，不抛", async () => {
  const result = await ensureSixtyService({
    exec: () => fail(),
    docker: null,
    health: async () => false,
    log: () => {},
  });
  assert.equal(result, false);
});
