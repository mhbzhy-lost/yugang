/**
 * 长期记忆「时效性核对 / EXPIRE」的自检脚本（2026-11-05，计划 T5）。
 *
 * 只 import 纯模块（model / patch / pending / extract / render），**不 import
 * src/app/runtime.ts**——不需要起鱼、不碰 var/、不连模型。逐项打印 F1–F9 的 PASS/FAIL，
 * 以退出码表达总体结果；F10（npm test）由验收命令另行覆盖。
 *
 *   node scripts/verify-memory-expire.ts
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { REPO_ROOT } from "../src/paths.ts";
import {
  MEMORY_CAPS,
  MEMORY_EXPIRE_PER_PAGE,
  emptyMemory,
  type MemoryPerson,
  type MemoryState,
} from "../src/memory/model.ts";
import { applyPatch } from "../src/memory/patch.ts";
import { isPatchEmpty, missingExpireTargets } from "../src/memory/pending.ts";
import { reconcileCandidates } from "../src/memory/extract.ts";
import { renderMemorySection } from "../src/memory/render.ts";

let failures = 0;
const results: string[] = [];

function check(id: string, ok: boolean, detail = ""): void {
  results.push(`${id} ${ok ? "PASS" : "FAIL"}${detail ? ` ${detail}` : ""}`);
  if (!ok) failures += 1;
}

const FACT_A = "f-aaaaaaaaaaaa";
const FACT_B = "f-bbbbbbbbbbbb";
const FACT_C = "f-cccccccccccc";
const FACT_D = "f-dddddddddddd";
const FACT_E = "f-eeeeeeeeeeee";
const FACT_F = "f-ffffffffffff";

function person(subject: string, facts: { id: string; text: string; at?: number; invalidAt?: number }[], names: string[] = ["甲"]): MemoryPerson {
  return {
    subject,
    names,
    updatedAt: 1,
    catchphrases: [],
    facts: facts.map((fact) => ({
      id: fact.id,
      subject,
      text: fact.text,
      at: fact.at ?? 1,
      source: "stated" as const,
      hits: 0,
      ...(fact.invalidAt !== undefined ? { invalidAt: fact.invalidAt } : {}),
    })),
  };
}

function stateOf(people: MemoryPerson[]): MemoryState {
  const state = emptyMemory();
  for (const item of people) state.people[item.subject] = item;
  return state;
}

/** known 行格式：主体行 + `f-id YYYY-MM 文本`。 */
function knownOf(subject: string, facts: { id: string; text: string }[]): string {
  return [`${subject} 甲`, ...facts.map((fact) => `${fact.id} 2026-10 ${fact.text}`)].join("\n");
}

const KNOWLEDGE = {
  known: knownOf("qq:1001", [
    { id: FACT_A, text: "在玩机械动力" },
    { id: FACT_B, text: "在学 Rust" },
    { id: FACT_C, text: "养了只猫" },
    { id: FACT_D, text: "住在杭州" },
    { id: FACT_E, text: "在做毕业设计" },
    { id: FACT_F, text: "在考驾照" },
  ]),
  subjects: [{ subject: "qq:1001", name: "甲" }],
  inboundTexts: ["我早不玩机械动力了", "Rust 也不学了", "猫送人了", "搬去上海了", "毕业设计黄了", "驾照不考了"],
};

function reconcile(raw: unknown, mode: { review: boolean } = { review: false }) {
  return reconcileCandidates(raw, KNOWLEDGE, mode);
}

const exp = (factId: string, quote: string, extra: Record<string, unknown> = {}) => ({
  action: "EXPIRE",
  type: "fact",
  factId,
  quote,
  confidence: "high",
  ...extra,
});

// ── F1：EXPIRE 落库语义 ────────────────────────────────────────────────
{
  const before = stateOf([person("qq:1001", [{ id: FACT_A, text: "在玩机械动力" }])]);
  const after = applyPatch(before, { expire: [{ subject: "qq:1001", id: FACT_A, quote: "早不玩了" }] }, 999);
  const fact = after.people["qq:1001"]?.facts[0];
  const rendered = renderMemorySection(after, undefined, {});
  check(
    "F1",
    fact?.invalidAt === 999 && fact?.expiredReason === "早不玩了" && fact?.supersededBy === undefined && !(rendered ?? "").includes("机械动力"),
    `invalidAt=${fact?.invalidAt} reason=${fact?.expiredReason ?? "-"} supersededBy=${fact?.supersededBy ?? "-"}`,
  );
}

