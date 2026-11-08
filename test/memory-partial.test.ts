import test from "node:test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { createModels } from "@earendil-works/pi-ai/models";
import { fauxProvider } from "@earendil-works/pi-ai/providers/faux";
import { createSession } from "@earendil-works/pi-durable";
import { openNodeSqliteStorage } from "@earendil-works/pi-durable/storage/sqlite/node";
import { openFish, type Fish } from "../src/harness.ts";
import {
  aggregatePendingItems,
  approvePending,
  effectivePendingPatch,
  findPendingSelection,
  fingerprintPatch,
  missingExpireTargets,
  parseMemoryCommand,
  pendingItems,
  publicizePatch,
  splitPendingPatch,
  type FeedbackMeta,
  type MemoryApprovalPreparation,
  type MemoryPatch,
  type MemoryState,
  type PendingMemoryEntry,
} from "../src/memory/index.ts";
import { privateMemoryKeyOf } from "../src/memory/scope.ts";
import { MemoryDoc, MemoryPendingDoc, MemoryPrivateDoc } from "../src/store.ts";

const ctx = BACKGROUND_CONTEXT;
const ROOT = fileURLToPath(new URL("..", import.meta.url));
const PROMPTS = fileURLToPath(new URL("../prompt", import.meta.url));
const exec = promisify(execFile);
const origin = "qq:group:42";
const persona = "默认";

function emptyMemory(): MemoryState {
  return { version: 1, people: {}, lore: [], cards: [] };
}

function entryOf(id: string, patch: MemoryPatch): PendingMemoryEntry {
  const items = splitPendingPatch(id, patch);
  return { id, patch: aggregatePendingItems(items), items, originChatKey: origin, at: 1 };
}

async function boot(dbPath: string): Promise<Fish> {
  const faux = fauxProvider();
  const models = createModels();
  models.setProvider(faux.provider);
  return openFish({
    storage: await openNodeSqliteStorage(dbPath),
    models,
    model: { provider: faux.provider.id, modelId: faux.models[0].id },
    promptRoot: PROMPTS,
    mediaRoot: mkdtempSync(join(tmpdir(), "yg-mp-media-")),
    workspaceRoot: mkdtempSync(join(tmpdir(), "yg-mp-work-")),
    emit: () => {},
    react: () => {},
  });
}

async function seed(fish: Fish, entry: PendingMemoryEntry, key = persona): Promise<void> {
  await fish.harness.commit(async (tx) => {
    const pending = await tx.doc(MemoryPendingDoc, key, key);
    pending.entries.push(entry);
  }, ctx);
}

function factTexts(state: MemoryState | undefined, subject = "qq:1"): string[] {
  return (state?.people[subject]?.facts ?? []).filter((fact) => fact.invalidAt === undefined).map((fact) => fact.text).sort();
}

function publicOutput(subject: string, texts: string[]): string {
  return JSON.stringify({
    people: texts.map((text) => ({ subject, facts: [text] })),
    lore: [],
    cards: [],
  });
}

