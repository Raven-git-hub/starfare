'use strict';

// droid-batch-buy.test.js — roadmap 2.6, the Syndicate droid BATCH-BUY slice (docs/droids.md §3, RE-RULED 07-11-26).
// Syndicate droids are sold in batches of 5 / 10 / 50 at the flat 10,000 cr/droid tariff, build time 0, delivered on
// ONE medium Syndicate hauler, landing as N idle Syndicate-source droids. It supersedes slice 3's instant buy.
// No new number: the sizes and tariff are ruled; the medium hold, CRAFT_SPEED and the waystations already existed.
//
// The tripwires:
//   1. THE CONSTANTS: the three sizes, the tariff, and a droid batch fills a MEDIUM hold (not the heavy asset hold).
//   2. CONSERVATION (invariants 1–2): a buy moves exactly N × tariff guild → ledger and burns exactly one medium
//      flight's fuel out of the galaxy — the same fuel for every size — and nothing else.
//   3. BUILD-0: the batch is in flight the tick it is bought — never on the commission queue, never behind a
//      building head, never counted against the queue cap.
//   4. THE ARRIVAL: on its arrival tick (not one sooner) exactly N idle Syndicate droids land at the held
//      destination, stamped with that tick, on consecutive ids; the landing moves nothing but the droids.
//   5. REFUSALS: a bad size, an unheld / unknown destination, short credits, short fuel — each refused with its own
//      reason, minting nothing; the retired instant buy is refused too.
//   6. TRIPWIRES: the droid-shipment invariants and the arrival guard bite on a corrupted record.
//   7. SNAPSHOT: the public droidBatchQuote prices exactly what the buy charges; the in-flight row names its count.
//   8. NO-OP: a galaxy that never buys a batch serializes exactly as at c613414; its snapshot differs only by the
//      new block.
//   9. DETERMINISM (invariant 9): a scripted run of all three sizes is byte-identical on a re-run and across a
//      mid-flight save / restore.

const { test } = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { advance } = require('../run.js');
const { hashState } = require('../serialize.js');
const { saveState, loadOrInit } = require('../persist.js');
const { buildSnapshot } = require('../snapshot.js');
const { checkInvariants } = require('../invariants.js');
const { tick } = require('../tick.js');
const { computeGalacticSupply } = require('../supply.js');
const { getStarterSystems } = require('../seed.js');
const { nearestWaystation, arrivalTickFor } = require('../transport.js');
const {
  HAULER_TIERS, ASSET_CARGO_VOLUME, DROID_BATCH_CARGO_VOLUME, haulerTierForSpace, routeFuelCost,
} = require('../fuel.js');
const { DROID, SYNDICATE_DROID_TARIFF, SYNDICATE_DROID_BATCHES } = require('../droids.js');
const { SYNDICATE_QUEUE_MAX } = require('../asset-recipes.js');
const { createBuyDroidBatchAction, createBuyAssetFromSyndicateAction } = require('../actions.js');
const { HOME, RIVAL, kitGalaxy, accept, refuse, ticks, tickUntil, g1Of } = require('./installation-kit-fixtures.js');
const { noBatchScript } = require('./droid-batch-noop-script.js');
const { withoutDroidBatchQuote } = require('./droid-batch-quote-strip.js');

// A second starter system g1 can be given, for the two-destination test.
const OTHER = getStarterSystems().map((x) => x.id).find((id) => id !== HOME.id && id !== RIVAL);
const sha = (text) => crypto.createHash('sha256').update(text).digest('hex');
const buyBatch = (batch, systemId = HOME.id, guildId = 'g1') => createBuyDroidBatchAction({ guildId, batch, destinationSystemId: systemId });
const droidsOf = (s) => g1Of(s).droids || [];
const MEDIUM_BURN = routeFuelCost(HOME.id, DROID_BATCH_CARGO_VOLUME).fuelBurn;
const HOME_LEG = nearestWaystation(HOME.id).distance;

// --- 1. the constants -----------------------------------------------------------------------------------------

