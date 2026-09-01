'use strict';

// fuel-cost.test.js — fuel Slice 2: the route burn QUOTE
// (docs/fuel-supply-and-allocation.md §8, Slice 2).
//
// WHAT THIS SLICE IS: one pure function, `routeFuelCost(systemId)`, and one
// additive snapshot field built by calling it. Nothing mutates, nothing is
// deducted — the deduction is Slice 3. So the tripwires here are not about state;
// they are about the three ways a QUOTE can quietly be wrong:
//
//   1. IT MEASURES THE WRONG THING. The burn must come from the distance
//      `nearestWaystation` already computed — the very number `buyFromSyndicate`
//      reads to schedule the arrival tick. A second measurement (calling
//      `hexDistance` again, or re-deriving from coords) would be a second
//      derivation of one fact, and the two could drift: a trip priced on one
//      geometry and flown on another. The last test in this file pins quote and
//      flight to the same distance end to end.
//   2. IT DEPENDS ON SOMETHING IT MUST NOT. The ruling is `fuel = distance x rate`,
//      CARGO-INDEPENDENT. `routeFuelCost` takes one argument and there is no good
//      or quantity in its signature, so this is proven structurally (arity) rather
//      than by hoping no caller passes one.
//   3. IT ROUNDS A REAL ROUTE TO FREE. At the `[FIRST-CUT]` rate of 0.5 a 1-hex
//      route is 0.5 fuel, which truncates to nothing. `Math.ceil` is what stops a
//      free trip, and a zero is reserved for the one honest case: no waystation.
//
// The seed is the fixture. These are real distances on seed 7331, so a change to
// the generator that moves a waystation shows up here as a moved number rather
// than as a silently different economy.

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
  routeFuelCost, fuelValue,
} = require('../fuel.js');
const {
  createBuyFromSyndicateAction, validateAction, applyAction,
} = require('../actions.js');

// Real systems on seed 7331, with the distance each sits from its nearest
// waystation. Pinned here so a failure names the geometry that moved, and chosen
// to cover the cases that distinguish a right answer from a plausible one:
//
//   NEAR  d=1   -> ceil 1, floor 0   the free-trip trap
//   MID   d=6   -> ceil 3, floor 3   an even distance, where rounding cannot show
//   ODD   d=7   -> ceil 4, floor 3   an odd one, where it must
//   FAR   d=100 -> ceil 50           far enough that "burn tracks distance" is unmistakable
const NEAR = { id: 'sys_1053', distance: 1, burn: 1 };
const MID = { id: 'sys_0719', distance: 6, burn: 3 };
const ODD = { id: 'sys_0509', distance: 7, burn: 4 };
const FAR = { id: 'sys_0002', distance: 100, burn: 50 };
const MID_HOME_PLANET = 'pl_02524'; // sys_0719's Terran homeworld
const UNHELD = 'sys_0256';          // a real system this guild never claims

const claim = (guildId, systemId, i) => ({
  claimId: i === 0 ? `claim_home_${guildId}` : `claim_${guildId}_${systemId}`,
  ownerGuildId: guildId,
  landmarkId: systemId,
  landmarkKind: 'system',
  claimedAtTick: 0,
  contested: false,
});

