'use strict';

// deployable-goods.test.js — the DEPLOYABLE good, roadmap 2.2 the deploy pipeline slice 1
// (docs/territory-model.md §5 — "a kit rides as cargo and deploy consumes it"; design.md §4
// ASSET_CARGO_VOLUME = HEAVY_HOLD; §15.2 integer goods). `outpost_kit` is the first good the game
// MOVES but never TRADES: legal in a craft's hold, and nowhere else.
//
// The tripwires, one per ruling:
//   - CATEGORY: `outpost_kit` is a deployable good, NOT a stockpile good, NOT fuel — the three
//     categories never overlap, and `kitGoodFor('outpost')` names it (the only kind this slice);
//   - VOLUME: `volumeOf(outpost_kit)` is ASSET_CARGO_VOLUME = HEAVY_HOLD, which is exactly a heavy
//     transport's hold and more than a medium's — so heavy-only and one-at-a-time fall out of it;
//   - OFF-MARKET: it has no price row, no band, no base; a tick with a kit aboard prices nothing new;
//   - OFF-SUPPLY: a hold carrying a kit adds 0 to Galactic Supply (supply.js sums stockpile goods only);
//   - INTEGRITY: legal in a hold; ILLEGAL in a system pool and in an Outpost stockpile; two kits in a
//     heavy, or one in a medium, overflow the hold and trip;
//   - NEVER AUTOMATES / NEVER MANIFESTED: a manual transfer, a route-action @load/@unload and a saved
//     route that names the kit are all refused, and the adjust-goods lever cannot put one in a pool;
//   - SNAPSHOT: a kit shows as an ordinary cargo key (no new field), its `used` a whole heavy hold.

const { test } = require('node:test');
const assert = require('node:assert/strict');

const { createState } = require('../state.js');
const { tick } = require('../tick.js');
const { checkInvariants } = require('../invariants.js');
const { buildSnapshot } = require('../snapshot.js');
const { computeGalacticSupply } = require('../supply.js');
const { volumeOf, ASSET_CARGO_VOLUME, HEAVY_HOLD } = require('../fuel.js');
const {
  PRICED_GOODS, seedPrices, bandFor, basePriceFor, postedPrice,
} = require('../prices.js');
const {
  STOCKPILE_GOODS, DEPLOYABLE_GOODS, OUTPOST_KIT, FUEL_GOOD,
  isStockpileGood, isDeployableGood, isFuel, kitGoodFor,
} = require('../resources.js');
const {
  VEHICLE_SPECS, HEAVY_TRANSPORT, MEDIUM_TRANSPORT, LIGHT_TRANSPORT,
} = require('../vehicles.js');
const { isHexInBounds, seedLandmarkAtHex } = require('../seed.js');
const { starterHomeAtDistance } = require('./waystation-fixtures.js');
const {
  validateAction, applyAction,
  createSpawnVehicleAction, createTransferCargoAction, createDispatchRouteWithActionsAction,
  createSaveRouteAction, createAdjustGoodsAction,
} = require('../actions.js');

const SYS = starterHomeAtDistance(6).id; // a real seed system a craft berths at
const AT_SYS = { landmarkKind: 'system', landmarkId: SYS };

// The first in-bounds hex with no seed landmark — derived from the seed, so a regen carries the test.
function firstFreeHex() {
  for (let q = -60; q <= 60; q += 1) {
    for (let r = -60; r <= 60; r += 1) {
      if (isHexInBounds(q, r) && !seedLandmarkAtHex(q, r)) return { q, r };
    }
  }
  throw new Error('no free hex on this seed');
}
const FREE = firstFreeHex();

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

// A bare guild with one idle craft of `vehicleClass` at its system, and `pool` in that system's
// stockpile. Nothing needs seating; the ledger is balanced so createState opens invariant-clean.
function stateWith({ vehicleClass = HEAVY_TRANSPORT, pool = {} } = {}) {
  const guild = { id: 'g1', credits: 0, fuelHoard: 0 };
  if (Object.keys(pool).length) guild.stockpiles = { [SYS]: { ...pool } };
  let s = createState({ guilds: [guild], reserve: { reserveLevel: 0 }, syndicate: { ledger: 0 } });
  s = accept(s, createSpawnVehicleAction({ guildId: 'g1', class: vehicleClass, location: AT_SYS }));
  return s;
}
const craftOf = (s) => s.guilds[0].vehicles[0];

// Put a hold in place directly. The grant-kit action (the real mint) is tested in deploy-asset.test.js;
// these tests are about what the CATEGORY allows, so they write the state the way a save-reload would.
function withHold(s, cargo) {
  craftOf(s).cargo = { ...cargo };
  return s;
}
const rulesOf = (violations) => violations.map((v) => v.rule);

// --- 1. the category -----------------------------------------------------------------------------

