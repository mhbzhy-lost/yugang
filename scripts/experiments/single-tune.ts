#!/usr/bin/env node
/** single-tune.ts —— 单人轻形态出图（无 RS）：生产 makeInteractionSingleGraph + loraBook。 */
import { parseArgs } from "node:util";
import { writeFileSync, readFileSync } from "node:fs";
import { makeInteractionSingleGraph, type InteractionPreset } from "../../src/tools/draw/comfy.ts";
import { loraBook } from "../../src/tools/characters.ts";

const args = parseArgs({
  options: {
    task: { type: "string" }, text: { type: "string" }, prompt: { type: "string" },
    key: { type: "string" }, width: { type: "string" }, height: { type: "string" },
    label: { type: "string" }, out: { type: "string" },
  },
}).values;

const t = JSON.parse(readFileSync(args.task!, "utf8")) as {
  scene_json: string; camera_extension: string;
  box: { x: number; y: number; width: number; height: number };
  seed_initial: number; seed_pass: number;
};
const preset: InteractionPreset = {
  scene_json: t.scene_json, scene_json_2x: "", camera_extension: t.camera_extension,
  box: [t.box, t.box],
};
const role = loraBook(args.key!);
if (!role) throw new Error(`unknown character: ${args.key}`);
const graph = makeInteractionSingleGraph({
  preset,
  prompt: args.prompt!,
  width: Number(args.width), height: Number(args.height),
  seed: t.seed_initial, passSeed: t.seed_pass,
  part: { text: args.text!, role: { file: role.file, weight: 1, inject: role.inject } },
  label: args.label!,
});
writeFileSync(args.out!, JSON.stringify(graph, undefined, 2) + "\n");
console.log(JSON.stringify({ out: args.out, nodes: Object.keys(graph).length, seed: t.seed_initial }));
