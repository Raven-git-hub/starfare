'use strict';

// fuel-cost.test.js — the SPACE-TIERED route burn and the cargo-space primitives
// (docs/transport-model.md §5.1, REVISED 14-09-26; numbers phase-1-tuning.md).
//
// ⤳ THIS FILE WAS THE CARGO-INDEPENDENT SLICE-2 QUOTE. That model is superseded: a
// Syndicate leg now flies on the SMALLEST hauler tier whose hold fits its cargo SPACE
// (`Σ qty × volumeOf(good)`), and the tier sets the per-hex rate. So `routeFuelCost` now
// takes the leg's SPACE (required — a charge site that forgot it would silently
// under-charge), and the burn steps between tiers by that space. The tripwires here guard:
//
//   1. THE PRIMITIVES. `volumeOf` (per-unit space by manufacturing tier: T1 1, T2 100,
//      T3 60,000, fuel/non-priced throws) and `haulerTierForSpace` (the smallest hold that
//      fits, inclusive at each boundary, null over the heavy hold).
//   2. THE BURN IS SPACE-TIERED, NOT CARGO-INDEPENDENT. A light-hold leg is the old
//      ceil(distance × 0.5) — byte-identical — but a bigger leg steps to the thirstier
//      medium/heavy rate. Rates rise with the tier, so for a fixed distance the burn never
//      cliffs backwards, and consolidating onto one heavy beats splitting across lights.
//   3. IT STILL MEASURES ONE GEOMETRY. The distance is the one `nearestWaystation` computed
//      and `buyFromSyndicate` schedules on — quote and flight share it, end to end.
//   4. THE SNAPSHOT surfaces the per-tier burns + volumes + hold ladder additively, and its
//      `fuelBurn`/`creditCost` stay the LIGHT-tier values (today's numbers).
//
// The seed is the fixture. These are real distances on seed 7331, so a change to the
// generator that moves a waystation shows up here as a moved number.

const { test } = require('node:test');
const assert = require('node:assert/strict');

const { createState } = require('../state.js');
const { buildSnapshot } = require('../snapshot.js');
const { hashState } = require('../serialize.js');
const { checkInvariants } = require('../invariants.js');
const { guildHolds, heldSystemIds } = require('../claims.js');
const { nearestWaystation, arrivalTickFor } = require('../transport.js');
const { postedPrice } = require('../prices.js');
const {
  REFERENCE_FUEL_PRICE, SYNDICATE_HAULER_BURN_RATE, GUILD_STARTING_FUEL,
  routeFuelCost, routeFuelBurnByTier, fuelValue,
  volumeOf, haulerTierForSpace, HAULER_TIERS, HEAVY_HOLD, ASSET_CARGO_VOLUME,
} = require('../fuel.js');
const {
  createAddOrderLineAction, createBuyFromSyndicateAction, validateAction, applyAction,
} = require('../actions.js');
const { systemAtDistance, farthestSystem, starterHomeAtDistance } = require('./waystation-fixtures.js');

// Real systems on seed 7331, with the distance each sits from its nearest waystation, and
// the LIGHT-tier burn for that distance (the tier a small raw leg flies on). Chosen to cover
// the free-trip trap (d=1), an even distance, an odd one (where rounding shows), and the
// farthest system (magnitude).
const lightBurnFor = (d) => Math.ceil(d * SYNDICATE_HAULER_BURN_RATE);
const MID_HOME = starterHomeAtDistance(6);
const NEAR = { id: systemAtDistance(1), distance: 1, burn: lightBurnFor(1) };
const MID = { id: MID_HOME.id, distance: MID_HOME.distance, burn: lightBurnFor(MID_HOME.distance) };
const ODD = { id: systemAtDistance(7), distance: 7, burn: lightBurnFor(7) };
const FAR = (() => { const f = farthestSystem(); return { id: f.id, distance: f.distance, burn: lightBurnFor(f.distance) }; })();
const MID_HOME_PLANET = MID_HOME.homePlanet; // MID's Terran homeworld — a landmark with no waystation
const UNHELD = 'sys_0256';          // a real system this guild never claims

// A single raw unit is 1 space — a light-hold leg, the tier the old cargo-independent burn
// implicitly always flew. Handy for asserting the light burn through the space-required API.
const LIGHT_SPACE = 1;

