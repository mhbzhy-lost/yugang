/**
 * 特别关注名单：内存镜像必须整份替换，撤销要立即生效。
 *
 * 这里锁的是两个真出过事的点：
 *  - 以前 onChanged 只带 ids 做增量合并，watch remove 之后内存里还留着那个人
 *    → 名单上已经没人了，他照样能让鱼主动 @ 别人（撤销要等重启才生效）
 *  - remove 以前也要过群成员校验，人一旦退群就再也撤不掉
 */
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { createModels } from "@earendil-works/pi-ai/models";
import { fauxAssistantMessage, fauxProvider, fauxToolCall } from "@earendil-works/pi-ai/providers/faux";
import { MemoryStorage } from "@earendil-works/pi-durable";
import { openFish } from "../src/harness.ts";
import { replaceWatched, watchedMapFor, type WatchedMap } from "../src/qq/watch-state.ts";
import type { WatchedPerson } from "../src/store.ts";

const ctx = BACKGROUND_CONTEXT;
const PROMPTS = fileURLToPath(new URL("../prompt", import.meta.url));

function person(userId: string, note = "备注"): WatchedPerson {
  return { userId, note, at: 0 };
}

test("名单整体替换：删掉的人立刻从镜像消失，空名单删 key", () => {
  const store = new Map<string, WatchedMap>();
  replaceWatched(store, "qq:group:42", [person("2000"), person("2001")]);
  assert.deepEqual([...(store.get("qq:group:42")?.keys() ?? [])], ["2000", "2001"]);

  // watch remove 之后宿主拿到的是整份新名单：旧条目必须一起消失
  replaceWatched(store, "qq:group:42", [person("2000")]);
  assert.equal(store.get("qq:group:42")?.has("2001"), false, "删掉的人还留在内存镜像里，撤销没有生效");

  replaceWatched(store, "qq:group:42", []);
  assert.equal(store.has("qq:group:42"), false, "空名单应该删 key，否则这个群看起来永远有特别关注");
});

test("镜像按 QQ 号去重，空号码与非名单一起被丢掉", () => {
  const map = watchedMapFor([person("2000", "叫他宝宝"), person("2000", "后写的赢"), { userId: "  ", note: "x", at: 0 }]);
  assert.equal(map?.size, 1);
  assert.equal(map?.get("2000")?.note, "后写的赢");
});

function boot() {
  const faux = fauxProvider();
  const models = createModels();
  models.setProvider(faux.provider);
  const mediaRoot = mkdtempSync(join(tmpdir(), "yg-media-"));
  const workspaceRoot = mkdtempSync(join(tmpdir(), "yg-ws-"));
  const mirror = new Map<string, WatchedMap>();
  const changed: string[][] = [];
  // 群里还有谁：remove 不该被这张名单卡住（人退群了就验不到）
  let members = [{ nickname: "张三", userId: "2000" }, { nickname: "李四", userId: "2001" }];

  const fish = openFish({
    storage: new MemoryStorage(),
    models,
    model: { provider: faux.provider.id, modelId: faux.models[0].id },
    promptRoot: PROMPTS,
    mediaRoot,
    workspaceRoot,
    emit: () => {},
    react: () => {},
    master: "1",
    // 每一轮都当成主人触发（本轮身份闸只认 triggerOf）
    triggerOf: () => ({ messageId: 1, mentionsBot: true, userId: 1 }),
    groupMembersOf: async () => members,
    onWatchChanged: (_conversationId, people) => {
      changed.push(people.map((p) => p.userId));
      replaceWatched(mirror, "qq:group:42", people);
    },
  });
  return {
    faux,
    fish,
    mirror,
    changed,
    model: { provider: faux.provider.id, modelId: faux.models[0].id },
    dropMember(userId: string) {
      members = members.filter((m) => m.userId !== userId);
    },
  };
}

test("watch add→remove：内存镜像立即撤权，退群的人也能被移除", async () => {
  const { faux, fish, mirror, changed, model, dropMember } = boot();
  const open = await fish;
  try {
    await open.group("qq:group:42");
    const root = await open.harness.root(ctx, { agent: { model } });

    faux.setResponses([
      fauxAssistantMessage([fauxToolCall("watch", { action: "add", userId: "2000", note: "叫他宝宝" })], { stopReason: "toolUse" }),
      fauxAssistantMessage("记住了"),
    ]);
    await (await root.submit({ type: "input", content: "关注张三" }, ctx)).wait(ctx);
    assert.equal(mirror.get("qq:group:42")?.has("2000"), true);

    // 张三退群：群成员名单里已经没有他，remove 仍然必须成功
    dropMember("2000");
    faux.setResponses([
      fauxAssistantMessage([fauxToolCall("watch", { action: "remove", userId: "2000" })], { stopReason: "toolUse" }),
      fauxAssistantMessage("不记了"),
    ]);
    await (await root.submit({ type: "input", content: "别关注了" }, ctx)).wait(ctx);

    assert.equal(mirror.has("qq:group:42"), false, "撤销后内存镜像还留着人 → 同进程内他仍能让鱼主动 @");
    assert.deepEqual(changed.at(-1), [], "onChanged 必须推整份名单（这里应该已经空了）");
  } finally {
    await open.close();
  }
});

test("watch remove 不依赖群成员名单：退群的人照样能撤销", async () => {
  const { faux, fish, mirror, model, dropMember } = boot();
  const open = await fish;
  try {
    const root = await open.harness.root(ctx, { agent: { model } });
    await open.group("qq:group:42");
    faux.setResponses([
      fauxAssistantMessage([fauxToolCall("watch", { action: "add", userId: "2001", note: "留意" })], { stopReason: "toolUse" }),
      fauxAssistantMessage("好"),
    ]);
    await (await root.submit({ type: "input", content: "关注李四" }, ctx)).wait(ctx);
    assert.equal(mirror.get("qq:group:42")?.has("2001"), true);

    dropMember("2001");
    faux.setResponses([
      fauxAssistantMessage([fauxToolCall("watch", { action: "remove", userId: "2001" })], { stopReason: "toolUse" }),
      fauxAssistantMessage("好"),
    ]);
    await (await root.submit({ type: "input", content: "不关注了" }, ctx)).wait(ctx);
    assert.equal(mirror.get("qq:group:42")?.has("2001") ?? false, false);
  } finally {
    await open.close();
  }
});
