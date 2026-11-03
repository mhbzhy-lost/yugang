/**
 * faux 60s —— 自建 60s 新闻服务的本地替身（IT bed Task I2）。
 *
 * 协议结论（2026-11-03 逐行核对 src/external/news-client.ts 后照实模拟，vikiboss/60s v2 形态）：
 * - 源端点：/v2/60s、/v2/weibo、/v2/baidu/hot 三个 GET；信封一律 {code, message?, data}，
 *   客户端只认 code===200（parse60s/parseHotList），非 200 抛错走单源降级。
 * - /v2/60s：data.news 是字符串或 {title,link,description} 混排数组；全天共用 data.link
 *   这篇 canonical 文章；data.date / data.created_at 充当 publishedAt。
 * - /v2/weibo、/v2/baidu/hot：data 是条目数组，字段宽容取——标题 title|word|query，
 *   链接 url|link|url_m|url_pc，简介 desc|detail。
 * - URL 一律 https（客户端 sanitizeUrl 只留 http/https，非 https 会被丢弃）。
 *
 * 单文件零依赖（同 faux NapCat 风格）：node:http 起服务，fixture 全部内存固定值。
 *
 * 用法：
 *   node scripts/itbed/faux/sixty.ts [--port 4399]
 *   环境变量 FAUX_SIXTY_PORT 同样生效，CLI 优先。缺省端口 4399 与生产缺省
 *   （DEFAULT_60S_API_ROOT，loopback 4399）一致，单跑即可无缝替身；IT bed launch
 *   会显式传 --port（port-base+1），与真服务并存不冲突。
 *
 * fixture 替换（POST /refresh，JSON，按键部分替换，内存态不落盘）：
 *   {"sixty":  {"news": [...], "link": "https://…", "date": "YYYY-MM-DD"},
 *    "weibo":  [{"title":"…","url":"https://…","desc":"…"}, …]（非空数组）,
 *    "baidu":  同 weibo 形态}
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

const PORT = num(argValue("port") ?? process.env["FAUX_SIXTY_PORT"], 4399);

// ── 固定 fixture（IT bed 冒烟样本：条目稳定、URL 全 https、无真实新闻）──────

/** 固定的「今天」（fixture 不随真实日期漂移，断言可复现）。 */
const FIXTURE_DATE = "2026-11-03";

interface SixtyFixture {
  news: (string | { title: string; link?: string; description?: string })[];
  link?: string;
  date?: string;
}
interface HotItem {
  title: string;
  url: string;
  desc?: string;
  created_at?: string;
}

const SIXTY_DEFAULT: SixtyFixture = {
  date: FIXTURE_DATE,
  link: "https://example.com/60s/2026-11-03",
  news: [
    "工信部发布 IT bed 冒烟测试指南， faux 服务全面试点",
    { title: "本地沙箱完成首轮注入演练", link: "https://example.com/60s/item-2", description: "出站记录核对无误。" },
    "国内首个「零真实上游」测试床投入运行",
    { title: "码头集装箱调度算法开源", link: "https://example.com/60s/item-4" },
    "多模态模型在离线环境完成一致性比对",
    "科研团队实现 60 秒读完当日要闻的自动化管线",
    { title: "港口晨雾预警解除， 通航恢复正常", link: "https://example.com/60s/item-7", description: "能见度回升至 5 海里。" },
    "开源社区发布《替身服务编写规范》1.0",
    "全国统一测试群号 424242 完成备案登记",
    { title: "AI 群员通过图灵聚会初筛", link: "https://example.com/60s/item-10", description: "评委未察觉异样。" },
  ],
};

