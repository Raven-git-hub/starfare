'use strict';

// buy.test.js — the Syndicate BUY engine (design.md §6, "Syndicate Delivery —
// the BUY side", 29-08-26): `buyFromSyndicate` debits the cash NOW and schedules
// the goods, and tick step 5 (`stepArrivals`) lands them some ticks later.
//
// The tripwires, one per ruling:
//   - the cash moves at purchase: `round(qty × postedPrice)` (#43), the SINGLE
//     posted price a sale earns, no fee and no spread — guild down, ledger up,
//     invariant 2 exact;
//   - the schedule: nearest waystation → straight-line hex distance × the ruled
//     CRAFT_SPEED → an ABSOLUTE arrival tick; nothing is deposited at purchase;
//   - one shipment, one destination, no splitting (§5), and only into a system
//     the guild HOLDS — `guildHolds`, the same predicate the vanish check uses;
//   - arrival deposits the exact cargo on its tick, and NOT the tick before;
//   - destination lost in flight → the cargo vanishes: no deposit, no refund, the
//     shipment dropped, and every invariant still green (conservation-clean
//     because the goods were never in a stockpile and the cash moved at purchase);
//   - persistence IS the mid-flight handling: a save round-tripped in flight still
//     lands on the right absolute tick;
//   - a BUY delivery contributes ZERO to invariant 1's fuel-in-transit sum;
//   - determinism (invariant 9) with several concurrent deliveries, and the no-op
//     proof that an unbought galaxy is untouched — which is why every committed
//     golden hash in the suite is unchanged.

const { test } = require('node:test');
const assert = require('node:assert/strict');

const { createState } = require('../state.js');
const { tick } = require('../tick.js');
const { hashState, canonicalStringify } = require('../serialize.js');
const { checkInvariants, assertInvariants } = require('../invariants.js');
const { computeGalacticSupply } = require('../supply.js');
const { getStock, guildTotals } = require('../stock.js');
const { buildSnapshot } = require('../snapshot.js');
const { postedPrice } = require('../prices.js');
const { FUEL_GOOD } = require('../resources.js');
const { guildHolds } = require('../claims.js');
const { GUILD_STARTING_FUEL, routeFuelCost } = require('../fuel.js');
const { getTerranHomeworld } = require('../seed.js');
const {
  CRAFT_SPEED, hexDistance, nearestWaystation, arrivalTickFor,
} = require('../transport.js');
const {
  createBuyFromSyndicateAction, validateAction, applyAction, intake,
} = require('../actions.js');

// Real seed landmarks, so the claim-integrity and guild-home invariants have
// something true to check. DEST is the starter-eligible system closest to any
// waystation on seed 7331 — 6 hexes from out_06 — chosen so the arrival tick is
// the smallest the real galaxy offers and a full tick-by-tick run stays cheap.
const DEST = 'sys_0719';
const DEST_HOME_PLANET = 'pl_02524';
const DEST_DISTANCE = 6;          // hexes, out_06 -> sys_0719 (asserted below)
const DEST_WAYSTATION = 'out_06';
// A second held system, for the "one destination, no splitting" side of things.
const OTHER = 'sys_0509';
const GOOD = 'titanium';

const homeClaim = (guildId, systemId) => ({
  claimId: `claim_home_${guildId}`,
  ownerGuildId: guildId,
  landmarkId: systemId,
  landmarkKind: 'system',
  claimedAtTick: 0,
  contested: false,
});
const extraClaim = (guildId, systemId) => ({
  claimId: `claim_${guildId}_${systemId}`,
  ownerGuildId: guildId,
  landmarkId: systemId,
  landmarkKind: 'system',
  claimedAtTick: 0,
  contested: false,
});

// A guild homed on DEST, with the ledger funding its credits so invariant 2
// starts balanced. `holds` is the full set of systems it claims.
// FUEL (Slice 3, 31-08-26): the hoard moved 0 -> GUILD_STARTING_FUEL. Every buy in
// this file used to fly free; a BUY now burns `routeFuelCost(destination).fuelBurn`
// and `validateAction` refuses a guild that cannot pay it, so a zero-fuel fixture
// can no longer buy anything at all. The founding grant is the honest default —
// it is what a real guild actually holds — and it is far above the burns here
// (DEST 3, OTHER 4), so no test in this file is near the gate by accident.
// `fuelHoard` stays a parameter so a test can still pin the empty case.
function buyState({ credits = 100000, holds = [DEST], stockpiles = {}, shipments, fuelHoard = GUILD_STARTING_FUEL } = {}) {
  const claims = holds.map((sysId, i) => (i === 0 ? homeClaim('g1', sysId) : extraClaim('g1', sysId)));
  return createState({
    guilds: [{
      id: 'g1',
      credits,
      fuelHoard,
      homeSystemId: holds[0] === DEST ? DEST : null,
      homePlanetId: holds[0] === DEST ? DEST_HOME_PLANET : null,
      stockpiles,
    }],
    reserve: { reserveLevel: 0 },
    syndicate: { ledger: -credits },
    claims,
    ...(shipments === undefined ? {} : { shipments }),
  });
}

