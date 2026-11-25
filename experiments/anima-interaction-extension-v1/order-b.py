# SPDX-License-Identifier: GPL-3.0-only
"""order-b.py —— 次序对照 B 臂：initial → 2x 放大 → 质感 pass @2048×1536。

0 扩散部分：initial.png 经 4x-AnimeSharp + lanczos 0.5 → initial2x.png。
1 扩散部分：克隆定稿 finish 图，scene_json 的 width/height 改 2048/1536
（相机投影随分辨率线性缩放，归一化构图不变；本例 camera_extension 为单位阵，
无像素平移需缩放），scene 节点 width/height 同改，image 接 initial2x。
"""
import hashlib
import json
import os
import subprocess
import sys
import time
import urllib.request
import urllib.parse
import uuid

LAB = 'http://127.0.0.1:8189'
SRC_STAGE = os.environ.get('YUGANG_SRC_STAGE', r'C:\Users\<win-user>\yugang-anima-interaction-run-20261111-e970eb55\anima-interaction-v1\stages\pipeline-v1-20261113')
RUN = os.environ.get('YUGANG_RUN_DIR', r'C:\Users\<win-user>\yugang-anima-interaction-run-20261111-e970eb55\anima-interaction-v1\stages\pipeline-v1-orderB')
INITIAL2X = 'yugang-ordB-initial2x.png'
DENOISE = 0.25


def sha(b):
    return hashlib.sha256(b).hexdigest()


def get(path):
    with urllib.request.urlopen(LAB + path, timeout=15) as r:
        return json.loads(r.read())


def post_json(path, obj):
    req = urllib.request.Request(LAB + path, data=json.dumps(obj).encode(),
                                 headers={'Content-Type': 'application/json'})
    with urllib.request.urlopen(req, timeout=15) as r:
        return json.loads(r.read())


def upscale_initial():
    q = get('/queue')
    assert not q['queue_running'] and not q['queue_pending'], 'queue not idle'
    src = os.path.join(SRC_STAGE, 'images', 'PV1__DC-HUG-M__20261113__initial',
                       '12_DC-HUG-M-20261113-initial_00001_.png')
    raw = open(src, 'rb').read()
    up = 'yugang-ordB-init-' + sha(raw)[:16] + '.png'
    b = uuid.uuid4().hex
    body = (b'--' + b.encode() + b'\r\nContent-Disposition: form-data; name="image"; filename="'
            + up.encode() + b'"\r\nContent-Type: image/png\r\n\r\n' + raw + b'\r\n--' + b.encode() + b'--\r\n')
    rq = urllib.request.Request(LAB + '/upload/image', data=body,
                                headers={'Content-Type': 'multipart/form-data; boundary=' + b})
    with urllib.request.urlopen(rq, timeout=120) as r:
        assert json.loads(r.read())['name'] == up
    g = {'1': {'class_type': 'LoadImage', 'inputs': {'image': up}},
         '2': {'class_type': 'UpscaleModelLoader', 'inputs': {'model_name': '4x-AnimeSharp.safetensors'}},
         '3': {'class_type': 'ImageUpscaleWithModel', 'inputs': {'upscale_model': ['2', 0], 'image': ['1', 0]}},
         '4': {'class_type': 'ImageScaleBy', 'inputs': {'image': ['3', 0], 'upscale_method': 'lanczos', 'scale_by': 0.5}},
         '5': {'class_type': 'SaveImage', 'inputs': {'images': ['4', 0], 'filename_prefix': 'pipeline-v1-ordB/initial2x'}}}
    resp = post_json('/prompt', {'prompt': g, 'client_id': str(uuid.uuid4())})
    assert not resp.get('node_errors'), resp.get('node_errors')
    pid = resp['prompt_id']
    for _ in range(600):
        time.sleep(1)
        h = get('/history/' + pid)
        if pid in h:
            o = h[pid].get('outputs', {}).get('5', {}).get('images')
            if o:
                out = o[0]
                break
            if h[pid].get('status', {}).get('status_str') == 'error':
                raise RuntimeError('upscale error')
    else:
        raise RuntimeError('no upscale output')
    qs = urllib.parse.urlencode({'filename': out['filename'], 'subfolder': out.get('subfolder', ''),
                                 'type': out.get('type', 'output')})
    with urllib.request.urlopen(LAB + '/view?' + qs, timeout=300) as r:
        data = r.read()
    os.makedirs(os.path.join(RUN, 'inputs'), exist_ok=True)
    open(os.path.join(RUN, 'inputs', 'initial2x.png'), 'wb').write(data)
    return sha(data)


