'use strict';

// fuel-burn-history.test.js — the per-guild FUEL-BURN-HISTORY engine slice
// (docs/guild-hall.md, the fuel-burn-history subsection; fuel-supply-and-allocation.md §1.4).
// Three new per-guild fields the DEUTERIUM tab (slice 2b) will read, all OBSERVED statistics —
// integer fuel QUANTITIES, never credits — stamped/recorded at the cycle boundary in tick.js
// step 6 and published in the snapshot:
//
//   - `fuelBurnedThisCycle`   the running per-cycle burn TOTAL (legal + contraband), accumulated
//                             in `burnFuel` and RESET at each boundary. A counter, never held fuel.
//   - `deuteriumFuelAtCycleStart`  the contraband held at the START of the cycle — the donut's RED
//                             baseline, exactly as `fuelHoardAtCycleStart` is the blue one.
//   - `fuelBurnHistory`       a rolling last-10-cycle ring of `{ burn, granted, contrabandBurned }`,
//                             recorded at the boundary BEFORE the new grant lands (the load-bearing
//                             order: `granted` is the PREVIOUS boundary's grant, the one that funded
//                             the closing cycle).
//
// The determinism / byte-identity story (the committed run gains only `fuelBurnHistory`, proven the
// ONLY delta by strip) lives in commitment-scaffold.test.js; this file pins the VALUES, the arithmetic,
// the boundary order, the snapshot surface, the sparsity, the ring cap, and the tripwires — and that
// invariant 1 is untouched by the accumulator (it is a statistic, not held fuel).

const { test } = require('node:test');
const assert = require('node:assert/strict');

const { createState } = require('../state.js');
const { tick } = require('../tick.js');
const { checkInvariants } = require('../invariants.js');
const { buildSnapshot } = require('../snapshot.js');
const { computeGalacticSupply } = require('../supply.js');
const { burnFuel, fuelValue } = require('../fuel.js');
const {
  FUEL_BURN_HISTORY_N, getFuelBurnHistory, pushFuelBurnEntry, cloneFuelBurnHistory,
} = require('../fuel-burn-history.js');

const SYS = 'sysA';
const N = 4; // a short window, so a boundary is 4 ticks away
const mine = (id, good, rate) => ({
  id, ownerGuildId: 'g1', type: 'mining', systemId: SYS, resourceType: good, productionRate: rate,
});

// A one-guild galaxy with a titanium mine (GP > 0, so it is DUE a grant at every boundary) over a
// pool that starts full enough to fund the grants, on the short window N. `fuelHoard` seeds the
// legal store so a test has legal fuel to burn; `deuteriumFuel` seeds the contraband store.
function fixture({ fuelHoard = 0, deuteriumFuel = 0, pool = 100000 } = {}) {
  return createState({
    guilds: [{ id: 'g1', credits: 0, fuelHoard, deuteriumFuel, ventures: [mine('t', 'titanium', 5)] }],
    reserve: { reserveLevel: pool },
    syndicate: { ledger: 0 },
    windowN: N,
  });
}
const runToBoundary = (s) => { do { s = tick(s); } while (s.tick % N !== 0); return s; };

// A faithful mid-cycle ROUTE BURN on the pre-tick state: `burnFuel` (which the accumulator hooks)
// PLUS the `audit.totalConsumed += amount` the burn's caller (sim/actions.js) does in the same
// breath — so held fuel and consumption move together and invariant 1 stays closed, exactly as a
// real SELL/BUY leaves it. Using this instead of a bare `burnFuel` keeps the boundary-entry tests
// invariant-clean without needing a full BUY fixture (route, price, credits, destination).
const routeBurn = (s, amount) => { burnFuel(s.guilds[0], amount); s.audit.totalConsumed += amount; };

// --- the module in isolation ------------------------------------------------------