// Set a good's POSTED value directly — the publish pipeline is prices.js's
// business, and a purchase only ever reads `posted` (the same shortcut sell.test
// takes).
function setPosted(state, good, value) {
  state.prices[good].posted = value;
  return state;
}

const buy = (guildId, good, qty, destinationSystemId) => createBuyFromSyndicateAction({ guildId, good, qty, destinationSystemId });
const accept = (state, action) => {
  const { valid, reason } = validateAction(state, action);
  assert.equal(valid, true, `expected accepted, got: ${reason}`);
  return applyAction(state, action);
};
const reject = (state, action, match) => {
  const { valid, reason } = validateAction(state, action);
  assert.equal(valid, false, 'expected a rejection');
  assert.match(reason, match);
  return reason;
};
const ticks = (state, n) => {
  let s = state;
  for (let i = 0; i < n; i += 1) s = tick(s, []);
  return s;
};

// --- 1. the geometry and the ruled speed --------------------------------------

test('hexDistance is the standard axial distance: zero on itself, symmetric, and integral on the seed', () => {
  const a = { q: 0, r: 0 };
  assert.equal(hexDistance(a, a), 0);
  assert.equal(hexDistance({ q: 0, r: 0 }, { q: 1, r: 0 }), 1);
  assert.equal(hexDistance({ q: 0, r: 0 }, { q: 1, r: -1 }), 1);   // the diagonal the third term exists for
  assert.equal(hexDistance({ q: 0, r: 0 }, { q: 2, r: -1 }), 2);
  assert.equal(hexDistance({ q: 3, r: -7 }, { q: -4, r: 2 }), hexDistance({ q: -4, r: 2 }, { q: 3, r: -7 }));
  assert.equal(hexDistance({ q: 80, r: -127 }, { q: 5, r: 160 }), 287);
});

test('nearestWaystation picks the closest OUTPOST, deterministically, and refuses an unknown system', () => {
  const ws = nearestWaystation(DEST);
  assert.equal(ws.outpost.id, DEST_WAYSTATION);
  assert.equal(ws.distance, DEST_DISTANCE);
  assert.equal(ws.outpost.kind, 'outpost'); // the Citadel is NOT a candidate (see transport.js)
  // Same answer every call — it reads only the seed, never live state.
  assert.deepEqual(nearestWaystation(DEST), ws);
  assert.equal(nearestWaystation('sys_does_not_exist'), null);
});

test('CRAFT_SPEED is the one ruled number, and the arrival tick is ceil(distance × speed) from now', () => {
  assert.equal(CRAFT_SPEED, 300);                       // [FIRST-CUT], docs/phase-1-tuning.md
  assert.equal(arrivalTickFor(0, DEST_DISTANCE), 1800);
  assert.equal(arrivalTickFor(40, 2), 640);
  // ceil, not round: a part-tick of travel is a whole tick of waiting.
  assert.equal(arrivalTickFor(0, 0.5), 150);
});

// --- 2. the purchase: cash now, goods scheduled -------------------------------

