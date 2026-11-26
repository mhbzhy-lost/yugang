/**
 * draw_remote 工具包（统一远程生图的工具层）的工具级测试（draw_remote 计划 Task 3 / Spec §3.3）。
 *
 * 适配器（runDrawRemote 的四条通道）由桩替代——通道协议、OAuth、脱敏与落盘在
 * test/draw-remote-media.test.ts 里已经验过；这里只验工具层自己的契约：
 *  - 入口热读配置，通道与模型跟着 fish.config.json 现值走，同一实例不重建；
 *  - 总开关两道闸：入口关闭即拒不占轮；onSubmitted 瞬间翻为关闭同样拒绝且 submitted 保持 false；
 *  - 出图经 outbox 机械直发（幂等键 / 引用锚点），入队失败回退引导 say_media；
 *  - submitted 防重提矩阵：submitted=false 的失败不锁轮、true 的锁轮；
 *  - 参考图安全围栏（方括号 / 穿越 / 符号链接 / 非图 / 魔数不符 / 体积 / 按通道的张数与类型上限）；
 *  - 取消围栏：返回后已中止则不入 outbox。
 *
 * 任何用例都不碰真实适配器：drawRemoteRun 一律是桩，绝不读仓库的 config/、不发网络请求。
 */
import test, { after } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { LiveDoc } from "@earendil-works/pi-durable";
import { DRAW_REMOTE_DEFAULTS, type DrawRemoteConfig, type DrawRemoteProvider } from "../src/fish-config.ts";
import { DrawRemoteError, type DrawRemoteRunRequest } from "../src/media/draw-remote/index.ts";
import { loadPrompts } from "../src/prompt/index.ts";
import { loadToolManifests } from "../src/tools/manifest.ts";
import { mergeToolMessages } from "../src/tools/loader.ts";
import type { OutboundPayload } from "../src/tools/say-shared.ts";
import type { ToolPackageDeps } from "../src/tools/types.ts";
import { createDrawRemoteTool } from "../src/tools/draw_remote/tool.ts";

const ROOT = fileURLToPath(new URL("..", import.meta.url));
const prompts = loadPrompts(join(ROOT, "prompt"));
const manifests = loadToolManifests(fileURLToPath(new URL("../src/tools/", import.meta.url)), { memeTags: prompts.memeTags });
// 与 loader 同款合并：工具回执文案来自 src/tools/draw_remote/messages.json（线上由 loadToolSurface 完成）
mergeToolMessages(manifests, prompts.messages);
const manifest = manifests.get("draw_remote")!;

const PNG_MAGIC = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
const JPEG_MAGIC = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46, 0x49, 0x46]);
const GIF_MAGIC = Buffer.from("GIF89a");
const MiB = 1024 * 1024;
const png = (bytes: number) => Buffer.concat([PNG_MAGIC, Buffer.alloc(Math.max(0, bytes - PNG_MAGIC.length), 7)]);
const jpeg = (bytes: number) => Buffer.concat([JPEG_MAGIC, Buffer.alloc(Math.max(0, bytes - JPEG_MAGIC.length), 1)]);
const gif = (bytes: number) => Buffer.concat([GIF_MAGIC, Buffer.alloc(Math.max(0, bytes - GIF_MAGIC.length), 1)]);

/** 每个用例的临时目录都登记在这里，文件结束时统一清理。 */
const work: string[] = [];
after(() => {
  for (const dir of work) rmSync(dir, { recursive: true, force: true });
});

let seq = 0;

/** 固定触发消息：带消息 id 且 @ 了鱼（机械必答引用）；要改用 deps.triggerOf 覆盖。 */
const trigger = { messageId: 5001, mentionsBot: true, userId: 10001 };

interface CommitOptions {
  /** 按提交序号决定这次 commit 是否失败。 */
  failCommit?: (n: number) => boolean;
  /** 提交瞬间的副作用（用来模拟「两张图之间宿主取消」）。 */
  onCommit?: (n: number) => void;
}

interface Fixture {
  tool: ReturnType<typeof createDrawRemoteTool>;
  mediaRoot: string;
  inbound: string;
  outbox: OutboundPayload[];
  longWorks: Array<[string, unknown]>;
  calls: DrawRemoteRunRequest[];
  commits: () => number;
  conv: string;
  setConfig: (next: Partial<Omit<DrawRemoteConfig, "models">> & { models?: DrawRemoteConfig["models"] }) => void;
  config: () => DrawRemoteConfig;
  behave: (next: (request: DrawRemoteRunRequest) => Promise<{ files: string[] }>) => void;
  /** 假 api：LiveDoc 快照给本轮轮标识（null = 拿不到）；commit 把 payload 落进 outbox。 */
  api: (round?: unknown, opts?: CommitOptions) => never;
}

