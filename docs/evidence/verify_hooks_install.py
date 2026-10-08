#!/usr/bin/env python3
"""Re-check that the Claude Code hook install in ~/.claude/settings.json is
additive and exactly reversible, against the pre-install copy and the dated
backup the app itself took.

    python verify_hooks_install.py
"""
import glob
import hashlib
import json
import os
import sys

HOME = r"C:\Users\DELL\.claude"
SETTINGS = os.path.join(HOME, "settings.json")
MARKER = "kai-hook"

KAI_EVENTS = [
    "SessionStart", "SessionEnd", "UserPromptSubmit", "PreToolUse", "PostToolUse",
    "PostToolUseFailure", "PermissionRequest", "Notification", "Stop", "StopFailure",
    "SubagentStart", "SubagentStop",
]


def load(path):
    with open(path, encoding="utf-8-sig") as handle:
        return json.load(handle)


def sha(path):
    with open(path, "rb") as handle:
        return hashlib.sha256(handle.read()).hexdigest()


def ours(entry):
    return any(MARKER in str(h.get("command", "")) for h in entry.get("hooks", []))


def without_ours(settings):
    """Re-implementation of hooks::without_ours() in app/src-tauri/src/hooks.rs."""
    out = {k: v for k, v in settings.items()}
    hooks = settings.get("hooks")
    if not isinstance(hooks, dict):
        return out
    kept_events = {}
    for event, value in hooks.items():
        if isinstance(value, list):
            kept = [e for e in value if not ours(e)]
            if kept:
                kept_events[event] = kept
        else:
            kept_events[event] = value
    if kept_events:
        out["hooks"] = kept_events
    else:
        out.pop("hooks", None)
    return out


def main():
    pre_candidates = sorted(glob.glob(os.path.join(HOME, "settings.json.pre-kai-*")))
    app_backups = sorted(glob.glob(os.path.join(HOME, "settings.json.bak-*")))
    if not pre_candidates:
        print("FAIL: no pre-install copy found (settings.json.pre-kai-*)")
        return 1
    pre_path = pre_candidates[-1]
    app_backup = app_backups[-1] if app_backups else None

    pre, after = load(pre_path), load(SETTINGS)

    print(f"pre-install copy : {pre_path}")
    print(f"  sha256         : {sha(pre_path)}")
    print(f"settings.json    : {SETTINGS}")
    print(f"  sha256         : {sha(SETTINGS)}")
    print(f"app's own backup : {app_backup}")
    print("  sha256         :", sha(app_backup) if app_backup else "n/a")
    print("  identical to my pre-install copy:",
          bool(app_backup) and open(app_backup, "rb").read() == open(pre_path, "rb").read())

    print()
    print("top-level keys before:", sorted(pre))
    print("top-level keys after :", sorted(after))
    changed = [k for k in pre if pre[k] != after.get(k)]
    added = sorted(set(after) - set(pre))
    removed = sorted(set(pre) - set(after))
    print("keys added / removed :", added, "/", removed)
    print("values changed       :", changed)

    pre_hooks, after_hooks = pre.get("hooks", {}), after.get("hooks", {})
    lost = [e for ev in pre_hooks for e in pre_hooks[ev] if e not in after_hooks.get(ev, [])]
    print()
    print(f"{'event':26} {'before':>6} {'after':>6} {'kai':>4}")
    for event in sorted(set(pre_hooks) | set(after_hooks)):
        before = pre_hooks.get(event, [])
        now = after_hooks.get(event, [])
        kai = sum(1 for e in now if ours(e))
        print(f"{event:26} {len(before):6} {len(now):6} {kai:4}")
    print()
    print("pre-existing hook entries lost:", len(lost))

    missing = [e for e in KAI_EVENTS if not any(ours(x) for x in after_hooks.get(e, []))]
    print("KAI events missing a hook     :", missing or "none")

    # Reversibility, both as objects and as the exact bytes the app would write.
    reversed_obj = without_ours(after)
    print()
    print("removing KAI's entries reproduces the original object :", reversed_obj == pre)
    round_trip = json.dumps(reversed_obj, indent=2, ensure_ascii=False) + "\n"
    with open(pre_path, encoding="utf-8-sig") as handle:
        original_text = handle.read()
    print("... and byte-for-byte the original file               :", round_trip == original_text)

    ok = (
        not lost and not added and not removed and changed == ["hooks"]
        and not missing and reversed_obj == pre and round_trip == original_text
    )
    print()
    print("RESULT:", "PASS" if ok else "FAIL")
    return 0 if ok else 1


if __name__ == "__main__":
    sys.exit(main())
