'use strict';

// dark-array-snapshot.test.js — losing ground, client slice 3, the ENGINE half: the snapshot now publishes a Deep Scan
// Array's DARK state (exploration-model.md §5, "AS-BUILT — the array goes dark"; design.md §19 #67). Engine PR 3 made
// an array dark when it loses its §5 attachment. That state is derived, never stored (`isArrayAttached`), and the array
// row did not carry it, so the client could not show it — and must not work it out for itself (design.md §18). The row
// now carries `dark: true` while the array is NOT attached, and has no `dark` key while it is. Proved on the real
// galaxies of dark-array-script.js:
//   1. THE FIELD IS THE PREDICATE — on every array, in the god's-eye lens and in each guild's own view, `dark: true`
//      exactly when `isArrayAttached` is false, and no key otherwise; a dark row never carries a `scan`.
//   2. AN IDLE ARRAY THAT GOES DARK is published dark too — the case with no job to void, no notice and no stamp.
//   3. NOTHING STORED — no state row ever carries `dark`, and it lifts with no write when control returns.
//   4. BYTE-IDENTITY — a galaxy with no dark array serves exactly `main`'s bytes (pinned at 1c28fe4); one with a dark
//      array serves `main`'s bytes once its `dark` keys are taken out, so the field is the only byte this slice moves.

// ⤳ 02-11-26 (roadmap 2.6, droid engine slice 1 — the Tier-3 reband): digests pinned below were RE-PINNED. The
// slice gave the droid's two parts their ruled sub-tier (drive_module → 3-2, droid_components → 3-2;
// docs/phase-1-tuning.md §Droids), which moves their seeded price rows (prices, price history, the quote ring, the
// snapshot's price fields and tier3Contract) in every state and view. With those two goods' keys deleted, every digest
// this file computes is the one 4bf6cbb computed, line for line (checked over all of them at the re-pin); scripted
// runs keep that proof standing in tests/rebanded-goods-delta.test.js. Read "byte-identical to main" or "the pre-slice
// engine" below as: apart from the re-banded goods' price rows.

const { test } = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');

const { buildSnapshot } = require('../snapshot.js');
// ⤳ 07-11-26: the droid batch-buy slice's one snapshot delta, stripped so the goldens below keep their old pins.
const { withoutDroidBatchQuote } = require('./droid-batch-quote-strip.js');
const { hashState } = require('../serialize.js');
const { isArrayAttached } = require('../deep-scan-arrays.js');
const { ticks } = require('./prefecture-fixtures.js');
const D = require('./dark-array-script.js');

const sha = (x) => crypto.createHash('sha256').update(JSON.stringify(x)).digest('hex');
const arrayOf = (s, id) => s.deepScanArrays.find((a) => a.id === id);
const rowOf = (snap, id) => (snap.deepScanArrays || []).find((a) => a.id === id);
const g1Events = (s) => s.guilds.find((g) => g.id === 'g1').events || [];

const EVICTED = D.evicted();
const OUTPOST = D.outpostGone();
const REWOKEN = D.rewoken();

// Every galaxy the tests read, by name: the arrays before and after each loss, 30 ticks on, and after the re-plant.
const STATES = {
  'reach, before the abandon': EVICTED.before,
  'reach, abandoned': EVICTED.s,
  'reach, abandoned, 30 ticks on': ticks(EVICTED.s, 30),
  'outpost, standing': OUTPOST.before,
  'outpost, removed': OUTPOST.s,
  'reach, re-planted': REWOKEN.s,
};

// The three lenses on a galaxy: the operator's god's-eye, and each guild's own view, as the browser receives them.
function lenses(s) {
  return {
    god: JSON.parse(JSON.stringify(buildSnapshot(s))),
    g1: JSON.parse(JSON.stringify(buildSnapshot(s, 'g1'))),
    g2: JSON.parse(JSON.stringify(buildSnapshot(s, 'g2'))),
  };
}

// ---- 1. the field is the predicate -------------------------------------------------------------------------------

test('THE FIELD IS THE PREDICATE: in every lens, an array row carries `dark: true` exactly when isArrayAttached is false, and never with a scan', () => {
  for (const [what, s] of Object.entries(STATES)) {
    for (const [lens, snap] of Object.entries(lenses(s))) {
      // The lens carries the arrays it always carried: every one in the god's-eye, the viewer's own in a view.
      const expected = (s.deepScanArrays || []).filter((a) => lens === 'god' || a.ownerGuildId === lens).map((a) => a.id).sort();
      assert.deepEqual((snap.deepScanArrays || []).map((r) => r.id), expected, `${what}, ${lens}: the same arrays as before`);
      for (const row of snap.deepScanArrays || []) {
        const attached = isArrayAttached(s, arrayOf(s, row.id));
        const where = `${what}, ${lens}, ${row.id} (attached: ${attached})`;
        assert.equal('dark' in row, !attached, `${where}: a dark key exactly when the array is not attached`);
        if (!attached) assert.equal(row.dark, true, `${where}: the key is the one bit, true`);
        if (row.dark) assert.equal('scan' in row, false, `${where}: a dark array carries no job`);
      }
    }
  }
});

