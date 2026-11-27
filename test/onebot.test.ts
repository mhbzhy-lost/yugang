/**
 * 裸 @ 修复：
 *  - 只 @ 不带字的消息不再被丢弃，以最小占位文本进闸（进 chatlog 与 user message）
 *  - 非 @ 的空文本维持丢弃
 */
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  OneBot,
  parseEvent,
  completeAtNames,
  fillAtName,
  buildGroupTextSegments,
  buildGroupImageSegments,
  type OneBotEvent,
} from "../src/qq/onebot.ts";

const SELF = 1000;

function frame(message: OneBotEvent["message"]): OneBotEvent {
  return {
    post_type: "message",
    message_type: "group",
    group_id: 42,
    user_id: 2000,
    message_id: 7,
    sender: { nickname: "张三" },
    message,
  };
}

test("裸 @（只 @ 不带字）不丢弃，占位文本进链路", () => {
  const parsed = parseEvent(frame([{ type: "at", data: { qq: SELF } }, { type: "text", data: { text: "" } }]), SELF);
  assert.ok(parsed, "裸 @ 被丢了，用户观感是鱼不理人");
  assert.equal(parsed.mentionsBot, true);
  assert.ok(parsed.text.trim().length > 0, "占位文本不能是空的，否则后面还是被当空消息丢掉");
  assert.match(parsed.text, /@/);
});

test("非 @ 的空文本维持丢弃", () => {
  const empty = parseEvent(frame([{ type: "text", data: { text: "   " } }]), SELF);
  assert.equal(empty, null);

  // @ 了别人（不是鱼）的空文本也不进
  const other = parseEvent(frame([{ type: "at", data: { qq: 9999 } }, { type: "text", data: { text: "" } }]), SELF);
  assert.equal(other, null);
});

test("带正文的 @ 行为不变", () => {
  const parsed = parseEvent(frame([{ type: "at", data: { qq: SELF } }, { type: "text", data: { text: " 在吗" } }]), SELF);
  assert.ok(parsed);
  assert.equal(parsed.mentionsBot, true);
  assert.equal(parsed.text, "在吗");
});

test("@号码补昵称只改自己那个占位，不碰数字前缀相同的别人", () => {
  // @12 的号码是 @123 的前缀：不能把 @123 也改成 @张三(12)3
  assert.equal(fillAtName("@12 和 @123 都在", "12", "张三"), "@张三(12) 和 @123 都在");
  // 昵称里带 $& / $1 不能被当成替换模式（字符串模板 replace 会吃掉它们）
  assert.equal(fillAtName("@77 来", "77", "$&老哥"), "@$&老哥(77) 来");
  // 非法号码原样返回
  assert.equal(fillAtName("@all 集合", "all", "全体成员"), "@all 集合");
});

test("completeAtNames：名单里有的才补，空名 / @全体 / 非法号码跳过", async () => {
  const parsed = parseEvent(
    frame([
      { type: "at", data: { qq: 12 } },
      { type: "at", data: { qq: "all" } },
      { type: "text", data: { text: " 看 @123" } },
    ]),
    SELF,
  );
  assert.ok(parsed);
  await completeAtNames(parsed, (qq) => (qq === "12" ? " 张三 " : undefined));
  assert.match(parsed.text, /@张三\(12\)/, "合法号码应该补上昵称");
  assert.match(parsed.text, /@123/, "号码前缀相同的别人不能被改掉");
  assert.match(parsed.text, /@全体成员/, "@全体 保持标记");
  assert.equal(parsed.atOtherNames?.[0], "张三");
  assert.equal(parsed.mentions?.find((m) => m.qq === "12")?.name, "张三");

  const unknown = parseEvent(frame([{ type: "at", data: { qq: 12 } }, { type: "text", data: { text: " 你好" } }]), SELF);
  assert.ok(unknown);
  const before = unknown.text;
  await completeAtNames(unknown, () => "   ");
  assert.equal(unknown.text, before, "空名不能把正文改成 @(12)");
});