function setup(extraDeps: Partial<ToolPackageDeps> = {}): Fixture {
  const mediaRoot = mkdtempSync(join(tmpdir(), "yg-draw-remote-"));
  work.push(mediaRoot);
  const inbound = join(mediaRoot, "inbound");
  mkdirSync(inbound);
  writeFileSync(join(inbound, "a.png"), png(64));
  writeFileSync(join(inbound, "b.png"), png(64));
  writeFileSync(join(inbound, "p.jpg"), jpeg(58));
  writeFileSync(join(inbound, "anim.gif"), gif(39));

  let config: DrawRemoteConfig = DRAW_REMOTE_DEFAULTS;
  let behaviour: (request: DrawRemoteRunRequest) => Promise<{ files: string[] }> = async (request) => {
    request.onSubmitted?.();
    return { files: ["1-test.png"] };
  };
  const calls: DrawRemoteRunRequest[] = [];
  const longWorks: Array<[string, unknown]> = [];
  const outbox: OutboundPayload[] = [];
  let commits = 0;
  const conv = `conv-draw-remote-${++seq}`;

  const deps: ToolPackageDeps = {
    prompts,
    mediaRoot,
    drawRemote: () => config,
    drawRemoteRun: async (request) => {
      calls.push(request);
      const outcome = await behaviour(request);
      return { provider: request.provider, model: request.model, files: outcome.files };
    },
    onLongWork: (tool, round) => {
      longWorks.push([tool, round]);
    },
    triggerOf: () => trigger,
    modelsPath: "/tmp/yg-draw-remote-models.json",
    ...extraDeps,
  };
  const tool = createDrawRemoteTool(manifest, deps);
  return {
    tool,
    mediaRoot,
    inbound,
    outbox,
    longWorks,
    calls,
    commits: () => commits,
    conv,
    setConfig: (next) => {
      config = { ...config, ...next };
    },
    config: () => config,
    behave: (next) => {
      behaviour = next;
    },
    api: (round: unknown = 1, opts: CommitOptions = {}) =>
      ({
        conversationId: conv,
        callId: "call_test",
        snapshot: async (doc: unknown) => (doc === LiveDoc && round !== null ? { run: { inputs: [round] } } : undefined),
        commit: async (fn: (tx: unknown) => Promise<void>) => {
          commits += 1;
          const n = commits;
          opts.onCommit?.(n);
          if (opts.failCommit?.(n)) throw new Error("commit boom");
          return fn({
            appendEntry: async () => ({ id: n }),
            doc: async () => ({ queue: outbox }),
          });
        },
      }) as never,
  };
}

/** 工具返回值的第一段文本（回执）。 */
function text(result: unknown): string {
  return String((result as { output: { type: string; text: string }[] }).output[0]?.text ?? "");
}

/** 工具以错误拒绝时的回执文本。 */
async function rejection(run: () => Promise<unknown>): Promise<string> {
  return run().then(
    () => "",
    (error: unknown) => (error instanceof Error ? error.message : String(error)),
  );
}

const ctx = (signal?: AbortSignal) => (signal === undefined ? {} : { abortSignal: signal }) as never;

test("createDrawRemoteTool 恒返回注册：依赖不全也在册，参数 Schema 唯一来自 manifest", async () => {
  // 没注入 drawRemote / drawRemoteRun / modelsPath / onLongWork 的装配（离线、无凭据环境）也照样注册，
  // 缺凭据留到执行期由适配器以 draw_remote_unconfigured 回执，不在装配期静默消失
  const bare = createDrawRemoteTool(manifest, { prompts, mediaRoot: "/tmp/yg-draw-remote-bare" });
  assert.ok(bare, "工厂不得返回 undefined");
  assert.equal(bare.name, "draw_remote");
  assert.deepEqual(bare.callers, ["model"]);
  assert.deepEqual(bare.parameters, manifest.parameters);
  assert.equal(bare.description, [manifest.description, manifest.guide].join("\n\n"), "说明逐字来自 TOOL.md");
});

test("没注入配置读取函数时按冻结默认值走；modelsPath 缺省落到仓库 config/models.json", async () => {
  const fixture = setup({ drawRemote: undefined, modelsPath: undefined });
  const result = await fixture.tool.execute({ prompt: "一只猫" } as never, fixture.api(), ctx());
  assert.equal(fixture.calls[0]?.provider, "qwen");
  assert.equal(fixture.calls[0]?.model, "qwen-image-3.0-pro");
  assert.equal(typeof fixture.calls[0]?.modelsPath, "string");
  assert.ok(fixture.calls[0]?.modelsPath.endsWith(join("config", "models.json")));
  assert.equal(fixture.calls[0]?.mediaRoot, fixture.mediaRoot);
  assert.match(text(result), /画好了/);
});

