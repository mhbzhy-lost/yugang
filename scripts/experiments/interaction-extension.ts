#!/usr/bin/env node
/** Offline extension contract/build/verification. No sampling, image judgment or credentials. */
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { REPO_ROOT } from "../../src/paths.ts";
import { loraBook } from "../../src/tools/characters.ts";
import { buildRsGraph, buildRepairGraph } from "./interaction-study-lib/graphs.ts";

type Obj = Record<string, any>;
const args = process.argv.slice(2);
const command = args[0] ?? "describe";
const flag = (name: string) => { const i = args.indexOf(`--${name}`); return i < 0 ? undefined : args[i + 1]; };
const root = resolve(REPO_ROOT, flag("run") ?? "var/local-driver/anima-interaction-extension-v1");
const source = join(REPO_ROOT, "experiments/anima-interaction-extension-v1");
const old = join(REPO_ROOT, "var/local-driver/anima-interaction-v1");
const read = (p: string) => JSON.parse(readFileSync(p, "utf8"));
const sha = (value: string | Buffer) => createHash("sha256").update(value).digest("hex");
const fileSha = (p: string) => sha(readFileSync(p));
const json = (value: unknown) => JSON.stringify(value, null, 2) + "\n";
function save(p: string, value: unknown) {
  const bytes = typeof value === "string" ? value : json(value);
  if (existsSync(p)) {
    if (readFileSync(p, "utf8") !== bytes) throw new Error(`Refusing to overwrite frozen artifact: ${p}`);
    return;
  }
  mkdirSync(dirname(p), { recursive: true });
  writeFileSync(p, bytes, { flag: "wx" });
}
function demand(condition: unknown, reason: string): asserts condition { if (!condition) throw new Error(reason); }
function files(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap(d => d.isDirectory() ? files(join(dir, d.name)) : [join(dir, d.name)]);
}
const seed = (pair: string, world: string, stage: string) => createHash("sha256").update(`${pair}|${world}|20261112|${stage}`).digest().readUInt32BE(0);
const spec = read(join(existsSync(join(root, "spec.json")) ? root : source, "spec.json"));
const cases = Object.keys(spec.pairs).flatMap(pair => [...spec.contact_cases, ...Object.keys(spec.camera_cases)].map(c => `${pair}-${c}`));
const firstIds = new Set(spec.budget.first_checkpoint);

function descriptions(kind: string) {
  if (kind.startsWith("D")) return [
    "on the left of the other girl, running, mid-stride, left hand holding the other girl's right hand, right arm swinging, left knee forward",
    "on the right of the other girl, running, mid-stride, right hand holding the other girl's left hand, left arm swinging, right knee forward",
  ];
  const hands = kind === "C1" ? "below chest" : kind === "C2" ? "in front of waist" : "in front of abdomen";
  return [
    `left arm around the other girl's waist, right hand interlaced with the other girl's left hand ${hands}, kissing, lips touching, ${kind === "C3" ? "standing behind the other girl" : "facing the other girl"}`,
    `left hand interlaced with the other girl's right hand ${hands}, ${kind === "C3" ? "right hand resting on the encircling forearm, torso and head turned back" : "right arm around the other girl's waist, facing the other girl"}, kissing, lips touching`,
  ];
}

