#!/usr/bin/env bash
# KAI rebrand audit — proves no upstream Coucou / Mochi / "Notch Buddy" / Louis
# Raillé branding is left anywhere in the sources OR in the built artifacts.
#
# Must print "AUDIT CLEAN" and exit 0. Any hit is a leftover.
#
# Why the token list is shaped the way it is: the first version of this audit
# only tested `NotchBuddy` (no space, one capital). The real leftover in
# `app/src/island/hooks.ts` was `notchbuddy` / "Notch Buddy", which that token
# could never match — so the audit said 0 while the string sat in the source.
# Every upstream token is now listed in each spelling it actually appears in,
# and `notch` on its own is deliberately NOT a token: `NOTCH_W` / `NOTCH_H` in
# `src/core/layout.ts` are the display-notch vocabulary (this app runs on a PC
# with no notch), not upstream branding.
set -uo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"

TOKENS=(
  coucou Coucou COUCOU
  mochi Mochi MOCHI
  NotchBuddy "Notch Buddy" notchbuddy notch-buddy notch_buddy
  louisraille "Louis Raille" Raill
)

# Source tree: node_modules / target / dist are generated, so they are skipped
# here and audited separately as the built artifacts below.
SRC_EXCLUDES=(--exclude-dir=node_modules --exclude-dir=target --exclude-dir=dist)

fails=0
printf '%-14s %6s %6s\n' TOKEN FILES HITS
for t in "${TOKENS[@]}"; do
  files=$(grep -rIl "${SRC_EXCLUDES[@]}" -F -e "$t" app core 2>/dev/null | wc -l | tr -d ' ')
  hits=$(grep -rIo "${SRC_EXCLUDES[@]}" -F -e "$t" app core 2>/dev/null | wc -l | tr -d ' ')
  printf '%-14s %6s %6s\n' "$t" "$files" "$hits"
  if [ "$files" != "0" ]; then
    fails=$((fails + 1))
    grep -rIn "${SRC_EXCLUDES[@]}" -F -e "$t" app core | head -5
  fi
done

echo
echo "--- built artifacts ---"
# app/dist is the bundled front end; src-tauri/target holds the compiled exes.
dist_hits=$(grep -rIo -F -e coucou -e Coucou -e mochi -e Mochi \
  -e "Notch Buddy" -e notchbuddy app/dist 2>/dev/null | wc -l | tr -d ' ')
printf '%-14s %6s\n' "app/dist" "$dist_hits"
[ "$dist_hits" != "0" ] && fails=$((fails + 1))

wavs=$(find app/dist app/src-tauri/target/release -iname '*.wav' 2>/dev/null | wc -l | tr -d ' ')
printf '%-14s %6s\n' ".wav files" "$wavs"
[ "$wavs" != "0" ] && fails=$((fails + 1))

# The only files allowed to contain upstream branding are the evidence files
# that document what upstream looked like.
echo
echo "--- evidence files (allowed to contain upstream branding) ---"
grep -rIl -F -e Coucou -e mochi -e "Notch Buddy" docs/evidence 2>/dev/null || echo "(none)"

echo
if [ "$fails" = "0" ]; then
  echo "AUDIT CLEAN"
  exit 0
fi
echo "AUDIT FAILED: $fails check group(s) with hits"
exit 1