test('fuel-burn-history: push appends oldest → newest and the ring caps at FUEL_BURN_HISTORY_N', () => {
  const g = {};
  assert.equal(getFuelBurnHistory(g), null, 'no history before the first entry');
  for (let i = 0; i < FUEL_BURN_HISTORY_N; i += 1) pushFuelBurnEntry(g, { burn: i, granted: i * 2, contrabandBurned: 0 });
  assert.equal(g.fuelBurnHistory.length, FUEL_BURN_HISTORY_N, 'the ring fills to its cap');
  assert.deepEqual(g.fuelBurnHistory[0], { burn: 0, granted: 0, contrabandBurned: 0 }, 'oldest first');
  assert.equal(g.fuelBurnHistory[FUEL_BURN_HISTORY_N - 1].burn, FUEL_BURN_HISTORY_N - 1, 'newest last');

  // One past the cap: the oldest is dropped, the newest is appended, length holds.
  pushFuelBurnEntry(g, { burn: 99, granted: 5, contrabandBurned: 3 });
  assert.equal(g.fuelBurnHistory.length, FUEL_BURN_HISTORY_N, 'still capped');
  assert.equal(g.fuelBurnHistory[0].burn, 1, 'the oldest entry fell off');
  assert.deepEqual(g.fuelBurnHistory[FUEL_BURN_HISTORY_N - 1], { burn: 99, granted: 5, contrabandBurned: 3 }, 'the newest is at the end');
});

test('fuel-burn-history: a non-integer or negative field is REFUSED, never written', () => {
  const g = {};
  assert.throws(() => pushFuelBurnEntry(g, { burn: 1.5, granted: 0, contrabandBurned: 0 }), /non-integer\/negative burn/);
  assert.throws(() => pushFuelBurnEntry(g, { burn: 1, granted: -1, contrabandBurned: 0 }), /non-integer\/negative granted/);
  assert.throws(() => pushFuelBurnEntry(g, { burn: 1, granted: 0, contrabandBurned: NaN }), /non-integer\/negative contrabandBurned/);
  assert.equal(g.fuelBurnHistory, undefined, 'not one corrupt entry was written');
});

test('fuel-burn-history: clone is a DEEP copy — no entry aliases into the source', () => {
  const src = [{ burn: 1, granted: 2, contrabandBurned: 0 }];
  const copy = cloneFuelBurnHistory(src);
  copy[0].burn = 999;
  assert.equal(src[0].burn, 1, 'mutating the copy does not reach the source entry');
  assert.deepEqual(cloneFuelBurnHistory(undefined), [], 'a missing list clones to an empty array');
});

// --- the accumulator (burnFuel) ---------------------------------------------------

test('accumulator: burnFuel counts the burn, a second burn adds, and it resets to 0 (omitted) at the boundary', () => {
  const g = { fuelHoard: 100 };
  burnFuel(g, 30);
  assert.equal(g.fuelBurnedThisCycle, 30, 'the first burn is counted');
  burnFuel(g, 20);
  assert.equal(g.fuelBurnedThisCycle, 50, 'a second burn adds to the accumulator');

  // Reset at the boundary: seed a due-a-grant guild, burn mid-cycle, cross a boundary.
  let s = fixture({ fuelHoard: 1000 });
  s = runToBoundary(s);
  routeBurn(s, 40); // a mid-cycle route burn on the pre-tick state (carried into the clone)
  assert.equal(s.guilds[0].fuelBurnedThisCycle, 40, 'the burn accumulated within the cycle');
  s = runToBoundary(s);
  assert.equal(s.guilds[0].fuelBurnedThisCycle, undefined, 'the accumulator is reset (key omitted) at the boundary');
});

test('accumulator: an all-legal burn never mints a deuteriumFuel key and counts the whole burn', () => {
  const g = { fuelHoard: 100 };
  burnFuel(g, 100);
  assert.equal(g.fuelBurnedThisCycle, 100);
  assert.equal(g.deuteriumFuel, undefined, 'no contraband touched');
});

// --- the boundary entry -----------------------------------------------------------

