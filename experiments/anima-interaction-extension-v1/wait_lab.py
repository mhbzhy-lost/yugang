import json
import sys
import time
import urllib.request

deadline = time.time() + 300
while time.time() < deadline:
    try:
        with urllib.request.urlopen('http://127.0.0.1:8189/queue', timeout=5) as r:
            q = json.loads(r.read())
        if not q['queue_running'] and not q['queue_pending']:
            print('LAB_UP_IDLE')
            sys.exit(0)
    except Exception:
        pass
    time.sleep(3)
print('LAB_TIMEOUT')
sys.exit(1)
