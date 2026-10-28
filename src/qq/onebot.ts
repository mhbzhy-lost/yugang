/**
 * 极简 OneBot v11 客户端（零依赖，用 Node 内置 WebSocket）。
 * 只做这个项目需要的事：收消息、发消息（可拆条、可引用）、贴表情、查群档案、下载图片。
 */

export interface OneBotSegment {
  type: string;
  data?: Record<string, unknown>;
}

export interface OneBotEvent {
  post_type?: string;
  message_type?: "group" | "private";
  self_id?: number;
  user_id?: number;
  group_id?: number;
  message_id?: number | string;
  raw_message?: string;
  message?: string | OneBotSegment[];
  sender?: { nickname?: string; card?: string; role?: string };
}

export interface IncomingImage {
  /** 相对 mediaRoot 的引用，进站文本里用 [图片 inbound/xxx.png] 标注。 */
  ref: string;
}

export type IncomingMessage = {
  chatKey: string; // qq:group:<id> | qq:private:<id>
  groupId?: number;
  userId: number;
  nickname: string;
  text: string;
  mentionsBot: boolean;
  messageId?: number | string;
  /** 已落盘的图片引用；进站文本里也会带 [图片 inbound/xxx.png]。 */
  images: IncomingImage[];
  /** 收消息时临时用来下载的原始段，处理完就清空。 */
  imageSegments: OneBotSegment[];
  /** reply 段引用的消息 id；宿主取回被引消息里的图后替换占位符。 */
  replyIds: string[];
};

export interface SendOptions {
  quote?: number | string;
  /** 每条之间的抖动延迟，由宿主决定，模型管不着。 */
  delayMs?: () => number;
}

interface Pending {
  resolve: (value: unknown) => void;
  reject: (error: Error) => void;
}

export class OneBot {
  #url: string;
  #token?: string;
  #ws?: WebSocket;
  #seq = 0;
  #pending = new Map<string, Pending>();
  #handlers: ((msg: IncomingMessage) => void)[] = [];
  #selfId = 0;

  #mediaRoot?: string;

  constructor(url: string, token?: string, mediaRoot?: string) {
    this.#url = url;
    this.#token = token;
    this.#mediaRoot = mediaRoot;
  }

  get selfId(): number {
    return this.#selfId;
  }

  onMessage(handler: (msg: IncomingMessage) => void): void {
    this.#handlers.push(handler);
  }

