#!/usr/bin/env python3
"""Standalone Impact candidate; leaves fish and ComfyUI configuration unchanged.

Run with the Windows ComfyUI embedded Python. The supplied templates are the
existing fish workflow JSON files. Generated graphs, status and previews remain
in a new caller-specified directory. A submission with unknown outcome is never
automatically retried.
"""
import io
import itertools
import json
import os
from pathlib import Path
import sys
import time
import urllib.error
import urllib.parse
import urllib.request
import uuid

import cv2
import numpy as np
from PIL import Image

BASE = "http://127.0.0.1:8188"
WIDTH, HEIGHT, SEED = 912, 1216, 194376
PREFIX = "masterpiece, best quality, absurdres, score_7, score_8, score_9, newest, year 2025, detailed, novel illustration, game cg, anime, "
NEGATIVE = "low quality, worst quality, score_1, score_2, score_3, early, old, lips, shiny skin, abs, monochrome,"
SCENES = {
    "holding": "2girls, standing close together, holding hands, looking at each other, smiling, garden, sunlight, full body",
    "bed-overhead": "2girls, lying on a bed, cuddling, holding hands, looking at each other, smiling, bedroom, soft daylight, overhead view, viewed directly from above",
    "bed-side": "2girls, lying together on a bed, cuddling, holding hands, facing each other, smiling, bedroom, soft daylight, horizontal camera angle, eye-level view from the side of the bed, foreground girl partially obscuring the girl behind her",
    "picnic": "2girls, picnic in a park, green grass, picnic blanket, picnic basket, sunlight, one cat, the girl on the left sitting sideways and playfully teasing the cat, the girl on the right looking at her and holding a bag of cat food, relaxed, wide shot",
}
SCENE = SCENES["holding"]
LEFT = "blue hair, very long wavy hair, blue eyes, maid headdress, blue ribbon, blue and white maid dress"
RIGHT = "orange hair, very long wavy hair, orange eyes, hair flower, black bow, white dress"
LEFT_TAGS = "aigirls, aigirls（deepseek）, blue hair, gradient hair, very long hair, wavy hair, ahoge, blue eyes, fins, cetacean tail, maid headdress, blue ribbon"
RIGHT_TAGS = "claude_girl, orange hair, very long hair, wavy hair, bangs, orange eyes, hair flower, hair bow, black bow"


def node(kind, **inputs):
    return {"class_type": kind, "inputs": inputs}


def req(path, data=None, headers=None, timeout=15):
    request = urllib.request.Request(BASE + path, data=data, headers=headers or {})
    with urllib.request.urlopen(request, timeout=timeout) as response:
        return response.read()


def get_json(path):
    return json.loads(req(path))


def require_idle():
    queue = get_json("/queue")
    if not isinstance(queue.get("queue_running"), list) or not isinstance(queue.get("queue_pending"), list):
        raise RuntimeError("queue status unavailable")
    if queue["queue_running"] or queue["queue_pending"]:
        raise RuntimeError("production queue busy; no submission made")


def run_graph(root, name, graph):
    require_idle()
    prompt_id = str(uuid.uuid4())
    (root / (name + "-graph.json")).write_text(json.dumps(graph, ensure_ascii=False, indent=2), encoding="utf-8")
    state = {"stage": name, "prompt_id": prompt_id, "state": "submitting"}
    (root / "status.json").write_text(json.dumps(state), encoding="utf-8")
    print("SUBMITTING", name, prompt_id, flush=True)
    payload = json.dumps({"prompt": graph, "prompt_id": prompt_id, "client_id": str(uuid.uuid4())}).encode("utf-8")
    try:
        result = json.loads(req("/prompt", payload, {"Content-Type": "application/json"}, timeout=30))
    except urllib.error.HTTPError as e:
        print("REJECTED", e.code, e.read().decode("utf-8", errors="replace"), flush=True)
        raise
    if result.get("prompt_id") != prompt_id:
        raise RuntimeError("submission outcome unknown; do not retry")
    state["state"] = "accepted"
    (root / "status.json").write_text(json.dumps(state), encoding="utf-8")
    print("ACCEPTED", name, prompt_id, flush=True)
    deadline = time.monotonic() + 1800
    while time.monotonic() < deadline:
        job = get_json("/history/" + prompt_id).get(prompt_id)
        if job:
            (root / (name + "-history.json")).write_text(json.dumps(job, ensure_ascii=False, indent=2), encoding="utf-8")
            status = job.get("status", {})
            state["state"] = "success" if status.get("status_str") == "success" and status.get("completed") is True else "failed"
            (root / "status.json").write_text(json.dumps(state), encoding="utf-8")
            if state["state"] != "success":
                raise RuntimeError("ComfyUI execution failed; see history")
            print("COMPLETED", name, flush=True)
            return job
        time.sleep(2)
    raise RuntimeError("history timeout; submission outcome unknown; do not retry")


