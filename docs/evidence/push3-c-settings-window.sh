#!/usr/bin/env bash
# Phase 3, item C — the settings window must be VISIBLE and INTERACTIVE ON SCREEN.
#
# The reported symptom was `IsWindowVisible` staying false while the page was live.
# This script measures it rather than arguing about it, then drives the whole path
# with the REAL mouse, because a renderer-level click proves nothing about a window:
#
#   1. the settings window at launch (built hidden on purpose) — before/after state;
#   2. the real user path: click the island's gear, then "Settings…" in it;
#   3. the window's style + a screen capture;
#   4. a real click on a real control in the settings window, and the page's own
#      reaction to it over CDP (the same evidence a person would see).
#
# The island is always-on-top, so step 2b is where its overlap with the settings
# window used to be: the island must retract, and the numbers below show whether it did.
#
#   bash docs/evidence/push3-c-settings-window.sh
set -u
cd "$(dirname "$0")/../.." || exit 1
export LC_ALL=C

LOG_POSIX="$LOCALAPPDATA/KAI/kai.log"
cdp() { node docs/evidence/cdp.mjs "$@" --target island; }
cdp_s() { node docs/evidence/cdp.mjs "$@" --target settings; }
kai_pids() { powershell -NoProfile -Command "Get-Process kai -ErrorAction SilentlyContinue | Select-Object -ExpandProperty Id" | tr -d '\r' | tr -s ' \n' ' '; }
styles() { powershell -NoProfile -File docs/evidence/win-styles.ps1 -TitleMatch "$1" | tr -d '\r'; }
rect() { powershell -NoProfile -File docs/evidence/win-input.ps1 -Action rect -ProcessName kai | tr -d '\r'; }
point_of() { echo "$1" | node -e "let s='';process.stdin.on('data',d=>s+=d).on('end',()=>{const j=JSON.parse(s);console.log(j.x,j.y,j.dpr);});"; }

if [ -z "$(kai_pids)" ]; then
  echo "\$ powershell -File docs/evidence/launch-cdp.ps1"
  powershell -NoProfile -File docs/evidence/launch-cdp.ps1
  sleep 12
fi
echo "kai.exe: $(kai_pids)"

echo
echo "################ 1. the settings window BEFORE anything asks for it ################"
echo "\$ win-styles.ps1 -TitleMatch Settings"
styles Settings
echo "\$ node docs/evidence/cdp.mjs eval \"document.visibilityState\" --target settings"
cdp_s eval "document.visibilityState + ' | ' + document.title + ' | ' + location.href"

echo
echo "################ 2. the real user path: gear, then Settings… ################"
echo "\$ (real mouse: park, wake at the strip, click to expand) - the gear only exists on an expanded island"
powershell -NoProfile -File docs/evidence/win-input.ps1 -Action move -X 400 -Y 700 | tr -d '\r'
sleep 1
powershell -NoProfile -File docs/evidence/win-input.ps1 -Action move -X 959 -Y 4 | tr -d '\r'
sleep 1
powershell -NoProfile -File docs/evidence/win-input.ps1 -Action click -X 959 -Y 30 | tr -d '\r'
sleep 2
cdp eval "document.getElementById('island').style.width + 'x' + document.getElementById('island').style.height + ' (expanded = 640px x 210px)'"
echo
echo "\$ cdp eval  # where the gear is, in page coordinates"
GEAR=$(cdp eval "(() => { const b = [...document.querySelectorAll('button')].find((e) => e.title === 'Settings'); if (!b) return 'NOT FOUND'; const r = b.getBoundingClientRect(); return [r.x + r.width / 2, r.y + r.height / 2, devicePixelRatio].join(' '); })()")
echo "  $GEAR"
IFS=" " read -r gx gy gdpr <<<"$GEAR"
echo "\$ win-client.ps1 -TitleMatch KAI -TitleExact -X $gx -Y $gy -Dpr $gdpr -Action click    # REAL click on the gear"
powershell -NoProfile -File docs/evidence/win-client.ps1 -TitleMatch KAI -TitleExact -X "$gx" -Y "$gy" -Dpr "$gdpr" -Action click | tr -d '\r'
sleep 1
echo "\$ cdp eval  # is the in-island settings view the one on screen?"
cdp eval "(() => { const v = document.querySelector('.settings-rows'); return v ? ('settings view present, its .view.on = ' + v.closest('.view').classList.contains('on')) : 'settings view missing'; })()"