test("热切换：同一实例不重建，通道与模型跟着 drawRemote 现值走", async () => {
  const fixture = setup();
  const first = await fixture.tool.execute({ prompt: "第一张" } as never, fixture.api(1), ctx());
  assert.equal(fixture.calls[0]?.provider, "qwen", "缺省通道是 qwen");
  assert.equal(fixture.calls[0]?.model, "qwen-image-3.0-pro");
  assert.match(text(first), /qwen/);

  // 主人热切到 gpt 并换模型（models 浅合并：其余通道的默认值不动）；同一个工具实例、同一个会话
  fixture.setConfig({ provider: "gpt", models: { ...DRAW_REMOTE_DEFAULTS.models, gpt: "gpt-image-custom" } });
  const second = await fixture.tool.execute({ prompt: "第二张" } as never, fixture.api(2), ctx());
  assert.equal(fixture.calls[1]?.provider, "gpt");
  assert.equal(fixture.calls[1]?.model, "gpt-image-custom");
  assert.match(text(second), /gpt 画好了/);
  assert.equal(fixture.calls[1]?.mediaRoot, fixture.mediaRoot);
  assert.equal(fixture.calls[1]?.modelsPath, "/tmp/yg-draw-remote-models.json");
  assert.equal(fixture.calls[1]?.prompt, "第二张");
});

test("总开关入口关闭：立即拒绝，不发「稍等」不占轮；重新打开后同轮可成功", async () => {
  const fixture = setup();
  const api = fixture.api();
  fixture.setConfig({ enabled: false });
  assert.match(await rejection(() => fixture.tool.execute({ prompt: "一只猫" } as never, api, ctx())), /已被主人关闭/);
  assert.equal(fixture.calls.length, 0, "关闭时不碰适配器");
  assert.equal(fixture.longWorks.length, 0, "关闭时不触发 onLongWork");
  assert.equal(fixture.commits(), 0);

  fixture.setConfig({ enabled: true });
  assert.match(text(await fixture.tool.execute({ prompt: "一只猫" } as never, api, ctx())), /画好了/);
  assert.equal(fixture.outbox.length, 1);
});

test("总开关提交前二次复核：onSubmitted 瞬间翻为关闭则拒绝，submitted 保持 false 不锁轮", async () => {
  const fixture = setup();
  const api = fixture.api();
  fixture.behave(async (request) => {
    // 入口时是开的；适配器读完配置、即将 POST 的那一刻主人把开关关了
    fixture.setConfig({ enabled: false });
    request.onSubmitted?.();
    return { files: ["1-test.png"] };
  });
  assert.match(await rejection(() => fixture.tool.execute({ prompt: "一只猫" } as never, api, ctx())), /已被主人关闭/);
  assert.equal(fixture.longWorks.length, 0, "没到 onLongWork 就被拦下，不发「稍等」");
  assert.equal(fixture.outbox.length, 0);

  // 重新打开：同一轮直接重试成功（上一次没有留下 submitted / used 状态）
  fixture.setConfig({ enabled: true });
  fixture.behave(async (request) => {
    request.onSubmitted?.();
    return { files: ["2-test.png"] };
  });
  assert.match(text(await fixture.tool.execute({ prompt: "一只猫" } as never, api, ctx())), /gen\/2-test\.png/);
  assert.deepEqual(fixture.longWorks, [["draw_remote", 1]]);
  assert.equal(fixture.outbox.length, 1);
});

test("成功后经 outbox 机械直发：幂等键、引用锚点、回执含 gen/ 路径与通道名", async () => {
  const fixture = setup();
  fixture.setConfig({ provider: "gemini" });
  fixture.behave(async (request) => {
    request.onSubmitted?.();
    return { files: ["111-a.png", "222-b.png"] };
  });
  const result = await fixture.tool.execute({ prompt: "一只猫", aspect_ratio: "3:4" } as never, fixture.api(77), ctx());
  assert.deepEqual(fixture.longWorks, [["draw_remote", 77]], "onSubmitted 之后才发一次「稍等」");

  assert.equal(fixture.outbox.length, 2, "两张图各入队一条");
  assert.deepEqual(
    fixture.outbox.map((item) => ({
      media: item.media,
      key: item.key,
      items: item.items,
      quote: item.quote,
      quoteId: item.quoteId,
      quoteForce: item.quoteForce,
    })),
    [
      { media: "gen/111-a.png", key: `${fixture.conv}:draw_remote:77:111-a.png`, items: [], quote: false, quoteId: 5001, quoteForce: true },
      { media: "gen/222-b.png", key: `${fixture.conv}:draw_remote:77:222-b.png`, items: [], quote: false, quoteId: 5001, quoteForce: true },
    ],
  );
  const done = text(result);
  assert.match(done, /gen\/111-a\.png/);
  assert.match(done, /gen\/222-b\.png/);
  assert.match(done, /gemini/, "回执带当前通道名");
  assert.match(done, /不用再调 say_media/);

  // 适配器收到本轮透传的参数：比例原样交给通道决定认不认；没传参考图就不带 images
  assert.equal(fixture.calls[0]?.aspectRatio, "3:4");
  assert.equal(fixture.calls[0]?.prompt, "一只猫");
  assert.equal(fixture.calls[0]?.images, undefined);
});

test("background 透传给适配器；触发消息没有锚点时 payload 不带 quoteId、quoteForce=false", async () => {
  const fixture = setup({ triggerOf: () => ({ messageId: undefined, mentionsBot: false }) });
  await fixture.tool.execute({ prompt: "抠个素材", background: "transparent" } as never, fixture.api(5), ctx());
  assert.equal(fixture.calls[0]?.background, "transparent");
  assert.equal(fixture.outbox.length, 1);
  assert.equal(fixture.outbox[0]?.quoteId, undefined);
  assert.equal(fixture.outbox[0]?.quoteForce, false);
  assert.equal(fixture.outbox[0]?.key, `${fixture.conv}:draw_remote:5:1-test.png`);
});