test('the real cases: the abandon darkens the two arrays that hung off TARGET alone; the one touching HOME and the rival\'s stay lit', () => {
  const { dark, idleDark, lit, rival } = EVICTED.arrays;
  const before = lenses(EVICTED.before);
  const after = lenses(EVICTED.s);
  const darkIds = (snap) => (snap.deepScanArrays || []).filter((r) => r.dark).map((r) => r.id);
  assert.deepEqual([darkIds(before.god), darkIds(before.g1), darkIds(before.g2)], [[], [], []], 'nothing is dark while g1 holds TARGET');
  assert.deepEqual(darkIds(after.god), [dark, idleDark], 'the god\'s-eye: g1\'s two');
  assert.deepEqual(darkIds(after.g1), [dark, idleDark], 'g1\'s own view: the same two');
  assert.deepEqual(darkIds(after.g2), [], 'g2\'s view: its own array is lit, and g1\'s are not in it at all');
  assert.equal(JSON.stringify(after.g2).includes(dark), false);
  // `lit` and the rival keep their jobs; the voided array's job is gone.
  assert.deepEqual(['scan' in rowOf(after.g1, lit), 'scan' in rowOf(after.g2, rival), 'scan' in rowOf(after.g1, dark)], [true, true, false]);
  // The field is per-array, about the OWNER's control — so the owner's view carries exactly the god's-eye row.
  for (const id of [dark, idleDark, lit]) assert.deepEqual(rowOf(after.g1, id), rowOf(after.god, id), `${id}: own view = god's-eye`);
  assert.deepEqual(rowOf(after.g2, rival), rowOf(after.god, rival));
});

// ---- 2. an idle array that goes dark --------------------------------------------------------------------------------

test('AN IDLE ARRAY THAT GOES DARK is published dark: the Outpost it touched alone is removed, no job is voided, no notice, no stamp — and the row says dark', () => {
  const { before, s, alone, homeSide } = OUTPOST;
  // The premise: idle before, idle after, and the engine wrote nothing about it — so nothing but the new field shows it.
  assert.equal('scan' in arrayOf(before, alone), false);
  assert.equal(isArrayAttached(before, arrayOf(before, alone)), true);
  assert.equal(isArrayAttached(s, arrayOf(s, alone)), false);
  assert.deepEqual(arrayOf(s, alone), arrayOf(before, alone), 'the stored row is byte-for-byte as it was (nothing voided, no stamp)');
  assert.equal(g1Events(s).length, g1Events(before).length, 'no notice');
  const [was, now] = [lenses(before), lenses(s)];
  for (const lens of ['god', 'g1']) {
    assert.equal('dark' in rowOf(was[lens], alone), false, `${lens}: lit while the Outpost stood`);
    assert.equal(rowOf(now[lens], alone).dark, true, `${lens}: dark once it is gone`);
    assert.deepEqual(rowOf(now[lens], homeSide), rowOf(was[lens], homeSide), `${lens}: the array touching HOME too is unchanged, still surveying`);
  }
  // The eviction's idle dark array is the same case.
  const { idleDark } = EVICTED.arrays;
  assert.equal('scan' in arrayOf(EVICTED.before, idleDark), false);
  assert.equal(rowOf(lenses(EVICTED.s).g1, idleDark).dark, true);
});

// ---- 3. nothing stored --------------------------------------------------------------------------------------------

test('NOTHING STORED: no state row carries `dark`; re-planting TARGET lifts it from both rows with no write to either', () => {
  for (const [what, s] of Object.entries(STATES)) {
    for (const a of s.deepScanArrays || []) assert.equal('dark' in a, false, `${what}, ${a.id}: the state row stores no dark`);
  }
  const { dark, idleDark } = REWOKEN.arrays;
  const snap = lenses(REWOKEN.s).g1;
  for (const id of [dark, idleDark]) {
    assert.equal(isArrayAttached(REWOKEN.s, arrayOf(REWOKEN.s, id)), true);
    assert.equal('dark' in rowOf(snap, id), false, `${id}: lit again`);
    assert.deepEqual(arrayOf(REWOKEN.s, id), arrayOf(EVICTED.s, id), `${id}: the wake wrote nothing to the row`);
  }
});

