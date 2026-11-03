/**
 * faux NapCat —— OneBot v11 协议端的本地替身（IT bed Task I1）。
 *
 * 协议结论（2026-11-03 逐行核对 src/qq/onebot.ts 后照实模拟）：
 * - 连接方向：鱼是 WS **客户端**，主动连 ONEBOT_WS_URL（缺省 ws://127.0.0.1:3001），
 *   token 以 ?access_token= 查询参数携带（withAccessToken）。本服务即 WS **服务端**。
 * - 动作帧：鱼发 {action, params, echo}（echo 形如 yg1）；应答 {status, retcode, data, echo}，
 *   retcode 非 0 一律按失败（onebot.ts #onFrame）；send_group_msg 应答须带 data.message_id。
 * - 鱼会调用的动作全集：send_group_msg / send_private_msg / set_msg_emoji_like（NapCat 扩展）、
 *   get_group_info（data.group_name/member_count/owner_id）、get_group_member_list（data 数组
 *   card/nickname/user_id）、get_msg（回复引用水合：data.message 段数组 + data.sender）、
 *   get_forward_msg（合集展开：data.messages 节点 content + sender.nickname）、
 *   get_login_info（scripts/probe.ts 用）、get_group_list / get_group_member_info（协议标配）。
 * - 事件帧：{post_type:"message", message_type:"group"|"private", self_id, user_id, group_id,
 *   message_id, message:段数组, raw_message, sender, time}；段：text/at/image/video/reply/json/forward。
 *   鱼只认 post_type=message；meta_event 只读 self_id；notice（含撤回）当前**不处理**——
 *   注入撤回按 OB11 标准发 group_recall 帧，鱼无反应是真实行为，不是 faux 缺陷。
 * - 心跳：反向 WS 下由协议端定期推 meta_event/heartbeat；连上立即推 lifecycle/connect + 首跳，
 *   让鱼第一时间拿到 self_id（@鱼 判定依赖它，onebot.ts #selfId）。
 * - 图片接收：image 段 data.url 为 http(s) 直链时鱼直接 fetch 下载（按魔数嗅探扩展名落盘），
 *   .gif 扩展名驱动 mediaOnly="gif" 判定（mediaOnlyOf 按 file/url 扩展名）。本服务同端口
 *   提供静态文件 /assets/*，注入图片段一律用可下载直链。
 *
 * 单文件零依赖：WS 服务端用 node:http upgrade + 手写 RFC6455 帧编解码（仓库无 ws 包）。
 *
 * 用法：
 *   node scripts/itbed/faux/napcat.ts [--port 8080] [--out outbound.jsonl] [--token xxx]
 *                                     [--groups 424242,10086] [--self 1000001]
 *                                     [--assets <dir>] [--heartbeat-ms 15000]
 *   环境变量同名大写（FAUX_PORT / FAUX_OUTBOUND / FAUX_TOKEN / FAUX_GROUPS / FAUX_SELF_ID /
 *   FAUX_ASSETS / FAUX_HEARTBEAT_MS）同样生效，CLI 优先。
 *
 * 注入 API（POST /inject，JSON；驱动器 I3 消费同一契约）：
 *   {kind:"group"(缺省)|"private"|"recall", groupId?, userId?, nickname?, messageId?,
 *    text?, at?:["bot"|"all"|"QQ号"...], quote?:消息id, image?:"test.jpg", gif?:true,
 *    card?:{title,desc,url}, forward?:[{name,text}|{name,image}|...], replyForward?:"FWD-1",
 *    segments?:[原始 OneBot 段], raw?:{完整事件透传}}
 *   快捷字段按 reply → at → image/gif → card → forward → text 顺序拼段；
 *   给了 segments 则正文完全以它为准（快捷字段忽略）；raw 最高优先级整帧透传。
 *   message_id 自增可指定；注入与鱼发送的消息都会登记进 get_msg，回复引用可水合。
 *
 * 观测：出站全量落 outbound.jsonl（{at, action, params 完整, echo, messageId}），
 *       控制台一行摘要；GET /health 探活；GET / 看用法。
 */

import { createHash } from "node:crypto";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { appendFileSync, existsSync, mkdirSync, readFileSync, statSync } from "node:fs";
import { dirname, join, resolve } from "node:path";