const claim = (guildId, systemId, i) => ({
  claimId: i === 0 ? `claim_home_${guildId}` : `claim_${guildId}_${systemId}`,
  ownerGuildId: guildId,
  landmarkId: systemId,
  landmarkKind: 'system',
  claimedAtTick: 0,
  contested: false,
});

// A guild homed on MID holding `holds`, ledger-funded so invariant 2 starts balanced.
// `holds[0]` must be MID for the guild-home invariant to be satisfied.
function quoteState({ credits = 100000, holds = [MID.id], guilds, fuelHoard = GUILD_STARTING_FUEL } = {}) {
  return createState({
    guilds: guilds || [{
      id: 'g1',
      credits,
      fuelHoard,
      homeSystemId: MID.id,
      homePlanetId: MID_HOME_PLANET,
    }],
    reserve: { reserveLevel: 0 },
    syndicate: { ledger: -credits },
    claims: holds.map((sysId, i) => claim('g1', sysId, i)),
  });
}

// --- the seed fixtures are real -------------------------------------------

test('the pinned seed distances are what the engine actually measures', () => {
  for (const sys of [NEAR, MID, ODD, FAR]) {
    assert.equal(nearestWaystation(sys.id).distance, sys.distance, `${sys.id}'s distance to its nearest waystation`);
  }
});

// --- the cargo-space primitives -------------------------------------------

test('volumeOf: T1=1, T2=100, T3=60,000 — space by manufacturing tier only', () => {
  assert.equal(volumeOf('ammonia'), 1, 'a raw resource is 1 space/unit');
  assert.equal(volumeOf('titanium'), 1);
  assert.equal(volumeOf('battery_cells'), 100, 'a processed good is 100 space/unit');
  assert.equal(volumeOf('cargo_handling_system'), 60000, 'a Tier-3 module is 60,000 space/unit');
});

test('volumeOf: a fuel or non-priced good has no cargo volume — it THROWS, never 0', () => {
  // Fuel is Syndicate-regulated and never rides a cart; an unknown name is a bug. Scoring
  // either as 0 space would silently under-size a load and under-charge the burn (§18).
  assert.throws(() => volumeOf('deuterium_fuel'), /no cargo volume/);
  assert.throws(() => volumeOf('not_a_good'), /no cargo volume/);
  assert.throws(() => volumeOf(undefined), /no cargo volume/);
});

test('haulerTierForSpace: the smallest hold that fits, inclusive, null over the heavy hold', () => {
  assert.equal(haulerTierForSpace(1), 'light');
  assert.equal(haulerTierForSpace(10000), 'light', '10,000 is the light hold — inclusive');
  assert.equal(haulerTierForSpace(10001), 'medium', 'one over light steps to medium');
  assert.equal(haulerTierForSpace(50000), 'medium', '50,000 is the medium hold — inclusive');
  assert.equal(haulerTierForSpace(50001), 'heavy', 'one over medium steps to heavy');
  assert.equal(haulerTierForSpace(6000000), 'heavy', '6,000,000 is the heavy hold — inclusive');
  assert.equal(haulerTierForSpace(6000001), null, 'one over the heavy hold — no hauler carries it');
  assert.equal(HEAVY_HOLD, 6000000, 'the reject-whole cap IS the heavy hold');
});

test('the volumes match the ruled anchors (phase-1-tuning §5.1)', () => {
  // 100 T2 fill a light; a T3 will not fit a medium; 100 T3 fill a heavy; a T4 asset = a heavy hold.
  assert.equal(haulerTierForSpace(100 * volumeOf('battery_cells')), 'light', '100 processed = a light hold');
  assert.equal(haulerTierForSpace(volumeOf('cargo_handling_system')), 'heavy', 'one T3 module needs a heavy (60,000 > the 50,000 medium)');
  assert.equal(100 * volumeOf('cargo_handling_system'), HEAVY_HOLD, '100 T3 modules fill a heavy hold exactly');
  assert.equal(ASSET_CARGO_VOLUME, HEAVY_HOLD, 'a non-movable T4 asset fills a heavy hold');
});

// --- routeFuelCost: the space-tiered burn ---------------------------------

test('routeFuelCost REQUIRES an explicit space — a missing load throws, never under-charges', () => {
  assert.throws(() => routeFuelCost(MID.id), /space is required/);
  assert.throws(() => routeFuelCost(MID.id, undefined), /space is required/);
});

