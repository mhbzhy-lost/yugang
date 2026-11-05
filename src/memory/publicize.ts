import { renderTemplate } from "../prompt/index.ts";
import { FACT_TEXT_CHARS, MEMORY_CAPS, type MemoryPatch } from "./model.ts";

// ---------------------------------------------------------------- 公共批准的 AI 脱敏

/** 公共化脱敏的依赖：提示词模板由调用方从 PromptSet 取，模型调用由调用方装配（线上与脚本同走 memoryModel 链）。 */
export interface PublicizeDeps {
  /** prompt/memory-publicize.md 的原文，含 {{patch}}。 */
  template: string;
  /** 单轮模型调用：输入整份 prompt，返回模型输出原文；异常在本函数内捕获转 failed。 */
  complete: (prompt: string) => Promise<string>;
}

/**
 * 公共化脱敏结果：failed 时调用方必须 fail closed——该次公共批准以错误回执终止，
 * 不降级机械替换、不原样入库（私有批准不经本函数，不受影响）。
 */
export type PublicizeOutcome =
  | { status: "ok"; patch: MemoryPatch }
  | { status: "failed"; reason: "no_json" | "bad_json" | "shape_mismatch" | "unsafe_text" | "model_error" };

/** 与 memory-extract.ts 的 safeShort 同款机械过滤（本地副本，两处常量须同步维护）：
 *  trim、限长、拒绝空串/控制字符/`<>` 标记/注入与隐私模式；不合格返回 undefined。 */