test('a buy debits round(qty × price) to the ledger and schedules ONE delivery — depositing nothing yet', () => {
  const before = setPosted(buyState({ credits: 5000 }), GOOD, 12);
  const price = postedPrice(before, GOOD);
  const qty = 40;
  const cost = Math.round(qty * price);

  const after = accept(before, buy('g1', GOOD, qty, DEST));

  // The cash moved, and ONLY moved: guild down, ledger up, by the same integer.
  assert.equal(after.guilds[0].credits, before.guilds[0].credits - cost);
  assert.equal(after.syndicate.ledger, before.syndicate.ledger + cost);
  assert.equal(
    after.guilds[0].credits + after.syndicate.ledger,
    before.guilds[0].credits + before.syndicate.ledger,
    'invariant 2 exact: nothing minted, nothing destroyed',
  );

  // The schedule: one shipment, one destination, the §6 shape and nothing else.
  assert.equal(after.shipments.length, 1);
  const ship = after.shipments[0];
  assert.deepEqual(Object.keys(ship).sort(), ['arrivalTick', 'cargo', 'destinationSystemId', 'ownerGuildId']);
  assert.equal(ship.ownerGuildId, 'g1');
  assert.deepEqual(ship.cargo, { [GOOD]: qty });
  assert.equal(ship.destinationSystemId, DEST);
  assert.equal(ship.arrivalTick, after.tick + Math.ceil(DEST_DISTANCE * CRAFT_SPEED));
  assert.equal(ship.arrivalTick, 1800);

  // NOTHING is deposited at purchase — the goods are in flight, and in-flight
  // cargo has no realized value until delivered (invariant 7).
  assert.equal(getStock(after.guilds[0], DEST, GOOD), 0);
  assert.deepEqual(guildTotals(after.guilds[0]), {});
  assert.equal(after.galacticSupply.resources[GOOD], 0);
  assert.deepEqual(
    after.galacticSupply, computeGalacticSupply(after),
    'the supply cache still describes the galaxy — no stockpile moved, so the action needs no refresh',
  );

  // Green IMMEDIATELY, with no tick in between — the between-tick seam POST /action
  // asserts on.
  assert.deepEqual(checkInvariants(after), []);
});

test('the cost is rounded ONCE on the whole order (#43), the same arithmetic a sale credits', () => {
  const before = setPosted(buyState({ credits: 5000 }), GOOD, 12.5);
  const after = accept(before, buy('g1', GOOD, 7, DEST));
  // 7 × 12.5 = 87.5 -> 88, one rounding, not seven.
  assert.equal(before.guilds[0].credits - after.guilds[0].credits, 88);
  assert.equal(Number.isInteger(after.guilds[0].credits), true);
  assert.equal(Number.isInteger(after.syndicate.ledger), true);
});

test('two buys are two independent shipments — one shipment, one destination, no merging or splitting', () => {
  let s = setPosted(buyState({ credits: 5000, holds: [DEST, OTHER] }), GOOD, 10);
  s = accept(s, buy('g1', GOOD, 10, DEST));
  s = accept(s, buy('g1', GOOD, 3, OTHER));
  assert.equal(s.shipments.length, 2);
  assert.deepEqual(s.shipments.map((x) => x.destinationSystemId), [DEST, OTHER]);
  assert.deepEqual(s.shipments.map((x) => x.cargo), [{ [GOOD]: 10 }, { [GOOD]: 3 }]);
  // Different distances -> different absolute arrival ticks, each its own journey.
  assert.equal(s.shipments[0].arrivalTick, arrivalTickFor(0, nearestWaystation(DEST).distance));
  assert.equal(s.shipments[1].arrivalTick, arrivalTickFor(0, nearestWaystation(OTHER).distance));
  assert.notEqual(s.shipments[0].arrivalTick, s.shipments[1].arrivalTick);
  assert.deepEqual(checkInvariants(s), []);
});

// --- 3. arrival ---------------------------------------------------------------

test('the delivery lands on its arrival tick and NOT the tick before, and the shipment is gone', () => {
  const bought = accept(setPosted(buyState({ credits: 5000 }), GOOD, 12), buy('g1', GOOD, 40, DEST));
  const arrivalTick = bought.shipments[0].arrivalTick;

  // Tick to arrivalTick − 1: still in flight, nothing deposited.
  const eve = ticks(bought, arrivalTick - 1);
  assert.equal(eve.tick, arrivalTick - 1);
  assert.equal(eve.shipments.length, 1, 'still in flight the tick before it is due');
  assert.equal(getStock(eve.guilds[0], DEST, GOOD), 0);
  assert.deepEqual(checkInvariants(eve), []);

  // One more tick: it lands, exactly and entirely.
  const landed = tick(eve, []);
  assert.equal(landed.tick, arrivalTick);
  assert.equal(getStock(landed.guilds[0], DEST, GOOD), 40);
  assert.deepEqual(landed.shipments, [], 'delivered shipments leave the list');
  // The tick's own end-of-steps derive pass refreshed the cache — stepArrivals
  // does NOT refresh it, and this is the assertion that says so.
  assert.equal(landed.galacticSupply.resources[GOOD], 40);
  assert.deepEqual(landed.galacticSupply, computeGalacticSupply(landed));
  assertInvariants(landed);

  // And it stays landed: no second deposit on the following tick.
  const after = tick(landed, []);
  assert.equal(getStock(after.guilds[0], DEST, GOOD), 40);
  assert.deepEqual(after.shipments, []);
});

