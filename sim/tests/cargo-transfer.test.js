'use strict';

// cargo-transfer.test.js — the craft hold + load/unload at a system, roadmap 2.2 (cargo, engine
// slice 1) (design.md §4 "The dock model", the SYSTEM half; §15.4 the Vehicle `cargo` field). A
// guild loads/unloads an IDLE craft against the system it sits at, resolved INSTANTLY — no slot, no
// timer (the Outpost park/queue/turnaround is a later slice, and a transfer anywhere but a system is
// refused). The manifest resolves ALL UNLOADS FIRST, then ALL LOADS, each line clamped to what fits.
//
// The tripwires, one per ruling:
//   - a LOAD is clamped by hold CAPACITY (`Σ qty×volumeOf ≤ capacity`) — a partial when the ask overflows;
//   - an UNLOAD is clamped by what the HOLD holds;
//   - the UNLOADS-THEN-LOADS CASCADE — arrive full, an unload frees space, the load takes only the freed space;
//   - a good the POOL LACKS loads zero, and the rest of the manifest still resolves (partial-safe);
//   - SUPPLY IS CONSERVED across a load (galactic-supply consistency green before and after, hold-inclusive);
//   - a transfer at an OUTPOST or a BARE HEX is refused (systems only this slice);
//   - every well-formed FAILURE MODE is rejected (empty / bad dir / unknown good / non-positive qty /
//     fuel good / non-idle craft / unknown guild / unknown craft);
//   - every mutation STAMPS ITS TICK;
//   - the omit-when-empty NO-OP (a never-loaded craft carries no `cargo` key) and DETERMINISM (a
//     transfer replays byte-identically);
//   - the INVARIANT guards a corrupt hold (unknown good / non-positive qty / over capacity).

const { test } = require('node:test');
const assert = require('node:assert/strict');

const { createState } = require('../state.js');
const { tick } = require('../tick.js');
const { hashState } = require('../serialize.js');
const { checkInvariants } = require('../invariants.js');
const { buildSnapshot } = require('../snapshot.js');
const { getStock } = require('../stock.js');
const { computeGalacticSupply } = require('../supply.js');
const { volumeOf } = require('../fuel.js');
const { LIGHT_TRANSPORT, VEHICLE_SPECS } = require('../vehicles.js');
const { isHexInBounds, seedLandmarkAtHex } = require('../seed.js');
const { starterHomeAtDistance } = require('./waystation-fixtures.js');
const {
  validateAction, applyAction,
  createSpawnVehicleAction, createTransferCargoAction, createDispatchVehicleAction,
} = require('../actions.js');

const SYS = starterHomeAtDistance(6).id; // a real seed system the craft berths at
const LIGHT = VEHICLE_SPECS[LIGHT_TRANSPORT]; // capacity 10000
const VID = 'vehicle_g1_lightTransport_01';

// Good volumes read from the ONE source (`volumeOf`), never inlined: T1 titanium = 1, T2
// titanium_alloy = 100, T3 chassis = 60,000. So a light hold (10,000) fits 10,000 titanium OR
// 100 titanium_alloy, and a single chassis (60,000) never fits — the clamp cases below.
const T1 = 'titanium';
const T2 = 'titanium_alloy';

// The first in-bounds hex holding no seed landmark — DERIVED from the seed (the outposts.test.js
// discipline), so a regen carries the test rather than breaking it. Used as a bare-hex berth and an
// outpost site.
function firstFreeHex() {
  for (let q = -60; q <= 60; q += 1) {
    for (let r = -60; r <= 60; r += 1) {
      if (isHexInBounds(q, r) && !seedLandmarkAtHex(q, r)) return { q, r };
    }
  }
  throw new Error('no free hex on this seed');
}
const FREE = firstFreeHex();
const OUT = 'out_01'; // a seed waystation-outpost id (getLandmark resolves it) — the systems-only refusal case