test('constants: batches 5 / 10 / 50 at 10,000 each; a batch fills a MEDIUM hold, not the heavy asset hold', () => {
  assert.deepEqual([...SYNDICATE_DROID_BATCHES], [5, 10, 50]);
  assert.ok(Object.isFrozen(SYNDICATE_DROID_BATCHES));
  assert.equal(SYNDICATE_DROID_TARIFF, 10_000);
  assert.equal(DROID_BATCH_CARGO_VOLUME, HAULER_TIERS.find((t) => t.tier === 'medium').hold, 'read from the ruled table');
  assert.equal(DROID_BATCH_CARGO_VOLUME, 50_000);
  assert.equal(haulerTierForSpace(DROID_BATCH_CARGO_VOLUME), 'medium');
  assert.equal(haulerTierForSpace(ASSET_CARGO_VOLUME), 'heavy');
  // At HOME's 6-hex leg the two rates round apart (6 × 0.6 → 4, 6 × 0.7 → 5), so a test can tell them apart.
  assert.equal(HOME_LEG, 6);
  assert.equal(MEDIUM_BURN, 4);
  assert.equal(routeFuelCost(HOME.id, ASSET_CARGO_VOLUME).fuelBurn, 5);
});

// --- 2. conservation ------------------------------------------------------------------------------------------

for (const n of SYNDICATE_DROID_BATCHES) {
  test(`conservation (invariants 1–2): a batch of ${n} moves exactly ${n} × 10,000 to the ledger and burns one medium flight`, () => {
    const s = kitGalaxy({ credits: 1_000_000, fuelHoard: 100 });
    const before = {
      credits: g1Of(s).credits, ledger: s.syndicate.ledger, fuel: g1Of(s).fuelHoard, consumed: s.audit.totalConsumed,
    };
    const after = accept(s, buyBatch(n)); // accept() runs every invariant with no tick between
    assert.equal(g1Of(after).credits, before.credits - n * 10_000);
    assert.equal(after.syndicate.ledger, before.ledger + n * 10_000);
    assert.equal(g1Of(after).credits + after.syndicate.ledger, before.credits + before.ledger, 'credits moved, none made');
    // One medium flight, whatever the size — and NOT the heavy asset flight.
    assert.equal(g1Of(after).fuelHoard, before.fuel - MEDIUM_BURN);
    assert.equal(after.audit.totalConsumed, before.consumed + MEDIUM_BURN, 'the burned fuel left the galaxy through the audit');
    // Nothing else: no droid yet, no commission, no asset, no counter.
    assert.equal(g1Of(after).droids, undefined, 'no droid exists until the batch lands');
    assert.equal(g1Of(after).droidSerial, undefined);
    assert.equal(after.syndicateBuilds, undefined, 'no commission was queued');
    assert.equal(g1Of(after).syndicateCommissionSerial, undefined);
    assert.equal(g1Of(after).assets, undefined);
  });
}

test('conservation: contraband fuel pays when the legal hoard is short (the same legal-first burnFuel as every buy)', () => {
  const s = kitGalaxy({ credits: 50_000, fuelHoard: 1 });
  g1Of(s).deuteriumFuel = 10;
  s.audit.totalProduced += 10; // the contraband had to come from somewhere (invariant 1)
  s.galacticSupply = computeGalacticSupply(s); // and the supply cache counts it
  assert.deepEqual(checkInvariants(s, s.tick), []);
  const after = accept(s, buyBatch(5));
  assert.equal(g1Of(after).fuelHoard + g1Of(after).deuteriumFuel, 11 - MEDIUM_BURN);
  assert.equal(after.audit.totalConsumed, s.audit.totalConsumed + MEDIUM_BURN);
});

// --- 3. build-0: ships the tick it is bought --------------------------------------------------------------------

