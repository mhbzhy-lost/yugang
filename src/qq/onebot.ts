/**
 * 极简 OneBot v11 客户端（零依赖，用 Node 内置 WebSocket）。
 * 只做这个项目需要的事：收消息、发消息（可拆条、可引用）、贴表情、查群档案、下载图片、
 * 展开合并转发（限一层，文本进上下文、子图走同一落盘路径）。
 */

import { isLookDisabled } from "../tools/look.ts";

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

/** QQ 分享卡片里我们要的那几个字段（小程序 com.tencent.miniapp_01 / structmsg 都覆盖）。 */
export interface ShareCard {
  /** 卡片主标题（B 站分享里通常是「哔哩哔哩」） */
  title?: string;
  /** 卡片正文（B 站分享里通常是视频标题/简介） */
  desc?: string;
  /** 真正能打开的链接：优先 qqdocurl（b23.tv 短链），其次 jumpUrl / url */
  url?: string;
  /** 缩略图 */
  preview?: string;
}

/** 一处 @ 在入站消息里的结构化形态；兼容字段（mentionsBot / atOthers）仍保留给老消费方。 */
export interface IncomingMention {
  /** @ 的 QQ 号；@全体成员 时是 "all"。 */
  qq: string;
  /** 显示名：能拿到就用名片/昵称，拿不到就是 QQ 号；@全体成员 固定「全体成员」。 */
  name: string;
  /** bot = 鱼自己；other = 别人；all = @全体成员（不是点名鱼）。 */
  kind: "bot" | "other" | "all";
}

export type IncomingMessage = {
  chatKey: string; // qq:group:<id> | qq:private:<id>
  groupId?: number;
  userId: number;
  nickname: string;
  text: string;
  mentionsBot: boolean;
  /** 所有 @ 目标的结构化形态（含 @鱼 与 @全体）；判定仍只认 mentionsBot。 */
  mentions?: IncomingMention[];
  /** 收到这条消息帧时分配的单调序号；入站补充是异步的，消费侧按它恢复收到顺序。 */
  arrivalSeq?: number;
  /** 消息里 @ 了别人（或 @全体）的 QQ 号；与 mentionsBot 互不排斥，用来防「把别人的话当叫自己」。 */
  atOthers?: string[];
  /** 与 atOthers 对齐的显示名（群里查到的名片/昵称）；查不到时是 QQ 号。 */
  atOtherNames?: string[];
  messageId?: number | string;
  /** 已落盘的图片引用；进站文本里也会带 [图片 inbound/xxx.png]。 */
  images: IncomingImage[];
  /** 收消息时临时用来下载的原始段，处理完就清空。 */
  imageSegments: OneBotSegment[];
  /** reply 段引用的消息 id；宿主取回被引消息里的图后替换占位符。 */
  replyIds: string[];
  /** forward 段的合集 id；宿主异步拉子消息展开成文本摘要后清空（见 #onFrame）。 */
  forwardIds?: string[];
  /** 这条消息回复的是不是一条合并转发合集；gate 用它放行（回复合集即明确指令，不需要 @）。 */
  repliedForward?: boolean;
  /** 分享卡片（小程序 / 结构化分享）；文本里留 [卡片#N] 占位，由宿主按 prompt 文案渲染。 */
  cards?: ShareCard[];
};