test("outbox 入队失败：回退回执引导 say_media 补发，图不丢且本轮不再重复画", async () => {
  const fixture = setup();
  fixture.behave(async (request) => {
    request.onSubmitted?.();
    return { files: ["111-a.png", "222-b.png"] };
  });
  // 第二次 commit（第二张图）失败：第一张已入队，回退只点名没发出去的那张
  const api = fixture.api(9, { failCommit: (n) => n === 2 });
  const fallback = text(await fixture.tool.execute({ prompt: "一只猫" } as never, api, ctx()));
  assert.match(fallback, /自动发送没成功/);
  assert.match(fallback, /gen\/222-b\.png/);
  assert.doesNotMatch(fallback, /gen\/111-a\.png/);
  assert.match(fallback, /say_media/);
  assert.equal(fixture.outbox.length, 1, "第一张已入队");

  // 入队失败也算「这轮画过了」：同轮再调报 used，不让模型再画一张
  assert.match(await rejection(() => fixture.tool.execute({ prompt: "再来一张" } as never, api, ctx())), /已经用远程画过/);
  assert.equal(fixture.calls.length, 1);

  // 第一张都入不了队：回退点名全部
  const fresh = setup();
  const single = text(await fresh.tool.execute({ prompt: "一只猫" } as never, fresh.api(9, { failCommit: () => true }), ctx()));
  assert.match(single, /gen\/1-test\.png.*自动发送没成功.*say_media/);
  assert.equal(fresh.outbox.length, 0);
});

test("并发二次调用拒绝：任务在途时不重复提交", async () => {
  const fixture = setup();
  let release: (() => void) | undefined;
  fixture.behave(async (request) => {
    request.onSubmitted?.();
    await new Promise<void>((resolve) => {
      release = resolve;
    });
    return { files: ["1-test.png"] };
  });
  const api = fixture.api();
  const first = fixture.tool.execute({ prompt: "一只猫" } as never, api, ctx());
  await new Promise((resolve) => setImmediate(resolve));
  assert.match(await rejection(() => fixture.tool.execute({ prompt: "再来" } as never, api, ctx())), /还在处理/);
  assert.equal(fixture.calls.length, 1);
  release?.();
  assert.match(text(await first), /画好了/);
  assert.equal(fixture.outbox.length, 1);
});

test("同轮成功后二次调用拒绝 used，新一轮恢复", async () => {
  const fixture = setup();
  const api = fixture.api();
  await fixture.tool.execute({ prompt: "一只猫" } as never, api, ctx());
  assert.match(await rejection(() => fixture.tool.execute({ prompt: "再来一张" } as never, api, ctx())), /已经用远程画过/);
  assert.equal(fixture.calls.length, 1);
  await fixture.tool.execute({ prompt: "新的一轮" } as never, fixture.api(2), ctx());
  assert.equal(fixture.calls.length, 2);
});

test("拿不到轮标识时拒绝 round_missing，不碰适配器", async () => {
  const fixture = setup();
  assert.match(await rejection(() => fixture.tool.execute({ prompt: "一只猫" } as never, fixture.api(null), ctx())), /无法确认当前轮次/);
  assert.equal(fixture.calls.length, 0);
});