test('boundary entry: a purely-legal cycle records burn == legalBurned, contrabandBurned == 0, granted == the PREVIOUS boundary grant', () => {
  let s = fixture({ fuelHoard: 1000 });
  s = runToBoundary(s); // boundary 1: grant applied, fuelHoardAtCycleStart stamped, lastFuelGrant set
  const grant1 = s.guilds[0].lastFuelGrant.granted;
  assert.ok(grant1 > 0, 'the first boundary really granted fuel');

  const M = 40; // burn purely legal fuel this cycle
  routeBurn(s, M);
  s = runToBoundary(s); // boundary 2: records the CLOSING cycle 2

  const entry = s.guilds[0].fuelBurnHistory.at(-1);
  assert.equal(entry.burn, M, 'total burn is the legal burn');
  assert.equal(entry.contrabandBurned, 0, 'no red was touched');
  assert.equal(entry.granted, grant1, 'granted is the grant that FUNDED this cycle — the previous boundary\'s, not the new one');
  assert.notEqual(entry.granted, s.guilds[0].lastFuelGrant.granted, 'and it is NOT this boundary\'s new grant (the load-bearing order)');
  assert.deepEqual(checkInvariants(s, s.tick), [], 'invariant-clean across the boundary');
});

test('boundary entry: a cycle that dips into contraband records contrabandBurned == exactly the red drained', () => {
  let s = fixture({ fuelHoard: 1000, deuteriumFuel: 100 });
  s = runToBoundary(s); // boundary 1
  const H1 = s.guilds[0].fuelHoardAtCycleStart; // the legal hoard this cycle opens with
  const grant1 = s.guilds[0].lastFuelGrant.granted;
  const contrabandBefore = s.guilds[0].deuteriumFuel;
  const r = 20; // drain all legal, then r from the red

  routeBurn(s, H1 + r);
  assert.equal(s.guilds[0].fuelHoard, 0, 'legal fuel is fully drained');
  assert.equal(s.guilds[0].deuteriumFuel, contrabandBefore - r, 'exactly r came out of the red');

  s = runToBoundary(s); // boundary 2: records the CLOSING cycle 2
  const entry = s.guilds[0].fuelBurnHistory.at(-1);
  assert.equal(entry.burn, H1 + r, 'total burn = legal + contraband');
  assert.equal(entry.contrabandBurned, r, 'contrabandBurned is exactly the red drained');
  assert.equal(entry.burn - entry.contrabandBurned, H1, 'and the remainder is exactly the legal burn');
  assert.equal(entry.granted, grant1, 'granted is still the previous boundary\'s grant');
  assert.deepEqual(checkInvariants(s, s.tick), [], 'invariant-clean across the boundary');
});

test('boundary entry: a due-a-grant guild that burned NOTHING still records {burn:0, granted, contrabandBurned:0}', () => {
  let s = fixture({ fuelHoard: 1000 });
  s = runToBoundary(s); // boundary 1 — closing cycle 1, no prior grant → granted 0
  const first = s.guilds[0].fuelBurnHistory.at(-1);
  assert.deepEqual(first, { burn: 0, granted: 0, contrabandBurned: 0 }, 'the first cycle: nothing burned, funded by no prior grant');
  const grant1 = s.guilds[0].lastFuelGrant.granted;

  s = runToBoundary(s); // boundary 2 — still nothing burned, but funded by grant1
  const second = s.guilds[0].fuelBurnHistory.at(-1);
  assert.deepEqual(second, { burn: 0, granted: grant1, contrabandBurned: 0 }, 'the second cycle records the grant that funded it');
});

test('the ring holds at most 10, oldest dropped, ordered oldest → newest over a >10-cycle run', () => {
  let s = fixture({ fuelHoard: 0 });
  // 13 boundaries — 3 more than the cap — each pushing one entry (due a grant every cycle).
  for (let b = 0; b < 13; b += 1) s = runToBoundary(s);
  const ring = s.guilds[0].fuelBurnHistory;
  assert.equal(ring.length, FUEL_BURN_HISTORY_N, 'the ring is capped at 10 even after 13 boundaries');
  // Ordered oldest → newest: each entry's `granted` is the boundary grant one cycle earlier, and
  // those grants are non-decreasing here (the pool funds them fully), so the series is monotone
  // once past the opening cycle — a cheap ordering tell that the oldest really did fall off.
  const grants = ring.map((e) => e.granted);
  assert.ok(grants[0] > 0, 'the oldest surviving entry is past the opening (granted-0) cycle — it fell off');
  for (let i = 1; i < grants.length; i += 1) {
    assert.ok(grants[i] >= grants[i - 1], `granted series is non-decreasing (oldest → newest) at ${i}`);
  }
});

