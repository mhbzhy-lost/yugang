# SPDX-License-Identifier: GPL-3.0-only
"""pipeline-v1.py —— 直出管线驱动（规格见 PIPELINE-V1.md）。

用法（Windows 嵌入式 Python）：
  python -X utf8 -s -B pipeline-v1.py --case DC-HUG-M --seed 20261113 \
    --src-manifest <full-execution-v4/manifest.json> --run-root <本阶段目录> \
    --lab-url http://127.0.0.1:8189 --permit <submit-permit.json>

流程：克隆源 B1 图（仅改 LoRA 强度→1.0、输出名）→ 派生 finish 图（scene img2img
0.25 + Project 外部姿态）→ 单 manifest 两 job（finish 依赖 initial，parent_job 链接）
→ runner 串行执行（2 扩散）→ finish 输出离线 2x 超分（0 扩散）→ 汇总 JSON。
"""
import argparse
import hashlib
import json
import os
import shutil
import subprocess
import sys
import time
import urllib.request
import urllib.parse
import uuid

DENOISE_PASS = 0.25
UPSCALE_MODEL = '4x-AnimeSharp.safetensors'
# 主人 2026-11-12 裁定：v1 采用生产地板（原文写入，不做增删）
FLOOR_POS = 'masterpiece, best quality, absurdres, score_7, score_8, score_9, '
FLOOR_NEG = ('low quality, worst quality, score_1, score_2, score_3, early, old, '
             'monochrome, lips, shiny skin')


def sha(b):
    return hashlib.sha256(b).hexdigest()


def stage_seed(pair, case, seeddate, stage):
    return int.from_bytes(hashlib.sha256(f'{pair}|{case}|{seeddate}|{stage}'.encode()).digest()[:4], 'big')


def write_json(path, obj):
    with open(path, 'w', encoding='utf-8') as f:
        f.write(json.dumps(obj, ensure_ascii=False, indent=2) + '\n')


def load(p):
    return json.loads(open(p, encoding='utf-8').read())