// A bare guild with an idle light craft at `location` (a system landmark by default) and its SYS pool
// seeded from `pool`. Nothing needs seating — a transfer touches no claims/credits/fuel — and the
// ledger is balanced so createState opens invariant-clean.
function stateWith({ location = { landmarkKind: 'system', landmarkId: SYS }, pool = {}, fuelHoard = 0 } = {}) {
  const guild = { id: 'g1', credits: 0, fuelHoard };
  if (Object.keys(pool).length) guild.stockpiles = { [SYS]: { ...pool } };
  let s = createState({ guilds: [guild], reserve: { reserveLevel: 0 }, syndicate: { ledger: 0 } });
  s = accept(s, createSpawnVehicleAction({ guildId: 'g1', class: LIGHT_TRANSPORT, location }));
  return s;
}

const accept = (state, action) => {
  const { valid, reason } = validateAction(state, action);
  assert.equal(valid, true, `expected accepted, got: ${reason}`);
  return applyAction(state, action);
};
const refuse = (state, action) => {
  const { valid, reason } = validateAction(state, action);
  assert.equal(valid, false, 'expected refused');
  return reason;
};
const transfer = (manifest) => createTransferCargoAction({ guildId: 'g1', vehicleId: VID, manifest });
const craftOf = (s) => s.guilds[0].vehicles.find((v) => v.id === VID);
const pool = (s, good) => getStock(s.guilds[0], SYS, good);
const ticks = (state, n) => {
  let s = state;
  for (let i = 0; i < n; i += 1) s = tick(s, []);
  return s;
};

// --- 1. a load is clamped by hold capacity (partial when the ask overflows) --------------------

test('load: clamped by hold capacity — the overflow loads only what fits, the rest stays in the pool', () => {
  // 150 titanium_alloy would need 15,000 space; the light hold is 10,000 → 100 units fit.
  let s = stateWith({ pool: { [T2]: 500 } });
  s = accept(s, transfer([{ dir: 'load', good: T2, qty: 150 }]));
  assert.deepEqual(craftOf(s).cargo, { [T2]: 100 }, 'loaded exactly what fit the hold');
  assert.equal(pool(s, T2), 400, 'the pool kept the 50 that did not fit');
  assert.equal(100 * volumeOf(T2), LIGHT.capacity, 'the hold is exactly full (Σ qty×volumeOf == capacity)');
  assert.deepEqual(checkInvariants(s, s.tick), []);
});

// --- 2. an unload is clamped by what the hold holds --------------------------------------------

test('unload: clamped by what the hold holds — asking for more than it carries moves only what it has', () => {
  let s = stateWith({ pool: { [T2]: 500 } });
  s = accept(s, transfer([{ dir: 'load', good: T2, qty: 40 }]));   // hold 40, pool 460
  assert.deepEqual(craftOf(s).cargo, { [T2]: 40 });
  s = accept(s, transfer([{ dir: 'unload', good: T2, qty: 100 }])); // asks 100, holds 40 -> moves 40
  assert.equal(craftOf(s).cargo, undefined, 'an emptied hold drops the cargo key (omit-when-empty)');
  assert.equal(pool(s, T2), 500, 'the 40 returned to the pool, nothing invented');
  assert.deepEqual(checkInvariants(s, s.tick), []);
});

// --- 3. the unloads-then-loads cascade ---------------------------------------------------------

test('cascade: arrive full, an unload frees space, and the load takes ONLY the freed space', () => {
  let s = stateWith({ pool: { [T1]: 100000, [T2]: 500 } });
  s = accept(s, transfer([{ dir: 'load', good: T2, qty: 100 }])); // hold full: 100×100 = 10,000
  assert.equal(craftOf(s).cargo[T2], 100);

  // Unload 40 titanium_alloy frees 4,000 space; then load titanium (vol 1) asking for far more than
  // fits — it must take exactly the 4,000 the unload freed, not the whole ask (the §4 cascade).
  s = accept(s, transfer([
    { dir: 'unload', good: T2, qty: 40 },
    { dir: 'load', good: T1, qty: 100000 },
  ]));
  assert.deepEqual(craftOf(s).cargo, { [T2]: 60, [T1]: 4000 }, 'the load took only the freed space');
  const used = 60 * volumeOf(T2) + 4000 * volumeOf(T1);
  assert.equal(used, LIGHT.capacity, 'the hold is full again — the load filled exactly the freed room');
  assert.equal(pool(s, T1), 96000, 'the pool gave up exactly the 4,000 that fit');
  assert.equal(pool(s, T2), 440, 'the 40 unloaded titanium_alloy returned to the pool');
  assert.deepEqual(checkInvariants(s, s.tick), []);
});

