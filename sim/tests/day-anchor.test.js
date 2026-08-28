'use strict';

// day-anchor.test.js — the midnight anchor at the ENGINE level
// (docs/cycle-and-calendar.md §2 the anchored boundary, §3 no catch-up, §4 the stub
// first cycle). The pure calendar arithmetic is pinned in calendar.test.js; this file
// is about what the anchor does to a running galaxy.
//
// The load-bearing one is the FIRST test: at the default anchor the engine must be
// byte-identical to the pre-anchor engine. Everything else this slice adds is only safe
// because that holds (invariant 9).

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const { join } = require('node:path');

const { tick } = require('../tick.js');
const { createState } = require('../state.js');
const { checkInvariants } = require('../invariants.js');
const { hashState } = require('../serialize.js');
const { getWindow, winStartFor, DEFAULT_WINDOW_N } = require('../windows.js');
const { anchorForCreation } = require('../calendar.js');
const { buildSnapshot } = require('../snapshot.js');
const { saveState, loadOrInit } = require('../persist.js');

const SYS = 'sysA';
const N = DEFAULT_WINDOW_N; // 1440

const mine = (commitment = 0, extra = {}) => ({
  id: 'm', ownerGuildId: 'g1', type: 'mining', systemId: SYS,
  resourceType: 'titanium', productionRate: 10, syndicateCommitment: commitment, ...extra,
});

function galaxy({ dayAnchorTick, windowN, ventures = [mine()] } = {}) {
  return createState({
    guilds: [{ id: 'g1', credits: 0, fuelHoard: 0, ventures }],
    reserve: { reserveLevel: 0 },
    syndicate: { ledger: 0 },
    windowN,
    dayAnchorTick,
  });
}

const win = (s) => getWindow(s.guilds[0], SYS, 'titanium');

// --- 1. THE NO-OP PROOF — the anchor's whole safety case ---------------------------

test('NO-OP: an unset anchor writes no field and is byte-identical to an absent one', () => {
  // omit-when-absent, exactly like windowN. If this key ever appears unbidden, every
  // golden hash in the suite moves and the determinism proof is gone.
  const s = galaxy();
  assert.equal('dayAnchorTick' in s, false, 'no anchor set -> no key in state');
  assert.equal(s.dayAnchorTick, undefined);
});

test('NO-OP: anchor 0 and no anchor produce identical bytes over a committed run', () => {
  let bare = galaxy({ windowN: 6, ventures: [mine(12)] });
  let zero = galaxy({ windowN: 6, dayAnchorTick: 0, ventures: [mine(12)] });
  // The explicit 0 does write the key, so strip it before comparing the RUN — what is
  // being proven is that the anchor changes no BEHAVIOUR at 0, not that the field is
  // invisible (the test above proves that separately).
  for (let i = 0; i < 20; i += 1) { bare = tick(bare); zero = tick(zero); }
  const { dayAnchorTick, ...zeroRest } = zero;
  assert.equal(hashState(zeroRest), hashState(bare), 'anchor 0 is the unanchored engine');
});

test('NO-OP: winStartFor at anchor 0 reduces to the pre-anchor formula', () => {
  const preAnchor = (t, len) => t - ((t - 1) % len);
  for (const len of [1, 2, 3, 7, 24, N]) {
    for (let t = 1; t <= 3 * len + 2; t += 1) {
      assert.equal(winStartFor(t, len, 0), preAnchor(t, len), `N=${len} tick=${t}`);
      assert.equal(winStartFor(t, len), preAnchor(t, len), 'and the default arg is 0');
    }
  }
});

// --- 2. the anchored boundary (§2) -------------------------------------------------

test('a galaxy created mid-day gets its first boundary at the next midnight', () => {
  // Created at minute 870 (14:30). §2: the first boundary falls at the next server
  // midnight, which is N - 870 = 570 ticks in.
  const anchor = anchorForCreation(870, N);
  const firstBoundary = N - 870;
  assert.equal(anchor, -870);

  let s = galaxy({ dayAnchorTick: anchor, ventures: [mine(100)] });
  const boundaries = [];
  // Two full cycles past the stub, to prove the spacing settles at exactly N.
  for (let i = 0; i < firstBoundary + 2 * N + 1; i += 1) {
    s = tick(s);
    if ((((s.tick - anchor) % N) + N) % N === 0) boundaries.push(s.tick);
  }
  assert.deepEqual(boundaries, [firstBoundary, firstBoundary + N, firstBoundary + 2 * N],
    'first at the next midnight, then every N ticks');
});

