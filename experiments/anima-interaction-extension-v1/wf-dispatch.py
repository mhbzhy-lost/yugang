# SPDX-License-Identifier: GPL-3.0-only
"""wf-dispatch.py —— 管线唯一派发器：workflow-pipeline-v1.json 模板 + task.json 参数
→ 替换占位符 → 校验 JSON → POST → 轮询 → 下载 initial+final。模拟线上 draw 用法。

task.json 字段：scene_json(str), scene_json_2x(str), camera_extension(str),
slot_a, slot_b, public, negative, lora_a, lora_b, box_a{x,y,w,h}, box_b{x,y,w,h},
w, h, seed_initial, seed_pass, prefix, label
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


def render(template_text, task):
    subs = {
        '{{slot_a}}': task['slot_a'], '{{slot_b}}': task['slot_b'],
        '{{lora_a}}': task['lora_a'], '{{lora_b}}': task['lora_b'],
        '{{public}}': task['public'], '{{negative}}': task['negative'],
        '{{scene_json}}': task['scene_json'], '{{scene_json_2x}}': task['scene_json_2x'],
        '{{camera_extension}}': task['camera_extension'],
        '{{seed_initial}}': str(task['seed_initial']), '{{seed_pass}}': str(task['seed_pass']),
        '{{w}}': str(task['w']), '{{h}}': str(task['h']),
        '{{w2x}}': str(task['w'] * 2), '{{h2x}}': str(task['h'] * 2),
        '{{prefix}}': task['prefix'], '{{label}}': task['label'],
    }
    for key in ('a', 'b'):
        for f in ('x', 'y', 'w', 'h'):
            subs[f'{{{{box_{key}_{f}}}}}'] = repr(task[f'box_{key}'][f])
    text = template_text
    for k, v in subs.items():
        text = text.replace(k, v)
    assert '{{' not in text, 'unresolved placeholder remains: ' + text[text.find('{{'):text.find('{{') + 40]
    return json.loads(text)


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('--template', required=True)
    ap.add_argument('--task', required=True)
    ap.add_argument('--out-dir', required=True)
    ap.add_argument('--timeout', type=int, default=1800)
    a = ap.parse_args()
    task = json.loads(open(a.task, encoding='utf-8').read())
    wf = render(open(a.template, encoding='utf-8').read(), task)
    q = get('/queue')
    assert not q['queue_running'] and not q['queue_pending'], 'lab queue not idle'
    resp = post_json('/prompt', {'prompt': wf, 'client_id': str(uuid.uuid4())})
    assert not resp.get('node_errors'), resp.get('node_errors')
    pid = resp['prompt_id']
    saved = []
    deadline = time.time() + a.timeout
    while time.time() < deadline and not saved:
        time.sleep(3)
        h = get('/history/' + pid)
        if pid not in h:
            continue
        st = h[pid].get('status', {})
        if st.get('status_str') == 'error':
            for tag, m in st.get('messages', []):
                if tag == 'execution_error':
                    raise RuntimeError(str(m)[:600])
            raise RuntimeError('execution error')
        outs = []
        for node, payload in h[pid].get('outputs', {}).items():
            for img in payload.get('images', []):
                if img.get('type') != 'temp':
                    outs.append((node, img))
        if outs:
            os.makedirs(a.out_dir, exist_ok=True)
            for node, img in outs:
                qs = urllib.parse.urlencode({'filename': img['filename'], 'subfolder': img.get('subfolder', ''),
                                             'type': img.get('type', 'output')})
                with urllib.request.urlopen(LAB + '/view?' + qs, timeout=300) as r:
                    data = r.read()
                local = os.path.join(a.out_dir, f'{node}_{img["filename"]}')
                open(local, 'wb').write(data)
                saved.append({'node': node, 'file': local, 'bytes': len(data),
                              'sha256': hashlib.sha256(data).hexdigest()})
    assert saved, 'no output before timeout'
    print(json.dumps({'prompt_id': pid, 'saved': saved}, ensure_ascii=False))


if __name__ == '__main__':
    main()