def build(args):
    src = load(args.src_manifest)
    jobs = {j['job_id']: j for j in src['jobs']}
    src_jid = f'B__{args.case}__{args.seed}__B1'
    sj = jobs.get(src_jid)
    if not sj:
        raise SystemExit(f'source job missing: {src_jid}')
    sg = load(os.path.join(os.path.dirname(args.src_manifest), sj['graph_path']))

    g_init = json.loads(json.dumps(sg))
    for slot in (1, 2):
        g_init['2']['inputs'][f'character{slot}_lora_strength'] = 1.0
        g_init['2']['inputs'][f'character{slot}_lora_clip_strength'] = 1.0
    # 主人裁定的生产地板：正向换质量头（场景/景别/2girls 段保留），负向整串替换
    old_pos = g_init['11']['inputs']['prompt']
    head = 'masterpiece, best quality, '
    if not old_pos.startswith(head):
        raise SystemExit('unexpected public prompt head: ' + old_pos[:60])
    g_init['11']['inputs']['prompt'] = FLOOR_POS + old_pos[len(head):]
    g_init['11']['inputs']['negative_prompt'] = FLOOR_NEG
    init_id = f'PV1__{args.case}__{args.seed}__initial'
    g_init['12']['inputs']['filename_prefix'] = f'pipeline-v1/{args.case}-{args.seed}-initial'
    g_init['13']['inputs']['label'] = f'pipeline-v1 {args.case} {args.seed} initial'

    scene_path = os.path.join(args.structure_root, args.case, 'scene.json')
    scene_json = open(scene_path, encoding='utf-8').read()
    want_sha = (sj.get('structure_provenance') or {}).get('scene_json', {}).get('sha256')
    if want_sha and sha(scene_json.encode()) != want_sha:
        raise SystemExit('scene.json hash mismatch vs source manifest')
    sampler = g_init['11']['inputs']
    pass_seed = stage_seed(sj['pair'], args.case, str(args.seed), 'pass')
    camera_ext = json.dumps({'matrix': [[1, 0, 0], [0, 1, 0], [0, 0, 1]], 'roll': 0,
                             'center': None, 'tail': None}, ensure_ascii=False)
    g_fin = {
        '1': {'class_type': 'LoadImage', 'inputs': {'image': f'yugang-pv1-{args.case}-initial.png'}},
        '2': dict(g_init['8']), '3': dict(g_init['9']), '4': dict(g_init['10']),
        '5': dict(g_init['1']),
        '6': {'class_type': 'RSMultiCharacterLoRA', 'inputs': {**g_init['2']['inputs'], 'building_pipe': ['5', 0]}},
        '7': {'class_type': 'RSMultiCharacterPosition', 'inputs': {**g_init['3']['inputs'], 'building_pipe': ['6', 0]}},
        '8': {'class_type': 'RSMultiCharacterFinalize', 'inputs': {'building_pipe': ['7', 0]}},
        '9': {'class_type': 'ModelPatchLoader',
              'inputs': {'name': 'rs_reference\\anima_pose\\anima_3dpose_outline_7000.safetensors'}},
        '14': {'class_type': 'YugangStudyCameraProject',
               'inputs': {'scene_json': scene_json, 'camera_extension': camera_ext}},
        '10': {'class_type': 'AnimaLLLiteApply',
               'inputs': {'strength': 0.8, 'start_percent': 0, 'end_percent': 0.7,
                          'model': ['2', 0], 'model_patch': ['9', 0], 'image': ['14', 0]}},
        '11': {'class_type': 'YugangRSSceneImg2Img', 'inputs': {
            'model': ['10', 0], 'clip': ['3', 0], 'vae': ['4', 0], 'character_pipe': ['8', 0],
            'prompt': sampler['prompt'], 'negative_prompt': sampler['negative_prompt'],
            'image': ['1', 0], 'denoise': DENOISE_PASS, 'seed': pass_seed,
            'steps': sampler['steps'], 'cfg': sampler['cfg'],
            'sampler_name': sampler['sampler_name'], 'scheduler': sampler['scheduler'],
            'width': 1024, 'height': 768, 'autosave': False, 'save_format': 'PNG', 'webp_quality': 90}},
        '12': {'class_type': 'SaveImage',
               'inputs': {'images': ['11', 0], 'filename_prefix': f'pipeline-v1/{args.case}-{args.seed}-finish'}},
        '13': {'class_type': 'YugangStudyMetadata', 'inputs': {'label': f'pipeline-v1 {args.case} {args.seed} finish'}},
    }
    fin_id = f'PV1__{args.case}__{args.seed}__finish'
    os.makedirs(os.path.join(args.run_root, 'graphs'), exist_ok=True)
    entries = []
    for jid, g, method, stage, sseed, inputs, parent, deps in (
        (init_id, g_init, 'pipeline-v1-initial', 'initial', sj['stage_seed'], [], None, []),
        (fin_id, g_fin, 'pipeline-v1-finish', 'pass', pass_seed,
         [{'target': f'yugang-pv1-{args.case}-initial.png',
           'source': {'kind': 'parent_job', 'job_id': init_id, 'output_node_id': '12'}}],
         init_id, [init_id]),
    ):
        gb = json.dumps(g, ensure_ascii=False, indent=2).encode() + b'\n'
        rel = f'graphs/{jid}.json'
        open(os.path.join(args.run_root, rel), 'wb').write(gb)
        entries.append({
            'job_id': jid, 'group': 'pipeline-v1', 'case_id': args.case, 'pair': sj['pair'],
            'action': sj.get('action'), 'framing': sj.get('framing'), 'seed': int(args.seed),
            'stage': stage, 'stage_seed': sseed, 'method': method,
            'weights': {'A': 1.0, 'B': 1.0, 'denoise': DENOISE_PASS if method.endswith('finish') else None},
            'parent': parent, 'asset_hashes': sj['asset_hashes'],
            'expected_visibility': sj.get('expected_visibility'),
            'comparison_folders': ['PIPELINE-V1'],
            'execution_fingerprint': sha(json.dumps({'graph_sha': sha(gb), 'seed': sseed,
                                                     'source_job': src_jid}, sort_keys=True).encode()),
            'sample_kind': 'new', 'depends_on': deps, 'reuse_of': None,
            'graph_path': rel, 'graph_hash': sha(gb),
            'expected_width': 1024, 'expected_height': 768,
            'input_files': inputs, 'condition_files': {},
            'output_contract': {'image_node_ids': ['12'], 'metadata_node_ids': ['13']},
            'source_job': src_jid,
        })
    manifest = {
        'schema_version': 'anima-interaction-manifest.v1', 'generated_at': '2026-11-12',
        'generated_by': 'pipeline-v1.py', 'study': 'pipeline-v1',
        'spec_sha256': sha(open(args.spec, encoding='utf-8').read().encode()),
        'preflight_sha256': sha(open(args.preflight, 'rb').read()),
        'execution': {'lab': 'isolated-8189', 'single_gpu_serial': True},
        'counts': {'total_rows': 2, 'total_new': 2, 'budget_max_new_diffusions': 2},
        'jobs': entries,
    }
    write_json(os.path.join(args.run_root, 'manifest.json'), manifest)
    return init_id, fin_id


def run_runner(args):
    r = subprocess.run([sys.executable, '-s', '-B', os.path.join(args.run_root, 'interaction-study-run.py'),
                        'worker-run', '--manifest', os.path.join(args.run_root, 'manifest.json'),
                        '--run-root', args.run_root, '--lab-url', args.lab_url,
                        '--permit', args.permit, '--max-new-jobs', '2',
                        '--expect-schema-version', 'anima-interaction-manifest.v1',
                        '--poll-interval-seconds', '3'])
    return r.returncode


