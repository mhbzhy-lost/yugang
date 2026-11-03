/**
 * faux B 站 —— api.bilibili.com 白名单端点的本地替身（IT bed Task I2）。
 *
 * 协议结论（2026-11-03 逐行核对 src/external/bili-client.ts 后照实模拟）：
 * - 信封：JSON 端点一律 {code:0, message:"0", ttl:1, data}；客户端只认 code===0，
 *   code=-412/-352 触发风控熔断（fixture 默认不给，/refresh 可注入做演练）。
 * - 白名单七端点（endpointUrl 唯一拼 URL 处，路径与查询形状照抄）：
 *     GET /x/web-interface/popular?ps=20&pn=N        → data.list = 视频卡片数组
 *     GET /x/web-interface/ranking/v2?rid=0&type=all → data.list = 视频卡片数组
 *     GET /x/web-interface/view?bvid=BV…             → data = 单张视频卡片（含 cid）；未知 bvid 给 code=-404
 *     GET /x/v1/dm/list.so?oid=cid                   → **原始 XML 文本**（不是 JSON 信封），Content-Type text/xml
 *     GET /x/v2/reply/main?type=1&oid=…&mode=3       → data.replies = 评论数组
 *     GET /x/web-interface/card?mid=…&photo=false    → data.card = UP 卡片（fans/level_info/official_verify）
 *     GET /x/frontend/finger/spi                     → data.b_3 / data.b_4（buvid，客户端拿到后长期复用）
 * - 卡片消费字段：bvid/aid/title/desc/duration/pubdate/owner{mid,name}/
 *   stat{view,danmaku,reply,favorite,coin,share,like}/cid/tname/pic，缺的字段按 0/空处理。
 * - 评论消费字段：rpid/like/ctime/content.message/member{mid,uname,level_info.current_level,official_verify.type?desc}。
 *
 * 样本设计：正常号 / 营销号混合——正常号标题朴素、赞播比健康、发布较久；
 * 营销号标题命中 titleBait/UC/盘点词表（震惊、99%的人、看完删、老外看、盘点、合集…）、
 * 高播放低赞、发布新鲜，硬筛一票否决的靶子。BV 号固定不变，断言可复现。
 *
 * 单文件零依赖（同 faux NapCat 风格）。
 *
 * 用法：
 *   node scripts/itbed/faux/bili.ts [--port 4430]
 *   环境变量 FAUX_BILI_PORT 同样生效，CLI 优先。
 *   注意：src 侧 bili-client 的 API_ROOT 目前钉死 https://api.bilibili.com，尚无地址覆盖项
 *   （BILI_BASE_URL 已由 launch 注入，待 src 接线后即生效）；本替身当前由 launch 自测与场景驱动器消费。
 *
 * fixture 替换（POST /refresh，JSON，按键部分替换，内存态不落盘）：
 *   {"popular": [卡片…], "ranking": [卡片…],          ← 整列表替换（须非空、每张有非空 bvid）
 *    "view":    [卡片…],                              ← 按 bvid 建索引（覆盖同名 bvid）
 *    "dm":      {"42001": "<i>…</i>"}                 ← 按 cid 建索引（覆盖同名 cid）
 *    "replies": {"42001": [评论…]},                    ← 按 oid(type=1) 建索引
 *    "card":    {"910001": UP卡片…},                  ← 按 mid 建索引
 *    "spi":     {"b_3":"…","b_4":"…"}}
 *   只替换给了的键；校验失败返回 400 且不改动。GET /fixtures 看当前生效值，GET /health 探活。
 */

import { createServer, type IncomingMessage, type ServerResponse } from "node:http";

// ── 参数（CLI > 环境变量 > 缺省）─────────────────────────────────────────────

function argValue(name: string): string | undefined {
  const argv = process.argv;
  const at = argv.indexOf(`--${name}`);
  return at >= 0 && at + 1 < argv.length ? argv[at + 1] : undefined;
}
function num(value: string | undefined, fallback: number): number {
  const n = Number(value);
  return Number.isFinite(n) && n > 0 ? n : fallback;
}

