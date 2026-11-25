import asyncio
import json
import os
import time

import aiohttp

LAB = 'http://127.0.0.1:8189'


async def main():
    wf = json.load(open('graph-sit1-3x.json'))
    cid = os.urandom(16).hex()
    s = aiohttp.ClientSession()
    try:
        q = await (await s.get(LAB + '/queue')).json()
        assert not q['queue_running'] and not q['queue_pending']
        ws = await s.ws_connect(LAB.replace('http', 'ws') + '/ws?clientId=' + cid)
        r = await (await s.post(LAB + '/prompt', json={'prompt': wf, 'client_id': cid})).json()
        assert not r.get('node_errors'), r.get('node_errors')
        pid = r['prompt_id']
        events = []
        t0 = time.time()
        done = False
        while not done and time.time() - t0 < 2400:
            try:
                msg = await asyncio.wait_for(ws.receive(), timeout=max(1, 2400 - (time.time() - t0)))
            except asyncio.TimeoutError:
                break
            if msg.type != aiohttp.WSMsgType.TEXT:
                continue
            e = json.loads(msg.data)
            node = e.get('data', {}).get('node') if isinstance(e.get('data'), dict) else None
            events.append((round(time.time() - t0, 2), e.get('type'), node))
            if e.get('type') in ('execution_success', 'execution_error', 'execution_interrupted'):
                done = True
        await ws.close()
        for t, typ, node in events:
            print(f'{t:8.2f} {typ} {node}')
        print('PROMPT', pid, 'EVENTS', len(events))
    finally:
        await s.close()


asyncio.run(main())
