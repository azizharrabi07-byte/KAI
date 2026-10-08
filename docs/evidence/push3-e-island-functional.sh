#!/usr/bin/env bash
# Phase 3, item E — the packaged app, end to end, as a user meets it.
#
# Not a test suite: the checks a person would make on a machine where KAI has just been
# started — the process, its title, whether it answers, the relay pipe, the log, the
# Core, and one real chat turn typed at the keyboard into the island.
#
#   bash docs/evidence/push3-e-island-functional.sh
set -u
cd "$(dirname "$0")/../.." || exit 1
export LC_ALL=C

LOG_POSIX="$LOCALAPPDATA/KAI/kai.log"
cdp() { node docs/evidence/cdp.mjs "$@" --target island; }
kai_pids() { powershell -NoProfile -Command "Get-Process kai -ErrorAction SilentlyContinue | Select-Object -ExpandProperty Id" | tr -d '\r' | tr -s ' \n' ' '; }
listen_pid() { netstat -ano | grep -E ':8788 .*LISTENING' | awk '{print $NF}' | head -1; }
point_of() { echo "$1" | node -e "let s='';process.stdin.on('data',d=>s+=d).on('end',()=>{const j=JSON.parse(s);console.log(j.x,j.y,j.dpr);});"; }

if [ -z "$(kai_pids)" ]; then
  echo "\$ powershell -File docs/evidence/launch-cdp.ps1"
  powershell -NoProfile -File docs/evidence/launch-cdp.ps1
  sleep 12
fi

echo "################ 1. the process ################"
echo "\$ Get-Process kai | Select Id,ProcessName,MainWindowTitle,Responding"
powershell -NoProfile -Command "Get-Process kai | Select-Object Id,ProcessName,MainWindowTitle,Responding,StartTime | Format-List" | tr -d '\r'

echo
echo "################ 2. the relay pipe (Claude Code's way in) ################"
echo "\$ [System.IO.Directory]::GetFiles('\\\\.\\pipe\\') | Where-Object { \$_ -like '*kai-*' }"
powershell -NoProfile -Command "[System.IO.Directory]::GetFiles('\\\\.\\pipe\\') | Where-Object { \$_ -like '*kai-*' }" | tr -d '\r'

echo
echo "################ 3. the Core the APP started ################"
echo "\$ netstat -ano | grep ':8788 .*LISTENING'"
netstat -ano | grep -E ':8788 .*LISTENING'
pid=$(listen_pid)
echo "\$ Get-CimInstance Win32_Process -Filter ProcessId=$pid | Select ParentProcessId,CommandLine"
powershell -NoProfile -Command "Get-CimInstance Win32_Process -Filter \"ProcessId=$pid\" | Select-Object ProcessId,ParentProcessId,CommandLine | Format-List" | tr -d '\r'
echo "  kai.exe pid: $(kai_pids)   <- the Core's parent must be this"
echo
echo "\$ cdp eval \"invoke('core_status')\""
cdp eval "window.__TAURI_INTERNALS__.invoke('core_status').then((r) => JSON.stringify(r))"

echo
echo "################ 4. kai.log: the control layer, as it recorded itself ################"
echo "\$ grep -E 'KAI 0.1.1 started|core: |control layer: ' kai.log | tail -12"
grep -E "KAI 0.1.1 started|core: |control layer: " "$LOG_POSIX" | tail -12

echo
echo "################ 5. one real chat turn in the island ################"
echo "\$ park the cursor, then wake and expand the island with the REAL mouse"
powershell -NoProfile -File docs/evidence/win-input.ps1 -Action move -X 400 -Y 700 | tr -d '\r'
sleep 1
powershell -NoProfile -File docs/evidence/win-input.ps1 -Action move -X 959 -Y 4 | tr -d '\r'
sleep 1
powershell -NoProfile -File docs/evidence/win-input.ps1 -Action click -X 959 -Y 30 | tr -d '\r'
sleep 2
cdp eval "document.getElementById('island').style.width + 'x' + document.getElementById('island').style.height + ' (expanded = 640pxx210px+)'"

echo
TAB=$(cdp eval "(() => { const b = document.querySelector('button.tab[title=\"Ask\"]'); if (!b) return JSON.stringify({ error: 'no Ask tab' }); const r = b.getBoundingClientRect(); return JSON.stringify({ x: r.x + r.width / 2, y: r.y + r.height / 2, dpr: devicePixelRatio }); })()")
echo "\$ cdp eval  # where the Ask tab is"
echo "  $TAB"
read -r tx ty tdpr <<<"$(point_of "$TAB")"
echo "\$ win-client.ps1 -TitleMatch KAI -TitleExact -X $tx -Y $ty -Dpr $tdpr -Action click     # REAL click on Ask"
powershell -NoProfile -File docs/evidence/win-client.ps1 -TitleMatch KAI -TitleExact -X "$tx" -Y "$ty" -Dpr "$tdpr" -Action click | tr -d '\r'
sleep 2
echo "\$ cdp eval  # the chat view is the one on screen"
cdp eval "(() => { const v = document.querySelector('.chat-input'); return v ? ('chat input present; its view is .on: ' + v.closest('.view').classList.contains('on')) : 'no chat input'; })()"
echo "\$ powershell  # does the ISLAND hold the OS keyboard focus?"
powershell -NoProfile -Command "Add-Type -Namespace K -Name F -MemberDefinition '[DllImport(\"user32.dll\")] public static extern System.IntPtr GetForegroundWindow(); [DllImport(\"user32.dll\", CharSet=CharSet.Unicode)] public static extern int GetWindowTextW(System.IntPtr h, System.Text.StringBuilder s, int m);'; \$h=[K.F]::GetForegroundWindow(); \$sb=New-Object System.Text.StringBuilder 256; [void][K.F]::GetWindowTextW(\$h, \$sb, 256); 'foreground window: ' + \$sb.ToString()" | tr -d '\r'
echo
echo "\$ win-type.ps1 -Text 'what is happening?' -Enter        # REAL keystrokes"
powershell -NoProfile -File docs/evidence/win-type.ps1 -Text "what is happening?" -Enter | tr -d '\r'
for i in $(seq 1 15); do
  sleep 2
  reply=$(cdp eval "(() => { const rows = [...document.querySelectorAll('.chat-log .reply')]; return rows.length ? (rows[rows.length - 1].textContent || '').slice(0, 300) : ''; })()" 2>/dev/null)
  if [ -n "$reply" ]; then break; fi
done
echo
echo "\$ cdp eval  # the chat log, as rendered"
cdp eval "(() => { const rows = [...document.querySelectorAll('.chat-log .chat-row')]; if (!rows.length) return 'chat log is empty'; return rows.map((r) => (r.classList.contains('user') ? 'YOU: ' : 'KAI: ') + (r.innerText || '').trim()).join(' || ').slice(0, 600); })()"
echo
echo "\$ cdp eval  # the same turn through the Core, for comparison"
curl -s -m 30 -X POST http://127.0.0.1:8788/chat -H 'content-type: application/json' -d '{"text":"what is happening?"}' | head -c 300
echo