def build_manifest(init2x_sha):
    fin = json.loads(open(os.path.join(SRC_STAGE, 'graphs', 'PV1__DC-HUG-M__20261113__finish.json'),
                          encoding='utf-8').read())
    scene = json.loads(fin['14']['inputs']['scene_json'])
    assert (scene['width'], scene['height']) == (1024, 768), 'unexpected scene canvas'
    scene['width'], scene['height'] = 2048, 1536
    g = json.loads(json.dumps(fin))
    g['14']['inputs']['scene_json'] = json.dumps(scene, ensure_ascii=False, indent=2)
    g['1']['inputs']['image'] = INITIAL2X
    g['11']['inputs'].update({'width': 2048, 'height': 1536})
    g['12']['inputs']['filename_prefix'] = 'pipeline-v1-ordB/DC-HUG-M-finish-2x-domain'
    g['13']['inputs']['label'] = 'pipeline-v1 orderB pass@2x'
    os.makedirs(os.path.join(RUN, 'graphs'), exist_ok=True)
    gb = json.dumps(g, ensure_ascii=False, indent=2).encode() + b'\n'
    rel = 'graphs/PV1__DC-HUG-M__20261113__finish-ordB.json'
    open(os.path.join(RUN, rel), 'wb').write(gb)
    src_man = json.loads(open(os.path.join(SRC_STAGE, 'manifest.json'), encoding='utf-8').read())
    src_job = {j['job_id']: j for j in src_man['jobs']}['PV1__DC-HUG-M__20261113__finish']
    jid = 'PV1__DC-HUG-M__20261113__finish-ordB'
    job = {k: v for k, v in src_job.items()}
    job.update({
        'job_id': jid, 'group': 'pipeline-v1-orderB', 'stage': 'pass-after-upscale',
        'method': 'pipeline-v1-finish-2x-domain',
        'execution_fingerprint': sha(json.dumps({'graph_sha': sha(gb), 'order': 'upscale_then_pass',
                                                 'base': 'PV1__DC-HUG-M__20261113'}, sort_keys=True).encode()),
        'graph_path': rel, 'graph_hash': sha(gb),
        'expected_width': 2048, 'expected_height': 1536,
        'input_files': [{'target': INITIAL2X,
                         'source': {'kind': 'run_root_file', 'path': 'inputs/initial2x.png',
                                    'sha256': init2x_sha}}],
        'depends_on': [], 'parent': None,
        'output_contract': {'image_node_ids': ['12'], 'metadata_node_ids': ['13']},
        'comparison': 'vs PV1__DC-HUG-M__20261113__finish (pass@base then upscale); single variable = order',
    })
    manifest = {
        'schema_version': 'anima-interaction-manifest.v1', 'generated_at': '2026-11-12',
        'generated_by': 'order-b.py', 'study': 'pipeline-v1-order-comparison',
        'spec_sha256': src_man['spec_sha256'], 'preflight_sha256': src_man['preflight_sha256'],
        'execution': {'lab': 'isolated-8189', 'single_gpu_serial': True},
        'counts': {'total_rows': 1, 'total_new': 1, 'budget_max_new_diffusions': 1},
        'jobs': [job],
    }
    mb = json.dumps(manifest, ensure_ascii=False, indent=2).encode() + b'\n'
    open(os.path.join(RUN, 'manifest.json'), 'wb').write(mb)
    return sha(mb)


def main():
    if os.path.exists(os.path.join(RUN, 'manifest.json')):
        raise SystemExit('refuse: manifest exists')
    os.makedirs(os.path.join(RUN, 'checks'), exist_ok=True)
    s = upscale_initial()
    m = build_manifest(s)
    open(os.path.join(RUN, 'checks', 'build-ordB.json'), 'w', encoding='utf-8').write(json.dumps(
        {'initial2x_sha256': s, 'manifest_sha256': m, 'diffusions': 1}, indent=2))
    print(json.dumps({'build': 'ok', 'manifest': m}))


if __name__ == '__main__':
    main()
