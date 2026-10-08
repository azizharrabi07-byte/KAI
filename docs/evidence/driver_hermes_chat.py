import json
import os
import re
import time
import urllib.error
import urllib.request

env_path = r"C:\Users\DELL\.hermes\.env"
key = None
for line in open(env_path, encoding="utf-8", errors="replace"):
    m = re.match(r"\s*(?:export\s+)?API_SERVER_KEY\s*=\s*(.+)\s*$", line)
    if m:
        key = m.group(1).strip().strip('"').strip("'")

BASE = "http://127.0.0.1:8642"
SESSION = os.environ.get("KAI_HERMES_SESSION", "api_1790876616_56289fcc")
PROMPT = "Reply with exactly this token and nothing else: KAI-CONTROL-LAYER-OK"


def call(method, path, body=None, timeout=300):
    data = None if body is None else json.dumps(body).encode()
    req = urllib.request.Request(BASE + path, data=data, method=method)
    if data is not None:
        req.add_header("content-type", "application/json")
    req.add_header("authorization", "Bearer " + (key or ""))
    t0 = time.time()
    try:
        with urllib.request.urlopen(req, timeout=timeout) as r:
            return r.status, r.read().decode("utf-8", "replace"), time.time() - t0
    except urllib.error.HTTPError as e:
        return e.code, e.read().decode("utf-8", "replace"), time.time() - t0
    except Exception as e:  # noqa: BLE001
        return None, f"{type(e).__name__}: {e}", time.time() - t0


print(f"session={SESSION} prompt={PROMPT!r}", flush=True)
status, raw, dt = call("POST", f"/api/sessions/{SESSION}/chat", {"message": PROMPT})
print(f"POST /api/sessions/{SESSION}/chat -> {status} in {dt:.1f}s", flush=True)
print(raw[:2500], flush=True)

out = {"session": SESSION, "prompt": PROMPT, "status": status, "seconds": round(dt, 2), "body": raw}
json.dump(out, open("hermes-chat-turn.json", "w"), indent=2)