test('a full hold with only a load line loads nothing (no unload to free space first)', () => {
  let s = stateWith({ pool: { [T1]: 100000, [T2]: 500 } });
  s = accept(s, transfer([{ dir: 'load', good: T2, qty: 100 }])); // full
  const before = pool(s, T1);
  s = accept(s, transfer([{ dir: 'load', good: T1, qty: 5000 }])); // no room -> 0
  assert.equal(craftOf(s).cargo[T1], undefined, 'nothing loaded into the full hold');
  assert.equal(pool(s, T1), before, 'the pool is untouched');
});

// --- 4. a good the pool lacks loads zero; the rest of the manifest still resolves ---------------

test('partial-safe: a good the pool lacks loads zero, and the other lines still resolve', () => {
  let s = stateWith({ pool: { [T1]: 100 } }); // no gold in the pool
  s = accept(s, transfer([
    { dir: 'load', good: 'gold', qty: 10 }, // pool holds 0 gold -> loads 0
    { dir: 'load', good: T1, qty: 5 },       // resolves normally
  ]));
  assert.deepEqual(craftOf(s).cargo, { [T1]: 5 }, 'gold moved nothing; titanium loaded');
  assert.equal(pool(s, T1), 95);
  assert.deepEqual(checkInvariants(s, s.tick), []);
});

// --- 5. supply is conserved across a load (hold-inclusive galactic supply) ----------------------

test('supply: a load moves goods pool->hold with galactic supply CONSERVED and consistent', () => {
  let s = stateWith({ pool: { [T2]: 500 } });
  assert.deepEqual(checkInvariants(s, s.tick), [], 'consistent before');
  const before = computeGalacticSupply(s).resources[T2];
  assert.equal(before, 500, 'the pool total is in supply');

  s = accept(s, transfer([{ dir: 'load', good: T2, qty: 100 }]));
  const after = computeGalacticSupply(s).resources[T2];
  assert.equal(after, before, 'supply unchanged — the hold is counted, so pool−100 + hold+100 nets zero');
  assert.equal(pool(s, T2) + craftOf(s).cargo[T2], 500, 'pool + hold still totals the original');
  assert.deepEqual(checkInvariants(s, s.tick), [], 'consistent after (the cache matches the hold-inclusive sum)');
});

// --- 6. a store is required — a seed waystation or an empty bare hex is refused -----------------

test('refused: a craft at a seed waystation (NOT a guild Outpost) has no dockable store', () => {
  // A craft berthed at a seed waystation-outpost (`landmarkKind: 'outpost'`, resolved by getLandmark).
  // A seed waystation is NOT a guild Outpost (the dock model, slice 2, docks only at a guild Outpost
  // reached by hex-coincidence, §4/§15.4), so there is no store here — refused as deep space.
  const s = stateWith({ location: { landmarkKind: 'outpost', landmarkId: OUT }, pool: {} });
  const reason = refuse(s, transfer([{ dir: 'load', good: T1, qty: 1 }]));
  assert.match(reason, /deep space|Outpost/, 'refused — no system or owned guild Outpost here');
});

test('refused: a transfer in deep space (a bare hex with no owned Outpost) has no store to move against', () => {
  const s = stateWith({ location: FREE, pool: {} }); // a bare hex holding no owned Outpost
  const reason = refuse(s, transfer([{ dir: 'load', good: T1, qty: 1 }]));
  assert.match(reason, /deep space/);
});

// --- 7. the well-formedness gates --------------------------------------------------------------

test('refused: malformed manifests (empty / bad dir / unknown good / non-positive qty / fuel)', () => {
  const s = stateWith({ pool: { [T1]: 100 } });
  assert.match(refuse(s, transfer([])), /non-empty array/);
  assert.match(refuse(s, transfer([{ dir: 'sideways', good: T1, qty: 1 }])), /dir must be/);
  assert.match(refuse(s, transfer([{ dir: 'load', good: 'not_a_good', qty: 1 }])), /not a known stockpile good/);
  assert.match(refuse(s, transfer([{ dir: 'load', good: 'deuterium_fuel', qty: 1 }])), /not a known stockpile good/); // fuel is never a hold good
  assert.match(refuse(s, transfer([{ dir: 'load', good: T1, qty: 0 }])), /positive integer/);
  assert.match(refuse(s, transfer([{ dir: 'load', good: T1, qty: 2.5 }])), /positive integer/);
  assert.match(refuse(s, transfer([{ dir: 'load', good: T1, qty: -3 }])), /positive integer/);
});