test("buildGroupTextSegments：主动 @ 后自动补空格与正文分隔，多 @ 间也隔开且不重复补", () => {
  assert.deepEqual(buildGroupTextSegments("你好"), [{ type: "text", data: { text: "你好" } }]);
  assert.deepEqual(buildGroupTextSegments("你好", { mentions: ["123"] }), [
    { type: "at", data: { qq: "123" } },
    { type: "text", data: { text: " 你好" } },
  ]);
  assert.deepEqual(buildGroupTextSegments(" 你好", { mentions: ["123"] }), [
    { type: "at", data: { qq: "123" } },
    { type: "text", data: { text: " 你好" } },
  ]);
  assert.deepEqual(buildGroupTextSegments("开黑", { quote: 99, mentions: ["123", "456"] }), [
    { type: "reply", data: { id: "99" } },
    { type: "at", data: { qq: "123" } },
    { type: "text", data: { text: " " } },
    { type: "at", data: { qq: "456" } },
    { type: "text", data: { text: " 开黑" } },
  ]);
});

test("buildGroupImageSegments：带 @ 发图时每个 @ 后补空格再接图片段", () => {
  assert.deepEqual(buildGroupImageSegments("AAAA", { quote: 7, mentions: ["123", "456"] }), [
    { type: "reply", data: { id: "7" } },
    { type: "at", data: { qq: "123" } },
    { type: "text", data: { text: " " } },
    { type: "at", data: { qq: "456" } },
    { type: "text", data: { text: " " } },
    { type: "image", data: { file: "base64://AAAA" } },
  ]);
});

class MockWebSocket {
  static instances: MockWebSocket[] = [];
  static onCreate?: (ws: MockWebSocket, index: number) => void;
  readyState = 0; // CONNECTING
  url: string;
  sent: string[] = [];
  closed = false;
  onSend?: (raw: string, ws: MockWebSocket) => void;
  #listeners = new Map<string, Set<(event: any) => void>>();

  constructor(url: string) {
    this.url = url;
    MockWebSocket.instances.push(this);
    MockWebSocket.onCreate?.(this, MockWebSocket.instances.length - 1);
  }

  addEventListener(type: string, listener: (event: any) => void, options?: { once?: boolean }): void {
    let set = this.#listeners.get(type);
    if (!set) {
      set = new Set();
      this.#listeners.set(type, set);
    }
    if (options?.once) {
      const wrapped = (event: any) => {
        set!.delete(wrapped);
        listener(event);
      };
      set.add(wrapped);
    } else {
      set.add(listener);
    }
  }

  removeEventListener(type: string, listener: (event: any) => void): void {
    this.#listeners.get(type)?.delete(listener);
  }

  send(raw: string): void {
    if (this.readyState !== 1) throw new Error("socket not open");
    this.sent.push(raw);
    this.onSend?.(raw, this);
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    this.readyState = 3;
    this.emit("close", {});
  }

  open(): void {
    this.readyState = 1;
    this.emit("open", {});
  }

  failConnect(): void {
    this.readyState = 3;
    this.emit("error", new Error("connect failed"));
    this.emit("close", {});
  }

