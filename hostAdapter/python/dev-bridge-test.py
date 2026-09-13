#!/usr/bin/env python3
"""Local protocol test for femo_bridge.py (no dsh involved)."""
import subprocess
import sys
import json
import time

sys.stdout.reconfigure(encoding="utf-8", errors="replace")
sys.stderr.reconfigure(encoding="utf-8", errors="replace")

BRIDGE = r"D:\myFiles\fe4m\python\femo_bridge.py"
FE4M = r"D:\myFiles\fe4m"

p = subprocess.Popen(
    [sys.executable, BRIDGE, "--fe4m", FE4M],
    stdin=subprocess.PIPE,
    stdout=subprocess.PIPE,
    stderr=subprocess.PIPE,
    text=True,
    encoding="utf-8",
    errors="replace",
    bufsize=1,
)

def send(obj):
    p.stdin.write(json.dumps(obj) + "\n")
    p.stdin.flush()

send({"id": 1, "cmd": "ping", "args": {}})
send({"id": 2, "cmd": "list_scripts", "args": {}})
send({"id": 3, "cmd": "run", "args": {"femo": "not a real script"}})
time.sleep(2)
p.stdin.close()
try:
    out, err = p.communicate(timeout=15)
except subprocess.TimeoutExpired:
    p.kill()
    out, err = p.communicate()
    print("!! timed out; process killed")
print("=== bridge stdout ===")
print(out)
print("=== bridge stderr (first 2000 chars) ===")
print(err[:2000])
