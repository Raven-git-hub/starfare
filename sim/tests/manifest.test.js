'use strict';

// manifest.test.js — the ONE shared manifest resolver and its shape helpers, exercised DIRECTLY
// (design.md §4 "Resolving a manifest"; roadmap 2.2 cargo, the manifest MAX-mode engine slice). The
// system path (sim/actions.js) and the Outpost dock path (sim/tick.js) both call `resolveManifest`,
// so unit-testing it here — against a hand-built store — proves the move once, for both.
//
// The MAX-mode tripwires, one per ruling (§4 "A max line carries no qty cap"):
//   - a max LOAD clamps to min(store stock, hold free space): it fills the hold when the store is
//     plentiful, and takes the whole stock when the store is the limit;
//   - a max UNLOAD at a SYSTEM (unbounded free space) empties the good from the hold;
//   - a max UNLOAD at a hard-capped OUTPOST stops at the cap (a PARTIAL — the rest stays aboard);
//   - ORDER-DETERMINISM: a max line greedily consumes its phase's room, so `max A, then 500 B` leaves
//     B nothing, while `500 B, then max A` loads B and then fills the rest with A;
//   - a MIXED amount+max manifest resolves each line by its own rule;
//   - the move CONSERVES the total (hold + store) — it only shuffles goods between the two stores;
//   - the shape helpers `manifestAmountError` / `copyManifestLine` accept/reject and copy the two shapes.

const { test } = require('node:test');
const assert = require('node:assert/strict');

const { resolveManifest, usedSpace, manifestAmountError, copyManifestLine } = require('../manifest.js');
const { volumeOf } = require('../fuel.js');

// Vol-1 goods (titanium / silica / gold) and one vol-100 good (titanium_alloy), read from the ONE
// source — never inlined — so a volume retune carries these tests rather than silently breaking them.
const T1 = 'titanium';         // volumeOf 1
const T1b = 'silica';          // volumeOf 1 — a second vol-1 good for the ordering test
const T2 = 'titanium_alloy';   // volumeOf 100
assert.equal(volumeOf(T1), 1);
assert.equal(volumeOf(T1b), 1);
assert.equal(volumeOf(T2), 100);

// A store matching the resolveManifest contract: a good→int holding with either UNBOUNDED free space
// (a soft-capped SYSTEM pool) or a HARD CAP (an OUTPOST stockpile), exactly as the two real callers
// build it. `holding` is exposed so a test can read the store back after the move.
function makeStore(holding = {}, cap = Infinity) {
  const s = { ...holding };
  return {
    holding: s,
    get: (good) => s[good] || 0,
    add: (good, delta) => { s[good] = (s[good] || 0) + delta; if (s[good] === 0) delete s[good]; },
    freeSpace: () => (cap === Infinity ? Infinity : cap - usedSpace(s)),
  };
}

const CAP = 10000; // a light-transport-sized hold, for concrete numbers

// --- a max LOAD clamps to min(store stock, hold free space) ------------------------------------

test('max load: fills the hold when the store is plentiful (clamped by hold free space)', () => {
  const hold = {};
  const store = makeStore({ [T1]: 100000 }); // far more than the hold can take
  resolveManifest(hold, CAP, store, [{ dir: 'load', good: T1, max: true }]);
  assert.deepEqual(hold, { [T1]: CAP }, 'the hold filled to capacity — the max load took only what fits');
  assert.equal(store.holding[T1], 100000 - CAP, 'the store gave up exactly what the hold could hold');
});

test('max load: takes the WHOLE stock when the store is the limit (fewer than the hold could hold)', () => {
  const hold = {};
  const store = makeStore({ [T1]: 300 }); // less than the hold's 10,000 room
  resolveManifest(hold, CAP, store, [{ dir: 'load', good: T1, max: true }]);
  assert.deepEqual(hold, { [T1]: 300 }, 'the max load drained the store — the store, not the hold, was the limit');
  assert.equal(store.holding[T1], undefined, 'the store emptied (omit-when-empty)');
});

// --- a max UNLOAD empties at a system, partials at a full Outpost -------------------------------

test('max unload at a SYSTEM (unbounded free space) empties the good from the hold', () => {
  const hold = { [T1]: 500 };
  const store = makeStore({ [T1]: 40 }); // a soft-capped pool: freeSpace Infinity
  resolveManifest(hold, CAP, store, [{ dir: 'unload', good: T1, max: true }]);
  assert.equal(hold[T1], undefined, 'the whole 500 left the hold — an unbounded store takes it all');
  assert.equal(store.holding[T1], 540, 'the pool received all 500');
});

test('max unload at a full OUTPOST stops at the hard cap — a partial, the rest stays aboard', () => {
  const hold = { [T1]: 10 };
  const store = makeStore({ [T1]: CAP - 3 }, CAP); // 3 space short of the hard cap
  resolveManifest(hold, CAP, store, [{ dir: 'unload', good: T1, max: true }]);
  assert.deepEqual(hold, { [T1]: 7 }, 'only the 3 that fit landed; 7 stay in the hold');
  assert.equal(store.holding[T1], CAP, 'the Outpost is exactly at its hard cap');
});