test('at a light-hold space the burn is the old ceil(distance × 0.5) — byte-identical', () => {
  for (const sys of [NEAR, MID, ODD, FAR]) {
    assert.deepEqual(routeFuelCost(sys.id, LIGHT_SPACE), { fuelBurn: sys.burn }, `${sys.id} at distance ${sys.distance}`);
    assert.equal(routeFuelCost(sys.id, LIGHT_SPACE).fuelBurn, Math.ceil(sys.distance * SYNDICATE_HAULER_BURN_RATE));
    assert.equal(fuelValue(sys.burn, REFERENCE_FUEL_PRICE), sys.burn * REFERENCE_FUEL_PRICE);
  }
  // Farther costs strictly more — monotone across the ladder, at a fixed tier.
  const burns = [NEAR, MID, ODD, FAR].map((s) => routeFuelCost(s.id, LIGHT_SPACE).fuelBurn);
  for (let i = 1; i < burns.length; i += 1) {
    assert.ok(burns[i] > burns[i - 1], `burn must rise with distance: ${burns.join(' -> ')}`);
  }
});

test('rates rise with the tier — for a fixed distance lightBurn ≤ mediumBurn ≤ heavyBurn, no backward cliff', () => {
  // Space that lands squarely in each tier: 1 (light), 20,000 (medium), 100,000 (heavy).
  for (const sys of [NEAR, MID, ODD, FAR]) {
    const light = routeFuelCost(sys.id, 1).fuelBurn;
    const medium = routeFuelCost(sys.id, 20000).fuelBurn;
    const heavy = routeFuelCost(sys.id, 100000).fuelBurn;
    assert.ok(light <= medium && medium <= heavy, `${sys.id}: ${light} <= ${medium} <= ${heavy}`);
    // And the byTier helper agrees with the space-selected burns tier for tier.
    const byTier = routeFuelBurnByTier(sys.id);
    assert.deepEqual({ light, medium, heavy }, byTier, `${sys.id}: routeFuelCost per tier == routeFuelBurnByTier`);
  }
});

test('economies of scale: one full heavy burns strictly less than the same space split across lights', () => {
  // §5.1: burn is per-TRIP and load-independent within a tier, so consolidating onto a
  // bigger hold rewards the player even though the heavy is thirstier per hex. A full heavy
  // hold (6,000,000 space) is 600 light holds' worth; one heavy trip must beat 600 light trips.
  for (const sys of [MID, ODD, FAR]) {
    const heavy = routeFuelCost(sys.id, HEAVY_HOLD).fuelBurn;
    const oneLight = routeFuelCost(sys.id, 10000).fuelBurn;
    const lightsForSameSpace = (HEAVY_HOLD / 10000) * oneLight;
    assert.ok(heavy < lightsForSameSpace, `${sys.id}: one heavy ${heavy} must beat ${HEAVY_HOLD / 10000} lights ${lightsForSameSpace}`);
  }
});

test('every REAL route costs at least 1 fuel — ceil, not truncation', () => {
  assert.equal(routeFuelCost(NEAR.id, LIGHT_SPACE).fuelBurn, 1, 'a 1-hex route is not free');
  assert.equal(Math.floor(NEAR.distance * SYNDICATE_HAULER_BURN_RATE), 0, 'floor really would have made it free');
  for (let i = 1; i <= 1500; i += 11) {
    const id = `sys_${String(i).padStart(4, '0')}`;
    if (!nearestWaystation(id)) continue;
    assert.ok(routeFuelCost(id, LIGHT_SPACE).fuelBurn >= 1, `${id} quoted a free trip`);
  }
});

test('over-cap space THROWS — the reject-whole gate must refuse it before the fuel charge', () => {
  // A load no hauler carries must never be priced: it is a bug to reach the burn with one.
  assert.throws(() => routeFuelCost(MID.id, HEAVY_HOLD + 1), /exceeds the heavy hold/);
});