const PUBLICIZE_INJECTION_RES: readonly RegExp[] = [/忽略(之前|以上|前面)/, /system prompt/i, /系统提示/, /ignore (all )?previous/i];
const PUBLICIZE_FACT_INJECTION_RES: readonly RegExp[] = [/忽略/, /系统提示/, /system prompt/i, /ignore previous/i, /以后都/, /你必须/, /从现在开始/];
const PUBLICIZE_PRIVACY_RES: readonly RegExp[] = [
  /\d{7,}/,
  /[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+/,
  /https?:\/\/|www\./i,
  /(api[_-]?key|token|password|passwd|secret|密码|密钥)/i,
  /\b(sk|pk|ghp|gho|xoxb?)[-_a-zA-Z0-9]{10,}/i,
];

function publicSafeText(value: string, max: number, extraInjections: readonly RegExp[]): string | undefined {
  const text = value.trim();
  if (text.length === 0 || text.length > max) return undefined;
  if (/[\u0000-\u001F\u007F]/.test(text)) return undefined;
  if (text.includes("<") || text.includes(">")) return undefined;
  for (const pattern of [...extraInjections, ...PUBLICIZE_PRIVACY_RES]) {
    if (pattern.test(text)) return undefined;
  }
  return text;
}

/**
 * 公共批准（AI 脱敏）的编排：把 patch 的文本字段（facts/lore/cards 的 text；subject/keys/
 * names/style/口头禅/supersede 等结构与其它字段不动）交给便宜模型按
 * prompt/memory-publicize.md 改写，去掉指向来源群的身份信息，让表述在该人格任何会话都成立。
 * 评价类（/评）的 feedback 通道不进模型：主人原话与机器装配的结构字段不做 AI 改写
 * （决策 12：公共化脱敏对 meta 结构同构保留，文本字段以原 patch 为准）——重建时
 * 经展开原样带回；fact 级 kind/meta 同样只在重建时原样保留。
 * 模型输出全部当不可信数据：
 *   - 只接受与输入同构的 JSON（同数组长度、同 subject、同 keys），文本之外的字段一律
 *     以原 patch 为准重建，模型改不动；
 *   - 每条改写文本重过 sanitizePatch 同款机械过滤（限长/控制字符/<> 标记/注入与隐私模式），
 *     任一条不合格整体失败；
 *   - 没有可改写文本（空 patch / 只有 supersede）时不调模型，原样返回。
 */
export async function publicizePatch(patch: MemoryPatch, deps: PublicizeDeps): Promise<PublicizeOutcome> {
  const inPeople = patch.people ?? [];
  const inLore = patch.lore ?? [];
  const inCards = patch.cards ?? [];
  const input = {
    people: inPeople.map((person) => ({ subject: person.subject, facts: (person.facts ?? []).map((fact) => fact.text) })),
    lore: inLore.map((item) => ({ keys: item.keys, text: item.text })),
    cards: inCards.map((card) => ({ text: card.text })),
  };
  const hasTexts =
    input.people.some((person) => person.facts.length > 0) || input.lore.length > 0 || input.cards.length > 0;
  if (!hasTexts) return { status: "ok", patch };

  let output: string;
  try {
    output = await deps.complete(renderTemplate(deps.template, { patch: JSON.stringify(input, null, 2) }));
  } catch {
    return { status: "failed", reason: "model_error" };
  }
  const start = output.indexOf("{");
  const end = output.lastIndexOf("}");
  if (start < 0 || end <= start) return { status: "failed", reason: "no_json" };
  let parsed: unknown;
  try {
    parsed = JSON.parse(output.slice(start, end + 1));
  } catch {
    return { status: "failed", reason: "bad_json" };
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) return { status: "failed", reason: "shape_mismatch" };
  const source = parsed as Record<string, unknown>;
  const outPeople = source["people"];
  const outLore = source["lore"];
  const outCards = source["cards"];
  if (
    !Array.isArray(outPeople) || !Array.isArray(outLore) || !Array.isArray(outCards) ||
    outPeople.length !== inPeople.length || outLore.length !== inLore.length || outCards.length !== inCards.length
  ) {
    return { status: "failed", reason: "shape_mismatch" };
  }

  // 逐位对齐：同 subject、同 keys、同条数；只收 text，其余一切以原 patch 为准
  const factTexts: string[][] = [];
  for (let i = 0; i < inPeople.length; i++) {
    const outPerson = outPeople[i];
    const inFacts = inPeople[i].facts ?? [];
    const facts = (typeof outPerson === "object" && outPerson !== null ? (outPerson as Record<string, unknown>)["facts"] : undefined);
    if (!Array.isArray(facts) || facts.length !== inFacts.length) return { status: "failed", reason: "shape_mismatch" };
    if ((outPerson as Record<string, unknown>)["subject"] !== inPeople[i].subject) return { status: "failed", reason: "shape_mismatch" };
    const row: string[] = [];
    for (const value of facts) {
      if (typeof value !== "string") return { status: "failed", reason: "shape_mismatch" };
      row.push(value);
    }
    factTexts.push(row);
  }
  const loreTexts: string[] = [];
  for (let i = 0; i < inLore.length; i++) {
    const outItem = outLore[i];
    if (typeof outItem !== "object" || outItem === null) return { status: "failed", reason: "shape_mismatch" };
    const record = outItem as Record<string, unknown>;
    if (JSON.stringify(record["keys"]) !== JSON.stringify(inLore[i].keys)) return { status: "failed", reason: "shape_mismatch" };
    if (typeof record["text"] !== "string") return { status: "failed", reason: "shape_mismatch" };
    loreTexts.push(record["text"]);
  }
  const cardTexts: string[] = [];
  for (let i = 0; i < inCards.length; i++) {
    const outCard = outCards[i];
    const text = typeof outCard === "object" && outCard !== null ? (outCard as Record<string, unknown>)["text"] : undefined;
    if (typeof text !== "string") return { status: "failed", reason: "shape_mismatch" };
    cardTexts.push(text);
  }

  // 机械过滤：facts 用 fact 级注入模式，lore/cards 用通用模式；任一条不合格整体失败
  for (let i = 0; i < factTexts.length; i++) {
    for (let j = 0; j < factTexts[i].length; j++) {
      const clean = publicSafeText(factTexts[i][j], FACT_TEXT_CHARS, PUBLICIZE_FACT_INJECTION_RES);
      if (clean === undefined) return { status: "failed", reason: "unsafe_text" };
      factTexts[i][j] = clean;
    }
  }
  for (let i = 0; i < loreTexts.length; i++) {
    const clean = publicSafeText(loreTexts[i], MEMORY_CAPS.loreTextChars, PUBLICIZE_INJECTION_RES);
    if (clean === undefined) return { status: "failed", reason: "unsafe_text" };
    loreTexts[i] = clean;
  }
  for (let i = 0; i < cardTexts.length; i++) {
    const clean = publicSafeText(cardTexts[i], MEMORY_CAPS.cardTextChars, PUBLICIZE_INJECTION_RES);
    if (clean === undefined) return { status: "failed", reason: "unsafe_text" };
    cardTexts[i] = clean;
  }

  return {
    status: "ok",
    patch: {
      ...patch,
      people: inPeople.map((person, i) => ({
        ...person,
        facts: (person.facts ?? []).map((fact, j) => ({ ...fact, text: factTexts[i][j] })),
      })),
      lore: inLore.map((item, i) => ({ ...item, text: loreTexts[i] })),
      cards: inCards.map((card, i) => ({ ...card, text: cardTexts[i] })),
    },
  };
}

/** 定位：该 fact id 是否在 state 里（遍历每个人物的 facts 与评价 fact 列表）。 */