test('the first boundary is N + anchor — minutes REMAINING, not minutes elapsed', () => {
  // The operator log in server.js prints this number, and it is easy to get backwards:
  // a galaxy created at minute 870 closes its first cycle 570 ticks in (1440 - 870), not
  // 870. Pinned across the range, including both ends.
  for (const minute of [0, 1, 870, 1439]) {
    const a = anchorForCreation(minute, N);
    const firstBoundary = N + a;
    assert.equal(firstBoundary, minute === 0 ? N : N - minute, `created at minute ${minute}`);
    assert.equal((((firstBoundary - a) % N) + N) % N, 0, 'and it really is a boundary');
    // nothing earlier is
    for (let t = 1; t < firstBoundary; t += 1) {
      assert.notEqual((((t - a) % N) + N) % N, 0, `tick ${t} must not be a boundary`);
    }
  }
});

test('the stub first cycle is shorter, and the existing pro-rate sizes its Q (§4)', () => {
  // §4: the anchor's stub is just another partial window, absorbed by committedFromTick
  // /windowFraction — no new mechanism. A mine present from tick 1 in a 570-tick stub
  // owes 570/1440 of its commitment, not a whole day's.
  const anchor = anchorForCreation(870, N);
  const stubLength = N - 870; // 570
  const commitment = 1440;    // chosen so the pro-rate lands on a whole number

  let s = galaxy({ dayAnchorTick: anchor, ventures: [mine(commitment, { committedFromTick: 1 })] });
  s = tick(s);
  const w = win(s);
  // The window containing tick 1 nominally OPENED before the galaxy existed — that is
  // what makes the stub short, and it is the number windowFraction measures against.
  assert.equal(w.windowStart, 1 + anchor, 'the stub window’s nominal start precedes tick 1');
  assert.equal(w.windowStart + N - 1, stubLength, 'so the stub runs to the first midnight');

  const q = s.guilds[0].ventures[0].syndicateCommitment;
  assert.equal(q, commitment, 'the stored commitment itself is untouched');
  // Q for the stub is the pro-rated share, via the same machinery a mid-window join uses.
  const report = buildSnapshot(s).guilds[0];
  assert.ok(report, 'snapshot built');
  assert.deepEqual(checkInvariants(s, s.tick), [], 'and a negative window-start is legal when anchored');
});

test('a stub window-start below tick 1 is legal ONLY down to the anchor’s bound', () => {
  // The tripwire this slice had to loosen: pre-anchor it read "windowStart >= 1". It is
  // now anchor-relative. It must still catch a window that never opened.
  const anchor = anchorForCreation(870, N);
  let s = galaxy({ dayAnchorTick: anchor, ventures: [mine(100, { committedFromTick: 1 })] });
  s = tick(s);
  assert.deepEqual(checkInvariants(s, s.tick), [], 'the legitimate stub start passes');

  // One tick earlier than the anchor allows is still a window that never opened.
  s.guilds[0].syndicateWindows[SYS].titanium.windowStart = anchor; // = (1 + anchor) - 1
  const issues = checkInvariants(s, s.tick);
  assert.ok(issues.some((i) => i.rule.startsWith('window-start-is-a-real-tick')),
    'a start below 1 + dayAnchorTick still trips');
});

test('at anchor 0 the loosened tripwire is exactly the old "windowStart >= 1"', () => {
  let s = galaxy({ windowN: 6, ventures: [mine(12, { committedFromTick: 1 })] });
  s = tick(s);
  assert.deepEqual(checkInvariants(s, s.tick), []);
  s.guilds[0].syndicateWindows[SYS].titanium.windowStart = 0;
  assert.ok(checkInvariants(s, s.tick).some((i) => i.rule.startsWith('window-start-is-a-real-tick')),
    '0 is still not a small window-start, it is a window that never opened');
});

// --- 3. persistence + no catch-up (§3) ---------------------------------------------