function build() {
  const conditions = read(join(root, "conditions.json"));
  demand(Object.keys(conditions.cases).length === 14, "All fourteen real reference conditions are required before graph freeze");
  const preflight = read(join(root, "preflight.json"));
  const previous = read(join(old, "revisions/interaction-executable-v4/manifest.json"));
  const sourceFiles = [...files(source).filter(p => /\.(py|json)$/.test(p)),
    join(REPO_ROOT, "scripts/experiments/interaction-extension.ts"),
    join(REPO_ROOT, "scripts/experiments/interaction-study-lib/graphs.ts"),
    join(REPO_ROOT, "scripts/experiments/interaction-study-run.py"),
    join(REPO_ROOT, "scripts/experiments/interaction-study-pull.py"),
    join(REPO_ROOT, "experiments/anima-interaction-v1/patches/rs-img2img.patch")];
  const sourceHashes = Object.fromEntries(sourceFiles.map(p => [p.slice(REPO_ROOT.length + 1), fileSha(p)]));
  for (const p of sourceFiles) save(join(root, "sources/code", p.slice(REPO_ROOT.length + 1)), readFileSync(p, "utf8"));
  const snapshots = new Map(previous.characters_snapshot.map((c: Obj) => [c.key, c]));
  const asset = (key: string) => preflight.assets[key].comfyRelativePath;
  const schema = read(join(root, "checks/object-info.json"));
  const patchNames = schema.selected.ModelPatchLoader.input.required.name[0] as string[];
  const patchMatches = patchNames.filter(name => name.replaceAll("\\", "/") === asset("pose_lllite").replaceAll("\\", "/"));
  demand(patchMatches.length === 1, "Pinned pose asset has no unique name in the real ModelPatchLoader schema");
  const posePatchName = patchMatches[0];
  const jobs: Obj[] = [];
  for (const caseId of cases) {
    const [pair, kind] = caseId.split("-");
    const c = conditions.cases[caseId];
    const chars = spec.pairs[pair].map((key: string) => {
      const current = loraBook(key);
      const frozen: any = snapshots.get(key);
      demand(current && frozen && current.file === frozen.lora_comfy_path && current.inject === frozen.inject,
        `Character source differs from the verified assets: ${key}`);
      return current;
    });
    const regional = chars.map((ch: Obj, i: number) => ch.inject.split(",").map((t: string) => t.trim())
      .filter((t: string) => t !== "1girl" && t !== "solo").join(", ") + ", " + descriptions(kind)[i]);
    const common = kind.startsWith("C")
      ? "masterpiece, best quality, 2girls, adult women, original outfits, soft sunlight, courtyard, outdoors, cowboy shot, embracing, kissing, interlocked fingers"
      : "masterpiece, best quality, 2girls, adult women, original outfits, night, starry sky, grassland, open field, running, holding hands, full body, small subjects";
    const methods = kind.startsWith("C") ? ["parent", "repair"] : ["human", "scene"];
    const opt = { commonPositive: common, negative: previous.prompt_floor.negative,
      regionalA: regional[0], regionalB: regional[1], loraA: chars[0].file, loraB: chars[1].file,
      weightA: .8, weightB: .8, unetName: asset("unet"), clipName: asset("clip"), vaeName: asset("vae") };
    for (const method of methods) {
      const jobId = `${caseId}-${method}`;
      const parentId = method === "repair" ? `${caseId}-parent` : null;
      const stage = method === "repair" ? "repair" : "initial";
      const stageSeed = seed(pair, c.world_id, stage);
      const inputFiles: Obj[] = [];
      function upload(name: string) {
        const f = c.files[name + ".png"];
        demand(f && fileSha(join(root, f.path)) === f.sha256, `Missing/changed condition: ${caseId}/${name}`);
        const target = `yugang-ext-${caseId}-${name}-${f.sha256.slice(0, 12)}.png`;
        inputFiles.push({ target, source: { kind: "structure", path: f.path, sha256: f.sha256 } });
        return target;
      }
      let built;
      if (method === "repair") {
        const target = `yugang-ext-${caseId}-parent.png`;
        inputFiles.push({ target, source: { kind: "parent_job", job_id: parentId, sha256: null } });
        built = buildRepairGraph({ ...opt, jobId, method: "R3", denoise: .45, parentUploadName: target,
          coreUploadName: upload("repair_core"), supportUploadName: upload("support"), contextUploadName: upload("context"),
          grayUploadName: upload("gray"), ownerAUploadName: upload("owner_a"), ownerBUploadName: upload("owner_b"),
          seed: stageSeed, crop: { mask_blend_pixels: 32, downscale_algorithm: "bilinear", upscale_algorithm: "bicubic" },
          width: 768, height: 768, ringFraction: .08 });
      } else {
        built = buildRsGraph({ ...opt, jobId, method: "B0", seed: stageSeed, width: 1024, height: 768,
          boxA: c.boxes.owner_a, boxB: c.boxes.owner_b, pose: spec.pose,
          sceneJson: readFileSync(join(root, c.files["scene.json"].path), "utf8") });
        const g: any = built.graph;
        const find = (type: string) => Object.entries(g).find(([, n]: any) => n.class_type === type)![0];
        let id = Math.max(...Object.keys(g).map(Number));
        const add = (class_type: string, inputs: Obj) => { const k = String(++id); g[k] = { class_type, inputs }; return k; };
        const project = add("YugangStudyCameraProject", {
          scene_json: readFileSync(join(root, c.files["scene.json"].path), "utf8"),
          camera_extension: readFileSync(join(root, c.files["camera-extension.json"].path), "utf8"),
        });
        const position = find("RSMultiCharacterPosition");
        const maskA = add("RSMultiCharacterMask", { building_pipe: [position, 0], character_id: 1,
          enabled: true, margin: 0, threshold: .5, mask: [project, 1] });
        const maskB = add("RSMultiCharacterMask", { building_pipe: [maskA, 0], character_id: 2,
          enabled: true, margin: 0, threshold: .5, mask: [project, 2] });
        g[find("RSMultiCharacterFinalize")].inputs.building_pipe = [maskB, 0];
        const patch = add("ModelPatchLoader", { name: posePatchName });
        const sampler = find("RSMultiCharacterSampler");
        const apply = add("AnimaLLLiteApply", { model: g[sampler].inputs.model, model_patch: [patch, 0],
          image: [project, 0], strength: .8, start_percent: 0, end_percent: .7 });
        g[sampler].inputs.model = [apply, 0];
        g[find("YugangStudyMetadata")].inputs.scene_info = [project, 6];
        if (method === "scene") {
          g[sampler].class_type = "YugangRSSceneImg2Img";
          g[sampler].inputs.image = [project, 5];
          g[sampler].inputs.denoise = .65;
        }
      }
      const graphPath = `graphs/${jobId}.json`;
      const graphText = json(built.graph);
      save(join(root, graphPath), graphText);
      const semanticGraph: any = structuredClone(built.graph);
      for (const node of Object.values(semanticGraph) as any[]) {
        if (node.class_type === "SaveImage") delete node.inputs.filename_prefix;
        if (node.class_type === "YugangStudyMetadata") delete node.inputs.label;
      }
      const job = { job_id: jobId, case_id: caseId, pair, action: kind, framing: kind.startsWith("C") ? "C" : "W",
        seed: spec.seed, stage, stage_seed: stageSeed, group: `${kind[0]}-${method}`, method,
        weights: { A: .8, B: .8 }, parent: parentId ? { source_job: parentId } : null,
        asset_hashes: Object.fromEntries(Object.entries(preflight.assets).map(([k, a]: any) => [k, a.sha256])),
        expected_visibility: { contacts: c.contacts, visual_acceptance: "user_only" },
        comparison_folders: [kind.startsWith("C") ? "C-联合接触" : "D-人物与背景镜头"],
        sample_kind: "new", depends_on: parentId ? [parentId] : [], reuse_of: null,
        graph_path: graphPath, graph_hash: sha(graphText), expected_width: 1024, expected_height: 768,
        input_files: inputFiles, condition_files: c.files,
        execution_fingerprint: sha(json({ graph: semanticGraph, inputs: inputFiles, source_hashes: sourceHashes })),
        output_contract: { image_node_ids: built.imageNodes, metadata_node_ids: built.metadataNodes } };
      jobs.push(job);
    }
  }
  demand(jobs.length === 28 && new Set(jobs.map(j => j.job_id)).size === 28, "Wrong extension job count");
  const manifest = { schema_version: "anima-interaction-manifest.v1", study: spec.schema,
    spec_sha256: fileSha(join(root, "spec.json")), preflight_sha256: fileSha(join(root, "preflight.json")),
    conditions_sha256: fileSha(join(root, "conditions.json")), source_hashes: sourceHashes,
    runtime_model_names: { pose_lllite: posePatchName }, budget: spec.budget,
    counts: { total_rows: 28, total_new: 28, total_reuse: 0 }, jobs };
  save(join(root, "manifest.json"), manifest);
  const checkpoint = { ...manifest, parent_manifest_sha256: sha(json(manifest)),
    counts: { total_rows: 4, total_new: 4, total_reuse: 0 }, jobs: jobs.filter(j => firstIds.has(j.job_id)) };
  demand(checkpoint.jobs.length === 4, "Checkpoint selection mismatch");
  save(join(root, "checkpoint-manifest.json"), checkpoint);
  console.log(json({ command, root, groups: { "C-parent": 6, "C-repair": 6, "D-human": 8, "D-scene": 8 },
    manifest_sha256: sha(json(manifest)), checkpoint_sha256: sha(json(checkpoint)), gpu_submissions: 0 }));
}