def fetch_image(descriptor):
    filename = descriptor.get("filename", "")
    if descriptor.get("type") != "temp" or descriptor.get("subfolder") or "/" in filename or "\\" in filename or not filename.endswith(".png"):
        raise RuntimeError("unexpected output image path")
    query = urllib.parse.urlencode({"filename": filename, "subfolder": "", "type": "temp"})
    return req("/view?" + query, timeout=60)


def outputs(job, node_id):
    result = job.get("outputs", {}).get(node_id, {}).get("images", [])
    if not result:
        raise RuntimeError("missing output node " + node_id)
    return result


def upload_png(content):
    name = "yugang-ref-" + str(uuid.uuid4()) + ".png"
    boundary = "----fish-impact-" + uuid.uuid4().hex
    body = ("--" + boundary + "\r\nContent-Disposition: form-data; name=\"image\"; filename=\"" + name + "\"\r\nContent-Type: image/png\r\n\r\n").encode() + content
    body += ("\r\n--" + boundary + "\r\nContent-Disposition: form-data; name=\"type\"\r\n\r\ninput\r\n--" + boundary + "--\r\n").encode()
    result = json.loads(req("/upload/image", body, {"Content-Type": "multipart/form-data; boundary=" + boundary}, timeout=60))
    if result.get("name") != name or result.get("type") != "input" or result.get("subfolder"):
        raise RuntimeError("unexpected upload result")
    return name


def scene_graph(template):
    g = {k: template[k] for k in ("1", "2", "3", "30", "31", "32", "33", "34")}
    g["30"]["inputs"].update(width=WIDTH, height=HEIGHT)
    g["31"]["inputs"]["text"] = PREFIX + "on the left: " + LEFT + ", on the right: " + RIGHT + ", " + SCENE
    g["32"]["inputs"]["text"] = NEGATIVE
    g["33"]["inputs"].update(seed=SEED, steps=30)
    g.update({
        "200": node("UltralyticsDetectorProvider", model_name="segm/yolov8x-seg.pt"),
        "201": node("SAMLoader", model_name="sam_vit_b_01ec64.pth", device_mode="AUTO"),
        "202": node("SegmDetectorSEGS", segm_detector=["200", 1], image=["34", 0], threshold=0.35, dilation=10, crop_factor=3, drop_size=10, labels=""),
        "203": node("SAMDetectorSegmented", sam_model=["201", 0], segs=["202", 0], image=["34", 0], detection_hint="center-1", dilation=0, threshold=0.93, bbox_expansion=0, mask_hint_threshold=0.7, mask_hint_use_negative="False"),
        "206": node("MaskToImage", mask=["203", 1]),
        "207": node("PreviewImage", images=["206", 0]),
        "208": node("PreviewImage", images=["34", 0]),
    })
    return g


def person_detection_graph(template, input_name):
    g = scene_graph(template)
    for key in ("1", "2", "3", "30", "31", "32", "33"):
        del g[key]
    g["34"] = node("LoadImage", image=input_name)
    g["202"]["inputs"]["labels"] = "person"
    return g