test('dayAnchorTick survives a save/load round-trip — it MUST outlive a restart', () => {
  const dir = fs.mkdtempSync(join(os.tmpdir(), 'starfare-anchor-'));
  try {
    const anchor = anchorForCreation(613, N);
    let s = galaxy({ dayAnchorTick: anchor, ventures: [mine(50)] });
    for (let i = 0; i < 5; i += 1) s = tick(s);
    saveState(s, dir);

    const restored = loadOrInit(dir, () => { throw new Error('should not re-init'); });
    assert.equal(restored.dayAnchorTick, anchor, 'the anchor came back off disk');
    assert.equal(hashState(restored), hashState(s), 'and the whole state round-tripped');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('a restart does NOT recompute the anchor — no catch-up, drift accepted (§3)', () => {
  // §3 is a ruling about what must NOT happen: nothing on the load path may consult a
  // clock or re-derive the anchor. Loading twice, at different wall-clock moments, must
  // give the same anchor — so the cycle stays exactly N ticks and only the "this is
  // really midnight" label drifts.
  const dir = fs.mkdtempSync(join(os.tmpdir(), 'starfare-anchor-'));
  try {
    const anchor = anchorForCreation(870, N);
    const s = galaxy({ dayAnchorTick: anchor });
    saveState(s, dir);
    const first = loadOrInit(dir, () => { throw new Error('no'); });
    const second = loadOrInit(dir, () => { throw new Error('no'); });
    assert.equal(first.dayAnchorTick, anchor);
    assert.equal(second.dayAnchorTick, anchor, 'a second load re-derives nothing');
    assert.equal(hashState(first), hashState(second));
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

// --- 4. the snapshot readout -------------------------------------------------------

test('the snapshot carries the cycle clock, derived and additive', () => {
  const anchor = anchorForCreation(870, N);
  let s = galaxy({ dayAnchorTick: anchor });
  s = tick(s); // tick 1 — created at 14:30, so day 0, minute 870
  const snap = buildSnapshot(s);
  assert.deepEqual(snap.calendar, {
    day: 0, minute: 870, label: '0000:0870', windowN: N, dayAnchorTick: anchor,
    // WHICH midnight the anchor lines up with (§2). 0 = UTC on a galaxy that never
    // chose one — see utc-offset.test.js for the offset's own proofs.
    utcOffsetMinutes: 0,
  });
  assert.equal(snap.schemaVersion, 7, 'additive — no schema bump');
});

test('the snapshot clock is DERIVED — it adds nothing to the determinism hash', () => {
  let s = galaxy({ windowN: 6, ventures: [mine(12)] });
  for (let i = 0; i < 8; i += 1) s = tick(s);
  const before = hashState(s);
  buildSnapshot(s); // building a snapshot must not touch state
  assert.equal(hashState(s), before);
});

// --- 5. the clock-free proof (§2's central claim) ----------------------------------

// Comments discuss the clock rule constantly (this very file does), so the scan must
// read CODE. Strip block and line comments before matching, or the prose describing the
// invariant trips the invariant.
const stripComments = (src) => src
  .replace(/\/\*[\s\S]*?\*\//g, '')
  .replace(/^\s*\/\/.*$/gm, '')
  .replace(/([^:'"`])\/\/.*$/gm, '$1');

// `new Date(x)` with an ARGUMENT is a pure conversion of a value the caller supplied
// (calendar.js's minuteOfDayFromDate takes one); only a clock READ is forbidden.
const readsClock = (code) => /Date\.now\s*\(/.test(code) || /new\s+Date\s*\(\s*\)/.test(code);

test('THE ENGINE READS NO CLOCK: the only wall-clock reads in sim/ are in server.js', () => {
  // §2: "no Date.now() ever enters the tick path". This is the mechanical form of that
  // claim — a scan, so it stays true as the engine grows rather than being re-argued.
  const dir = join(__dirname, '..');
  const offenders = [];
  for (const name of fs.readdirSync(dir)) {
    if (!name.endsWith('.js')) continue;
    if (name === 'server.js') continue; // the operator seam — allowed, checked below
    if (readsClock(stripComments(fs.readFileSync(join(dir, name), 'utf8')))) offenders.push(name);
  }
  assert.deepEqual(offenders, [], 'no engine module reads the wall clock');
});

test('the scan has teeth — it catches a clock read planted in engine code', () => {
  // A green scan is only worth something if it can go red. Prove both directions.
  assert.equal(readsClock(stripComments('const t = Date.now();')), true);
  assert.equal(readsClock(stripComments('const t = new Date();')), true);
  assert.equal(readsClock(stripComments('// a comment mentioning Date.now() and new Date()')), false);
  assert.equal(readsClock(stripComments('/* block mentioning Date.now() */')), false);
  assert.equal(readsClock(stripComments('minuteOfDayFromDate(new Date(2026, 0, 1));')), false,
    'a Date built from supplied values is a conversion, not a clock read');
});

test('and server.js reads it in exactly the places it is allowed to', () => {
  const src = stripComments(fs.readFileSync(join(__dirname, '..', 'server.js'), 'utf8'));
  const reads = src.split('\n').map((l) => l.trim()).filter(readsClock);
  // Two, and only two: the /health readout (display), and the anchor at galaxy creation.
  assert.equal(reads.length, 2, `expected 2 clock reads, found ${reads.length}: ${JSON.stringify(reads)}`);
  assert.ok(reads.some((l) => l.includes('serverTime')), 'one is /health’s display clock');
  // The creation read now sits on the line that CONVERTS it — the UTC minute-of-day,
  // shifted to the galaxy's chosen offset — and `anchorForCreation` consumes that
  // number on the next line, still without a clock of its own.
  assert.ok(reads.some((l) => l.includes('minuteOfDayFromDate')), 'the other is the creation anchor');
});
