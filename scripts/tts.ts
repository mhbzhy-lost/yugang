/**
 * 语音服务管理：macmini 上 3 个 GPT-SoVITS 实例由 launchd 托管
 * （~/Library/LaunchAgents/com.yugang.tts*.plist，RunAtLoad=false 不开机自启，
 * KeepAlive 崩溃自愈）。实例随鱼缸启动链拉起（scripts/up.ts、scripts/deploy.ts
 * 都会顺带跑一次本脚本的 up），本脚本也给人一个统一运维入口：
 *
 *   npm run tts              # = tts status：实例表格；有异常 exit 1
 *   npm run tts status
 *   npm run tts up           # 未监听的实例 load + kickstart，等模型加载（≤90s/实例）；已监听跳过
 *   npm run tts down         # 全部 launchctl unload（慎用：语音能力整体下线）
 *
 * 本地开发机没有这些 plist：任何子命令都提示一句后 exit 0。
 */
import { spawnSync } from "node:child_process";
import { readdirSync } from "node:fs";
import { basename, join } from "node:path";
import { Socket } from "node:net";

const AGENT_DIR = join(process.env.HOME ?? "", "Library", "LaunchAgents");
const HOST = "127.0.0.1";
const PROBE_TIMEOUT_MS = 500;
const LOAD_TIMEOUT_MS = 90_000;
const POLL_INTERVAL_MS = 2_000;

type Instance = {
  label: string;
  path: string;
  port?: number;
  sovits?: string;
  gpt?: string;
};

/** 扫 ~/Library/LaunchAgents/com.yugang.tts*.plist，plutil 转 JSON 后取字段；目录不存在返回 [] */
function discover(): Instance[] {
  let files: string[];
  try {
    files = readdirSync(AGENT_DIR)
      .filter((f) => /^com\.yugang\.tts.*\.plist$/.test(f))
      .sort();
  } catch {
    return [];
  }
  return files.map((file) => {
    const path = join(AGENT_DIR, file);
    let doc: any = {};
    try {
      const out = spawnSync("plutil", ["-convert", "json", "-o", "-", path], { encoding: "utf8", maxBuffer: 1 << 20 });
      if (out.status === 0 && out.stdout) doc = JSON.parse(out.stdout);
    } catch {
      // plist 读不动：按缺字段处理，status 表格里会显示异常
    }
    const args: string[] = Array.isArray(doc.ProgramArguments) ? doc.ProgramArguments : [];
    const port = Number(argValue(args, "-p"));
    return {
      label: typeof doc.Label === "string" ? doc.Label : file.replace(/\.plist$/, ""),
      path,
      port: Number.isInteger(port) && port > 0 ? port : undefined,
      sovits: shortModel(argValue(args, "-s")),
      gpt: shortModel(argValue(args, "-g")),
    };
  });
}

function argValue(args: string[], flag: string): string | undefined {
  const i = args.indexOf(flag);
  return i >= 0 && i + 1 < args.length ? args[i + 1] : undefined;
}

function shortModel(p?: string): string | undefined {
  return p ? basename(p).replace(/\.(pth|ckpt)$/i, "") : undefined;
}

/** launchctl 退出码 */
function launchctl(args: string[]): number | null {
  return spawnSync("launchctl", args, { stdio: "ignore" }).status;
}

/** plist 加载态：launchctl print 能查到这个 label 才算已加载 */
function isLoaded(label: string): boolean {
  return launchctl(["print", `gui/${process.getuid()}/${label}`]) === 0;
}

/** TCP 探活：连上=在监听；拒绝/超时/其它错误=没在监听 */
function probePort(port: number, timeoutMs = PROBE_TIMEOUT_MS): Promise<boolean> {
  return new Promise((resolveProbe) => {
    const socket = new Socket();
    let settled = false;
    const finish = (listening: boolean) => {
      if (settled) return;
      settled = true;
      socket.destroy();
      resolveProbe(listening);
    };
    socket.once("connect", () => finish(true));
    socket.once("error", () => finish(false));
    socket.once("timeout", () => finish(false));
    socket.connect(port, HOST);
    socket.setTimeout(timeoutMs);
    setTimeout(() => finish(false), timeoutMs).unref?.();
  });
}

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

/** 轮询等端口监听，返回等待的毫秒数；超时返回 null */
async function waitListening(port: number, timeoutMs: number): Promise<number | null> {
  const started = Date.now();
  for (;;) {
    if (await probePort(port)) return Date.now() - started;
    const waited = Date.now() - started;
    if (waited >= timeoutMs) return (await probePort(port)) ? waited : null;
    await sleep(Math.min(POLL_INTERVAL_MS, timeoutMs - waited));
  }
}

// 中文字符按显示宽度 2 列算，表格才对得齐
function width(s: string): number {
  return [...s].reduce((n, ch) => n + ((ch.codePointAt(0) ?? 0) > 0xff ? 2 : 1), 0);
}
function pad(s: string, n: number): string {
  return s + " ".repeat(Math.max(0, n - width(s)));
}

