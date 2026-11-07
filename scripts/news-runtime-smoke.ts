/** 生产 runtime 新闻竞态 smoke：独立进程隔离 ROOT，真实 submitRound / freeze stage / engage。 */
import assert from "node:assert/strict";
import { appendFileSync, copyFileSync, existsSync, mkdirSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { randomUUID } from "node:crypto";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";

const REPO = fileURLToPath(new URL("../", import.meta.url));
const RUN_ID = `${Date.now().toString(36)}-${randomUUID().slice(0, 8)}`;
const ROOT = join(REPO, "var", "local-driver", `news-runtime-smoke-${RUN_ID}`);
const EVIDENCE = join(ROOT, "evidence.jsonl");
const GROUP = "900001";
const CHAT = `qq:group:${GROUP}`;
const today = new Date();
const DAY = `${today.getFullYear()}-${String(today.getMonth() + 1).padStart(2, "0")}-${String(today.getDate()).padStart(2, "0")}`;
const RUN_KEY = `${DAY} ${GROUP}`;
mkdirSync(join(ROOT, "config"), { recursive: true });
mkdirSync(join(ROOT, "var"), { recursive: true });
copyFileSync(join(REPO, "config", "models.json"), join(ROOT, "config", "models.json"));
if (existsSync(join(REPO, "config", "auth.json"))) copyFileSync(join(REPO, "config", "auth.json"), join(ROOT, "config", "auth.json"));
symlinkSync(join(REPO, "prompt"), join(ROOT, "prompt"), "dir");
writeFileSync(join(ROOT, "fish.config.json"), JSON.stringify({
  engage: { freeSeconds: 15, freeBrowseChance: 0, freeBatchMax: 50 },
  salvagePlainReply: false,
}, null, 2));
process.env.YUGANG_ROOT = ROOT;
process.env.YUGANG_HOME = join(ROOT, "var");
process.env.GROUPS = GROUP;
process.env.MASTER_QQ = "10000";
process.env.ONEBOT_WS_URL = "ws://127.0.0.1:1";
process.env.ONEBOT_TOKEN = "local-smoke";
process.chdir(ROOT);

function evidence(value: Record<string, unknown>): void {
  const row = { at: new Date().toISOString(), ...value };
  appendFileSync(EVIDENCE, JSON.stringify(row) + "\n");
  console.log(JSON.stringify(row));
}

const runtime = await import(pathToFileURL(join(REPO, "src", "app", "runtime.ts")).href);
const { NewsFrozenError } = await import(pathToFileURL(join(REPO, "src", "external", "news-freeze.ts")).href);
const { OutboxDoc } = await import(pathToFileURL(join(REPO, "src", "store.ts")).href);

await runtime.bootRuntime();
const fish = runtime.runtimeFish();
const conv = await runtime.conversationFor(CHAT);
const originalDrain = fish.drain;
fish.drain = async () => 0;

async function holdAbsorb(): Promise<{ entered: Promise<void>; release: () => void; restore: () => void }> {
  const original = conv.viewState;
  let enteredResolve!: () => void;
  let releaseResolve!: () => void;
  const entered = new Promise<void>((resolve) => { enteredResolve = resolve; });
  const held = new Promise<void>((resolve) => { releaseResolve = resolve; });
  conv.viewState = async (...args: Parameters<typeof conv.viewState>): ReturnType<typeof conv.viewState> => {
    enteredResolve();
    await held;
    return original.apply(conv, args);
  };
  return {
    entered,
    release: () => releaseResolve(),
    restore: () => { conv.viewState = original; },
  };
}

async function assistantCount(): Promise<number> {
  const view = await conv.viewState(BACKGROUND_CONTEXT);
  try {
    return view.value.entries.filter((entry) => entry.kind === "pi.assistant").length;
  } finally {
    view.dispose();
  }
}

async function waitFor(check: () => Promise<boolean>, timeoutMs = 90_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    if (await check()) return;
    if (Date.now() >= deadline) throw new Error("wait_for_timeout");
    await new Promise<void>((resolve) => setTimeout(resolve, 20));
  }
}