// ── 参数（CLI > 环境变量 > 缺省）─────────────────────────────────────────────

function argValue(name: string): string | undefined {
  const argv = process.argv;
  const at = argv.indexOf(`--${name}`);
  return at >= 0 && at + 1 < argv.length ? argv[at + 1] : undefined;
}
function option(name: string, envName: string, fallback: string): string {
  return argValue(name) ?? process.env[envName] ?? fallback;
}
function num(value: string, fallback: number): number {
  const n = Number(value);
  return Number.isFinite(n) && n > 0 ? n : fallback;
}

const PORT = num(option("port", "FAUX_PORT", "8080"), 8080);
const OUT_PATH = resolve(option("out", "FAUX_OUTBOUND", "outbound.jsonl"));
const TOKEN = option("token", "FAUX_TOKEN", "");
const SELF_ID = num(option("self", "FAUX_SELF_ID", "1000001"), 1000001);
const HEARTBEAT_MS = num(option("heartbeat-ms", "FAUX_HEARTBEAT_MS", "15000"), 15000);
const ASSETS_DIR = resolve(option("assets", "FAUX_ASSETS", join(import.meta.dirname, "assets")));
const GROUP_IDS = option("groups", "FAUX_GROUPS", "424242")
  .split(",")
  .map((s) => Number(s.trim()))
  .filter((n) => Number.isFinite(n) && n > 0);
if (GROUP_IDS.length === 0) GROUP_IDS.push(424242);

// ── 固定名单 fixture ────────────────────────────────────────────────────────

/** 群成员：card 是群名片（鱼认 card 优先于 nickname），统一等于显示名保持稳定。 */
interface Member {
  userId: number;
  nickname: string;
  role: "owner" | "admin" | "member";
}
/** 名单：鱼（admin）、主人（群主）、若干假人。默认所有群共用一份。 */
const ROSTER: Member[] = [
  { userId: SELF_ID, nickname: "鱼", role: "admin" },
  { userId: 1000002, nickname: "主人", role: "owner" },
  { userId: 1000101, nickname: "小明", role: "member" },
  { userId: 1000102, nickname: "小红", role: "member" },
  { userId: 1000103, nickname: "阿强", role: "member" },
  { userId: 1000104, nickname: "咸鱼君", role: "member" },
];
const DEFAULT_SENDER = ROSTER.find((m) => m.role === "member")!;

interface GroupFixture {
  groupId: number;
  name: string;
  members: Member[];
}
const groups = new Map<number, GroupFixture>(
  GROUP_IDS.map((id, index) => [
    id,
    { groupId: id, name: index === 0 ? "IT Bed 测试群" : `IT Bed 群${id}`, members: ROSTER },
  ]),
);
/** 首次见到的群号自动建档（配置漂移兜底），控制台提示一声。 */
function ensureGroup(groupId: number): GroupFixture {
  let g = groups.get(groupId);
  if (!g) {
    g = { groupId, name: `IT Bed 群${groupId}`, members: ROSTER };
    groups.set(groupId, g);
    console.log(`[faux] 自动建档未知群 ${groupId}（鱼在跟一个名单外的群说话？）`);
  }
  return g;
}
function memberName(userId: number): string | undefined {
  return groups.values().next().value?.members.find((m) => m.userId === userId)?.nickname;
}

// ── 状态：消息登记（get_msg / 回复引用水合）、合集登记、自增 id ─────────────

interface StoredMessage {
  sender: { user_id: number; nickname: string; card?: string };
  message: OneBotSegment[];
}
const msgStore = new Map<string, StoredMessage>();
const fwdStore = new Map<string, { sender: { nickname: string }[] }>(); // id → 节点数组
let messageIdSeq = 10000;
let forwardSeq = 0;
let clientSeq = 0;

function rememberMessage(id: number | string, stored: StoredMessage): void {
  msgStore.set(String(id), stored);
  if (msgStore.size > 1000) {
    const oldest = msgStore.keys().next().value;
    if (oldest !== undefined) msgStore.delete(oldest);
  }
}

// ── 出站落盘（outbound.jsonl 全量 + 控制台一行摘要）────────────────────────