// ── F2：EXPIRE-only 不被静默丢（reconcile → 非空 → 白名单保留）──────
{
  const result = reconcile({ candidates: [exp(FACT_A, "我早不玩机械动力了")], skipped: 0 });
  const patch = result?.patch;
  check(
    "F2",
    result !== undefined && (patch?.expire?.length ?? 0) === 1 && patch !== undefined && !isPatchEmpty(patch),
    `expire=${patch?.expire?.length ?? 0} empty=${patch ? isPatchEmpty(patch) : "?"}`,
  );
}

// ── F3：factId 机械解析（伪造 subject 被忽略；未知 id 丢弃）───────────
{
  const forged = reconcile({ candidates: [exp(FACT_A, "我早不玩机械动力了", { subject: "qq:9999" })], skipped: 0 });
  const unknown = reconcile({ candidates: [exp("f-000000000000", "我早不玩机械动力了")], skipped: 0 });
  check(
    "F3",
    forged?.patch.expire?.[0]?.subject === "qq:1001" && (unknown?.patch.expire?.length ?? 0) === 0,
    `subject=${forged?.patch.expire?.[0]?.subject ?? "-"} unknown=${unknown?.patch.expire?.length ?? 0}`,
  );
}

// ── F4：quote 证据闸 ──────────────────────────────────────────────────
{
  const missing = reconcile({ candidates: [exp(FACT_A, "")], skipped: 0 });
  const absent = reconcile({ candidates: [{ action: "EXPIRE", type: "fact", factId: FACT_A, confidence: "high" }], skipped: 0 });
  const notInTranscript = reconcile({ candidates: [exp(FACT_A, "我早就不玩这个了")], skipped: 0 });
  const tooLong = reconcile({ candidates: [exp(FACT_A, "我早不玩机械动力了".repeat(10))], skipped: 0 });
  const privacy = reconcile({ candidates: [exp(FACT_A, "我的手机号 13800138000")], skipped: 0 });
  const ok = reconcile({ candidates: [exp(FACT_A, "我早不玩机械动力了")], skipped: 0 });
  check(
    "F4",
    (missing?.patch.expire?.length ?? 0) === 0 &&
      (absent?.patch.expire?.length ?? 0) === 0 &&
      (notInTranscript?.patch.expire?.length ?? 0) === 0 &&
      (tooLong?.patch.expire?.length ?? 0) === 0 &&
      (privacy?.patch.expire?.length ?? 0) === 0 &&
      (ok?.patch.expire?.length ?? 0) === 1,
    `ok=${ok?.patch.expire?.length ?? 0}`,
  );
}

// ── F5：防误杀与限额 ──────────────────────────────────────────────────
{
  const medium = reconcile({ candidates: [exp(FACT_A, "我早不玩机械动力了", { confidence: "medium" })], skipped: 0 });
  const lowReview = reconcile({ candidates: [exp(FACT_A, "我早不玩机械动力了", { confidence: "low" })], skipped: 0 }, { review: true });
  const dupId = reconcile({
    candidates: [exp(FACT_A, "我早不玩机械动力了"), exp(FACT_A, "Rust 也不学了")],
    skipped: 0,
  });
  const oneQuote = reconcile({
    candidates: [exp(FACT_A, "Rust 也不学了"), exp(FACT_B, "Rust 也不学了")],
    skipped: 0,
  });
  const many = reconcile({
    candidates: [
      exp(FACT_A, "我早不玩机械动力了"),
      exp(FACT_B, "Rust 也不学了"),
      exp(FACT_C, "猫送人了"),
      exp(FACT_D, "搬去上海了"),
      exp(FACT_E, "毕业设计黄了"),
      exp(FACT_F, "驾照不考了"),
    ],
    skipped: 0,
  });
  check(
    "F5",
    (medium?.patch.expire?.length ?? 0) === 0 &&
      (lowReview?.patch.expire?.length ?? 0) === 0 &&
      (dupId?.patch.expire?.length ?? 0) === 1 &&
      (oneQuote?.patch.expire?.length ?? 0) === 1 &&
      (many?.patch.expire?.length ?? 0) === MEMORY_EXPIRE_PER_PAGE,
    `dup=${dupId?.patch.expire?.length ?? 0} quote=${oneQuote?.patch.expire?.length ?? 0} many=${many?.patch.expire?.length ?? 0}`,
  );
}

