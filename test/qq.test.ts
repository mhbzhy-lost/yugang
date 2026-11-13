/**
 * QQ 侧三件事：
 *  - 群档案只在建会话时写一次，身份只用群号/人数/成员 QQ 号锚定（无群名/昵称）
 *  - look 只能看媒体目录里的图，且一轮最多两次
 *  - react 只贴表情，不产生文本，但会被限流
 */
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { createModels } from "@earendil-works/pi-ai/models";
import { fauxAssistantMessage, fauxProvider, fauxToolCall } from "@earendil-works/pi-ai/providers/faux";
import { MemoryStorage } from "@earendil-works/pi-durable";
import { openFish } from "../src/harness.ts";
import { OutboxDoc } from "../src/store.ts";
import { withContext } from "../src/channels/qq/round-input.ts";
import type { IncomingMessage } from "../src/channels/qq/onebot.ts";

const ctx = BACKGROUND_CONTEXT;
const PROMPTS = fileURLToPath(new URL("../prompt", import.meta.url));
const PNG = readFileSync(fileURLToPath(new URL("./fixtures/dot.png", import.meta.url)));

interface BootOverrides {
  emit?: (id: string, payload: { key: string; items: string[] }) => void | Promise<void>;
  react?: (id: string, emoji: string, messageId?: number | string) => void;
  triggerOf?: (roundId: unknown) => { messageId?: number | string; mentionsBot: boolean; userId?: number } | undefined;
}

function boot(overrides: BootOverrides = {}) {
  const faux = fauxProvider();
  const models = createModels();
  models.setProvider(faux.provider);
  const mediaRoot = mkdtempSync(join(tmpdir(), "yg-media-"));
  const workspaceRoot = mkdtempSync(join(tmpdir(), "yg-ws-"));
  const reacts: string[] = [];
  const reactCalls: { emoji: string; messageId?: number | string }[] = [];
  const fish = openFish({
    storage: new MemoryStorage(),
    models,
    model: { provider: faux.provider.id, modelId: faux.models[0].id },
    promptRoot: PROMPTS,
    mediaRoot,
    workspaceRoot,
    emit: overrides.emit ?? (() => {}),
    react: (id, emoji, messageId) => {
      reacts.push(emoji);
      reactCalls.push({ emoji, ...(messageId !== undefined ? { messageId } : {}) });
      overrides.react?.(String(id), emoji, messageId);
    },
    ...(overrides.triggerOf ? { triggerOf: overrides.triggerOf } : {}),
  });
  return { faux, mediaRoot, reacts, reactCalls, fish };
}

test("群档案写进 transcript，身份只锚定群号与成员 QQ 号", async () => {
  const { fish } = boot();
  const open = await fish;
  try {
    const conv = await open.group("qq:group:42", {
      groupId: "42",
      count: 3,
      master: "1000",
      members: [
        { nickname: "张三", userId: "2000" },
        { nickname: "李四", userId: "2001" },
      ],
    });
    const view = await conv.viewState(ctx);
    const entry = view.value.entries.find((e) => e.kind === "fish.group-profile");
    assert.ok(entry, "没有写群档案");
    const text = JSON.stringify(entry.model ?? "");
    // 身份只用群号与人数锚定，不写群名/群主昵称等外部文本
    assert.match(text, /群号 42/);
    assert.match(text, /3 人/);
    // 群档案 system prompt 只放成员 QQ 号，昵称不再进入
    assert.match(text, /2000/);
    assert.match(text, /2001/);
    assert.doesNotMatch(text, /张三/);
    assert.doesNotMatch(text, /李四/);
    view.dispose();
  } finally {
    await open.close();
  }
});

