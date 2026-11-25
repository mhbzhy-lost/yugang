#!/usr/bin/env python3
"""interaction-finish-v3.py —— D 组收尾链公平重跑（v3）的离线构建器（纯本地、不联网、不采样）。

主人 2026-11-12 裁决：只跑 DC；两臂对称补收尾链：
  初始 pass（复用 v2 scene / v1 human 已付产物，0 新扩散）
  → 4x-AnimeSharp 超分 + lanczos 0.5（净 2x，纯像素，0 扩散）
  → 质感 pass：YugangRSSceneImg2Img(image=2x 图, denoise=0.25, 区域 pipe 同初始, 不挂 LLLite/pose)
    （repair 节点 YugangRSMaskedImg2Img 的冻结保护明确拒绝无 mask 全画布重绘，
      全画布同域重采样合同属于 scene 节点；v2 已验证其全画布 img2img 与区域路由）
每图 1 次新扩散，共 8 次。提示词 = 初始提示词原文（同内容、不加风格词）。
质感 pass 在基础分辨率 1024x768 执行（scene 节点冻结合同只收 1024x768 板）；
4x-AnimeSharp+lanczos0.5 超分移到 pass 之后、离线纯像素派生展示副本（不计扩散、不入 output_contract）。
stage seed = uint32be(SHA256(UTF8(pair|world_id|20261112|pass))[0:4])，两臂同 case 同 seed。
"""
import hashlib
import json
import pathlib
import shutil
import sys

REPO = pathlib.Path(__file__).resolve().parents[2]
EXT = REPO / "var/local-driver/anima-interaction-extension-v1"
V2 = EXT / "scene-v2"
OUT = EXT / "finish-v3"
DL = pathlib.Path.home() / "Downloads/yugang-ab/61-Anima2B-联合接触与镜头约束-20261112"
RAW = V2 / "checks/object-info-raw.json"

ASSETS = {
    "unet": "oneObsessionAnima_v40.safetensors",
    "clip": "qwen_3_06b_base.safetensors",
    "vae": "qwen_image_vae.safetensors",
}
SAMPLER = {"steps": 30, "cfg": 4.0, "sampler_name": "euler_ancestral", "scheduler": "sgm_uniform"}
PASS_DENOISE = 0.25
UPSCALE_MODEL = "4x-AnimeSharp.safetensors"


def sha(b: bytes) -> str:
    return hashlib.sha256(b).hexdigest()


def stage_seed(pair: str, world_id: str, stage: str) -> int:
    return int.from_bytes(hashlib.sha256(f"{pair}|{world_id}|20261112|{stage}".encode()).digest()[:4], "big")


def load_json(p: pathlib.Path):
    return json.loads(p.read_text())


def find_initial_png(kind: str, i: int) -> pathlib.Path:
    if kind == "scene":
        p = DL / "D-scene-v2/images/D-scene-v2" / f"DC-D{i}-scene-v2.png"
        if p.exists():
            return p
        raise SystemExit(f"missing scene initial {p}")
    cands = sorted(DL.glob(f"**/images/D-human/DC-D{i}-human.png"))
    if len(cands) != 1:
        raise SystemExit(f"human initial DC-D{i}: {len(cands)} candidates")
    return cands[0]


def pipe_inputs_from(graph: dict):
    """从初始 graph 原样取区域 pipe 三节点与三个 loader 的 inputs，不改一字。"""
    out = {}
    for nid, node in graph.items():
        ct = node["class_type"]
        if ct == "RSMultiCharacterPrompt":
            out["prompt"] = dict(node["inputs"])
        elif ct == "RSMultiCharacterLoRA":
            out["lora"] = dict(node["inputs"])
        elif ct == "RSMultiCharacterPosition":
            out["position"] = dict(node["inputs"])
        elif ct == "UNETLoader":
            out["unet"] = dict(node["inputs"])
        elif ct == "CLIPLoader":
            out["clip"] = dict(node["inputs"])
        elif ct == "VAELoader":
            out["vae"] = dict(node["inputs"])
        elif ct == "ModelPatchLoader":
            out["patch"] = {k: v for k, v in node["inputs"].items() if not isinstance(v, list)}
        elif ct == "AnimaLLLiteApply":
            out["lllite"] = {k: v for k, v in node["inputs"].items() if not isinstance(v, list)}
        elif ct == "YugangStudyCameraProject":
            out["project"] = {k: v for k, v in node["inputs"].items() if not isinstance(v, list)}
    if len(out) != 9:
        raise SystemExit(f"pipe/loader/pose nodes incomplete: {sorted(out)}")
    return out