test('build-0: the batch is a delivery shipment from the buy tick — departure now, arrival = arrivalTickFor(now, leg)', () => {
  const s = ticks(kitGalaxy({ credits: 1_000_000, fuelHoard: 100 }), 7);
  const after = accept(s, buyBatch(10));
  assert.deepEqual(after.shipments, [{
    ownerGuildId: 'g1', assetKind: DROID, droidCount: 10, destinationSystemId: HOME.id, arrivalTick: arrivalTickFor(7, HOME_LEG),
  }]);
  // The snapshot's transit row says it left on the buy tick, from the destination's nearest waystation.
  const row = buildSnapshot(after, 'g1').shipments[0];
  assert.equal(row.departureTick, 7);
  assert.equal(row.originOutpostId, nearestWaystation(HOME.id).outpost.id);
});

test('build-0: it never waits behind a building commission, and never counts against the queue cap', () => {
  let s = kitGalaxy({ credits: 1_000_000_000, fuelHoard: 1_000 });
  for (let i = 0; i < SYNDICATE_QUEUE_MAX; i += 1) {
    s = accept(s, createBuyAssetFromSyndicateAction({ guildId: 'g1', assetKind: 'miner', destinationSystemId: HOME.id }));
  }
  s = ticks(s, 3); // the head is building
  assert.equal(s.syndicateBuilds.length, SYNDICATE_QUEUE_MAX, 'the commission queue is full');
  const queueBefore = structuredClone(s.syndicateBuilds);
  const after = accept(s, buyBatch(5));
  assert.deepEqual(after.syndicateBuilds, queueBefore, 'the queue is untouched');
  assert.equal(after.shipments.length, 1);
  assert.equal(after.shipments[0].arrivalTick, arrivalTickFor(s.tick, HOME_LEG), 'in flight at once, no build wait');
});

// --- 4. the arrival -------------------------------------------------------------------------------------------

for (const n of SYNDICATE_DROID_BATCHES) {
  test(`arrival: a batch of ${n} lands on its arrival tick as ${n} idle Syndicate droids at the held destination`, () => {
    let s = ticks(kitGalaxy({ credits: 1_000_000, fuelHoard: 100 }), 2);
    s = accept(s, buyBatch(n));
    const due = s.shipments[0].arrivalTick;
    s = tickUntil(s, (x) => droidsOf(x).length > 0);
    assert.equal(s.tick, due, 'not a tick sooner, not a tick later');
    assert.equal(droidsOf(s).length, n);
    droidsOf(s).forEach((d, i) => {
      assert.deepEqual(d, {
        id: `asset_g1_droid_${String(i + 1).padStart(2, '0')}`, systemId: HOME.id, source: 'syndicate', condition: 1,
        updatedAtTick: due,
      }, 'idle (no venture), new, Syndicate-source, stamped with the landing tick');
    });
    assert.equal(g1Of(s).droidSerial, n);
    assert.equal(s.shipments.length, 0, 'the delivery is finished');
  });
}

test('arrival: the landing moves NOTHING but the droids — no credit, no fuel, nothing else in the state', () => {
  let s = accept(kitGalaxy({ credits: 1_000_000, fuelHoard: 100 }), buyBatch(50));
  const due = s.shipments[0].arrivalTick;
  s = ticks(s, due - 1);
  // Twin the last tick: with the shipment, and with it simply removed. The only difference must be the droids.
  const landed = advance(s, []).state;
  const control = structuredClone(s);
  control.shipments = [];
  const without = advance(control, []).state;
  assert.equal(droidsOf(landed).length, 50);
  const stripped = structuredClone(landed);
  delete g1Of(stripped).droids;
  delete g1Of(stripped).droidSerial;
  assert.equal(hashState(stripped), hashState(without));
});