test("look 能看图，越界和不存在都被拦", async () => {
  const { faux, mediaRoot, fish } = boot();
  const open = await fish;
  try {
    mkdirSync(join(mediaRoot, "inbound"), { recursive: true });
    writeFileSync(join(mediaRoot, "inbound", "a.png"), PNG);

    const root = await open.harness.root(ctx, {
      agent: { model: { provider: faux.provider.id, modelId: faux.models[0].id } },
    });

    faux.setResponses([
      // look 现在是按需提供：先 tool_search 加载，从下一次模型请求起才在工具列表里
      fauxAssistantMessage([fauxToolCall("tool_search", { query: "看图" })], { stopReason: "toolUse" }),
      fauxAssistantMessage([fauxToolCall("look", { ref: "inbound/a.png" })], { stopReason: "toolUse" }),
      fauxAssistantMessage("看到了"),
    ]);
    await (await root.submit({ type: "input", content: "看图" }, ctx)).wait(ctx);

    const view = await root.viewState(ctx);
    const result = view.value.entries.filter((e) => e.kind === "pi.tool-result").at(-1);
    const content = JSON.stringify(result?.model ?? "");
    // 新契约：图不进主会话，look 返回的是描述文字（faux 模型的文本回复），不再有 image 块
    assert.ok(content.includes("toolName\":\"look\""), "look 结果存在");
    assert.ok(!content.includes("image/"), "主会话不应出现图片块");
    view.dispose();

    faux.setResponses([
      fauxAssistantMessage([fauxToolCall("look", { ref: "/etc/passwd" })], { stopReason: "toolUse" }),
      fauxAssistantMessage("不行"),
    ]);
    await (await root.submit({ type: "input", content: "再看" }, ctx)).wait(ctx);

    const after = await root.viewState(ctx);
    const denied = JSON.stringify(after.value.entries.filter((e) => e.kind === "pi.tool-result").at(-1)?.model ?? "");
    assert.match(denied, /只能看群里的图/);
    after.dispose();
  } finally {
    await open.close();
  }
});

test("react 贴表情，重复贴被限流", async () => {
  const { faux, reacts, fish } = boot();
  const open = await fish;
  try {
    const root = await open.harness.root(ctx, {
      agent: { model: { provider: faux.provider.id, modelId: faux.models[0].id } },
    });

    faux.setResponses([
      fauxAssistantMessage([fauxToolCall("react", { emoji: "124" })], { stopReason: "toolUse" }),
      fauxAssistantMessage("贴了"),
    ]);
    await (await root.submit({ type: "input", content: "在吗" }, ctx)).wait(ctx);
    assert.deepEqual(reacts, ["124"]);

    faux.setResponses([
      fauxAssistantMessage([fauxToolCall("react", { emoji: "124" })], { stopReason: "toolUse" }),
      fauxAssistantMessage("又贴"),
    ]);
    await (await root.submit({ type: "input", content: "人呢" }, ctx)).wait(ctx);
    assert.deepEqual(reacts, ["124"], "同一个表情不该连贴");
  } finally {
    await open.close();
  }
});

test("react 只贴本轮触发的那条，不拿会话级最后一条消息", async () => {
  const { faux, reactCalls, fish } = boot({
    // 本轮触发消息就是这一条：本轮之外的后到消息不参与
    triggerOf: () => ({ messageId: 4242, mentionsBot: true, userId: 1 }),
  });
  const open = await fish;
  try {
    const root = await open.harness.root(ctx, {
      agent: { model: { provider: faux.provider.id, modelId: faux.models[0].id } },
    });
    faux.setResponses([
      // 换个表情编号：同进程里前一个用例已经贴过 124，会撞上 60 秒冷却
      fauxAssistantMessage([fauxToolCall("react", { emoji: "185" })], { stopReason: "toolUse" }),
      fauxAssistantMessage("贴了"),
    ]);
    await (await root.submit({ type: "input", content: "在吗" }, ctx)).wait(ctx);
    assert.deepEqual(reactCalls, [{ emoji: "185", messageId: 4242 }]);
  } finally {
    await open.close();
  }
});

test("发送失败后队首保持 sending：不重试、不重复、不跳过它发后面的", async () => {
  let emitCalls = 0;
  const { fish } = boot({
    emit: (_id, _payload) => {
      emitCalls += 1;
      // 模拟 sendGroup 已发出第一条文本/@后第二条失败：emit 抛错时发出多少是未知的
      throw new Error("网络抖了一下");
    },
  });
  const open = await fish;
  try {
    const conv = await open.group("qq:group:42");
    await open.enqueue(conv.id, { items: ["第一条", "第二条"], at: Date.now(), key: "partial:1" });
    await open.enqueue(conv.id, { items: ["后面那条"], at: Date.now(), key: "next:1" });
    const sent = await open.drain([conv.id]);
    assert.equal(sent, 0, "部分发送的那条不算发出去");
    assert.equal(emitCalls, 1, "失败后不重试，不会把第一条文本/@再发一遍");
    const box = await open.harness.snapshot(OutboxDoc, conv.id, ctx);
    assert.equal(box?.queue[0]?.status, "sending", "未决记录保持 sending 供诊断");
    assert.equal(box?.queue.length, 2, "后面的 queued 没有被跳过队首发出去");
  } finally {
    await open.close();
  }
});