test('category: outpost_kit is a deployable good — not a stockpile good, not fuel', () => {
  assert.equal(OUTPOST_KIT, 'outpost_kit');
  assert.deepEqual([...DEPLOYABLE_GOODS], ['outpost_kit'], 'the only kind this slice');
  assert.equal(isDeployableGood(OUTPOST_KIT), true);
  assert.equal(isStockpileGood(OUTPOST_KIT), false, 'never a stockpile key');
  assert.equal(STOCKPILE_GOODS.includes(OUTPOST_KIT), false);
  assert.equal(isFuel(OUTPOST_KIT), false);
  // The three categories never overlap.
  for (const g of STOCKPILE_GOODS) assert.equal(isDeployableGood(g), false, `${g} is a stockpile good`);
  assert.equal(isDeployableGood(FUEL_GOOD), false);
  assert.equal(isDeployableGood('unobtanium'), false);
  assert.equal(isDeployableGood(undefined), false);
  // A kind maps to its kit; an unknown kind has none.
  assert.equal(kitGoodFor('outpost'), OUTPOST_KIT);
  assert.equal(kitGoodFor('tollGate'), null, 'not built this slice');
  assert.equal(kitGoodFor('toString'), null, 'an inherited property name is not a kind');
});

// --- 2. the volume ------------------------------------------------------------------------------

test('volume: a kit is one whole heavy hold — so only a heavy carries one, one at a time', () => {
  assert.equal(volumeOf(OUTPOST_KIT), ASSET_CARGO_VOLUME);
  assert.equal(ASSET_CARGO_VOLUME, HEAVY_HOLD);
  // The heavy transport's hold and HEAVY_HOLD are two separately-sourced values that happen to agree
  // (phase-1-tuning.md). If they ever drift apart, "a heavy carries exactly one kit" breaks — fail here.
  assert.equal(VEHICLE_SPECS[HEAVY_TRANSPORT].capacity, volumeOf(OUTPOST_KIT), 'a heavy hold fits exactly one kit');
  assert.ok(VEHICLE_SPECS[MEDIUM_TRANSPORT].capacity < volumeOf(OUTPOST_KIT), 'a medium cannot carry one');
  assert.ok(VEHICLE_SPECS[LIGHT_TRANSPORT].capacity < volumeOf(OUTPOST_KIT), 'a light cannot carry one');
  assert.ok(Number.isInteger(volumeOf(OUTPOST_KIT)), 'an integer volume (§15.2)');
});

// --- 3. off-market -------------------------------------------------------------------------------

test('off-market: a kit is never priced — no price row, no band, no base, and a tick adds none', () => {
  assert.equal(PRICED_GOODS.includes(OUTPOST_KIT), false);
  assert.equal(Object.prototype.hasOwnProperty.call(seedPrices(), OUTPOST_KIT), false);
  assert.equal(bandFor(OUTPOST_KIT), null, 'bandFor answers "not priced" rather than throwing or guessing');
  assert.equal(basePriceFor(OUTPOST_KIT), null);

  // A heavy with a kit aboard ticks cleanly: the price step walks PRICED_GOODS only, so it never
  // reaches the kit, and no row for it appears.
  let s = withHold(stateWith(), { [OUTPOST_KIT]: 1 });
  s = tick(s, []);
  s = tick(s, []);
  assert.equal(postedPrice(s, OUTPOST_KIT), null);
  assert.equal(Object.prototype.hasOwnProperty.call(s.prices, OUTPOST_KIT), false);
  assert.deepEqual(craftOf(s).cargo, { [OUTPOST_KIT]: 1 }, 'the kit rode two ticks untouched');
  assert.deepEqual(checkInvariants(s, s.tick), []);
});

// --- 4. off-supply -------------------------------------------------------------------------------

test('off-supply: a hold carrying a kit adds 0 to Galactic Supply', () => {
  const empty = stateWith();
  const laden = withHold(stateWith(), { [OUTPOST_KIT]: 1 });
  const before = computeGalacticSupply(empty);
  const after = computeGalacticSupply(laden);
  assert.deepEqual(after, before, 'the kit is invisible to the supply totals');
  assert.equal(Object.prototype.hasOwnProperty.call(after.resources, OUTPOST_KIT), false, 'no supply row for it');
  // And the cached supply still matches the live sum (galactic-supply consistency stays green).
  laden.galacticSupply = computeGalacticSupply(laden);
  assert.deepEqual(checkInvariants(laden, laden.tick), []);
});

// --- 5. integrity: where a kit may live ----------------------------------------------------------

test('integrity: a kit is LEGAL in a heavy hold', () => {
  const s = withHold(stateWith(), { [OUTPOST_KIT]: 1 });
  assert.deepEqual(checkInvariants(s, s.tick), []);
});

test('integrity: a kit is ILLEGAL in a system pool', () => {
  const s = stateWith({ pool: { titanium: 5 } });
  s.guilds[0].stockpiles[SYS][OUTPOST_KIT] = 1;
  s.galacticSupply = computeGalacticSupply(s);
  assert.ok(rulesOf(checkInvariants(s, s.tick)).includes('known-good (resources.js)'));
});

