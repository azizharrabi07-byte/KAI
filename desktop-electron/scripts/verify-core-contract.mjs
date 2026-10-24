/**
 * Release guard: the packaged app must expect the Core that is actually deployed.
 *
 * The failure this prevents is subtle and total: `stamp:core` run AFTER `dist`
 * leaves a package containing every new renderer feature but an OLD expected Core
 * id, so the compatibility gate refuses EVERY turn before Core is reached. It
 * looks like a broken model, a broken tool path, or an empty app — and nothing in
 * the UI says "the build order was wrong".
 *
 * Exit code 1 on a mismatch, so a release step can fail instead of shipping it.
 */
import fs from 'node:fs';

const CORE_DIR = process.argv[2] || 'C:\\tmp\\kai-exec\\app\\target\\release\\core';
const paths = {
  expected: 'desktop/core-expected.json',
  asar: 'dist/win-unpacked/resources/app.asar',
  core: `${CORE_DIR}/build-info.json`,
};

const read = (p) => { try { return fs.readFileSync(p); } catch { return null; } };
const expected = read(paths.expected);
if (expected === null) { console.error('verify-core-contract: missing', paths.expected); process.exit(1); }
const expectation = JSON.parse(expected.toString('utf8'));
const expectedId = expectation.coreBuildId;
// A development expectation (`--mode track`) accepts any Core with a verifiable
// identity: the point of that mode is to keep a workspace usable while the Core is
// rebuilt by another process. The package must still CARRY a track expectation, and
// the deployed Core must still name itself — only the exact id is not pinned.
const tracking = expectation.mode === 'track';

const coreInfo = read(paths.core);
const coreId = coreInfo ? JSON.parse(coreInfo.toString('utf8')).buildId : null;

const asar = read(paths.asar);
const asarHasExpected = asar !== null && asar.includes(Buffer.from(expectedId));
const asarHasTrack = asar !== null && asar.includes(Buffer.from('"mode": "track"'));

const ok = tracking
  ? Boolean(coreId) && asarHasTrack
  : coreId === expectedId && asarHasExpected;
console.log(`  expectation mode  : ${tracking ? 'track (any verifiable Core)' : 'pinned'}`);
console.log(`  expected (source) : ${expectedId}`);
console.log(`  deployed core     : ${coreId ?? '(missing build-info.json)'}`);
console.log(`  packaged asar     : ${asar === null ? '(not built)' : tracking ? (asarHasTrack ? 'contains a track expectation' : 'DOES NOT contain a track expectation') : asarHasExpected ? 'contains the expected id' : 'DOES NOT contain it'}`);
if (!ok) {
  console.error(tracking
    ? '  MISMATCH — the packaged app does not carry a track expectation, or the Core names no build.'
    : '  MISMATCH — the packaged app would refuse every turn. Run: npm run stamp:core -- <core-dir> && npm run dist:portable');
  process.exit(1);
}
console.log('  contract OK');
