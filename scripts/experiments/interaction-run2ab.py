#!/usr/bin/env python3
"""interaction-run2ab.py —— DC-RUN2 复杂构图 A/B 构建器（纯本地、不联网、不采样）。

A 直出（1 扩散）：B1 配方联合采样（RS 区域装配 + 外部 LLLite 姿态 + Project 投影）。
B 分层（2 扩散）：B1 背景渲染（布局板 → denoise 0.8，无人物提示）
              → B2 人物绘制（背景 VAEEncode + 人物区 noise_mask，scene 节点 denoise 1.0 满强度）。
单变量 = 路线；同 seed（A 与 B2）、同提示词、同条件、LoRA 权重 1.0（主人裁定的新默认）。
stage seed = uint32be(SHA256("DC|DC-RUN2|20261112|initial/bg")[0:4])。
"""
import hashlib
import json
import pathlib
import shutil
import sys

REPO = pathlib.Path(__file__).resolve().parents[2]
EXT = REPO / "var/local-driver/anima-interaction-extension-v1"
RUN2 = EXT / "run2"
OUT = RUN2 / "ab"
RAW = json.loads((RUN2 / "object-info-raw.json").read_bytes())

SLOT_A = ("aigirls, aigirls（deepseek）, 1girl, solo, blue hair, gradient hair, very long hair, wavy hair, "
          "ahoge, blue eyes, fins, cetacean tail, maid headdress, blue ribbon, running, leading ahead, "
          "right arm raised pointing at the starry sky, head turned toward viewer, face visible, "
          "left hand holding the other girl's hand")
SLOT_B = ("claude_girl, 1girl, solo, orange hair, very long hair, wavy hair, bangs, orange eyes, hair flower, "
          "hair bow, black bow, running, following behind, right hand holding the other girl's hand, "
          "head turned toward viewer, face visible")
PUBLIC = ("masterpiece, best quality, 2girls, adult women, original outfits, night, starry sky, milky way, "
          "grassland, open field, distant lake, sparkling water surface, reflection, running, holding hands, "
          "full body, small subjects")
BG_POS = ("masterpiece, best quality, night, starry sky, milky way, open field, grassland, "
          "distant lake, sparkling water surface, reflection, scenery, no humans, detailed grass")
NEG = ("lowres, worst quality, low quality, bad anatomy, bad hands, missing fingers, extra digit, fewer digits, "
       "extra limbs, extra legs, extra arms, conjoined bodies, fused bodies, text, watermark, signature")

JOB_REQUIRED_KEYS = [
    "job_id", "case_id", "pair", "action", "framing", "seed", "stage", "stage_seed",
    "method", "weights", "parent", "asset_hashes", "expected_visibility",
    "comparison_folders", "sample_kind", "depends_on", "reuse_of", "graph_path",
    "graph_hash", "expected_width", "expected_height", "input_files", "output_contract",
]


def sha(b: bytes) -> str:
    return hashlib.sha256(b).hexdigest()


def stage_seed(stage: str) -> int:
    return int.from_bytes(hashlib.sha256(f"DC|DC-RUN2|20261112|{stage}".encode()).digest()[:4], "big")


def load(p: pathlib.Path):
    return json.loads(p.read_bytes())


def write_graph(g: dict, name: str) -> tuple[str, str, bytes]:
    gb = json.dumps(g, ensure_ascii=False, indent=2).encode() + b"\n"
    rel = f"graphs/{name}.json"
    (OUT / rel).write_bytes(gb)
    return rel, sha(gb), gb


def condition_files() -> dict:
    idx = load(RUN2 / "conditions-run2.json")
    conds = {}
    dstd = OUT / "inputs/DC-D5"
    dstd.mkdir(parents=True, exist_ok=True)
    for name, meta in idx["files"].items():
        src = RUN2 / meta["path"]
        blob = src.read_bytes()
        if sha(blob) != meta["sha256"]:
            raise SystemExit(f"condition hash mismatch {name}")
        (dstd / name).write_bytes(blob)
        conds[name] = {"path": f"inputs/DC-D5/{name}", "sha256": meta["sha256"]}
    return conds