// --- order-determinism: a max line consumes whatever room its phase has left --------------------

test('order-determinism: `max A, then 500 B` leaves B nothing (A took all the room first)', () => {
  const hold = {};
  const store = makeStore({ [T1]: 100000, [T1b]: 100000 });
  resolveManifest(hold, CAP, store, [
    { dir: 'load', good: T1, max: true },   // fills all 10,000 room with A
    { dir: 'load', good: T1b, qty: 500 },   // no room left → loads 0
  ]);
  assert.deepEqual(hold, { [T1]: CAP }, 'A filled the hold; B found no room and moved nothing');
});

test('order-determinism: `500 B, then max A` loads B first, then A fills the rest', () => {
  const hold = {};
  const store = makeStore({ [T1]: 100000, [T1b]: 100000 });
  resolveManifest(hold, CAP, store, [
    { dir: 'load', good: T1b, qty: 500 },   // 500 B (500 space)
    { dir: 'load', good: T1, max: true },   // fills the remaining 9,500 with A
  ]);
  assert.deepEqual(hold, { [T1b]: 500, [T1]: CAP - 500 }, 'B loaded its 500, then A greedily took the rest');
  assert.equal(usedSpace(hold), CAP, 'the hold is exactly full');
});

// --- a mixed amount + max manifest resolves each line by its own rule ----------------------------

test('mixed amount + max: the amount line moves its qty, the max line takes what remains', () => {
  const hold = { [T2]: 20 }; // 20 alloy = 2,000 space used already
  const store = makeStore({ [T1]: 100000, [T2]: 500 });
  resolveManifest(hold, CAP, store, [
    { dir: 'unload', good: T2, qty: 5 },   // amount unload: drop 5 alloy (frees 500 space)
    { dir: 'load', good: T1, max: true },  // max load: fill the now-8,500 free space with titanium
  ]);
  // Started 2,000 used; unloaded 5 alloy → 1,500 used, 8,500 free → 8,500 titanium.
  assert.deepEqual(hold, { [T2]: 15, [T1]: 8500 }, 'the amount unload moved exactly 5; the max load filled the rest');
  assert.equal(usedSpace(hold), CAP, 'the hold is full again');
  assert.equal(store.holding[T2], 505, 'the 5 unloaded alloy returned to the store');
});

// --- conservation: a max move only shuffles goods between the hold and the store -----------------

test('conservation: a max transfer conserves the total (hold + store) for every good it touches', () => {
  const hold = { [T1]: 200 };
  const store = makeStore({ [T1]: 5000, [T2]: 500 });
  const totalBefore = (hold[T1] || 0) + store.holding[T1];
  const alloyBefore = (hold[T2] || 0) + (store.holding[T2] || 0);
  resolveManifest(hold, CAP, store, [
    { dir: 'unload', good: T1, max: true }, // empties the hold's titanium into the (unbounded) store
    { dir: 'load', good: T2, max: true },   // then fills the freed hold with alloy from the store
  ]);
  assert.equal((hold[T1] || 0) + store.holding[T1], totalBefore, 'titanium total unchanged — only moved');
  assert.equal((hold[T2] || 0) + (store.holding[T2] || 0), alloyBefore, 'alloy total unchanged — only moved');
});

// --- the shape helpers -------------------------------------------------------------------------

test('manifestAmountError: accepts an amount line and a max line; rejects both / neither / non-boolean', () => {
  // Well-formed: exactly one of qty / max.
  assert.equal(manifestAmountError({ dir: 'load', good: T1, qty: 5 }), null, 'a positive-int qty is well-formed');
  assert.equal(manifestAmountError({ dir: 'load', good: T1, max: true }), null, 'max: true is well-formed');
  // Rejected shapes, each with a distinguishing message.
  assert.match(manifestAmountError({ dir: 'load', good: T1, qty: 5, max: true }), /both|AND/, 'qty AND max is rejected');
  assert.match(manifestAmountError({ dir: 'load', good: T1 }), /needs/, 'neither qty nor max is rejected');
  assert.match(manifestAmountError({ dir: 'load', good: T1, max: false }), /boolean true/, 'max: false is rejected');
  assert.match(manifestAmountError({ dir: 'load', good: T1, max: 1 }), /boolean true/, 'a non-boolean max is rejected');
  assert.match(manifestAmountError({ dir: 'load', good: T1, qty: 0 }), /positive integer/, 'a non-positive qty is rejected');
  assert.match(manifestAmountError({ dir: 'load', good: T1, qty: 2.5 }), /positive integer/, 'a non-integer qty is rejected');
});

test('copyManifestLine: an amount line -> { dir, good, qty }; a max line -> { dir, good, max: true } (never qty: undefined)', () => {
  assert.deepEqual(copyManifestLine({ dir: 'load', good: T1, qty: 5 }), { dir: 'load', good: T1, qty: 5 });
  const maxCopy = copyManifestLine({ dir: 'unload', good: T1, max: true });
  assert.deepEqual(maxCopy, { dir: 'unload', good: T1, max: true });
  assert.equal('qty' in maxCopy, false, 'a max copy carries NO qty key — a reader can tell the two shapes apart');
});