const WEIBO_DEFAULT: HotItem[] = [
  { title: " faux 服务上了热搜第一", url: "https://example.com/weibo/1", desc: "原因：太稳了。" },
  { title: " 测试床日更宠粉", url: "https://example.com/weibo/2" },
  { title: " 零依赖 HTTP 服务怎么写", url: "https://example.com/weibo/3", desc: "node:http 党狂喜。" },
  { title: " 沙箱隔离到底隔离了什么", url: "https://example.com/weibo/4" },
  { title: " 出站记录 JSONL 成为新潮流", url: "https://example.com/weibo/5" },
  { title: " 固定 fixture 让断言不再漂", url: "https://example.com/weibo/6" },
  { title: " 端口参数化的艺术", url: "https://example.com/weibo/7" },
  { title: " IT bed 的 100 种打开方式", url: "https://example.com/weibo/8" },
  { title: " 假上游，真行为", url: "https://example.com/weibo/9" },
  { title: " 冒烟测试为什么要限时", url: "https://example.com/weibo/10" },
];

const BAIDU_DEFAULT: HotItem[] = [
  { title: " faux 60s 服务正式上线", url: "https://example.com/baidu/1", desc: "本地回环 4399。" },
  { title: " 新鲜事：沙箱今天很干净", url: "https://example.com/baidu/2" },
  { title: " 热榜条目固定不变引热议", url: "https://example.com/baidu/3", desc: "官方回应：fixture 而已。" },
  { title: " 降级链路演习成功", url: "https://example.com/baidu/4" },
  { title: " 单源失败不阻断兄弟源", url: "https://example.com/baidu/5" },
  { title: " 探活状态只在内存", url: "https://example.com/baidu/6" },
  { title: " 端口被占用怎么办", url: "https://example.com/baidu/7", desc: "换一个。" },
  { title: " curl 自测的正确姿势", url: "https://example.com/baidu/8" },
  { title: " SIGTERM 之后没有残留进程", url: "https://example.com/baidu/9" },
  { title: " IT bed：把生产搬进笔记本", url: "https://example.com/baidu/10" },
];

/** 当前生效 fixture：/refresh 只动这里，进程重启即回默认。 */
const current = {
  sixty: SIXTY_DEFAULT,
  weibo: WEIBO_DEFAULT,
  baidu: BAIDU_DEFAULT,
};

// ── fixture 校验与替换 ───────────────────────────────────────────────────────

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

/** weibo/baidu 条目：至少要有非空 title（客户端还会宽容取 word/query，这里从严收口）。 */
function validHotItems(value: unknown): value is HotItem[] {
  return (
    Array.isArray(value) &&
    value.length > 0 &&
    value.every((item) => isRecord(item) && typeof item["title"] === "string" && item["title"].length > 0)
  );
}

/** /v2/60s 形态：news 非空（客户端拿到空数组会抛「60s 无可用条目」），date/link 字符串。 */
function validSixty(value: unknown): value is SixtyFixture {
  if (!isRecord(value)) return false;
  const news = value["news"];
  if (!Array.isArray(news) || news.length === 0) return false;
  const okNews = news.every((entry) => typeof entry === "string" || (isRecord(entry) && typeof entry["title"] === "string" && entry["title"].length > 0));
  if (!okNews) return false;
  if (value["link"] !== undefined && typeof value["link"] !== "string") return false;
  if (value["date"] !== undefined && typeof value["date"] !== "string") return false;
  return true;
}

// ── HTTP 服务 ────────────────────────────────────────────────────────────────