const PORT = num(argValue("port") ?? process.env["FAUX_BILI_PORT"], 4430);

// ── 固定 fixture（BV 稳定：BV + 10 位字母数字，ITB 前缀 + 7 位序号）──────────

/** BVITB + 7 位序号 → after-BV 恰好 10 位，过得了 isValidBvid 的 ^BV[0-9A-Za-z]{10}$。 */
function bvidOf(seq: number): string {
  return `BVITB${String(seq).padStart(7, "0")}`;
}

// 发布时间固定（Unix 秒）：正常号老稿（过 minAgeHours），营销号新鲜（48h 内，靶子）
const PUBDATE_OLD_A = 1790683200; // 2026-06-01T00:00:00Z
const PUBDATE_OLD_B = 1791100000; // 2026-06-05T…
const PUBDATE_FRESH = 1793698200; // 2026-11-03T09:30:00Z（fixture 与 FIXTURE 基线同天）

interface Card {
  aid: number;
  bvid: string;
  cid: number;
  tname: string;
  title: string;
  desc: string;
  duration: number;
  pubdate: number;
  owner: { mid: number; name: string; face?: string };
  stat: { view: number; danmaku: number; reply: number; favorite: number; coin: number; share: number; like: number };
  pic: string;
}

const UPS = {
  normal1: { mid: 910001, name: "山谷里的风", face: "https://example.com/face/910001.jpg" },
  normal2: { mid: 910002, name: "科学漫谈社", face: "https://example.com/face/910002.jpg" },
  mk001: { mid: 910003, name: "每日猎奇速递酱", face: "https://example.com/face/910003.jpg" },
  mk002: { mid: 910004, name: "影视剪辑搬运君", face: "https://example.com/face/910004.jpg" },
} as const;

function card(seq: number, over: Partial<Card> & Pick<Card, "title" | "owner" | "pubdate"> & { stat: Card["stat"] }): Card {
  return {
    aid: 4200000 + seq,
    bvid: bvidOf(seq),
    cid: 42000 + seq,
    tname: "科技",
    desc: "",
    duration: 300,
    pic: `https://example.com/pic/${bvidOf(seq)}.jpg`,
    ...over,
  };
}

/** 综合热门与排行榜共用一份列表：正常号在前，营销号混合其中。 */
const LIST_DEFAULT: Card[] = [
  // —— 正常号：标题朴素、赞播比健康、稿龄老（过 48h 硬筛）——
  card(1, {
    title: "把一台 1998 年的渔船电台改造成床头收音机",
    desc: "拆解、除锈、换电容，一气呵成。BGM 是它自己放出来的。",
    duration: 384, pubdate: PUBDATE_OLD_A, owner: { ...UPS.normal1 },
    stat: { view: 128000, danmaku: 2100, reply: 860, favorite: 9800, coin: 5200, share: 700, like: 11200 },
  }),
  card(2, {
    title: "为什么深海鱼一捞上来就「化」了？",
    desc: "压力、体液与蛋白质的三重奏。",
    duration: 612, pubdate: PUBDATE_OLD_B, owner: { ...UPS.normal2 },
    stat: { view: 456000, danmaku: 8800, reply: 3200, favorite: 42000, coin: 26000, share: 4100, like: 43000 },
  }),
  card(5, {
    title: "三年之后，我的屋顶菜园怎么样了",
    desc: "番茄占领了整个水箱，附实测产量。",
    duration: 458, pubdate: PUBDATE_OLD_A, owner: { ...UPS.normal1 },
    stat: { view: 89000, danmaku: 1400, reply: 620, favorite: 7600, coin: 4100, share: 390, like: 8100 },
  }),
  card(6, {
    title: "用一杯水的能量讲清楚芯片为什么难",
    desc: "不查表，只用生活量级。",
    duration: 520, pubdate: PUBDATE_OLD_B, owner: { ...UPS.normal2 },
    stat: { view: 232000, danmaku: 5100, reply: 1900, favorite: 21000, coin: 13000, share: 2200, like: 26000 },
  }),
  // —— 营销号：标题命中词表、高播放低赞、新鲜发布（硬筛一票否决的靶子）——
  card(3, {
    title: "震惊！99%的人不知道手机这个开关，看完删",
    desc: "关注我，下期更精彩。素材来源网络，侵删。",
    duration: 42, pubdate: PUBDATE_FRESH, owner: { ...UPS.mk001 },
    stat: { view: 980000, danmaku: 96, reply: 45, favorite: 120, coin: 30, share: 88, like: 1500 },
  }),
  card(4, {
    title: "老外看傻呆蒙！盘点年度十大名场面合集",
    desc: "关注公众号领福利，每天更新。",
    duration: 65, pubdate: PUBDATE_FRESH, owner: { ...UPS.mk002 },
    stat: { view: 740000, danmaku: 51, reply: 32, favorite: 90, coin: 21, share: 66, like: 980 },
  }),
  card(7, {
    title: "内幕曝光：速看，马上删",
    desc: "懂的自然懂，评论区留入口。",
    duration: 31, pubdate: PUBDATE_FRESH, owner: { ...UPS.mk001 },
    stat: { view: 510000, danmaku: 18, reply: 27, favorite: 44, coin: 9, share: 120, like: 620 },
  }),
  card(8, {
    title: "不转不是中国人：五年前的一碗面",
    desc: "转发这条视频，好运自然来。",
    duration: 58, pubdate: PUBDATE_FRESH, owner: { ...UPS.mk002 },
    stat: { view: 630000, danmaku: 40, reply: 61, favorite: 71, coin: 12, share: 300, like: 880 },
  }),
];