test('a delivery lands into the DESTINATION system pool, not the guild home or a flat pile', () => {
  // Homed on DEST, buying into OTHER: the goods must appear in OTHER's pool.
  let s = setPosted(buyState({ credits: 5000, holds: [DEST, OTHER] }), GOOD, 10);
  s = accept(s, buy('g1', GOOD, 9, OTHER));
  const arrivalTick = s.shipments[0].arrivalTick;
  s.tick = arrivalTick - 1;   // a save from the eve of arrival (the absolute tick is the record)
  const landed = tick(s, []);
  assert.equal(getStock(landed.guilds[0], OTHER, GOOD), 9);
  assert.equal(getStock(landed.guilds[0], DEST, GOOD), 0);
  assertInvariants(landed);
});

// --- 4. the vanish, and its counterfactual ------------------------------------

// Both halves share one fixture so the ONLY difference between them is whether
// the claim on the destination is still there — otherwise a vanish could pass for
// some other reason (a wrong tick, a missing guild, an empty cargo).
function inFlightState({ holdsDestination }) {
  const holds = holdsDestination ? [DEST] : [OTHER];
  const s = buyState({
    credits: 5000,
    holds,
    shipments: [{ ownerGuildId: 'g1', cargo: { [GOOD]: 25 }, destinationSystemId: DEST, arrivalTick: 3 }],
  });
  // buyState only sets a home when DEST is held; give the OTHER-homed guild a
  // real home so the guild-home invariant has the same footing in both halves.
  if (!holdsDestination) {
    s.guilds[0].homeSystemId = OTHER;
    s.guilds[0].homePlanetId = getTerranHomeworld(OTHER);
  }
  s.tick = 2;
  return s;
}

test('destination lost in flight: the cargo vanishes — nothing deposited, the shipment dropped, every invariant green', () => {
  const before = inFlightState({ holdsDestination: false });
  assert.equal(guildHolds(before, 'g1', DEST), false, 'the guild no longer holds the destination');
  const creditsBefore = before.guilds[0].credits;
  const ledgerBefore = before.syndicate.ledger;

  const after = tick(before, []);
  assert.equal(after.tick, 3, 'the arrival tick');
  assert.equal(getStock(after.guilds[0], DEST, GOOD), 0, 'nothing deposited');
  assert.deepEqual(guildTotals(after.guilds[0]), {}, 'and not into any other pool either');
  assert.deepEqual(after.shipments, [], 'the shipment is dropped, not left to retry forever');

  // CONSERVATION-CLEAN. No refund and no imbalance: the cash moved to the ledger
  // at purchase (so invariant 2 was settled ticks ago and does not move now), and
  // the cargo was never in a stockpile (so galactic supply never counted it).
  assert.equal(after.guilds[0].credits, creditsBefore, 'no refund');
  assert.equal(after.syndicate.ledger, ledgerBefore, 'and no credits invented to unwind the sale');
  assert.equal(after.galacticSupply.resources[GOOD], 0);
  assert.deepEqual(after.galacticSupply, computeGalacticSupply(after));
  assertInvariants(after);
});

test('...and the counterfactual: the SAME shipment, with the destination still held, deposits', () => {
  const before = inFlightState({ holdsDestination: true });
  assert.equal(guildHolds(before, 'g1', DEST), true);
  const after = tick(before, []);
  assert.equal(after.tick, 3);
  assert.equal(getStock(after.guilds[0], DEST, GOOD), 25, 'the only difference is the claim');
  assert.deepEqual(after.shipments, []);
  assertInvariants(after);
});

test('a shipment already past its arrival tick still lands rather than being stranded', () => {
  const s = buyState({
    credits: 100,
    shipments: [{ ownerGuildId: 'g1', cargo: { [GOOD]: 4 }, destinationSystemId: DEST, arrivalTick: 1 }],
  });
  s.tick = 40; // e.g. a save restored past the due tick
  const after = tick(s, []);
  assert.equal(getStock(after.guilds[0], DEST, GOOD), 4);
  assert.deepEqual(after.shipments, []);
  assertInvariants(after);
});

// --- 5. persistence IS the mid-flight handling --------------------------------