/** OneBot v11 消息段。 */
interface OneBotSegment {
  type: string;
  data?: Record<string, unknown>;
}

mkdirSync(dirname(OUT_PATH), { recursive: true });
function recordOutbound(action: string, params: Record<string, unknown>, echo: unknown, messageId?: number | string): void {
  const entry = { at: new Date().toISOString(), action, params, echo, ...(messageId !== undefined ? { messageId } : {}) };
  appendFileSync(OUT_PATH, `${JSON.stringify(entry)}\n`);
}

/** 段的一行摘要（控制台用；base64 只报长度，文件里仍是完整 params）。 */
function summarizeMessage(message: unknown): string {
  if (typeof message === "string") return JSON.stringify(message.slice(0, 40));
  if (!Array.isArray(message)) return JSON.stringify(message)?.slice(0, 60) ?? "?";
  return message
    .map((seg: OneBotSegment) => {
      const data = seg.data ?? {};
      switch (seg.type) {
        case "text":
          return `「${String(data.text ?? "").slice(0, 40)}」`;
        case "at":
          return `@${data.qq}`;
        case "image": {
          const file = String(data.file ?? "");
          return /^base64:\/\//.test(file) ? `image(base64:${file.length}字符)` : `image(${file || data.url})`;
        }
        case "record":
          return `voice(${String(data.file ?? "").length}字符)`;
        case "reply":
          return `reply(${data.id})`;
        case "forward":
          return `合集(${data.id})`;
        case "json":
          return "卡片json";
        default:
          return seg.type;
      }
    })
    .join(" ");
}

function describeAction(action: string, params: Record<string, unknown>): string {
  const parts: string[] = [];
  if (params.group_id !== undefined) parts.push(`group=${params.group_id}`);
  if (params.user_id !== undefined) parts.push(`user=${params.user_id}`);
  if (params.message_id !== undefined) parts.push(`message_id=${params.message_id}`);
  if (params.message !== undefined) parts.push(`segs=${summarizeMessage(params.message)}`);
  else if (Object.keys(params).length > 0) parts.push(JSON.stringify(params).slice(0, 80));
  return `${action} ${parts.join(" ")}`;
}

// ── 最小 RFC6455 WS 服务端（只覆盖本项目要用的子集）────────────────────────

const WS_GUID = "258EAFA5-E914-47DA-95CA-C5AB0DC85B11";
const MAX_FRAME_BYTES = 64 * 1024 * 1024; // 鱼可能发几 MB 的 base64 图，留足余量

interface WsClient {
  id: number;
  socket: import("node:net").Socket;
  buffer: Buffer;
  fragments: { opcode: number; chunks: Buffer[] } | null;
  alive: boolean;
}

const clients = new Set<WsClient>();

function wsAccept(key: string): string {
  return createHash("sha1").update(key + WS_GUID).digest("base64");
}

/** 服务端出帧：不带掩码（协议要求服务端不掩码），fin=1。 */
function wsEncode(opcode: number, payload: Buffer): Buffer {
  const head: Buffer[] = [];
  const first = 0x80 | opcode;
  if (payload.length < 126) {
    head.push(Buffer.from([first, payload.length]));
  } else if (payload.length < 65536) {
    const h = Buffer.alloc(4);
    h[0] = first;
    h[1] = 126;
    h.writeUInt16BE(payload.length, 2);
    head.push(h);
  } else {
    const h = Buffer.alloc(10);
    h[0] = first;
    h[1] = 127;
    h.writeBigUInt64BE(BigInt(payload.length), 2);
    head.push(h);
  }
  return Buffer.concat([...head, payload]);
}

function wsSend(client: WsClient, text: string): void {
  if (!client.alive) return;
  client.socket.write(wsEncode(0x1, Buffer.from(text, "utf8")));
}

function wsClose(client: WsClient, code = 1000): void {
  if (!client.alive) return;
  client.alive = false;
  const payload = Buffer.alloc(2);
  payload.writeUInt16BE(code);
  try {
    client.socket.write(wsEncode(0x8, payload));
  } catch {}
  client.socket.end();
}

