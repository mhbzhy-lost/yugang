/**
 * 通道边界与开关的机械检查（计划 §2 F2/F3）：
 * - F2：QQ 输入转换集中在 src/channels/qq/，src/qq/ 不再有四个已迁移文件；
 *        src/index.ts、src/compact.ts 不直接 import channels/qq/*；
 *        src/app 只允许 QQ 单例接线白名单（adapter/normalize/round-input/onebot/render），
 *        计划 §2 F2 括注「经 registry/adapter 间接引用除外」。
 * - F3：parseChannels 对 unset/none/qq/未知名的判定。
 * 只读源码与 process.env，不读 .env / 凭据。
 */
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { parseChannels } from "../src/channels/registry.ts";

let failed = false;
const check = (name: string, ok: boolean, detail = ""): void => {
  console.log(`${ok ? "PASS" : "FAIL"} ${name}${detail ? `：${detail}` : ""}`);
  if (!ok) failed = true;
};

// —— F2 静态边界 ——
const moved = ["onebot.ts", "model-input.ts", "round-input.ts", "round-images.ts"];
for (const file of moved) {
  let oldExists = false;
  try { statSync(join("src/qq", file)); oldExists = true; } catch {}
  check(`F2 src/qq/${file} 已迁走`, !oldExists);
  let newExists = false;
  try { statSync(join("src/channels/qq", file)); newExists = true; } catch {}
  check(`F2 src/channels/qq/${file} 存在`, newExists);
}

function* tsFiles(dir: string): Generator<string> {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const p = join(dir, entry.name);
    if (entry.isDirectory()) yield* tsFiles(p);
    else if (entry.name.endsWith(".ts")) yield p;
  }
}
const importRe = /from "[^"]*channels\/qq\/([a-z-]+)\.ts"/g;
const qqImportsOf = (file: string): string[] => {
  const hits = [...readFileSync(file, "utf8").matchAll(importRe)].map((m) => m[1]);
  return [...new Set(hits)];
};
for (const file of ["src/index.ts", "src/compact.ts"]) {
  const hits = qqImportsOf(file);
  check(`F2 ${file} 不直接 import channels/qq/*`, hits.length === 0, hits.join(", "));
}
const appAllow = new Set(["adapter", "normalize", "round-input", "onebot", "round-images", "model-input"]);
const appHits = [...tsFiles("src/app")].flatMap((f) => qqImportsOf(f).map((m) => `${f} → ${m}`));
check(
  "F2 src/app 只经 QQ 单例接线白名单引用 channels/qq",
  appHits.every((hit) => appAllow.has(hit.split(" → ")[1])),
  appHits.join(", "),
);

// —— F3 开关 ——
check("F3 unset → qq", JSON.stringify(parseChannels(undefined)) === JSON.stringify(["qq"]));
check("F3 none → []", parseChannels("none").length === 0);
check("F3 空串 → []", parseChannels("").length === 0);
check("F3 qq,dingtalk 顺序保持", JSON.stringify(parseChannels("qq,dingtalk")) === JSON.stringify(["qq", "dingtalk"]));
let threw = "";
try { parseChannels("foo"); } catch (error) { threw = error instanceof Error ? error.message : String(error); }
check("F3 未知名抛错", threw.includes("未知通道"), threw);

process.exit(failed ? 1 : 0);
