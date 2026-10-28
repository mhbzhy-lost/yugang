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
    const ws = new WebSocket(
      this.#url,
      this.#token ? ({ headers: { Authorization: `Bearer ${this.#token}` } } as never) : undefined,
    );
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
    const source = String(data["file"] ?? data["url"] ?? "");
    if (!source) return null;
    try {
      const { mkdirSync, writeFileSync } = await import("node:fs");
      const { join } = await import("node:path");
      const dir = join(mediaRoot, "inbound");
      mkdirSync(dir, { recursive: true });

      let bytes: Uint8Array;
      if (/^https?:\/\//.test(source)) {
        const res = await fetch(source);
        if (!res.ok) return null;
        bytes = new Uint8Array(await res.arrayBuffer());
      } else {
        const { readFile } = await import("node:fs/promises");
        bytes = new Uint8Array(await readFile(source));
      }

      const name = `${Date.now()}-${Math.random().toString(16).slice(2, 8)}.png`;
      writeFileSync(join(dir, name), bytes);
      return { ref: `inbound/${name}` };
    } catch {
      return null;
    }
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms).unref?.());
}

export function parseEvent(frame: OneBotEvent, selfId: number): IncomingMessage | null {
  const userId = frame.user_id ?? 0;
  if (!userId) return null;

  let text = "";
  let mentionsBot = false;
  const images: IncomingImage[] = [];
  const segments: OneBotSegment[] = [];
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
        text += " [回复某条消息] ";
      }
    }
  }
  text = text.replace(/\s+/g, " ").trim();
  if (!text) return null;

  const nickname = frame.sender?.card || frame.sender?.nickname || String(userId);
  const base = { userId, nickname, text, mentionsBot, messageId: frame.message_id, images, imageSegments: segments };

  if (frame.message_type === "group" && frame.group_id) {
    return { ...base, chatKey: `qq:group:${frame.group_id}`, groupId: frame.group_id };
  }
  if (frame.message_type === "private") {
    return { ...base, chatKey: `qq:private:${userId}`, mentionsBot: true };
  }
  return null;
}