/** 从累计缓冲里解出完整帧；客户端帧必须带掩码，解掩码后交给回调。 */
function wsFeed(client: WsClient, chunk: Buffer, onText: (text: string) => void): void {
  client.buffer = Buffer.concat([client.buffer, chunk]);
  for (;;) {
    const buf = client.buffer;
    if (buf.length < 2) return;
    const fin = (buf[0] & 0x80) !== 0;
    const opcode = buf[0] & 0x0f;
    const masked = (buf[1] & 0x80) !== 0;
    let len = buf[1] & 0x7f;
    let offset = 2;
    if (len === 126) {
      if (buf.length < 4) return;
      len = buf.readUInt16BE(2);
      offset = 4;
    } else if (len === 127) {
      if (buf.length < 10) return;
      const big = buf.readBigUInt64BE(2);
      if (big > BigInt(MAX_FRAME_BYTES)) {
        wsClose(client, 1009);
        return;
      }
      len = Number(big);
      offset = 10;
    }
    const maskKey = masked ? 4 : 0;
    if (buf.length < offset + maskKey + len) return;
    const payload = Buffer.from(buf.subarray(offset + maskKey, offset + maskKey + len));
    if (masked) {
      const key = buf.subarray(offset, offset + 4);
      for (const [i] of payload.entries()) payload[i] ^= key[i % 4];
    }
    client.buffer = buf.subarray(offset + maskKey + len);

    if (opcode === 0x8) {
      wsClose(client);
      return;
    }
    if (opcode === 0x9) {
      // ping → 原样回 pong
      if (client.alive) client.socket.write(wsEncode(0xa, payload));
      continue;
    }
    if (opcode === 0xa) continue; // pong：忽略

    if (opcode === 0x1 || opcode === 0x2 || opcode === 0x0) {
      if (opcode !== 0x0) {
        if (fin) {
          if (opcode === 0x1) onText(payload.toString("utf8"));
          continue;
        }
        client.fragments = { opcode, chunks: [payload] };
      } else if (client.fragments) {
        client.fragments.chunks.push(payload);
        if (fin) {
          const whole = Buffer.concat(client.fragments.chunks);
          const kind = client.fragments.opcode;
          client.fragments = null;
          if (kind === 0x1) onText(whole.toString("utf8"));
        }
      }
      continue;
    }
    // 未知 opcode：按协议回 1002
    wsClose(client, 1002);
    return;
  }
}

function broadcast(text: string): void {
  for (const client of clients) wsSend(client, text);
}

// ── 动作应答（echo 回带；retcode 0 = 成功）─────────────────────────────────

interface FauxError extends Error {
  retcode?: number;
}
function fail(retcode: number, message: string): FauxError {
  const error = new Error(message) as FauxError;
  error.retcode = retcode;
  return error;
}

function nextMessageId(): number {
  return ++messageIdSeq;
}

function respond(client: WsClient, echo: unknown, data: unknown): void {
  wsSend(client, JSON.stringify({ status: "ok", retcode: 0, data, echo }));
}
function respondFail(client: WsClient, echo: unknown, retcode: number, message: string): void {
  wsSend(client, JSON.stringify({ status: "failed", retcode, message, echo }));
}

/** 鱼发来的消息段数组登记进 get_msg（sender = 鱼），回复引用它时可水合。 */
function rememberOutgoingMessage(params: Record<string, unknown>, id: number | string): void {
  const message = params.message;
  rememberMessage(id, {
    sender: { user_id: SELF_ID, nickname: "鱼", card: "鱼" },
    message: Array.isArray(message) ? (message as OneBotSegment[]) : [{ type: "text", data: { text: String(message ?? "") } }],
  });
}

function handleAction(client: WsClient, frame: { action?: string; params?: Record<string, unknown>; echo?: unknown }): void {
  const action = String(frame.action ?? "");
  const params = (frame.params ?? {}) as Record<string, unknown>;
  const echo = frame.echo;
  try {
    const data = dispatchAction(action, params, echo);
    respond(client, echo, data);
    console.log(`  ↳ [out] ${describeAction(action, params)}`);
  } catch (error) {
    const e = error as FauxError;
    respondFail(client, echo, e.retcode ?? 1200, e.message);
    console.log(`  ↳ [out] ${action} 失败 retcode=${e.retcode ?? 1200}：${e.message}`);
  }
}