test("submitted=false 的失败不锁轮：修正后同轮可重试成功", async () => {
  const cases: Array<{
    name: string;
    provider: DrawRemoteProvider;
    args?: Record<string, unknown>;
    error: DrawRemoteError;
    rejected: RegExp;
    /** 失败那一次之后 onLongWork 的次数：提交前失败 = 0；POST 之后被 4xx 拒 = 1（「稍等」已发出）。 */
    longWorks: number;
  }> = [
    {
      name: "unconfigured（缺 models.json provider / 凭据）",
      provider: "gemini",
      error: new DrawRemoteError("gemini", "unconfigured", "draw_remote 未配置：models.json（/x/config/models.json）里没有 provider「google-antigravity」", false),
      rejected: /还没配置好.*google-antigravity/,
      longWorks: 0,
    },
    {
      name: "bad_ref（qwen 通道参考图超 3 张：工具层放行的 3 张之外，适配器层的张数防御拦下第 4 张）",
      provider: "qwen",
      args: { images: ["inbound/a.png", "inbound/b.png", "inbound/p.jpg"] },
      error: new DrawRemoteError("qwen", "bad_ref", "qwen 通道最多接受 3 张参考图", false),
      rejected: /用不了.*最多 3 张/,
      longWorks: 0,
    },
    {
      name: "no_transparent（qwen 要透明底）",
      provider: "qwen",
      args: { background: "transparent" },
      error: new DrawRemoteError("qwen", "no_transparent", "qwen 通道不支持透明背景（background=transparent）", false),
      rejected: /不支持透明背景/,
      longWorks: 0,
    },
    {
      name: "prompt（超 4000 字）",
      provider: "qwen",
      error: new DrawRemoteError("qwen", "prompt", "draw_remote 的 prompt 去首尾空白后不能为空，且不得超过 4000 字（当前 4001 字）", false),
      rejected: /画面描述不合适.*4000 字/,
      longWorks: 0,
    },
    {
      name: "上游 400（请求发出后被确定性拒绝）",
      provider: "gpt",
      error: new DrawRemoteError("gpt", "failed", "gpt 生图请求失败（HTTP 400）", false),
      rejected: /没成功.*HTTP 400/,
      longWorks: 1,
    },
  ];
  for (const item of cases) {
    const fixture = setup();
    fixture.setConfig({ provider: item.provider });
    let attempt = 0;
    fixture.behave(async (request) => {
      attempt += 1;
      // 提交前的失败适配器不会调 onSubmitted；POST 之后的 4xx 会先调一次
      if (attempt > 1 || item.longWorks > 0) request.onSubmitted?.();
      if (attempt === 1) throw item.error;
      return { files: ["retry-ok.png"] };
    });
    const api = fixture.api(3);
    const args = { prompt: "一只猫", ...(item.args ?? {}) };
    const failed = await rejection(() => fixture.tool.execute(args as never, api, ctx()));
    assert.match(failed, item.rejected, item.name);
    assert.doesNotMatch(failed, /结果不明/, `${item.name}：确定性失败不说结果不明`);
    if (item.longWorks > 0) assert.match(failed, /say_words/, `${item.name}：已发过「稍等」的失败要引导告知群友`);
    assert.equal(fixture.longWorks.length, item.longWorks, `${item.name}：onLongWork 次数`);
    assert.equal(fixture.outbox.length, 0, `${item.name}：失败不入队`);
    // 同轮修正后重试：没被上一次失败锁住
    const result = await fixture.tool.execute({ prompt: "一只猫" } as never, api, ctx());
    assert.match(text(result), /gen\/retry-ok\.png/, item.name);
    assert.equal(fixture.calls.length, 2, item.name);
  }
});

test("submitted=true 的失败锁轮：上游 500 / 超时后同轮重试报 uncertain", async () => {
  const errors = [
    new DrawRemoteError("gpt", "failed", "gpt 生图请求失败（HTTP 500）", true),
    new DrawRemoteError("gemini", "failed", "gemini 生图请求超时（180000ms），结果不明", true),
  ];
  for (const error of errors) {
    const fixture = setup();
    fixture.behave(async (request) => {
      request.onSubmitted?.();
      throw error;
    });
    const api = fixture.api();
    const rejected = await rejection(() => fixture.tool.execute({ prompt: "一只猫" } as never, api, ctx()));
    assert.match(rejected, /结果不明/);
    assert.match(rejected, /不要.*draw_remote/, "明确告知本轮不要重试");
    assert.match(rejected, /say_words/, "失败回执引导用 say_words 告知群友");
    assert.doesNotMatch(rejected, /画好了/);
    assert.equal(fixture.longWorks.length, 1, "请求发出前的「稍等」已经发过");
    assert.equal(fixture.outbox.length, 0, "失败不出图");

    assert.match(await rejection(() => fixture.tool.execute({ prompt: "再来" } as never, api, ctx())), /状态未确认/);
    assert.equal(fixture.calls.length, 1, "锁轮后不再碰适配器");
  }
});

test("非 DrawRemoteError 的异常：已提交按结果不明锁轮，提交前不锁；原始报错不出境", async () => {
  const posted = setup();
  posted.behave(async (request) => {
    request.onSubmitted?.();
    throw new TypeError("write EEXIST");
  });
  const api = posted.api();
  const message = await rejection(() => posted.tool.execute({ prompt: "一只猫" } as never, api, ctx()));
  assert.match(message, /结果不明/);
  assert.match(message, /内部错误/);
  assert.doesNotMatch(message, /EEXIST/);
  assert.match(await rejection(() => posted.tool.execute({ prompt: "再来" } as never, api, ctx())), /状态未确认/);
  assert.equal(posted.calls.length, 1);

  const early = setup();
  early.behave(async () => {
    throw new TypeError("boom before submit");
  });
  const earlyApi = early.api();
  const earlyMessage = await rejection(() => early.tool.execute({ prompt: "一只猫" } as never, earlyApi, ctx()));
  assert.match(earlyMessage, /没成功.*内部错误/);
  assert.doesNotMatch(earlyMessage, /结果不明/);
  assert.doesNotMatch(earlyMessage, /boom/);
  assert.equal(early.longWorks.length, 0);
  early.behave(async (request) => {
    request.onSubmitted?.();
    return { files: ["after-boom.png"] };
  });
  assert.match(text(await early.tool.execute({ prompt: "一只猫" } as never, earlyApi, ctx())), /gen\/after-boom\.png/);
});

