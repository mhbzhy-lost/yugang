#!/usr/bin/env node
/**
 * check-parity —— 本地工作区 vs parity-manifest.json 三项比对（IT bed Task I0 / FI1）。
 *
 * 本地基准（「工作区期望」）：
 *   1. 当前 git HEAD        —— 与 manifest.gitHead 比对（同 repo 同 commit 口径）
 *   2. fish.config 期望     —— src/fish-config.ts 的 FISH_CONFIG_FIELDS 白名单（本地代码认识哪些键）
 *   3. .env 键集            —— .env.example 的非注释键（含必填五键完备性）
 *
 * 比对口径：只比结构与身份（键集 / schema 白名单 / commit），**不比具体值**——
 * fish.config 生产值覆盖模板、.env 值因机器而异，都是预期差异；值级差异没有本地基准可比。
 *
 * 结果分级：
 *   一致        两边对得上
 *   提示        非阻塞的预期内差异（遗留键、未显式配置的字段等），人工知悉即可
 *   差异（阻塞） 真实的 parity 断裂（HEAD 不一致、本地代码不认识的键、必填键缺失），退出码 1
 *   跳过        注释键（fish.config 的 `_` 前缀备注）不参与比对
 *
 * 用法：node scripts/itbed/parity/check-parity.ts [--manifest <路径>]
 * 退出码：0 = 无阻塞差异；1 = 有阻塞差异；2 = 无法比对（manifest 缺失/损坏、git 不可用）。
 */
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { FISH_CONFIG_FIELDS } from "../../../src/fish-config.ts";

const PARITY_DIR = dirnameOf(import.meta.url);
const REPO_ROOT = resolve(PARITY_DIR, "../../..");
const DEFAULT_MANIFEST = join(PARITY_DIR, "parity-manifest.json");
/** 必填五键，对照 .env.example「必填」段；缺一即阻塞。 */
const REQUIRED_ENV_KEYS = ["ONEBOT_WS_URL", "ONEBOT_TOKEN", "MASTER_QQ", "GROUPS", "PROTOCOL_QQ"] as const;

function dirnameOf(url: string): string {
  return resolve(fileURLToPath(url), "..");
}

interface Row {
  item: string;
  manifest: string;
  local: string;
  status: "一致" | "提示" | "差异（阻塞）" | "跳过";
  blocking: boolean;
}

/** 展示宽度（CJK 记 2），用于表格对齐。 */
function width(s: string): number {
  let n = 0;
  for (const ch of s) n += ch.charCodeAt(0) > 0xff ? 2 : 1;
  return n;
}

function pad(s: string, n: number): string {
  return s + " ".repeat(Math.max(0, n - width(s)));
}

function short(s: string, max = 44): string {
  return width(s) > max ? `${s.slice(0, Math.max(0, max - 1))}…` : s;
}

function row(item: string, manifest: string, local: string, status: Row["status"]): Row {
  return { item, manifest, local, status, blocking: status === "差异（阻塞）" };
}

function gitHeadLocal(): string {
  const r = spawnSync("git", ["rev-parse", "HEAD"], { cwd: REPO_ROOT, encoding: "utf8" });
  if (r.error || r.status !== 0) return "";
  return r.stdout.trim();
}

function envExampleKeys(): string[] {
  const keys: string[] = [];
  for (const line of readFileSync(join(REPO_ROOT, ".env.example"), "utf8").split(/\r?\n/)) {
    const m = /^([A-Za-z_][A-Za-z0-9_]*)\s*=/.exec(line);
    if (m) keys.push(m[1]);
  }
  return keys;
}