SET=$(cdp eval "(() => { const b = [...document.querySelectorAll('.settings-rows .link-btn')].find((e) => e.textContent.trim().startsWith('Settings')); if (!b) return 'NOT FOUND'; const r = b.getBoundingClientRect(); return [r.x + r.width / 2, r.y + r.height / 2, devicePixelRatio].join(' '); })()")
echo "\$ cdp eval  # where the 'Settings…' button is"
echo "  $SET"
IFS=" " read -r sx sy sdpr <<<"$SET"
echo "\$ win-client.ps1 -TitleMatch KAI -TitleExact -X $sx -Y $sy -Dpr $sdpr -Action click     # REAL click on Settings…"
powershell -NoProfile -File docs/evidence/win-client.ps1 -TitleMatch KAI -TitleExact -X "$sx" -Y "$sy" -Dpr "$sdpr" -Action click | tr -d '\r'
sleep 2

echo
echo "################ 3. after the click ################"
echo "\$ win-styles.ps1 -TitleMatch Settings"
styles Settings
echo "\$ win-input.ps1 -Action rect -ProcessName kai        # the island window"
rect
echo "\$ win-styles.ps1 -TitleMatch KAI -TitleExact          # the island window's own style"
powershell -NoProfile -File docs/evidence/win-styles.ps1 -TitleMatch KAI -TitleExact | tr -d '\r'
echo "\$ cdp eval  # the island's own state: retracted, so it cannot cover the window"
cdp eval "document.getElementById('island').style.width + 'x' + document.getElementById('island').style.height"
echo "\$ kai.log"
grep -E "settings window" "$LOG_POSIX" | tail -3
echo "\$ powershell -File docs/evidence/screen-capture.ps1 -Out docs/evidence/push3-c-settings-visible.png"
powershell -NoProfile -File docs/evidence/screen-capture.ps1 -Out docs/evidence/push3-c-settings-visible.png | tr -d '\r'

echo
echo "################ 4. a REAL click on a real control in the settings window ################"
BTN=$(cdp_s eval "(() => { const b = [...document.querySelectorAll('button')].find((e) => e.textContent.trim().startsWith('Reinstall hooks')); if (!b) return 'NOT FOUND'; b.scrollIntoView({ block: 'center' }); const r = b.getBoundingClientRect(); return [r.x + r.width / 2, r.y + r.height / 2, devicePixelRatio, b.textContent.trim()].join('|'); })()")
echo "\$ cdp eval --target settings  # where the button is"
echo "  $BTN"
IFS="|" read -r bx by bdpr blabel <<<"$BTN"
echo "\$ cdp eval --target settings  # the page's text before the click"
cdp_s eval "document.body.innerText.slice(0, 120).replace(/\n/g, ' | ')"
echo "\$ win-client.ps1 -TitleMatch Settings -X $bx -Y $by -Dpr $bdpr -Action click   # REAL click"
powershell -NoProfile -File docs/evidence/win-client.ps1 -TitleMatch Settings -X "$bx" -Y "$by" -Dpr "$bdpr" -Action click | tr -d '\r'
sleep 2
echo "\$ cdp eval --target settings  # the page's text AFTER the click"
cdp_s eval "document.body.innerText.slice(0, 300).replace(/\n/g, ' | ')"
echo "\$ cdp eval --target settings  # does it now show the diff preview it would write?"
cdp_s eval "document.querySelector('.diff') ? ('diff preview rendered, ' + document.querySelectorAll('.diff > div').length + ' lines') : 'no diff preview'"
echo
echo "-- leave the hooks exactly as they were: click Cancel (renderer-level is fine for undo) --"
cdp_s eval "(() => { const b = [...document.querySelectorAll('button')].find((e) => e.textContent.trim() === 'Cancel'); if (b) { b.click(); return 'Cancel clicked'; } return 'no Cancel button (nothing was changed)'; })()"
sleep 1
cdp_s eval "document.body.innerText.slice(0, 90).replace(/\n/g, ' | ')"