try {
  // R1 真实生产路径：第一次准入后登记在途，absorbSecrets 等待期间冻结，第二次准入拒绝。
  const frozen = await holdAbsorb();
  const ambient = runtime.submitRound({
    chatKey: CHAT,
    conv,
    content: "冻结交错测试",
    trigger: { kind: "ambient", mentionsBot: false, userId: 10001 },
    reply: false,
    entryKind: "fish.engage_tick",
  });
  await frozen.entered;
  runtime.newsFreezes.freeze(CHAT, {
    runId: RUN_KEY,
    conversationId: String(conv.id),
    attempt: 1,
    publishAt: Date.now() + 60_000,
  });
  frozen.release();
  await assert.rejects(ambient, NewsFrozenError);
  frozen.restore();
  assert.equal(runtime.conversationBusy(conv.id), false, "冻结拒绝不得泄漏 nextInFlight");
  runtime.newsFreezes.unfreeze(CHAT, RUN_KEY);
  evidence({ stage: "R1-runtime", status: "pass", busy: runtime.conversationBusy(conv.id) });

  // 同一生产入口的 deadline 分支也必须释放在途登记。
  runtime.newsFreezes.freeze(CHAT, {
    runId: RUN_KEY,
    conversationId: String(conv.id),
    attempt: 1,
    publishAt: Date.now() + 60_000,
  });
  const expiring = await holdAbsorb();
  const news = runtime.submitRound({
    chatKey: CHAT,
    conv,
    content: "截止交错测试",
    trigger: { kind: "news", mentionsBot: false, newsRunId: RUN_KEY, newsAttempt: 1 },
    reply: false,
    entryKind: "fish.engage_tick",
    deadline: Date.now() + 20,
  });
  await expiring.entered;
  await new Promise<void>((resolve) => setTimeout(resolve, 30));
  expiring.release();
  await assert.rejects(news, runtime.NewsDeadlineError);
  expiring.restore();
  assert.equal(runtime.conversationBusy(conv.id), false, "deadline 拒绝不得泄漏 nextInFlight");
  runtime.newsFreezes.unfreeze(CHAT, RUN_KEY);
  evidence({ stage: "deadline-runtime", status: "pass", busy: runtime.conversationBusy(conv.id) });

  // 真实 newsFreezeStage：@ 机械入队且不往 next，非 @ 进真实 engage 收集器，解冻后真实模型处理。
  runtime.newsFreezes.freeze(CHAT, {
    runId: RUN_KEY,
    conversationId: String(conv.id),
    attempt: 1,
    publishAt: Date.now() + 60_000,
  });
  let nextCalled = false;
  await runtime.newsFreezeStage({
    msg: {
      chatKey: CHAT,
      groupId: GROUP,
      userId: 10001,
      nickname: "虚构群友",
      text: "@鱼 冻结期必答",
      mentionsBot: true,
      messageId: 501,
      replyIds: [],
      mentions: [],
      media: [],
    },
    burstText: "@鱼 冻结期必答",
    decision: { enter: true, reason: "mentioned" },
    bucket: [],
  }, async () => { nextCalled = true; });
  assert.equal(nextCalled, false);
  const mechanical = await fish.harness.snapshot(OutboxDoc, conv.id, BACKGROUND_CONTEXT);
  assert.ok(mechanical?.queue.some((item) => item.key === `news-preparing:${DAY}:501`));

  runtime.startEngage();
  await runtime.newsFreezeStage({
    msg: {
      chatKey: CHAT,
      groupId: GROUP,
      userId: 10001,
      nickname: "虚构群友",
      text: "解冻后只回复两个字：在的",
      mentionsBot: false,
      messageId: 502,
      arrivalSeq: 502,
      replyIds: [],
      mentions: [],
      media: [],
    },
    burstText: "解冻后只回复两个字：在的",
    decision: { enter: true, reason: "free_pass" },
    bucket: [],
  }, async () => { nextCalled = true; });
  assert.equal(nextCalled, false);
  const before = await assistantCount();
  runtime.newsFreezes.unfreeze(CHAT, RUN_KEY);
  await waitFor(async () => await assistantCount() > before && !runtime.conversationBusy(conv.id));
  await new Promise<void>((resolve) => setTimeout(resolve, 500));
  evidence({ stage: "N2-runtime", status: "pass", mechanical: true, ambientRecovered: true, busy: runtime.conversationBusy(conv.id) });
  evidence({ stage: "summary", status: "pass", root: ROOT });
} finally {
  runtime.stopEngage();
  runtime.stopNews();
  fish.drain = originalDrain;
  await runtime.closeFish();
}
