#!/usr/bin/env python3
"""Find a provider/model pair that actually answers, using OpenCode's own route."""
import json
import sys
import urllib.error
import urllib.request

BASE = "http://127.0.0.1:4096"

PAIRS = [
    ("z", "glm-4.7"),
    ("nvidia", "z-ai/glm5"),
    ("logfare", "deepseek-v4-flash"),
    ("seraphyn", "glm-4.7"),
    ("ezif", "glm-5.1"),
    ("github-copilot", "gpt-5.4-mini"),
    ("opencode", "minimax-m2.5-free"),
    ("modal", "zai-org/GLM-5-FP8"),
]


def call(method, path, body=None, timeout=90):
    data = None if body is None else json.dumps(body).encode()
    req = urllib.request.Request(BASE + path, data=data, method=method)
    if data is not None:
        req.add_header("content-type", "application/json")
    try:
        with urllib.request.urlopen(req, timeout=timeout) as r:
            return r.status, r.read().decode("utf-8", "replace")
    except urllib.error.HTTPError as e:
        return e.code, e.read().decode("utf-8", "replace")
    except Exception as e:  # noqa: BLE001
        return None, f"{type(e).__name__}: {e}"


def main():
    ok = []
    for provider, model in PAIRS:
        status, raw = call("POST", "/session", {"title": f"KAI probe {provider}/{model}"})
        if status != 200:
            print(f"{provider}/{model}: session create failed {status}")
            continue
        sid = json.loads(raw)["id"]
        status, raw = call("POST", f"/session/{sid}/message", {
            "parts": [{"type": "text", "text": "Reply with just: OK"}],
            "model": {"providerID": provider, "modelID": model},
            "agent": "build",
        }, timeout=120)
        try:
            msg = json.loads(raw)
            info = msg.get("info", {})
            err = info.get("error")
            text = "\n".join(p.get("text", "") for p in (msg.get("parts") or [])
                             if p.get("type") == "text").strip()
        except Exception:  # noqa: BLE001
            err, text = raw[:200], ""
        if text:
            print(f"OK   {provider}/{model}: {text[:80]!r}")
            ok.append((provider, model, text))
        else:
            reason = ""
            if isinstance(err, dict):
                reason = str(err.get("data", {}).get("message"))[:90]
            print(f"FAIL {provider}/{model}: {reason}")
    print("\nusable:", [(p, m) for p, m, _ in ok])
    return 0 if ok else 1


if __name__ == "__main__":
    sys.exit(main())