function dispatchAction(action: string, params: Record<string, unknown>, echo: unknown): unknown {
  switch (action) {
    case "send_group_msg": {
      const id = nextMessageId();
      recordOutbound(action, params, echo, id);
      rememberOutgoingMessage(params, id);
      return { message_id: id };
    }
    case "send_private_msg": {
      const id = nextMessageId();
      recordOutbound(action, params, echo, id);
      rememberOutgoingMessage(params, id);
      return { message_id: id };
    }
    case "set_msg_emoji_like":
      return {};
    case "get_login_info":
      return { user_id: SELF_ID, nickname: "鱼" };
    case "get_version_info":
      return { app_name: "faux-napcat", version: "0.1.0", protocol: "OneBot v11" };
    case "get_group_list":
      return [...groups.values()].map((g) => ({ group_id: g.groupId, group_name: g.name }));
    case "get_group_info": {
      const g = groups.get(Number(params.group_id));
      if (!g) throw fail(1404, `群 ${params.group_id} 不在名单里`);
      return { group_id: g.groupId, group_name: g.name, member_count: g.members.length, owner_id: g.members.find((m) => m.role === "owner")?.userId ?? 0 };
    }
    case "get_group_member_list": {
      const g = groups.get(Number(params.group_id));
      if (!g) throw fail(1404, `群 ${params.group_id} 不在名单里`);
      return g.members.map((m) => ({ user_id: m.userId, nickname: m.nickname, card: m.nickname, role: m.role }));
    }
    case "get_group_member_info": {
      const g = groups.get(Number(params.group_id));
      const m = g?.members.find((x) => x.userId === Number(params.user_id));
      if (!m) throw fail(1404, `群 ${params.group_id} 里没有 ${params.user_id}`);
      return { user_id: m.userId, nickname: m.nickname, card: m.nickname, role: m.role, level: "1" };
    }
    case "get_msg": {
      const stored = msgStore.get(String(params.message_id));
      if (!stored) throw fail(1404, `消息 ${params.message_id} 不存在`);
      return { message_id: params.message_id, ...stored };
    }
    case "get_forward_msg": {
      const nodes = fwdStore.get(String(params.message_id));
      if (!nodes) throw fail(1404, `合集 ${params.message_id} 不存在`);
      return { messages: nodes };
    }
    default:
      throw fail(1404, `faux 未实现的动作：${action}`);
  }
}

// ── 注入事件构造（POST /inject 的快捷字段 → OneBot 事件帧）──────────────────

function assetUrl(name: string): string {
  return `http://127.0.0.1:${PORT}/assets/${encodeURIComponent(name)}`;
}

interface InjectBody {
  kind?: string;
  groupId?: number;
  userId?: number;
  nickname?: string;
  messageId?: number | string;
  text?: string;
  at?: (string | number)[];
  quote?: number | string;
  image?: string;
  gif?: boolean;
  card?: { title?: string; desc?: string; url?: string };
  forward?: ({ name?: string; text?: string; image?: string; gif?: boolean; segments?: OneBotSegment[] } | OneBotSegment[])[];
  replyForward?: string;
  segments?: OneBotSegment[];
  raw?: Record<string, unknown>;
}

/** 注册一个合集：节点登记进 get_forward_msg，合集 id 也登记进 get_msg（回复引用可水合）。 */
function registerForward(ownerName: string, nodes: InjectBody["forward"]): { id: string; segment: OneBotSegment } {
  const id = `FWD-${++forwardSeq}`;
  const list = (nodes ?? []).map((node) => {
    const name = Array.isArray(node) ? "群友" : node.name ?? "群友";
    const content: OneBotSegment[] = Array.isArray(node)
      ? node
      : node.segments ?? [
          ...(node.gif ? [{ type: "image", data: { file: "test.gif", url: assetUrl("test.gif") } }] : []),
          ...(node.image ? [{ type: "image", data: { file: node.image, url: assetUrl(node.image) } }] : []),
          ...(node.text ? [{ type: "text", data: { text: node.text } }] : []),
        ];
    return { sender: { nickname: name }, content };
  });
  fwdStore.set(id, list);
  rememberMessage(id, {
    sender: { user_id: DEFAULT_SENDER.userId, nickname: ownerName, card: ownerName },
    message: [{ type: "forward", data: { id } }],
  });
  return { id, segment: { type: "forward", data: { id } } };
}