// --- the contraband start-of-cycle datum ------------------------------------------

test('deuteriumFuelAtCycleStart: stamps to the contraband held at each boundary', () => {
  let s = fixture({ fuelHoard: 100, deuteriumFuel: 77 });
  s = runToBoundary(s);
  assert.equal(s.guilds[0].deuteriumFuelAtCycleStart, 77, 'the red baseline is the contraband held at the boundary');
  assert.deepEqual(checkInvariants(s, s.tick), [], 'invariant-clean');
});

test('deuteriumFuelAtCycleStart: is null/omitted for a guild with no contraband', () => {
  let s = fixture({ fuelHoard: 100 }); // no deuteriumFuel
  s = runToBoundary(s);
  assert.equal(s.guilds[0].deuteriumFuelAtCycleStart, undefined, 'no contraband → the key is never stamped');
  const snap = buildSnapshot(s);
  const row = snap.guilds.find((g) => g.id === 'g1');
  assert.equal(row.deuteriumFuelAtCycleStart, null, 'the snapshot reports null (not 0), the honest "no red"');
  assert.equal(row.deuteriumFuelAtCycleStartValue, null, 'and its marked value is null too');
});

test('deuteriumFuelAtCycleStart: is cleared at a boundary once the guild has burned its red dry', () => {
  let s = fixture({ fuelHoard: 1000, deuteriumFuel: 50 });
  s = runToBoundary(s);
  assert.equal(s.guilds[0].deuteriumFuelAtCycleStart, 50, 'stamped while contraband is held');
  // Drain all legal, then all contraband.
  const H = s.guilds[0].fuelHoard;
  routeBurn(s, H + 50);
  assert.equal(s.guilds[0].deuteriumFuel, 0, 'the red is dry (a real 0, not deleted, by burnFuel discipline)');
  s = runToBoundary(s);
  assert.equal(s.guilds[0].deuteriumFuelAtCycleStart, undefined, 'a dry red clears the baseline — omit-when-0');
});

// --- the snapshot surface ---------------------------------------------------------

test('snapshot: publishes the three fields on the guild row, marked to the fuel price', () => {
  let s = fixture({ fuelHoard: 200, deuteriumFuel: 30 });
  s = runToBoundary(s);
  const fuelPrice = s.reserve.fuelPrice;
  routeBurn(s, 25); // a live mid-cycle burn, so the counter is non-zero at snapshot time

  const row = buildSnapshot(s).guilds.find((g) => g.id === 'g1');
  assert.equal(row.fuelBurnedThisCycle, 25, 'the live burn counter is published');
  assert.equal(row.deuteriumFuelAtCycleStart, 30, 'the red baseline is published');
  assert.equal(row.deuteriumFuelAtCycleStartValue, fuelValue(30, fuelPrice), 'and marked to the one fuel price, parallel to the blue baseline');
  assert.ok(Array.isArray(row.fuelBurnHistory), 'the burn-history series is published as an array');
  assert.equal(row.fuelBurnHistory.length, 1, 'one entry after the first boundary');
});

// --- invariant 1 is UNTOUCHED: the accumulator is a statistic, not held fuel ------

test('invariant 1: a guild mid-cycle with a nonzero fuelBurnedThisCycle still passes fuel conservation', () => {
  let s = fixture({ fuelHoard: 500 });
  s = runToBoundary(s);
  assert.deepEqual(checkInvariants(s, s.tick), [], 'clean before the accumulator is set');

  // Set the accumulator directly WITHOUT touching hoard or audit — it is a pure statistic, so
  // conservation (produced − consumed == pool + Σ hoards) must be undisturbed by it.
  const withCounter = structuredClone(s);
  withCounter.guilds[0].fuelBurnedThisCycle = 123;
  assert.deepEqual(checkInvariants(withCounter, withCounter.tick), [],
    'a nonzero accumulator does not disturb invariant 1 — it is a statistic, not held fuel');
});

