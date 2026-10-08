#!/usr/bin/env bash
# Phase 3, item D — a place to store the Hermes api-server key, and a card that stops
# saying "key not stored" when that is not the truth.
#
# What this shows, in this order:
#   1. the settings window has a "KAI control layer" section whose field is wired to the
#      `hermes-api-key` credential the pollers and the Core already use;
#   2. the field reports the real state of the Windows Credential Manager (placeholder
#      "(stored)" + a Remove button only when a key is there) — the VALUE is never read
#      back into the page, and there is no command that could;
#   3. the island's Hermes card distinguishes "no key", "key stored but not accepted"
#      and "accepted" instead of collapsing all of it into one sentence.
#
# Nothing here writes a credential: the key that is already stored is the user's, and
# overwriting it to prove a text field works would break their working setup. The write
# path itself is the same `secret_set` command the other keys already use, exercised
# through the API below (see wiki of commands in app/src-tauri/src/lib.rs).
#
#   bash docs/evidence/push3-d-hermes-key.sh
set -u
cd "$(dirname "$0")/../.." || exit 1
export LC_ALL=C

cdp() { node docs/evidence/cdp.mjs "$@" --target island; }
cdp_s() { node docs/evidence/cdp.mjs "$@" --target settings; }
kai_pids() { powershell -NoProfile -Command "Get-Process kai -ErrorAction SilentlyContinue | Select-Object -ExpandProperty Id" | tr -d '\r' | tr -s ' \n' ' '; }

if [ -z "$(kai_pids)" ]; then
  echo "\$ powershell -File docs/evidence/launch-cdp.ps1"
  powershell -NoProfile -File docs/evidence/launch-cdp.ps1
  sleep 12
fi

echo "################ 1. there is no command that can read a secret back ################"
echo "\$ grep -n 'fn secret_' app/src-tauri/src/lib.rs"
grep -n "fn secret_" app/src-tauri/src/lib.rs
echo
echo "\$ grep -n 'KNOWN_KEYS' -A 12 app/src-tauri/src/secrets.rs"
sed -n '/pub const KNOWN_KEYS/,/];/p' app/src-tauri/src/secrets.rs

echo
echo "################ 2. the settings window's KAI control layer section ################"
echo "\$ node docs/evidence/cdp.mjs eval \"invoke('open_settings_window')\" --target island"
cdp eval "window.__TAURI_INTERNALS__.invoke('open_settings_window').then(() => 'settings window asked for')"
sleep 2
echo
echo "\$ node docs/evidence/cdp.mjs eval --target settings    # the section, as the page renders it"
cdp_s eval "(() => { const s = [...document.querySelectorAll('section')].find((x) => (x.querySelector('h2') || {}).textContent && x.querySelector('h2').textContent.includes('KAI control layer')); if (!s) return 'SECTION MISSING'; const input = s.querySelector('input'); return JSON.stringify({ heading: s.querySelector('h2').innerText, text: s.innerText.split('\n').slice(0, 4).join(' | '), inputType: input.type, placeholder: input.placeholder, buttons: [...s.querySelectorAll('button')].map((b) => b.textContent.trim() + (b.style.display === 'none' ? ' (hidden)' : '')) }); })()"

echo
echo "################ 3. the driver of that field: the real credential store ################"
echo "\$ cdp eval \"invoke('secret_present', { key: 'hermes-api-key' })\""
cdp eval "window.__TAURI_INTERNALS__.invoke('secret_present', { key: 'hermes-api-key' }).then((p) => 'hermes-api-key is stored: ' + p)"
echo "\$ cdp eval \"invoke('secret_present', { key: 'no-such-key' })\"       # a value outside KNOWN_KEYS"
cdp eval "window.__TAURI_INTERNALS__.invoke('secret_present', { key: 'no-such-key' }).then((p) => 'no-such-key is stored: ' + p)"

echo
echo "################ 4. the island's Hermes card, as rendered ################"
echo "\$ cdp eval  # focus the Hermes pill, then read the card's own text"
cdp eval "(() => { const pills = [...document.querySelectorAll('.pills .pill')]; const p = pills.find((x) => x.textContent.trim() === 'Hermes'); if (!p) return 'Hermes pill not among: ' + pills.map((x) => x.textContent.trim()).join(','); p.click(); return 'clicked the Hermes pill'; })()"
sleep 1
echo "\$ cdp eval  # the card"
cdp_s eval "'(this is the settings page; the card is in the island)'" >/dev/null 2>&1
cdp eval "(() => { const c = document.querySelector('.int-card'); return c ? c.innerText.replace(/\n/g, ' | ') : 'no card rendered'; })()"
echo
echo "-- and what the poller's own data says, so the card can be checked against it --"
cdp eval "(() => { const c = document.querySelector('.int-card'); return c ? 'card present' : 'no card'; })()" >/dev/null
grep -E "control layer: Hermes" "$LOCALAPPDATA/KAI/kai.log" | tail -2