test('arrival: two batches to two of the guild\'s held systems each land where they were sent, ids in landing order', () => {
  // A second starter system g1 also holds (droid-assignment.test.js's OTHER fixture).
  let s = kitGalaxy({ credits: 1_000_000, fuelHoard: 1_000 });
  const far = OTHER;
  s.claims.push({ claimId: `claim_g1_${OTHER}`, ownerGuildId: 'g1', landmarkId: OTHER, landmarkKind: 'system', claimedAtTick: 0, contested: false });
  assert.deepEqual(checkInvariants(s, s.tick), []);
  s = accept(s, buyBatch(5, far));
  s = accept(s, buyBatch(10));
  s = ticks(s, Math.max(...s.shipments.map((x) => x.arrivalTick)));
  const at = (sys) => droidsOf(s).filter((d) => d.systemId === sys).length;
  assert.equal(at(HOME.id), 10);
  assert.equal(at(far), 5);
  assert.equal(g1Of(s).droidSerial, 15);
});

test('arrival: a batch whose owner is gone mid-flight is dropped — nothing minted, nothing thrown', () => {
  let s = accept(kitGalaxy({ credits: 1_000_000, fuelHoard: 100 }), buyBatch(5));
  s.guilds = s.guilds.filter((g) => g.id !== 'g1');
  const due = s.shipments[0].arrivalTick;
  // Tick the raw step loop (the torn-down owner leaves the fixture's other invariants moot here).
  for (let t = s.tick; t < due; t += 1) s = tick(s, []);
  assert.equal(s.shipments.length, 0);
});

// --- 5. refusals ----------------------------------------------------------------------------------------------

test('refusals: a batch size that is not 5 / 10 / 50 is refused, naming the sizes', () => {
  const s = kitGalaxy({ credits: 10_000_000, fuelHoard: 100 });
  for (const bad of [0, 1, 4, 6, 7, 11, 49, 51, 100, -5, 5.5, '5', null, NaN]) {
    assert.match(refuse(s, buyBatch(bad)), /batch must be one of 5 \/ 10 \/ 50 droids/, `size ${JSON.stringify(bad)}`);
  }
});

test('refusals: a destination the guild does not hold, or that is not on the seed, is refused', () => {
  const s = kitGalaxy({ credits: 10_000_000, fuelHoard: 100 });
  assert.match(refuse(s, buyBatch(5, RIVAL)), new RegExp(`guild g1 does not hold system "${RIVAL}"`));
  assert.match(refuse(s, buyBatch(5, 'sys_nope')), /is not a system on the seed/);
  assert.match(refuse(s, buyBatch(5, '')), /destinationSystemId must be a non-empty string/);
  assert.match(refuse(s, buyBatch(5, HOME.id, 'g9')), /no guild with id "g9"/);
});

test('refusals: short of credits — refused naming the shortfall; the exact price is enough', () => {
  for (const n of SYNDICATE_DROID_BATCHES) {
    const price = n * 10_000;
    const short = kitGalaxy({ credits: price - 1, fuelHoard: 100 });
    assert.match(refuse(short, buyBatch(n)),
      new RegExp(`holds ${price - 1} credits, cannot pay ${price} for a batch of ${n} Syndicate droids \\(10000 each\\) — short by 1`));
    assert.equal(g1Of(accept(kitGalaxy({ credits: price, fuelHoard: 100 }), buyBatch(n))).credits, 0);
  }
});

test('refusals: short of fuel for the one medium flight — refused naming the shortfall; the exact burn is enough', () => {
  const short = kitGalaxy({ credits: 1_000_000, fuelHoard: MEDIUM_BURN - 1 });
  assert.match(refuse(short, buyBatch(50)), new RegExp(`holds ${MEDIUM_BURN - 1} fuel .* cannot burn ${MEDIUM_BURN} flying a droid batch .* — short by 1`));
  // Credits are blamed first when both are short.
  assert.match(refuse(kitGalaxy({ credits: 0, fuelHoard: 0 }), buyBatch(5)), /cannot pay 50000/);
  assert.equal(g1Of(accept(kitGalaxy({ credits: 1_000_000, fuelHoard: MEDIUM_BURN }), buyBatch(50))).fuelHoard, 0);
});