  emit(type: string, event: any): void {
    for (const listener of [...(this.#listeners.get(type) ?? [])]) {
      listener(event);
    }
  }
}

async function withMockWebSocket<T>(fn: () => Promise<T>): Promise<T> {
  const original = globalThis.WebSocket;
  MockWebSocket.instances = [];
  MockWebSocket.onCreate = undefined;
  globalThis.WebSocket = MockWebSocket as unknown as typeof WebSocket;
  try {
    return await fn();
  } finally {
    MockWebSocket.onCreate = undefined;
    globalThis.WebSocket = original;
  }
}

async function advanceTimers(t: test.TestContext, ms: number, step = 100): Promise<void> {
  const flush = async () => {
    for (let i = 0; i < 6; i++) await Promise.resolve();
  };
  await flush();
  let remaining = ms;
  while (remaining > 0) {
    const chunk = Math.min(step, remaining);
    t.mock.timers.tick(chunk);
    remaining -= chunk;
    await flush();
  }
}

test("首次 connect 连不上按原样 reject，不触发重连", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout", "setInterval", "Date"] });
  await withMockWebSocket(async () => {
    let reconnected = 0;
    MockWebSocket.onCreate = (ws) => {
      queueMicrotask(() => ws.failConnect());
    };
    const bot = new OneBot("ws://fake", undefined, undefined, {
      onReconnect: () => {
        reconnected++;
      },
    });
    await assert.rejects(bot.connect(), /连不上 OneBot WebSocket/);
    await advanceTimers(t, 60_000, 1_000);
    assert.equal(MockWebSocket.instances.length, 1);
    assert.equal(reconnected, 0);
    bot.close();
  });
});

test("首次连上后断线按指数退避重连并触发 onReconnect，不并发建多条 WS，close 后停机", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout", "setInterval", "Date"] });
  await withMockWebSocket(async () => {
    let reconnected = 0;
    MockWebSocket.onCreate = (ws, idx) => {
      if (idx === 0) queueMicrotask(() => ws.open());
      else if (idx === 1 || idx === 2) queueMicrotask(() => ws.failConnect());
      else queueMicrotask(() => ws.open());
    };
    const bot = new OneBot("ws://fake", undefined, undefined, {
      onReconnect: () => {
        reconnected++;
      },
    });
    await bot.connect();
    assert.equal(MockWebSocket.instances.length, 1);

    // 首次连上后断开，连续重复触发 close 也不得并发创建多个 WS
    const ws0 = MockWebSocket.instances[0]!;
    ws0.readyState = 3;
    ws0.emit("close", {});
    ws0.emit("close", {});

    // 未满 1s 前不应发起重连
    await advanceTimers(t, 900);
    assert.equal(MockWebSocket.instances.length, 1);

    // 第 1 次重连：1s + jitter (< 1.2s)
    await advanceTimers(t, 400);
    assert.equal(MockWebSocket.instances.length, 2);

    // 第 1 次重连失败后，第 2 次退避为 2s + jitter（至少 2s，在 1.5s 时不应重连）
    await advanceTimers(t, 1_500);
    assert.equal(MockWebSocket.instances.length, 2);
    await advanceTimers(t, 1_200);
    assert.equal(MockWebSocket.instances.length, 3);

    // 第 2 次失败后，第 3 次退避 4s + jitter 后成功打开
    await advanceTimers(t, 5_000);
    assert.equal(MockWebSocket.instances.length, 4);
    assert.equal(reconnected, 1);

    // 显式 close() 后再推进时间也不会重连
    bot.close();
    await advanceTimers(t, 120_000, 1_000);
    assert.equal(MockWebSocket.instances.length, 4);
  });
});

test("heartbeatTimeoutMs 超时发 get_status 探测，失败时主动断链并触发重连", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout", "setInterval", "Date"] });
  await withMockWebSocket(async () => {
    let reconnected = 0;
    const actions: string[] = [];
    MockWebSocket.onCreate = (ws, idx) => {
      ws.onSend = (raw) => {
        const req = JSON.parse(raw) as { action: string };
        actions.push(req.action);
        // 第一个 socket 对 get_status 装死不回（模拟半开）
      };
      if (idx === 0 || idx === 1) queueMicrotask(() => ws.open());
    };
    const bot = new OneBot("ws://fake", undefined, undefined, {
      heartbeatTimeoutMs: 1_000,
      onReconnect: () => {
        reconnected++;
      },
    });
    await bot.connect();

    // 900ms 收到 meta_event 刷新活跃时间，不应触发断链
    await advanceTimers(t, 900);
    MockWebSocket.instances[0]!.emit("message", {
      data: JSON.stringify({ post_type: "meta_event", meta_event_type: "heartbeat", self_id: 1000 }),
    });
    await advanceTimers(t, 500);
    assert.equal(actions.length, 0);

    // 再静默超过 heartbeatTimeoutMs，触发 get_status 探测
    await advanceTimers(t, 1_000);
    assert.ok(actions.includes("get_status"), "超时后应发 get_status 探测");

    // 探测超时失败 -> 主动关闭旧连接并进入重连
    await advanceTimers(t, 3_000);
    assert.ok(MockWebSocket.instances.length >= 2, "探测失败后应重连新建 WebSocket");
    assert.equal(reconnected, 1);
    bot.close();
  });
});