def upscale_finish(args, fin_id):
    state = load(os.path.join(args.run_root, 'state.json'))
    job = state['jobs'][fin_id]
    assert job['status'] == 'success', job['status']
    src = next(iter(job['outputs']['files'].values()))
    raw = open(src, 'rb').read()
    s = sha(raw)

    def get(path):
        with urllib.request.urlopen(args.lab_url + path, timeout=15) as r:
            return json.loads(r.read())

    def post_json(path, obj):
        req = urllib.request.Request(args.lab_url + path, data=json.dumps(obj).encode(),
                                     headers={'Content-Type': 'application/json'})
        with urllib.request.urlopen(req, timeout=15) as r:
            return json.loads(r.read())
    q = get('/queue')
    assert not q['queue_running'] and not q['queue_pending'], 'queue not idle'
    up = 'yugang-pv1-fx-' + s[:16] + '.png'
    b = uuid.uuid4().hex
    body = (b'--' + b.encode() + b'\r\nContent-Disposition: form-data; name="image"; filename="'
            + up.encode() + b'"\r\nContent-Type: image/png\r\n\r\n' + raw + b'\r\n--' + b.encode() + b'--\r\n')
    rq = urllib.request.Request(args.lab_url + '/upload/image', data=body,
                                headers={'Content-Type': 'multipart/form-data; boundary=' + b})
    with urllib.request.urlopen(rq, timeout=60) as r:
        assert json.loads(r.read())['name'] == up
    g = {'1': {'class_type': 'LoadImage', 'inputs': {'image': up}},
         '2': {'class_type': 'UpscaleModelLoader', 'inputs': {'model_name': UPSCALE_MODEL}},
         '3': {'class_type': 'ImageUpscaleWithModel', 'inputs': {'upscale_model': ['2', 0], 'image': ['1', 0]}},
         '4': {'class_type': 'ImageScaleBy', 'inputs': {'image': ['3', 0], 'upscale_method': 'lanczos', 'scale_by': 0.5}},
         '5': {'class_type': 'SaveImage', 'inputs': {'images': ['4', 0], 'filename_prefix': 'pipeline-v1/' + fin_id}}}
    resp = post_json('/prompt', {'prompt': g, 'client_id': str(uuid.uuid4())})
    assert not resp.get('node_errors'), resp.get('node_errors')
    pid = resp['prompt_id']
    out = None
    for _ in range(300):
        time.sleep(1)
        h = get('/history/' + pid)
        if pid in h:
            o = h[pid].get('outputs', {}).get('5', {}).get('images')
            if o:
                out = o[0]
                break
            if h[pid].get('status', {}).get('status_str') == 'error':
                raise RuntimeError('upscale error')
    assert out, 'no upscale output'
    qs = urllib.parse.urlencode({'filename': out['filename'], 'subfolder': out.get('subfolder', ''),
                                 'type': out.get('type', 'output')})
    with urllib.request.urlopen(args.lab_url + '/view?' + qs, timeout=120) as r:
        data = r.read()
    dst = os.path.join(args.run_root, 'derivations', fin_id + '__2x.png')
    os.makedirs(os.path.dirname(dst), exist_ok=True)
    open(dst, 'wb').write(data)
    write_json(os.path.join(args.run_root, 'checks', 'upscale.json'), {
        'source': src, 'source_sha256': s, 'derivation': dst,
        'derivation_sha256': sha(data), 'model': UPSCALE_MODEL, 'net_scale': 2, 'diffusion': False})
    return dst


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('--case', required=True)
    ap.add_argument('--seed', required=True)
    ap.add_argument('--src-manifest', required=True)
    ap.add_argument('--structure-root', required=True)
    ap.add_argument('--run-root', required=True)
    ap.add_argument('--lab-url', default='http://127.0.0.1:8189')
    ap.add_argument('--permit', required=True)
    ap.add_argument('--spec', required=True)
    ap.add_argument('--preflight', required=True)
    args = ap.parse_args()
    if os.path.exists(os.path.join(args.run_root, 'manifest.json')):
        raise SystemExit('refuse: manifest exists')
    os.makedirs(os.path.join(args.run_root, 'checks'), exist_ok=True)
    init_id, fin_id = build(args)
    rc = run_runner(args)
    if rc != 0:
        raise SystemExit(f'runner rc={rc}')
    fx = upscale_finish(args, fin_id)
    state = load(os.path.join(args.run_root, 'state.json'))
    fin = state['jobs'][fin_id]
    print(json.dumps({'initial': state['jobs'][init_id]['outputs']['files'],
                      'finish': fin['outputs']['files'], 'upscale_2x': fx,
                      'finish_sha256': list(fin['outputs']['hashes'].values())[0]}))


if __name__ == '__main__':
    main()
