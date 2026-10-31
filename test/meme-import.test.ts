/**
 * 本地表情导入的读取/入库安全与逐张语义。
 *
 * 覆盖的机械边界：
 *  - meme-inbox/ 只有「主人 + 本轮 meme_import 清单 + 这一轮 look 过」才能读、能收
 *  - 动图豁免严格限 inbound/；其他目录的 gif 一样要主人
 *  - 来源校验 fail closed：符号链接 / realpath 逃逸 / 坏 magic / 超限
 *  - 逐张配额：普通轮 2 张，导入轮＝清单张数（上限 50），cursor 续批，清单不跨轮
 *  - say 不能把 meme-inbox 里的图直接当 media 发出去
 *
 * 图片全部用 /tmp 里的临时文件（真实文件头），测试结束清理；不进仓库 fixture。
 */
import test from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { LiveDoc } from "@earendil-works/pi-durable";
import { loadPrompts } from "../src/prompts.ts";
import { DEFAULT_LIMITS } from "../src/egress/policy.ts";
import { createSayTool } from "../src/egress/say.ts";
import { createLookTool } from "../src/tools/look.ts";
import { createMemeAddTool } from "../src/tools/meme-add.ts";
import {
  MEME_IMPORT_MAX,
  clearMemeImportRound,
  createMemeImportTool,
  memeImportLookLimit,
  memeImportLooked,
  memeImportMarkLooked,
  memeImportRefs,
  registerMemeImportRound,
} from "../src/tools/meme-import.ts";

const PROMPTS = fileURLToPath(new URL("../prompt", import.meta.url));

const PNG = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.alloc(64, 7)]);
const GIF = Buffer.concat([Buffer.from("GIF89a"), Buffer.alloc(64, 3)]);
const JUNK = Buffer.from("这根本不是图片，只是一段文本内容而已");

let seq = 0;

/** 假 api：只回 LiveDoc 的 run.inputs[0]（round id），其余文档当不存在。 */
function fakeApi(conversationId: string, roundId: string, extra: Record<string, unknown> = {}) {
  return {
    conversationId,
    callId: "call_test",
    snapshot: async (doc: unknown) => (doc === LiveDoc ? { run: { inputs: [roundId] } } : undefined),
    ...extra,
  } as never;
}

function setup(over: { master?: string; userId?: number; maxBytes?: number } = {}) {
  const mediaRoot = mkdtempSync(join(tmpdir(), "yg-import-"));
  for (const dir of ["inbound", "memes", "meme-inbox", "gen"]) mkdirSync(join(mediaRoot, dir), { recursive: true });
  const prompts = loadPrompts(PROMPTS);
  const master = over.master ?? "1";
  // 调用时现取：同一个工具实例可以先以群友身份调、再以主人身份调
  let userId = over.userId ?? Number(master);
  const triggerOf = () => ({ mentionsBot: false, userId });
  const models = {
    getModel: () => ({ provider: "stub", modelId: "stub" }),
    streamSimple: () => ({ result: async () => ({ content: [{ type: "text", text: "一张图" }] }) }),
  } as never;
  const look = createLookTool({
    mediaRoot,
    prompts,
    models,
    visionModel: { provider: "stub", modelId: "stub" },
    master,
    triggerOf,
  });
  const memeAdd = createMemeAddTool({
    mediaRoot,
    prompts,
    master,
    triggerOf,
    ...(over.maxBytes === undefined ? {} : { maxBytes: over.maxBytes }),
  });
  const memeImport = createMemeImportTool({
    mediaRoot,
    prompts,
    master,
    triggerOf,
    ...(over.maxBytes === undefined ? {} : { maxBytes: over.maxBytes }),
  });
  const say = createSayTool({ limits: { ...DEFAULT_LIMITS, mediaRoot }, prompts });
  const conversationId = `conv-${++seq}`;

  writeInbox(mediaRoot, "a.png", PNG);
  return {
    mediaRoot,
    look,
    memeAdd,
    memeImport,
    say,
    conversationId,
    setUserId: (id: number) => {
      userId = id;
    },
    cleanup: () => rmSync(mediaRoot, { recursive: true, force: true }),
  };
}