function sendJson(res: ServerResponse, status: number, body: unknown): void {
  const payload = JSON.stringify(body);
  res.writeHead(status, { "Content-Type": "application/json; charset=utf-8", "Content-Length": Buffer.byteLength(payload) });
  res.end(payload);
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

function hotEnvelope(items: HotItem[]): { code: number; message: string; data: HotItem[] } {
  return { code: 200, message: "success", data: items };
}

const server = createServer((req, res) => {
  const url = new URL(req.url ?? "/", `http://127.0.0.1:${PORT}`);
  const path = url.pathname.replace(/\/+$/, "") || "/";

  if (path === "/health") {
    sendJson(res, 200, {
      ok: true,
      service: "faux-60s",
      items: { sixty: current.sixty.news.length, weibo: current.weibo.length, baidu: current.baidu.length },
      uptimeMs: Math.round(process.uptime() * 1000),
    });
    return;
  }
  if (path === "/v2/60s" && req.method === "GET") {
    sendJson(res, 200, { code: 200, message: "success", data: current.sixty });
    return;
  }
  if (path === "/v2/weibo" && req.method === "GET") {
    sendJson(res, 200, hotEnvelope(current.weibo));
    return;
  }
  if (path === "/v2/baidu/hot" && req.method === "GET") {
    sendJson(res, 200, hotEnvelope(current.baidu));
    return;
  }
  if (path === "/fixtures" && req.method === "GET") {
    sendJson(res, 200, { sixty: current.sixty, weibo: current.weibo, baidu: current.baidu });
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
          sendJson(res, 400, { ok: false, error: "body 须是对象：{sixty?, weibo?, baidu?}" });
          return;
        }
        const unknownKeys = Object.keys(body).filter((k) => k !== "sixty" && k !== "weibo" && k !== "baidu");
        if (unknownKeys.length > 0) {
          sendJson(res, 400, { ok: false, error: `不认识的键：${unknownKeys.join(", ")}（只认 sixty/weibo/baidu）` });
          return;
        }
        if (body["sixty"] !== undefined && !validSixty(body["sixty"])) {
          sendJson(res, 400, { ok: false, error: "sixty 形态不对：{news: 非空数组, link?, date?}" });
          return;
        }
        if (body["weibo"] !== undefined && !validHotItems(body["weibo"])) {
          sendJson(res, 400, { ok: false, error: "weibo 形态不对：非空数组，条目至少含非空 title" });
          return;
        }
        if (body["baidu"] !== undefined && !validHotItems(body["baidu"])) {
          sendJson(res, 400, { ok: false, error: "baidu 形态不对：非空数组，条目至少含非空 title" });
          return;
        }
        const replaced: string[] = [];
        if (body["sixty"] !== undefined) {
          const patch = body["sixty"] as SixtyFixture;
          current.sixty = {
            news: patch.news,
            ...(patch.link !== undefined ? { link: patch.link } : {}),
            ...(patch.date !== undefined ? { date: patch.date } : {}),
          };
          replaced.push("sixty");
        }
        if (body["weibo"] !== undefined) {
          current.weibo = body["weibo"] as HotItem[];
          replaced.push("weibo");
        }
        if (body["baidu"] !== undefined) {
          current.baidu = body["baidu"] as HotItem[];
          replaced.push("baidu");
        }
        console.log(`[faux-60s] /refresh 替换：${replaced.join("、") || "（空 body，无变化）"}`);
        sendJson(res, 200, {
          ok: true,
          replaced,
          items: { sixty: current.sixty.news.length, weibo: current.weibo.length, baidu: current.baidu.length },
        });
      })
      .catch((error: unknown) => sendJson(res, 500, { ok: false, error: error instanceof Error ? error.message : String(error) }));
    return;
  }
  sendJson(res, 404, { code: 404, message: `未知路径 ${path}（可用：/v2/60s /v2/weibo /v2/baidu/hot /refresh /fixtures /health）` });
});

// ── 退出 ─────────────────────────────────────────────────────────────────────

function shutdown(signal: string): void {
  console.log(`[faux-60s] 收到 ${signal}，关闭`);
  server.close(() => process.exit(0));
  setTimeout(() => process.exit(0), 1000).unref();
}
process.on("SIGINT", () => shutdown("SIGINT"));
process.on("SIGTERM", () => shutdown("SIGTERM"));

server.on("error", (error: NodeJS.ErrnoException) => {
  console.error(`[faux-60s] 起服务失败：${error.code === "EADDRINUSE" ? `端口 ${PORT} 已被占用` : error.message}`);
  process.exit(1);
});
server.listen(PORT, "127.0.0.1", () => {
  console.log(`[faux-60s] 就绪 http://127.0.0.1:${PORT}/v2/60s（+ /v2/weibo、/v2/baidu/hot；POST /refresh 换 fixture）`);
});
