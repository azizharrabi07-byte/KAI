#!/usr/bin/env bash
# Phase 3, item E — the chain, run in order, on this machine, after the changes.
#
# The long outputs are saved whole next to this file; the summary of each step is
# printed. Nothing is summarised away: the full core test output is in
# push3-core-npm-test.txt, and the build log lines are quoted from the real run.
#
#   bash docs/evidence/push3-e-chain.sh
set -u
cd "$(dirname "$0")/../.." || exit 1
export LC_ALL=C
OUT="$(pwd)/docs/evidence"

section() { echo; echo "################ $1 ################"; }

section "1. app typecheck"
echo "\$ (cd app && npx tsc --noEmit)"
if ( cd app && npx tsc --noEmit ) > "$OUT/push3-tsc-app.txt" 2>&1; then
  echo "  exit 0 — no diagnostics"
else
  echo "  FAILED:"; cat "$OUT/push3-tsc-app.txt"
fi

section "2. core typecheck"
echo "\$ (cd core && npm run typecheck)"
if ( cd core && npm run typecheck ) > "$OUT/push3-tsc-core.txt" 2>&1; then
  echo "  exit 0 — no diagnostics"
else
  echo "  FAILED:"; cat "$OUT/push3-tsc-core.txt"
fi

section "3. app tests"
echo "\$ (cd app && npm test)"
( cd app && npm test ) > "$OUT/push3-app-tests.txt" 2>&1
echo "  exit code: $?"
grep -E "^ℹ (tests|pass|fail|skipped)" "$OUT/push3-app-tests.txt" | sed 's/^/  /'

section "4. the servers, before the core suite"
echo "\$ curl -s http://127.0.0.1:8642/health"
curl -s -m 5 http://127.0.0.1:8642/health | head -c 200; echo
echo "\$ curl -s http://127.0.0.1:4096/global/health"
curl -s -m 5 http://127.0.0.1:4096/global/health; echo
echo "\$ curl -s http://127.0.0.1:4096/session | (number of sessions)"
curl -s -m 5 http://127.0.0.1:4096/session | node -e "let s='';process.stdin.on('data',d=>s+=d).on('end',()=>{try{console.log('  sessions on this OpenCode server: '+JSON.parse(s).length)}catch(e){console.log('  unreadable')}})"

section "5. core tests, straight from TypeScript"
echo "\$ (cd core && npm test)"
( cd core && npm test ) > "$OUT/push3-core-npm-test.txt" 2>&1
echo "  exit code: $?"
grep -E "^ℹ (tests|pass|fail|skipped)" "$OUT/push3-core-npm-test.txt" | sed 's/^/  /'
echo "  --- failing tests, verbatim titles ---"
grep -E "^✖" "$OUT/push3-core-npm-test.txt" | sed 's/^/  /' || echo "  none"
echo "  (the whole run is in docs/evidence/push3-core-npm-test.txt)"

section "6. the packaged build"
echo "\$ (cd app && npm run tauri build)"
echo "  run separately; the tail of the real log:"
tail -6 "$TMPDIR/tauri-build-6.log" 2>/dev/null | sed 's/^/  /' || echo "  (log not found in TMPDIR)"
ls -l app/target/release/kai.exe app/target/release/bundle/nsis/*.exe app/target/release/core/server.js | sed 's/^/  /'
