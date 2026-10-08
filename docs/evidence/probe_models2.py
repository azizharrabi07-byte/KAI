#!/usr/bin/env python3
"""Bounded hunt for a provider/model pair that answers, via OpenCode's own API.

Every attempt is a real session + a real prompt; failures are reported with the
provider's own error message so the result is auditable.
"""
import json
import sys
import time
import urllib.error
import urllib.request

BASE = "http://127.0.0.1:4096"

PAIRS = [
    ("github-copilot", "claude-sonnet-4.6"),
    ("github-copilot", "claude-sonnet-4"),
    ("voidai", "claude-sonnet-4-6"),
    ("swiftrouter", "claude-sonnet-4-6"),
    ("modal", "zai-org/GLM-5.1-FP8"),
    ("openference", "GLM-5.2"),
    ("zenllm", "xiaomi/mimo-v2.5-pro-full"),
    ("llmzone", "claude-opus-4.6-2026"),
    ("seraphyn", "gpt-5.3-chat-latest"),
    ("aqua", "gpt-5.6-terra"),
    ("aihubmix", "coding-glm-5-free"),
    ("zai", "glm-5v-turbo"),
]


def call(method, path, body=None, timeout=60):
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
    good = []
    for provider, model in PAIRS:
        t0 = time.time()
        status, raw = call("POST", "/session", {"title": f"KAI probe {provider}/{model}"})
        if status != 200:
            print(f"FAIL {provider}/{model}: session create HTTP {status}", flush=True)
            continue
        sid = json.loads(raw)["id"]
        status, raw = call("POST", f"/session/{sid}/message", {
            "parts": [{"type": "text", "text": "Reply with just: OK"}],
            "model": {"providerID": provider, "modelID": model},
            "agent": "build",
        }, timeout=75)
        dt = time.time() - t0
        try:
            msg = json.loads(raw)
            info = msg.get("info", {})
            err = info.get("error")
            text = "\n".join(p.get("text", "") for p in (msg.get("parts") or [])
                             if p.get("type") == "text").strip()
        except Exception:  # noqa: BLE001
            err, text = raw[:200], ""
        if text:
            print(f"OK   {provider}/{model} ({dt:.1f}s): {text[:60]!r}", flush=True)
            good.append((provider, model))
        else:
            reason = ""
            if isinstance(err, dict):
                reason = str(err.get("data", {}).get("message"))[:110]
            print(f"FAIL {provider}/{model} ({dt:.1f}s): {reason}", flush=True)
    print("\nUSABLE:", json.dumps(good), flush=True)
    return 0 if good else 1


if __name__ == "__main__":
    sys.exit(main())