test("拆分聚合保留重复 subject、稳定子项 id 与完整资料", () => {
  const patch: MemoryPatch = {
    people: [
      { subject: "qq:1", names: ["甲"], style: "简短", catchphrases: ["嗯"], facts: [{ text: "事实甲", source: "stated" }] },
      { subject: "qq:1", names: ["二甲"], facts: [{ text: "事实乙", source: "observed" }] },
    ],
    lore: [{ keys: ["梗"], text: "说法原文", kind: "word" }],
    cards: [{ text: "卡片原文", importance: 2, keys: ["卡"], subjects: ["qq:1"] }],
    feedback: [{ text: "主人原话", meta: { direction: "好", targetSummary: "目标", statsLine: "统计", day: "2026-11-08" } }],
  };
  const items = splitPendingPatch("p-split", patch);
  assert.deepEqual(items.map((item) => item.id), ["p-split#01", "p-split#02", "p-split#03", "p-split#04", "p-split#05", "p-split#06", "p-split#07"]);
  assert.equal(items[0]?.patch.people?.[0]?.style, "简短");
  assert.equal(items[0]?.patch.people?.[0]?.catchphrases?.[0], "嗯");
  assert.equal(items[1]?.patch.people?.[0]?.facts?.[0]?.text, "事实甲");
  assert.equal(items[3]?.patch.people?.[0]?.facts?.[0]?.text, "事实乙");
  const entry = entryOf("p-split", patch);
  assert.deepEqual(effectivePendingPatch(entry), aggregatePendingItems(items));
  assert.equal((effectivePendingPatch(entry).people ?? []).filter((person) => person.subject === "qq:1").length, 4);
  assert.equal(findPendingSelection([entry], "p-split#02")?.patch.people?.[0]?.facts?.[0]?.text, "事实甲");
  assert.equal(findPendingSelection([entry], "p-other#02"), undefined);
  assert.equal(findPendingSelection([entry], "p-split#02#03"), undefined);
  assert.equal(fingerprintPatch({ lore: patch.lore, people: [] }), fingerprintPatch({ people: [], lore: patch.lore }));
  assert.deepEqual(parseMemoryCommand("/记忆 查看 p-split"), { kind: "view", id: "p-split" });
  assert.deepEqual(parseMemoryCommand("/记忆 同意 p-split#02 私有"), { kind: "approve", id: "p-split#02", track: "私有" });

  const duplicateSubject = splitPendingPatch("p-duplicate", {
    people: [
      { subject: "qq:1", facts: [{ text: "第一新事实", source: "stated" }] },
      { subject: "qq:1", facts: [{ text: "第二新事实", source: "stated" }] },
    ],
    supersede: [{ subject: "qq:1", ids: ["f-old"] }],
  });
  assert.equal(duplicateSubject[0]?.patch.supersede?.length, 1);
  assert.equal(duplicateSubject[1]?.patch.supersede, undefined, "同一 supersede 绑定到了同 subject 的多个新事实");
});