test('a save round-tripped mid-flight still lands on the right ABSOLUTE tick', () => {
  const bought = accept(setPosted(buyState({ credits: 5000 }), GOOD, 12), buy('g1', GOOD, 40, DEST));
  const arrivalTick = bought.shipments[0].arrivalTick;

  // Fly a few ticks, then serialize and deserialize exactly as persist.js does
  // (canonicalStringify out, JSON.parse back in).
  const midFlight = ticks(bought, 5);
  const restored = JSON.parse(canonicalStringify(midFlight));
  assert.equal(hashState(restored), hashState(midFlight), 'the save is a faithful round trip');
  assert.equal(restored.shipments.length, 1);
  assert.equal(restored.shipments[0].arrivalTick, arrivalTick, 'an absolute tick, not a countdown');

  // Continue from the restored state alone — it still lands on the same tick it
  // would have without the restart, and it lands nothing early.
  const eve = ticks(restored, arrivalTick - 1 - restored.tick);
  assert.equal(getStock(eve.guilds[0], DEST, GOOD), 0);
  const landed = tick(eve, []);
  assert.equal(landed.tick, arrivalTick);
  assert.equal(getStock(landed.guilds[0], DEST, GOOD), 40);
  assert.deepEqual(landed.shipments, []);
  assertInvariants(landed);
});

// --- 6. the fuel invariant is unaffected --------------------------------------

test('a BUY delivery contributes ZERO fuel in transit — and the tripwire proves it would fire if it did', () => {
  // A galaxy with real fuel in it, so invariant 1 has something to conserve.
  const s = createState({
    guilds: [{ id: 'g1', credits: 5000, fuelHoard: 10, homeSystemId: DEST, homePlanetId: DEST_HOME_PLANET }],
    reserve: { reserveLevel: 30 },
    syndicate: { ledger: -5000 },
    claims: [homeClaim('g1', DEST)],
  });
  const bought = accept(setPosted(s, GOOD, 10), buy('g1', GOOD, 12, DEST));
  assert.equal(bought.shipments[0].cargo.fuel, undefined, 'the cargo carries the bought good and nothing else');
  assert.deepEqual(checkInvariants(bought), [], 'invariant 1 still balances');
  // Sharpened by fuel Slice 3: the BUY now BURNS fuel, so invariant 1 is no longer
  // "untouched" — the hoard drops and `totalConsumed` rises to match. What stays
  // exactly zero is the IN-TRANSIT term, which is what this test is about: fuel is
  // spent at the moment of purchase, never carried by the delivery.
  const { fuelBurn } = routeFuelCost(DEST);
  assert.equal(bought.guilds[0].fuelHoard, 10 - fuelBurn, 'the flight was paid for');
  assert.equal(bought.audit.totalConsumed, fuelBurn, 'and recorded as consumed');

  // The tripwire is real: put fuel in that same cargo and invariant 1 trips.
  const tampered = JSON.parse(JSON.stringify(bought));
  tampered.shipments[0].cargo.fuel = 5;
  const violations = checkInvariants(tampered);
  assert.equal(violations.length, 1);
  assert.match(violations[0].rule, /conservation-of-fuel/);
  assert.equal(violations[0].detail.inTransit, 5);
});

// --- 7. determinism and the no-op ---------------------------------------------

test('several concurrent deliveries land deterministically — the same run twice is byte-identical', () => {
  const build = () => {
    const s = buyState({
      credits: 5000,
      holds: [DEST, OTHER],
      shipments: [
        { ownerGuildId: 'g1', cargo: { [GOOD]: 5 }, destinationSystemId: OTHER, arrivalTick: 2 },
        { ownerGuildId: 'g1', cargo: { [GOOD]: 7 }, destinationSystemId: DEST, arrivalTick: 2 },
        { ownerGuildId: 'g1', cargo: { silica: 3 }, destinationSystemId: DEST, arrivalTick: 2 },
        { ownerGuildId: 'g1', cargo: { [GOOD]: 11 }, destinationSystemId: DEST, arrivalTick: 4 },
      ],
    });
    return setPosted(s, GOOD, 10);
  };

  const runA = ticks(build(), 5);
  const runB = ticks(build(), 5);
  assert.equal(hashState(runA), hashState(runB), 'same state + same inputs = same next state (invariant 9)');

  // Three landed on tick 2, the fourth on tick 4; all four are gone by tick 5.
  assert.deepEqual(runA.shipments, []);
  assert.equal(getStock(runA.guilds[0], DEST, GOOD), 18);
  assert.equal(getStock(runA.guilds[0], DEST, 'silica'), 3);
  assert.equal(getStock(runA.guilds[0], OTHER, GOOD), 5);
  assertInvariants(runA);

  // The tick-2 deposits really did happen on tick 2, not spread over the run.
  const atTwo = ticks(build(), 2);
  assert.equal(getStock(atTwo.guilds[0], DEST, GOOD), 7);
  assert.equal(atTwo.shipments.length, 1);
  assert.equal(atTwo.shipments[0].arrivalTick, 4);
});