/** UP 卡片（card 端点）：正常号高粉丝高等级，营销号低等级带机构认证尾巴。 */
interface UpCardFixture {
  mid: number;
  name: string;
  fans: number;
  current_level: number;
  official_type: number;
  official_desc?: string;
}
const CARD_DEFAULT: Record<string, UpCardFixture> = {
  "910001": { mid: 910001, name: UPS.normal1.name, fans: 860000, current_level: 6, official_type: -1 },
  "910002": { mid: 910002, name: UPS.normal2.name, fans: 1520000, current_level: 6, official_type: 0, official_desc: "科学领域爱好者" },
  "910003": { mid: 910003, name: UPS.mk001.name, fans: 24000, current_level: 2, official_type: -1 },
  "910004": { mid: 910004, name: UPS.mk002.name, fans: 51000, current_level: 3, official_type: 0, official_desc: "影视领域爱好者" },
};

/** 热评（reply/main mode=3）：认证UP回复 + 高赞普通评论 + 营销号互关spam，等级/认证齐全。 */
interface ReplyFixture {
  rpid: number;
  like: number;
  ctime: number;
  message: string;
  mid: number;
  uname: string;
  current_level: number;
  official_type: number;
  official_desc?: string;
}
const REPLIES_DEFAULT: Record<string, ReplyFixture[]> = {
  "42001": [
    { rpid: 800001, like: 3200, ctime: PUBDATE_OLD_A + 3600, message: "换电容那段太解压了，周末也想试试。", mid: 910010, uname: "拆解爱好者", current_level: 6, official_type: -1 },
    { rpid: 800002, like: 2100, ctime: PUBDATE_OLD_A + 7200, message: "UP 回复：电容型号和清单放在置顶了。", mid: 910001, uname: UPS.normal1.name, current_level: 6, official_type: -1 },
    { rpid: 800003, like: 4, ctime: PUBDATE_FRESH + 600, message: "互关必回，主页有惊喜。", mid: 910011, uname: "互关小助手", current_level: 2, official_type: -1 },
    { rpid: 800004, like: 560, ctime: PUBDATE_OLD_B + 3600, message: "第一次见到还能响的船用电台，声音好有年代感。", mid: 910012, uname: "港口夜听", current_level: 4, official_type: -1 },
  ],
};