test('refusals: a refused buy mints nothing and schedules nothing, even after the flight would have landed', () => {
  const s = kitGalaxy({ credits: 49_999, fuelHoard: 100 });
  refuse(s, buyBatch(5));
  // Sent through the tick loop's own intake: the refused action is dropped and the galaxy runs on droidless.
  let t = advance(s, [buyBatch(5)]).state;
  t = ticks(t, arrivalTickFor(0, HOME_LEG) + 5);
  assert.equal(g1Of(t).droids, undefined);
  assert.equal(g1Of(t).credits, 49_999);
  assert.equal(t.shipments.length, 0);
});

test('refusals: the retired instant buyAssetFromSyndicate droid is refused, naming buyDroidBatch', () => {
  const s = kitGalaxy({ credits: 1_000_000, fuelHoard: 100 });
  assert.match(refuse(s, createBuyAssetFromSyndicateAction({ guildId: 'g1', assetKind: DROID, destinationSystemId: HOME.id })),
    /the Syndicate sells droids only in batches of 5 \/ 10 \/ 50 — send buyDroidBatch, not buyAssetFromSyndicate/);
});

// --- 6. tripwires ---------------------------------------------------------------------------------------------

test('tripwires: the droid-shipment invariants bite on a corrupted record, and the arrival halts on a bad count', () => {
  const s = accept(kitGalaxy({ credits: 1_000_000, fuelHoard: 100 }), buyBatch(5));
  const rules = (mutate) => {
    const x = structuredClone(s);
    mutate(x);
    return checkInvariants(x, x.tick).map((v) => v.rule);
  };
  assert.ok(rules((x) => { x.shipments[0].droidCount = 6; }).includes('droid-shipment-count'));
  assert.ok(rules((x) => { delete x.shipments[0].droidCount; }).includes('droid-shipment-count'));
  assert.ok(rules((x) => { x.shipments[0].assetKind = 'miner'; }).includes('droid-shipment-kind'));
  assert.ok(rules((x) => { x.shipments[0].cargo = { titanium: 1 }; }).includes('droid-shipment-no-cargo'));
  // The arrival's own guard, reached past the invariants: it halts naming the tick and the count.
  const bad = structuredClone(s);
  bad.shipments[0].droidCount = 7;
  bad.shipments[0].arrivalTick = bad.tick + 1;
  assert.throws(() => tick(bad, []), new RegExp(`arriving at tick ${bad.tick + 1} carries droidCount 7`));
});

// --- 7. snapshot ----------------------------------------------------------------------------------------------

test('snapshot: droidBatchQuote prices exactly what buyDroidBatch charges, names the medium tier, and is public', () => {
  const s = kitGalaxy({ credits: 1_000_000, fuelHoard: 100 });
  const quote = buildSnapshot(s).droidBatchQuote;
  assert.deepEqual(quote, {
    perDroid: 10_000,
    haulerTier: 'medium',
    batches: [{ size: 5, price: 50_000 }, { size: 10, price: 100_000 }, { size: 50, price: 500_000 }],
  });
  for (const { size, price } of quote.batches) {
    const after = accept(s, buyBatch(size));
    assert.equal(g1Of(s).credits - g1Of(after).credits, price, `the quote for ${size} is the charge`);
  }
  // Public: the owner's and the rival's views carry the same block.
  assert.deepEqual(buildSnapshot(s, 'g1').droidBatchQuote, quote);
  assert.deepEqual(buildSnapshot(s, 'g2').droidBatchQuote, quote);
  // The card's two other figures come from the per-system route quote: the delivery leg and the medium burn.
  const route = buildSnapshot(s, 'g1').guilds.find((g) => g.id === 'g1').fuelCost[HOME.id];
  const after = accept(s, buyBatch(5));
  assert.equal(route.travelTicks, after.shipments[0].arrivalTick - s.tick, 'the published estimate is the real arrival');
  assert.equal(route.fuelBurnByTier[quote.haulerTier], MEDIUM_BURN, 'the published medium burn is the real burn');
});