function writeInbox(mediaRoot: string, name: string, bytes: Buffer): string {
  const full = join(mediaRoot, "meme-inbox", name);
  writeFileSync(full, bytes);
  return full;
}

async function textOf(tool: { execute: (...args: never[]) => Promise<unknown> }, args: unknown, api: unknown) {
  const result = (await tool.execute(args as never, api as never, {} as never)) as {
    output: { type: string; text: string }[];
  };
  return result.output.map((o) => o.text).join("\n");
}

const CAPTION = { ref: "", caption: "假笑敷衍", tags: ["无语"] };

test("普通轮的 look 额度仍是 2 张（不会被导入配额或重复计数抬走）", async () => {
  const { mediaRoot, look, conversationId, cleanup } = setup();
  try {
    const api = fakeApi(conversationId, "round-quota");
    for (const name of ["a.png", "b.png", "c.png"]) writeFileSync(join(mediaRoot, "inbound", name), PNG);

    assert.equal(await textOf(look, { ref: "inbound/a.png" }, api), "一张图");
    assert.equal(await textOf(look, { ref: "inbound/b.png" }, api), "一张图");
    await assert.rejects(() => textOf(look, { ref: "inbound/c.png" }, api), /本轮已经看过 2 张图/, "普通轮就是 2 张");

    // meme-inbox 不在本轮清单里：拒绝的同时不能把普通额度吃掉
    await assert.rejects(() => textOf(look, { ref: "meme-inbox/a.png" }, api), /不在本轮导入清单里/);
  } finally {
    cleanup();
  }
});

test("普通群友 look meme-inbox：没有主人身份，读不了", async () => {
  const { look, conversationId, cleanup, setUserId } = setup({ userId: 999 });
  try {
    const api = fakeApi(conversationId, "round-1");
    await assert.rejects(
      () => textOf(look, { ref: "meme-inbox/a.png" }, api),
      /只有主人这一轮导入时才能看/,
      "群友不该能读本地待收目录",
    );
    // 普通额度（2 张）不能代替清单授权：换主人也一样，只要清单里没有它就拒绝
    setUserId(1);
    await assert.rejects(() => textOf(look, { ref: "meme-inbox/a.png" }, api), /不在本轮导入清单里/);
  } finally {
    cleanup();
  }
});

test("主人清单外 / 清单内：look 与 meme_add 的逐张链路", async () => {
  const { mediaRoot, look, memeAdd, memeImport, conversationId, cleanup } = setup();
  try {
    const api = fakeApi(conversationId, "round-2");
    registerMemeImportRound("round-2", ["meme-inbox/other.png"]);
    await assert.rejects(
      () => textOf(look, { ref: "meme-inbox/a.png" }, api),
      /不在本轮导入清单里/,
      "清单里没有的 inbox 图不能凭主人身份读",
    );
    clearMemeImportRound("round-2");

    // 走真实登记：meme_import 产出清单，look 才能看
    const listed = await textOf(memeImport, {}, api);
    assert.match(listed, /meme-inbox\/a\.png/, "登记结果要把 ref 给模型");
    assert.match(listed, /这一批登记了 1 张/);

    // 没看过就 meme_add：拒绝
    await assert.rejects(
      () => textOf(memeAdd, { ...CAPTION, ref: "meme-inbox/a.png" }, api),
      /还没看过就先别收/,
      "清单里的图也必须先 look 再收",
    );

    const described = await textOf(look, { ref: "meme-inbox/a.png" }, api);
    assert.equal(described, "一张图");
    assert.ok(memeImportLooked("round-2", "meme-inbox/a.png"), "看成功后要记进清单的 lookedRefs");

    // 重复看：不占额度、不重复花视觉调用
    await assert.rejects(() => textOf(look, { ref: "meme-inbox/a.png" }, api), /已经看过这张了/);

    const added = await textOf(memeAdd, { ...CAPTION, ref: "meme-inbox/a.png" }, api);
    assert.match(added, /收好了/);
    const index = JSON.parse(readFileSync(join(mediaRoot, "memes", "index.json"), "utf8")) as {
      file: string;
      caption: string;
    }[];
    assert.equal(index.length, 1);
    assert.equal(index[0]!.caption, "假笑敷衍");
    assert.ok(existsSync(join(mediaRoot, "memes", index[0]!.file)), "收进库的图要真的落盘");

    // 清单只活一轮：清掉后同一张立刻不可读、不可收
    clearMemeImportRound("round-2");
    await assert.rejects(() => textOf(look, { ref: "meme-inbox/a.png" }, api), /不在本轮导入清单里/);
    await assert.rejects(
      () => textOf(memeAdd, { ...CAPTION, ref: "meme-inbox/a.png" }, api),
      /不在本轮导入清单里/,
    );
  } finally {
    cleanup();
  }
});

