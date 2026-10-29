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

const { test } = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');

const { buildSnapshot } = require('../snapshot.js');
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
  const h = (snap) => sha(strip ? withoutDark(snap) : snap);
  return { tick: s.tick, state: hashState(s), god: h(l.god), g1: h(l.g1), g2: h(l.g2) };
}

// The digests `main` gave at 1c28fe4 for these galaxies, computed by requiring dark-array-script.js there (it uses
// nothing this slice added). `main` publishes no `dark` key, so for it there was nothing to take out.
const ON_MAIN = {
  'outpost, standing': {
    tick: 0,
    state: 'cb07a79eae185fc0c89f0a9af3df3be9d54c51d014f6cec580d3a44723024f5d',
    god: 'c9103693d0d9514c4eaa8cd9384ec7695b7b81a873baee6b1ffd2d64fa5c88f1',
    g1: 'cfc6fe543016c0ea2082f0526d40310aad0f6ae7b1eb020544080796fdfa6124',
    g2: '2ca1ebc85021c50eb4d1f1aa50d3f947cc68a199d8093fb819a61eead54b134f',
  },
  'reach, re-planted': {
    tick: 450,
    state: '3c7116bf153171a01db3e07a6adc6a86160d3f7688dfe2b0ff5350ac9f7d7bd9',
    god: '59002c427621d6e877849f0579dd68d74d989150176ea23fa550fd33e8e02a32',
    g1: '22c2a42bb82528364cf6282a93b3335c33fca2e59d7a20e89b8851e59aed968e',
    g2: '3c9a9966a4d34a76b1cb1742253451c66ccbdca1687fac63a633d9e8829c9bdc',
  },
  'reach, abandoned': {
    tick: 450,
    state: '8b2d47c67b0fe9a0480fcd416f7fa56f817a8a6337e1efd5dc8a18b434449ef0',
    god: '5af2b151a5a2e3f907327a68a2027b652983b5933db9392cc5fa4f20c3791033',
    g1: '7ce633b5c08105f40d11e3e833074be490e2b1b67382f392170e5338f9df246c',
    g2: '10e9ac9b9dfee4f0c08c88147ee3d268fa9314dd3838ec90876f846b30299d0b',
  },
  'outpost, removed': {
    tick: 0,
    state: 'bec373f81e49fe74039e6aa0c701fb8f9841cd1ce5d7d5f0475d913599cbaa3b',
    god: '5f7e03e7906bb1f04a57ddc5712ae955b96b3c406d9d04dc588b7b12592c63ba',
    g1: 'e95481b2d671358ba0f9fc4ab23ea0998184dbffa85f75a96cd739a31ce4269a',
    g2: 'c75722cffd2399bd9245bb0e98ddce1db5ab0654c5486ac403602a8e6b438d96',
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