test('no waystation: a zero quote at any space, not a throw', () => {
  for (const missing of ['sys_nope', '', 'out_01', MID_HOME_PLANET]) {
    assert.equal(nearestWaystation(missing), null, `${JSON.stringify(missing)} really has no waystation`);
    // The no-route check runs BEFORE the tier, so it answers 0 even for an over-cap space.
    assert.deepEqual(routeFuelCost(missing, LIGHT_SPACE), { fuelBurn: 0 });
    assert.deepEqual(routeFuelCost(missing, HEAVY_HOLD + 1), { fuelBurn: 0 });
    assert.deepEqual(routeFuelBurnByTier(missing), { light: 0, medium: 0, heavy: 0 });
  }
  // A held buyOrder (docs/syndicate-orders.md §5) finalised to a no-waystation system.
  const s = applyAction(quoteState(), createAddOrderLineAction({ guildId: 'g1', side: 'buy', good: 'titanium', qty: 1 }));
  const { valid, reason } = validateAction(s, createBuyFromSyndicateAction({
    guildId: 'g1', destinationSystemId: 'sys_nope',
  }));
  assert.equal(valid, false, 'the engine refuses the trade a zero quote describes');
  assert.match(reason, /does not hold system|no Syndicate waystation/);
});

// --- the snapshot field ----------------------------------------------------

test('fuelCost covers exactly the systems the guild holds, sorted', () => {
  const holds = [MID.id, FAR.id, NEAR.id, ODD.id];
  const s = quoteState({ holds });
  const guild = buildSnapshot(s).guilds[0];
  const keys = Object.keys(guild.fuelCost);

  assert.deepEqual(keys, [...holds].sort((a, b) => a.localeCompare(b)),
    'keys are sorted lexicographically (invariant 9), not in claim order');
  assert.notDeepEqual(keys, holds, 'and the fixture really was unsorted, or the assertion above proves nothing');

  for (const id of holds) assert.ok(guildHolds(s, 'g1', id) && id in guild.fuelCost, id);
  assert.equal(guildHolds(s, 'g1', UNHELD), false);
  assert.equal(UNHELD in guild.fuelCost, false, 'no quote for a system the guild does not hold');
  assert.deepEqual(keys, heldSystemIds(s, 'g1'), 'the map is keyed by the same predicate the BUY gate reads');
});

test('fuelCost row: fuelBurn/creditCost stay the LIGHT-tier values, byTier is additive', () => {
  const s = quoteState({ holds: [MID.id, FAR.id, NEAR.id, ODD.id] });
  for (const [systemId, q] of Object.entries(buildSnapshot(s).guilds[0].fuelCost)) {
    assert.deepEqual(Object.keys(q).sort(),
      ['creditCost', 'creditCostByTier', 'fuelBurn', 'fuelBurnByTier', 'travelTicks'], `${systemId} row shape`);
    // The top-level burn/cost are the LIGHT-tier values — today's numbers, unchanged.
    const byTier = routeFuelBurnByTier(systemId);
    assert.equal(q.fuelBurn, byTier.light, `${systemId}: fuelBurn is the light tier`);
    assert.equal(q.creditCost, fuelValue(byTier.light, s.reserve.fuelPrice), `${systemId}: creditCost is the light valuation`);
    // The byTier maps carry all three tiers, integer, non-negative.
    assert.deepEqual(Object.keys(q.fuelBurnByTier).sort(), ['heavy', 'light', 'medium']);
    assert.deepEqual(q.fuelBurnByTier, byTier);
    for (const tier of ['light', 'medium', 'heavy']) {
      assert.ok(Number.isInteger(q.fuelBurnByTier[tier]) && q.fuelBurnByTier[tier] >= 0, `${systemId}.${tier} burn`);
      assert.equal(q.creditCostByTier[tier], fuelValue(q.fuelBurnByTier[tier], s.reserve.fuelPrice), `${systemId}.${tier} valuation`);
    }
    assert.ok(Number.isInteger(q.travelTicks) && q.travelTicks >= 0, `${systemId} travelTicks`);
  }
});

test('travelTicks is the route travel duration — arrivalTickFor(0, distance), tier-independent', () => {
  const s = quoteState({ holds: [MID.id, FAR.id, NEAR.id, ODD.id] });
  const { fuelCost } = buildSnapshot(s).guilds[0];
  for (const systemId of Object.keys(fuelCost)) {
    const { distance } = nearestWaystation(systemId);
    assert.equal(fuelCost[systemId].travelTicks, arrivalTickFor(0, distance), systemId);
  }
  assert.ok(fuelCost[FAR.id].travelTicks > fuelCost[NEAR.id].travelTicks, 'a farther system is a longer flight');
});

