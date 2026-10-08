#!/usr/bin/env bash
# Phase 3, item B — the island must be reachable by MOUSE once it has hidden.
#
# The defect as measured in docs/evidence/runtime-findings.md §3: with the island
# hidden, the window was a 345x9 strip carrying WS_EX_LAYERED|WS_EX_TRANSPARENT, so
# Windows delivered the webview no mouse messages at all; the strip's DOM `mouseenter`
# could never fire, and with autoCloseInterval at 15 s a hidden island had no way back.
#
# Three parts, all with the REAL cursor:
#   PART 1  hide the island the way the product does; read the window style and the
#           island geometry; then move the real cursor into the strip and report what
#           happened (log, the DOM probe's own counts, geometry).
#   PART 2  the worst case, forced: put WS_EX_LAYERED|WS_EX_TRANSPARENT back on the
#           hidden window, so the webview provably cannot see the mouse, and move the
#           real cursor in again. If the island comes back now, the wake does not
#           depend on the webview at all.
#   PART 3  a real click on the revealed island must expand it.
#
#   bash docs/evidence/push3-b-wake-strip.sh
set -u
cd "$(dirname "$0")/../.." || exit 1
export LC_ALL=C

LOG_POSIX="$LOCALAPPDATA/KAI/kai.log"
cdp() { node docs/evidence/cdp.mjs "$@" --target island; }
kai_pids() { powershell -NoProfile -Command "Get-Process kai -ErrorAction SilentlyContinue | Select-Object -ExpandProperty Id" | tr -d '\r' | tr -s ' \n' ' '; }
island_style() { powershell -NoProfile -File docs/evidence/win-styles.ps1 -TitleMatch KAI -TitleExact | tr -d '\r'; }
probe() { cdp eval "JSON.stringify({island:document.getElementById('island').style.width+'x'+document.getElementById('island').style.height,content:document.getElementById('content').style.opacity,mini:document.getElementById('mini-grid').style.opacity,viewport:innerWidth+'x'+innerHeight,stripEnter:(window.__wakeProbe||{}).enter||0,stripMove:(window.__wakeProbe||{}).move||0,docMove:(window.__wakeProbe||{}).docMove||0})"; }
rect() { powershell -NoProfile -File docs/evidence/win-input.ps1 -Action rect -ProcessName kai | tr -d '\r'; }
move() { powershell -NoProfile -File docs/evidence/win-input.ps1 -Action move -X "$1" -Y "$2" | tr -d '\r'; }
click() { powershell -NoProfile -File docs/evidence/win-input.ps1 -Action click -X "$1" -Y "$2" | tr -d '\r'; }

install_probe() {
  cdp eval "(() => { window.__wakeProbe = { enter: 0, move: 0, docMove: 0 }; const s = document.getElementById('wake-strip'); s.addEventListener('mouseenter', () => window.__wakeProbe.enter++); s.addEventListener('mousemove', () => window.__wakeProbe.move++); document.addEventListener('mousemove', () => window.__wakeProbe.docMove++); return 'probe installed on #wake-strip'; })()"
}

# Collapse the island and WAIT FOR THE WINDOW TO ACTUALLY BE THE STRIP.
#
# Two things this has to get right, both learned by getting them wrong first:
#   * the real cursor must be parked AWAY first — while it is inside the island the FSM
#     treats the pointer as still on the island, mouseLeft() is never called, and no
#     hide countdown is ever started;
#   * the wait is fsm.homeToPetitDelay (15 s) + fsm.petitToHiddenDelay (60 s) when the
#     island starts expanded, so it is polled, not guessed. Nothing here shortens the
#     product's own delays.
hide_island() {
  move 400 700 >/dev/null
  for i in $(seq 1 24); do
    w=$(cdp eval "document.getElementById('island').style.width" 2>/dev/null)
    if [ "$w" = "184px" ]; then
      echo "  hidden after ~$((i * 5))s (style.width = 184px, window = wake strip)" >&2
      return 0
    fi
    sleep 5
  done
  echo "  STILL NOT HIDDEN after 120s (style.width = $w) — the rest of this part proves nothing" >&2
  return 1
}

echo "################ setup ################"
if [ -z "$(kai_pids)" ]; then
  echo "\$ powershell -File docs/evidence/launch-cdp.ps1"
  powershell -NoProfile -File docs/evidence/launch-cdp.ps1
  sleep 12
fi
echo "kai.exe: $(kai_pids)"
echo "\$ node docs/evidence/cdp.mjs eval   # a DOM probe on #wake-strip, so its own counts are evidence"
install_probe

echo
echo "################ PART 1 — hidden, then approached with the real mouse ################"
echo "\$ (park the real cursor, then wait for the product's own hide: 15 s + 60 s)"
hide_island
echo
echo "\$ win-input.ps1 -Action rect -ProcessName kai        # while hidden"
rect
echo
echo "\$ win-styles.ps1 -TitleMatch KAI -TitleExact          # while hidden"
island_style
echo
echo "\$ win-input.ps1 -Action move -X 400 -Y 700            # real cursor away from the strip"
move 400 700
sleep 1
echo "\$ win-input.ps1 -Action move -X 959 -Y 4              # real cursor INTO the hidden strip"
move 959 4
sleep 2
echo
echo "-- the island --"
probe
echo "-- the window --"
rect
echo "-- kai.log --"
grep -E "wake strip entered|\[core\] connection" "$LOG_POSIX" | tail -4

echo
echo "################ PART 2 — the worst case, forced: the hidden window is click-through ################"
hide_island
echo
echo "\$ win-input.ps1 -Action rect"
rect
echo "\$ win-transparent.ps1 -TitleMatch KAI -TitleExact -On    # put LAYERED|TRANSPARENT back"
powershell -NoProfile -File docs/evidence/win-transparent.ps1 -TitleMatch KAI -TitleExact -On | tr -d '\r'
echo "\$ win-styles.ps1 -TitleMatch KAI -TitleExact"
island_style
echo
echo "-- reset the probe, park the cursor, then approach again with the real mouse --"
cdp eval "window.__wakeProbe = { enter: 0, move: 0, docMove: 0 }" >/dev/null
move 400 700
sleep 1
echo "\$ win-input.ps1 -Action move -X 959 -Y 4"
move 959 4
sleep 2
echo
echo "-- the island --"
probe
echo "-- the window --"
rect
echo "-- kai.log: the Rust wake monitor's own line --"
grep -E "wake strip entered" "$LOG_POSIX" | tail -3
echo

echo
echo "################ PART 3 — a real click on the revealed island expands it ################"
echo "\$ sleep 5   # the window has to shed the flag this test forced on it (the poll re-asserts once a second)"
sleep 5
echo "\$ win-styles.ps1 -TitleMatch KAI -TitleExact          # the forced flag is gone again"
island_style
echo "\$ win-input.ps1 -Action click -X 959 -Y 30"
click 959 30
sleep 2
echo "-- the island --"
probe
echo "-- the window --"
rect