test("动图豁免严格限 inbound：inbox gif 与其他目录 gif 都要主人", async () => {
  const { mediaRoot, memeAdd, conversationId, cleanup, setUserId } = setup({ userId: 999 });
  try {
    const api = fakeApi(conversationId, "round-3");
    writeInbox(mediaRoot, "b.gif", GIF);
    writeFileSync(join(mediaRoot, "gen", "c.gif"), GIF);

    await assert.rejects(
      () => textOf(memeAdd, { ...CAPTION, ref: "meme-inbox/b.gif" }, api),
      /只有主人能让图长期留在库里/,
      "inbox 的 gif 不能拿动图豁免绕过去",
    );
    await assert.rejects(
      () => textOf(memeAdd, { ...CAPTION, ref: "gen/c.gif" }, api),
      /只有主人能让图长期留在库里/,
      "非 inbound 目录的 gif 同样要主人",
    );

    // inbound 的群图 gif 仍是合法豁免（自动收图链路）：
    writeFileSync(join(mediaRoot, "inbound", "d.gif"), GIF);
    const added = await textOf(memeAdd, { ...CAPTION, ref: "inbound/d.gif" }, api);
    assert.match(added, /收好了/);

    // 主人身份下 inbox gif 仍要清单 + 已 look（由上一个用例覆盖清单缺口，这里验「未看」）
    setUserId(1);
    registerMemeImportRound("round-3", ["meme-inbox/b.gif"]);
    await assert.rejects(() => textOf(memeAdd, { ...CAPTION, ref: "meme-inbox/b.gif" }, api), /还没看过就先别收/);
    clearMemeImportRound("round-3");
  } finally {
    cleanup();
  }
});