/** 弹幕（dm/list.so 是 XML）：p = 时间,模式,字号,颜色,时间戳,池,user_hash,行号。 */
function dmXml(cid: string): string {
  const bodies: Record<string, { at: number; text: string; hash: string }[]> = {
    "42001": [
      { at: 12.34, text: "开头这段 BGM 爷青回", hash: "910001" },
      { at: 48.0, text: "换电容手法好稳", hash: "910010" },
      { at: 155.5, text: "这声音值一个三连", hash: "910012" },
    ],
    "42002": [
      { at: 5.2, text: "前排放个教授", hash: "910013" },
      { at: 210.0, text: "蛋白质变性讲得好直观", hash: "910010" },
    ],
  };
  const body = bodies[cid] ?? [];
  const items = body.map((d, i) => `<d p="${d.at.toFixed(2)},1,25,16777215,0,0,${d.hash},${i}">${d.text}</d>`).join("");
  return (
    `<i><chatserver>chat.bilibili.com</chatserver><chatid>${cid}</chatid><maxlimit>1000</maxlimit>` +
    `<state>0</state><real_name>0</real_name><source>k-v</source>${items}</i>`
  );
}

const SPI_DEFAULT: { b_3: string; b_4?: string } = { b_3: "itbed-buvid3-fixed-0001", b_4: "itbed-buvid4-fixed-0001" };

/** 当前生效 fixture：/refresh 只动这里，进程重启即回默认。 */
const current = {
  list: LIST_DEFAULT,
  viewIndex: new Map<string, Card>(LIST_DEFAULT.map((c) => [c.bvid, c])),
  cardIndex: new Map<string, UpCardFixture>(Object.entries(CARD_DEFAULT)),
  replyIndex: new Map<string, ReplyFixture[]>(Object.entries(REPLIES_DEFAULT)),
  dmIndex: new Map<string, string>(),
  spi: SPI_DEFAULT,
};

// ── fixture 校验与替换 ───────────────────────────────────────────────────────

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function isCards(value: unknown): value is Card[] {
  return Array.isArray(value) && value.length > 0 && value.every((c) => isRecord(c) && typeof c["bvid"] === "string" && c["bvid"].length > 0);
}

function isReplyList(value: unknown): value is ReplyFixture[] {
  return Array.isArray(value) && value.every((r) => isRecord(r) && typeof r["message"] === "string");
}

// ── HTTP 服务 ────────────────────────────────────────────────────────────────

function sendJson(res: ServerResponse, status: number, body: unknown): void {
  const payload = JSON.stringify(body);
  res.writeHead(status, { "Content-Type": "application/json; charset=utf-8", "Content-Length": Buffer.byteLength(payload) });
  res.end(payload);
}