test("含 null 消息段与抛错帧不产生 UnhandledPromiseRejection", async () => {
  const rejections: unknown[] = [];
  const onUnhandled = (reason: unknown) => {
    rejections.push(reason);
  };
  process.on("unhandledRejection", onUnhandled);
  try {
    const parsed = parseEvent(
      frame([null as unknown as OneBotEvent["message"] & object, { type: "text", data: { text: "正常正文" } }] as unknown as OneBotEvent["message"]),
      SELF,
    );
    assert.ok(parsed);
    assert.equal(parsed.text, "正常正文");

    await withMockWebSocket(async () => {
      MockWebSocket.onCreate = (ws) => queueMicrotask(() => ws.open());
      const bot = new OneBot("ws://fake");
      bot.onMessage(() => {
        throw new Error("handler_boom");
      });
      await bot.connect();
      const ws = MockWebSocket.instances[0]!;
      ws.emit("message", { data: "null" });
      ws.emit("message", {
        data: JSON.stringify({
          post_type: "message",
          message_type: "group",
          group_id: 42,
          user_id: 2000,
          message_id: 9,
          self_id: SELF,
          message: [null, { type: "text", data: { text: "触发异常" } }],
        }),
      });
      await new Promise((r) => setTimeout(r, 20));
      bot.close();
    });

    assert.equal(rejections.length, 0, `不应产生 unhandledRejection: ${String(rejections[0])}`);
  } finally {
    process.off("unhandledRejection", onUnhandled);
  }
});

test("未连接时 sendGroup 抛出带 notSent=true 的错误", async () => {
  const bot = new OneBot("ws://fake");
  await assert.rejects(
    bot.sendGroup(42, ["你好"]),
    (err: unknown) => err instanceof Error && (err as { notSent?: boolean }).notSent === true,
  );
});

test("shouldDownloadMedia 返回 false 时不下载入站图片", async () => {
  const dir = mkdtempSync(join(tmpdir(), "yg-ob-media-"));
  const originalFetch = globalThis.fetch;
  let fetchCount = 0;
  globalThis.fetch = (async () => {
    fetchCount++;
    return new Response(new Uint8Array([0x89, 0x50, 0x4e, 0x47]), { status: 200 });
  }) as typeof fetch;
  try {
    await withMockWebSocket(async () => {
      MockWebSocket.onCreate = (ws) => queueMicrotask(() => ws.open());
      const bot = new OneBot("ws://fake", undefined, dir, {
        shouldDownloadMedia: (f) => f.group_id === 42,
      });
      const received: string[] = [];
      bot.onMessage((msg) => received.push(msg.text));
      await bot.connect();
      const ws = MockWebSocket.instances[0]!;
      ws.emit("message", {
        data: JSON.stringify({
          post_type: "message",
          message_type: "group",
          group_id: 99,
          user_id: 2000,
          self_id: SELF,
          message: [
            { type: "image", data: { url: "https://example.test/a.png" } },
            { type: "text", data: { text: " 看图" } },
          ],
        }),
      });
      await new Promise((r) => setTimeout(r, 20));
      assert.equal(fetchCount, 0);
      assert.equal(received.length, 1);
      assert.ok(!received[0]!.includes("inbound/"));
      bot.close();
    });
  } finally {
    globalThis.fetch = originalFetch;
    rmSync(dir, { recursive: true, force: true });
  }
});