test("来源校验 fail closed：符号链接 / realpath 逃逸 / 坏 magic / 超限", async () => {
  const { mediaRoot, look, memeAdd, conversationId, cleanup } = setup({ maxBytes: 4096 });
  try {
    const api = fakeApi(conversationId, "round-4");
    const outside = mkdtempSync(join(tmpdir(), "yg-outside-"));
    try {
      writeFileSync(join(outside, "evil.png"), PNG);

      // 1) 文件符号链接：inbound/x.png -> meme-inbox/a.png
      symlinkSync(join(mediaRoot, "meme-inbox", "a.png"), join(mediaRoot, "inbound", "link.png"));
      await assert.rejects(() => textOf(memeAdd, { ...CAPTION, ref: "inbound/link.png" }, api), /符号链接/);

      // 2) 目录符号链接逃逸：realpath 落在媒体目录外
      symlinkSync(outside, join(mediaRoot, "inbound", "out"));
      await assert.rejects(
        () => textOf(memeAdd, { ...CAPTION, ref: "inbound/out/evil.png" }, api),
        /找不到这张图/,
        "realpath 逃出媒体目录要当成不可读",
      );

      // 3) 路径穿越：解析后落在媒体目录外
      await assert.rejects(() => textOf(memeAdd, { ...CAPTION, ref: "meme-inbox/../../evil.png" }, api), /找不到这张图/);

      // 4) 扩展名骗人：文件头不是图片
      writeFileSync(join(mediaRoot, "inbound", "junk.gif"), JUNK);
      await assert.rejects(() => textOf(memeAdd, { ...CAPTION, ref: "inbound/junk.gif" }, api), /文件头不是图片/);

      // 5) 超限（deps.maxBytes = 4096）
      writeFileSync(join(mediaRoot, "inbound", "big.gif"), Buffer.concat([GIF, Buffer.alloc(8192, 1)]));
      await assert.rejects(() => textOf(memeAdd, { ...CAPTION, ref: "inbound/big.gif" }, api), /这张太大/);

      // 6) inbox 里的图被换成链接：清单里有也不读（读之前再验一次来源）
      symlinkSync(join(outside, "evil.png"), join(mediaRoot, "meme-inbox", "link.png"));
      registerMemeImportRound("round-4", ["meme-inbox/link.png"]);
      await assert.rejects(() => textOf(look, { ref: "meme-inbox/link.png" }, api), /找不到这张图/);
      clearMemeImportRound("round-4");

      // 库里没有半成品
      assert.ok(!existsSync(join(mediaRoot, "memes", "index.json")), "被拒的来源不该写索引");
    } finally {
      rmSync(outside, { recursive: true, force: true });
    }
  } finally {
    cleanup();
  }
});

test("meme_import 的目录状态可区分，跳过项稳定排序", async () => {
  const { mediaRoot, memeImport, conversationId, cleanup, setUserId } = setup();
  try {
    const api = fakeApi(conversationId, "round-5");
    // setup 预置的 a.png 先拿掉：这个用例要看「空目录」
    rmSync(join(mediaRoot, "meme-inbox", "a.png"));

    const empty = await textOf(memeImport, {}, api);
    assert.match(empty, /没有能收的图片/);

    // 跳过项：先按名字排序再输出
    writeFileSync(join(mediaRoot, "meme-inbox", "z.txt"), Buffer.from("z"));
    writeFileSync(join(mediaRoot, "meme-inbox", "m.txt"), Buffer.from("m"));
    const skipped = await textOf(memeImport, {}, api);
    assert.match(skipped, /跳过了 2 个/);
    assert.ok(skipped.indexOf("m.txt") < skipped.indexOf("z.txt"), "跳过项要稳定排序");
    rmSync(join(mediaRoot, "meme-inbox", "z.txt"));
    rmSync(join(mediaRoot, "meme-inbox", "m.txt"));

    // 目录本身是符号链接
    rmSync(join(mediaRoot, "meme-inbox"), { recursive: true, force: true });
    const real = join(mediaRoot, "inbox-real");
    mkdirSync(real);
    symlinkSync(real, join(mediaRoot, "meme-inbox"));
    const linked = await textOf(memeImport, {}, api);
    assert.match(linked, /本身是个符号链接/);

    // 目录不存在
    rmSync(join(mediaRoot, "meme-inbox"), { force: true });
    const missing = await textOf(memeImport, {}, api);
    assert.match(missing, /还没有 meme-inbox 这个待导入目录/);

    // 群友连目录状态都问不到
    setUserId(999);
    await assert.rejects(() => textOf(memeImport, {}, api), /只有主人能开/);
  } finally {
    cleanup();
  }
});

