#!/usr/bin/env node
/**
 * interaction-study.ts —— anima-interaction-v1 研究的本地统一入口（build / preflight / describe-* /
 * collect / deliver / report / verify）。仓库根唯一来源 = src/paths.ts::REPO_ROOT（直接 import，不自拼回退）。
 * run-root 默认 <REPO_ROOT>/var/local-driver/anima-interaction-v1，可 --run 覆盖。
 * Downloads 交付根是主人指定绝对路径，本入口不派生、不触碰。
 *
 * 命令：
 *   describe-matrix   纯机械展开 spec.matrix（不读 preflight/结构、不写盘），报各组计数与 808 断言
 *   describe-prompts  报 40 主 case + 4 单人 case 的提示词组合（地板/公共/区域文本，机械可复核）
 *   preflight         门 1–4 + 资产绑定 + 结构状态（只读核对，不写 graphs/manifest）
 *   build             真实构建：全部硬门通过才写 manifest.json / graphs/** / checks/build-*.json；
 *                     缺任一输入 → 非零退出并报具体缺项，绝不产假图/假 hash。
 *                     分批：--group W-S [--seed N] [--weight W] → run-root/stages/w-s-smoke/，
 *                     参数与预定全矩阵一致、job_id 一致；如实报 selected count，不伪称完整 F1。
 *                     --dry-run 全部门禁与构图照跑但不写盘。
 *   collect|deliver|report
 *                     动态转发到独立 archive 模块（interaction-study-archive.ts::runArchiveCommand）；
 *                     模块未落盘/导出不符如实非零拒绝，不放永远通过的空实现。
 *   verify            动态转发到独立验收模块（interaction-study-verify.ts::runVerifyCommand，F1–F10）；
 *                     加载失败/导出不符/内部异常明确非零，不吞真正异常伪称未落盘。
 *
 * 消费命令（collect/deliver/report/verify）跟随 canonical run-root 的 current-revision.json 发布指针：
 *   指针不存在 → 沿用明确 --run 根（旧 draft 或主人显式指定），不偷偷改写、不回退；
 *   指针存在 → 必须 schema_version=anima-interaction-current-revision.v1、run_root 为 canonical root 相对路径
 *   且解析为其真实 revisions/ 子目录的直接子项、manifest_sha256（64hex）与 child manifest.json 实际字节相符；
 *   任一不合法/越界/逃逸/sha 不符 → 非零拒绝，绝不回退旧 draft 冒通过。ctx.runRoot 传选中真实 child，
 *   canonical 原路径只在日志记来源。build/preflight/describe-* 仍对显式 --run，不跟指针（避免重写原 draft）。
 *   --run 相对路径一律从 REPO_ROOT 解析（不再从 cwd）；根路径唯一来源 src/paths.ts::REPO_ROOT。
 *
 * 约束：不 commit/push、不接 QQ/GPU/远端、不改 spec/合同/方案/T0/T2/T4/runner/生产文件。
 */
import { REPO_ROOT } from "../../src/paths.ts";
import { join, resolve, relative, sep } from "node:path";
import { existsSync, readFileSync, realpathSync, statSync } from "node:fs";
import { createHash } from "node:crypto";

const args = process.argv.slice(2);
const command = args[0];
const flag = (name: string): string | undefined => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 ? args[i + 1] : undefined;
};
const hasFlag = (name: string): boolean => args.includes(`--${name}`);

function fail(msg: string): never {
  console.error(`[interaction-study] ${msg}`);
  process.exit(1);
}

const CONSUMER_COMMANDS = new Set(["collect", "deliver", "report", "verify"]);
const POINTER_SCHEMA = "anima-interaction-current-revision.v1";

/**
 * 消费命令（collect/deliver/report/verify）的 run-root 选择：跟随 canonical root 的
 * current-revision.json 发布指针（见 contracts/revision.md）。
 * - 指针不存在：沿用明确 --run 根（canonicalRoot 原样），不偷偷改写、不回退。
 * - 指针存在：严格校验 schema_version / run_root（相对、落在真实 revisions/ 的直接子目录）/
 *   manifest_sha256（64hex，核 child manifest.json 实际字节）；任一不符即非零拒绝，绝不回退旧 draft。
 * 真实路径边界（realpath + 分隔符）防目录前缀伪装与跨 root symlink。返回选中真实 child（realpath）。
 * 本函数只读指针、不创建/修改它；指针发布与新 revision 构建另派。
 */
