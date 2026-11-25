#!/usr/bin/env node
/** interaction-tune.ts —— 本地调参运行器：生产代码路径出图。
 * 读 task json（authoring 产出）→ makeInteractionGraph（src/tools/draw/comfy.ts）
 * → 写 API 图 JSON（提交由测试 shim 完成，不进生产）。
 * 用法：node --experimental-strip-types scripts/experiments/interaction-tune.ts \
 *   --task <task.json> --text-a <互动描述A> --text-b <互动描述B> --prompt <公共场景词> \
 *   --key-a deepseek --key-b claude --width 1280 --height 720 --label sit1 --out graph.json
 */
import { parseArgs } from "node:util";
import { writeFileSync } from "node:fs";
import { makeInteractionGraph, type InteractionPreset } from "../../src/tools/draw/comfy.ts";
import { loraBook } from "../../src/tools/characters.ts";

const args = parseArgs({
  options: {
    task: { type: "string" }, "text-a": { type: "string" }, "text-b": { type: "string" },
    prompt: { type: "string" }, "key-a": { type: "string" }, "key-b": { type: "string" },
    width: { type: "string" }, height: { type: "string" }, label: { type: "string" },
    seed: { type: "string" }, out: { type: "string" },
  },
}).values;

const t = JSON.parse((await import("node:fs")).readFileSync(args.task!, "utf8")) as {
  scene_json: string; scene_json_2x: string; camera_extension: string;
  box_a: { x: number; y: number; width: number; height: number };
  box_b: { x: number; y: number; width: number; height: number };
  seed_initial: number; seed_pass: number;
};
const preset: InteractionPreset = {
  scene_json: t.scene_json, scene_json_2x: t.scene_json_2x, camera_extension: t.camera_extension,
  box: [t.box_a, t.box_b],
};
const book = (key: string) => {
  const entry = loraBook(key);
  if (!entry) throw new Error(`unknown character key: ${key}`);
  return { file: entry.file, weight: 1, inject: entry.inject };
};
const graph = makeInteractionGraph({
  preset,
  prompt: args.prompt!,
  width: Number(args.width), height: Number(args.height),
  seed: t.seed_initial, passSeed: t.seed_pass,
  parts: [
    { text: args["text-a"]!, role: book(args["key-a"]!) },
    { text: args["text-b"]!, role: book(args["key-b"]!) },
  ],
  label: args.label!,
});
writeFileSync(args.out!, JSON.stringify(graph, undefined, 2) + "\n");
console.log(JSON.stringify({ out: args.out, nodes: Object.keys(graph).length, seed: t.seed_initial }));