test('a galaxy with no deliveries is untouched: stepArrivals moves nothing and adds no field', () => {
  // `shipments` has been an always-present empty array since the walking skeleton
  // (state.js), so it is already in every committed golden hash — which is why
  // this slice moves none of them (the pinned GOLDEN_* in commitment-scaffold and
  // persist.test.js are the standing proof; this is the local statement of it).
  const before = buyState({ credits: 5000 });
  assert.deepEqual(before.shipments, []);
  const control = ticks(buyState({ credits: 5000 }), 3);
  const after = ticks(before, 3);
  assert.deepEqual(after.shipments, [], 'still present, still empty — never deleted, never grown');
  assert.equal(hashState(after), hashState(control));
  assertInvariants(after);
});

// --- 8. refusals ---------------------------------------------------------------

test('a refused buy changes nothing at all', () => {
  const s = setPosted(buyState({ credits: 100 }), GOOD, 10);
  const before = hashState(s);

  reject(s, buy('nobody', GOOD, 1, DEST), /no guild with id/);
  reject(s, buy('g1', FUEL_GOOD, 1, DEST), /Syndicate-regulated/);
  reject(s, buy('g1', 'not_a_good', 1, DEST), /not a good the Syndicate posts a price for/);
  reject(s, buy('g1', GOOD, 0, DEST), /positive integer/);
  reject(s, buy('g1', GOOD, -5, DEST), /positive integer/);
  reject(s, buy('g1', GOOD, 2.5, DEST), /positive integer/);
  reject(s, buy('g1', GOOD, 1, ''), /non-empty string/);
  reject(s, buy('g1', GOOD, 1, OTHER), /does not hold system/);
  reject(s, buy('g1', GOOD, 1, 'sys_not_real'), /does not hold system/);
  // 100 credits, 11 × 10 = 110 owed.
  reject(s, buy('g1', GOOD, 11, DEST), /cannot pay 110/);

  assert.equal(hashState(s), before, 'validation is pure — a refusal leaves the state byte-identical');
  assert.deepEqual(s.shipments, []);
});

test('a guild may buy exactly what it can afford, and not one credit more', () => {
  const s = setPosted(buyState({ credits: 100 }), GOOD, 10);
  reject(s, buy('g1', GOOD, 11, DEST), /cannot pay/);
  const after = accept(s, buy('g1', GOOD, 10, DEST));
  assert.equal(after.guilds[0].credits, 0);
  assert.equal(after.shipments.length, 1);
  assert.deepEqual(checkInvariants(after), []);
});

test('intake applies buys sequentially against state-as-it-stands — the second is refused on the first\'s spend', () => {
  const s = setPosted(buyState({ credits: 100 }), GOOD, 10);
  const { state: after, results } = intake(s, [buy('g1', GOOD, 8, DEST), buy('g1', GOOD, 8, DEST)]);
  assert.equal(results[0].accepted, true);
  assert.equal(results[1].accepted, false);
  assert.match(results[1].reason, /cannot pay/);
  assert.equal(after.guilds[0].credits, 20);
  assert.equal(after.shipments.length, 1);
});

// --- 9. the snapshot surface ---------------------------------------------------

test('the snapshot surfaces in-transit deliveries with a derived ticksRemaining', () => {
  const bought = accept(setPosted(buyState({ credits: 5000 }), GOOD, 12), buy('g1', GOOD, 40, DEST));
  const flown = ticks(bought, 4);

  const snap = buildSnapshot(flown);
  assert.equal(snap.shipments.length, 1);
  assert.deepEqual(snap.shipments[0], {
    ownerGuildId: 'g1',
    cargo: { [GOOD]: 40 },
    destinationSystemId: DEST,
    arrivalTick: 1800,
    ticksRemaining: 1800 - 4,
  });
  // Derived telemetry only — mutating the snapshot cannot reach live state.
  snap.shipments[0].cargo[GOOD] = 999;
  assert.equal(flown.shipments[0].cargo[GOOD], 40);
  // An empty galaxy still reports the field, as an empty list.
  assert.deepEqual(buildSnapshot(buyState({})).shipments, []);
});