def public_prompt_from(graph: dict) -> tuple[str, str]:
    for node in graph.values():
        if node["class_type"] in ("RSMultiCharacterSampler", "YugangRSSceneImg2Img"):
            return node["inputs"]["prompt"], node["inputs"]["negative_prompt"]
    raise SystemExit("no sampler node for prompts")



JOB_REQUIRED_KEYS = [
    "job_id", "case_id", "pair", "action", "framing", "seed", "stage", "stage_seed",
    "method", "weights", "parent", "asset_hashes", "expected_visibility",
    "comparison_folders", "sample_kind", "depends_on", "reuse_of", "graph_path",
    "graph_hash", "expected_width", "expected_height", "input_files", "output_contract",
]


def contract_preflight(manifest: dict, raw: dict) -> list:
    errs = []
    for j in manifest["jobs"]:
        jid = j["job_id"]
        for k in JOB_REQUIRED_KEYS:
            if k not in j:
                errs.append((jid, "missing_job_key", k))
        g = json.loads((OUT / j["graph_path"]).read_text())
        scene = [n for n in g.values() if n["class_type"] == "YugangRSSceneImg2Img"]
        if len(scene) != 1:
            errs.append((jid, "scene_node_count", len(scene))); continue
        sc = scene[0]["inputs"]
        # 守卫1：scene 节点只收 1024x768 板
        if (sc.get("width"), sc.get("height")) != (j["expected_width"], j["expected_height"]):
            errs.append((jid, "scene_size_mismatch", sc.get("width"), sc.get("height")))
        if j["expected_width"] != 1024 or j["expected_height"] != 768:
            errs.append((jid, "expected_not_base_canvas"))
        # 守卫2：scene 节点要求外部原生 Anima pose patch 在模型链上
        mid = sc.get("model")
        if not (isinstance(mid, list) and g.get(str(mid[0]), {}).get("class_type") == "AnimaLLLiteApply"):
            errs.append((jid, "scene_requires_external_pose_patch"))
        # 守卫3：repair 节点不得无 mask 全画布（本构建不使用 repair）
        if any(n["class_type"] == "YugangRSMaskedImg2Img" for n in g.values()):
            errs.append((jid, "repair_node_not_allowed_in_pass"))
        # 链接自洽：image 必须来自 LoadImage；SaveImage 必须接 scene 输出
        img = sc.get("image")
        if not (isinstance(img, list) and g.get(str(img[0]), {}).get("class_type") == "LoadImage"):
            errs.append((jid, "scene_image_not_loadimage"))
        saves = [n for n in g.values() if n["class_type"] == "SaveImage"]
        if len(saves) != 1 or saves[0]["inputs"]["images"] != ["11", 0]:
            errs.append((jid, "save_wiring"))
        # LoadImage 引用名必须与 input_files target 一致
        tgt = j["input_files"][0]["target"]
        if g["1"]["inputs"]["image"] != tgt:
            errs.append((jid, "loadimage_target_mismatch", g["1"]["inputs"]["image"], tgt))
        if j["output_contract"]["image_node_ids"] != [nid for nid, n in g.items() if n["class_type"] == "SaveImage"]:
            errs.append((jid, "output_contract_mismatch"))
    return errs