/** 快捷字段 → 段数组；顺序 reply → at → image/gif → card → forward → text。 */
function buildSegments(body: InjectBody): { segments: OneBotSegment[]; forwardId?: string } {
  const segments: OneBotSegment[] = [];
  if (body.segments !== undefined) return { segments: body.segments };
  if (body.quote !== undefined) segments.push({ type: "reply", data: { id: String(body.quote) } });
  if (body.replyForward !== undefined) segments.push({ type: "reply", data: { id: String(body.replyForward) } });
  for (const target of body.at ?? []) {
    const qq = target === "bot" ? String(SELF_ID) : String(target);
    segments.push({ type: "at", data: { qq, ...(qq !== "all" ? { name: memberName(Number(qq)) ?? qq } : {}) } });
  }
  if (body.gif) segments.push({ type: "image", data: { file: "test.gif", url: assetUrl("test.gif") } });
  if (body.image) segments.push({ type: "image", data: { file: body.image, url: assetUrl(body.image) } });
  if (body.card) {
    segments.push({
      type: "json",
      data: {
        data: JSON.stringify({
          app: "com.tencent.miniapp_01",
          desc: String(body.card.desc ?? body.card.title ?? ""),
          meta: { detail_1: { title: body.card.title ?? "", desc: body.card.desc ?? "", qqdocurl: body.card.url ?? "" } },
          prompt: `[QQ小程序]${body.card.title ?? ""}`,
        }),
      },
    });
  }
  let forwardId: string | undefined;
  if (body.forward) {
    const { id, segment } = registerForward(memberName(Number(body.userId ?? DEFAULT_SENDER.userId)) ?? "群友", body.forward);
    forwardId = id;
    segments.push(segment);
  }
  if (body.text) segments.push({ type: "text", data: { text: body.text } });
  return { segments, forwardId };
}

/** 注入构造事件帧；同时登记进 get_msg。返回 null = 参数不合法。 */
function buildEvent(body: InjectBody): { event: Record<string, unknown>; messageId: number | string } | null {
  const now = Math.floor(Date.now() / 1000);
  const kind = body.kind ?? "group";

  if (body.raw) {
    const raw = { self_id: SELF_ID, time: now, ...body.raw };
    if (raw.post_type === "message" && raw.message_id !== undefined) {
      rememberMessage(raw.message_id, {
        sender: (raw.sender as StoredMessage["sender"]) ?? { user_id: Number(raw.user_id ?? 0), nickname: String(raw.nickname ?? "群友") },
        message: raw.message as OneBotSegment[],
      });
    }
    return { event: raw, messageId: (raw.message_id as number | string) ?? -1 };
  }

  if (kind === "recall") {
    const groupId = Number(body.groupId ?? groups.keys().next().value);
    ensureGroup(groupId);
    const messageId = body.messageId ?? nextMessageId();
    return {
      messageId,
      event: {
        post_type: "notice",
        notice_type: "group_recall",
        self_id: SELF_ID,
        time: now,
        group_id: groupId,
        user_id: Number(body.userId ?? DEFAULT_SENDER.userId),
        operator_id: Number(body.userId ?? DEFAULT_SENDER.userId),
        message_id: messageId,
      },
    };
  }

  const userId = Number(body.userId ?? DEFAULT_SENDER.userId);
  const nickname = body.nickname ?? memberName(userId) ?? `群友${userId}`;
  const messageId = body.messageId ?? nextMessageId();
  const { segments } = buildSegments(body);
  if (segments.length === 0) return null;
  const rawMessage = segments
    .map((seg) => (seg.type === "text" ? String(seg.data?.text ?? "") : seg.type === "at" ? `@${seg.data?.qq}` : `[${seg.type}]`))
    .join("");
  const sender = { user_id: userId, nickname, card: nickname, role: "member" };
  const event: Record<string, unknown> = {
    post_type: "message",
    self_id: SELF_ID,
    time: now,
    user_id: userId,
    message_id: messageId,
    message: segments,
    raw_message: rawMessage,
    sender,
  };
  if (kind === "private") {
    event.message_type = "private";
  } else {
    const groupId = Number(body.groupId ?? groups.keys().next().value);
    ensureGroup(groupId);
    event.message_type = "group";
    event.group_id = groupId;
  }
  rememberMessage(messageId, { sender, message: segments });
  return { event, messageId };
}