// A guild homed on MID holding `holds`, ledger-funded so invariant 2 starts
// balanced. `holds[0]` must be MID for the guild-home invariant to be satisfied.
function quoteState({ credits = 100000, holds = [MID.id], guilds, fuelHoard = GUILD_STARTING_FUEL } = {}) {
  return createState({
    guilds: guilds || [{
      id: 'g1',
      credits,
      // The founding grant, not 0: fuel Slice 3 made a BUY burn fuel, so the seam
      // test at the foot of this file could not place a purchase from an empty hoard.
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
  // Every assertion below leans on these four numbers. If the generator moves a
  // waystation they change, and this test says so first and by name — instead of
  // four burn assertions failing with no explanation.
  for (const sys of [NEAR, MID, ODD, FAR]) {
    assert.equal(nearestWaystation(sys.id).distance, sys.distance, `${sys.id}'s distance to its nearest waystation`);
  }
});

// --- routeFuelCost: the pure function --------------------------------------

test('burn tracks distance, and credit cost tracks burn', () => {
  // ⚠ THE QUOTE SPLIT IN TWO AT SLICE 5b-i (§4.2). `routeFuelCost` returns the BURN
  // alone — geometry, and what the engine actually charges — while what that burn is
  // WORTH is `fuelValue(burn, reserve.fuelPrice)` at the display site. The burns below
  // are the SAME numbers this test pinned before the split; the credit figures are
  // unchanged too, because the price is seeded at the reference the retired flat
  // constant used to hold.
  for (const sys of [NEAR, MID, ODD, FAR]) {
    const quote = routeFuelCost(sys.id);
    assert.deepEqual(quote, { fuelBurn: sys.burn }, `${sys.id} at distance ${sys.distance}`);
    // Stated as the RELATIONSHIP too, so retuning either constant moves the pinned
    // figures above and leaves this assertion honest rather than stale.
    assert.equal(quote.fuelBurn, Math.ceil(sys.distance * SYNDICATE_HAULER_BURN_RATE));
    assert.equal(fuelValue(quote.fuelBurn, REFERENCE_FUEL_PRICE), sys.burn * REFERENCE_FUEL_PRICE);
  }

  // The headline: farther costs strictly more. Monotonic across the whole ladder.
  const burns = [NEAR, MID, ODD, FAR].map((s) => routeFuelCost(s.id).fuelBurn);
  for (let i = 1; i < burns.length; i += 1) {
    assert.ok(burns[i] > burns[i - 1], `burn must rise with distance: ${burns.join(' -> ')}`);
  }
});

test('the burn reads the distance nearestWaystation already computed — not a second measurement', () => {
  // The anti-drift guarantee at the function level, asserted over a broad sample
  // of the real galaxy rather than a couple of hand-picked ids: for EVERY system,
  // the quote is exactly `ceil(nearestWaystation(id).distance x rate)`. Any second
  // derivation of distance — a fresh `hexDistance` call, a different origin, a
  // different metric — would have to agree with this everywhere to pass, which is
  // the same thing as not being a second derivation at all.
  let checked = 0;
  for (let i = 1; i <= 1500; i += 7) {
    const id = `sys_${String(i).padStart(4, '0')}`;
    const near = nearestWaystation(id);
    if (!near) continue;
    assert.equal(routeFuelCost(id).fuelBurn, Math.ceil(near.distance * SYNDICATE_HAULER_BURN_RATE), id);
    checked += 1;
  }
  assert.ok(checked > 100, `the sweep must actually cover the galaxy, checked ${checked}`);
});

test('cargo-independent: no good, no quantity, and no state can reach the burn', () => {
  // Structural, not behavioural: the function takes ONE argument. A cargo-aware or
  // state-aware version could not have this arity, so this fails the moment the
  // signature grows — which is the failure mode the ruling actually guards against.
  assert.equal(routeFuelCost.length, 1, 'routeFuelCost takes exactly one argument (systemId)');

  // And it is a pure function of that argument: same id, same answer, every time,
  // whatever else is going on. Extra arguments are ignored rather than honoured.
  const first = routeFuelCost(MID.id);
  assert.deepEqual(routeFuelCost(MID.id), first);
  assert.deepEqual(routeFuelCost(MID.id, 'titanium', 9999), first,
    'a caller cannot smuggle cargo into the burn');
  assert.notEqual(routeFuelCost(MID.id), first, 'each call returns a fresh object, never a shared one');
});

test('every REAL route costs at least 1 fuel — ceil, not truncation', () => {
  // NEAR is 1 hex out: 1 x 0.5 = 0.5, which floors to a free delivery. ODD is 7:
  // 3.5, which floors to 3. Both are pinned, so a switch to floor or trunc fails
  // here loudly rather than quietly making short trips free.
  assert.equal(routeFuelCost(NEAR.id).fuelBurn, 1, 'a 1-hex route is not free');
  assert.equal(Math.floor(NEAR.distance * SYNDICATE_HAULER_BURN_RATE), 0, 'floor really would have made it free');
  assert.equal(routeFuelCost(ODD.id).fuelBurn, 4);
  assert.equal(Math.floor(ODD.distance * SYNDICATE_HAULER_BURN_RATE), 3, 'floor really would have undercharged it');

  // Swept across the galaxy: no reachable system is ever free.
  for (let i = 1; i <= 1500; i += 11) {
    const id = `sys_${String(i).padStart(4, '0')}`;
    if (!nearestWaystation(id)) continue;
    assert.ok(routeFuelCost(id).fuelBurn >= 1, `${id} quoted a free trip`);
  }
});

test('no waystation: a zero quote, not a throw', () => {
  // The graceful-absence case. A quote is a display figure, so it answers rather
  // than blowing up the whole snapshot for one unreachable system; the refusal
  // that matters lives in validateAction, which rejects the purchase on this same
  // null (asserted below, so the two halves stay joined).
  for (const missing of ['sys_nope', '', 'out_01', 'pl_02524']) {
    assert.equal(nearestWaystation(missing), null, `${JSON.stringify(missing)} really has no waystation`);
    assert.deepEqual(routeFuelCost(missing), { fuelBurn: 0 });
  }
  const s = quoteState();
  const { valid, reason } = validateAction(s, createBuyFromSyndicateAction({
    guildId: 'g1', good: 'titanium', qty: 1, destinationSystemId: 'sys_nope',
  }));
  assert.equal(valid, false, 'the engine refuses the trade a zero quote describes');
  assert.match(reason, /does not hold system|no Syndicate waystation/);
});

// --- the snapshot field ----------------------------------------------------

test('fuelCost covers exactly the systems the guild holds, sorted', () => {
  // Claims deliberately inserted OUT of lexicographic order, so a sorted result
  // proves the sort rather than echoing insertion order.
  const holds = [MID.id, FAR.id, NEAR.id, ODD.id];
  const s = quoteState({ holds });
  const guild = buildSnapshot(s).guilds[0];
  const keys = Object.keys(guild.fuelCost);

  assert.deepEqual(keys, [...holds].sort((a, b) => a.localeCompare(b)),
    'keys are sorted lexicographically (invariant 9), not in claim order');
  assert.notDeepEqual(keys, holds, 'and the fixture really was unsorted, or the assertion above proves nothing');

  // Held systems in, unheld systems out — including one real seed system the
  // guild simply never claimed. A quote for it would price a trade §6 refuses.
  for (const id of holds) assert.ok(guildHolds(s, 'g1', id) && id in guild.fuelCost, id);
  assert.equal(guildHolds(s, 'g1', UNHELD), false);
  assert.equal(UNHELD in guild.fuelCost, false, 'no quote for a system the guild does not hold');
  assert.deepEqual(keys, heldSystemIds(s, 'g1'), 'the map is keyed by the same predicate the BUY gate reads');
});

test('fuelCost values are integer credits and integer fuel, never negative', () => {
  const s = quoteState({ holds: [MID.id, FAR.id, NEAR.id, ODD.id] });
  for (const [systemId, q] of Object.entries(buildSnapshot(s).guilds[0].fuelCost)) {
    assert.deepEqual(Object.keys(q).sort(), ['creditCost', 'fuelBurn'], `${systemId} row shape`);
    assert.ok(Number.isInteger(q.fuelBurn) && q.fuelBurn >= 0, `${systemId} fuelBurn ${q.fuelBurn}`);
    assert.ok(Number.isInteger(q.creditCost) && q.creditCost >= 0, `${systemId} creditCost ${q.creditCost}`);
  }
});

test('the snapshot quote IS the function — the anti-drift guarantee', () => {
  // The claim the client depends on: what it renders and what the purchase deducts
  // come out of ONE function. If `buildSnapshot` ever grows its own copy of the
  // arithmetic, this is what catches it. Since slice 5b-i there are TWO functions to
  // hold it to, because the row is two facts: the BURN is `routeFuelCost`'s geometry,
  // and the `creditCost` is that burn marked at the galaxy's one fuel price through
  // the same `fuelValue` the hoard uses. Neither half may be re-derived in the lens.
  const s = quoteState({ holds: [MID.id, FAR.id, NEAR.id, ODD.id] });
  const { fuelCost } = buildSnapshot(s).guilds[0];
  for (const systemId of Object.keys(fuelCost)) {
    const { fuelBurn } = routeFuelCost(systemId);
    assert.deepEqual(fuelCost[systemId],
      { fuelBurn, creditCost: fuelValue(fuelBurn, s.reserve.fuelPrice) }, systemId);
  }
});

test('a guild that holds nothing gets an empty map, not a missing key', () => {
  // A homeless, claimless guild is legal (the guild-home invariant skips it), and
  // the client should read "no routes" rather than crash on undefined.
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
  // The point of reading `near.distance` rather than measuring again. A real
  // purchase into MID schedules its arrival from a distance; the quote prices the
  // burn from a distance. This asserts they are the SAME distance, by deriving the
  // arrival tick from the quote's own geometry and matching what the engine
  // actually scheduled. Drift between the two would fail here even if both halves
  // looked individually reasonable.
  let s = quoteState({ holds: [MID.id] });
  s.prices.titanium.posted = 10;

  const action = createBuyFromSyndicateAction({ guildId: 'g1', good: 'titanium', qty: 5, destinationSystemId: MID.id });
  const { valid, reason } = validateAction(s, action);
  assert.equal(valid, true, `expected accepted, got: ${reason}`);
  s = applyAction(s, action);

  const shipment = s.shipments[0];
  const { distance } = nearestWaystation(MID.id);
  assert.equal(shipment.arrivalTick, arrivalTickFor(0, distance), 'the flight is timed on this distance...');
  assert.equal(routeFuelCost(MID.id).fuelBurn, Math.ceil(distance * SYNDICATE_HAULER_BURN_RATE), '...and the quote is priced on the same one');

  // UPDATED BY SLICE 3 (31-08-26). This assertion used to read `fuelHoard === 0,
  // 'nothing is deducted in this slice'` — the Slice-2 boundary, when the quote was
  // a display figure and nothing spent it. Slice 3 is exactly the slice that spends
  // it, so the boundary moves rather than the test being dropped: the purchase must
  // now burn EXACTLY what the quote said, which is a stronger statement than either
  // half alone. Quoted, flown and charged on one distance.
  const quoted = routeFuelCost(MID.id).fuelBurn;
  assert.equal(s.guilds[0].fuelHoard, GUILD_STARTING_FUEL - quoted, 'the guild paid exactly the quoted burn');
  assert.equal(s.audit.totalConsumed, quoted, 'and it was recorded as consumed, not lost');
  assert.equal(postedPrice(s, 'titanium'), 10);
  assert.deepEqual(checkInvariants(s, s.tick), []);
});
