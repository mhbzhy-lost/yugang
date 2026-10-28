/**
 * 手艺系统的两条底线：
 *  1. 常驻上下文里只有 name + description + 路径，不塞 SKILL.md 正文
 *  2. 模型能真的用 bash 跑 skill 脚本，产物能安全地经 say 发出去
 */
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { createModels } from "@earendil-works/pi-ai/models";
import { fauxAssistantMessage, fauxProvider, fauxToolCall } from "@earendil-works/pi-ai/providers/faux";
import { MemoryStorage } from "@earendil-works/pi-durable";
import { openFish } from "../src/harness.ts";
import { discoverSkills, parseSkillFile, renderSkillsPrompt } from "../src/skills.ts";

const ctx = BACKGROUND_CONTEXT;
const SKILLS = fileURLToPath(new URL("../skills", import.meta.url));

test("发现 skills，且 prompt 里只有摘要不给正文", () => {
  const skills = discoverSkills(SKILLS);
  assert.ok(skills.length >= 2, "至少要发现 draw 和 meme");
  const names = skills.map((s) => s.name);
  assert.ok(names.includes("draw") && names.includes("meme"));

  const prompt = renderSkillsPrompt(skills);
  assert.match(prompt, /- draw: /);
  assert.match(prompt, /SKILL\.md/);
  // 正文里的"步骤"不该出现在常驻 prompt 里
  assert.ok(!prompt.includes("## 步骤"), "SKILL.md 正文泄漏进常驻 prompt 了");
});

test("frontmatter 解析", () => {
  const parsed = parseSkillFile('---\nname: demo\ndescription: >\n  第一行\n  第二行\n---\n\n# 正文');
  assert.equal(parsed.name, "demo");
  assert.match(parsed.description, /第一行 第二行/);
});

test("bash 跑 skill 脚本 → say 发图，路径与文本各自归位", async () => {
  const faux = fauxProvider();
  const models = createModels();
  models.setProvider(faux.provider);

  const mediaRoot = mkdtempSync(join(tmpdir(), "yg-media-"));
  const workspaceRoot = mkdtempSync(join(tmpdir(), "yg-ws-"));
  const out = join(mediaRoot, "blue.png");

  faux.setResponses([
    // 1. 按 SKILL.md 的指示跑脚本
    fauxAssistantMessage(
      [fauxToolCall("bash", { command: `node "$YUGANG_SKILL_DIR/draw/scripts/make.mjs" "蓝色" "#3b82f6" blue.png` })],
      { stopReason: "toolUse" },
    ),
    // 2. 拿到路径后，只把路径放进 media，text 保持干净
    fauxAssistantMessage([fauxToolCall("say", { text: "画好了", media: out })], { stopReason: "toolUse" }),
    fauxAssistantMessage("完成"),
  ]);

  const outbox: { text: string; media?: string }[] = [];
  const fish = await openFish({
    storage: new MemoryStorage(),
    models,
    model: { provider: faux.provider.id, modelId: faux.models[0].id },
    persona: "你是鱼",
    skillsRoot: SKILLS,
    mediaRoot,
    workspaceRoot,
    emit: (_id, payload) => {
      outbox.push({ text: payload.text, media: payload.media });
    },
  });

  try {
    const root = await fish.harness.root(ctx, {
      agent: { model: { provider: faux.provider.id, modelId: faux.models[0].id } },
    });

    const tools = (await root.agent(ctx)).tools.map((t) => t.name);
    assert.deepEqual(tools, ["bash", "read", "say"], "鱼只该有 bash / read / say");

    const submission = await root.submit({ type: "input", content: "画一张蓝色的" }, ctx);
    assert.equal((await submission.wait(ctx)).status, "done");

    assert.equal(outbox.length, 1);
    assert.equal(outbox[0].text, "画好了");
    assert.equal(outbox[0].media, out, "发出去的应该是 skill 脚本产出的那个文件");
    assert.ok(!outbox[0].text.includes("IMAGE"), "路径不该混进正文");
  } finally {
    await fish.close();
  }
});
