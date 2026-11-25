# SPDX-License-Identifier: GPL-3.0-only
"""ws-run.py —— 提交 workflow + WebSocket 逐节点计时（显式 session 生命周期）。"""
import argparse
import asyncio
import hashlib
import json
import os
import time

import aiohttp

LAB = 'http://127.0.0.1:8189'
WS = 'ws://127.0.0.1:8189/ws'


async def run(workflow, out_dir, timeout):
    wf = json.loads(open(workflow, encoding='utf-8').read())
    client_id = os.urandom(16).hex()
    session = aiohttp.ClientSession()
    ws = None
    try:
        q = await (await session.get(LAB + '/queue')).json()
        assert not q['queue_running'] and not q['queue_pending'], 'queue not idle'
        ws = await session.ws_connect(WS + '?clientId=' + client_id)
        resp = await session.post(LAB + '/prompt', json={'prompt': wf, 'client_id': client_id})
        r = await resp.json()
        assert not r.get('node_errors'), r.get('node_errors')
        pid = r['prompt_id']
        started = {}
        deadline = time.time() + timeout
        done = False
        while not done and time.time() < deadline:
            try:
                msg = await asyncio.wait_for(ws.receive(), timeout=max(1, deadline - time.time()))
            except asyncio.TimeoutError:
                break
            if msg.type != aiohttp.WSMsgType.TEXT:
                continue
            e = json.loads(msg.data)
            et = e.get('type')
            if et == 'executing':
                node = e['data'].get('node')
                if node:
                    started[node] = time.time()
            elif et in ('execution_success', 'execution_error', 'execution_interrupted'):
                done = True
        h = await (await session.get(LAB + '/history/' + pid)).json()
        assert pid in h, 'no history'
        st = h[pid].get('status', {})
        if st.get('status_str') == 'error':
            for tag, m in st.get('messages', []):
                if tag == 'execution_error':
                    raise RuntimeError(str(m)[:600])
        os.makedirs(out_dir, exist_ok=True)
        saved = []
        for node, payload in h[pid].get('outputs', {}).items():
            for img in payload.get('images', []):
                if img.get('type') == 'temp':
                    continue
                data = await (await session.get(LAB + '/view', params={
                    'filename': img['filename'], 'subfolder': img.get('subfolder', ''),
                    'type': img.get('type', 'output')})).read()
                local = os.path.join(out_dir, f'{node}_{img["filename"]}')
                open(local, 'wb').write(data)
                saved.append({'node': node, 'file': local, 'bytes': len(data),
                              'sha256': hashlib.sha256(data).hexdigest()})
        ordered = sorted(started.items(), key=lambda kv: kv[1])
        durations = {}
        for i, (node, t0) in enumerate(ordered):
            t1 = ordered[i + 1][1] if i + 1 < len(ordered) else time.time()
            durations[node] = round(t1 - t0, 2)
        print(json.dumps({'prompt_id': pid, 'node_seconds': durations, 'saved': saved}, ensure_ascii=False))
    finally:
        if ws is not None:
            await ws.close()
        await session.close()


if __name__ == '__main__':
    ap = argparse.ArgumentParser()
    ap.add_argument('--workflow', required=True)
    ap.add_argument('--out-dir', required=True)
    ap.add_argument('--timeout', type=int, default=2400)
    a = ap.parse_args()
    asyncio.run(run(a.workflow, a.out_dir, a.timeout))