test("参考图：方括号兼容，按真实字节读图交给适配器", async () => {
  const fixture = setup();
  fixture.setConfig({ provider: "gpt" });
  const result = await fixture.tool.execute(
    { prompt: "把这几张拼起来", images: ["[inbound/a.png]", " inbound/p.jpg ", "[inbound/anim.gif]"] } as never,
    fixture.api(),
    ctx(),
  );
  assert.match(text(result), /画好了/);
  const images = fixture.calls[0]?.images ?? [];
  assert.equal(images.length, 3);
  assert.deepEqual(
    images.map((image) => ({ mimeType: image.mimeType, length: image.bytes.length })),
    [
      { mimeType: "image/png", length: 64 },
      { mimeType: "image/jpeg", length: 58 },
      { mimeType: "image/gif", length: 39 },
    ],
  );
  assert.ok(png(64).equals(images[0]!.bytes), "字节原样（不经任何转码）");
});

test("参考图围栏：穿越 / 绝对路径 / 符号链接 / 非图 / 魔数不符 / 0 字节 / 超限 / 超出通道张数上限 一律 bad_ref", async () => {
  // 这条用例跑在缺省通道上（qwen，最多 3 张）：类型与张数的逐通道边界见下面两条用例
  const fixture = setup();
  const outside = mkdtempSync(join(tmpdir(), "yg-draw-remote-outside-"));
  work.push(outside);
  writeFileSync(join(outside, "secret.png"), png(64));
  symlinkSync(join(outside, "secret.png"), join(fixture.inbound, "link-out.png"));
  symlinkSync(join(fixture.inbound, "a.png"), join(fixture.inbound, "link-in.png"));
  writeFileSync(join(fixture.inbound, "note.txt"), "不是图片");
  writeFileSync(join(fixture.inbound, "fake.png"), jpeg(40));
  writeFileSync(join(fixture.inbound, "empty.png"), Buffer.alloc(0));
  writeFileSync(join(fixture.inbound, "big.png"), png(10 * MiB + 1));

  const bad: Array<[string, string[]]> = [
    ["../ 穿越", ["../etc/passwd"]],
    ["绝对路径", [join(outside, "secret.png")]],
    ["目录本身", ["inbound"]],
    ["不存在的文件", ["inbound/missing.png"]],
    ["指向目录外的符号链接", ["inbound/link-out.png"]],
    ["指向目录内的符号链接（最终分量是链接一律不跟随）", ["inbound/link-in.png"]],
    ["非图片", ["inbound/note.txt"]],
    ["魔数与后缀不符", ["inbound/fake.png"]],
    ["0 字节", ["inbound/empty.png"]],
    ["单张超过 10MiB", ["inbound/big.png"]],
    ["超出通道张数上限（6 张）", ["inbound/a.png", "inbound/a.png", "inbound/a.png", "inbound/a.png", "inbound/a.png", "inbound/a.png"]],
    ["好图夹带一张坏图整批拒", ["inbound/a.png", "inbound/fake.png"]],
    ["空字符串", ["   "]],
  ];
  for (const [name, images] of bad) {
    const rejected = await rejection(() => fixture.tool.execute({ prompt: "改这张", images } as never, fixture.api(), ctx()));
    assert.match(rejected, /用不了/, name);
  }
  assert.equal(fixture.calls.length, 0, "围栏在任何请求之前：适配器一次都没被调");
  assert.equal(fixture.longWorks.length, 0);
  assert.equal(fixture.commits(), 0);

  // 拒绝之后同一轮仍可修正重试
  assert.match(text(await fixture.tool.execute({ prompt: "改这张", images: ["[inbound/a.png]"] } as never, fixture.api(), ctx())), /画好了/);
});