// ── HTTP：/inject、/assets/*、/health、/ 用法页；upgrade → WS ────────────────

const USAGE = `faux NapCat（OneBot v11 反向 WS 替身）
  WS     ws://127.0.0.1:${PORT}/${TOKEN ? "（需 ?access_token=）" : ""}
  注入   POST /inject  {"kind":"group","at":["bot"],"text":"你好"}
  静态图 GET  /assets/test.jpg | /assets/test.gif
  探活   GET  /health
`;

function sendJson(res: ServerResponse, status: number, body: unknown): void {
  const payload = JSON.stringify(body);
  res.writeHead(status, { "Content-Type": "application/json; charset=utf-8", "Content-Length": Buffer.byteLength(payload) });
  res.end(payload);
}

const MIME: Record<string, string> = { ".gif": "image/gif", ".jpg": "image/jpeg", ".jpeg": "image/jpeg", ".png": "image/png", ".webp": "image/webp" };

function serveAsset(name: string, res: ServerResponse): boolean {
  if (!/^[A-Za-z0-9._-]+$/.test(name) || name.startsWith(".")) return false;
  const path = join(ASSETS_DIR, name);
  if (!path.startsWith(ASSETS_DIR) || !existsSync(path) || !statSync(path).isFile()) return false;
  res.writeHead(200, { "Content-Type": MIME[name.slice(name.lastIndexOf("."))] ?? "application/octet-stream" });
  res.end(readFileSync(path));
  return true;
}