test("连续私有子项批准、SQLite 重开与父批剩余保持稳定", async () => {
  const dbPath = join(mkdtempSync(join(tmpdir(), "yg-mp-db-")), "fish.db");
  const entry = entryOf("p-stable", {
    people: [{ subject: "qq:1", names: ["甲"], facts: [
      { text: "事实甲", source: "stated" },
      { text: "事实乙", source: "observed" },
    ] }],
    lore: [{ keys: ["梗"], text: "说法原文", kind: "word" }],
  });
  const first = await boot(dbPath);
  await seed(first, entry);
  try {
    const secondFact = await first.approveMemory("p-stable#03", "私有");
    assert.equal(secondFact.status, "ok");
    if (secondFact.status === "ok") assert.equal(secondFact.remaining, 3);
    let priv = await first.harness.snapshot(MemoryPrivateDoc, privateMemoryKeyOf(persona, origin), ctx);
    assert.deepEqual(factTexts(priv), ["事实乙"]);
    assert.equal(priv?.people["qq:1"]?.facts[0]?.fromChat, origin);
    let pending = await first.harness.snapshot(MemoryPendingDoc, persona, ctx);
    assert.deepEqual(pendingItems(pending!.entries[0]!).map((item) => item.id), ["p-stable#01", "p-stable#02", "p-stable#04"]);
    assert.deepEqual(effectivePendingPatch(pending!.entries[0]!), aggregatePendingItems(pending!.entries[0]!.items!));

    const profile = await first.approveMemory("p-stable#01", "私有");
    assert.equal(profile.status, "ok");
    assert.deepEqual((await first.harness.snapshot(MemoryPendingDoc, persona, ctx))?.entries[0]?.items?.map((item) => item.id), ["p-stable#02", "p-stable#04"]);
    assert.equal((await first.approveMemory("p-stable#99", "私有")).status, "missing");
    priv = await first.harness.snapshot(MemoryPrivateDoc, privateMemoryKeyOf(persona, origin), ctx);
    assert.deepEqual(priv?.people["qq:1"]?.names, ["甲"]);
    assert.deepEqual(factTexts(priv), ["事实乙"], "错误 selector 不得改变目标");
  } finally {
    await first.close();
  }

  const second = await boot(dbPath);
  try {
    const pending = await second.harness.snapshot(MemoryPendingDoc, persona, ctx);
    assert.deepEqual(pending?.entries[0]?.items?.map((item) => item.id), ["p-stable#02", "p-stable#04"], "重开后重新编号了");
    const detail = await second.memoryCommandReply("qq:private:master", { kind: "view", id: "p-stable" });
    assert.match(detail, /p-stable#02/);
    assert.match(detail, /p-stable#04/);
    assert.ok(!detail.includes("p-stable#01"));
    const all = await second.approveMemory("p-stable", "私有");
    assert.equal(all.status, "ok");
    if (all.status === "ok") assert.equal(all.remaining, 0);
    const priv = await second.harness.snapshot(MemoryPrivateDoc, privateMemoryKeyOf(persona, origin), ctx);
    assert.deepEqual(new Set(factTexts(priv)), new Set(["事实甲", "事实乙"]));
    assert.equal(priv?.lore[0]?.text, "说法原文");
    assert.equal((await second.harness.snapshot(MemoryPendingDoc, persona, ctx))?.entries.length, 0);
  } finally {
    await second.close();
  }
});

test("旧父条目与旧 feedback 子项兼容，群内指令无副作用", async () => {
  const fish = await boot(join(mkdtempSync(join(tmpdir(), "yg-mp-db-")), "fish.db"));
  try {
    await seed(fish, { id: "p-old", patch: { lore: [{ keys: ["旧"], text: "旧说法", kind: "word" }] }, originChatKey: origin, at: 1 });
    const feedback: FeedbackMeta = {
      kind: "feedback",
      direction: "好",
      targetSummary: "被评内容",
      statsLine: "统计行",
      day: "2026-11-08",
      contextRefs: [],
      chatKey: origin,
      persona,
      masterText: "主人评价原文",
    };
    await seed(fish, { id: "p-feedback", patch: {}, feedback, originChatKey: origin, at: 2 });
    assert.equal((await fish.approveMemory("p-old", "私有")).status, "ok");
    assert.equal((await fish.harness.snapshot(MemoryPrivateDoc, privateMemoryKeyOf(persona, origin), ctx))?.lore[0]?.text, "旧说法");

    const groupReply = await fish.memoryCommandReply("qq:group:42", { kind: "approve", id: "p-feedback#01", track: "私有" });
    assert.match(groupReply, /私聊/);
    assert.equal((await fish.harness.snapshot(MemoryPrivateDoc, privateMemoryKeyOf(persona, origin), ctx))?.feedback, undefined);
    const detail = await fish.memoryCommandReply("qq:private:master", { kind: "view", id: "p-feedback" });
    assert.match(detail, /p-feedback#01/);
    assert.match(detail, /主人评价原文/);
    const approved = await fish.memoryCommandReply("qq:private:master", { kind: "approve", id: "p-feedback#01", track: "私有" });
    assert.match(approved, /剩余 0 项/);
    const priv = await fish.harness.snapshot(MemoryPrivateDoc, privateMemoryKeyOf(persona, origin), ctx);
    assert.equal(priv?.feedback?.length, 1);
    assert.equal(priv?.feedback?.[0]?.text, "主人评价原文");
    assert.equal(priv?.feedback?.[0]?.fromChat, origin);
    assert.equal((await fish.harness.snapshot(MemoryPendingDoc, persona, ctx))?.entries.length, 0);
  } finally {
    await fish.close();
  }
});

test("supersede 与替代事实同项展示并应用，expire 在最终事务重检", async () => {
  const fish = await boot(join(mkdtempSync(join(tmpdir(), "yg-mp-db-")), "fish.db"));
  const privKey = privateMemoryKeyOf(persona, origin);
  try {
    await fish.harness.commit(async (tx) => {
      const doc = await tx.doc(MemoryPrivateDoc, privKey, privKey);
      doc.people["qq:1"] = {
        subject: "qq:1",
        names: [],
        catchphrases: [],
        updatedAt: 1,
        facts: [
          { id: "f-old", subject: "qq:1", text: "旧事实原文", at: 1, source: "stated", hits: 0 },
          { id: "f-expire", subject: "qq:1", text: "待淘汰原文", at: 1, source: "stated", hits: 0 },
        ],
      };
    }, ctx);
    await seed(fish, entryOf("p-replace", {
      people: [{ subject: "qq:1", facts: [
        { text: "新事实甲", source: "stated" },
        { text: "新事实乙", source: "stated" },
      ] }],
      supersede: [{ subject: "qq:1", ids: ["f-old"] }],
    }));
    await seed(fish, entryOf("p-expire", { expire: [{ subject: "qq:1", id: "f-expire", quote: "本人说已经变了" }] }));

    const detail = await fish.memoryCommandReply("qq:private:master", { kind: "view", id: "p-replace" });
    assert.match(detail, /p-replace#01/);
    assert.match(detail, /将随本项失效：f-old 旧事实原文/);
    assert.equal(detail.match(/将随本项失效/g)?.length, 1, "同 subject 第二条事实不应重复绑定");
    const replaced = await fish.approveMemory("p-replace#01", "私有");
    assert.equal(replaced.status, "ok");
    const afterReplace = await fish.harness.snapshot(MemoryPrivateDoc, privKey, ctx);
    const old = afterReplace?.people["qq:1"]?.facts.find((fact) => fact.id === "f-old");
    const replacement = afterReplace?.people["qq:1"]?.facts.find((fact) => fact.text === "新事实甲");
    assert.ok(old?.invalidAt !== undefined);
    assert.equal(old?.supersededBy, replacement?.id);
    assert.deepEqual((await fish.harness.snapshot(MemoryPendingDoc, persona, ctx))?.entries.find((entry) => entry.id === "p-replace")?.items?.map((item) => item.id), ["p-replace#02"]);

    const before = await fish.harness.snapshot(MemoryPrivateDoc, privKey, ctx);
    assert.deepEqual(missingExpireTargets(before, { expire: [{ subject: "qq:1", id: "f-expire", quote: "本人说已经变了" }] }), []);
    // 模拟早期预检完成后、最终批准前目标已被另一事务失效；最终事务必须重新读取并拒绝。
    await fish.harness.commit(async (tx) => {
      const doc = await tx.doc(MemoryPrivateDoc, privKey, privKey);
      const target = doc.people["qq:1"]?.facts.find((fact) => fact.id === "f-expire");
      if (target) target.invalidAt = 2;
    }, ctx);
    const expired = await fish.approveMemory("p-expire#01", "私有");
    assert.equal(expired.status, "expire_mismatch");
    assert.equal((await fish.harness.snapshot(MemoryPendingDoc, persona, ctx))?.entries.some((entry) => entry.id === "p-expire"), true, "失败时待审被删了");
  } finally {
    await fish.close();
  }
});

test("独立 supersede 明示无替代，成功与最终事务失败都可回归", async () => {
  const fish = await boot(join(mkdtempSync(join(tmpdir(), "yg-mp-db-")), "fish.db"));
  const privKey = privateMemoryKeyOf(persona, origin);
  try {
    await fish.harness.commit(async (tx) => {
      const doc = await tx.doc(MemoryPrivateDoc, privKey, privKey);
      doc.people["qq:1"] = {
        subject: "qq:1",
        names: [],
        catchphrases: [],
        updatedAt: 1,
        facts: [
          { id: "f-independent", subject: "qq:1", text: "独立旧事实", at: 1, source: "stated", hits: 0 },
          { id: "f-race", subject: "qq:1", text: "交错旧事实", at: 1, source: "stated", hits: 0 },
        ],
      };
    }, ctx);
    await seed(fish, entryOf("p-independent", { supersede: [{ subject: "qq:1", ids: ["f-independent"] }] }));
    await seed(fish, entryOf("p-independent-race", { supersede: [{ subject: "qq:1", ids: ["f-race"] }] }));

    const detail = await fish.memoryCommandReply("qq:private:master", { kind: "view", id: "p-independent" });
    assert.match(detail, /仅失效、无替代：f-independent 独立旧事实/);
    assert.ok(!detail.includes("将随本项失效"));
    const approved = await fish.approveMemory("p-independent#01", "私有");
    assert.equal(approved.status, "ok");
    const afterSuccess = await fish.harness.snapshot(MemoryPrivateDoc, privKey, ctx);
    const old = afterSuccess?.people["qq:1"]?.facts.find((fact) => fact.id === "f-independent");
    assert.ok(old?.invalidAt !== undefined);
    assert.equal(old?.supersededBy, undefined);
    assert.equal((await fish.harness.snapshot(MemoryPendingDoc, persona, ctx))?.entries.some((entry) => entry.id === "p-independent"), false);

    // 早期检查有效后，另一事务先失效目标；最终批准必须完整回滚。
    const beforeTarget = await fish.harness.snapshot(MemoryPrivateDoc, privKey, ctx);
    await fish.harness.commit(async (tx) => {
      const doc = await tx.doc(MemoryPrivateDoc, privKey, privKey);
      const target = doc.people["qq:1"]?.facts.find((fact) => fact.id === "f-race");
      if (target) target.invalidAt = 2;
    }, ctx);
    const targetBeforeFailure = await fish.harness.snapshot(MemoryPrivateDoc, privKey, ctx);
    const pendingBeforeFailure = await fish.harness.snapshot(MemoryPendingDoc, persona, ctx);
    const mismatch = await fish.approveMemory("p-independent-race#01", "私有");
    assert.equal(mismatch.status, "supersede_mismatch");
    assert.deepEqual(await fish.harness.snapshot(MemoryPrivateDoc, privKey, ctx), targetBeforeFailure);
    assert.deepEqual(await fish.harness.snapshot(MemoryPendingDoc, persona, ctx), pendingBeforeFailure);
    assert.notDeepEqual(targetBeforeFailure, beforeTarget);
  } finally {
    await fish.close();
  }
});

test("父公共化等待期间子项私有批准会 conflict，不复活也不串轨", async () => {
  const fish = await boot(join(mkdtempSync(join(tmpdir(), "yg-mp-db-")), "fish.db"));
  try {
    await seed(fish, entryOf("p-race", {
      people: [{ subject: "qq:1", facts: [{ text: "事实甲", source: "stated" }, { text: "事实乙", source: "stated" }] }],
    }));
    const pending = await fish.harness.snapshot(MemoryPendingDoc, persona, ctx);
    const parent = findPendingSelection(pending!.entries, "p-race")!;
    const expectedFingerprint = fingerprintPatch(parent.patch);
    let release!: () => void;
    let started!: () => void;
    const startedPromise = new Promise<void>((resolve) => { started = resolve; });
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const publicizing = publicizePatch(parent.patch, {
      template: "{{patch}}",
      complete: async () => {
        started();
        await gate;
        return publicOutput("qq:1", ["公共甲", "公共乙"]);
      },
    });
    await startedPromise;
    const privateResult = await fish.approveMemory("p-race#01", "私有");
    assert.equal(privateResult.status, "ok");
    release();
    const publicized = await publicizing;
    assert.equal(publicized.status, "ok");
    if (publicized.status !== "ok") return;
    const preparation: MemoryApprovalPreparation = {
      selector: "p-race",
      expectedFingerprint,
      approvedPatch: publicized.patch,
    };
    const conflict = await fish.approveMemory("p-race", "公共", preparation);
    assert.equal(conflict.status, "changed");

    assert.equal(await fish.harness.snapshot(MemoryDoc, persona, ctx), undefined, "冲突时创建了空公共 doc");
    const remaining = await fish.harness.snapshot(MemoryPendingDoc, persona, ctx);
    assert.deepEqual(remaining?.entries[0]?.items?.map((item) => item.id), ["p-race#02"], "旧公共化快照复活了已私有批准子项");
    assert.deepEqual(factTexts(await fish.harness.snapshot(MemoryPrivateDoc, privateMemoryKeyOf(persona, origin), ctx)), ["事实甲"]);
    assert.deepEqual(factTexts(await fish.harness.snapshot(MemoryDoc, persona, ctx)), [], "冲突时把旧快照写进公共层了");

    // 用当前剩余子项重新准备：模型输入不得包含已批准的甲，也不能混入其它子项。
    let promptSeen = "";
    const current = findPendingSelection((await fish.harness.snapshot(MemoryPendingDoc, persona, ctx))!.entries, "p-race#02")!;
    const childPublicized = await publicizePatch(current.patch, {
      template: "{{patch}}",
      complete: async (prompt) => {
        promptSeen = prompt;
        return publicOutput("qq:1", ["公共乙"]);
      },
    });
    assert.equal(childPublicized.status, "ok");
    if (childPublicized.status !== "ok") return;
    assert.match(promptSeen, /事实乙/);
    assert.ok(!promptSeen.includes("事实甲"));
    const approved = await fish.approveMemory("p-race#02", "公共", {
      selector: "p-race#02",
      expectedFingerprint: fingerprintPatch(current.patch),
      approvedPatch: childPublicized.patch,
    });
    assert.equal(approved.status, "ok");
    if (approved.status === "ok") assert.match(approved.digest, /公共乙/);
    assert.deepEqual(factTexts(await fish.harness.snapshot(MemoryDoc, persona, ctx)), ["公共乙"]);
    assert.deepEqual(factTexts(await fish.harness.snapshot(MemoryPrivateDoc, privateMemoryKeyOf(persona, origin), ctx)), ["事实甲"]);
    assert.equal((await fish.harness.snapshot(MemoryPendingDoc, persona, ctx))?.entries.length, 0);
  } finally {
    await fish.close();
  }
});

test("纯资料、feedback 与纯失效公共化不调用模型，无准备不能绕过公共化", async () => {
  let calls = 0;
  for (const patch of [
    { people: [{ subject: "qq:1", names: ["甲"] }] },
    { feedback: [{ text: "主人原话", meta: { direction: "好" as const, targetSummary: "目标", statsLine: "统计", day: "2026-11-08" } }] },
    { expire: [{ subject: "qq:1", id: "f-old", quote: "本人说变了" }] },
  ]) {
    const result = await publicizePatch(patch, { template: "{{patch}}", complete: async () => { calls++; throw new Error("不应调用"); } });
    assert.equal(result.status, "ok");
  }
  assert.equal(calls, 0);
  const fish = await boot(join(mkdtempSync(join(tmpdir(), "yg-mp-db-")), "fish.db"));
  try {
    await seed(fish, entryOf("p-public", { lore: [{ keys: ["梗"], text: "原文", kind: "word" }] }));
    assert.equal((await fish.approveMemory("p-public#01", "公共")).status, "publicize_required");
    assert.equal((await fish.harness.snapshot(MemoryPendingDoc, persona, ctx))?.entries.length, 1);
    assert.equal(factTexts(await fish.harness.snapshot(MemoryDoc, persona, ctx)).length, 0);
  } finally {
    await fish.close();
  }
});

test("CLI 列出子项并批准残留人格的单个候选", async () => {
  const home = mkdtempSync(join(tmpdir(), "yg-mp-home-"));
  const storage = await openNodeSqliteStorage(join(home, "fish.db"));
  const session = createSession(storage);
  const residual = "已删除人格";
  await session.commit(async (tx) => {
    const pending = await tx.doc(MemoryPendingDoc, residual, residual);
    pending.entries.push(entryOf("p-residual", {
      people: [{ subject: "qq:1", facts: [{ text: "保留甲", source: "stated" }, { text: "只批乙", source: "stated" }] }],
      supersede: [{ subject: "qq:other", ids: ["f-independent-cli"] }],
    }));
    pending.entries.push(entryOf("p-cli-profile", {
      people: [{ subject: "qq:1", names: ["甲"] }, { subject: "qq:2", names: ["乙"] }],
    }));
  }, ctx);
  await session.close(ctx);

  const env = { ...process.env, YUGANG_HOME: home };
  const listed = await exec(process.execPath, ["--env-file-if-exists=.env", "scripts/memory.ts", "--pending"], { cwd: ROOT, env });
  assert.match(listed.stdout, /p-residual#01/);
  assert.match(listed.stdout, /p-residual#02/);
  assert.match(listed.stdout, /只批乙/);
  assert.match(listed.stdout, /仅失效、无替代：f-independent-cli/);
  const approved = await exec(process.execPath, ["--env-file-if-exists=.env", "scripts/memory.ts", "--approve", "p-residual#02"], { cwd: ROOT, env });
  assert.match(approved.stdout, /剩余 2 项/);
  // 纯资料公共子项不调用模型，覆盖 CLI prepare + fingerprint + 最终事务。
  const publicApproved = await exec(process.execPath, ["--env-file-if-exists=.env", "scripts/memory.ts", "--approve", "p-cli-profile#02", "公共"], { cwd: ROOT, env });
  assert.match(publicApproved.stdout, /剩余 1 项/);

  const verifySession = createSession(await openNodeSqliteStorage(join(home, "fish.db")));
  try {
    const pending = await verifySession.snapshot(MemoryPendingDoc, residual, ctx);
    assert.deepEqual(pending?.entries[0]?.items?.map((item) => item.id), ["p-residual#01", "p-residual#03"]);
    assert.deepEqual(pending?.entries[1]?.items?.map((item) => item.id), ["p-cli-profile#01"]);
    const priv = await verifySession.snapshot(MemoryPrivateDoc, privateMemoryKeyOf(residual, origin), ctx);
    assert.deepEqual(factTexts(priv), ["只批乙"]);
    const pub = await verifySession.snapshot(MemoryDoc, residual, ctx);
    assert.deepEqual(Object.keys(pub?.people ?? {}), ["qq:2"]);
    assert.deepEqual(pub?.people["qq:2"]?.names, ["乙"]);
  } finally {
    await verifySession.close(ctx);
  }
});