/** B 站信封；code 非 0 时客户端会当接口错误（-412/-352 额外触发熔断）。 */
function envelope(res: ServerResponse, data: unknown): void {
  sendJson(res, 200, { code: 0, message: "0", ttl: 1, data });
}
function envelopeError(res: ServerResponse, code: number, message: string): void {
  sendJson(res, 200, { code, message, ttl: 1, data: null });
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

/** card 端点形态：{card:{mid,name,fans,level_info,official_verify}, …}（photo=false 之类忽略）。 */
function upCardEnvelope(entry: UpCardFixture): unknown {
  return {
    card: {
      mid: String(entry.mid), // card 端点真实返回是字符串，客户端 numOf 兼容两种
      name: entry.name,
      fans: entry.fans,
      level_info: { current_level: entry.current_level },
      official_verify: { type: entry.official_type, ...(entry.official_desc !== undefined ? { desc: entry.official_desc } : {}) },
    },
    follower: entry.fans,
  };
}

function replyEnvelope(list: ReplyFixture[]): unknown {
  return {
    replies: list.map((r) => ({
      rpid: r.rpid,
      like: r.like,
      ctime: r.ctime,
      content: { message: r.message },
      member: {
        mid: String(r.mid),
        uname: r.uname,
        level_info: { current_level: r.current_level },
        official_verify: { type: r.official_type, ...(r.official_desc !== undefined ? { desc: r.official_desc } : {}) },
      },
    })),
  };
}

const server = createServer((req, res) => {
  const url = new URL(req.url ?? "/", `http://127.0.0.1:${PORT}`);
  const path = url.pathname.replace(/\/+$/, "") || "/";

  if (path === "/health") {
    sendJson(res, 200, {
      ok: true,
      service: "faux-bili",
      items: { list: current.list.length, view: current.viewIndex.size, card: current.cardIndex.size, reply: current.replyIndex.size, dm: current.dmIndex.size },
      uptimeMs: Math.round(process.uptime() * 1000),
    });
    return;
  }
  if (path === "/fixtures" && req.method === "GET") {
    sendJson(res, 200, {
      list: current.list,
      view: [...current.viewIndex.keys()],
      card: Object.fromEntries(current.cardIndex),
      replies: Object.fromEntries(current.replyIndex),
      dm: [...current.dmIndex.keys()],
      spi: current.spi,
    });
    return;
  }
  if (path === "/refresh" && req.method === "POST") {
    void readBody(req)
      .then((text) => {
        let body: unknown;
        try {
          body = JSON.parse(text) as unknown;
        } catch {
          sendJson(res, 400, { ok: false, error: "JSON 解析失败" });
          return;
        }
        if (!isRecord(body)) {
          sendJson(res, 400, { ok: false, error: "body 须是对象：{popular?, ranking?, view?, dm?, replies?, card?, spi?}" });
          return;
        }
        const listKeys = ["popular", "ranking"] as const;
        for (const key of listKeys) {
          if (body[key] !== undefined && !isCards(body[key])) {
            sendJson(res, 400, { ok: false, error: `${key} 形态不对：非空卡片数组，每张须有非空 bvid` });
            return;
          }
        }
        if (body["view"] !== undefined && !isCards(body["view"])) {
          sendJson(res, 400, { ok: false, error: "view 形态不对：卡片数组，按 bvid 建索引" });
          return;
        }
        const replaced: string[] = [];
        if (body["popular"] !== undefined) {
          current.list = body["popular"] as Card[];
          replaced.push("popular");
        }
        if (body["ranking"] !== undefined) {
          current.list = body["ranking"] as Card[];
          replaced.push("ranking");
        }
        if (body["view"] !== undefined) {
          for (const c of body["view"] as Card[]) current.viewIndex.set(c.bvid, c);
          replaced.push("view");
        }
        // dm/replies/card：先窄化到局部 Record，校验不过整体拒改
        if (body["dm"] !== undefined) {
          const dmPatch = body["dm"];
          if (!isRecord(dmPatch)) {
            sendJson(res, 400, { ok: false, error: "dm 形态不对：{cid: XML字符串} 映射" });
            return;
          }
          for (const [cid, xml] of Object.entries(dmPatch)) {
            if (typeof xml !== "string") {
              sendJson(res, 400, { ok: false, error: "dm 的值须是 XML 字符串" });
              return;
            }
            current.dmIndex.set(cid, xml);
          }
          replaced.push("dm");
        }
        if (body["replies"] !== undefined) {
          const replyPatch = body["replies"];
          if (!isRecord(replyPatch)) {
            sendJson(res, 400, { ok: false, error: "replies 形态不对：{oid: 评论数组} 映射" });
            return;
          }
          for (const [oid, list] of Object.entries(replyPatch)) {
            if (!isReplyList(list)) {
              sendJson(res, 400, { ok: false, error: "replies 的值须是评论数组" });
              return;
            }
            current.replyIndex.set(oid, list);
          }
          replaced.push("replies");
        }
        if (body["card"] !== undefined) {
          const cardPatch = body["card"];
          if (!isRecord(cardPatch)) {
            sendJson(res, 400, { ok: false, error: "card 形态不对：{mid: UP卡片} 映射" });
            return;
          }
          for (const [mid, entry] of Object.entries(cardPatch)) {
            if (!isRecord(entry) || typeof entry["name"] !== "string") {
              sendJson(res, 400, { ok: false, error: "card 的值须是 UP 卡片（含 name）" });
              return;
            }
            current.cardIndex.set(mid, {
              mid: Number(mid),
              name: String(entry["name"]),
              fans: typeof entry["fans"] === "number" ? entry["fans"] : 0,
              current_level: typeof entry["current_level"] === "number" ? entry["current_level"] : 0,
              official_type: typeof entry["official_type"] === "number" ? entry["official_type"] : -1,
              ...(typeof entry["official_desc"] === "string" ? { official_desc: entry["official_desc"] } : {}),
            });
          }
          replaced.push("card");
        }
        if (body["spi"] !== undefined) {
          const spiPatch = body["spi"];
          if (!(isRecord(spiPatch) && typeof spiPatch["b_3"] === "string")) {
            sendJson(res, 400, { ok: false, error: "spi 形态不对：{b_3, b_4?}" });
            return;
          }
          current.spi = { b_3: String(spiPatch["b_3"]), ...(spiPatch["b_4"] !== undefined ? { b_4: String(spiPatch["b_4"]) } : {}) };
          replaced.push("spi");
        }
        console.log(`[faux-bili] /refresh 替换：${replaced.join("、") || "（空 body，无变化）"}`);
        sendJson(res, 200, { ok: true, replaced, items: { list: current.list.length, view: current.viewIndex.size, card: current.cardIndex.size, reply: current.replyIndex.size, dm: current.dmIndex.size } });
      })
      .catch((error: unknown) => sendJson(res, 500, { ok: false, error: error instanceof Error ? error.message : String(error) }));
    return;
  }

  // —— 白名单端点（路径照抄 endpointUrl 的拼法）——
  if (path === "/x/web-interface/popular" || path === "/x/web-interface/ranking/v2") {
    envelope(res, { list: current.list, no_more: false });
    return;
  }
  if (path === "/x/web-interface/view") {
    const bvid = url.searchParams.get("bvid") ?? "";
    const card = current.viewIndex.get(bvid);
    if (card === undefined) {
      envelopeError(res, -404, "啥都木有");
      return;
    }
    envelope(res, card);
    return;
  }
  if (path === "/x/v1/dm/list.so") {
    const oid = url.searchParams.get("oid") ?? "";
    const xml = current.dmIndex.get(oid) ?? dmXml(oid);
    res.writeHead(200, { "Content-Type": "text/xml; charset=utf-8" });
    res.end(xml);
    return;
  }
  if (path === "/x/v2/reply/main") {
    const oid = url.searchParams.get("oid") ?? "";
    envelope(res, replyEnvelope(current.replyIndex.get(oid) ?? []));
    return;
  }
  if (path === "/x/web-interface/card") {
    const mid = url.searchParams.get("mid") ?? "";
    const entry = current.cardIndex.get(mid);
    if (entry === undefined) {
      envelopeError(res, -400, "请求错误");
      return;
    }
    envelope(res, upCardEnvelope(entry));
    return;
  }
  if (path === "/x/frontend/finger/spi") {
    envelope(res, current.spi);
    return;
  }
  sendJson(res, 404, { code: 404, message: `未知路径 ${path}（仅白名单七端点 + /refresh /fixtures /health）` });
});

// ── 退出 ─────────────────────────────────────────────────────────────────────

function shutdown(signal: string): void {
  console.log(`[faux-bili] 收到 ${signal}，关闭`);
  server.close(() => process.exit(0));
  setTimeout(() => process.exit(0), 1000).unref();
}
process.on("SIGINT", () => shutdown("SIGINT"));
process.on("SIGTERM", () => shutdown("SIGTERM"));

server.on("error", (error: NodeJS.ErrnoException) => {
  console.error(`[faux-bili] 起服务失败：${error.code === "EADDRINUSE" ? `端口 ${PORT} 已被占用` : error.message}`);
  process.exit(1);
});
server.listen(PORT, "127.0.0.1", () => {
  console.log(`[faux-bili] 就绪 http://127.0.0.1:${PORT}/x/web-interface/popular（白名单七端点；POST /refresh 换 fixture）`);
});
