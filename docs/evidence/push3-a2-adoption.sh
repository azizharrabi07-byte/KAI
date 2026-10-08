#!/usr/bin/env bash
# Phase 3, item A, second half — "don't double-start if one is already listening".
#
# Only one Core may run: it binds a fixed port and owns the SQLite file
# (docs/development.md). So a Core that is already on 127.0.0.1:8788 must be ADOPTED,
# not duplicated — two Cores would fight over the same database.
#
# The precondition (a Core already running) is created here by hand, on purpose: this
# script tests the adoption rule, not the startup rule, and the hand-started Core is
# stopped again at the end.
#
#   bash docs/evidence/push3-a2-adoption.sh
set -u
cd "$(dirname "$0")/../.." || exit 1
export LC_ALL=C

LOG_POSIX="$LOCALAPPDATA/KAI/kai.log"
listen_pid() { netstat -ano | grep -E ':8788 .*LISTENING' | awk '{print $NF}' | head -1; }
has_listener() { [ -n "$(listen_pid)" ]; }
kai_pids() { powershell -NoProfile -Command "Get-Process kai -ErrorAction SilentlyContinue | Select-Object -ExpandProperty Id" | tr -d '\r' | tr -s ' \n' ' '; }
cores() {
  powershell -NoProfile -Command "Get-CimInstance Win32_Process -Filter \"Name='node.exe'\" | Where-Object { \$_.CommandLine -like '*core*server.js*' } | Select-Object -ExpandProperty ProcessId" | tr -d '\r' | tr -s ' \n' ' '
}
core_status() { node docs/evidence/cdp.mjs eval "window.__TAURI_INTERNALS__.invoke('core_status').then(r => JSON.stringify(r))" --target island 2>&1; }

echo "################ 0. clean slate ################"
for pid in $(kai_pids); do node -e "process.kill($pid)"; done
sleep 2
if has_listener; then
  pid=$(listen_pid)
  echo "  stopping a leftover Core (pid $pid)"
  node -e "process.kill($pid)"
  sleep 2
fi
left=$(kai_pids)
corelist=$(cores)
echo "  kai.exe: ${left:-none}"
echo "  Core processes: ${corelist:-none}"

echo
echo "################ 1. a Core that is ALREADY running (the precondition) ################"
NODE_EXE='C:\Users\DELL\.hermes\tools\node-26.7.0-win32-x64\node.exe'
SERVER_JS="$(cygpath -w "$(pwd)/core/bundle/server.js" 2>/dev/null || echo "$(pwd)/core/bundle/server.js")"
echo "\$ Start-Process node core/bundle/server.js   # by hand, on purpose"
MANUAL=$(powershell -NoProfile -Command "\$p = Start-Process -FilePath '$NODE_EXE' -ArgumentList '$SERVER_JS' -PassThru -WindowStyle Hidden; \$p.Id" | tr -d '\r')
echo "  hand-started Core pid: $MANUAL"
for i in $(seq 1 12); do
  sleep 1
  curl -s -m 2 http://127.0.0.1:8788/state >/dev/null 2>&1 && break
done
echo "  netstat: $(netstat -ano | grep -E ':8788 .*LISTENING')"
echo "  GET /state: $(curl -s -m 3 http://127.0.0.1:8788/state | head -c 90)"
echo "  Core processes now: $(cores)"

echo
echo "################ 2. now start the app ################"
echo "\$ powershell -File docs/evidence/launch-cdp.ps1"
powershell -NoProfile -File docs/evidence/launch-cdp.ps1 | tr -d '\r'
sleep 14
echo "  kai.exe: $(kai_pids)"
echo
echo "\$ grep 'core:' kai.log | tail -4"
grep -E "core: " "$LOG_POSIX" | tail -4
echo
echo "\$ netstat -ano | grep ':8788 .*LISTENING'      # must still be the SAME pid"
netstat -ano | grep -E ':8788 .*LISTENING'
echo "  listener pid: $(listen_pid)      hand-started pid: $MANUAL"
if [ "$(listen_pid)" = "$MANUAL" ]; then
  echo "  ^ unchanged: the app did not start a second Core"
else
  echo "  ^ CHANGED — the app replaced the running Core"
fi
echo
echo "\$ node processes running core/server.js        # must be exactly one"
cores
echo
echo "\$ node docs/evidence/cdp.mjs eval \"invoke('core_status')\""
core_status

echo
echo "################ 3. cleanup ################"
app=$(kai_pids | awk '{print $1}')
echo "\$ node -e \"process.kill($app)\"                 # quit the app; it started no Core, so it should kill none"
node -e "process.kill($app)"
sleep 3
echo "  kai.exe: $(kai_pids)"
echo "  listener pid after the app quit: $(listen_pid)   (the hand-started Core is not the app's to kill)"
echo "\$ node -e \"process.kill($MANUAL)\"              # stop the hand-started Core"
node -e "process.kill($MANUAL)"
sleep 2
if has_listener; then echo "  8788 STILL LISTENING"; else echo "  8788 is free again"; fi