test('refused: a non-idle craft, an unknown guild, an unknown craft', () => {
  // In-transit craft: dispatch it away first (needs fuel), then a transfer is refused.
  let s = stateWith({ pool: {}, fuelHoard: 500 });
  s = accept(s, createDispatchVehicleAction({ guildId: 'g1', vehicleId: VID, waypoints: [FREE] }));
  assert.match(refuse(s, transfer([{ dir: 'load', good: T1, qty: 1 }])), /not idle/);

  const s2 = stateWith({ pool: { [T1]: 10 } });
  assert.match(refuse(s2, createTransferCargoAction({ guildId: 'nope', vehicleId: VID, manifest: [{ dir: 'load', good: T1, qty: 1 }] })), /no guild/);
  assert.match(refuse(s2, createTransferCargoAction({ guildId: 'g1', vehicleId: 'nope', manifest: [{ dir: 'load', good: T1, qty: 1 }] })), /owns no vehicle/);
});

// --- 8. every mutation stamps its tick ---------------------------------------------------------

test('tick stamp: a transfer records the tick it moved goods on (§15.2)', () => {
  let s = stateWith({ pool: { [T1]: 100 } });
  assert.equal(craftOf(s).updatedAtTick, null, 'a spawned craft has stamped nothing yet');
  s = ticks(s, 2); // advance to tick 2
  s = accept(s, transfer([{ dir: 'load', good: T1, qty: 10 }]));
  assert.equal(craftOf(s).updatedAtTick, 2, 'stamped with the tick the transfer resolved on');
});

// --- 9. the no-op + determinism ----------------------------------------------------------------

test('no-op: a never-loaded craft carries no cargo key (byte-identical to pre-slice)', () => {
  const s = stateWith({ pool: { [T1]: 100 } });
  assert.equal('cargo' in craftOf(s), false, 'the omit-when-empty hold — no key on a craft that never loaded');
  assert.deepEqual(buildSnapshot(s).guilds[0].vehicles[0].cargo, {}, 'the snapshot still surfaces a stable {} for the reader');
});

test('determinism (invariant 9): the same transfer applied to the same start replays byte-identically', () => {
  const start = stateWith({ pool: { [T1]: 100000, [T2]: 500 } });
  const manifest = [{ dir: 'load', good: T2, qty: 100 }, { dir: 'load', good: T1, qty: 5 }];
  const a = accept(start, transfer(manifest));
  const b = accept(start, transfer(manifest));
  assert.equal(hashState(a), hashState(b), 'a transfer is a pure function of the start state');
});

// --- 10. the invariant guards a corrupt hold ---------------------------------------------------

test('invariant: a corrupt hold (unknown good / non-positive qty / over capacity) trips the guard', () => {
  const base = stateWith({ pool: {} });
  const rules = (s) => checkInvariants(s, s.tick).map((v) => v.rule);

  // Over capacity: one chassis is 60,000 space, far past the light hold's 10,000.
  const over = structuredCloneState(base);
  over.guilds[0].vehicles[0].cargo = { chassis: 1 };
  assert.ok(rules(over).includes('vehicle-cargo-within-capacity'), 'a hold past capacity is flagged');

  // A non-integer / non-positive qty.
  const badQty = structuredCloneState(base);
  badQty.guilds[0].vehicles[0].cargo = { [T1]: 0 };
  assert.ok(rules(badQty).includes('vehicle-cargo-positive-int'), 'a zero qty is flagged');

  // An unknown good key.
  const badGood = structuredCloneState(base);
  badGood.guilds[0].vehicles[0].cargo = { not_a_good: 5 };
  assert.ok(rules(badGood).includes('vehicle-cargo-known-good (resources.js)'), 'an unknown good is flagged');
});

// A tiny deep-copy so a mutation in one assertion can't leak into the shared `base`.
function structuredCloneState(s) {
  return JSON.parse(JSON.stringify(s));
}