function readBody(req: IncomingMessage): Promise<string> {
  return new Promise((resolveBody, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    req.on("data", (chunk: Buffer) => {
      size += chunk.length;
      if (size > 5 * 1024 * 1024) {
        reject(new Error("body 过大"));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on("end", () => resolveBody(Buffer.concat(chunks).toString("utf8")));
    req.on("error", reject);
  });
}

const server: Server = createServer((req, res) => {
  const url = new URL(req.url ?? "/", `http://127.0.0.1:${PORT}`);
  if (url.pathname === "/health") {
    sendJson(res, 200, { ok: true, clients: clients.size, groups: [...groups.keys()], assets: ASSETS_DIR, outbound: OUT_PATH, uptimeMs: Math.round(process.uptime() * 1000) });
    return;
  }
  if (url.pathname === "/inject" && req.method === "POST") {
    void readBody(req)
      .then((text) => {
        let body: InjectBody;
        try {
          body = JSON.parse(text) as InjectBody;
        } catch {
          sendJson(res, 400, { ok: false, error: "JSON 解析失败" });
          return;
        }
        if (body.kind === "recall" || body.raw) {
          const built = buildEvent(body)!;
          broadcast(JSON.stringify(built.event));
          console.log(`  ↳ [inject] ${body.kind === "recall" ? "撤回" : "raw 透传"} → ${JSON.stringify(built.event).slice(0, 100)}…`);
          sendJson(res, 200, { ok: true, messageId: built.messageId, event: built.event });
          return;
        }
        const built = buildEvent(body);
        if (!built) {
          sendJson(res, 400, { ok: false, error: "构造不出消息：给 text / segments / 快捷字段至少其一" });
          return;
        }
        broadcast(JSON.stringify(built.event));
        const at = (body.at ?? []).join(",");
        console.log(`  ↳ [inject] ${body.kind ?? "group"} ${body.groupId ?? groups.keys().next().value} from ${body.nickname ?? memberName(Number(body.userId ?? DEFAULT_SENDER.userId)) ?? body.userId}${at ? ` @[${at}]` : ""} segs=${summarizeMessage(built.event.message)} → id=${built.messageId}`);
        sendJson(res, 200, { ok: true, messageId: built.messageId, event: built.event });
      })
      .catch((error: unknown) => sendJson(res, 500, { ok: false, error: error instanceof Error ? error.message : String(error) }));
    return;
  }
  if (url.pathname.startsWith("/assets/")) {
    if (serveAsset(decodeURIComponent(url.pathname.slice("/assets/".length)), res)) return;
    sendJson(res, 404, { ok: false, error: `资产不存在；目录 ${ASSETS_DIR}` });
    return;
  }
  if (url.pathname === "/") {
    res.writeHead(200, { "Content-Type": "text/plain; charset=utf-8" });
    res.end(USAGE);
    return;
  }
  sendJson(res, 404, { ok: false, error: "未知路径" });
});

/** WS 握手：校验 access_token（配置了才校验），101 升级后进帧循环。 */
server.on("upgrade", (req: IncomingMessage, socket, head) => {
  const url = new URL(req.url ?? "/", `http://127.0.0.1:${PORT}`);
  if (TOKEN && url.searchParams.get("access_token") !== TOKEN) {
    socket.write("HTTP/1.1 401 Unauthorized\r\n\r\n");
    socket.destroy();
    return;
  }
  const key = req.headers["sec-websocket-key"];
  if (!key) {
    socket.destroy();
    return;
  }
  socket.write(
    "HTTP/1.1 101 Switching Protocols\r\n" +
      "Upgrade: websocket\r\n" +
      "Connection: Upgrade\r\n" +
      `Sec-WebSocket-Accept: ${wsAccept(key)}\r\n` +
      "\r\n",
  );
  const client: WsClient = { id: ++clientSeq, socket, buffer: Buffer.from(head), fragments: null, alive: true };
  clients.add(client);
  console.log(`[faux] fish #${client.id} 已连入（${clients.size} 个客户端在线）`);

  // 连上立即推 lifecycle + 首跳：鱼靠 meta_event 的 self_id 认自己（@鱼 判定依赖）
  wsSend(
    client,
    JSON.stringify({ post_type: "meta_event", meta_event_type: "lifecycle", sub_type: "connect", self_id: SELF_ID, time: Math.floor(Date.now() / 1000) }),
  );
  wsSend(client, JSON.stringify({ post_type: "meta_event", meta_event_type: "heartbeat", self_id: SELF_ID, time: Math.floor(Date.now() / 1000), interval: HEARTBEAT_MS, status: {} }));

  socket.on("data", (chunk: Buffer) => wsFeed(client, chunk, (text) => {
    try {
      const frame = JSON.parse(text) as { action?: string; params?: Record<string, unknown>; echo?: unknown };
      if (frame.action) handleAction(client, frame);
    } catch {
      return; // 非 JSON 帧直接忽略
    }
  }));
  socket.on("close", () => {
    clients.delete(client);
    console.log(`[faux] fish #${client.id} 已断开（剩 ${clients.size} 个）`);
  });
  socket.on("error", () => {
    clients.delete(client);
  });
});

// ── 心跳与退出 ─────────────────────────────────────────────────────────────

const heartbeat = setInterval(() => {
  if (clients.size === 0) return;
  broadcast(JSON.stringify({ post_type: "meta_event", meta_event_type: "heartbeat", self_id: SELF_ID, time: Math.floor(Date.now() / 1000), interval: HEARTBEAT_MS, status: {} }));
}, HEARTBEAT_MS);
heartbeat.unref();

function shutdown(signal: string): void {
  console.log(`[faux] 收到 ${signal}，关闭`);
  for (const client of clients) wsClose(client);
  server.close(() => process.exit(0));
  setTimeout(() => process.exit(0), 1000).unref();
}
process.on("SIGINT", () => shutdown("SIGINT"));
process.on("SIGTERM", () => shutdown("SIGTERM"));

server.listen(PORT, "127.0.0.1", () => {
  console.log(`[faux] NapCat 替身就绪 ws://127.0.0.1:${PORT}/ （self_id=${SELF_ID}，群：${[...groups.keys()].join("、")}）`);
  console.log(`[faux] 出站落盘 ${OUT_PATH}；静态图 ${ASSETS_DIR}（/assets/<文件名>）`);
  console.log(`[faux] 注入示例：curl -s localhost:${PORT}/inject -d '{"kind":"group","at":["bot"],"text":"鱼鱼在吗"}'`);
});