function resolveConsumerRunRoot(canonicalRoot: string): string {
  const pointerPath = join(canonicalRoot, "current-revision.json");
  if (!existsSync(pointerPath)) return canonicalRoot; // 无指针：沿用明确 --run 根

  let ptr: unknown;
  try {
    ptr = JSON.parse(readFileSync(pointerPath, "utf8"));
  } catch (e) {
    fail(`current-revision.json 不是合法 JSON 或不可读（${pointerPath}）：${(e as Error).message}`);
  }
  if (typeof ptr !== "object" || ptr === null || Array.isArray(ptr))
    fail(`current-revision.json 顶层必须是对象（${pointerPath}）。`);
  const obj = ptr as Record<string, unknown>;

  if (obj.schema_version !== POINTER_SCHEMA)
    fail(`current-revision.json schema_version 必须为 "${POINTER_SCHEMA}"，实得 ${JSON.stringify(obj.schema_version)}。`);

  const relRun = obj.run_root;
  if (typeof relRun !== "string" || relRun.length === 0)
    fail(`current-revision.json run_root 必须是非空字符串（相对 canonical root），实得 ${JSON.stringify(relRun)}。`);
  if (relRun.startsWith("/") || /^[A-Za-z]:[\\/]/.test(relRun))
    fail(`current-revision.json run_root 必须是相对路径（相对 canonical root），不得为绝对路径，实得 ${JSON.stringify(relRun)}。`);

  const sha = obj.manifest_sha256;
  if (typeof sha !== "string" || !/^[0-9a-f]{64}$/.test(sha))
    fail(`current-revision.json manifest_sha256 必须是 64 位小写 hex，实得 ${JSON.stringify(sha)}。`);

  // 真实边界：canonicalRoot 与其 revisions/ 都取 realpath，防目录前缀伪装与跨 root symlink。
  let canonReal: string;
  try {
    canonReal = realpathSync(canonicalRoot);
  } catch (e) {
    fail(`canonical run-root 不可解析（${canonicalRoot}）：${(e as Error).message}`);
  }
  const revisionsDir = join(canonReal, "revisions");
  if (!existsSync(revisionsDir))
    fail(`canonical run-root 下缺真实 revisions/ 子目录（${revisionsDir}）；指针 run_root 无处落地。`);
  let revisionsReal: string;
  try {
    revisionsReal = realpathSync(revisionsDir);
  } catch (e) {
    fail(`revisions/ 不可解析（${revisionsDir}）：${(e as Error).message}`);
  }

  // 候选 = canonicalRoot(real) + relRun；必须落在 revisions/ 之内且为其直接子目录。
  const candidate = resolve(canonReal, relRun);
  let candidateReal: string;
  try {
    candidateReal = realpathSync(candidate);
  } catch (e) {
    fail(`current-revision.json 指向的 revision 目录不存在或不可解析（${candidate}）：${(e as Error).message}`);
  }
  if (!statSync(candidateReal).isDirectory())
    fail(`current-revision.json 指向的 revision 不是目录（${candidateReal}）。`);

  const relToRevisions = relative(revisionsReal, candidateReal);
  if (relToRevisions === "" || relToRevisions === "." || relToRevisions.startsWith("..") || relToRevisions.includes(sep))
    fail(`current-revision.json run_root 必须解析为 ${revisionsReal} 的直接子目录；实得相对 revisions 路径 "${JSON.stringify(relToRevisions)}（越界/逃逸/非直接子目录）。拒绝，不回退旧 draft。`);

  // 核 child manifest.json 实际字节 SHA-256 与指针声明一致。
  const manifestPath = join(candidateReal, "manifest.json");
  if (!existsSync(manifestPath))
    fail(`current-revision 目录缺 manifest.json（${manifestPath}）。`);
  let actualSha: string;
  try {
    actualSha = createHash("sha256").update(readFileSync(manifestPath)).digest("hex");
  } catch (e) {
    fail(`current-revision manifest.json 读取/计算 SHA 失败（${manifestPath}）：${(e as Error).message}`);
  }
  if (actualSha !== sha)
    fail(`current-revision.json manifest_sha256 不符：指针声明 ${sha}，实际 child manifest 字节 SHA-256 ${actualSha}（${manifestPath}）。拒绝，不回退旧 draft。`);

  console.log(`[interaction-study] consumer 跟随 current-revision 指针：canonical=${canonicalRoot}（来源）→ revision=${candidateReal}（manifest_sha256=${actualSha}）`);
  return candidateReal;
}

