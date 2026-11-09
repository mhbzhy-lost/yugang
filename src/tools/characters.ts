/**
 * 角色 / 风格 LoRA 词表：唯一事实源是 src/tools/tags/*.json。
 *
 * 分工：
 * - tags 面向模型，回答「这个 key 是什么、触发词是什么、用哪个 LoRA、推荐权重多少」；
 * - draw 面向 ComfyUI，只按 key 取「文件名 + 机械注入串」，不做任何画图决策。
 *
 * 数据不合法直接抛错（坏数据等于启动失败），与词表类数据同款处理，不做静默降级。
 * 模型可见文字只来自 TOOL.md / messages.json，这里不产出任何文案。
 */
import { readFileSync } from "node:fs";

export type EntryGroup = "aigirls" | "honkai3rd" | "style";

export interface CharacterSection {
  readonly title: string;
  readonly tags: string;
  /** 段名别名（如 `herrscher of human`），供 tags 二次命中；只做匹配，不展示。 */
  readonly alias?: readonly string[];
}

export interface CharacterEntry {
  readonly key: string;
  readonly group: EntryGroup;
  readonly name: string;
  /** ComfyUI models/loras 下的文件名（含扩展名）。 */
  readonly lora: string;
  /** draw 机械拼进 positive 的唯一段（style 组为空串）。 */
  readonly inject: string;
  /** 给模型看的建议权重；draw 不消费。 */
  readonly weight: number;
  readonly base: string;
  readonly source: string;
  readonly match: readonly string[];
  /** 该角色在 danbooru 的规范 tag 形式；用于检测「模型把角色 tag 手写进 prompt 却没传 key」。 */
  readonly danbooru: readonly string[];
  readonly sections: readonly CharacterSection[];
}

const GROUPS: readonly EntryGroup[] = ["aigirls", "honkai3rd", "style"];
const KEY_RE = /^[a-z][a-z0-9_]*$/;
const SECTION_LIMIT = 300;
const INJECT_LIMIT = 300;
const WEIGHT_MIN = 0.4;
const WEIGHT_MAX = 1.1;
const FILES = ["./tags/ai-girls.json", "./tags/honkai3rd.json", "./tags/styles.json"] as const;

/** 归一化：全角转半角、小写、下划线/连字符/空白统一成单个空格。 */
export function normalizeKey(raw: string): string {
  return raw.normalize("NFKC").toLowerCase().replace(/[\s_-]+/g, " ").trim();
}

