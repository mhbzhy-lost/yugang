/**
 * IT bed 断言库（Task I3）—— 出站/日志断言的纯逻辑层（无 IO、无子进程，可独立自测）。
 *
 * 数据模型（驱动器 driver.ts 负责采集与时间归属，本库只做窗口/匹配/判定）：
 *   - outbound.jsonl 每行一条 JSON（faux NapCat 落盘：{at, action, params, echo, messageId?}），
 *     驱动器按行解析并以记录的 at 字段归属 atMs（相对场景 t0 的毫秒，精确）；
 *   - fish.log 行本身无时间戳，驱动器以 ~250ms 轮询归属时间（近似，±250ms 分辨率）。
 *   两类条目统一为 AttributedEntry；atMs=null（无法归属时间）的条目只参与无界窗口
 *   （afterMs/withinMs 均未指定的全程窗口），避免把未知时间的条目误判进有界窗口。
 *
 * expect 结构（normalizeExpect 校验并归一）：
 *   { kind: "outbound" | "log" | "none",
 *     match?: 字符串（子串）| {regex, flags?} | {field, equals?/contains?/regex?/exists?/min?/max?}
 *           | {fields: {点路径: 条件|字符串|数字}}（多字段 AND）,
 *     afterMs?, withinMs?, count?, minIntervalMs?, desc? }
 *   - 窗口 [afterMs(缺省 0), withinMs(缺省 ∞))，毫秒均相对场景 t0；
 *   - outbound/log 必须给 match 或 count 二者其一；
 *   - count：命中数恰等于该值（不给 match 时按窗口内全部条目计数）；
 *   - minIntervalMs：命中条目按时间排序后相邻间隔都必须 ≥ 该值（配速类断言）；
 *   - none：窗口内出站与日志都不得出现匹配（给 match 按匹配计；不给则任何条目都算违例），
 *     与 count/minIntervalMs 互斥。
 *
 * 证据红线：所有进入报告/证据的文本一律先 redact()（token/authorization/secret/password
 * 掩码）+ clip() 截断；匹配仍在原始文本上进行，本库只对展示掩码、不做判定。
 */

// ── 类型 ─────────────────────────────────────────────────────────────────────

/** 带时间归属的条目（atMs 相对场景 t0 的毫秒；null=无法归属）。 */
export interface AttributedEntry {
  atMs: number | null;
  /** 原始行文本（outbound 为 JSONL 行，log 为鱼日志行）。 */
  text: string;
  /** outbound 行解析出的 JSON；解析失败/日志行则缺省。 */
  json?: unknown;
  /** 条目来源（证据标注用）。 */
  source?: "outbound" | "log";
}

/** 字段条件：至少一个键；对点路径取值做子集匹配。 */
export interface FieldCond {
  equals?: unknown;
  contains?: string | number;
  regex?: string;
  flags?: string;
  exists?: boolean;
  min?: number;
  max?: number;
}

/** match 的归一形态。 */
export type MatchSpec =
  | { kind: "text"; text: string }
  | { kind: "regex"; regex: RegExp }
  | { kind: "field"; field: string; cond: FieldCond }
  | { kind: "fields"; fields: { field: string; cond: FieldCond }[] };

/** 归一后的 expect。 */
export interface ExpectSpec {
  kind: "outbound" | "log" | "none";
  match?: MatchSpec;
  afterMs?: number;
  withinMs?: number;
  count?: number;
  minIntervalMs?: number;
  desc?: string;
}

/** 单条断言结果。 */
export interface ExpectResult {
  index: number;
  kind: string;
  desc: string;
  pass: boolean;
  /** 一行判定说明（窗口/命中数/失败原因）。 */
  detail: string;
  /** 失败时的有限证据片段（已 redact + clip）。 */
  evidence: string[];
}

export interface ExpectView {
  outbound: AttributedEntry[];
  log: AttributedEntry[];
}

// ── 证据卫生：redact / clip ──────────────────────────────────────────────────