function checkStructure(manifest: Record<string, unknown>): Row[] {
  const rows: Row[] = [];
  const env = manifest.env as { keyCount?: unknown; keys?: unknown; values?: unknown } | undefined;
  let problems: string[] = [];
  if (manifest.manifestVersion !== 1) problems.push("manifestVersion ≠ 1");
  if (!/^[0-9a-f]{40}$/.test(String(manifest.gitHead ?? ""))) problems.push("gitHead 不是 40 位 hex");
  if (!env || !Array.isArray(env.keys) || typeof env.values !== "object" || env.values === null) {
    problems.push("env 键清单/值表缺失");
  } else {
    const keys = env.keys as string[];
    const values = env.values as Record<string, unknown>;
    if (env.keyCount !== keys.length) problems.push(`env.keyCount(${String(env.keyCount)}) ≠ keys.length(${keys.length})`);
    const missingValues = keys.filter((k) => !(k in values));
    if (missingValues.length) problems.push(`values 缺键：${missingValues.join(",")}`);
    const extraValues = Object.keys(values).filter((k) => !keys.includes(k));
    if (extraValues.length) problems.push(`values 多余键：${extraValues.join(",")}`);
    const badPlaceholder = keys.filter((k) => typeof values[k] === "string" && /^<redacted:/.test(String(values[k])) && !/^<redacted:(len=\d+|empty)>$/.test(String(values[k])));
    if (badPlaceholder.length) problems.push(`脱敏占位格式异常：${badPlaceholder.join(",")}`);
  }
  if (manifest.fishConfig === null || typeof manifest.fishConfig !== "object") problems.push("fishConfig 快照缺失");
  rows.push(
    problems.length
      ? row("manifest 结构自检", problems.join("；"), "版本/键值对齐/占位格式合法", "差异（阻塞）")
      : row("manifest 结构自检", "结构完整", "版本/键值对齐/占位格式合法", "一致"),
  );
  return rows;
}