function verify() {
  const requested = flag("criterion");
  const results: Obj[] = [];
  const evidence: Obj = {};
  const check = (id: string, run: () => string[]) => {
    if (requested && requested !== id) return;
    try { results.push({ id, status: "passed", evidence: run() }); }
    catch (error) { results.push({ id, status: "failed", reason: String(error) }); }
  };
  const manifest = () => read(join(root, "manifest.json"));
  const state = () => read(join(root, "state.json"));
  check("F1", () => {
    const m = manifest();
    demand(m.jobs.length === 28 && new Set(m.jobs.map((j: Obj) => j.job_id)).size === 28, "Expected 28 unique jobs");
    demand(m.spec_sha256 === fileSha(join(root, "spec.json")), "Spec drift");
    for (const [p, hash] of Object.entries(m.source_hashes)) demand(fileSha(join(REPO_ROOT, p)) === hash, `Source drift: ${p}`);
    for (const j of m.jobs) demand(fileSha(join(root, j.graph_path)) === j.graph_hash, `Graph drift: ${j.job_id}`);
    const counts: Obj = {};
    for (const j of m.jobs) counts[j.group] = (counts[j.group] ?? 0) + 1;
    demand(counts["C-parent"] === 6 && counts["C-repair"] === 6 && counts["D-human"] === 8 && counts["D-scene"] === 8, "Group counts mismatch");
    return ["manifest.json", "spec.json", "graphs/"];
  });
  check("F2", () => {
    const c = read(join(root, "conditions.json"));
    const projection = read(join(root, "checks/projection.json"));
    demand(Object.keys(c.cases).length === 14 && Object.keys(c.worlds).length === 8, "Reference coverage mismatch");
    for (const [id, item] of Object.entries(c.cases) as any) {
      for (const f of Object.values(item.files) as any[]) demand(fileSha(join(root, f.path)) === f.sha256, `Condition drift: ${id}/${f.path}`);
      const p = projection.cases[id];
      demand(p.horizon_angle_error <= .5, `${id}: horizon mismatch`);
      if (id.includes("-D")) demand(Math.max(...p.center_error) <= .025, `${id}: composition center mismatch`);
      demand(p.point_reprojection_error_px <= 1.5 && p.owner_boundary.every((v: Obj) => v.sample_count > 0 && v.maximum_error_px <= 1.5), `${id}: missing/failed independent point/boundary projection check`);
      for (const edge of item.contacts) demand(edge.in_frame && edge.distance_h <= edge.limit_h, `${id}: reference contact failed`);
    }
    return ["conditions.json", "inputs/"];
  });
  check("F3", () => {
    const registration = read(join(root, "checks/registration.json"));
    demand(registration.real_schema_pass && registration.project_cpu_hash_match && registration.old_repair_unchanged,
      "Real registration / CPU comparison / repair protection missing");
    const sceneJob = manifest().jobs.find((j: Obj) => j.job_id === "DC-D1-scene");
    demand(state().jobs[sceneJob.job_id].status === "success", "Scene initialization has no successful history yet");
    const texts = files(join(root, "generation-info")).filter(p => p.includes(sceneJob.job_id)).map(p => readFileSync(p, "utf8")).join("\n");
    demand(texts.includes('yugang_scene_img2img') && texts.includes('layout_image+vae') && /latent_nonzero[\\"\s:]+true/.test(texts), "Missing runtime layout latent evidence");
    return ["checks/registration.json", "generation-info/", "state.json"];
  });
  check("F4", () => {
    const s = state();
    for (const j of manifest().jobs) demand(["success", "execution_error", "http_rejected"].includes(s.jobs[j.job_id]?.status), `Nonterminal job: ${j.job_id}`);
    for (const group of ["C-parent", "C-repair", "D-human", "D-scene"]) demand(manifest().jobs.some((j: Obj) => j.group === group && s.jobs[j.job_id]?.status === "success"), `Mechanism has no image: ${group}`);
    return ["state.json", "results.jsonl"];
  });
  check("F5", () => {
    const budget = read(join(root, "checks/budget.json"));
    demand(budget.actual_diffusions <= 28 && budget.unknown_reserved === 0 && budget.successful_reposts === 0 && budget.reconciled_with_histories,
      "Budget/history reconciliation missing or cap violated");
    return ["checks/budget.json", "generation-info/"];
  });
  check("F6", () => {
    const d = read(join(root, "delivery.json"));
    const ids = new Set(d.jobs.map((j: Obj) => j.job_id));
    demand(manifest().jobs.every((j: Obj) => ids.has(j.job_id)), "Delivery is partial (checkpoint is not final delivery)");
    for (const f of d.files) demand(fileSha(f.path) === f.sha256, `Delivery hash drift: ${f.path}`);
    demand(d.visual_acceptance === "user_only", "Automated visual verdict forbidden");
    return ["delivery.json"];
  });
  check("F7", () => {
    const baseline = read(join(root, "checks/change-scope-baseline.json"));
    for (const [p, hash] of Object.entries(baseline.protected)) demand(fileSha(join(REPO_ROOT, p)) === hash, `Protected file changed: ${p}`);
    const test = read(join(root, "checks/npm-test.json"));
    demand(test.exit_code === 0 && test.log_sha256 === fileSha(join(root, "checks/npm-test.log")), "Current regression evidence missing");
    for (const [p, hash] of Object.entries(test.sources)) demand(fileSha(join(REPO_ROOT, p)) === hash, `Tested source drift: ${p}`);
    return ["checks/change-scope-baseline.json", "checks/npm-test.json", "checks/npm-test.log"];
  });
  check("F9", () => {
    const timeline = read(join(root, "checks/resource-timeline.json"));
    demand(timeline.G0_maintained && !timeline.restored_on_branch_pause, "Resource-window semantics violated");
    demand(timeline.entire_shared_window_ended && timeline.final_G1_verified, "Window still active; final G1 is not yet due or verified");
    return ["checks/resource-timeline.json"];
  });
  check("F10", () => {
    const audit = read(join(root, "reviews/delivery-audit.json"));
    demand(audit.manifest_sha256 === fileSha(join(root, "manifest.json")) && audit.independent && audit.all_mechanical_conditions_passed,
      "Independent current-delivery audit missing");
    return ["reviews/delivery-audit.json"];
  });
  demand(!requested || results.length > 0, `Unknown AUTO criterion ${requested}; F8 is user-only`);
  const out = { study: spec.schema, at: new Date().toISOString(), manifest_sha256: existsSync(join(root, "manifest.json")) ? fileSha(join(root, "manifest.json")) : null,
    results, visual_acceptance: "pending-user", overall: results.every(r => r.status === "passed") ? "mechanical_subset_passed_not_visual_acceptance" : "incomplete" };
  mkdirSync(join(root, "checks"), { recursive: true });
  writeFileSync(join(root, requested ? `checks/acceptance-${requested}.json` : "acceptance-auto.json"), json(out));
  console.log(json(out));
  if (results.some(r => r.status !== "passed")) process.exitCode = 1;
}

if (command === "describe") console.log(json({ study: spec.schema, cases, counts: { "C-parent": 6, "C-repair": 6, "D-human": 8, "D-scene": 8 }, first_checkpoint: [...firstIds], maximum_new_diffusions: 28, gpu_submissions: 0 }));
else if (command === "build") build();
else if (command === "verify") verify();
else throw new Error(`Unknown command: ${command}`);