// ── F6：supersede 优先（两种顺序）─────────────────────────────────────
{
  const supersede = {
    action: "SUPERSEDE",
    type: "fact",
    factId: FACT_A,
    text: "改玩星铁了",
    source: "stated",
    confidence: "high",
  };
  const expireFirst = reconcile({ candidates: [exp(FACT_A, "我早不玩机械动力了"), supersede], skipped: 0 });
  const supersedeFirst = reconcile({ candidates: [supersede, exp(FACT_A, "我早不玩机械动力了")], skipped: 0 });
  const applied = applyPatch(
    stateOf([person("qq:1001", [{ id: FACT_A, text: "在玩机械动力" }])]),
    expireFirst!.patch,
    555,
  );
  const oldFact = applied.people["qq:1001"]?.facts.find((fact) => fact.id === FACT_A);
  const newFact = applied.people["qq:1001"]?.facts.find((fact) => fact.text === "改玩星铁了");
  check(
    "F6",
    (expireFirst?.patch.expire?.length ?? 0) === 0 &&
      (supersedeFirst?.patch.expire?.length ?? 0) === 0 &&
      oldFact?.supersededBy !== undefined &&
      oldFact.supersededBy === newFact?.id,
    `expire=${expireFirst?.patch.expire?.length ?? 0}/${supersedeFirst?.patch.expire?.length ?? 0} supersededBy=${oldFact?.supersededBy ?? "-"}`,
  );
}

// ── F7：批准前的双轨预检 ──────────────────────────────────────────────
{
  const patch = { expire: [{ subject: "qq:1001", id: FACT_A, quote: "早不玩了" }] };
  const wrongDoc = stateOf([person("qq:1001", [{ id: FACT_B, text: "在学 Rust" }])]);
  const rightDoc = stateOf([person("qq:1001", [{ id: FACT_A, text: "在玩机械动力" }])]);
  const alreadyInvalid = stateOf([person("qq:1001", [{ id: FACT_A, text: "在玩机械动力", invalidAt: 1 }])]);
  const applied = applyPatch(rightDoc, patch, 777);
  check(
    "F7",
    missingExpireTargets(wrongDoc, patch).length === 1 &&
      missingExpireTargets(alreadyInvalid, patch).length === 1 &&
      missingExpireTargets(rightDoc, patch).length === 0 &&
      applied.people["qq:1001"]?.facts[0]?.invalidAt === 777,
    `wrong=${missingExpireTargets(wrongDoc, patch).length} right=${missingExpireTargets(rightDoc, patch).length}`,
  );
}

// ── F8：不回归（不新增 fact、失效仍计上限并优先淘汰、feedback 不受影响）──
{
  const base = stateOf([
    person("qq:1001", [
      { id: FACT_A, text: "过期项目", at: 1, invalidAt: 10 },
      { id: FACT_B, text: "b", at: 2 },
      { id: FACT_C, text: "c", at: 3 },
      { id: FACT_D, text: "d", at: 4 },
      { id: FACT_E, text: "e", at: 5 },
      { id: FACT_F, text: "f", at: 6 },
      { id: "f-111111111111", text: "g", at: 7 },
      { id: "f-222222222222", text: "h", at: 8 },
    ]),
  ]);
  const applied = applyPatch(base, { people: [{ subject: "qq:1001", facts: [{ text: "新事实", source: "stated" }] }] }, 100);
  const facts = applied.people["qq:1001"]?.facts ?? [];
  const feedbackOnly = applyPatch(base, { feedback: [] }, 100);
  check(
    "F8",
    facts.length <= MEMORY_CAPS.factsPerPerson &&
      facts.some((fact) => fact.text === "新事实") &&
      !facts.some((fact) => fact.id === FACT_A) &&
      Object.keys(feedbackOnly.people).length === Object.keys(base.people).length &&
      // EXPIRE 不新增 fact：apply 前后总数不增
      (applyPatch(stateOf([person("qq:1001", [{ id: FACT_A, text: "x" }])]), { expire: [{ subject: "qq:1001", id: FACT_A, quote: "q" }] }, 1).people["qq:1001"]?.facts.length ?? 0) === 1,
    `facts=${facts.length} expiredEvicted=${!facts.some((fact) => fact.id === FACT_A)}`,
  );
}

// ── F9：提示词与术语 ─────────────────────────────────────────────────
{
  const read = (name: string): string => readFileSync(join(REPO_ROOT, "prompt", name), "utf8");
  const rules = (text: string): boolean =>
    text.includes("EXPIRE") && text.includes("quote") && text.includes("逐字") && text.includes("high");
  check("F9", rules(read("memory-extract.md")) && rules(read("memory-extract-review.md")), "extract/review 关键片段");
}

for (const line of results) console.log(line);
console.log(failures === 0 ? "\n全部通过（F10 见 npm test）" : `\n${failures} 项未通过`);
process.exit(failures === 0 ? 0 : 1);