test("逐张配额：清单 1 张就是 1 张，20 张按 20，51 张按 50 + cursor 续批", async () => {
  const { mediaRoot, memeImport, look, conversationId, cleanup } = setup();
  try {
    // 1 张：额度 1（不被普通轮的 2 张抬上去）
    const api1 = fakeApi(conversationId, "round-6");
    const one = await textOf(memeImport, {}, api1);
    assert.match(one, /这一批登记了 1 张/);
    assert.equal(memeImportLookLimit("round-6"), 1);
    assert.equal(memeImportRefs("round-6").length, 1);
    assert.equal(await textOf(look, { ref: "meme-inbox/a.png" }, api1), "一张图");
    clearMemeImportRound("round-6");

    // 20 张：额度 20（不是 2）
    rmSync(join(mediaRoot, "meme-inbox"), { recursive: true, force: true });
    mkdirSync(join(mediaRoot, "meme-inbox"));
    for (let i = 0; i < 20; i++) writeInbox(mediaRoot, `f${String(i).padStart(2, "0")}.png`, PNG);
    const api20 = fakeApi(conversationId, "round-7");
    const twenty = await textOf(memeImport, {}, api20);
    assert.match(twenty, /这一批登记了 20 张/);
    assert.equal(memeImportLookLimit("round-7"), 20);
    assert.equal(memeImportRefs("round-7").length, 20);
    clearMemeImportRound("round-7");

    // 51 张：一批 50 + cursor 续批；清单合并 51 条，但一轮只能看 50 张
    rmSync(join(mediaRoot, "meme-inbox"), { recursive: true, force: true });
    mkdirSync(join(mediaRoot, "meme-inbox"));
    for (let i = 0; i < 51; i++) writeInbox(mediaRoot, `g${String(i).padStart(2, "0")}.png`, PNG);
    const api51 = fakeApi(conversationId, "round-8");
    const first = await textOf(memeImport, {}, api51);
    assert.match(first, /这一批登记了 50 张/);
    assert.match(first, /还有 1 张/);
    assert.equal(memeImportRefs("round-8").length, 50);

    const second = await textOf(memeImport, { cursor: "g49.png" }, api51);
    assert.match(second, /这一批登记了 1 张/);
    assert.equal(memeImportRefs("round-8").length, 51, "同一轮续批要合并，不作废上一批");
    assert.equal(memeImportLookLimit("round-8"), MEME_IMPORT_MAX, "一轮最多看 50 张");

    // 看满 50 张后，第 51 张不放行
    const refs = memeImportRefs("round-8");
    const last = refs[refs.length - 1]!;
    for (const ref of refs) if (ref !== last) memeImportMarkLooked("round-8", ref);
    await assert.rejects(() => textOf(look, { ref: last }, api51), /已经看完了/);

    clearMemeImportRound("round-8");
    assert.equal(memeImportLookLimit("round-8"), undefined, "清单不跨轮");
  } finally {
    cleanup();
  }
});

test("say 不能把 meme-inbox 的图直接当 media 发；普通媒体目录照旧", async () => {
  const { mediaRoot, say, conversationId, cleanup } = setup();
  try {
    const outbox: { media?: string }[] = [];
    const api = fakeApi(conversationId, "round-9", {
      commit: async (fn: (tx: unknown) => Promise<unknown>) =>
        fn({
          doc: async () => ({ queue: outbox }),
          appendEntry: async () => ({ id: 1 }),
        }),
    });

    await assert.rejects(
      () => textOf(say, { messages: ["看这张"], media: "meme-inbox/a.png" }, api),
      /meme-inbox 里的图不能直接发/,
      "本地待收图必须先 look + meme_add 进库",
    );
    assert.equal(outbox.length, 0);

    // 正常媒体目录（群图）不受影响
    writeFileSync(join(mediaRoot, "inbound", "ok.png"), PNG);
    const sent = await textOf(say, { messages: ["看这张"], media: "inbound/ok.png" }, api);
    assert.match(sent, /已发到群里/);
    assert.equal(outbox.at(-1)?.media, "inbound/ok.png");
  } finally {
    cleanup();
  }
});