function main(): void {
  const idx = process.argv.indexOf("--manifest");
  const manifestPath = idx !== -1 && process.argv[idx + 1] ? resolve(process.argv[idx + 1]) : DEFAULT_MANIFEST;

  let manifest: Record<string, unknown>;
  try {
    manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
  } catch (e) {
    console.error(`[check-parity] 读不了 manifest（${manifestPath}）：${e instanceof Error ? e.message : String(e)}`);
    console.error("[check-parity] 先跑 node scripts/itbed/parity/pull-parity.ts 生成一份。");
    process.exit(2);
  }

  const source = (manifest.source ?? {}) as { pullMode?: string };
  const generatedAt = typeof manifest.generatedAt === "string" ? manifest.generatedAt : "?";
  console.log(`[check-parity] manifest：${manifestPath}（generatedAt ${generatedAt}，pullMode=${source.pullMode ?? "?"}）`);

  const rows: Row[] = [];

  // 0. manifest 结构自检：手改/损坏的 manifest 直接挡下
  rows.push(...checkStructure(manifest));

  // 1. git HEAD：同 repo 同 commit 口径；开发期本地领先线上属预期内的真实差异，照实报
  const localHead = gitHeadLocal();
  if (!localHead) {
    console.error("[check-parity] 本地 git HEAD 取不到，无法比对。");
    process.exit(2);
  }
  rows.push(
    manifest.gitHead === localHead
      ? row("git HEAD", String(manifest.gitHead), localHead, "一致")
      : row("git HEAD", String(manifest.gitHead), localHead, "差异（阻塞）"),
  );

  // 2. fish.config：快照键 vs 本地 schema 白名单（FISH_CONFIG_FIELDS）；`_` 注释键跳过
  const schemaNames = new Set(FISH_CONFIG_FIELDS.map((f) => f.name));
  const fishConfig = manifest.fishConfig as Record<string, unknown>;
  for (const key of Object.keys(fishConfig)) {
    if (key.startsWith("_")) {
      rows.push(row(`fishConfig.${key}`, short(String(fishConfig[key])), "注释键不参与比对", "跳过"));
    } else if (schemaNames.has(key)) {
      rows.push(row(`fishConfig.${key}`, short(JSON.stringify(fishConfig[key])), "schema 认识（FISH_CONFIG_FIELDS）", "一致"));
    } else {
      rows.push(row(`fishConfig.${key}`, short(JSON.stringify(fishConfig[key])), "schema 不认识（本地会忽略该键）", "差异（阻塞）"));
    }
  }
  const missingInSnapshot = FISH_CONFIG_FIELDS.map((f) => f.name).filter((name) => !(name in fishConfig));
  if (missingInSnapshot.length) {
    rows.push(row("fishConfig 线上未配置的字段", "（快照无此键）", missingInSnapshot.join(", "), "提示"));
  }

  // 3. .env 键集：必填五键完备性 + 全键对照 .env.example
  const env = manifest.env as { keyCount: number; keys: string[]; values: Record<string, string> };
  const exampleKeys = envExampleKeys();
  const exampleSet = new Set(exampleKeys);
  const missingRequired = REQUIRED_ENV_KEYS.filter((k) => !env.keys.includes(k));
  rows.push(
    missingRequired.length
      ? row("env 必填五键", `缺 ${missingRequired.join(", ")}`, REQUIRED_ENV_KEYS.join(", "), "差异（阻塞）")
      : row("env 必填五键", "5/5 在清单中", REQUIRED_ENV_KEYS.join(", "), "一致"),
  );
  for (const key of env.keys) {
    const value = env.values[key] ?? "";
    const shown = value.startsWith("<redacted:") ? `${value}（脱敏占位）` : short(value);
    if (exampleSet.has(key)) {
      rows.push(row(`env.${key}`, shown, "example 认识", "一致"));
    } else {
      rows.push(row(`env.${key}`, shown, "example 未收录（遗留/可选键，注意同步语义）", "提示"));
    }
  }
  const unsetExampleKeys = exampleKeys.filter((k) => !env.keys.includes(k));
  if (unsetExampleKeys.length) {
    rows.push(row("env 模板键线上未设", "（清单无此键）", unsetExampleKeys.join(", "), "提示"));
  }

  // 4. 来源提示：手工兜底构造的 manifest（来源待补）要显式提醒
  if (source.pullMode === "manual-fallback") {
    rows.push(row("source.pullMode", "manual-fallback", "非实时拉取，来源待补后重跑 pull-parity.ts", "提示"));
  }

  // 输出逐项表
  const wItem = Math.max(...rows.map((r) => width(r.item))) + 2;
  const wManifest = Math.min(56, Math.max(...rows.map((r) => width(r.manifest)))) + 2;
  const wLocal = Math.min(48, Math.max(...rows.map((r) => width(r.local)))) + 2;
  console.log(`${pad("项目", wItem)}| ${pad("manifest", wManifest)}| ${pad("本地期望", wLocal)}| 结果`);
  console.log(`${"-".repeat(wItem)}+${"-".repeat(wManifest + 1)}+${"-".repeat(wLocal + 1)}+---------`);
  for (const r of rows) {
    console.log(`${pad(r.item, wItem)}| ${pad(short(r.manifest, wManifest - 2), wManifest)}| ${pad(short(r.local, wLocal - 2), wLocal)}| ${r.status}`);
  }

  const nBlock = rows.filter((r) => r.blocking).length;
  const nInfo = rows.filter((r) => r.status === "提示").length;
  const nSame = rows.filter((r) => r.status === "一致").length;
  const nSkip = rows.filter((r) => r.status === "跳过").length;
  console.log(`[check-parity] 汇总：一致 ${nSame} · 提示 ${nInfo} · 跳过 ${nSkip} · 阻塞差异 ${nBlock}`);
  if (nBlock > 0) {
    for (const r of rows.filter((x) => x.blocking)) console.log(`[check-parity] 阻塞：${r.item} —— manifest=${r.manifest} vs 本地=${r.local}`);
    console.log("[check-parity] 有阻塞差异（退出码 1）。git HEAD 差异在开发期属常态（线上未部署），部署对齐或确认接受后可继续用 IT bed。");
    process.exit(1);
  }
  console.log("[check-parity] 无阻塞差异（退出码 0）。");
  process.exit(0);
}

main();