def masks_from_scene(root, job):
    instances = []
    for descriptor in outputs(job, "207"):
        image = Image.open(io.BytesIO(fetch_image(descriptor))).convert("RGB")
        if image.size != (WIDTH, HEIGHT):
            raise RuntimeError("segmentation dimensions mismatch")
        binary = np.asarray(image)[:, :, 0] > 127
        y, x = np.nonzero(binary)
        if len(x):
            instances.append((len(x), float(x.mean()), binary))
    print("MASK_CANDIDATES", [(area, round(cx, 1)) for area, cx, _ in instances], flush=True)
    valid = [item for item in instances if WIDTH * HEIGHT * 0.01 <= item[0] <= WIDTH * HEIGHT * 0.4]
    pairs = []
    for first, second in itertools.combinations(valid, 2):
        if max(first[0], second[0]) > min(first[0], second[0]) * 3 or abs(first[1] - second[1]) / WIDTH < 0.15:
            continue
        overlap = np.logical_and(first[2], second[2]).sum() / min(first[0], second[0])
        if overlap <= 0.5:
            pairs.append((first, second))
    if len(pairs) != 1:
        raise RuntimeError("segmentation has zero or ambiguous valid pairs; no silent fallback")
    first, second = pairs[0]
    selected = sorted((first, second), key=lambda item: item[1])
    names = []
    for index, (area, centroid, binary) in enumerate(selected):
        mask = cv2.dilate(binary.astype(np.uint8), np.ones((49, 49), dtype=np.uint8))
        rgba = np.full((HEIGHT, WIDTH, 4), 255, dtype=np.uint8)
        rgba[:, :, 3] = np.where(mask, 0, 255).astype(np.uint8)
        out = io.BytesIO()
        Image.fromarray(rgba, "RGBA").save(out, format="PNG")
        data = out.getvalue()
        (root / ("mask-left.png" if index == 0 else "mask-right.png")).write_bytes(data)
        names.append(upload_png(data))
        print("MASK", index, "area", area, "center_x", round(centroid, 1), flush=True)
    return names


def impact_graph(template, scene_image, masks):
    g = {k: template[k] for k in ("1", "2", "3", "32", "60", "61", "62", "63", "64", "65", "66", "100", "101")}
    g["32"]["inputs"]["text"] = NEGATIVE
    scene_prompt = PREFIX + "on the left: " + LEFT + ", on the right: " + RIGHT + ", " + SCENE
    g.update({
        "30": node("LoadImage", image=scene_image),
        "31": node("VAEEncode", pixels=["30", 0], vae=["3", 0]),
        "40": node("CLIPTextEncode", text=scene_prompt, clip=["2", 0]),
        "41": node("CLIPTextEncode", text=PREFIX + LEFT_TAGS + ", " + LEFT + ", " + SCENE, clip=["50", 1]),
        "42": node("CLIPTextEncode", text=PREFIX + RIGHT_TAGS + ", " + RIGHT + ", " + SCENE, clip=["51", 1]),
        "50": node("AnimaLoRARemapTagLoader", model=["1", 0], clip=["2", 0], text="<lora:aigrilsV1.0.safetensors:0.8>", default_weight=1, weight_multiplier=1, auto_remap=True, save_remapped=False, extend_to_new_layers=False, extend_strength=0.5, manifest="Auto (Recommended)"),
        "51": node("AnimaLoRARemapTagLoader", model=["1", 0], clip=["2", 0], text="<lora:claude_girl_anima_lora_clean.safetensors:0.8>", default_weight=1, weight_multiplier=1, auto_remap=True, save_remapped=False, extend_to_new_layers=False, extend_strength=0.5, manifest="Auto (Recommended)"),
        "52": node("ToBasicPipe", model=["1", 0], clip=["2", 0], vae=["3", 0], positive=["40", 0], negative=["32", 0]),
        "53": node("ToBasicPipe", model=["50", 0], clip=["50", 1], vae=["3", 0], positive=["41", 0], negative=["32", 0]),
        "54": node("ToBasicPipe", model=["51", 0], clip=["51", 1], vae=["3", 0], positive=["42", 0], negative=["32", 0]),
        "55": node("KSamplerAdvancedProvider", cfg=4.5, sampler_name="dpmpp_2m", scheduler="sgm_uniform", sigma_factor=1, basic_pipe=["52", 0]),
        "56": node("KSamplerAdvancedProvider", cfg=4.5, sampler_name="dpmpp_2m", scheduler="sgm_uniform", sigma_factor=1, basic_pipe=["53", 0]),
        "57": node("KSamplerAdvancedProvider", cfg=4.5, sampler_name="dpmpp_2m", scheduler="sgm_uniform", sigma_factor=1, basic_pipe=["54", 0]),
        "70": node("LoadImage", image=masks[0]),
        "71": node("LoadImage", image=masks[1]),
        "72": node("RegionalPrompt", mask=["70", 1], advanced_sampler=["56", 0]),
        "73": node("RegionalPrompt", mask=["71", 1], advanced_sampler=["57", 0]),
        "74": node("CombineRegionalPrompts", regional_prompts1=["72", 0], regional_prompts2=["73", 0]),
        "75": node("RegionalSampler", seed=SEED, seed_2nd=0, seed_2nd_mode="ignore", steps=30, base_only_steps=2, denoise=0.75, samples=["31", 0], base_sampler=["55", 0], regional_prompts=["74", 0], overlap_factor=8, restore_latent=True, additional_mode="DISABLE", additional_sampler="AUTO", additional_sigma_ratio=0.3),
        "76": node("VAEDecode", samples=["75", 0], vae=["3", 0]),
        "77": node("PreviewImage", images=["76", 0]),
        "67": node("CLIPTextEncode", text=scene_prompt, clip=["2", 0]),
        "79": node("PreviewImage", images=["65", 0]),
        "80": node("PreviewImage", images=["101", 0]),
        "81": node("SaveText", text=["50", 3], filename_prefix="yugang-impact-audit/left", format="txt"),
        "82": node("SaveText", text=["51", 3], filename_prefix="yugang-impact-audit/right", format="txt"),
    })
    g["61"]["inputs"]["image"] = ["76", 0]
    g["64"]["inputs"].update(seed=SEED, steps=16, denoise=0.30, positive=["67", 0])
    g["101"]["inputs"].update(seed=SEED, denoise=0.25)
    g["66"]["inputs"]["images"] = ["101", 0]
    return g