// ---- 4. byte-identity -----------------------------------------------------------------------------------------------

// withoutDark(snap) -> the lens with every array row's `dark` key taken out. `dark` is a row's LAST key, so what is left
// is the row exactly as `main` built it.
function withoutDark(snap) {
  const copy = JSON.parse(JSON.stringify(snap));
  for (const row of copy.deepScanArrays || []) delete row.dark;
  return copy;
}
// digest(s, strip) -> the tick, the state hash, and the hash of each lens (each with its `dark` keys taken out, when
// `strip`).
function digest(s, strip) {
  const l = lenses(s);
  const h = (snap) => sha(withoutDroidBatchQuote(strip ? withoutDark(snap) : snap));
  return { tick: s.tick, state: hashState(s), god: h(l.god), g1: h(l.g1), g2: h(l.g2) };
}

// The digests `main` gave at 1c28fe4 for these galaxies, computed by requiring dark-array-script.js there (it uses
// nothing this slice added). `main` publishes no `dark` key, so for it there was nothing to take out.
const ON_MAIN = {
  'outpost, standing': {
    tick: 0,
    state: 'b48c215f5d98335988fc2fd19c85d35771a645c13dd51c21e974b27be3533435',
    god: '33e2c3573f6fdd9a177d1c548b637dc1e821d79d61a8f12ba6f0b51aafcdfc7b',
    g1: 'fda927de600362483ed324cc8ad22bbadcaf963a9718d0959e962e3c5f65e0a2',
    g2: 'ab19da9b6c6182bb0719e847b54bdc76cd9a7bd9b415e0525f68055a27f90326',
  },
  'reach, re-planted': {
    tick: 450,
    state: '6e9d04a121a95d46620f674920209da1f71fc78b9fbbd5dd94395ffe2420c48a',
    god: '183e1c3f3f1512f0adca5876bf933288ec448dbe8fecc58a41319027db273cf2',
    g1: '4a6ddf9882fc8f1a4cb414a2e23027bf7b2a9ed21b27c5dc73e9d3da11efa840',
    g2: '0e17558ff053d493fd0a2b20e5c1617d79c32fab67aa107bba9c653ad112b087',
  },
  'reach, abandoned': {
    tick: 450,
    state: '0225f6b37f829d02bf92e4265a202bd47e60dab664e0b71020831430df834cbb',
    god: '3d0f06c70b966bab041a13838a4f51d541218d76d7468da4e504c30a29928776',
    g1: '0272e512755555b1ef72aab04ed9a97c43a88ad7a14bda7a1c3eb8bad10050bd',
    g2: 'b4ba3e9dcff2f8cce5de459ded7bea2397c3c6c4922328f16b0afb62ecab519c',
  },
  'outpost, removed': {
    tick: 0,
    state: 'ea0e680ad950d829e0815c28cbf28757030eb758a6132814e96c730daa29f7f9',
    god: '6d50236748cae7d3b5c37a8f4068363eb3b1b0acff338ca5745a97bff4e1a229',
    g1: 'e6fa48823f5f56d7eca6900b39b3af44524d1e81b9717bce57aa8f2a9e635235',
    g2: 'ecc9e53f287ed5cfe429855d2d2950784e9a87e2e9f3501d4eea1acd7fd30faf',
  },
};

test('BYTE-IDENTICAL: a galaxy whose arrays are all attached serves exactly main\'s bytes — state and every lens, with nothing taken out', () => {
  // (eviction-reach.test.js's GOLDEN_NO_ABANDON pins the reach galaxy before the abandon — four arrays, scanning and
  // idle, none dark — on its launch tick and 760 ticks on, and it still holds; these two add an array held up by an
  // Outpost alone, and arrays that went dark and woke again.)
  for (const what of ['outpost, standing', 'reach, re-planted']) {
    assert.deepEqual(digest(STATES[what], false), ON_MAIN[what], `${what}: as on main`);
  }
});

test('BYTE-IDENTICAL BUT FOR THE FIELD: with a dark array, every lens is main\'s once its `dark` keys are taken out — and only a lens holding one moved', () => {
  for (const what of ['reach, abandoned', 'outpost, removed']) {
    const s = STATES[what];
    assert.deepEqual(digest(s, true), ON_MAIN[what], `${what}: main's bytes, but for the dark keys`);
    const raw = digest(s, false);
    for (const lens of ['god', 'g1', 'g2']) {
      const holdsDark = (lenses(s)[lens].deepScanArrays || []).some((r) => r.dark);
      assert.equal(raw[lens] === ON_MAIN[what][lens], !holdsDark, `${what}, ${lens}: moved exactly when it holds a dark row`);
    }
  }
});