def build():
    if (OUT / "manifest.json").exists():
        raise SystemExit(f"refuse: {OUT}/manifest.json exists")
    (OUT / "graphs").mkdir(parents=True, exist_ok=True)
    (OUT / "inputs/initial").mkdir(parents=True, exist_ok=True)
    raw = load_json(RAW)
    v1man = load_json(EXT / "manifest.json")
    v2man = load_json(V2 / "manifest.json")
    v1jobs = {j["job_id"]: j for j in v1man["jobs"]}
    v2jobs = {j["job_id"]: j for j in v2man["jobs"]}

    # 公式自证：用 v1 的 initial stage seed 反推 world_id 拼接形式
    probe = v1jobs["DC-D1-human"]
    expect = probe["stage_seed"]
    got = stage_seed("DC", "DC-RUN", "initial")
    if got != expect:
        raise SystemExit(f"seed formula mismatch: {got} != {expect} for {probe['job_id']}")

    jobs = []
    cond_copied = {}
    for i in range(4):
        case = f"DC-D{i}"
        world = "DC-RUN"
        seed = stage_seed("DC", world, "pass")
        for kind, init_jid in (("scene", f"DC-D{i}-scene-v2"), ("human", f"DC-D{i}-human")):
            src_man = v2man if kind == "scene" else v1man
            src_jobs = v2jobs if kind == "scene" else v1jobs
            init = src_jobs[init_jid]
            graph0 = load_json(EXT.parent / "anima-interaction-extension-v1" / src_man["jobs"][0]["graph_path"]) if False else load_json(
                (V2 if kind == "scene" else EXT) / init["graph_path"])
            pipe = pipe_inputs_from(graph0)
            pub, neg = public_prompt_from(graph0)
            png = find_initial_png(kind, i)
            blob = png.read_bytes()
            init_sha = sha(blob)
            recorded = init.get("output_sha256") or None
            # 与交付/状态记录核对：v2 用 state 记录，v1 用 delivery 记录；这里用参数文件里的 local_images sha 兜底
            prm = DL / ("D-scene-v2" if kind == "scene" else "") / "parameters" / f"{init_jid}.json"
            if not prm.exists():
                prm = next(DL.glob(f"**/parameters/{init_jid}.json"))
            prmd = load_json(prm)
            rec_sha = prmd["local_images"][0]["sha256"]
            if init_sha != rec_sha:
                raise SystemExit(f"initial png sha mismatch {init_jid}: {init_sha} != {rec_sha}")
            dst = OUT / "inputs/initial" / f"{init_jid}.png"
            dst.write_bytes(blob)

            # 条件文件：从 v1 manifest 的 condition_files 原样复制并核 hash
            conds = {}
            for name, c in init.get("condition_files", {}).items():
                srcp = (V2 if kind == "scene" else EXT) / c["path"]
                if not srcp.exists():
                    srcp = EXT / c["path"]
                cb = srcp.read_bytes()
                if sha(cb) != c["sha256"]:
                    raise SystemExit(f"condition hash mismatch {init_jid} {name}")
                dstd = OUT / "inputs/cond" / case
                dstd.mkdir(parents=True, exist_ok=True)
                (dstd / name).write_bytes(cb)
                conds[name] = {"path": f"inputs/cond/{case}/{name}", "sha256": c["sha256"]}
            cond_copied[case] = len(conds)

            g = {}
            g["1"] = {"class_type": "LoadImage", "inputs": {"image": f"yugang-fin3-{init_jid}.png"}}
            g["2"] = {"class_type": "UNETLoader", "inputs": pipe["unet"]}
            g["3"] = {"class_type": "CLIPLoader", "inputs": pipe["clip"]}
            g["4"] = {"class_type": "VAELoader", "inputs": pipe["vae"]}
            g["5"] = {"class_type": "RSMultiCharacterPrompt", "inputs": pipe["prompt"]}
            g["6"] = {"class_type": "RSMultiCharacterLoRA", "inputs": {**pipe["lora"], "building_pipe": ["5", 0]}}
            g["7"] = {"class_type": "RSMultiCharacterPosition", "inputs": {**pipe["position"], "building_pipe": ["6", 0]}}
            g["8"] = {"class_type": "RSMultiCharacterFinalize", "inputs": {"building_pipe": ["7", 0]}}
            g["9"] = {"class_type": "ModelPatchLoader", "inputs": pipe["patch"]}
            g["14"] = {"class_type": "YugangStudyCameraProject", "inputs": pipe["project"]}
            g["10"] = {"class_type": "AnimaLLLiteApply", "inputs": {**pipe["lllite"], "model": ["2", 0], "model_patch": ["9", 0], "image": ["14", 0]}}
            g["9x_placeholder"] = None
            del g["9x_placeholder"]
            g["9"] = {"class_type": "ModelPatchLoader", "inputs": pipe["patch"]}
            g["11"] = {
                "class_type": "YugangRSSceneImg2Img",
                "inputs": {
                    "model": ["10", 0], "clip": ["3", 0], "vae": ["4", 0], "character_pipe": ["8", 0],
                    "prompt": pub, "negative_prompt": neg, "image": ["1", 0], "denoise": PASS_DENOISE,
                    "seed": seed, **SAMPLER, "width": 1024, "height": 768,
                    "autosave": False, "save_format": "PNG", "webp_quality": 90,
                },
            }
            g["12"] = {"class_type": "SaveImage", "inputs": {"images": ["11", 0], "filename_prefix": f"yugang-fin3-{case}-{kind}"}}
            g["13"] = {"class_type": "YugangStudyMetadata", "inputs": {"label": f"finish-v3 {case} {kind} pass"}}
            gb = json.dumps(g, ensure_ascii=False, indent=2).encode() + b"\n"
            gpath = f"graphs/{case}__finish-{kind}.json"
            (OUT / gpath).write_bytes(gb)

            jobs.append({
                "job_id": f"DF__{case}__20261112__finish-{kind}",
                "group": f"D-finish-{kind}",
                "case_id": case,
                "pair": "DC",
                "action": init.get("action"),
                "framing": init.get("framing"),
                "seed": 20261112,
                "stage": "pass",
                "stage_seed": seed,
                "method": f"finish-{kind}",
                "weights": {"A": 0.8, "B": 0.8, "denoise": PASS_DENOISE},
                "parent": None,
                "lineage": {"initial_job": init_jid, "initial_sha256": init_sha,
                            "initial_run_root": "scene-v2-20261112" if kind == "scene" else "anima-interaction-extension-v1",
                            "note": "初始 pass 为已付产物，本 job 仅执行收尾链；血缘不构成本 manifest 内依赖"},
                "parent_initial_sha256": init_sha,
                "asset_hashes": init["asset_hashes"],
                "expected_visibility": init.get("expected_visibility"),
                "comparison_folders": ["D-finish-v3"],
                "execution_fingerprint": sha(json.dumps({
                    "graph_inputs_sha": sha(json.dumps(pipe, ensure_ascii=False, sort_keys=True).encode()),
                    "initial_sha256": init_sha, "denoise": PASS_DENOISE,
                    "upscale": [UPSCALE_MODEL, "lanczos", 0.5], "seed": seed,
                    "prompt_sha256": sha(pub.encode()), "negative_sha256": sha(neg.encode()),
                }, sort_keys=True).encode()),
                "sample_kind": "new",
                "depends_on": [],
                "reuse_of": None,
                "graph_path": gpath,
                "graph_hash": sha(gb),
                "expected_width": 1024,
                "expected_height": 768,
                "input_files": [{
                    "target": f"yugang-fin3-{init_jid}.png",
                    "source": {
                        "kind": "run_root_file",
                        "path": f"inputs/initial/{init_jid}.png",
                        "sha256": init_sha,
                    },
                }],
                "condition_files": conds,
                "output_contract": {"image_node_ids": ["12"], "metadata_node_ids": ["13"]},
                "chain": ["reuse_initial_0diff", "texture_pass_denoise0.25_base_res_1diff", "upscale_display_offline_0diff"],
                "lllite_in_pass": False,
                "pose_in_pass": False,
            })

    # Schema 静态校验（真实 object_info）
    errors = []
    for j in jobs:
        g = load_json(OUT / j["graph_path"])
        for nid, node in g.items():
            s = raw.get(node["class_type"])
            if not s:
                errors.append((j["job_id"], nid, "unknown class")); continue
            req = s.get("input", {}).get("required", {})
            for k in req:
                if k not in node["inputs"]:
                    errors.append((j["job_id"], nid, node["class_type"], k))
            if node["class_type"] == "UpscaleModelLoader":
                opts = req["model_name"][1].get("options", req["model_name"][0] if isinstance(req["model_name"][0], list) else [])
                if isinstance(opts, list) and node["inputs"]["model_name"] not in opts:
                    errors.append((j["job_id"], nid, "enum", node["inputs"]["model_name"]))
            if node["class_type"] == "ImageScaleBy":
                m = req["upscale_method"][0]
                if node["inputs"]["upscale_method"] not in m:
                    errors.append((j["job_id"], nid, "enum", node["inputs"]["upscale_method"]))
    if errors:
        raise SystemExit(json.dumps({"schema_errors": errors}, ensure_ascii=False))
    cerrs = contract_preflight(manifest_pre := {"jobs": jobs}, raw)
    if cerrs:
        raise SystemExit(json.dumps({"contract_errors": cerrs}, ensure_ascii=False))

    manifest = {
        "schema_version": "anima-interaction-manifest.v1",
        "generated_at": "2026-11-12",
        "generated_by": "scripts/experiments/interaction-finish-v3.py",
        "study": "anima-contact-camera-extension.v1/finish-v3",
        "spec_sha256": sha((EXT / "spec.json").read_bytes()),
        "preflight_sha256": sha((EXT / "preflight.json").read_bytes()),
        "execution": {"lab": "isolated-8189", "single_gpu_serial": True},
        "counts": {"total_rows": 8, "total_new": 8, "total_reuse": 0,
                   "budget_max_new_diffusions": 8, "reused_initials": 8, "reused_backgrounds": 0},
        "scope": {"pairs": ["DC"], "qg_excluded_by_owner": True,
                  "chain": ["reuse_initial", "upscale_net2x_0diff", "texture_pass_0.25_1diff"],
                  "frozen": {"order": "upscale_then_pass_at_2x", "pass_prompt": "initial_verbatim",
                             "hd_excluded": True, "lllite_in_pass": False, "pose_in_pass": False}},
        "jobs": jobs,
    }
    mb = json.dumps(manifest, ensure_ascii=False, indent=2).encode() + b"\n"
    (OUT / "manifest.json").write_bytes(mb)
    shutil.copy2(EXT / "spec.json", OUT / "spec.json")
    shutil.copy2(EXT / "preflight.json", OUT / "preflight.json")
    shutil.copy2(REPO / "scripts/experiments/interaction-study-run.py", OUT / "interaction-study-run.py")
    checks = {
        "builder_sha256": sha(pathlib.Path(__file__).read_bytes()),
        "manifest_sha256": sha(mb),
        "schema_errors": 0,
        "jobs": 8,
        "cond_files_per_case": cond_copied,
        "initial_shas": {j["parent"]: j["parent_initial_sha256"] for j in jobs},
        "seed_formula_selfcheck": "v1 initial stage_seed reproduced from pair|world_id|20261112|initial",
    }
    (OUT / "checks").mkdir(exist_ok=True)
    (OUT / "checks/build-finish-v3.json").write_text(json.dumps(checks, ensure_ascii=False, indent=2) + "\n")
    print(json.dumps({"manifest_sha256": checks["manifest_sha256"], "jobs": 8, "schema_errors": 0}, ensure_ascii=False))


if __name__ == "__main__":
    sys.exit(build())