def build():
    if (OUT / "manifest.json").exists():
        raise SystemExit(f"refuse: {OUT}/manifest.json exists")
    (OUT / "graphs").mkdir(parents=True, exist_ok=True)
    v1 = load(EXT / "graphs/DC-D1-human.json")
    v1man = load(EXT / "manifest.json")
    v1job = {j["job_id"]: j for j in v1man["jobs"]}["DC-D1-human"]
    bg = load(EXT / "scene-v2/graphs/BG-D1.json")
    idx = load(RUN2 / "conditions-run2.json")
    boxes = idx["boxes"]
    scene_json = json.dumps(load(RUN2 / "inputs/DC-D5/scene.json"), ensure_ascii=False, indent=2)
    camera_ext = json.dumps(load(RUN2 / "inputs/DC-D5/camera-extension.json"), ensure_ascii=False, indent=2)
    conds = condition_files()
    seed_initial, seed_bg = stage_seed("initial"), stage_seed("bg")

    proj_keys = {k for k in v1["11"]["inputs"] if not isinstance(v1["11"]["inputs"][k], list)}
    if proj_keys != {"scene_json", "camera_extension"}:
        raise SystemExit(f"unexpected Project keys: {proj_keys}")

    # ---- A 直出：克隆 v1 D-human 图，替换投影/提示/框/权重/seed/输出名 ----
    a = json.loads(json.dumps(v1))
    a["11"]["inputs"]["scene_json"] = scene_json
    a["11"]["inputs"]["camera_extension"] = camera_ext
    a["1"]["inputs"]["character1"] = SLOT_A
    a["1"]["inputs"]["character2"] = SLOT_B
    for slot in (1, 2):
        b = boxes["owner_a"] if slot == 1 else boxes["owner_b"]
        a["3"]["inputs"].update({
            f"character{slot}_geometry": "box", f"character{slot}_x": b["x"], f"character{slot}_y": b["y"],
            f"character{slot}_width": b["width"], f"character{slot}_height": b["height"]})
        a["2"]["inputs"][f"character{slot}_lora_strength"] = 1.0
        a["2"]["inputs"][f"character{slot}_lora_clip_strength"] = 1.0
    a["8"]["inputs"]["prompt"] = PUBLIC
    a["8"]["inputs"]["seed"] = seed_initial
    a["9"]["inputs"]["filename_prefix"] = "yugang-run2/DC-RUN2-direct"
    a["10"]["inputs"]["label"] = "run2 DC-RUN2 direct"
    rel, gh, _ = write_graph(a, "R2__DC-RUN2__20261112__direct")

    # ---- B1 背景：克隆 scene-v2 BG 图，换板/提示/seed/输出名 ----
    b1 = json.loads(json.dumps(bg))
    b1["1"]["inputs"]["image"] = "yugang-run2-plate.png"
    b1["5"]["inputs"]["text"] = BG_POS
    b1["8"]["inputs"]["seed"] = seed_bg
    b1["10"]["inputs"]["filename_prefix"] = "yugang-run2/BG-RUN2"
    rel_bg, gh_bg, _ = write_graph(b1, "R2__DC-RUN2__20261112__bg")

    # ---- B2 分层人物：新图（finish-v3 形态 + noise_mask + Project 姿态） ----
    b2 = {
        "1": {"class_type": "LoadImage", "inputs": {"image": "yugang-run2-bg.png"}},
        "2": dict(v1["5"]), "3": dict(v1["6"]), "4": dict(v1["7"]),
        "5": {"class_type": "RSMultiCharacterPrompt", "inputs": dict(a["1"]["inputs"])},
        "6": {"class_type": "RSMultiCharacterLoRA", "inputs": {**a["2"]["inputs"], "building_pipe": ["5", 0]}},
        "7": {"class_type": "RSMultiCharacterPosition", "inputs": {**a["3"]["inputs"], "building_pipe": ["6", 0]}},
        "16": {"class_type": "RSMultiCharacterMask",
               "inputs": {"character_id": 1, "enabled": True, "margin": 0, "threshold": 0.5,
                          "building_pipe": ["7", 0], "mask": ["14", 1]}},
        "17": {"class_type": "RSMultiCharacterMask",
               "inputs": {"character_id": 2, "enabled": True, "margin": 0, "threshold": 0.5,
                          "building_pipe": ["16", 0], "mask": ["14", 2]}},
        "8": {"class_type": "RSMultiCharacterFinalize", "inputs": {"building_pipe": ["17", 0]}},
        "9": dict(v1["14"]),
        "14": {"class_type": "YugangStudyCameraProject",
               "inputs": {"scene_json": scene_json, "camera_extension": camera_ext}},
        "10": {"class_type": "AnimaLLLiteApply",
               "inputs": {"strength": 0.8, "start_percent": 0, "end_percent": 0.7,
                          "model": ["2", 0], "model_patch": ["9", 0], "image": ["14", 0]}},
        "15": {"class_type": "LoadImage", "inputs": {"image": "yugang-run2-charmask.png"}},
        "18": {"class_type": "ImageToMask", "inputs": {"image": ["15", 0], "channel": "red"}},
        "11": {"class_type": "YugangRSSceneImg2Img", "inputs": {
            "model": ["10", 0], "clip": ["3", 0], "vae": ["4", 0], "character_pipe": ["8", 0],
            "prompt": PUBLIC, "negative_prompt": NEG, "image": ["1", 0], "noise_mask": ["18", 0],
            "denoise": 1.0, "seed": seed_initial, "steps": 30, "cfg": 4.0,
            "sampler_name": "euler_ancestral", "scheduler": "sgm_uniform",
            "width": 1024, "height": 768, "autosave": False, "save_format": "PNG", "webp_quality": 90}},
        "12": {"class_type": "SaveImage", "inputs": {"images": ["11", 0], "filename_prefix": "yugang-run2/DC-RUN2-layered"}},
        "13": {"class_type": "YugangStudyMetadata", "inputs": {"label": "run2 DC-RUN2 layered"}},
    }
    rel_l, gh_l, _ = write_graph(b2, "R2__DC-RUN2__20261112__layered")

    plate_sha = sha((RUN2 / "inputs/DC-D5/layout_plate.png").read_bytes())
    mask_sha = sha((RUN2 / "inputs/DC-D5/char_noise_mask.png").read_bytes())

    def row(job_id, group, method, stage, seed, gp, ghash, inputs, depends, extra):
        return {
            "job_id": job_id, "group": group, "case_id": "DC-RUN2", "pair": "DC",
            "action": "RUN2", "framing": "D5", "seed": 20261112, "stage": stage, "stage_seed": seed,
            "method": method, "weights": {"A": 1.0, "B": 1.0}, "parent": None,
            "asset_hashes": v1job["asset_hashes"], "expected_visibility": v1job.get("expected_visibility"),
            "comparison_folders": ["D-run2-ab"],
            "execution_fingerprint": sha(json.dumps({"graph_sha": ghash, "seed": seed, "method": method,
                                                     "prompt_sha": sha(PUBLIC.encode()),
                                                     "slot_a_sha": sha(SLOT_A.encode()), "slot_b_sha": sha(SLOT_B.encode())},
                                                    sort_keys=True).encode()),
            "sample_kind": "new", "depends_on": depends, "reuse_of": None,
            "graph_path": gp, "graph_hash": ghash, "expected_width": 1024, "expected_height": 768,
            "input_files": inputs, "condition_files": conds,
            "output_contract": {"image_node_ids": ["9"] if job_id.endswith("direct") else (["10"] if job_id.endswith("bg") else ["12"]),
                                "metadata_node_ids": ["10"] if job_id.endswith("direct") else ([] if job_id.endswith("bg") else ["13"])},
            **extra,
        }

    jobs = [
        row("R2__DC-RUN2__20261112__direct", "D-run2-direct", "direct", "initial", seed_initial, rel, gh, [], [],
            {"chain": ["joint_direct_1diff"]}),
        row("R2__DC-RUN2__20261112__bg", "D-run2-bg", "bg", "bg", seed_bg, rel_bg, gh_bg,
            [{"target": "yugang-run2-plate.png",
              "source": {"kind": "run_root_file", "path": "inputs/DC-D5/layout_plate.png", "sha256": plate_sha}}],
            [], {"chain": ["layout_plate_init", "bg_render_denoise0.8_1diff"]}),
        row("R2__DC-RUN2__20261112__layered", "D-run2-layered", "layered", "initial", seed_initial, rel_l, gh_l,
            [{"target": "yugang-run2-bg.png",
              "source": {"kind": "parent_job", "job_id": "R2__DC-RUN2__20261112__bg", "output_node_id": "10"}},
             {"target": "yugang-run2-charmask.png",
              "source": {"kind": "run_root_file", "path": "inputs/DC-D5/char_noise_mask.png", "sha256": mask_sha}}],
            ["R2__DC-RUN2__20261112__bg"],
            {"chain": ["bg_render_parent", "char_region_noise_mask", "scene_full_strength_denoise1.0_1diff"]}),
    ]

    errors = []
    for j in jobs:
        g = load(OUT / j["graph_path"])
        for k in JOB_REQUIRED_KEYS:
            if k not in j:
                errors.append((j["job_id"], "missing_job_key", k))
        for nid, node in g.items():
            s = RAW.get(node["class_type"])
            if not s:
                errors.append((j["job_id"], nid, "unknown class", node["class_type"])); continue
            for k in s.get("input", {}).get("required", {}):
                if k not in node["inputs"]:
                    errors.append((j["job_id"], nid, node["class_type"], k))
        # 合同预检
        ct = {n["class_type"] for n in g.values()}
        if "YugangRSMaskedImg2Img" in ct:
            errors.append((j["job_id"], "repair_node_not_allowed"))
        for li in j["input_files"]:
            tg = li["target"]
            hits = [n for n in g.values() if n["class_type"] == "LoadImage" and n["inputs"].get("image") == tg]
            if len(hits) != 1:
                errors.append((j["job_id"], "loadimage_target_mismatch", tg))
        if j["method"] == "layered":
            sc = [n for n in g.values() if n["class_type"] == "YugangRSSceneImg2Img"][0]["inputs"]
            if sc["denoise"] != 1.0:
                errors.append((j["job_id"], "layered_denoise_not_1.0"))
            if g.get(str(sc["noise_mask"][0]), {}).get("class_type") != "ImageToMask":
                errors.append((j["job_id"], "noise_mask_not_imagetomask"))
            if g.get(str(sc["model"][0]), {}).get("class_type") != "AnimaLLLiteApply":
                errors.append((j["job_id"], "scene_requires_external_pose_patch"))
        if j["method"] == "direct":
            sm = [n for n in g.values() if n["class_type"] == "RSMultiCharacterSampler"][0]["inputs"]
            if g.get(str(sm["model"][0]), {}).get("class_type") != "AnimaLLLiteApply":
                errors.append((j["job_id"], "direct_requires_external_pose_patch"))
    if errors:
        raise SystemExit(json.dumps({"errors": errors}, ensure_ascii=False))

    manifest = {
        "schema_version": "anima-interaction-manifest.v1", "generated_at": "2026-11-12",
        "generated_by": "scripts/experiments/interaction-run2ab.py",
        "study": "anima-contact-camera-extension.v1/run2-ab",
        "spec_sha256": sha((EXT / "spec.json").read_bytes()),
        "preflight_sha256": sha((EXT / "preflight.json").read_bytes()),
        "execution": {"lab": "isolated-8189", "single_gpu_serial": True},
        "counts": {"total_rows": 3, "total_new": 3, "total_reuse": 0, "budget_max_new_diffusions": 3},
        "scope": {"pairs": ["DC"], "single_variable": "route",
                  "arms": {"A_direct": "B1-recipe joint sampling, 1 diffusion",
                           "B_layered": "BG render 0.8 then char-region denoise 1.0 via scene noise_mask, 2 diffusions"},
                  "shared": {"seed_initial": seed_initial, "seed_bg": seed_bg, "lora_weights": 1.0,
                             "prompts_identical_across_arms": True},
                  "owner_description_verbatim": "deepseek拉着claude的手，在夜空下的原野向远处奔跑，要侧视，人物居于左侧，从左向右、由近向远跑，但不能完全背对镜头，要能看到脸，deepseek在前面，伸手指向夜空，远处是一片波光粼粼的湖面，夜空中群星璀璨，银河清晰可见。"},
        "jobs": jobs,
    }
    mb = json.dumps(manifest, ensure_ascii=False, indent=2).encode() + b"\n"
    (OUT / "manifest.json").write_bytes(mb)
    shutil.copy2(EXT / "spec.json", OUT / "spec.json")
    shutil.copy2(EXT / "preflight.json", OUT / "preflight.json")
    shutil.copy2(REPO / "scripts/experiments/interaction-study-run.py", OUT / "interaction-study-run.py")
    (OUT / "checks").mkdir(exist_ok=True)
    (OUT / "checks/build-run2.json").write_text(json.dumps({
        "manifest_sha256": sha(mb), "jobs": 3, "errors": 0,
        "seed_initial": seed_initial, "seed_bg": seed_bg,
        "box_a": boxes["owner_a"], "box_b": boxes["owner_b"],
        "plate_sha256": plate_sha, "char_mask_sha256": mask_sha,
    }, ensure_ascii=False, indent=2) + "\n")
    print(json.dumps({"manifest_sha256": sha(mb), "jobs": 3, "errors": 0,
                      "seed_initial": seed_initial, "seed_bg": seed_bg}, ensure_ascii=False))


if __name__ == "__main__":
    sys.exit(build())