test("入站渲染：私聊不写「@了你」，群里只 @全体时不补「不是在叫你」", () => {
  // 文案表用 prompt/messages.md 的真实值（decisions §2–§5 的共享消息模板 key）
  const messages: Record<string, string> = {
    message_group_header: "群里有新消息啦。",
    message_private_header: "私聊有新消息啦。",
    message_list_start: "> 消息起始",
    message_list_end: "> 消息结束",
    message_mention_bot: "[这条消息@了你]",
    message_master: "[主人]",
  };
  const base = {
    messageId: 1425302217,
    userId: 2000,
    nickname: "张三",
    text: "在吗",
    images: [],
    imageSegments: [],
    replyIds: [],
  } as const;

  // 群轮的真实形状（src/index.ts flushBurst）：anchor + 整组 burst（当前消息就在组里），
  // 背景流水为空。
  const groupRound = (anchor: IncomingMessage): string =>
    withContext(anchor, [], [{ ...anchor, arrivalSeq: 1, at: 0, replyIds: [] }], {
      master: "1000",
      messages,
    }).content;

  // 私聊（decisions §5.3）：真实输入组装入口是 withContext——独立开场 + 消息列表边界，
  // 只注入当前消息、不展示背景；入站把 mentionsBot 恒置 true 只是内部标记，
  // 私聊没有「@谁」这回事，不许渲染成 @ 标签。
  const priv = withContext(
    { ...base, chatKey: "qq:private:2000", mentionsBot: true } as IncomingMessage,
    [],
    [],
    { master: "2000", messages },
  ).content;
  assert.equal(
    priv,
    [
      "私聊有新消息啦。",
      "> 消息起始",
      "[m:1425302217][主人] 张三(2000): 在吗",
      "> 消息结束",
    ].join("\n"),
  );
  assert.ok(!priv.includes("[这条消息@了你]"), "私聊渲染成了「@了你」");

  // 群里只 @全体成员：@ 标记由入站解析层留在正文里（onebot applyMention），
  // 消息行不再另加「@了全体成员」行内标注，也不许再补「（这些都不是在叫你）」自相矛盾；
  // 它不是点名鱼，所以没有 [这条消息@了你] 标签。
  const all = groupRound({
    ...base,
    chatKey: "qq:group:42",
    groupId: 42,
    text: "@全体成员 在吗",
    mentionsBot: false,
    mentions: [{ qq: "all", name: "全体成员", kind: "all" }],
  } as IncomingMessage);
  assert.equal(
    all,
    [
      "群里有新消息啦。",
      "> 消息起始",
      "[m:1425302217] 张三(2000): @全体成员 在吗",
      "> 消息结束",
    ].join("\n"),
  );
  assert.match(all, /@全体成员/, "@全体 的事实没进正文");
  assert.ok(!all.includes("[这条消息@了你]"), "只 @全体 不该被当成点名鱼");
  assert.ok(!all.includes("都不是在叫你"), "只 @全体 时不该再否定一次");

  // 只 @别人：新合同下同样不写行内 @ 标注、不写「不是在叫你」，但 @ 目标仍留在正文里，
  // 模型要能看出这句是 @ 别人的（旧行为不能丢）。
  const other = groupRound({
    ...base,
    chatKey: "qq:group:42",
    groupId: 42,
    text: "@李四 在吗",
    mentionsBot: false,
    mentions: [{ qq: "2001", name: "李四", kind: "other" }],
  } as IncomingMessage);
  assert.equal(
    other,
    [
      "群里有新消息啦。",
      "> 消息起始",
      "[m:1425302217] 张三(2000): @李四 在吗",
      "> 消息结束",
    ].join("\n"),
  );
  assert.match(other, /@李四/, "@别人 的目标没留在正文里");
  assert.ok(!other.includes("[这条消息@了你]"), "@别人 不该被当成点名鱼");
  assert.ok(!other.includes("都不是在叫你"), "否定文案已随新标签合同下线");
});