const SECRET_KEY_JSON_RE = /("(?:[^"]*(?:token|authorization|secret|password)[^"]*)"\s*:\s*")[^"]*(")/gi;
const SECRET_KV_RE = /((?:token|authorization|secret|password)\s*[=:])\s*[^\s&"']+/gi;
/** IT bed 固定测试 token（faux NapCat --token 与 ONEBOT_TOKEN 同值）；按字面值掩码。 */
const KNOWN_TEST_SECRETS = ["itbed-faux-token"];

/** 掩码一切疑似凭据的片段（仅用于展示；匹配逻辑不经过本函数）。 */
export function redact(text: string): string {
  let out = text.replace(SECRET_KEY_JSON_RE, "$1<redacted>$2");
  out = out.replace(SECRET_KV_RE, "$1<redacted>");
  for (const known of KNOWN_TEST_SECRETS) out = out.split(known).join("<redacted>");
  return out;
}

/** 证据截断：压成单行、限长（缺省 240 字符）。 */
export function clip(text: string, max = 240): string {
  const oneLine = text.replace(/\n/g, "\\n").replace(/\r/g, "");
  return oneLine.length > max ? `${oneLine.slice(0, max)}…` : oneLine;
}

// ── 归一：match / expect ─────────────────────────────────────────────────────

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function compileRegex(source: string, flags: string | undefined, where: string): RegExp {
  if (typeof source !== "string" || source.length === 0) throw new Error(`${where}：regex 须为非空字符串`);
  try {
    return new RegExp(source, flags);
  } catch (error) {
    throw new Error(`${where}：regex 编译失败（${error instanceof Error ? error.message : String(error)}）`);
  }
}

/** 归一字段条件；至少一个条件键，regex 须可编译。 */
function normalizeCond(raw: unknown, where: string): FieldCond {
  if (typeof raw === "string" || typeof raw === "number") return { equals: raw };
  if (!isPlainObject(raw)) throw new Error(`${where}：字段条件须为字符串/数字/对象`);
  const cond: FieldCond = {};
  let hasAny = false;
  if (raw["equals"] !== undefined) { cond.equals = raw["equals"]; hasAny = true; }
  if (raw["contains"] !== undefined) { cond.contains = raw["contains"]; hasAny = true; }
  if (raw["exists"] !== undefined) {
    if (typeof raw["exists"] !== "boolean") throw new Error(`${where}：exists 须为布尔`);
    cond.exists = raw["exists"];
    hasAny = true;
  }
  for (const key of ["min", "max"] as const) {
    if (raw[key] !== undefined) {
      if (typeof raw[key] !== "number" || !Number.isFinite(raw[key])) throw new Error(`${where}：${key} 须为有限数字`);
      cond[key] = raw[key];
      hasAny = true;
    }
  }
  if (raw["regex"] !== undefined) {
    cond.regex = raw["regex"];
    cond.flags = typeof raw["flags"] === "string" ? raw["flags"] : undefined;
    compileRegex(cond.regex, cond.flags, where);
    hasAny = true;
  }
  if (!hasAny) throw new Error(`${where}：字段条件至少要 equals/contains/regex/exists/min/max 其一`);
  return cond;
}

/** 归一 match：字符串=子串；对象按 field（条件键同级）| fields | regex（无 field 时）三分。 */
export function normalizeMatch(raw: unknown, where = "match"): MatchSpec {
  if (typeof raw === "string") {
    if (raw.length === 0) throw new Error(`${where}：字符串 match 不能为空`);
    return { kind: "text", text: raw };
  }
  if (!isPlainObject(raw)) throw new Error(`${where}：须为字符串或对象`);
  if (raw["field"] !== undefined) {
    // field 规格：field + 同级的条件键（equals/contains/regex/exists/min/max/flags）
    const field = raw["field"];
    if (typeof field !== "string" || field.length === 0) throw new Error(`${where}：field 须为非空点路径`);
    if (raw["fields"] !== undefined) throw new Error(`${where}：field 与 fields 不能同时给`);
    const condRaw = { ...raw } as Record<string, unknown>;
    delete condRaw["field"];
    return { kind: "field", field, cond: normalizeCond(condRaw, where) };
  }
  if (raw["fields"] !== undefined) {
    const fieldsRaw = raw["fields"];
    if (!isPlainObject(fieldsRaw) || Object.keys(fieldsRaw).length === 0) {
      throw new Error(`${where}：fields 须为非空对象`);
    }
    const fields = Object.entries(fieldsRaw).map(([field, condRaw]) => {
      if (field.length === 0) throw new Error(`${where}：fields 的字段名不能为空`);
      return { field, cond: normalizeCond(condRaw, `${where}.fields.${field}`) };
    });
    return { kind: "fields", fields };
  }
  if (raw["regex"] !== undefined) {
    const flags = raw["flags"];
    if (flags !== undefined && typeof flags !== "string") throw new Error(`${where}：flags 须为字符串`);
    return { kind: "regex", regex: compileRegex(String(raw["regex"]), flags, where) };
  }
  throw new Error(`${where}：对象 match 须含 field / fields / regex 其一`);
}

function intInRange(raw: unknown, min: number, where: string): number {
  if (typeof raw !== "number" || !Number.isInteger(raw) || raw < min) {
    throw new Error(`${where}：须为 ≥${min} 的整数`);
  }
  return raw;
}

/** 校验并归一单个 expect；不合法抛错（消息含定位前缀）。 */
export function normalizeExpect(raw: unknown, where = "expect"): ExpectSpec {
  if (!isPlainObject(raw)) throw new Error(`${where}：须为对象`);
  const kind = raw["kind"];
  if (kind !== "outbound" && kind !== "log" && kind !== "none") {
    throw new Error(`${where}：kind 须为 outbound | log | none（收到 ${JSON.stringify(kind)}）`);
  }
  const spec: ExpectSpec = { kind };
  if (raw["desc"] !== undefined) {
    if (typeof raw["desc"] !== "string") throw new Error(`${where}：desc 须为字符串`);
    spec.desc = raw["desc"];
  }
  if (raw["match"] !== undefined) spec.match = normalizeMatch(raw["match"], `${where}.match`);
  if (raw["afterMs"] !== undefined) spec.afterMs = intInRange(raw["afterMs"], 0, `${where}.afterMs`);
  if (raw["withinMs"] !== undefined) spec.withinMs = intInRange(raw["withinMs"], 1, `${where}.withinMs`);
  if (raw["count"] !== undefined) spec.count = intInRange(raw["count"], 0, `${where}.count`);
  if (raw["minIntervalMs"] !== undefined) spec.minIntervalMs = intInRange(raw["minIntervalMs"], 1, `${where}.minIntervalMs`);
  if (kind === "none") {
    if (spec.count !== undefined) throw new Error(`${where}：none 断言不能带 count（none 就是「零匹配」）`);
    if (spec.minIntervalMs !== undefined) throw new Error(`${where}：none 断言不能带 minIntervalMs`);
  } else if (spec.match === undefined && spec.count === undefined) {
    throw new Error(`${where}：${kind} 断言须给 match 或 count 至少其一`);
  }
  return spec;
}

// ── 匹配 ─────────────────────────────────────────────────────────────────────

function fieldGet(json: unknown, path: string): { found: boolean; value: unknown } {
  let current: unknown = json;
  for (const key of path.split(".")) {
    if (current === null || typeof current !== "object") return { found: false, value: undefined };
    current = (current as Record<string, unknown>)[key];
  }
  return { found: true, value: current };
}

function condPass(cond: FieldCond, value: unknown): boolean {
  if (cond.exists !== undefined && (value !== undefined) !== cond.exists) return false;
  if (cond.equals !== undefined && value !== cond.equals) return false;
  if (cond.contains !== undefined && !String(value ?? "").includes(String(cond.contains))) return false;
  if (cond.regex !== undefined && !compileRegex(cond.regex, cond.flags, "cond").test(String(value ?? ""))) return false;
  if (cond.min !== undefined && !(typeof value === "number" && value >= cond.min)) return false;
  if (cond.max !== undefined && !(typeof value === "number" && value <= cond.max)) return false;
  return true;
}

/** match → 谓词；match 缺省返回 null（匹配一切）。 */
export function makeMatcher(match: MatchSpec | undefined): ((entry: AttributedEntry) => boolean) | null {
  if (match === undefined) return null;
  if (match.kind === "text") return (entry) => entry.text.includes(match.text);
  if (match.kind === "regex") return (entry) => match.regex.test(entry.text);
  if (match.kind === "field") {
    return (entry) => {
      if (entry.json === undefined || entry.json === null) return false;
      const got = fieldGet(entry.json, match.field);
      return condPass(match.cond, got.value);
    };
  }
  return (entry) => {
    if (entry.json === undefined || entry.json === null) return false;
    return match.fields.every(({ field, cond }) => condPass(cond, fieldGet(entry.json, field).value));
  };
}

function windowLabel(expect: ExpectSpec): string {
  const end = expect.withinMs !== undefined ? `${expect.withinMs}` : "∞";
  return `[${expect.afterMs ?? 0},${end})ms`;
}

function inWindow(expect: ExpectSpec, entry: AttributedEntry): boolean {
  const bounded = expect.afterMs !== undefined || expect.withinMs !== undefined;
  if (entry.atMs === null) return !bounded; // 无时间戳条目只参与全程窗口
  if (entry.atMs < (expect.afterMs ?? 0)) return false;
  return expect.withinMs === undefined || entry.atMs < expect.withinMs;
}

// ── 判定 ─────────────────────────────────────────────────────────────────────

function collectEvidence(pass: boolean, matched: AttributedEntry[], inWindowAll: AttributedEntry[]): string[] {
  if (pass) return [];
  const pool = matched.length > 0 ? matched : inWindowAll;
  const evidence = pool.slice(0, 3).map((entry) => {
    const tag = entry.source === "log" ? "[日志]" : "[出站]";
    return `${tag} ${clip(redact(entry.text))}`;
  });
  if (pool.length > 3) evidence.push(`…（窗口内共 ${pool.length} 条，仅示前 3）`);
  return evidence;
}

/** 评测单条 outbound/log 断言。 */
function evaluateMatchExpect(expect: ExpectSpec, index: number, view: ExpectView): ExpectResult {
  const source = expect.kind === "outbound" ? view.outbound : view.log;
  const matcher = makeMatcher(expect.match);
  const inWindowAll = source.filter((entry) => inWindow(expect, entry));
  const matched = matcher === null ? inWindowAll : inWindowAll.filter(matcher);

  const problems: string[] = [];
  if (expect.count !== undefined) {
    if (matched.length !== expect.count) problems.push(`命中 ${matched.length} 条 ≠ 期望 count=${expect.count} 条`);
  } else if (matched.length === 0) {
    problems.push("窗口内无命中");
  }
  if (expect.minIntervalMs !== undefined) {
    const unknownTime = matched.filter((entry) => entry.atMs === null).length;
    if (unknownTime > 0) {
      problems.push(`命中含 ${unknownTime} 条无时间戳条目，无法验证最小间隔`);
    } else {
      const times = matched.map((entry) => entry.atMs as number).sort((a, b) => a - b);
      for (let i = 1; i < times.length; i++) {
        const gap = times[i] - times[i - 1];
        if (gap < expect.minIntervalMs) {
          problems.push(`相邻命中间隔 ${gap}ms < minIntervalMs=${expect.minIntervalMs}ms`);
          break;
        }
      }
    }
  }
  const pass = problems.length === 0;
  const head = `窗口${windowLabel(expect)} 命中 ${matched.length}/${inWindowAll.length} 条`;
  return {
    index,
    kind: expect.kind,
    desc: expect.desc ?? "",
    pass,
    detail: pass ? `${head}：通过` : `${head}；${problems.join("；")}`,
    evidence: collectEvidence(pass, matched, inWindowAll),
  };
}

/** 评测单条 none 断言：窗口内出站与日志都不得出现匹配。 */
function evaluateNoneExpect(expect: ExpectSpec, index: number, view: ExpectView): ExpectResult {
  const matcher = makeMatcher(expect.match);
  const violations = [...view.outbound, ...view.log]
    .filter((entry) => inWindow(expect, entry))
    .filter(matcher ?? (() => true));
  const pass = violations.length === 0;
  const head = `窗口${windowLabel(expect)} 不得出现${expect.match !== undefined ? "匹配条目" : "任何条目"}`;
  return {
    index,
    kind: expect.kind,
    desc: expect.desc ?? "",
    pass,
    detail: pass ? `${head}：通过（0 条）` : `${head}：发现 ${violations.length} 条违例`,
    evidence: violations.slice(0, 3).map((entry) => {
      const tag = entry.source === "log" ? "[日志]" : "[出站]";
      return `${tag} ${clip(redact(entry.text))}`;
    }),
  };
}

/** 评测单条断言（kind 分发）。 */
export function evaluateExpect(expect: ExpectSpec, index: number, view: ExpectView): ExpectResult {
  return expect.kind === "none" ? evaluateNoneExpect(expect, index, view) : evaluateMatchExpect(expect, index, view);
}

/** 评测全部断言。 */
export function evaluateExpects(expects: ExpectSpec[], view: ExpectView): { results: ExpectResult[]; pass: boolean } {
  const results = expects.map((expect, index) => evaluateExpect(expect, index, view));
  return { results, pass: results.every((result) => result.pass) };
}

/** 报告格式化：逐条 PASS/FAIL + 汇总行；证据已 redact + clip。 */
export function formatReport(results: ExpectResult[]): string {
  const lines = results.map((result) => {
    const head = `[itbed-expect] ${result.pass ? "PASS" : "FAIL"} #${result.index + 1} ${result.kind}${result.desc ? ` 「${result.desc}」` : ""} — ${result.detail}`;
    return [head, ...result.evidence.map((evidence) => `    证据: ${evidence}`)].join("\n");
  });
  const passed = results.filter((result) => result.pass).length;
  lines.push(`[itbed-expects] ${passed}/${results.length} PASS`);
  return lines.join("\n");
}
