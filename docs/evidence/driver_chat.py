#!/usr/bin/env python3
"""KAI evidence driver: real OpenCode chat turn over the control layer.

No third-party deps. Talks to the OpenCode headless server on 127.0.0.1:4096
using the routes published at GET /doc (POST /session, POST /session/{id}/message).
"""
import json
import os
import sys
import time
import urllib.request
import urllib.error

BASE = "http://127.0.0.1:4096"


def call(method, path, body=None, timeout=180):
    data = None if body is None else json.dumps(body).encode()
    req = urllib.request.Request(BASE + path, data=data, method=method)
    if data is not None:
        req.add_header("content-type", "application/json")
    req.add_header("accept", "application/json")
    t0 = time.time()
    try:
        with urllib.request.urlopen(req, timeout=timeout) as r:
            raw = r.read().decode("utf-8", "replace")
            return r.status, raw, time.time() - t0
    except urllib.error.HTTPError as e:
        return e.code, e.read().decode("utf-8", "replace"), time.time() - t0
    except Exception as e:  # noqa: BLE001
        return None, f"{type(e).__name__}: {e}", time.time() - t0


def main():
    out = {}
    status, raw, dt = call("GET", "/global/health")
    out["health"] = {"status": status, "body": raw, "seconds": round(dt, 2)}
    print("health:", status, raw)

    provider = os.environ.get("KAI_PROVIDER", "opencode-go")
    model = os.environ.get("KAI_MODEL", "deepseek-v4-flash")

    status, raw, dt = call("POST", "/session", {
        "title": "KAI selftest - chat turn (2026-10-01)",
        "model": {"providerID": provider, "id": model},
    })
    out["create_session"] = {"status": status, "body": raw, "seconds": round(dt, 2)}
    print("create session:", status, raw[:300])
    if status != 200:
        json.dump(out, open("kai-core-chat-turn.json", "w"), indent=2)
        return 1
    sid = json.loads(raw)["id"]

    prompt = "Reply with exactly this token and nothing else: KAI-CONTROL-LAYER-OK"
    t0 = time.time()
    status, raw, dt = call("POST", f"/session/{sid}/message",
                           {"parts": [{"type": "text", "text": prompt}],
                            "model": {"providerID": provider, "modelID": model},
                            "agent": os.environ.get("KAI_AGENT", "build")})
    out["prompt"] = {
        "session_id": sid,
        "prompt_sent": prompt,
        "status": status,
        "seconds": round(dt, 2),
        "body": raw,
    }
    print("prompt:", status, f"{dt:.1f}s")
    print(raw[:2000])

    # Pull the assistant text out of the returned message object.
    text = None
    try:
        msg = json.loads(raw)
        parts = msg.get("parts") or []
        text = "\n".join(p.get("text", "") for p in parts
                         if p.get("type") == "text").strip()
    except Exception as e:  # noqa: BLE001
        print("parse failed:", e)

    out["assistant_text"] = text
    print("\nASSISTANT TEXT:", repr(text))

    json.dump(out, open("kai-core-chat-turn.json", "w"), indent=2)
    return 0 if text else 1


if __name__ == "__main__":
    sys.exit(main())