function fail(message: string): never {
  throw new Error(`characters.json: ${message}`);
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function readList(rel: string): unknown[] {
  const parsed: unknown = JSON.parse(readFileSync(new URL(rel, import.meta.url), "utf8"));
  if (!Array.isArray(parsed)) fail(`${rel} 顶层必须是数组`);
  return parsed;
}

function parseEntry(raw: unknown, where: string): CharacterEntry {
  if (!isObject(raw)) fail(`${where} 必须是对象`);
  const key = raw["key"];
  const group = raw["group"];
  if (typeof key !== "string" || !KEY_RE.test(key)) fail(`${where} key 非法`);
  if (typeof group !== "string" || !(GROUPS as readonly string[]).includes(group)) fail(`${where} group 非法`);
  const name = raw["name"];
  if (typeof name !== "string" || !name.trim()) fail(`${where} name 为空`);
  const lora = raw["lora"];
  if (typeof lora !== "string" || !lora.endsWith(".safetensors")) fail(`${where} lora 必须是 .safetensors 文件名`);
  const inject = raw["inject"];
  if (typeof inject !== "string" || inject.length > INJECT_LIMIT) fail(`${where} inject 超过 ${INJECT_LIMIT} 字符`);
  if (group !== "style" && !inject.trim()) fail(`${where} 角色条目 inject 不能为空`);
  const weight = raw["weight"];
  if (typeof weight !== "number" || !Number.isFinite(weight) || weight < WEIGHT_MIN || weight > WEIGHT_MAX) {
    fail(`${where} weight 必须在 ${WEIGHT_MIN}–${WEIGHT_MAX}`);
  }
  const base = raw["base"];
  if (typeof base !== "string") fail(`${where} base 必须是字符串`);
  const source = raw["source"];
  if (typeof source !== "string") fail(`${where} source 必须是字符串`);
  const match = raw["match"];
  if (!Array.isArray(match) || match.length === 0 || match.some((m) => typeof m !== "string" || !m.trim())) {
    fail(`${where} match 必须是非空字符串数组`);
  }
  const danbooruRaw = raw["danbooru"];
  if (danbooruRaw !== undefined && (!Array.isArray(danbooruRaw) || danbooruRaw.some((t) => typeof t !== "string" || !t.trim()))) {
    fail(`${where} danbooru 必须是非空字符串数组`);
  }
  const danbooru = Array.isArray(danbooruRaw) ? (danbooruRaw as string[]) : [];
  const sectionsRaw = raw["sections"];
  if (!Array.isArray(sectionsRaw)) fail(`${where} sections 必须是数组`);
  if (group !== "style" && sectionsRaw.length === 0) fail(`${where} 角色条目 sections 不能为空`);
  const sections: CharacterSection[] = sectionsRaw.map((section, index) => {
    if (!isObject(section)) fail(`${where} sections[${index}] 必须是对象`);
    const title = section["title"];
    const tags = section["tags"];
    if (typeof title !== "string" || !title.trim()) fail(`${where} sections[${index}].title 为空`);
    if (typeof tags !== "string" || !tags.trim() || tags.length > SECTION_LIMIT) {
      fail(`${where} sections[${index}].tags 为空或超过 ${SECTION_LIMIT} 字符`);
    }
    const alias = section["alias"];
    if (alias !== undefined && (!Array.isArray(alias) || alias.some((a) => typeof a !== "string" || !a.trim()))) {
      fail(`${where} sections[${index}].alias 必须是非空字符串数组`);
    }
    return { title, tags, ...(alias === undefined ? {} : { alias: alias as string[] }) };
  });
  const entry: CharacterEntry = {
    key,
    group: group as EntryGroup,
    name,
    lora,
    inject,
    weight,
    base,
    source,
    match: match as string[],
    danbooru,
    sections,
  };
  return entry;
}

function load(): readonly CharacterEntry[] {
  const list: CharacterEntry[] = [];
  for (const rel of FILES) {
    const rows = readList(rel);
    rows.forEach((row, index) => list.push(parseEntry(row, `${rel}[${index}]`)));
  }
  const keys = new Set<string>();
  const matches = new Map<string, string>();
  for (const entry of list) {
    if (keys.has(entry.key)) fail(`key 重复：${entry.key}`);
    keys.add(entry.key);
    for (const alias of [entry.key, ...entry.match]) {
      const normalized = normalizeKey(alias);
      if (!normalized) fail(`${entry.key} 的 match 含空串`);
      const owner = matches.get(normalized);
      if (owner !== undefined && owner !== entry.key) fail(`match 冲突：「${alias}」同时属于 ${owner} 与 ${entry.key}`);
      matches.set(normalized, entry.key);
    }
  }
  return list;
}

export const CHARACTERS: readonly CharacterEntry[] = load();

const BY_KEY = new Map(CHARACTERS.map((entry) => [entry.key, entry]));

/** 按 key 精确（归一化后）取条目，不做模糊。 */
function byKey(raw: string): CharacterEntry | undefined {
  const key = normalizeKey(raw).replace(/ /g, "_");
  return BY_KEY.get(key);
}

/** 编辑距离（只用于短字符串的近似匹配）。 */
function levenshtein(a: string, b: string): number {
  if (a === b) return 0;
  let prev = Array.from({ length: b.length + 1 }, (_, index) => index);
  for (let i = 1; i <= a.length; i++) {
    const row = [i];
    for (let j = 1; j <= b.length; j++) {
      row[j] = Math.min(prev[j] + 1, row[j - 1] + 1, prev[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
    }
    prev = row;
  }
  return prev[b.length];
}

function similarity(a: string, b: string): number {
  const max = Math.max(a.length, b.length);
  return max === 0 ? 0 : 1 - levenshtein(a, b) / max;
}

/** 分数 = max(token 覆盖率, 与 key/name/match 的编辑距离相似度)。 */
function scored(raw: string): Array<{ entry: CharacterEntry; score: number }> {
  const normalized = normalizeKey(raw);
  const tokens = normalized.split(" ").filter((token) => token.length >= 2);
  return CHARACTERS.map((entry) => {
    const hay = [entry.key, entry.name, ...entry.match].map(normalizeKey).filter((item) => item.length >= 2);
    const coverage = tokens.length === 0 ? 0 : tokens.filter((token) => hay.some((item) => item.includes(token))).length / tokens.length;
    // 近似匹配只接受 1–2 个编辑（错字/缩写）；否则短词会互相误配（garden 与 eden 只差 3 步也不算）。
    const closest = normalized.length < 2 || hay.length === 0
      ? 0
      : Math.max(...hay.map((item) => {
        const distance = levenshtein(normalized, item);
        return distance <= 2 ? 1 - distance / Math.max(normalized.length, item.length) : 0;
      }));
    return { entry, score: Math.max(coverage, closest) };
  }).sort((a, b) => b.score - a.score);
}

/**
 * 三级匹配：key 精确 → match 精确 → 模糊（覆盖率 ≥0.5 且唯一最高分）。
 * 模糊分并列或不足时返回 undefined，由调用方给候选，绝不猜。
 */
export function findCharacter(raw: string): CharacterEntry | undefined {
  const text = raw.trim();
  if (!text) return undefined;
  const exactKey = byKey(text);
  if (exactKey) return exactKey;
  const normalized = normalizeKey(text);
  const exactMatch = CHARACTERS.find((entry) => entry.match.some((alias) => normalizeKey(alias) === normalized));
  if (exactMatch) return exactMatch;
  const ranked = scored(text).filter((row) => row.score >= 0.5);
  if (ranked.length === 0) return undefined;
  if (ranked.length > 1 && ranked[0].score === ranked[1].score) return undefined;
  return ranked[0].entry;
}

/** 候选：按同一分数排序，永远不猜，只用于「没找到，是不是这个」的回执。 */
export function suggestCharacters(raw: string, limit = 3): readonly CharacterEntry[] {
  return scored(raw)
    .filter((row) => row.score > 0)
    .slice(0, limit)
    .map((row) => row.entry);
}

/** 命中条目内的某一段服装：先比 alias，再比标题包含关系。 */
export function findSection(entry: CharacterEntry, raw: string): CharacterSection | undefined {
  const normalized = normalizeKey(raw);
  if (normalized.length < 2) return undefined;
  const byAlias = entry.sections.find((section) => section.alias?.some((alias) => normalizeKey(alias) === normalized));
  if (byAlias) return byAlias;
  const tokens = normalized.split(" ").filter((token) => token.length >= 3);
  if (tokens.length === 0) return entry.sections.find((section) => normalizeKey(section.title).includes(normalized));
  let best: CharacterSection | undefined;
  let bestHits = 0;
  let tie = false;
  for (const section of entry.sections) {
    const hay = normalizeKey([section.title, ...(section.alias ?? [])].join(" "));
    const hits = tokens.filter((token) => hay.includes(token)).length;
    if (hits > bestHits) { best = section; bestHits = hits; tie = false; }
    else if (hits === bestHits && hits > 0) tie = true;
  }
  return bestHits > 0 && !tie ? best : undefined;
}

/** draw 用：角色 LoRA 的文件名与机械注入串；style 组不可当角色挂。 */
export function loraBook(key: string): { file: string; inject: string } | undefined {
  const entry = byKey(key);
  if (!entry || entry.group === "style") return undefined;
  return { file: entry.lora, inject: entry.inject };
}

/** draw 用：风格 LoRA 的文件名与表内权重；角色组不可当风格挂。 */
export function styleBook(key: string): { file: string; weight: number } | undefined {
  const entry = byKey(key);
  if (!entry || entry.group !== "style") return undefined;
  return { file: entry.lora, weight: entry.weight };
}

/** tags 用：总表（可只列一组），顺序固定为 ai-girls → honkai3rd → styles。 */
export function listCharacters(group?: EntryGroup): readonly CharacterEntry[] {
  return group === undefined ? CHARACTERS : CHARACTERS.filter((entry) => entry.group === group);
}

/** 提示词归一化：去转义反斜杠、下划线当空格，供角色 tag 检测用。 */
function normalizePrompt(text: string): string {
  return text.normalize("NFKC").toLowerCase().replace(/\\/g, "").replace(/\s*\(/g, " (").replace(/_+/g, " ").replace(/\s+/g, " ").trim();
}

const DANBOORU_INDEX: ReadonlyArray<{ alias: string; entry: CharacterEntry }> = CHARACTERS
  .flatMap((entry) => entry.danbooru.map((alias) => ({ alias: normalizePrompt(alias), entry })))
  .filter((row) => row.alias.length >= 8)
  .sort((a, b) => b.alias.length - a.alias.length);

/**
 * 检测一段提示词里手写的角色 danbooru tag。
 * 只认表内显式登记的形式（长别名优先），命中即返回条目；用于「没传 key 就打回」的机械闸。
 */
export function detectCharacterTag(text: string): CharacterEntry | undefined {
  const normalized = normalizePrompt(text);
  if (!normalized) return undefined;
  return DANBOORU_INDEX.find((row) => normalized.includes(row.alias))?.entry;
}

export function characterKeys(): readonly string[] {
  return CHARACTERS.filter((entry) => entry.group !== "style").map((entry) => entry.key);
}

export function styleKeys(): readonly string[] {
  return CHARACTERS.filter((entry) => entry.group === "style").map((entry) => entry.key);
}
