/**
 * 极简 OneBot v11 客户端（零依赖，用 Node 内置 WebSocket）。
 * 只做这个项目需要的事：收群/私聊消息、发群消息、标记已发送。
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
  sender?: { nickname?: string; card?: string };
}

export type IncomingMessage = {
  chatKey: string; // qq:group:<id> | qq:private:<id>
  groupId?: number;
  userId: number;
  nickname: string;
  text: string;
  mentionsBot: boolean;
  messageId?: number | string;
};

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

  constructor(url: string, token?: string) {
    this.#url = url;
    this.#token = token;
  }

  get selfId(): number {
    return this.#selfId;
  }

  onMessage(handler: (msg: IncomingMessage) => void): void {
    this.#handlers.push(handler);
  }

  async connect(): Promise<void> {
    const ws = new WebSocket(this.#url, this.#token ? { headers: { Authorization: `Bearer ${this.#token}` } } as never : undefined);
    this.#ws = ws;
    await new Promise<void>((resolve, reject) => {
      ws.addEventListener("open", () => resolve(), { once: true });
      ws.addEventListener("error", () => reject(new Error("连不上 OneBot WebSocket")), { once: true });
    });
    ws.addEventListener("message", (event) => this.#onFrame(event.data));
    ws.addEventListener("close", () => {
      for (const [, p] of this.#pending) p.reject(new Error("连接已断开"));
      this.#pending.clear();
    });
  }

  #onFrame(raw: unknown): void {
    let data: unknown;
    try {
      data = typeof raw === "string" ? JSON.parse(raw) : JSON.parse(String(raw));
    } catch {
      return;
    }
    const frame = data as { echo?: string; retcode?: number; status?: string } & OneBotEvent;
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
    if (parsed) for (const h of this.#handlers) h(parsed);
  }

  async #call(action: string, params: Record<string, unknown>): Promise<unknown> {
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

  /** 发群消息。文本原样发出，不让协议端做 CQ 码解析。 */
  async sendGroup(groupId: number, text: string, media?: string): Promise<void> {
    const segments: OneBotSegment[] = [];
    if (media) segments.push({ type: "image", data: { file: `file://${media}` } });
    segments.push({ type: "text", data: { text } });
    await this.#call("send_group_msg", { group_id: groupId, message: segments, auto_escape: true });
  }

  async sendPrivate(userId: number, text: string): Promise<void> {
    await this.#call("send_private_msg", { user_id: userId, message: text, auto_escape: true });
  }
}

export function parseEvent(frame: OneBotEvent, selfId: number): IncomingMessage | null {
  const userId = frame.user_id ?? 0;
  if (!userId) return null;

  let text = "";
  let mentionsBot = false;
  const message = frame.message;
  if (typeof message === "string") {
    text = message;
  } else if (Array.isArray(message)) {
    for (const seg of message) {
      if (seg.type === "text") text += String(seg.data?.["text"] ?? "");
      else if (seg.type === "at") {
        if (String(seg.data?.["qq"] ?? "") === String(selfId)) mentionsBot = true;
      } else if (seg.type === "image") text += "[图片]";
    }
  }
  text = text.trim();
  if (!text) return null;

  const nickname = frame.sender?.card || frame.sender?.nickname || String(userId);
  if (frame.message_type === "group") {
    if (!frame.group_id) return null;
    return {
      chatKey: `qq:group:${frame.group_id}`,
      groupId: frame.group_id,
      userId,
      nickname,
      text,
      mentionsBot,
      messageId: frame.message_id,
    };
  }
  if (frame.message_type === "private") {
    return {
      chatKey: `qq:private:${userId}`,
      userId,
      nickname,
      text,
      mentionsBot: true,
      messageId: frame.message_id,
    };
  }
  return null;
}