function modelText(inst: Instance): string {
  return `${inst.sovits ?? "?"} / ${inst.gpt ?? "?"}`;
}

function emptyDir(): never {
  console.log("未发现语音服务 plist（本机非生产机？）");
  process.exit(0);
}

async function status(): Promise<number> {
  const instances = discover();
  if (!instances.length) emptyDir();

  const rows = [];
  for (const inst of instances) {
    rows.push({
      inst,
      listening: inst.port ? await probePort(inst.port) : false,
      loaded: isLoaded(inst.label),
    });
  }

  const wLabel = Math.max(width("label"), ...rows.map((r) => width(r.inst.label)));
  const wPort = Math.max(width("端口"), ...rows.map((r) => width(String(r.inst.port ?? "无"))));
  const wModel = Math.max(width("模型(SoVITS/GPT)"), ...rows.map((r) => width(modelText(r.inst))));

  console.log(`语音实例（${join(AGENT_DIR, "com.yugang.tts*.plist")}）\n`);
  console.log(`${pad("label", wLabel)}  ${pad("端口", wPort)}  ${pad("模型(SoVITS/GPT)", wModel)}  LISTEN  加载`);
  for (const r of rows) {
    console.log(
      `${pad(r.inst.label, wLabel)}  ${pad(String(r.inst.port ?? "无"), wPort)}  ${pad(modelText(r.inst), wModel)}  ${pad(r.listening ? "✓" : "✗", "LISTEN".length)}  ${r.loaded ? "✓" : "✗"}`,
    );
  }

  const bad = rows.filter((r) => !r.listening || !r.loaded);
  if (!bad.length) {
    console.log(`\n${rows.length}/${rows.length} 全部健康（监听中 + plist 已加载）`);
    return 0;
  }
  console.log(`\n${rows.length - bad.length}/${rows.length} 健康；异常：${bad.map((r) => r.inst.label).join("、")}`);
  console.log("拉起用 npm run tts up");
  return 1;
}

/** 把一个未监听的实例拉起来：没加载先 load，再 kickstart，轮询等端口（≤90s） */
async function bringUp(inst: Instance): Promise<string> {
  if (!isLoaded(inst.label) && launchctl(["load", inst.path]) !== 0)
    return `✗ ${inst.label}  launchctl load 失败`;
  if (launchctl(["kickstart", "-k", `gui/${process.getuid()}/${inst.label}`]) !== 0)
    return `✗ ${inst.label}  launchctl kickstart 失败`;
  const waited = await waitListening(inst.port!, LOAD_TIMEOUT_MS);
  return waited === null
    ? `✗ ${inst.label}  ${LOAD_TIMEOUT_MS / 1000}s 内端口没起来（模型可能仍在加载），稍后 npm run tts status 复查`
    : `✓ ${inst.label}  端口 ${inst.port} 已监听（等了 ${(waited / 1000).toFixed(0)}s）`;
}

async function up(): Promise<number> {
  const instances = discover();
  if (!instances.length) emptyDir();

  const results: string[] = [];
  const pending: Promise<void>[] = [];
  for (const inst of instances) {
    if (!inst.port) {
      results.push(`✗ ${inst.label}  plist 解析不到端口（-p）`);
      continue;
    }
    if (await probePort(inst.port)) {
      results.push(`✓ ${inst.label}  端口 ${inst.port} 已监听，跳过`);
      continue;
    }
    pending.push(bringUp(inst).then((line) => results.push(line)));
  }
  if (pending.length) console.log(`拉起 ${pending.length} 个实例，等模型加载（上限 ${LOAD_TIMEOUT_MS / 1000}s）…`);
  await Promise.all(pending);

  for (const line of results) console.log(line);
  const fail = results.filter((l) => l.startsWith("✗")).length;
  const ok = results.length - fail;
  console.log(`\n${ok}/${instances.length} 在监听${fail ? `，${fail} 个异常` : "，全部就绪"}`);
  return fail ? 1 : 0;
}

function down(): number {
  const instances = discover();
  if (!instances.length) emptyDir();

  let fail = 0;
  for (const inst of instances) {
    const rc = launchctl(["unload", inst.path]);
    console.log(`${rc === 0 ? "✓" : "✗"} ${inst.label}  launchctl unload 退出码 ${rc}`);
    if (rc !== 0) fail++;
  }
  console.log(`\n${instances.length - fail}/${instances.length} 已卸载`);
  return fail ? 1 : 0;
}

const [command = "status"] = process.argv.slice(2);

if (command === "status") {
  process.exit(await status());
} else if (command === "up") {
  process.exit(await up());
} else if (command === "down") {
  process.exit(down());
} else {
  console.error(`不认识的命令：${command}`);
  console.error("用法：npm run tts [status|up|down]");
  process.exit(1);
}
