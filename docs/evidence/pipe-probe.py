import os
import sys

PIPE_DIR = "\\\\.\\pipe\\"

try:
    names = os.listdir(PIPE_DIR)
except OSError as exc:
    print(f"listdir({PIPE_DIR!r}) failed: {exc}")
    sys.exit(1)

print("total pipes:", len(names))
kia = sorted(n for n in names if "kai" in n.lower())
print("pipes containing 'kai':", kia)

sid = "S-1-5-21-2720510131-810976395-3426585012-1001"
wanted = "kai-" + sid
print("expected server name:", wanted)
print("present:", wanted in names)

# And the real test: can a client open it?
try:
    with open(PIPE_DIR + wanted, "r+b", buffering=0) as fh:
        print("open() succeeded — the server is listening")
except OSError as exc:
    print(f"open() failed: {exc}")