test('snapshot: the in-flight batch row names its kind and count, to its owner only', () => {
  const s = accept(kitGalaxy({ credits: 1_000_000, fuelHoard: 100 }), buyBatch(50));
  const row = buildSnapshot(s, 'g1').shipments[0];
  assert.equal(row.assetKind, DROID);
  assert.equal(row.droidCount, 50);
  assert.deepEqual(row.cargo, {});
  assert.deepEqual(buildSnapshot(s, 'g2').shipments, [], 'a rival does not see it');
});

// --- 8. no-op -------------------------------------------------------------------------------------------------

// RECORDED AT c613414 (the branch base, before this slice's code existed) by running droid-batch-noop-script.js there.
// RE-PINNED 10-11-26 (maintenance slice 2): main's (fbafbab) bytes for this script with every asset's maintenanceCondition deleted hash to exactly this — the field's removal is the only change.
const NO_BATCH_STATE_C613414 = '931f12bd3f8d9ab990537162d00d9da6e6d4a7d2166365e43c826483ca42d84c';
const NO_BATCH_SNAPSHOT_C613414 = '1a6b98d5df52f96beeec1a722944c8fb7c160ac2ed6a631f1059ceac71612761';
const NO_BATCH_VIEW_C613414 = '107534e02006cb5864e4c56ac6c7e38a14ba2e5b6fcd1f970ae61a7e8dcace77';

test('no-op: a galaxy that never buys a droid batch is byte-identical to c613414; its snapshot moved only by droidBatchQuote', () => {
  const s = noBatchScript();
  // The run walked the touched paths: a guild droid built, three Syndicate droids granted, a miner delivered.
  assert.deepEqual(droidsOf(s).map((d) => d.source).sort(), ['guild', 'syndicate', 'syndicate', 'syndicate']);
  assert.deepEqual(g1Of(s).assets.map((a) => a.id), ['asset_g1_miner_01']);
  assert.equal(hashState(s), NO_BATCH_STATE_C613414);
  assert.equal(sha(JSON.stringify(withoutDroidBatchQuote(buildSnapshot(s)))), NO_BATCH_SNAPSHOT_C613414);
  assert.equal(sha(JSON.stringify(withoutDroidBatchQuote(buildSnapshot(s, 'g1')))), NO_BATCH_VIEW_C613414);
  assert.throws(() => withoutDroidBatchQuote({}), /nothing to strip/);
});

// --- 9. determinism -------------------------------------------------------------------------------------------

// batchScript() -> a run that buys every batch size at different ticks and flies them all in.
function batchScript() {
  let s = kitGalaxy({ credits: 1_000_000, fuelHoard: 100 });
  s = accept(s, buyBatch(5));
  s = ticks(s, 40);
  s = accept(s, buyBatch(50));
  s = ticks(s, 300);
  s = accept(s, buyBatch(10));
  const mid = ticks(s, 200); // all three in flight
  return { mid, end: ticks(mid, 800) };
}

test('determinism (invariant 9): the scripted run of all three sizes is byte-identical on a re-run', () => {
  const a = batchScript();
  const b = batchScript();
  assert.equal(a.mid.shipments.length, 3, 'all three were in flight at mid');
  assert.equal(droidsOf(a.end).length, 65, 'all three landed: 5 + 50 + 10');
  assert.equal(hashState(a.mid), hashState(b.mid));
  assert.equal(hashState(a.end), hashState(b.end));
  // Landing order is buy order here (one destination): the first five ids are the five-batch's, landed first.
  const landed = droidsOf(a.end).map((d) => d.updatedAtTick);
  assert.deepEqual([...new Set(landed)], [arrivalTickFor(0, HOME_LEG), arrivalTickFor(40, HOME_LEG), arrivalTickFor(340, HOME_LEG)]);
});

test('determinism: a save with batches in flight restores byte-identically and lands identically', () => {
  const { mid, end } = batchScript();
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'starfare-droid-batch-'));
  try {
    saveState(mid, dir);
    const restored = loadOrInit(dir, () => { throw new Error('expected the saved state to load'); });
    assert.equal(hashState(restored), hashState(mid));
    assert.equal(hashState(ticks(restored, 800)), hashState(end));
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