test('galactic supply: guildHeld sums only the two hoards, never the accumulator', () => {
  let s = fixture({ fuelHoard: 400, deuteriumFuel: 60 });
  s = runToBoundary(s);
  const g = s.guilds[0];
  const before = computeGalacticSupply(s).fuel.guildHeld;
  assert.equal(before, g.fuelHoard + (g.deuteriumFuel || 0), 'guildHeld is exactly legal + contraband');

  const withCounter = structuredClone(s);
  withCounter.guilds[0].fuelBurnedThisCycle = 999;
  assert.equal(computeGalacticSupply(withCounter).fuel.guildHeld, before,
    'the accumulator changes guildHeld not at all');
});

test('invariants: the non-negativity/integer sweep trips on a corrupt value in each new field', () => {
  let s = fixture({ fuelHoard: 100, deuteriumFuel: 40 });
  s = runToBoundary(s);
  assert.deepEqual(checkInvariants(s, s.tick), [], 'clean before it is broken');

  // fuelBurnedThisCycle
  const negBurn = structuredClone(s);
  negBurn.guilds[0].fuelBurnedThisCycle = -1;
  assert.ok(checkInvariants(negBurn, negBurn.tick).some((v) => v.rule === 'non-negativity (invariant 3)'),
    'a negative accumulator trips non-negativity');
  const fracBurn = structuredClone(s);
  fracBurn.guilds[0].fuelBurnedThisCycle = 2.5;
  assert.ok(checkInvariants(fracBurn, fracBurn.tick).some((v) => v.rule === 'integer credits/goods (§15.2)'),
    'a fractional accumulator trips the integer sweep');

  // deuteriumFuelAtCycleStart
  const negRed = structuredClone(s);
  negRed.guilds[0].deuteriumFuelAtCycleStart = -5;
  assert.ok(checkInvariants(negRed, negRed.tick).some((v) => v.rule === 'non-negativity (invariant 3)'),
    'a negative red baseline trips non-negativity');
  const fracRed = structuredClone(s);
  fracRed.guilds[0].deuteriumFuelAtCycleStart = 1.5;
  assert.ok(checkInvariants(fracRed, fracRed.tick).some((v) => v.rule === 'integer credits/goods (§15.2)'),
    'a fractional red baseline trips the integer sweep');

  // fuelBurnHistory entries
  const negEntry = structuredClone(s);
  negEntry.guilds[0].fuelBurnHistory = [{ burn: -1, granted: 0, contrabandBurned: 0 }];
  assert.ok(checkInvariants(negEntry, negEntry.tick).some((v) => v.rule === 'non-negativity (invariant 3)'),
    'a negative burn in a history entry trips non-negativity');
  const fracEntry = structuredClone(s);
  fracEntry.guilds[0].fuelBurnHistory = [{ burn: 0, granted: 1.1, contrabandBurned: 0 }];
  assert.ok(checkInvariants(fracEntry, fracEntry.tick).some((v) => v.rule === 'integer credits/goods (§15.2)'),
    'a fractional granted in a history entry trips the integer sweep');
});

test('invariants: a rotted fuel-burn history is caught (shape, cap)', () => {
  let s = fixture({ fuelHoard: 100 });
  s = runToBoundary(s);

  const notArray = structuredClone(s);
  notArray.guilds[0].fuelBurnHistory = { 0: { burn: 0, granted: 0, contrabandBurned: 0 } };
  assert.ok(checkInvariants(notArray, notArray.tick).some((v) => v.rule === 'fuel-burn-history-is-an-array (sim/fuel-burn-history.js)'),
    'a non-array history is caught');

  const overCap = structuredClone(s);
  overCap.guilds[0].fuelBurnHistory = new Array(FUEL_BURN_HISTORY_N + 1).fill({ burn: 0, granted: 0, contrabandBurned: 0 });
  assert.ok(checkInvariants(overCap, overCap.tick).some((v) => v.rule === 'fuel-burn-history-ring-capped-at-FUEL_BURN_HISTORY_N (sim/fuel-burn-history.js)'),
    'a ring past its cap is caught');
});