  async connect(): Promise<void> {
    const ws = new WebSocket(this.#token ? withAccessToken(this.#url, this.#token) : this.#url);
    this.#ws = ws;
    await new Promise<void>((resolve, reject) => {
      ws.addEventListener("open", () => resolve(), { once: true });
      ws.addEventListener("error", () => reject(new Error("连不上 OneBot WebSocket")), { once: true });
    });
    ws.addEventListener("message", (event) => void this.#onFrame(event.data));
    ws.addEventListener("close", () => {
      for (const [, p] of this.#pending) p.reject(new Error("连接已断开"));
      this.#pending.clear();
    });
  }

  async #onFrame(raw: unknown): Promise<void> {
    let data: unknown;
    try {
      data = JSON.parse(String(raw));
    } catch {
      return;
    }
    const frame = data as { echo?: string; retcode?: number } & OneBotEvent;
    if (frame.echo && this.#pending.has(frame.echo)) {
      const p = this.#pending.get(frame.echo)!;
      this.#pending.delete(frame.echo);
      if (frame.retcode && frame.retcode !== 0) p.reject(new Error(`OneBot 返回 ${frame.retcode}`));
      else p.resolve(data);
      return;
    }
    if (frame.post_type === "meta_event") {
      if (frame.self_id) this.#selfId = frame.self_id;
      return;
    }
    if (frame.post_type !== "message") return;
    const parsed = parseEvent(frame, this.#selfId);
    if (!parsed) return;

    // 图片落盘，把占位替换成真实引用
    if (parsed.imageSegments.length > 0 && this.#mediaRoot) {
      for (const [index, segment] of parsed.imageSegments.entries()) {
        const saved = await this.downloadImage(segment, this.#mediaRoot);
        const shown = saved ? `[图片 ${saved.ref}]` : "[图片 读不到]";
        parsed.text = parsed.text.replace(`[图片#${index}]`, shown);
      }
    }
    parsed.imageSegments = [];

    // 回复引用：取回被引消息，里面的图落盘后替换占位符，否则看不见被讨论的图
    for (const [index, replyId] of (parsed.replyIds ?? []).entries()) {
      if (!replyId || !this.#mediaRoot) continue;
      let shown = "[回复的图 读不到]";
      try {
        const quoted = await this.call("get_msg", { message_id: replyId });
        const quotedMessage = quoted?.data?.message ?? quoted?.message;
        const imageSegs = Array.isArray(quotedMessage)
          ? quotedMessage.filter((s: OneBotSegment) => s?.type === "image").slice(0, 2)
          : [];
        const savedList: string[] = [];
        for (const seg of imageSegs) {
          const saved = await this.downloadImage(seg, this.#mediaRoot);
          if (saved) savedList.push(saved.ref);
        }
        if (savedList.length > 0) shown = savedList.map((r) => `[回复的图 ${r}]`).join(" ");
        else if (imageSegs.length === 0) shown = "[回复的消息没有图]";
      } catch {
        // 保留默认占位符
      }
      parsed.text = parsed.text.replace(`[回复某条消息#${index}]`, shown);
    }
    parsed.replyIds = [];

    if (!parsed.text.trim()) return;
    for (const h of this.#handlers) h(parsed);
  }

  async call(action: string, params: Record<string, unknown> = {}): Promise<any> {
    const ws = this.#ws;
    if (!ws || ws.readyState !== 1) throw new Error("OneBot 未连接");
    const echo = `yg${++this.#seq}`;
    return new Promise((resolve, reject) => {
      this.#pending.set(echo, { resolve, reject });
      ws.send(JSON.stringify({ action, params, echo }));
      setTimeout(() => {
        if (this.#pending.delete(echo)) reject(new Error(`${action} 超时`));
      }, 20_000).unref?.();
    });
  }

  /** 按顺序发几条文本，中间加抖动；第一句可以引用触发消息。 */
  async sendGroup(groupId: number, texts: readonly string[], options: SendOptions = {}): Promise<void> {
    const delay = options.delayMs ?? (() => 700 + Math.floor(Math.random() * 1200));
    for (const [index, text] of texts.entries()) {
      const segments: OneBotSegment[] = [];
      if (options.quote !== undefined && index === 0) {
        segments.push({ type: "reply", data: { id: String(options.quote) } });
      }
      segments.push({ type: "text", data: { text } });
      await this.call("send_group_msg", { group_id: groupId, message: segments });
      if (index < texts.length - 1) await sleep(delay());
    }
  }

  async sendPrivate(userId: number, texts: readonly string[]): Promise<void> {
    for (const text of texts) {
      await this.call("send_private_msg", { user_id: userId, message: text });
    }
  }

  async sendImageGroup(groupId: number, filePath: string): Promise<void> {
    await this.call("send_group_msg", {
      group_id: groupId,
      message: [{ type: "image", data: { file: `file://${filePath}` } }],
    });
  }

  /** 贴表情回应（NapCat 扩展）。 */
  async react(messageId: number | string, emoji: string): Promise<void> {
    await this.call("set_msg_emoji_like", { message_id: messageId, emoji_id: emoji, set: true });
  }

  async groupInfo(groupId: number): Promise<{ name: string; count: number; owner: string } | null> {
    try {
      const res = await this.call("get_group_info", { group_id: groupId, no_cache: true });
      const data = res?.data ?? {};
      return {
        name: String(data.group_name ?? `群${groupId}`),
        count: Number(data.member_count ?? 0),
        owner: String(data.owner_id ?? "?"),
      };
    } catch {
      return null;
    }
  }

  async groupMembers(groupId: number, limit = 30): Promise<{ nickname: string; userId: string }[]> {
    try {
      const res = await this.call("get_group_member_list", { group_id: groupId });
      const list = (res?.data ?? []) as { nickname?: string; card?: string; user_id?: number }[];
      return list.slice(0, limit).map((m) => ({
        nickname: String(m.card || m.nickname || m.user_id),
        userId: String(m.user_id),
      }));
    } catch {
      return [];
    }
  }

  /** 把图片落盘到 mediaRoot/inbound，返回相对引用。 */
  async downloadImage(segment: OneBotSegment, mediaRoot: string): Promise<IncomingImage | null> {
    const data = segment.data ?? {};
    // 直链优先：NapCat 的 file 字段常是内部名（xxx.image）而不是可读路径；
    // 只有剥掉 file:// 后确实是存在的本地路径才走本地读。
    const url = String(data["url"] ?? "");
    let source = /^https?:\/\//.test(url) ? url : "";
    let localPath = "";
    if (!source) {
      const { existsSync } = await import("node:fs");
      const raw = String(data["file"] ?? "");
      const p = raw.startsWith("file://") ? raw.slice("file://".length) : raw;
      if (p.startsWith("/") && existsSync(p)) localPath = p;
    }
    if (!source && !localPath) return null;
    try {
      const { mkdirSync, writeFileSync, existsSync, unlinkSync } = await import("node:fs");
      const { join } = await import("node:path");
      const dir = join(mediaRoot, "inbound");
      mkdirSync(dir, { recursive: true });

      let bytes: Uint8Array;
      if (source) {
        const res = await fetch(source);
        if (!res.ok) return null;
        bytes = new Uint8Array(await res.arrayBuffer());
      } else {
        const { readFile } = await import("node:fs/promises");
        bytes = new Uint8Array(await readFile(localPath));
      }

      // 按魔数认真实格式，按真实扩展名落盘；伪装扩展名会让 look 按 MIME 表发错标数据。
      const kind = sniffImage(bytes);
      if (!kind) return null;
      const stem = `${Date.now()}-${Math.random().toString(16).slice(2, 8)}`;

      if (kind.convert) {
        // HEIC/HEIF/BMP/TIFF：模型不认，用 macOS 自带 sips 归一化成 JPEG。
        const raw = join(dir, `${stem}.${kind.ext}`);
        const jpg = join(dir, `${stem}.jpg`);
        writeFileSync(raw, bytes);
        const { spawnSync } = await import("node:child_process");
        const sips = spawnSync("sips", ["-s", "format", "jpeg", raw, "--out", jpg], { timeout: 20000 });
        unlinkSync(raw);
        if (sips.status !== 0 || !existsSync(jpg)) return null;
        return { ref: `inbound/${stem}.jpg` };
      }

      const name = `${stem}.${kind.ext}`;
      writeFileSync(join(dir, name), bytes);
      return { ref: `inbound/${name}` };
    } catch {
      return null;
    }
  }
}

// 魔数嗅探：返回真实扩展名；convert 标记需要 sips 归一化为 JPEG 的格式。
// png/jpg/gif/webp 模型直收（已实测），其余一律转 JPEG。
function sniffImage(b: Uint8Array): { ext: string; convert?: "jpeg" } | null {
  const at = (off: number, ascii: string) =>
    ascii.length <= b.length - off &&
    [...ascii].every((ch, i) => b[off + i] === ch.charCodeAt(0));
  if (at(0, "\x89PNG")) return { ext: "png" };
  if (b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff) return { ext: "jpg" };
  if (at(0, "GIF8")) return { ext: "gif" };
  if (at(0, "RIFF") && at(8, "WEBP")) return { ext: "webp" };
  if (at(0, "BM")) return { ext: "bmp", convert: "jpeg" };
  if (at(0, "II\x2a\x00") || at(0, "MM\x00\x2a")) return { ext: "tiff", convert: "jpeg" };
  if (at(4, "ftyp")) {
    const brand = String.fromCharCode(...b.slice(8, 12)).toLowerCase();
    if (["heic", "heix", "hevc", "heif", "mif1", "msf1"].includes(brand)) return { ext: "heic", convert: "jpeg" };
  }
  return null;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms).unref?.());
}

/** 把 token 追加成 WS URL 的 ?access_token= 查询参数。Node 原生 WebSocket 会静默丢弃自定义 headers，鉴权只能走 query。 */
export function withAccessToken(url: string, token: string): string {
  const sep = url.includes("?") ? "&" : "?";
  return `${url}${sep}access_token=${encodeURIComponent(token)}`;
}

export function parseEvent(frame: OneBotEvent, selfId: number): IncomingMessage | null {
  const userId = frame.user_id ?? 0;
  if (!userId) return null;

  let text = "";
  let mentionsBot = false;
  const images: IncomingImage[] = [];
  const segments: OneBotSegment[] = [];
  const replyIds: string[] = [];
  const message = frame.message;

  if (typeof message === "string") {
    text = message;
  } else if (Array.isArray(message)) {
    for (const seg of message) {
      if (seg.type === "text") text += String(seg.data?.["text"] ?? "");
      else if (seg.type === "at") {
        if (String(seg.data?.["qq"] ?? "") === String(selfId)) mentionsBot = true;
      } else if (seg.type === "image") {
        text += ` [图片#${images.length}] `;
        segments.push(seg);
        images.push({ ref: "" });
      } else if (seg.type === "reply") {
        text += ` [回复某条消息#${replyIds.length}] `;
        replyIds.push(String(seg.data?.["id"] ?? ""));
      }
    }
  }
  text = text.replace(/\s+/g, " ").trim();
  // 裸 @（只 @ 不带字）不丢弃：以最小占位文本继续走闸和链路，
  // 否则 chatlog 无痕，用户观感是鱼不理人。非 @ 的空文本维持丢弃。
  if (!text && mentionsBot) text = "（被 @ 了一下，没说话）";
  if (!text) return null;

  const nickname = frame.sender?.card || frame.sender?.nickname || String(userId);
  const base = { userId, nickname, text, mentionsBot, messageId: frame.message_id, images, imageSegments: segments, replyIds };

  if (frame.message_type === "group" && frame.group_id) {
    return { ...base, chatKey: `qq:group:${frame.group_id}`, groupId: frame.group_id };
  }
  if (frame.message_type === "private") {
    return { ...base, chatKey: `qq:private:${userId}`, mentionsBot: true };
  }
  return null;
}