async function main(): Promise<void> {
  // --run 相对路径一律从 REPO_ROOT 解析（不再从 cwd）；绝对 --run 原样保留。
  const canonicalRunRoot = resolve(REPO_ROOT, flag("run") ?? join("var", "local-driver", "anima-interaction-v1"));
  // 只有消费命令跟随 current-revision 指针；build/preflight/describe-* 仍对显式 --run，避免重写原 draft。
  const isConsumer = command !== undefined && CONSUMER_COMMANDS.has(command);
  const runRoot = isConsumer ? resolveConsumerRunRoot(canonicalRunRoot) : canonicalRunRoot;

  switch (command) {
    case "describe-matrix": {
      const { loadSpec, stageSeed } = await import("./interaction-study-lib/floor.ts");
      const { expandMatrix, assertCounts } = await import("./interaction-study-lib/matrix.ts");
      const { spec } = loadSpec(runRoot, REPO_ROOT);
      const rows = expandMatrix(spec);
      const counts = assertCounts(spec, rows);
      const ex = spec.seeds.stage_algorithm.verified_example;
      const [c, s, st] = ex.input.split("|") as [string, string, string];
      const got = stageSeed(c, Number(s), st);
      console.log(JSON.stringify({
        command: "describe-matrix", repo_root: REPO_ROOT, run_root: runRoot,
        seed_example_check: { input: ex.input, expect: ex.stage_seed, got, ok: got === ex.stage_seed },
        counts,
        sample_rows: rows.slice(0, 3),
      }, null, 2));
      if (!counts.budget_respected || got !== ex.stage_seed) process.exit(1);
      return;
    }
    case "describe-prompts": {
      const { loadSpec } = await import("./interaction-study-lib/floor.ts");
      const { describePrompts } = await import("./interaction-study-lib/matrix.ts");
      const { spec } = loadSpec(runRoot, REPO_ROOT);
      console.log(JSON.stringify({ command: "describe-prompts", prompts: describePrompts(spec) }, null, 2));
      return;
    }
    case "preflight": {
      const { runPreflightCheck } = await import("./interaction-study-lib/build.ts");
      const result = await runPreflightCheck(REPO_ROOT, runRoot);
      console.log(JSON.stringify({ command: "preflight", ok: result.ok, missing: result.missing, ...result.summary }, null, 2));
      if (!result.ok) process.exit(1);
      return;
    }
    case "build": {
      const { runBuild } = await import("./interaction-study-lib/build.ts");
      const group = flag("group");
      const seed = flag("seed");
      const weight = flag("weight");
      const stage = group !== undefined
        ? { group: group as "W-S", seed: seed !== undefined ? Number(seed) : undefined,
            weight: weight !== undefined ? Number(weight) : undefined }
        : undefined;
      if (group !== undefined && group !== "W-S")
        fail(`--group 目前只支持 W-S（staged 首批样例）；收到 "${group}"。其余组走全量 build（需结构就绪）。`);
      const result = await runBuild({
        repoRoot: REPO_ROOT, runRoot, dryRun: hasFlag("dry-run"),
        floorOverride: flag("floor"), stage,
      });
      if (!result.ok) {
        console.error(`[interaction-study] build 拒绝（${result.missing.length} 项具体缺项；未写任何图/manifest）：`);
        for (const m of result.missing) console.error(`  - ${m}`);
        process.exit(1);
      }
      console.log(JSON.stringify({
        command: "build", ok: true, dry_run: Boolean(result.dryRun),
        manifest: result.manifestPath ?? null,
        graphs_written: result.graphsWritten ?? null,
        selection: result.selection ?? null,
        counts: result.counts ?? null,
      }, null, 2));
      return;
    }
    case "collect": case "deliver": case "report": {
      // 动态转发到 T7a 的独立 archive 模块（唯一写 scripts/experiments/interaction-study-archive.ts，
      // 导出 runArchiveCommand(command, ctx)）。本入口不复制其逻辑、不提供永远通过的空实现；
      // 模块未落盘时如实报缺，不冒充成功。
      let mod: { runArchiveCommand: (cmd: string, ctx: { repoRoot: string; runRoot: string; argv: string[] }) => Promise<unknown> | unknown };
      try {
        mod = await import("./interaction-study-archive.ts");
      } catch {
        fail(`命令 "${command}" 由独立 archive 模块承接，但 scripts/experiments/interaction-study-archive.ts 尚未落盘（T7a 进行中）。本入口不提供空实现。`);
      }
      if (typeof mod.runArchiveCommand !== "function")
        fail(`interaction-study-archive.ts 缺 runArchiveCommand(command, ctx) 导出——接口不符，拒绝转发。`);
      await mod.runArchiveCommand(command, { repoRoot: REPO_ROOT, runRoot, argv: args.slice(1) });
      return;
    }
    case "verify": {
      // 动态转发到 T3v 的独立验收模块（唯一写 scripts/experiments/interaction-study-verify.ts，
      // 导出 runVerifyCommand(ctx)，ctx/argv 与 archive 同型）。本入口不复制其逻辑、不提供永远通过的空实现；
      // 加载失败/导出不符/内部异常都明确非零，不吞真正异常伪称未落盘。
      let mod: { runVerifyCommand: (ctx: { repoRoot: string; runRoot: string; argv: string[] }) => Promise<unknown> | unknown };
      try {
        mod = await import("./interaction-study-verify.ts");
      } catch (e) {
        fail(`命令 "verify" 由独立验收模块承接，但 scripts/experiments/interaction-study-verify.ts 加载失败：${(e as Error).message}`);
      }
      if (typeof mod.runVerifyCommand !== "function")
        fail(`interaction-study-verify.ts 缺 runVerifyCommand(ctx) 导出——接口不符，拒绝转发。`);
      await mod.runVerifyCommand({ repoRoot: REPO_ROOT, runRoot, argv: args.slice(1) });
      return;
    }
    default:
      fail(`未知命令 "${command ?? ""}"。可用：describe-matrix | describe-prompts | preflight | build [--group W-S --seed N --weight W] [--dry-run]`);
  }
}

main().catch((err) => fail(err instanceof Error ? `${err.message}\n${err.stack ?? ""}` : String(err)));