test("bad_ref 回执点名具体是哪张图（去掉方括号后的原路径）", async () => {
  const fixture = setup();
  writeFileSync(join(fixture.inbound, "fake.png"), jpeg(40));
  const mismatch = await rejection(() => fixture.tool.execute({ prompt: "改这张", images: ["[inbound/fake.png]"] } as never, fixture.api(), ctx()));
  assert.match(mismatch, /inbound\/fake\.png.*用不了/);
  assert.doesNotMatch(mismatch, /\[/, "回执里不带方括号");
  const missing = await rejection(() => fixture.tool.execute({ prompt: "改这张", images: ["inbound/gone.png"] } as never, fixture.api(), ctx()));
  assert.match(missing, /inbound\/gone\.png.*用不了/);
});

test("gemini 通道的参考图能力：gif 与聚合超过 15MiB 拒掉；同样输入在 gpt 通道放行", async () => {
  const fixture = setup();
  writeFileSync(join(fixture.inbound, "m8-a.png"), png(8 * MiB));
  writeFileSync(join(fixture.inbound, "m8-b.png"), png(8 * MiB));

  fixture.setConfig({ provider: "gemini" });
  const gifRejected = await rejection(() =>
    fixture.tool.execute({ prompt: "参考这张", images: ["inbound/anim.gif"] } as never, fixture.api(), ctx()),
  );
  assert.match(gifRejected, /inbound\/anim\.gif.*用不了/);
  const totalRejected = await rejection(() =>
    fixture.tool.execute({ prompt: "拼起来", images: ["inbound/m8-a.png", "inbound/m8-b.png"] } as never, fixture.api(2), ctx()),
  );
  assert.match(totalRejected, /inbound\/m8-b\.png.*用不了/);
  assert.equal(fixture.calls.length, 0, "gemini 通道：两次都没发出去");

  fixture.setConfig({ provider: "gpt" });
  await fixture.tool.execute({ prompt: "参考这张", images: ["inbound/anim.gif"] } as never, fixture.api(3), ctx());
  assert.equal(fixture.calls[0]?.images?.[0]?.mimeType, "image/gif");
  await fixture.tool.execute({ prompt: "拼起来", images: ["inbound/m8-a.png", "inbound/m8-b.png"] } as never, fixture.api(4), ctx());
  assert.equal(fixture.calls[1]?.images?.length, 2, "gpt 通道只限单张体积，不限聚合");
});

test("参考图张数按通道：qwen 最多 3 张（第 4 张起拒），gpt / wan / gemini 最多 5 张（第 6 张起拒）", async () => {
  for (const [provider, limit] of [
    ["qwen", 3],
    ["gpt", 5],
    ["wan", 5],
    ["gemini", 5],
  ] as const) {
    const fixture = setup();
    fixture.setConfig({ provider });
    // 只用四条通道都认的 png / jpg：把「类型不认」从这条用例里排除，只验张数
    writeFileSync(join(fixture.inbound, "c.png"), png(64));
    writeFileSync(join(fixture.inbound, "d.png"), png(64));
    writeFileSync(join(fixture.inbound, "e.png"), png(64));
    const refs = ["inbound/a.png", "inbound/b.png", "inbound/p.jpg", "inbound/c.png", "inbound/d.png", "inbound/e.png"];

    const accepted = await fixture.tool.execute({ prompt: "拼起来", images: refs.slice(0, limit) } as never, fixture.api(), ctx());
    assert.match(text(accepted), /画好了/, `${provider}：恰好 ${limit} 张放行`);
    assert.equal(fixture.calls[0]?.images?.length, limit);

    // 第 limit+1 张起拒：回执点名这一张，并如实写出通道上限
    const over = refs[limit]!;
    const rejected = await rejection(() =>
      fixture.tool.execute({ prompt: "拼起来", images: refs.slice(0, limit + 1) } as never, fixture.api(2), ctx()),
    );
    assert.match(rejected, new RegExp(`${over.replaceAll(".", "\\.")}.*用不了`), `${provider}：第 ${limit + 1} 张起拒`);
    assert.match(rejected, provider === "qwen" ? /qwen 通道最多 3 张/ : /最多 5 张（qwen 通道最多 3 张）/, provider);
    assert.equal(fixture.calls.length, 1, `${provider}：超限的那次没到适配器`);
  }
});

test("参考图类型按通道：wan / gemini 不认 gif，gpt / qwen 认 gif；缺省通道 qwen 不切配置也认", async () => {
  for (const provider of ["wan", "gemini"] as const) {
    const fixture = setup();
    fixture.setConfig({ provider });
    const rejected = await rejection(() =>
      fixture.tool.execute({ prompt: "参考这张", images: ["inbound/anim.gif"] } as never, fixture.api(), ctx()),
    );
    assert.match(rejected, /inbound\/anim\.gif.*用不了/, provider);
    assert.equal(fixture.calls.length, 0, `${provider}：没发出去`);
  }
  // gpt 认 gif 是老行为；qwen（缺省通道）同样认
  for (const provider of ["gpt", "qwen"] as const) {
    const fixture = setup();
    fixture.setConfig({ provider });
    await fixture.tool.execute({ prompt: "参考这张", images: ["inbound/anim.gif"] } as never, fixture.api(), ctx());
    assert.equal(fixture.calls[0]?.images?.[0]?.mimeType, "image/gif", provider);
  }
  const byDefault = setup();
  await byDefault.tool.execute({ prompt: "参考这张", images: ["[inbound/anim.gif]"] } as never, byDefault.api(), ctx());
  assert.equal(byDefault.calls[0]?.provider, "qwen");
  assert.equal(byDefault.calls[0]?.model, "qwen-image-3.0-pro");
  assert.equal(byDefault.calls[0]?.images?.[0]?.mimeType, "image/gif");
  assert.match(text(await byDefault.tool.execute({ prompt: "再来" } as never, byDefault.api(2), ctx())), /qwen 画好了/);
});

test("取消围栏：返回后已中止则不入 outbox、直接抛取消异常", async () => {
  // 适配器返回前宿主已取消（工具超时 / 人工中断）：晚到的图不落 outbox，整体按取消上抛
  const before = setup();
  const first = new AbortController();
  before.behave(async (request) => {
    request.onSubmitted?.();
    first.abort();
    return { files: ["late-1.png", "late-2.png"] };
  });
  const isAbort = (error: unknown) => (error as { name?: string }).name === "AbortError";
  await assert.rejects(() => before.tool.execute({ prompt: "一只猫" } as never, before.api(), ctx(first.signal)), isAbort);
  assert.equal(before.commits(), 0, "已取消：一次 outbox 提交都不发生");
  assert.equal(before.outbox.length, 0);
  // 信号早已中止的调用连适配器都进不去
  await assert.rejects(() => before.tool.execute({ prompt: "一只猫" } as never, before.api(2), ctx(first.signal)), isAbort);
  assert.equal(before.calls.length, 1);

  // 多图循环中途取消：第一张已入队，第二张入队前复核后停下；整体按取消上抛，不回退成「请补发」提示
  const mid = setup();
  const second = new AbortController();
  mid.behave(async (request) => {
    request.onSubmitted?.();
    return { files: ["111-a.png", "222-b.png"] };
  });
  const api = mid.api(8, {
    onCommit: (n) => {
      if (n === 2) second.abort();
    },
  });
  await assert.rejects(() => mid.tool.execute({ prompt: "一只猫" } as never, api, ctx(second.signal)), isAbort);
  assert.equal(mid.outbox.length, 1, "只有第一张入了队");

  // 提交后取消的轮同轮不能再画（结果不明）；新一轮不受影响
  assert.match(await rejection(() => before.tool.execute({ prompt: "再来" } as never, before.api(1), ctx())), /状态未确认/);
  before.behave(async (request) => {
    request.onSubmitted?.();
    return { files: ["fresh.png"] };
  });
  assert.match(text(await before.tool.execute({ prompt: "新的一轮" } as never, before.api(3), ctx())), /gen\/fresh\.png/);
});

test("文案契约：done 带通道名与路径并劝阻 say_media，failed 引导 say_words，key 全部 draw_remote_*", () => {
  const messages = manifest.messages;
  for (const key of Object.keys(messages)) assert.match(key, /^draw_remote_[a-z0-9_]*$/);
  assert.match(messages["draw_remote_done"], /\{\{provider\}\}/);
  assert.match(messages["draw_remote_done"], /\{\{file\}\}/);
  assert.match(messages["draw_remote_done"], /say_media/);
  assert.match(messages["draw_remote_done_fallback"], /\{\{file\}\}/);
  assert.match(messages["draw_remote_done_fallback"], /say_media/);
  assert.match(messages["draw_remote_failed"], /say_words/);
  assert.match(messages["draw_remote_failed_uncertain"], /say_words/);
  for (const key of ["draw_remote_disabled", "draw_remote_round_missing", "draw_remote_inflight", "draw_remote_used", "draw_remote_uncertain"]) {
    assert.ok(messages[key], `缺文案 ${key}`);
  }
  // bad_ref：点名是哪张，并如实写出张数上限（qwen 通道更少）；wan / qwen 都支持改图后 no_ref 整条删除，不留死文案
  assert.match(messages["draw_remote_bad_ref"], /\{\{ref\}\}.*用不了/);
  assert.match(messages["draw_remote_bad_ref"], /最多 5 张（qwen 通道最多 3 张）/);
  assert.equal(messages["draw_remote_no_ref"], undefined);
  // 参数 Schema：prompt 必填（四通道同一个 4000 字上限），images 最多 5 张（qwen 通道 3 张在执行期拦），比例与背景是枚举
  const properties = manifest.parameters.properties as Record<string, Record<string, unknown>>;
  assert.deepEqual(manifest.parameters.required, ["prompt"]);
  assert.equal(properties["images"]?.["maxItems"], 5);
  assert.deepEqual(properties["aspect_ratio"]?.["enum"], ["1:1", "3:4", "4:3", "9:16", "16:9"]);
  assert.deepEqual(properties["background"]?.["enum"], ["auto", "transparent", "opaque"]);
  assert.deepEqual(Object.keys(properties).sort(), ["aspect_ratio", "background", "images", "prompt"]);
  for (const name of ["prompt", "images", "aspect_ratio", "background"]) {
    assert.doesNotMatch(String(properties[name]?.["description"]), /800 字/, `${name}：wan 的 800 字上限已统一成 4000 字`);
  }
  assert.match(String(properties["prompt"]?.["description"]), /4000 字/);
  assert.match(String(properties["images"]?.["description"]), /最多 5 张.*qwen 通道最多 3 张/);
  assert.match(String(properties["aspect_ratio"]?.["description"]), /qwen \/ wan \/ gemini 通道生效，gpt 通道忽略/);
  // TOOL.md：四通道说明；images 四通道都能改图；比例对 qwen / wan / gemini 生效；通道不由模型选，出图自动发出
  assert.match(manifest.description, /GPT Image \/ Wan \/ Qwen \/ Gemini/);
  assert.match(manifest.guide, /gpt \/ wan \/ qwen \/ gemini/);
  assert.match(manifest.guide, /qwen \/ wan \/ gemini 通道生效，gpt 通道忽略/);
  assert.match(manifest.guide, /最多 5 张（qwen 通道最多 3 张）/);
  assert.match(manifest.guide, /gpt \/ qwen 通道额外认 gif/);
  assert.doesNotMatch(manifest.guide, /800 字|不支持参考图|wan 不收参考图/);
  assert.match(manifest.guide, /drawRemote\.provider/);
  assert.match(manifest.guide, /say_media/);
});