export interface SendOptions {
  quote?: number | string;
  /**
   * 主动 @ 的 QQ 号：只挂在第一条文本上（顺序 quote → at → text）。
   * 号码合法性、身份闸与群成员校验都在出口层（say）做完，这里只负责拼段。
   */
  mentions?: readonly string[];
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
  /** 收到消息帧即自增：入站补充（查名片/下头像/拉合集）是异步的，完成顺序可能倒过来。 */
  #arrivalSeq = 0;

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
    // 消息帧自己带 self_id：先落缓存，parseEvent 也优先认它（刚连上时缓存还是 0）
    if (frame.self_id) this.#selfId = frame.self_id;
    const parsed = parseEvent(frame, this.#selfId);
    if (!parsed) return;
    parsed.arrivalSeq = ++this.#arrivalSeq;

    // @ 别人的名字：段里往往只有 QQ 号，这里用群成员名单补成「昵称(QQ)」，
    // 让模型看得出这句话是对谁说的（进而知道不是在叫自己）。
    await completeAtNames(parsed, (qq) => this.#memberName(parsed.groupId ?? 0, qq));

    // 合并转发：parseEvent 是同步纯函数、拿不到 OneBot 实例，异步拉取放在这里（同 replyIds 先例）。
    // 展开规则（主人定案）：无 @ 的合集零成本丢弃（gate 连打分都不进，不浪费 token）；
    // 自带合集且被 @ = 明确指令，展开；回复合集且被 @ 在下面 reply 路径展开被回复的那条。
    for (const forwardId of parsed.forwardIds ?? []) {
      if (!forwardId) {
        parsed.text = parsed.text.replace("[转发合集，展开中]", "[转发合集，展开失败]");
        continue;
      }
      if (!parsed.mentionsBot) {
        // 没 @：不展开、不调 API，静态占位（这条消息会被闸直接拒，不进上下文）。
        // 但记下「这个群最近有一条没展开的合集」——之后 @ 鱼问「上面那个合集」时能补展开。
        this.#recentForward.set(parsed.chatKey, { id: forwardId, at: Date.now() });
        parsed.text = parsed.text.replace("[转发合集，展开中]", "[转发合集，未展开]");
        continue;
      }
      const shown = await this.#expandForward(forwardId, parsed);
      parsed.text = parsed.text.replace("[转发合集，展开中]", shown);
    }
    // forwardIds 不清空：gate 要用它把无 @ 的合集零成本拒掉

    // 图片落盘，把占位替换成真实引用；看图关闭时非 @ 消息不下载不暴露 ref——
    // 模型只看到中性的 [图]，不会无端提看不了；@ 鱼要求看图的照常全链路
    if (parsed.imageSegments.length > 0 && this.#mediaRoot) {
      const skipImages = isLookDisabled() && !parsed.mentionsBot;
      for (const [index, segment] of parsed.imageSegments.entries()) {
        if (skipImages) {
          parsed.text = parsed.text.replace(`[图片#${index}]`, "[图]");
          continue;
        }
        const saved = await this.downloadImage(segment, this.#mediaRoot);
        const shown = saved ? `[图片 ${saved.ref}]` : "[图片 读不到]";
        parsed.text = parsed.text.replace(`[图片#${index}]`, shown);
        // ref 回填到 images：宿主据此判断这张图是不是动图（自动收表情包用）
        const slot = parsed.images[index];
        if (saved && slot) slot.ref = saved.ref;
      }
    }
    parsed.imageSegments = [];

    // 回复引用：取回被引消息，里面的图落盘后替换占位符，否则看不见被讨论的图；
    // 被引消息若是合并转发：直接展开（回复合集本身就是明确指令，不再要求 @）。
    for (const [index, replyId] of (parsed.replyIds ?? []).entries()) {
      if (!replyId) continue;
      let shown = "[回复的图 读不到]";
      try {
        const quoted = await this.call("get_msg", { message_id: replyId });
        // 有的实现把被引消息给成 CQ 字符串而不是段数组；统一成段数组，否则一律「看不到内容」
        const rawQuoted = quoted?.data?.message ?? quoted?.message;
        const quotedMessage = typeof rawQuoted === "string"
          ? [{ type: "text", data: { text: rawQuoted.replace(/\[CQ:[^\]]+\]/g, " ").trim() } }]
          : rawQuoted;
        if (Array.isArray(quotedMessage)) {
          const fwd = quotedMessage.find((s: OneBotSegment) => s?.type === "forward");
          const fwdId = String((fwd?.data as Record<string, unknown> | undefined)?.["id"] ?? "");
          if (fwd && fwdId) {
            parsed.repliedForward = true;
            shown = await this.#expandForward(fwdId, parsed);
          }
        }
        // 被引消息是分享卡片（B 站小程序等）：把它挂到 cards 上，由宿主渲染成文本。
        // 只取卡片时 shown 用 [卡片#N] 占位，宿主会替换成「[B站视频卡片] 标题 链接」。
        let cardToken = "";
        if (Array.isArray(quotedMessage)) {
          const jsonSeg = quotedMessage.find((s: OneBotSegment) => s?.type === "json");
          const card = jsonSeg ? parseShareCard(jsonSeg.data?.["data"]) : null;
          if (card) {
            parsed.cards = parsed.cards ?? [];
            parsed.cards.push(card);
            cardToken = `[卡片#${parsed.cards.length - 1}]`;
          }
        }

        const imageSegs = Array.isArray(quotedMessage)
          ? quotedMessage.filter((s: OneBotSegment) => s?.type === "image").slice(0, 2)
          : [];
        // 被引消息的文本：纯文本被引也要把原文带上，否则鱼答非所问（旧版只管图）
        const quotedText = Array.isArray(quotedMessage)
          ? quotedMessage.filter((s: OneBotSegment) => s?.type === "text")
              .map((s: OneBotSegment) => String((s.data as Record<string, unknown> | undefined)?.["text"] ?? ""))
              .join("")
              .trim()
              .slice(0, 200)
          : "";
        const sender = (quoted?.data ?? quoted)?.sender ?? {};
        const quotedFrom = String(sender.card || sender.nickname || "").trim().slice(0, 20);
        const textPart = quotedText
          ? `${quotedFrom ? `${quotedFrom}：` : ""}「${quotedText}」`
          : "";
        const savedList: string[] = [];
        for (const seg of imageSegs) {
          const saved = await this.downloadImage(seg, this.#mediaRoot);
          if (saved) savedList.push(saved.ref);
        }
        if (savedList.length > 0) {
          shown = [cardToken, textPart, ...savedList.map((r) => `[回复的图 ${r}]`)].filter(Boolean).join(" ");
        } else if (imageSegs.length === 0) {
          shown = [cardToken, textPart].filter(Boolean).join(" ") || "[回复的消息看不到内容]";
        }
      } catch {
        // 保留默认占位符
      }
      parsed.text = parsed.text.replace(`[回复某条消息#${index}]`, shown);
    }
    parsed.replyIds = [];

    if (!parsed.text.trim()) return;
    for (const h of this.#handlers) h(parsed);
  }

  /** 每个群最近一条「没展开」的合集：@ 鱼问「上面的合集」时补展开用。只存 id，不预拉内容。 */
  readonly #recentForward = new Map<string, { id: string; at: number }>();

  /** 取这个群最近的合集（TTL 内）；没有就 undefined。 */
  recentForward(chatKey: string, ttlMs: number): string | undefined {
    const hit = this.#recentForward.get(chatKey);
    if (!hit) return undefined;
    if (Date.now() - hit.at > ttlMs) return undefined;
    return hit.id;
  }

  /** 展开指定合集（外部按 id 调用，失败返回 null，不抛）。 */
  async expandForwardById(id: string, msg: IncomingMessage): Promise<string | null> {
    try {
      return await this.#expandForward(id, msg);
    } catch {
      return null;
    }
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
  /** 发语音：内容走 base64://，绕开 QQ 沙盒对本地路径的限制（已实测）。 */
  async sendVoiceGroup(groupId: number, bytes: Buffer): Promise<void> {
    await this.call("send_group_msg", {
      group_id: groupId,
      message: [{ type: "record", data: { file: `base64://${bytes.toString("base64")}` } }],
    });
  }

  async sendVoicePrivate(userId: number, bytes: Buffer): Promise<void> {
    await this.call("send_private_msg", {
      user_id: userId,
      message: [{ type: "record", data: { file: `base64://${bytes.toString("base64")}` } }],
    });
  }

  async sendGroup(groupId: number, texts: readonly string[], options: SendOptions = {}): Promise<void> {
    const delay = options.delayMs ?? (() => 700 + Math.floor(Math.random() * 1200));
    for (const [index, text] of texts.entries()) {
      // 段顺序固定：quote → at → text。@ 只挂在第一条：连说几句时每句都带一遍 @ 会刷屏
      const segments: OneBotSegment[] = [];
      if (options.quote !== undefined && index === 0) {
        segments.push({ type: "reply", data: { id: String(options.quote) } });
      }
      if (index === 0) {
        for (const qq of options.mentions ?? []) segments.push({ type: "at", data: { qq } });
      }
      segments.push({ type: "text", data: { text } });
      await this.call("send_group_msg", { group_id: groupId, message: segments });
      if (index < texts.length - 1) await sleep(delay());
    }
  }

  /** 私聊不接收 mentions：私聊里没有「@谁」这回事，出口层已经拒绝带 @ 的私聊发送。 */
  async sendPrivate(userId: number, texts: readonly string[]): Promise<void> {
    for (const text of texts) {
      await this.call("send_private_msg", { user_id: userId, message: text });
    }
  }

  async sendImagePrivate(userId: number, filePath: string): Promise<void> {
    const { readFileSync } = await import("node:fs");
    const data = readFileSync(filePath).toString("base64");
    await this.call("send_private_msg", {
      user_id: userId,
      message: [{ type: "image", data: { file: `base64://${data}` } }],
    });
  }

  async sendImageGroup(groupId: number, filePath: string): Promise<void> {
    // QQ 是沙盒应用，读不了容器外的本地文件（EPERM）；自己读好后以 base64 传入，
    // NapCat 直接用数据发图，不经文件系统。局域网 WS 内传几 MB 无压力。
    const { readFileSync } = await import("node:fs");
    const data = readFileSync(filePath).toString("base64");
    await this.call("send_group_msg", {
      group_id: groupId,
      message: [{ type: "image", data: { file: `base64://${data}` } }],
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

  /** 群成员名单（5 分钟缓存）：只为把 @ 的 QQ 号换成看得懂的名字，不参与判定。 */
  #memberCache = new Map<number, { at: number; members: { nickname: string; userId: string }[] }>();

  async #memberName(groupId: number, qq: string): Promise<string | undefined> {
    const cached = this.#memberCache.get(groupId);
    if (!cached || Date.now() - cached.at > 300_000) {
      const members = await this.groupMembers(groupId, 10_000);
      this.#memberCache.set(groupId, { at: Date.now(), members });
      return members.find((m) => m.userId === qq)?.nickname;
    }
    return cached.members.find((m) => m.userId === qq)?.nickname;
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

  /** 拉一条合并转发的子消息列表；超时 5s、连接断开等一切失败一律返回 null，由调用方保留失败占位。 */
  async getForwardMsg(id: string): Promise<{ sender: { nickname?: string }; message: OneBotSegment[] }[] | null> {
    try {
      // call 内建超时是 20s（对拉取来说太久），这里 race 一个 5s 时钟先到先得；
      // call 的承诺被 .catch 挂住，晚到的 20s 超时不会变成未处理拒绝。
      const res = await Promise.race([
        this.call("get_forward_msg", { message_id: id }).catch(() => null),
        sleep(5_000).then(() => null),
      ]);
      // OB11 文档：列表在 data.messages；节点内容字段各实现叫 message 或 content，都收。
      const raw = res?.data?.messages ?? res?.data ?? res?.messages;
      if (!Array.isArray(raw)) return null;
      return raw.map((item: any) => ({
        sender: { nickname: item?.sender?.nickname == null ? undefined : String(item.sender.nickname) },
        message: (Array.isArray(item?.message)
          ? item.message
          : Array.isArray(item?.content)
            ? item.content
            : []) as OneBotSegment[],
      }));
    } catch {
      return null;
    }
  }

  /** 把一个转发合集展开成文本摘要（前 10 条）；子图 ≤2 张并入 imageSegments 走既有 downloadImage 路径。 */
  async #expandForward(id: string, msg: IncomingMessage): Promise<string> {
    const subs = await this.getForwardMsg(id);
    if (!subs || subs.length === 0) return "[转发合集，展开失败]";
    const lines = [`[转发合集 ${subs.length} 条]`];
    let subImages = 0;
    for (const [index, sub] of subs.slice(0, 10).entries()) {
      let body = "";
      for (const seg of sub.message ?? []) {
        if (seg.type === "text") body += String(seg.data?.["text"] ?? "");
        else if (seg.type === "image") {
          if (subImages < 2) {
            // 占位与直发图同格式、共用 images.length 计数；images 与 imageSegments 始终成对推进，
            // 占位号 = imageSegments 下标，落盘替换才不会错位。
            body += ` [图片#${msg.images.length}] `;
            msg.imageSegments.push(seg);
            msg.images.push({ ref: "" });
            subImages++;
          } else {
            body += " [图片 未展开] ";
          }
        } else if (seg.type === "forward") {
          // 嵌套转发不递归；同步阶段拿不到子消息数，占位不写 N。
          body += " [嵌套转发] ";
        } else if (seg.type === "json") {
          // 分享卡片（图文/链接，com.tencent.tuwen 等）：粗提 title，提不到给通用占位
          const raw = String(seg.data?.["data"] ?? "");
          const title = raw.match(/"title"\s*:\s*"([^"]{1,60})"/)?.[1] ?? "";
          body += title ? ` [分享卡片：${title}] ` : " [分享卡片] ";
        } else if (seg.type === "face") {
          body += " [表情] ";
        } else if (seg.type !== "reply" && seg.type !== "at") {
          body += " [不支持的消息] ";
        }
      }
      const num = String.fromCharCode(0x2460 + index); // ①..⑩
      lines.push(`${num}${sub.sender?.nickname ?? "?"}: ${body.replace(/\s+/g, " ").trim()}`);
    }
    if (subs.length > 10) lines.push(`…共 ${subs.length} 条`);
    return lines.join("\n");
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

  /** 优雅退出用：显式断开 WS，让协议端立即感知重连，不等它自己的超时。 */
  close(): void {
    try {
      this.#ws?.close();
    } catch {
      /* 已断则罢 */
    }
    this.#ws = undefined;
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

/**
 * 解析 QQ 分享卡片的 JSON（小程序分享、结构化分享两种壳子）。
 *
 * 实测样例（B 站小程序，2026-10-30）：
 *   app: com.tencent.miniapp_01
 *   prompt: "[QQ小程序]买人生第一辆车之前要先学会算账…"
 *   meta.detail_1: { title: "哔哩哔哩", desc: "买人生第一辆车…", qqdocurl: "https://b23.tv/3watppp" }
 * 另一种壳子 com.tencent.structmsg 把信息放在 meta.news 里，字段名是 jumpUrl。
 */
export function parseShareCard(raw: unknown): ShareCard | null {
  if (typeof raw !== "string" || raw.length === 0) return null;
  let obj: any;
  try {
    obj = JSON.parse(raw);
  } catch {
    return null;
  }
  const meta = obj?.meta ?? {};
  const detail = meta.detail_1 ?? meta.news ?? meta.detail_2 ?? {};
  const pick = (...keys: string[]): string | undefined => {
    for (const key of keys) {
      const value = detail?.[key] ?? obj?.[key];
      if (typeof value === "string" && value.trim().length > 0) return value.trim();
    }
    return undefined;
  };
  const title = pick("title");
  const desc = pick("desc", "description", "prompt");
  const url = pick("qqdocurl", "jumpUrl", "url", "source_url");
  const preview = pick("preview");
  if (!title && !desc && !url) return null;
  return {
    ...(title ? { title } : {}),
    ...(desc ? { desc } : {}),
    ...(url ? { url } : {}),
    ...(preview ? { preview } : {}),
  };
}

interface MentionAccumulator {
  mentions: IncomingMention[];
  atOthers: string[];
  atOtherNames: string[];
}

/**
 * 归一化一处 @：结构化 mentions 与兼容字段一起推进，返回要追加到正文的文本。
 * 三种 kind 的正文策略与旧实现一致：@鱼 不留字、@全体 留标记、@别人 留名字。
 */
function applyMention(
  qq: string,
  rawName: string,
  selfId: number,
  acc: MentionAccumulator,
): { text: string; kind: IncomingMention["kind"] } {
  const name = rawName.trim();
  if (qq === String(selfId)) {
    acc.mentions.push({ qq, name: name || qq, kind: "bot" });
    return { text: "", kind: "bot" };
  }
  if (qq === "all") {
    // @全体：说的是所有人，不是点名鱼；保留标记，别当「叫自己」
    acc.mentions.push({ qq, name: "全体成员", kind: "all" });
    acc.atOthers.push("all");
    acc.atOtherNames.push("全体成员");
    return { text: " @全体成员 ", kind: "all" };
  }
  // 昵称能拿到就用昵称，拿不到用 QQ 号：模型要能看出这句是 @ 别人的
  acc.mentions.push({ qq, name: name || qq, kind: "other" });
  acc.atOthers.push(qq);
  acc.atOtherNames.push(name || qq);
  return { text: ` @${name || qq} `, kind: "other" };
}

/** CQ 码的转义实体（规范里就这四个）；只还原文本，不去猜码。 */
const CQ_ENTITIES: Record<string, string> = { "&#91;": "[", "&#93;": "]", "&#44;": ",", "&amp;": "&" };

function unescapeCq(text: string): string {
  return text.replace(/&#91;|&#93;|&#44;|&amp;/g, (entity) => CQ_ENTITIES[entity] ?? entity);
}

/** CQ 码里的 `k=v,k=v` 参数；逗号在值里是转义的，所以按裸逗号切安全。 */
function parseCqParams(raw: string): Record<string, string> {
  const params: Record<string, string> = {};
  for (const pair of raw.split(",")) {
    const cut = pair.indexOf("=");
    if (cut <= 0) continue;
    params[pair.slice(0, cut).trim()] = unescapeCq(pair.slice(cut + 1));
  }
  return params;
}

/**
 * CQ 字符串形态的消息：只机械解析 at（message_format=string 时 @ 只在这里），
 * 其它 CQ 码原样留在正文里（与旧行为一致），普通文本做规范要求的反转义。
 */
function parseCqMessage(raw: string, selfId: number, acc: MentionAccumulator): { text: string; mentionsBot: boolean } {
  let text = "";
  let mentionsBot = false;
  let cursor = 0;
  const code = /\[CQ:at((?:,[^\]]*)?)\]/g;
  for (let hit = code.exec(raw); hit !== null; hit = code.exec(raw)) {
    text += unescapeCq(raw.slice(cursor, hit.index));
    cursor = hit.index + hit[0].length;
    const params = parseCqParams(hit[1] ?? "");
    const applied = applyMention(String(params["qq"] ?? ""), String(params["name"] ?? ""), selfId, acc);
    if (applied.kind === "bot") mentionsBot = true;
    text += applied.text;
  }
  text += unescapeCq(raw.slice(cursor));
  return { text, mentionsBot };
}

/**
 * 消费侧排序：按 arrivalSeq 升序重排；没有 arrivalSeq 的旧构造（fixture / 外部构造）
 * 原地不动，保留既有顺序。入站补充（查名片/下头像/拉合集）是异步的，
 * 处理完成顺序可能与收到顺序相反，流水必须按收到顺序给模型看。
 */
export function orderByArrival<T extends { arrivalSeq?: number }>(items: readonly T[]): T[] {
  const slots = items
    .map((item, index) => ({ item, index }))
    .filter((slot) => slot.item.arrivalSeq !== undefined);
  const result = [...items];
  if (slots.length < 2) return result;
  const ordered = slots
    .slice()
    .sort((a, b) => (a.item.arrivalSeq ?? 0) - (b.item.arrivalSeq ?? 0) || a.index - b.index)
    .map((slot) => slot.item);
  // 只回填原本有 seq 的槽位：缺失的条目留在原位置，不会被挤走
  for (const [position, slot] of slots.entries()) result[slot.index] = ordered[position];
  return result;
}

/**
 * 把正文里的 `@号码` 补成 `@昵称(号码)`。
 *
 * 只改这个号码自己的占位：号码后面紧跟数字的不动（`@12` 不能把 `@123` 改掉），
 * 昵称里的 `$&`、`$1` 也不能被当成替换模式（用函数式 replacer，不做字符串模板拼装）。
 */
export function fillAtName(text: string, qq: string, name: string): string {
  if (!/^\d+$/.test(qq) || !name) return text;
  return text.replace(new RegExp(`@${qq}(?!\\d)`, "g"), () => `@${name}(${qq})`);
}

/**
 * 用成员名单把入站消息里 `@别人` 的号码补成「昵称(QQ)」：状态、兼容字段、正文三处同步。
 *
 * 只补本群真实成员（lookup 拿不到就原样留着）；@全体、空名、非数字号码一律跳过，
 * 否则会把 `@全体成员` 或异常段拼成奇怪的文字。
 */
export async function completeAtNames(
  parsed: IncomingMessage,
  lookup: (qq: string) => Promise<string | undefined> | string | undefined,
): Promise<void> {
  if (!parsed.atOthers?.length) return;
  const names = parsed.atOtherNames ?? [];
  for (const [index, qq] of parsed.atOthers.entries()) {
    if (!/^\d+$/.test(qq) || parsed.groupId === undefined) continue;
    const known = names[index];
    if (known && known !== qq) continue;
    const name = (await lookup(qq))?.trim();
    if (!name || name === qq) continue;
    names[index] = name;
    // 结构化 mentions 与兼容字段同步：模型可见的标注只认 mentions
    const mention = parsed.mentions?.find((m) => m.kind === "other" && m.qq === qq);
    if (mention) mention.name = name;
    parsed.text = fillAtName(parsed.text, qq, name);
  }
  parsed.atOtherNames = names;
}

export function parseEvent(frame: OneBotEvent, selfId: number): IncomingMessage | null {
  const userId = frame.user_id ?? 0;
  if (!userId) return null;
  // 鱼是谁：这一帧的 self_id 是权威值，缺了才退回缓存
  const self = frame.self_id || selfId;

  let text = "";
  let mentionsBot = false;
  const mentions: IncomingMention[] = [];
  const atOthers: string[] = [];
  const atOtherNames: string[] = [];
  // 结构化 @ 与兼容字段一起推进
  const atTargets: MentionAccumulator = { mentions, atOthers, atOtherNames };
  const images: IncomingImage[] = [];
  const segments: OneBotSegment[] = [];
  const replyIds: string[] = [];
  const forwardIds: string[] = [];
  const cards: ShareCard[] = [];
  const message = frame.message;

  if (typeof message === "string") {
    // message_format=string：@ 只存在于 CQ 码里，与段路径走同一套归一逻辑
    const cq = parseCqMessage(message, self, atTargets);
    text = cq.text;
    mentionsBot = cq.mentionsBot;
  } else if (Array.isArray(message)) {
    for (const seg of message) {
      if (seg.type === "text") text += String(seg.data?.["text"] ?? "");
      else if (seg.type === "at") {
        const applied = applyMention(String(seg.data?.["qq"] ?? ""), String(seg.data?.["name"] ?? ""), self, atTargets);
        if (applied.kind === "bot") mentionsBot = true;
        text += applied.text;
      } else if (seg.type === "image") {
        text += ` [图片#${images.length}] `;
        segments.push(seg);
        images.push({ ref: "" });
      } else if (seg.type === "video") {
        const u = String(seg.data?.["url"] ?? seg.data?.["file"] ?? "");
        if (u) text += ` [视频 ${u.slice(0, 200)}] `;
      } else if (seg.type === "reply") {
        text += ` [回复某条消息#${replyIds.length}] `;
        replyIds.push(String(seg.data?.["id"] ?? ""));
      } else if (seg.type === "json") {
        const card = parseShareCard(seg.data?.["data"]);
        if (card) {
          text += ` [卡片#${cards.length}] `;
          cards.push(card);
        } else {
          text += " [卡片] ";
        }
      } else if (seg.type === "forward") {
        // OB11 文档形态 {type:"forward", data:{id}}（开发机无生产日志，以文档为准，
        // 上线后 F1 真机复验兜底）；同步阶段拿不到子消息数，占位不写 N，
        // 异步展开在 #onFrame。本函数保持同步纯函数。
        text += " [转发合集，展开中] ";
        forwardIds.push(String(seg.data?.["id"] ?? ""));
      }
    }
  }
  text = text.replace(/\s+/g, " ").trim();
  // 裸 @（只 @ 不带字）不丢弃：以最小占位文本继续走闸和链路，
  // 否则 chatlog 无痕，用户观感是鱼不理人。非 @ 的空文本维持丢弃。
  if (!text && mentionsBot) text = "（被 @ 了一下，没说话）";
  // 抠掉 @ 标记后只剩标点/空白/符号（含 emoji）的，也算没内容：这类消息不值得占一次抽签。
  // @ 了鱼（mentionsBot）不受此限——被点名就算只发个问号也要答。
  if (!mentionsBot && text.replace(/@\S+/g, " ").replace(/[\p{P}\p{S}\p{Z}\s]/gu, "") === "") return null;
  if (!text) return null;

  const nickname = frame.sender?.card || frame.sender?.nickname || String(userId);
  const base = { userId, nickname, text, mentionsBot, ...(mentions.length > 0 ? { mentions } : {}), ...(atOthers.length > 0 ? { atOthers, atOtherNames } : {}), messageId: frame.message_id, images, imageSegments: segments, replyIds, forwardIds, ...(cards.length > 0 ? { cards } : {}) };

  if (frame.message_type === "group" && frame.group_id) {
    return { ...base, chatKey: `qq:group:${frame.group_id}`, groupId: frame.group_id };
  }
  if (frame.message_type === "private") {
    return { ...base, chatKey: `qq:private:${userId}`, mentionsBot: true };
  }
  return null;
}