test("#memberName 并发调用合并为单次 get_group_member_list，失败不写入 5 分钟缓存", async () => {
  await withMockWebSocket(async () => {
    let rpcCount = 0;
    let shouldFailGroup99 = true;
    MockWebSocket.onCreate = (ws) => {
      ws.onSend = (raw) => {
        const req = JSON.parse(raw) as { action: string; echo: string; params: { group_id: number } };
        if (req.action === "get_group_member_list") {
          rpcCount++;
          if (req.params.group_id === 42) {
            setTimeout(() => {
              ws.emit("message", {
                data: JSON.stringify({
                  echo: req.echo,
                  retcode: 0,
                  data: [
                    { user_id: 111, nickname: "甲" },
                    { user_id: 222, nickname: "乙" },
                  ],
                }),
              });
            }, 15);
          } else {
            queueMicrotask(() => {
              if (shouldFailGroup99) {
                ws.emit("message", { data: JSON.stringify({ echo: req.echo, retcode: -1 }) });
              } else {
                ws.emit("message", {
                  data: JSON.stringify({
                    echo: req.echo,
                    retcode: 0,
                    data: [{ user_id: 333, nickname: "丙" }],
                  }),
                });
              }
            });
          }
        }
      };
      queueMicrotask(() => ws.open());
    };

    const bot = new OneBot("ws://fake");
    const texts: string[] = [];
    bot.onMessage((m) => texts.push(m.text));
    await bot.connect();
    const ws = MockWebSocket.instances[0]!;

    // 同一群两条并发消息同时触发查名片，只应发 1 次 get_group_member_list
    ws.emit("message", {
      data: JSON.stringify({
        post_type: "message",
        message_type: "group",
        group_id: 42,
        user_id: 2000,
        self_id: SELF,
        message: [{ type: "at", data: { qq: 111 } }, { type: "text", data: { text: " hi" } }],
      }),
    });
    ws.emit("message", {
      data: JSON.stringify({
        post_type: "message",
        message_type: "group",
        group_id: 42,
        user_id: 2001,
        self_id: SELF,
        message: [{ type: "at", data: { qq: 222 } }, { type: "text", data: { text: " yo" } }],
      }),
    });
    await new Promise((r) => setTimeout(r, 40));
    assert.equal(rpcCount, 1);
    assert.ok(texts.some((t) => t.includes("@甲(111)")));
    assert.ok(texts.some((t) => t.includes("@乙(222)")));

    // group 99 首次 RPC 失败后，第二次仍应重查而不命中空缓存
    ws.emit("message", {
      data: JSON.stringify({
        post_type: "message",
        message_type: "group",
        group_id: 99,
        user_id: 2000,
        self_id: SELF,
        message: [{ type: "at", data: { qq: 333 } }, { type: "text", data: { text: " first" } }],
      }),
    });
    await new Promise((r) => setTimeout(r, 20));
    shouldFailGroup99 = false;
    ws.emit("message", {
      data: JSON.stringify({
        post_type: "message",
        message_type: "group",
        group_id: 99,
        user_id: 2000,
        self_id: SELF,
        message: [{ type: "at", data: { qq: 333 } }, { type: "text", data: { text: " second" } }],
      }),
    });
    await new Promise((r) => setTimeout(r, 20));
    assert.equal(rpcCount, 3);
    assert.ok(texts.some((t) => t.includes("@丙(333)")));
    bot.close();
  });
});

test("sendImageGroup 在 #pacedSend 配速等待完成后才读取文件并发送", async () => {
  const dir = mkdtempSync(join(tmpdir(), "yg-ob-img-"));
  const file1 = join(dir, "1.png");
  const file2 = join(dir, "2.png");
  writeFileSync(file1, Buffer.from("first"));
  try {
    await withMockWebSocket(async () => {
      const sentBodies: string[] = [];
      MockWebSocket.onCreate = (ws) => {
        ws.onSend = (raw) => {
          const req = JSON.parse(raw) as { echo: string; params: { message: unknown } };
          sentBodies.push(JSON.stringify(req.params.message));
          queueMicrotask(() => {
            ws.emit("message", { data: JSON.stringify({ echo: req.echo, retcode: 0, data: { message_id: 1 } }) });
          });
        };
        queueMicrotask(() => ws.open());
      };

      const bot = new OneBot("ws://fake", undefined, undefined, { pacingSeconds: 0.06 });
      await bot.connect();
      await bot.sendImageGroup(42, file1);

      // 第二张图片在调用前尚未落盘，在配速等待期间写入：若提前 readFileSync 会直接 ENOENT
      const p2 = bot.sendImageGroup(42, file2);
      const writeTimer = setTimeout(() => {
        writeFileSync(file2, Buffer.from("second"));
      }, 15);
      try {
        await p2;
      } finally {
        clearTimeout(writeTimer);
      }

      assert.equal(sentBodies.length, 2);
      assert.ok(sentBodies[1]!.includes(Buffer.from("second").toString("base64")));
      bot.close();
    });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
