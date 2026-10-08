#!/usr/bin/env bash
# Phase 3, item A — "the app ensures KAI Core itself", proved from a COLD start.
#
# Preconditions this script creates itself, and states out loud:
#   * any kai.exe from a previous run is stopped;
#   * nothing is listening on 127.0.0.1:8788;
#   * %LOCALAPPDATA%\KAI\kai.log is rotated aside so the new lines are unambiguous.
#
# It then launches the PACKAGED app (app/target/release/kai.exe) with no terminal
# involved, and reports — in order — the log, the process tree, the port, the Core's
# own answers, a restart after the Core is killed, and the no-orphan behaviour when
# the app is killed outright. Nothing here is synthesised: every line is the output
# of the command printed above it.
#
#   bash docs/evidence/push3-a-cold-start.sh
set -u
cd "$(dirname "$0")/../.." || exit 1
export LC_ALL=C

KAI_EXE="app/target/release/kai.exe"
LOCAL_WIN="$LOCALAPPDATA\\KAI"
LOG_WIN="$LOCAL_WIN\\kai.log"
LOG_POSIX="$LOCALAPPDATA/KAI/kai.log"

ps_out() { powershell -NoProfile -Command "$1"; }
kai_pids() { ps_out "Get-Process kai -ErrorAction SilentlyContinue | Select-Object -ExpandProperty Id" | tr -d '\r' | tr -s ' \n' ' '; }
listeners() { netstat -ano | grep -E ':8788 .*LISTENING' || true; }
has_listener() { [ -n "$(listeners)" ]; }
listener_pid() { listeners | awk '{print $NF}' | head -1; }
node_8788() {
  pid=$(listener_pid)
  if [ -z "$pid" ]; then echo "(nothing on 8788)"; return; fi
  ps_out "Get-CimInstance Win32_Process -Filter \"ProcessId=$pid\" | Select-Object ProcessId,ParentProcessId,ExecutablePath,CommandLine | Format-List"
}
core_status() { node docs/evidence/cdp.mjs eval "window.__TAURI_INTERNALS__.invoke('core_status').then(r => JSON.stringify(r))" --target island 2>&1; }
listener_line() { if has_listener; then listeners; else echo "  (nothing on 8788)"; fi; }

echo "################ 0. what the machine looks like now ################"
echo "\$ Get-Process kai | Select Id"
ps_out "Get-Process kai -ErrorAction SilentlyContinue | Select-Object -ExpandProperty Id" | tr -d '\r'
for pid in $(kai_pids); do echo "  stopping kai.exe pid $pid"; node -e "process.kill($pid)"; done
sleep 2
pids=$(kai_pids)
echo "  kai.exe after stop: ${pids:-none}"

echo
echo "\$ netstat -ano | grep ':8788 .*LISTENING'      # before anything is launched"
old=$(listeners)
if [ -n "$old" ]; then
  echo "$old"
  for pid in $(echo "$old" | awk '{print $NF}' | sort -u); do
    echo "  stopping the Core left over from the previous session (pid $pid)"
    node -e "process.kill($pid)"
  done
  sleep 2
fi
listener_line

echo
echo "\$ curl -s -m 3 http://127.0.0.1:8788/state"
curl -s -m 3 http://127.0.0.1:8788/state || echo "(no answer — nothing is running KAI Core)"

echo
echo "################ 1. a clean log ################"
mv "$LOG_POSIX" "$LOG_POSIX.prepush3" 2>/dev/null && echo "kai.log rotated to kai.log.prepush3"

echo
echo "################ 2. launch the packaged app, cold ################"
echo "\$ powershell -File docs/evidence/launch-cdp.ps1     # sets the debug port via env only"
powershell -NoProfile -File docs/evidence/launch-cdp.ps1
for i in $(seq 1 30); do
  sleep 1
  [ -n "$(kai_pids)" ] && break
done
sleep 8
echo
echo "\$ Get-Process kai | Select Id,ProcessName,MainWindowTitle,Responding"
ps_out "Get-Process kai | Select-Object Id,ProcessName,MainWindowTitle,Responding | Format-List" | tr -d '\r'

echo
echo "\$ tail -30 %LOCALAPPDATA%\\KAI\\kai.log"
tail -30 "$LOG_POSIX"

echo
echo "\$ netstat -ano | grep ':8788 .*LISTENING'"
listener_line
echo
echo "\$ Get-CimInstance Win32_Process -Filter ProcessId=<8788 owner> | Format-List"
node_8788

echo
echo "\$ Get-CimInstance Win32_Process (children of kai.exe)"
for pid in $(kai_pids); do
  echo "  children of $pid:"
  ps_out "Get-CimInstance Win32_Process -Filter \"ParentProcessId=$pid\" | Select-Object ProcessId,Name,CommandLine | Format-List" | tr -d '\r'
done

echo
echo "\$ curl -s http://127.0.0.1:8788/state   # the Core the app started"
curl -s -m 5 http://127.0.0.1:8788/state | head -c 900
echo
echo
echo "\$ curl -s -X POST http://127.0.0.1:8788/chat -d '{\"text\":\"what is happening?\"}'"
curl -s -m 30 -X POST http://127.0.0.1:8788/chat -H 'content-type: application/json' \
  -d '{"text":"what is happening?"}' | head -c 900
echo

echo
echo "\$ node docs/evidence/cdp.mjs eval \"invoke('core_status')\"   # what the app itself reports"
core_status

echo
echo "################ 3. kill the Core under the running app ################"
pid=$(listener_pid)
echo "killing the Core pid ${pid:-<none>} (the app is left running)"
if [ -n "$pid" ]; then node -e "process.kill($pid)"; fi
for i in $(seq 1 20); do
  sleep 1
  now=$(listener_pid)
  if [ -n "$now" ] && [ "$now" != "$pid" ]; then break; fi
done
echo
echo "after the restart:"
listener_line
echo "\$ tail -8 kai.log"
tail -8 "$LOG_POSIX"
echo "\$ curl -s http://127.0.0.1:8788/state | head -c 200"
curl -s -m 5 http://127.0.0.1:8788/state | head -c 200
echo

echo
echo "################ 4. kill the APP outright — is the Core orphaned? ################"
pid=$(listener_pid)
app_pid=$(kai_pids | awk '{print $1}')
echo "app pid ${app_pid:-<none>}, Core pid ${pid:-<none>}"
echo "\$ node -e \"process.kill($app_pid)\"        # TerminateProcess, not a clean exit"
node -e "process.kill($app_pid)"
sleep 4
echo
left=$(kai_pids)
echo "kai.exe after the kill: ${left:-none}"
echo "\$ netstat -ano | grep ':8788 .*LISTENING'"
if has_listener; then
  listeners
  echo "  ^ STILL LISTENING — the Core outlived the app"
else
  echo "  (nothing on 8788 — the Core died with the app)"
fi
echo "\$ tail -4 kai.log"
tail -4 "$LOG_POSIX"
