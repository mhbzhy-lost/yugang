/**
 * 语音服务管理：macmini 上多个 GPT-SoVITS 实例由 launchd 托管
 * （~/Library/LaunchAgents/com.yugang.tts*.plist，RunAtLoad=false 不开机自启，
 * KeepAlive 崩溃自愈）。实例随鱼缸启动链拉起（scripts/up.ts、scripts/deploy.ts
 * 都会顺带跑一次本脚本的 up），本脚本也给人一个统一运维入口：
 *
 *   npm run tts              # = tts status：实例表格；活跃集有异常 exit 1
 *   npm run tts status
 *   npm run tts up           # 活跃集内未监听的实例 load + kickstart，等模型加载（≤90s/实例）；已监听跳过
 *   npm run tts down         # 卸载活跃集（仅人显式调用；遗留 plist 一律不碰）
 *
 * 活跃集 = 仓库根 fish.config.json 的 voices[*].url 端口（生产权威定义，随部署
 * 走配置；换端口只改配置不改代码）。plist 全量扫描展示，按 -p 端口标记活跃/遗留，
 * 遗留实例不参与健康判定、不被 up/down 触碰。
 *
 * 本地开发机没有 fish.config.json：status/up 提示一句后 exit 0，down 拒绝 exit 1。
 */
import { spawnSync } from "node:child_process";
import { readFileSync, readdirSync } from "node:fs";
import { basename, join } from "node:path";
import { Socket } from "node:net";

const AGENT_DIR = join(process.env.HOME ?? "", "Library", "LaunchAgents");
const CONFIG_PATH = join(import.meta.dirname, "..", "fish.config.json");
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
  active: boolean;
};

/** 活跃集端口；配置读不到返回 null（开发机） */
function activePorts(): Set<number> | null {
  let cfg: { voices?: Record<string, { url?: string }> };
  try {
    cfg = JSON.parse(readFileSync(CONFIG_PATH, "utf8"));
  } catch {
    return null;
  }
  const ports = new Set<number>();
  for (const voice of Object.values(cfg.voices ?? {})) {
    try {
      const port = Number(new URL(voice?.url ?? "").port);
      if (Number.isInteger(port) && port > 0) ports.add(port);
    } catch {
      // url 不合法：跳过这条音色
    }
  }
  return ports;
}

function noConfig(action: "status" | "up" | "down"): never {
  if (action === "down") {
    console.error("未发现 fish.config.json（开发机），无活跃集定义，拒绝 down（防误收起生产语音）");
    process.exit(1);
  }
  console.log("未发现 fish.config.json（开发机），无活跃语音实例");
  process.exit(0);
}

/** 扫 ~/Library/LaunchAgents/com.yugang.tts*.plist 全量，plutil 转 JSON 后取字段；目录不存在返回 [] */
function discover(active: Set<number>): Instance[] {
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
      // plist 读不动：按缺字段处理，status 表格里显示为遗留缺端口
    }
    const args: string[] = Array.isArray(doc.ProgramArguments) ? doc.ProgramArguments : [];
    const port = Number(argValue(args, "-p"));
    return {
      label: typeof doc.Label === "string" ? doc.Label : file.replace(/\.plist$/, ""),
      path,
      port: Number.isInteger(port) && port > 0 ? port : undefined,
      sovits: shortModel(argValue(args, "-s")),
      gpt: shortModel(argValue(args, "-g")),
      active: Number.isInteger(port) && port > 0 && active.has(port),
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

async function status(): Promise<number> {
  const active = activePorts();
  if (!active) noConfig("status");

  const instances = discover(active);
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

  console.log(`语音实例（${join(AGENT_DIR, "com.yugang.tts*.plist")}；活跃集 = fish.config.json voices 端口）\n`);
  console.log(
    `${pad("label", wLabel)}  ${pad("端口", wPort)}  ${pad("模型(SoVITS/GPT)", wModel)}  状态  LISTEN  加载`,
  );
  for (const r of rows) {
    console.log(
      `${pad(r.inst.label, wLabel)}  ${pad(String(r.inst.port ?? "无"), wPort)}  ${pad(modelText(r.inst), wModel)}  ${pad(r.inst.active ? "活跃" : "遗留", "状态".length)}  ${pad(r.listening ? "✓" : "✗", "LISTEN".length)}  ${r.loaded ? "✓" : "✗"}`,
    );
  }

  const activeRows = rows.filter((r) => r.inst.active);
  const bad = activeRows.filter((r) => !r.listening);
  const missing = [...active].filter((p) => !rows.some((r) => r.inst.port === p));
  const legacy = rows.length - activeRows.length;

  if (bad.length || missing.length) {
    const names = [...bad.map((r) => r.inst.label), ...missing.map((p) => `端口 ${p}（无 plist）`)];
    console.log(`\n活跃集 ${activeRows.length - bad.length}/${activeRows.length} 在监听；异常：${names.join("、")}`);
    console.log("拉起用 npm run tts up");
    return 1;
  }
  console.log(
    `\n活跃集 ${activeRows.length}/${activeRows.length} 全部监听中${legacy ? `（另有 ${legacy} 个遗留 plist 不参与判定）` : ""}`,
  );
  return 0;
}

/** 把一个未监听的活跃实例拉起来：没加载先 load，再 kickstart，轮询等端口（≤90s） */
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
  const active = activePorts();
  if (!active) noConfig("up");

  const instances = discover(active).filter((inst) => inst.active);
  const results: string[] = [];
  const pending: Promise<void>[] = [];
  for (const port of active) {
    if (!instances.some((inst) => inst.port === port)) results.push(`✗ 端口 ${port}  voices 里有但没有对应 plist`);
  }
  for (const inst of instances) {
    if (!inst.port) {
      results.push(`✗ ${inst.label}  活跃 plist 解析不到端口（-p）`);
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
  console.log(`\n活跃集 ${ok}/${active.size} 在监听${fail ? `，${fail} 个异常` : "，全部就绪"}`);
  return fail ? 1 : 0;
}

function down(): number {
  const active = activePorts();
  if (!active) noConfig("down");

  const instances = discover(active).filter((inst) => inst.active);
  let fail = 0;
  for (const port of active) {
    const inst = instances.find((i) => i.port === port);
    if (!inst) {
      console.log(`- 端口 ${port}  voices 里有但没有对应 plist，跳过`);
      continue;
    }
    if (!isLoaded(inst.label)) {
      console.log(`- ${inst.label}  本来就未加载，跳过`);
      continue;
    }
    const rc = launchctl(["unload", inst.path]);
    console.log(`${rc === 0 ? "✓" : "✗"} ${inst.label}  launchctl unload 退出码 ${rc}`);
    if (rc !== 0) fail++;
  }
  console.log(`\n活跃集卸载完成${fail ? `，${fail} 个失败` : ""}（遗留 plist 未触碰）`);
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