def main():
    global SCENE, WIDTH, HEIGHT, NEGATIVE, LEFT, RIGHT
    if len(sys.argv) not in (3, 4, 5, 6) or (len(sys.argv) >= 4 and sys.argv[3] not in SCENES) or (len(sys.argv) == 6 and sys.argv[5] != "person-only"):
        raise SystemExit("usage: impact-dual-candidate.py WORKFLOW_MULTI_JSON NEW_OUTPUT_DIR [holding|bed-overhead|bed-side|picnic] [EXISTING_SCENE_DIR [person-only]]")
    case = sys.argv[3] if len(sys.argv) >= 4 else "holding"
    SCENE = SCENES[case]
    if case == "bed-side":
        WIDTH, HEIGHT = 1280, 720
        NEGATIVE += " from above, overhead view, bird's-eye view, top-down view,"
    elif case == "picnic":
        WIDTH, HEIGHT = 1280, 720
        LEFT += ", sitting sideways on the grass, playfully teasing a cat with one hand"
        RIGHT += ", sitting on the grass, looking at the girl on the left, holding a bag of cat food"
    template_path = Path(sys.argv[1])
    root = Path(sys.argv[2])
    root.mkdir(parents=True, exist_ok=False)
    template = json.loads(template_path.read_text(encoding="utf-8"))
    print("OUTPUT", root, "CASE", case, flush=True)
    if len(sys.argv) >= 5:
        source = Path(sys.argv[4])
        old_graph = json.loads((source / "scene-graph.json").read_text(encoding="utf-8"))
        if old_graph != scene_graph(template):
            raise RuntimeError("saved scene does not match candidate parameters")
        scene = json.loads((source / "scene-history.json").read_text(encoding="utf-8"))
        if scene.get("status", {}).get("status_str") != "success" or scene.get("status", {}).get("completed") is not True:
            raise RuntimeError("saved scene did not succeed")
        print("REUSE_SCENE", source, flush=True)
        if len(sys.argv) == 6:
            saved_composition = (source / "composition.png").read_bytes()
            name = upload_png(saved_composition)
            scene = run_graph(root, "person_detection", person_detection_graph(template, name))
    else:
        scene = run_graph(root, "scene", scene_graph(template))
    composition = fetch_image(outputs(scene, "208")[0])
    (root / "composition.png").write_bytes(composition)
    masks = masks_from_scene(root, scene)
    scene_name = upload_png(composition)
    impact = run_graph(root, "impact", impact_graph(template, scene_name, masks))
    for node_id, name in (("77", "regional-base.png"), ("79", "hires.png"), ("80", "face.png"), ("66", "final.png")):
        content = fetch_image(outputs(impact, node_id)[0])
        (root / name).write_bytes(content)
        print("SAVED", name, len(content), flush=True)
    print("DONE", root, flush=True)


if __name__ == "__main__":
    main()