test('integrity: a kit is ILLEGAL in an Outpost stockpile', () => {
  const s = stateWith();
  s.outposts = [{
    id: 'outpost_g1_01', ownerGuildId: 'g1', coords: FREE, anchorSystemId: SYS,
    stockpile: { [OUTPOST_KIT]: 1 }, capacity: 30 * HEAVY_HOLD, dockCapacity: 10, createdAtTick: 0,
  }];
  s.guilds[0].outpostSerial = 1;
  assert.ok(rulesOf(checkInvariants(s, s.tick)).includes('outpost-stockpile-known-good (resources.js)'));
});

test('integrity: two kits in a heavy, or one in a medium, overflow the hold and trip', () => {
  const two = withHold(stateWith(), { [OUTPOST_KIT]: 2 });
  assert.ok(rulesOf(checkInvariants(two, two.tick)).includes('vehicle-cargo-within-capacity'));
  const medium = withHold(stateWith({ vehicleClass: MEDIUM_TRANSPORT }), { [OUTPOST_KIT]: 1 });
  assert.ok(rulesOf(checkInvariants(medium, medium.tick)).includes('vehicle-cargo-within-capacity'));
});

test('integrity: a kit beside other cargo in a heavy overflows the hold (the kit fills it)', () => {
  const s = withHold(stateWith(), { [OUTPOST_KIT]: 1, titanium: 1 });
  assert.ok(rulesOf(checkInvariants(s, s.tick)).includes('vehicle-cargo-within-capacity'));
});

test('integrity: a kit quantity must be a positive integer, like any cargo (§15.2)', () => {
  const s = withHold(stateWith(), { [OUTPOST_KIT]: 0.5 });
  assert.ok(rulesOf(checkInvariants(s, s.tick)).includes('vehicle-cargo-positive-int'));
});

// --- 6. never manifested, never automated --------------------------------------------------------

test('never manifested: a manual transfer naming the kit is refused (load and unload)', () => {
  const s = withHold(stateWith(), { [OUTPOST_KIT]: 1 });
  for (const dir of ['load', 'unload']) {
    const reason = refuse(s, createTransferCargoAction({
      guildId: 'g1', vehicleId: craftOf(s).id, manifest: [{ dir, good: OUTPOST_KIT, qty: 1 }],
    }));
    assert.match(reason, /not a known stockpile good/);
  }
});

test('never automates: a route-action @load / @unload of the kit is refused, on a one-shot and on a lane', () => {
  const s = withHold(stateWith(), { [OUTPOST_KIT]: 1 });
  s.guilds[0].fuelHoard = 1_000_000; // fuel is not what refuses these
  const other = starterHomeAtDistance(4).id;
  for (const dir of ['load', 'unload']) {
    for (const repeat of [undefined, { mode: 'continuous' }]) {
      const reason = refuse(s, createDispatchRouteWithActionsAction({
        guildId: 'g1',
        vehicleId: craftOf(s).id,
        waypoints: [
          { anchor: { landmarkKind: 'system', landmarkId: other } },
          { anchor: AT_SYS, action: { type: 'dock', manifest: [{ dir, good: OUTPOST_KIT, qty: 1 }] } },
        ],
        ...(repeat ? { repeat } : {}),
      }));
      assert.match(reason, /not a known stockpile good/);
    }
  }
});

test('never automates: a saved route naming the kit is refused', () => {
  const s = stateWith();
  const reason = refuse(s, createSaveRouteAction({
    guildId: 'g1',
    name: 'Kit run',
    waypoints: [{ anchor: AT_SYS, action: { type: 'dock', manifest: [{ dir: 'load', good: OUTPOST_KIT, max: true }] } }],
  }));
  assert.match(reason, /not a known stockpile good/);
});

test('never pooled: the adjust-goods lever cannot put a kit in a system pool', () => {
  const s = stateWith();
  const reason = refuse(s, createAdjustGoodsAction({ guildId: 'g1', systemId: SYS, good: OUTPOST_KIT, delta: 1 }));
  assert.match(reason, /not a known stockpile good/);
});

// --- 7. the snapshot -----------------------------------------------------------------------------

test('snapshot: a kit shows as an ordinary cargo key — no new field — filling the hold', () => {
  const s = withHold(stateWith(), { [OUTPOST_KIT]: 1 });
  const row = buildSnapshot(s).guilds[0].vehicles[0];
  assert.deepEqual(row.cargo, { [OUTPOST_KIT]: 1 });
  assert.equal(row.used, ASSET_CARGO_VOLUME);
  assert.equal(row.capacity, VEHICLE_SPECS[HEAVY_TRANSPORT].capacity);
  // The row's keys are the same as an empty heavy's: a kit adds no field of its own.
  const plain = buildSnapshot(stateWith()).guilds[0].vehicles[0];
  assert.deepEqual(Object.keys(row).sort(), Object.keys(plain).sort());
});
