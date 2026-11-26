/**
 * 角色与风格词表多底模 LoRA 解析测试（Spec §3.3 / Plan Task 1）。
 */
import test from "node:test";
import assert from "node:assert/strict";
import {
  CHARACTERS,
  loraBook,
  styleBook,
  normalizeLoraFamily,
  parseCharacterEntry,
  resolveEntryLora,
  resolveCharacter,
  resolveStyle,
} from "../src/tools/characters.ts";

function validRaw(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    key: "test_char",
    group: "aigirls",
    name: "测试角色",
    lora: "test_legacy.safetensors",
    inject: "test_char, silver hair",
    weight: 1.0,
    base: "Anima",
    source: "",
    match: ["test_char"],
    sections: [{ title: "基础外观", tags: "test_char, silver hair" }],
    ...overrides,
  };
}

test("既有词表导出与旧签名零回归", () => {
  assert.ok(CHARACTERS.length > 0);
  const claude = loraBook("claude");
  assert.ok(claude);
  assert.equal(claude.file, "claude_girl_anima_lora_clean.safetensors");
  assert.equal(claude.weight, 1.0);
  assert.ok(claude.inject.includes("claude_girl"));

  const hsr = styleBook("hsr");
  assert.ok(hsr);
  assert.equal(hsr.file, "HSR Anima.safetensors");
  assert.equal(hsr.weight, 0.7);

  assert.equal(loraBook("hsr"), undefined);
  assert.equal(styleBook("claude"), undefined);
});

test("normalizeLoraFamily 做 trim 与 lower-case 归一化", () => {
  assert.equal(normalizeLoraFamily("Anima"), "anima");
  assert.equal(normalizeLoraFamily("  SDXL  "), "sdxl");
  assert.equal(normalizeLoraFamily("Anima "), "anima");
  assert.equal(normalizeLoraFamily(""), "");
});

test("byKey 归一化同样作用于 resolveCharacter 与 resolveStyle", () => {
  const target = { backendId: "anima3.8b", loraFamily: "anima" };
  const exact = resolveCharacter("the_herta", target);
  const normalized = resolveCharacter("  The-Herta ", target);
  const fullwidth = resolveCharacter("ｔｈｅ_ｈｅｒｔａ", target);
  assert.ok(exact);
  assert.deepEqual(normalized, exact);
  assert.deepEqual(fullwidth, exact);

  const styleExact = resolveStyle("hsr", target);
  const styleNorm = resolveStyle(" HSR ", target);
  assert.ok(styleExact);
  assert.deepEqual(styleNorm, styleExact);
});

test("同族多后端共享 anima LoRA（Review Focus #2）", () => {
  const from38 = resolveCharacter("claude", { backendId: "anima3.8b", loraFamily: "anima" });
  const from2b = resolveCharacter("claude", { backendId: "anima2b", loraFamily: "anima" });
  assert.ok(from38?.lora);
  assert.equal(from38.lora.file, "claude_girl_anima_lora_clean.safetensors");
  assert.equal(from38.lora.weight, 1.0);
  assert.deepEqual(from2b, from38);

  const style2b = resolveStyle("hsr", { backendId: "anima2b", loraFamily: "anima" });
  assert.deepEqual(style2b, { lora: { file: "HSR Anima.safetensors", weight: 0.7 } });
});

test("跨族角色自动降级纯 tag、画风返回无 lora、跨组与未知 key 返回 undefined", () => {
  const sdxlTarget = { backendId: "sdxl", loraFamily: "sdxl" };
  const claudeSdxl = resolveCharacter("claude", sdxlTarget);
  assert.ok(claudeSdxl);
  assert.equal(claudeSdxl.inject, loraBook("claude")?.inject);
  assert.equal(claudeSdxl.lora, undefined);

  const hsrSdxl = resolveStyle("hsr", sdxlTarget);
  assert.ok(hsrSdxl);
  assert.equal(hsrSdxl.lora, undefined);

  assert.equal(resolveCharacter("hsr", sdxlTarget), undefined);
  assert.equal(resolveStyle("claude", sdxlTarget), undefined);
  assert.equal(resolveCharacter("unknown_key_xyz", sdxlTarget), undefined);
  assert.equal(resolveStyle("unknown_key_xyz", sdxlTarget), undefined);
});