test('the snapshot quote IS the function — the anti-drift guarantee, per tier', () => {
  const s = quoteState({ holds: [MID.id, FAR.id, NEAR.id, ODD.id] });
  const { fuelCost } = buildSnapshot(s).guilds[0];
  for (const systemId of Object.keys(fuelCost)) {
    const byTier = routeFuelBurnByTier(systemId);
    const creditByTier = Object.fromEntries(
      Object.entries(byTier).map(([tier, burn]) => [tier, fuelValue(burn, s.reserve.fuelPrice)]),
    );
    assert.deepEqual(fuelCost[systemId], {
      fuelBurn: byTier.light,
      creditCost: fuelValue(byTier.light, s.reserve.fuelPrice),
      travelTicks: arrivalTickFor(0, nearestWaystation(systemId).distance),
      fuelBurnByTier: byTier,
      creditCostByTier: creditByTier,
    }, systemId);
  }
});

test('goodVolumes and haulerTiers are published, correct, and unit-only', () => {
  const snap = buildSnapshot(quoteState());
  // Every priced good's per-unit volume, from the engine's own volumeOf.
  assert.ok(Object.keys(snap.goodVolumes).length > 0);
  for (const [good, vol] of Object.entries(snap.goodVolumes)) {
    assert.equal(vol, volumeOf(good), `${good} volume`);
    assert.ok(Number.isInteger(vol) && vol > 0, `${good} volume is a positive integer`);
  }
  // The hold ladder, smallest → largest, as { tier, hold } — no rate, no geometry, no speed.
  assert.deepEqual(snap.haulerTiers, HAULER_TIERS.map((t) => ({ tier: t.tier, hold: t.hold })));
  const serialized = JSON.stringify({ goodVolumes: snap.goodVolumes, haulerTiers: snap.haulerTiers });
  assert.ok(!/0\.5|0\.6|0\.7|rate|speed|hex/i.test(serialized), 'no rate, geometry, or speed leaks into the published constants');
});

test('a guild that holds nothing gets an empty map, not a missing key', () => {
  const s = createState({
    guilds: [{ id: 'g1', credits: 0, fuelHoard: 0 }],
    reserve: { reserveLevel: 0 },
    syndicate: { ledger: 0 },
  });
  assert.deepEqual(buildSnapshot(s).guilds[0].fuelCost, {});
  assert.deepEqual(checkInvariants(s, s.tick), []);
});

test('fuelCost is derived telemetry — it stores nothing and bumps no schema', () => {
  const s = quoteState({ holds: [MID.id, FAR.id] });
  const before = hashState(s);
  const snap = buildSnapshot(s);

  assert.equal(hashState(s), before, 'building the quote changes no engine state');
  assert.equal(s.guilds[0].fuelCost, undefined, 'and nothing is written onto the guild');
  assert.equal(snap.schemaVersion, 7, 'additive field, no schema bump');
  assert.deepEqual(checkInvariants(s, s.tick), []);
});

// --- the seam: quote and flight share one distance -------------------------

test('the quote is priced on the same distance the delivery is flown on', () => {
  let s = quoteState({ holds: [MID.id] });
  s.prices.titanium.posted = 10;

  // Build the held buyOrder (docs/syndicate-orders.md §5), then finalise it to MID.
  s = applyAction(s, createAddOrderLineAction({ guildId: 'g1', side: 'buy', good: 'titanium', qty: 5 }));
  const action = createBuyFromSyndicateAction({ guildId: 'g1', destinationSystemId: MID.id });
  const { valid, reason } = validateAction(s, action);
  assert.equal(valid, true, `expected accepted, got: ${reason}`);
  s = applyAction(s, action);

  const shipment = s.shipments[0];
  const { distance } = nearestWaystation(MID.id);
  assert.equal(shipment.arrivalTick, arrivalTickFor(0, distance), 'the flight is timed on this distance...');
  // 5 titanium (volume 1) = 5 space, a light-hold leg — burn is the light rate on the same distance.
  const quoted = routeFuelCost(MID.id, 5 * volumeOf('titanium')).fuelBurn;
  assert.equal(quoted, Math.ceil(distance * SYNDICATE_HAULER_BURN_RATE), '...and the quote is priced on the same one');
  assert.equal(s.guilds[0].fuelHoard, GUILD_STARTING_FUEL - quoted, 'the guild paid exactly the quoted burn');
  assert.equal(s.audit.totalConsumed, quoted, 'and it was recorded as consumed, not lost');
  assert.equal(postedPrice(s, 'titanium'), 10);
  assert.deepEqual(checkInvariants(s, s.tick), []);
});
