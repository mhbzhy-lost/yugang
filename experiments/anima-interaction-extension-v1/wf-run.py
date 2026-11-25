# SPDX-License-Identifier: GPL-3.0-only
"""wf-run.py —— 薄驱动：加载 workflow.json（API 格式）→ 上传输入图 → POST →
轮询 history（服务器 prompt_id）→ /view 下载产物。模拟线上 draw 的直接用法。

用法：python -X utf8 -s -B wf-run.py --workflow <json> --out-dir <dir> [--inputs k=path ...]
"""
import argparse
import hashlib
import json
import os
import time
import urllib.request
import urllib.parse
import uuid

LAB = 'http://127.0.0.1:8189'


def get(path, timeout=15):
    with urllib.request.urlopen(LAB + path, timeout=timeout) as r:
        return json.loads(r.read())


def post_json(path, obj):
    req = urllib.request.Request(LAB + path, data=json.dumps(obj).encode(),
                                 headers={'Content-Type': 'application/json'})
    with urllib.request.urlopen(req, timeout=20) as r:
        return json.loads(r.read())


def upload(raw, name):
    b = uuid.uuid4().hex
    body = (b'--' + b.encode() + b'\r\nContent-Disposition: form-data; name="image"; filename="'
            + name.encode() + b'"\r\nContent-Type: image/png\r\n\r\n' + raw + b'\r\n--' + b.encode() + b'--\r\n')
    rq = urllib.request.Request(LAB + '/upload/image', data=body,
                                headers={'Content-Type': 'multipart/form-data; boundary=' + b})
    with urllib.request.urlopen(rq, timeout=120) as r:
        got = json.loads(r.read())
    assert got.get('name') == name, got
    return name


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('--workflow', required=True)
    ap.add_argument('--out-dir', required=True)
    ap.add_argument('--inputs', nargs='*', default=[],
                    help='target=本地路径：把图上传并替换图中 LoadImage 的 image 引用')
    ap.add_argument('--timeout', type=int, default=1800)
    a = ap.parse_args()
    wf = json.loads(open(a.workflow, encoding='utf-8').read())
    for item in a.inputs:
        target, path = item.split('=', 1)
        raw = open(path, 'rb').read()
        up = 'wf-' + hashlib.sha256(raw).hexdigest()[:16] + '.png'
        upload(raw, up)
        hits = [n for n in wf.values() if n.get('class_type') == 'LoadImage' and n['inputs'].get('image') == target]
        assert len(hits) == 1, f'LoadImage target {target}: {len(hits)} hits'
        hits[0]['inputs']['image'] = up
    q = get('/queue')
    assert not q['queue_running'] and not q['queue_pending'], 'lab queue not idle'
    resp = post_json('/prompt', {'prompt': wf, 'client_id': str(uuid.uuid4())})
    assert not resp.get('node_errors'), resp.get('node_errors')
    pid = resp['prompt_id']
    deadline = time.time() + a.timeout
    outs = None
    while time.time() < deadline:
        time.sleep(2)
        h = get('/history/' + pid)
        if pid not in h:
            continue
        st = h[pid].get('status', {})
        if st.get('status_str') == 'error':
            for tag, m in st.get('messages', []):
                if tag == 'execution_error':
                    raise RuntimeError(str(m)[:600])
            raise RuntimeError('execution error')
        for node, payload in h[pid].get('outputs', {}).items():
            for img in payload.get('images', []):
                if img.get('type') == 'temp':
                    continue
                outs = outs or []
                outs.append((node, img))
        if outs:
            break
    assert outs, 'no output before timeout'
    os.makedirs(a.out_dir, exist_ok=True)
    saved = []
    for node, img in outs:
        qs = urllib.parse.urlencode({'filename': img['filename'], 'subfolder': img.get('subfolder', ''),
                                     'type': img.get('type', 'output')})
        with urllib.request.urlopen(LAB + '/view?' + qs, timeout=300) as r:
            data = r.read()
        local = os.path.join(a.out_dir, f'{node}_{img["filename"]}')
        open(local, 'wb').write(data)
        saved.append({'node': node, 'file': local, 'bytes': len(data),
                      'sha256': hashlib.sha256(data).hexdigest()})
    print(json.dumps({'prompt_id': pid, 'saved': saved}, ensure_ascii=False))


if __name__ == '__main__':
    main()