test("LoRA 解析优先级：backendId > loraFamily > legacy base", () => {
  const entry = parseCharacterEntry(
    validRaw({
      loras: {
        anima: { file: "char_anima.safetensors" },
        "anima2.9b": { file: "char_anima29b.safetensors", weight: 0.9 },
        sdxl: { file: "char_sdxl.safetensors", weight: 0.85 },
      },
    }),
    "test[0]",
  );

  // 1. 命中精确 backendId（覆盖 loraFamily）
  assert.deepEqual(
    resolveEntryLora(entry, { backendId: "anima2.9b", loraFamily: "anima" }),
    { file: "char_anima29b.safetensors", weight: 0.9 },
  );

  // 2. 未命中 backendId → 回落 loraFamily，且缺省 weight 沿用条目 weight (1.0)
  assert.deepEqual(
    resolveEntryLora(entry, { backendId: "anima2b", loraFamily: "anima" }),
    { file: "char_anima.safetensors", weight: 1.0 },
  );

  // 3. 命中 sdxl 族
  assert.deepEqual(
    resolveEntryLora(entry, { backendId: "sdxl", loraFamily: "sdxl" }),
    { file: "char_sdxl.safetensors", weight: 0.85 },
  );

  // 4. 未声明的族且不匹配 legacy base → undefined
  assert.equal(
    resolveEntryLora(entry, { backendId: "krea", loraFamily: "krea" }),
    undefined,
  );

  // 5. loras 仅含 sdxl 时，anima 仍回退到 legacy base ("Anima")
  const partial = parseCharacterEntry(
    validRaw({
      weight: 0.8,
      loras: {
        sdxl: { file: "only_sdxl.safetensors", weight: 0.75 },
      },
    }),
    "test[1]",
  );
  assert.deepEqual(
    resolveEntryLora(partial, { backendId: "anima3.8b", loraFamily: "anima" }),
    { file: "test_legacy.safetensors", weight: 0.8 },
  );

  // 6. SDXL 子系列 base（如 Illustrious）不靠字面匹配 sdxl，需通过 loras 显式声明
  const illustrious = parseCharacterEntry(
    validRaw({
      base: "Illustrious",
      loras: {
        sdxl: { file: "via_loras_sdxl.safetensors", weight: 0.85 },
      },
    }),
    "test[2]",
  );
  assert.deepEqual(
    resolveEntryLora(illustrious, { backendId: "sdxl", loraFamily: "sdxl" }),
    { file: "via_loras_sdxl.safetensors", weight: 0.85 },
  );
  assert.equal(
    resolveEntryLora(illustrious, { backendId: "anima3.8b", loraFamily: "anima" }),
    undefined,
  );
});

test("parseCharacterEntry 对 loras 的合法边界与非法输入校验", () => {
  // 边界合法权重（0.4 与 1.1）与合法键名（含点号/横杠/下划线）
  const ok = parseCharacterEntry(
    validRaw({
      loras: {
        "anima2.9b": { file: "a_b-1 (v2).safetensors", weight: 0.4 },
        "sdxl_1-0": { file: "SDXL Model@1.safetensors", weight: 1.1 },
      },
    }),
    "ok[0]",
  );
  assert.equal(ok.loras?.["anima2.9b"]?.weight, 0.4);
  assert.equal(ok.loras?.["sdxl_1-0"]?.weight, 1.1);

  const badLorasCases: unknown[] = [
    null,
    [],
    "anima",
    123,
    {},
    { "": { file: "a.safetensors" } },
    { "-bad": { file: "a.safetensors" } },
    { ".hidden": { file: "a.safetensors" } },
    { Anima: { file: "a.safetensors" } },
    { "a/b": { file: "a.safetensors" } },
    { anima: null },
    { anima: [] },
    { anima: "a.safetensors" },
    { anima: { file: "" } },
    { anima: { file: 123 } },
    { anima: { file: "a.ckpt" } },
    { anima: { file: ".safetensors" } },
    { anima: { file: "sub/a.safetensors" } },
    { anima: { file: "sub\\a.safetensors" } },
    { anima: { file: "../a.safetensors" } },
    { anima: { file: "a.safetensors", weight: 0.39 } },
    { anima: { file: "a.safetensors", weight: 1.11 } },
    { anima: { file: "a.safetensors", weight: Number.NaN } },
    { anima: { file: "a.safetensors", weight: Number.POSITIVE_INFINITY } },
    { anima: { file: "a.safetensors", weight: "1.0" } },
  ];

  for (const loras of badLorasCases) {
    assert.throws(
      () => parseCharacterEntry(validRaw({ loras }), "bad[0]"),
      /characters\.json:/,
      `应当拒绝非法 loras: ${JSON.stringify(loras)}`,
    );
  }
});
